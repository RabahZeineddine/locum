import type { Authorship } from "../config/types.js";
import { contasDoGh, lerRef, serializarRef, tokenDoGh, type GhConta, type GhRef } from "./gh-cli.js";
import { secretService, type SecretService } from "./secret-service.js";
import { settingsService, type SettingsService } from "./settings-service.js";

/**
 * Onde o token do GitHub mora no cofre.
 *
 * Uma referência só, e não uma por repositório: o token é pessoal, e quem
 * observa vários repositórios observa todos com a mesma conta. O dia em que
 * existir mais de uma conta, isto vira cadastro; hoje seria tabela de uma linha.
 */
export const GITHUB_CREDENTIAL_REF = "source/github";

/** A variável que sempre funcionou, e que continua valendo na linha de comando. */
export const GITHUB_TOKEN_ENV = "GITHUB_TOKEN";

/**
 * O que a última conferência descobriu fica em `settings`, com a referência da
 * credencial no nome da chave.
 *
 * Não é generalidade antecipada: o exame do smoke roda contra uma referência
 * de mentira para não encostar no token de quem desenvolve, e com chave fixa
 * ele apagaria o login e a data que a tela de verdade mostra.
 */
const CONFERIDO_EM = "checkedAt";
const LOGIN = "login";
const ESCOPOS = "scopes";

/**
 * Teto de caracteres do diff que vai para o modelo.
 *
 * O mesmo número da versão Python, que já tinha rodado em pull request de
 * verdade: cabe um pull request grande de código escrito à mão e barra o que
 * só chega a esse tamanho com migração ou dado gerado.
 */
export const DEFAULT_DIFF_MAX_CHARS = 200_000;

// Fora do nome da credencial: o teto vale para o diff, não para a conta.
const DIFF_MAX_CHARS_KEY = "github:diffMaxChars";

/**
 * O token do GitHub para quem vai conectar.
 *
 * O cofre vem antes do ambiente porque é ele que a interface alimenta: quem
 * guardou pela tela espera que o próximo run use aquele valor, e não um
 * `GITHUB_TOKEN` esquecido no shell de onde o app subiu. O ambiente continua
 * atrás porque é o caminho da linha de comando, onde não há keychain.
 *
 * O que o cofre guarda pode ser o token ou o vínculo com uma conta do `gh`
 * (`GhIndisponivelError` quando ela não responde).
 *
 * É síncrona porque o cofre é síncrono, e quem chama, o `octokit()` do source,
 * também é.
 */
export function githubToken(
  secrets: SecretService = secretService,
  ref: string = GITHUB_CREDENTIAL_REF,
): string | undefined {
  const guardado = secrets.get(ref);
  if (guardado !== undefined && guardado.length > 0) {
    // Vínculo com o gh: o token é pedido ao gh agora. Se ele não responde, o
    // erro sobe em vez de cair no ambiente, porque a escolha foi explícita.
    const vinculo = lerRef(guardado);
    return vinculo === undefined ? guardado : tokenDoGh(vinculo);
  }

  const ambiente = process.env[GITHUB_TOKEN_ENV];
  return ambiente !== undefined && ambiente.length > 0 ? ambiente : undefined;
}

/** Quem é a conta do token e o que ela pode. Nunca o token. */
export interface GithubIdentity {
  login: string;
  /**
   * Vazio não quer dizer "sem permissão".
   *
   * Token clássico publica os escopos no cabeçalho `x-oauth-scopes`; token de
   * escopo fino não publica nenhum, porque a permissão dele é por repositório e
   * não cabe numa lista de palavras. Quem mostra isso na tela precisa dizer as
   * duas coisas de formas diferentes, senão o token novo aparece como quebrado.
   */
  scopes: string[];
}

/**
 * O que a interface pode saber sobre a credencial do GitHub.
 *
 * O valor não cabe neste tipo, pela mesma razão do `CredentialRef`: quem
 * mostra alcança daqui o endereço, o sim ou não, e o que a última conferência
 * respondeu. O segredo só sai pelo `githubToken`, que é o caminho de quem vai
 * conectar.
 */
export interface GithubStatus {
  ref: string;
  /** Existe texto cifrado guardado. Vale mesmo sem keychain neste processo. */
  stored: boolean;
  /** Este processo alcança o keychain, isto é, dá para gravar e ler valor. */
  vault: boolean;
  /** A conta do gh a que a conexão está vinculada, quando é esse o caminho escolhido. */
  vinculo: { host: string; login: string; configDir?: string } | null;
  /** O gh vinculado não respondeu agora: a mensagem clara, nunca a saída dele. */
  erro: string | null;
  /** Existe `GITHUB_TOKEN` no ambiente, que é o caminho de trás. */
  env: boolean;
  /** Segundos desde a época, ou nulo quando nunca foi conferido. */
  checkedAt: number | null;
  identity: GithubIdentity | null;
}

