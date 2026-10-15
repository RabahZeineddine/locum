import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appHome } from "../db/path.js";

/**
 * Quem sabe cifrar nesta maquina. O Electron implementa por `safeStorage`, que
 * guarda a chave no keychain do macOS; fora dele nao ha implementacao, e por
 * isso `available` existe em vez de a chamada simplesmente estourar.
 */
export interface SecretBackend {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
}

/** Sem app Electron nao ha keychain, e o cofre inteiro fica indisponivel. */
const semKeychain: SecretBackend = {
  available: () => false,
  encrypt() {
    throw new Error("sem keychain nesta maquina");
  },
  decrypt() {
    throw new Error("sem keychain nesta maquina");
  },
};

/**
 * Valor que, em `env` ou `headers` de um servidor MCP, quer dizer "o segredo
 * apontado pelo credential_ref desta linha entra aqui". O cadastro guarda o
 * lugar do segredo, nunca o segredo.
 */
export const CREDENTIAL_PLACEHOLDER = "${credential}";

/** Escopo e nome, ex: `provider/anthropic`. O escopo vira pasta no cofre. */
const REF = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/;

/**
 * Cofre de segredos da instalacao.
 *
 * O banco guarda so a referencia, em `credential_ref`. O segredo em si e
 * cifrado pelo `safeStorage`, cuja chave mora no keychain do macOS, e o texto
 * cifrado fica num arquivo proprio dentro da pasta do app. Nao e "arquivo
 * solto": sem a chave do keychain o arquivo nao diz nada, e separar os dois e
 * justamente o que o `safeStorage` oferece, ja que o Electron nao expoe a API
 * de item do keychain para guardar o valor inteiro la dentro.
 *
 * Quem roda pela linha de comando nao tem `safeStorage`. Nesse caso a leitura
 * devolve `undefined` e quem chama cai para a variavel de ambiente, que e o
 * caminho que sempre funcionou. Gravar, esse nao tem como: exige o app aberto.
 *
 * As operacoes sao sincronas porque o `safeStorage` e sincrono, e fingir
 * assincronia aqui so esconderia isso de quem le.
 */
export class SecretService {
  private backend: SecretBackend = semKeychain;

  constructor(private readonly dir: string = join(appHome(), "secrets")) {}

  /** Chamado pelo processo principal do Electron na subida. */
  useBackend(backend: SecretBackend): void {
    this.backend = backend;
  }

  /** Da para ler e gravar segredo neste processo. */
  get available(): boolean {
    return this.backend.available();
  }

  /** Onde o texto cifrado de uma referencia mora. */
  pathFor(ref: string): string {
    if (!REF.test(ref)) {
      throw new Error(`referencia de credencial invalida: "${ref}", esperado "escopo/nome"`);
    }
    return join(this.dir, `${ref}.bin`);
  }

  /** Existe segredo guardado, sem precisar decifrar. Vale sem keychain. */
  has(ref: string): boolean {
    return existsSync(this.pathFor(ref));
  }

  /**
   * `undefined` quando nao ha nada guardado e tambem quando este processo nao
   * alcanca o keychain, porque nos dois casos a saida de quem chama e a mesma:
   * tentar a variavel de ambiente.
   */
  get(ref: string): string | undefined {
    const file = this.pathFor(ref);
    if (!existsSync(file)) return undefined;
    if (!this.backend.available()) return undefined;
    return this.backend.decrypt(readFileSync(file));
  }

  set(ref: string, secret: string): void {
    if (!this.backend.available()) {
      throw new Error(
        "guardar segredo exige o keychain, que so existe dentro do app; " +
          "pela linha de comando use variavel de ambiente",
      );
    }
    if (secret.length === 0) throw new Error("segredo vazio nao se guarda, use remove");

    const file = this.pathFor(ref);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, this.backend.encrypt(secret), { mode: 0o600 });
  }

  remove(ref: string): boolean {
    const file = this.pathFor(ref);
    if (!existsSync(file)) return false;
    rmSync(file);
    return true;
  }

  /** Referencias guardadas, sem abrir nenhuma. */
  list(): string[] {
    if (!existsSync(this.dir)) return [];
    const refs: string[] = [];
    for (const scope of readdirSync(this.dir, { withFileTypes: true })) {
      if (!scope.isDirectory()) continue;
      for (const file of readdirSync(join(this.dir, scope.name))) {
        if (file.endsWith(".bin")) refs.push(`${scope.name}/${file.slice(0, -4)}`);
      }
    }
    return refs.sort();
  }
}

/**
 * Troca o marcador de credencial pelo segredo, num mapa de `env` ou `headers`.
 *
 * Sem segredo guardado, a entrada de `env` cai para a variavel de ambiente de
 * mesmo nome, que e como a linha de comando sempre funcionou. Nao havendo nem
 * uma coisa nem outra, a entrada some do mapa: mandar o proprio marcador
 * adiante viraria um token literal `${credential}` numa chamada de rede, e uma
 * falha de autenticacao limpa e melhor que isso.
 */
export function fillCredential(
  record: Record<string, string> | undefined,
  secret: string | undefined,
  { envFallback }: { envFallback: boolean },
): Record<string, string> | undefined {
  if (!record) return record;

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== CREDENTIAL_PLACEHOLDER) {
      out[key] = value;
      continue;
    }
    const resolved = secret ?? (envFallback ? process.env[key] : undefined);
    if (resolved !== undefined && resolved.length > 0) out[key] = resolved;
  }
  return out;
}

export const secretService = new SecretService();
