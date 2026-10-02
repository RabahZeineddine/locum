import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { execFileSync } from "node:child_process";
import { claudeFixedPaths } from "../runtimes/claude-binary.js";
import { CODEX_DEFAULT_MODEL } from "../runtimes/codex.js";

/**
 * Identificador de modelo e sempre "provider/model-id".
 * O provider "claude-code" nao e um provider de API: e o runtime que gasta a
 * assinatura Max, e por isso nao expoe LanguageModel.
 */
export type ModelId = `${string}/${string}`;

export function splitModelId(id: string): { provider: string; model: string } {
  const at = id.indexOf("/");
  if (at < 1) throw new Error(`model id invalido: "${id}", esperado "provider/model"`);
  return { provider: id.slice(0, at), model: id.slice(at + 1) };
}

export type ProviderEntry = {
  /** Sem credencial, o provider simplesmente nao existe nesta maquina. */
  available: () => boolean;
  /**
   * Variaveis de ambiente que precisam estar presentes. Vazio quando a
   * disponibilidade nao vem do ambiente, como no binario da assinatura.
   */
  requires: string[];
  model?: (id: string) => LanguageModel;
  /**
   * Onde perguntar quais modelos existem. O catalogo e do provedor, e um
   * gateway expoe o que quiser: lista fixa no codigo envelhece e mente.
   */
  catalog?: () => { url: string; headers: Record<string, string> };
  /**
   * Modelos que valem sem perguntar a ninguém, para quem não publica catálogo.
   *
   * Só a assinatura usa: o binário do Claude Code aceita os apelidos de
   * família e resolve sozinho a versão mais nova de cada uma, então a lista
   * não envelhece como envelheceria uma lista de ids datados.
   */
  fixedModels?: string[];
  /** Prefixo que o catálogo põe no id e que a chamada não usa. */
  catalogPrefix?: string;
  /**
   * A variavel de ambiente que o segredo do cofre preenche, quando existe uma.
   *
   * Mora na propria entrada, e nao numa tabela em paralelo, porque e o unico
   * lugar onde ela nao pode discordar do `requires` e do `available` logo
   * acima. Ausente quer dizer que nao ha chave a guardar: a assinatura vive da
   * sessao do binario e o servidor local nao pede credencial. Nos compativeis
   * com OpenAI so a chave entra aqui; a URL base nao e segredo e continua no
   * ambiente.
   */
  secretVar?: string;
  /**
   * O que quem cadastrou escreveu, quando o provedor veio do banco.
   *
   * Ausente quer dizer provedor de fábrica. Quem administra precisa da
   * diferença: só o cadastrado tem endereço escolhido por alguém, e só ele
   * pode ser removido.
   */
  registered?: { label: string; baseUrl: string };
};

/**
 * Provedor compatível com OpenAI cadastrado nesta máquina.
 *
 * O endereço base vem do cadastro, e não do ambiente como nos fixos: quem
 * registra um gateway próprio já disse onde ele fica, e pedir de novo numa
 * variável guardaria a mesma informação em dois lugares que podem discordar.
 * A chave continua fora daqui, no cofre, como em todo provedor.
 */
export type RegisteredProvider = {
  id: string;
  label: string;
  baseUrl: string;
};

/**
 * A variável de ambiente que a chave de um provedor cadastrado preenche.
 *
 * Derivada do identificador, e não escolhida por quem cadastra. Nos fixos a
 * variável é a que o provedor documenta e por isso está escrita no código;
 * aqui não há documento nenhum a respeitar, e deixar alguém inventar o nome
 * só criaria uma segunda coisa para errar na hora de cair para o ambiente.
 */
export function registeredSecretVar(id: string): string {
  return `LOCUM_PROVIDER_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`;
}

/** Os nomes que o registro traz de fábrica. Cadastro nenhum pode tomar um. */
export function fixedProviderIds(): string[] {
  return Object.keys(buildProviders());
}

let codexChecked: boolean | undefined;