export type GithubCheck =
  | ({ ok: true; checkedAt: number } & GithubIdentity)
  /**
   * `missing` é a falta de token, e não chega a sair da máquina: perguntar ao
   * GitHub quem é o dono de um token que não existe gastaria uma viagem para
   * responder o que já se sabe daqui.
   */
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "refused"; message: string };

/** Quem pergunta ao GitHub de quem é o token. Trocável para não sair da máquina no exame. */
export type GithubProbe = (token: string) => Promise<GithubIdentity>;

/**
 * A conferência de verdade, contra a API do GitHub.
 *
 * O `octokit` entra por import dinâmico e não no topo do módulo: este serviço é
 * carregado pela ponte na subida da janela, e arrastar o cliente HTTP inteiro
 * para lá só para descobrir que não há token guardado é peso por nada.
 */
const perguntarAoGithub: GithubProbe = async (token) => {
  const { Octokit } = await import("octokit");
  const { data, headers } = await new Octokit({ auth: token }).rest.users.getAuthenticated();

  const cabecalho = headers["x-oauth-scopes"];
  const scopes =
    typeof cabecalho === "string"
      ? cabecalho
          .split(",")
          .map((escopo) => escopo.trim())
          .filter((escopo) => escopo.length > 0)
      : [];

  return { login: data.login, scopes };
};

/**
 * O token do GitHub: guardar, esquecer e conferir de quem ele é.
 *
 * Mora num serviço porque a interface, a linha de comando e o source fazem a
 * mesma pergunta por caminhos diferentes, e porque a parte fácil de errar não é
 * guardar: é o que fica para trás. Trocar o token sem apagar o login e os
 * escopos da conferência anterior faz a tela mostrar a conta antiga com o
 * token novo, que é exatamente a hora em que alguém precisa confiar no que lê.
 */
export class GithubService {
  constructor(
    private readonly secrets: SecretService = secretService,
    private readonly settings: SettingsService = settingsService,
    private readonly probe: GithubProbe = perguntarAoGithub,
    private readonly ref: string = GITHUB_CREDENTIAL_REF,
  ) {}

  private chave(sufixo: string): string {
    return `github:${this.ref}:${sufixo}`;
  }

  async status(): Promise<GithubStatus> {
    const [conferidoEm, login, escopos] = await Promise.all([
      this.settings.get(this.chave(CONFERIDO_EM)),
      this.settings.get(this.chave(LOGIN)),
      this.settings.get(this.chave(ESCOPOS)),
    ]);

    const ambiente = process.env[GITHUB_TOKEN_ENV];

    const guardado = this.secrets.has(this.ref) ? this.secrets.get(this.ref) : undefined;
    const ref = guardado === undefined ? undefined : lerRef(guardado);

    let erro: string | null = null;
    if (ref !== undefined) {
      try {
        tokenDoGh(ref);
      } catch (e) {
        erro = e instanceof Error ? e.message : String(e);
      }
    }

    return {
      ref: this.ref,
      erro,
      vinculo: ref === undefined ? null : { host: ref.host, login: ref.login, ...(ref.configDir === undefined ? {} : { configDir: ref.configDir }) },
      stored: this.secrets.has(this.ref),
      vault: this.secrets.available,
      env: ambiente !== undefined && ambiente.length > 0,
      checkedAt: conferidoEm === undefined ? null : Number(conferidoEm),
      identity:
        login === undefined
          ? null
          : {
              login,
              // Escopo nenhum e cadastro nunca gravado ficam iguais em texto, e
              // aqui os dois viram lista vazia de propósito: o token de escopo
              // fino não tem o que listar, e inventar diferença seria mentira.
              scopes: escopos === undefined || escopos.length === 0 ? [] : escopos.split(","),
            },
    };
  }

  /**
   * Guarda o token e joga fora o que a conferência anterior tinha descoberto.
   *
   * O login e os escopos descrevem o token que estava ali, e não a referência:
   * mantê-los depois da troca faria a tela afirmar, com cara de dado conferido,
   * uma conta que o token novo pode nem ter.
   */
  async setToken(token: string): Promise<void> {
    const limpo = token.trim();
    if (limpo.length === 0) throw new Error("token vazio não se guarda, use clearToken");

    this.secrets.set(this.ref, limpo);
    await this.esquecerConferencia();
  }

  /** As contas que o gh tem nesta máquina, para a pessoa escolher. Nunca o token. */
  async contasDoGh(configDir?: string): Promise<GhConta[]> {
    return contasDoGh(configDir);
  }

  /**
   * Vincula a conexão a uma conta do gh. Guarda só a referência, nunca o token,
   * e joga fora a conferência da credencial anterior pelo mesmo motivo do `setToken`.
   */
  async usarGh(ref: GhRef): Promise<void> {
    const host = ref.host.trim();
    const login = ref.login.trim();
    const configDir = ref.configDir?.trim();
    // Vão como argumento do gh: nada que ele leia como opção.
    if (host.length === 0 || login.length === 0 || host.startsWith("-") || login.startsWith("-")) {
      throw new Error("host e login do gh precisam ser preenchidos e não podem começar com hífen");
    }
    this.secrets.set(
      this.ref,
      serializarRef({ origem: "gh", host, login, ...(configDir === undefined || configDir.length === 0 ? {} : { configDir }) }),
    );
    await this.esquecerConferencia();
  }

  /** Devolve se havia algo para apagar. */
  async clearToken(): Promise<boolean> {
    const havia = this.secrets.remove(this.ref);
    await this.esquecerConferencia();
    return havia;
  }

  async check(): Promise<GithubCheck> {
    let token: string | undefined;
    try {
      token = githubToken(this.secrets, this.ref);
    } catch (erro) {
      return { ok: false, reason: "refused", message: erro instanceof Error ? erro.message : String(erro) };
    }
    if (token === undefined) return { ok: false, reason: "missing" };

    try {
      const { login, scopes } = await this.probe(token);
      const checkedAt = Math.floor(Date.now() / 1000);

      await this.settings.set(this.chave(LOGIN), login);
      await this.settings.set(this.chave(ESCOPOS), scopes.join(","));
      await this.settings.set(this.chave(CONFERIDO_EM), String(checkedAt));

      return { ok: true, login, scopes, checkedAt };
    } catch (erro) {
      const bruta = erro instanceof Error ? erro.message : String(erro);
      // O cliente HTTP já esconde o cabeçalho de autorização, mas a mensagem
      // dele passa por log e por tela, e quem a monta é código de terceiro.
      // Raspar o token daqui custa uma linha e não depende dessa promessa.
      return { ok: false, reason: "refused", message: bruta.split(token).join("[token]") };
    }
  }

  /**
   * O login da conta do token, do jeito que a última conferência descobriu.
   *
   * Sai da conferência guardada e não de uma chamada nova ao GitHub: quem
   * pergunta isto é o filtro de autoria do agendador, que roda a cada batida, e
   * uma viagem por batida gastaria cota de API para reler um valor que só muda
   * quando alguém troca o token, e a troca já apaga o que estava aqui.
   *
   * Nulo é "nunca foi conferido", e não "conta nenhuma": quem filtra por
   * autoria precisa tratar os dois como falta de resposta, porque comparar
   * autor com nulo aprovaria ou reprovaria tudo por acidente.
   */
  async viewerLogin(): Promise<string | null> {
    return (await this.status()).identity?.login ?? null;
  }

  async diffMaxChars(): Promise<number> {
    const guardado = Number(await this.settings.get(DIFF_MAX_CHARS_KEY));
    return Number.isSafeInteger(guardado) && guardado > 0 ? guardado : DEFAULT_DIFF_MAX_CHARS;
  }

  async setDiffMaxChars(chars: number): Promise<void> {
    if (!Number.isSafeInteger(chars) || chars <= 0) {
      throw new Error(`teto do diff precisa ser inteiro positivo, veio ${chars}`);
    }
    await this.settings.set(DIFF_MAX_CHARS_KEY, String(chars));
  }

  private async esquecerConferencia(): Promise<void> {
    await this.settings.remove(this.chave(LOGIN));
    await this.settings.remove(this.chave(ESCOPOS));
    await this.settings.remove(this.chave(CONFERIDO_EM));
  }
}

export const githubService = new GithubService();

/**
 * O pull request é de quem este gatilho quer olhar.
 *
 * A comparação ignora maiúscula porque o GitHub trata login assim, e o mesmo
 * dono chega escrito de dois jeitos dependendo de quem digitou: o autor vem da
 * API e a conta conferida vem de `users.getAuthenticated`, mas quem edita o
 * cadastro na mão escreve como quiser.
 */
export function matchesAuthorship(
  wanted: Authorship,
  author: string | undefined,
  viewer: string | null,
): boolean {
  if (wanted === "any") return true;
  // Sem autor no evento ou sem conta conferida não dá para dizer de quem é, e
  // o lado seguro de um filtro é não acordar o agent: rodar em cima de pull
  // request do time achando que é seu abriria tarefa de trabalho alheio.
  if (author === undefined || author.length === 0 || viewer === null) return false;

  const meu = author.toLowerCase() === viewer.toLowerCase();
  return wanted === "mine" ? meu : !meu;
}