/**
 * Esquece o que se sabe dos binários de assinatura. Quem chama é a subida do
 * app, depois de juntar o PATH do shell de login: a resposta dada antes dele
 * valia para o PATH do Finder, que não enxerga `~/.local/bin` nem o Homebrew.
 */
export function forgetSubscriptionBinaries(): void {
  codexChecked = undefined;
  claudeBinaryChecked = undefined;
}

/**
 * Binário presente e login feito. `codex login status` sai com zero só quando
 * há sessão, seja do plano ChatGPT ou de chave.
 */
export function codexAvailable(): boolean {
  if (codexChecked !== undefined) return codexChecked;
  try {
    execFileSync("codex", ["login", "status"], { stdio: "ignore", timeout: 5000 });
    codexChecked = true;
  } catch {
    codexChecked = false;
  }
  return codexChecked;
}

let claudeBinaryChecked: boolean | undefined;

/** Binario presente e sessao valida. Sem isso a via de assinatura nao existe. */
export function claudeCodeAvailable(): boolean {
  if (claudeBinaryChecked !== undefined) return claudeBinaryChecked;
  // Pelo nome primeiro, e depois nos lugares fixos: instalado em
  // `~/.claude/local`, o binário só existe como alias do `.zshrc` e o nome
  // sozinho não acha, embora o runtime o encontre pelo caminho absoluto.
  claudeBinaryChecked = ["claude", ...claudeFixedPaths()].some((comando) => {
    try {
      execFileSync(comando, ["--version"], { stdio: "ignore", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  });
  return claudeBinaryChecked;
}

/**
 * `secrets` vem do keychain, indexado por variavel de ambiente, e vence o
 * ambiente do processo: quem cadastrou a chave pelo app nao deveria precisar
 * exportar nada no shell. Sem nada guardado, tudo se comporta como antes.
 *
 * `registered` são os provedores compatíveis com OpenAI que alguém cadastrou,
 * e entram depois dos fixos. A lista chega de fora porque este módulo não
 * abre banco: é o `ProviderService` que lê a tabela e remonta o registro.
 */
export function buildProviders(
  secrets: Record<string, string> = {},
  registered: RegisteredProvider[] = [],
): Record<string, ProviderEntry> {
  const env = (name: string): string | undefined => {
    const v = secrets[name] ?? process.env[name];
    return v && v.length > 0 ? v : undefined;
  };

  const compat = (name: string, keyVar: string, urlVar: string) => {
    const apiKey = env(keyVar);
    const baseURL = env(urlVar);
    return {
      available: () => Boolean(apiKey && baseURL),
      requires: [keyVar, urlVar],
      secretVar: keyVar,
      model: (id: string) =>
        createOpenAICompatible({ name, apiKey: apiKey!, baseURL: baseURL! }).chatModel(id),
      catalog: () => ({
        url: `${baseURL!.replace(/\/$/, "")}/models`,
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
    } satisfies ProviderEntry;
  };

  const fixos: Record<string, ProviderEntry> = {
    "claude-code": { available: claudeCodeAvailable, requires: [], fixedModels: ["opus", "sonnet", "haiku"] },
    // O plano decide os modelos da conta; `default` deixa a escolha com o Codex.
    codex: { available: codexAvailable, requires: [], fixedModels: [CODEX_DEFAULT_MODEL] },

    anthropic: {
      available: () => Boolean(env("ANTHROPIC_API_KEY")),
      requires: ["ANTHROPIC_API_KEY"],
      secretVar: "ANTHROPIC_API_KEY",
      model: (id) => createAnthropic({ apiKey: env("ANTHROPIC_API_KEY")! })(id),
      catalog: () => ({
        url: "https://api.anthropic.com/v1/models",
        headers: {
          "x-api-key": env("ANTHROPIC_API_KEY")!,
          "anthropic-version": "2023-06-01",
        },
      }),
    },
    openai: {
      available: () => Boolean(env("OPENAI_API_KEY")),
      requires: ["OPENAI_API_KEY"],
      secretVar: "OPENAI_API_KEY",
      model: (id) => createOpenAI({ apiKey: env("OPENAI_API_KEY")! })(id),
      catalog: () => ({
        url: "https://api.openai.com/v1/models",
        headers: { Authorization: `Bearer ${env("OPENAI_API_KEY")}` },
      }),
    },
    google: {
      available: () => Boolean(env("GOOGLE_GENERATIVE_AI_API_KEY")),
      requires: ["GOOGLE_GENERATIVE_AI_API_KEY"],
      secretVar: "GOOGLE_GENERATIVE_AI_API_KEY",
      model: (id) => createGoogleGenerativeAI({ apiKey: env("GOOGLE_GENERATIVE_AI_API_KEY")! })(id),
      catalog: () => ({
        url: "https://generativelanguage.googleapis.com/v1beta/models",
        headers: { "x-goog-api-key": env("GOOGLE_GENERATIVE_AI_API_KEY")! },
      }),
      catalogPrefix: "models/",
    },

    glm: compat("glm", "GLM_API_KEY", "GLM_BASE_URL"),

    ollama: {
      available: () => Boolean(env("OLLAMA_BASE_URL")),
      requires: ["OLLAMA_BASE_URL"],
      model: (id) =>
        createOpenAICompatible({ name: "ollama", apiKey: "ollama", baseURL: env("OLLAMA_BASE_URL")! }).chatModel(id),
      catalog: () => ({
        url: `${env("OLLAMA_BASE_URL")!.replace(/\/$/, "")}/models`,
        headers: {},
      }),
    },
  };

  for (const cadastrado of registered) {
    // O fixo vence, e esta é a segunda tranca: o serviço já recusa cadastro
    // com nome de provedor de fábrica, e aqui um cadastro que passasse ainda
    // assim não conseguiria apontar o `anthropic` de alguém para outro
    // endereço, levando a chave junto.
    if (cadastrado.id in fixos) continue;

    const keyVar = registeredSecretVar(cadastrado.id);
    const apiKey = env(keyVar);
    const baseURL = cadastrado.baseUrl.replace(/\/$/, "");

    fixos[cadastrado.id] = {
      available: () => Boolean(apiKey),
      requires: [keyVar],
      secretVar: keyVar,
      registered: { label: cadastrado.label, baseUrl: baseURL },
      model: (id) =>
        createOpenAICompatible({ name: cadastrado.id, apiKey: apiKey!, baseURL }).chatModel(id),
      catalog: () => ({
        url: `${baseURL}/models`,
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
    };
  }

  return fixos;
}

export type ModelResolution = {
  requested: string;
  used: string;
  provider: string;
  model: string;
  substitutionReason?: string;
};

export type FallbackRow = { fromModel: string; toModel: string; order: number };

/**
 * Resolve o modelo do passo nesta maquina. O passo nunca muda, so a tabela.
 * Cadeia sem saida devolve erro em vez de escolher sozinho.
 */
export function resolveModel(
  requested: string,
  fallbacks: FallbackRow[],
  providers: Record<string, ProviderEntry> = buildProviders(),
): ModelResolution {
  const seen = new Set<string>();
  let current = requested;
  let hops = 0;

  while (!seen.has(current)) {
    seen.add(current);
    const { provider, model } = splitModelId(current);
    const entry = providers[provider];

    if (entry?.available()) {
      return {
        requested,
        used: current,
        provider,
        model,
        substitutionReason:
          hops === 0 ? undefined : `${requested} indisponivel nesta maquina, ${hops} substituicao(oes)`,
      };
    }

    const next = fallbacks
      .filter((f) => f.fromModel === current)
      .sort((a, b) => a.order - b.order)
      .find((f) => !seen.has(f.toModel));

    if (!next) {
      throw new Error(
        `modelo "${requested}" indisponivel nesta maquina e sem fallback restante (parou em "${current}")`,
      );
    }
    current = next.toModel;
    hops += 1;
  }

  throw new Error(`ciclo na tabela de fallback a partir de "${requested}"`);
}
