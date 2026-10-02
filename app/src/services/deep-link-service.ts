import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { McpService } from "./mcp-service.js";
import { secretService, type SecretService } from "./secret-service.js";
import { clienteHttp } from "../net/http.js";

export const LOCUM_SCHEME = "locum";

/** Para onde o servidor de autorizacao devolve o navegador. */
export const OAUTH_REDIRECT_URI = `${LOCUM_SCHEME}://oauth/callback`;

/** Tempo que uma autorizacao comecada espera pelo retorno antes de vencer. */
const STATE_TTL_MS = 10 * 60_000;

const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

export type DeepLinkRoute =
  | { kind: "oauth-callback"; server: string; code: string; state: string }
  | { kind: "oauth-error"; server: string; error: string; state: string }
  | { kind: "session-ended"; session: string; token: string }
  | { kind: "unknown"; reason: string };

export interface AuthorizationStart {
  server: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scope?: string;
}

export interface AuthorizationRequest {
  /** URL para abrir no navegador de quem esta autorizando. */
  url: string;
  state: string;
}

export interface TokenRequest {
  tokenUrl: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface TokenResponse {
  accessToken: string;
  tokenType?: string;
  refreshToken?: string;
}

export type TokenExchange = (request: TokenRequest) => Promise<TokenResponse>;

export interface AuthorizationResult {
  server: string;
  credentialRef: string;
  hasRefresh: boolean;
}

interface PendingAuthorization {
  state: string;
  codeVerifier: string;
  tokenUrl: string;
  clientId: string;
  createdAt: number;
}

/**
 * Le uma URL `locum://` sem confiar nela.
 *
 * Qualquer programa da maquina consegue abrir um `locum://`, entao o que chega
 * aqui e entrada de fora: nada estoura, tudo que nao bate vira `unknown` com o
 * motivo, e quem chama descarta. O motivo nunca repete o que veio na consulta,
 * porque e ali que o `code` viaja e ele nao pode cair no log.
 */
export function parseDeepLink(raw: string): DeepLinkRoute {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "unknown", reason: "url malformada" };
  }

  if (url.protocol !== `${LOCUM_SCHEME}:`) {
    return { kind: "unknown", reason: `esquema "${url.protocol}" nao e do Locum` };
  }

  const route = `${url.hostname}${url.pathname}`.replace(/\/+$/, "");
  if (route === "session/ended") {
    // So o formato e conferido aqui. Se o nonce e o da sessao, e se ainda nao
    // foi usado, quem decide e `SessionService.finish`.
    const session = url.searchParams.get("session") ?? "";
    const token = url.searchParams.get("token") ?? "";
    if (!SESSION_ID.test(session) || !SESSION_TOKEN.test(token)) {
      return { kind: "unknown", reason: "fim de sessao sem sessao ou token valido" };
    }
    return { kind: "session-ended", session, token };
  }
  if (route !== "oauth/callback") {
    return { kind: "unknown", reason: `rota "${route}" nao existe` };
  }

  const server = url.searchParams.get("server") ?? "";
  if (!NAME.test(server)) return { kind: "unknown", reason: "callback sem servidor valido" };

  const error = url.searchParams.get("error");
  if (error !== null) {
    return { kind: "oauth-error", server, error: error.slice(0, 120), state: url.searchParams.get("state") ?? "" };
  }

  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (code === "" || state === "") return { kind: "unknown", reason: "callback sem code ou state" };

  return { kind: "oauth-callback", server, code, state };
}

/**
 * O lado de dentro do deep link: comecar uma autorizacao, conferir o retorno e
 * guardar o que veio.
 *
 * Mora no servico, e nao no processo principal do Electron, porque a regra e de
 * cadastro: quem valida o `state`, quem troca o codigo e quem decide onde o
 * segredo mora e o mesmo para a interface, para a linha de comando e para
 * qualquer outra casca que apareca depois.
 */
export class DeepLinkService {
  constructor(
    private readonly mcp: McpService = new McpService(),
    private readonly secrets: SecretService = secretService,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Monta a URL de autorizacao e guarda o que o retorno vai precisar.
   *
   * O par `state` mais `code_verifier` fica no cofre, nao em memoria: o macOS
   * pode ter fechado o Locum enquanto a pessoa autorizava no navegador, e a
   * abertura do `locum://` sobe um processo novo, que nao lembra de nada.
   */
  async beginAuthorization(start: AuthorizationStart): Promise<AuthorizationRequest> {
    if (!NAME.test(start.server)) {
      throw new Error(`nome de servidor invalido: "${start.server}"`);
    }
    if ((await this.mcp.get(start.server)) === undefined) {
      throw new Error(`servidor "${start.server}" nao esta cadastrado`);
    }

    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const pending: PendingAuthorization = {
      state,
      codeVerifier,
      tokenUrl: start.tokenUrl,
      clientId: start.clientId,
      createdAt: this.now(),
    };
    this.secrets.set(this.stateRef(start.server), JSON.stringify(pending));

    const url = new URL(start.authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", start.clientId);
    url.searchParams.set("redirect_uri", `${OAUTH_REDIRECT_URI}?server=${start.server}`);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challengeFor(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    if (start.scope !== undefined) url.searchParams.set("scope", start.scope);

    return { url: url.toString(), state };
  }

  /**
   * Desiste da autorizacao pelo retorno de erro do provedor, so se o `state`
   * for o da autorizacao em andamento. O retorno de erro chega pelo mesmo
   * `locum://` que qualquer programa da maquina abre, e sem conferir o
   * `state` um link qualquer derrubaria a autorizacao de quem esta no meio.
   */
  cancelFromCallback(server: string, state: string): boolean {
    const ref = this.stateRef(server);
    const pending = this.readPending(ref);
    if (pending === undefined || !sameSecret(pending.state, state)) return false;
    return this.secrets.remove(ref);
  }

  /** Desiste de uma autorizacao comecada. Devolve se havia o que desistir. */
  cancelAuthorization(server: string): boolean {
    return this.secrets.remove(this.stateRef(server));
  }

  /**
   * Fecha o ciclo: confere o `state`, troca o codigo pelo token e guarda o
   * token no cofre, deixando no cadastro so a referencia.
   *
   * O `state` e consumido antes da troca. Codigo de autorizacao vale uma vez
   * so, e deixar o pendente no cofre depois de usado abriria a porta para um
   * segundo `locum://` reaproveitar o mesmo `state`. Um retorno com `state`
   * errado nao consome nada: senao qualquer link derrubaria a autorizacao em
   * andamento antes do retorno de verdade chegar.
   */
  async completeOAuth(
    route: Extract<DeepLinkRoute, { kind: "oauth-callback" }>,
    exchange: TokenExchange = exchangeCode,
  ): Promise<AuthorizationResult> {
    const ref = this.stateRef(route.server);
    const pending = this.readPending(ref);
    if (pending === undefined) {
      throw new Error(`nenhuma autorizacao pendente para "${route.server}"`);
    }

    if (this.now() - pending.createdAt > STATE_TTL_MS) {
      this.secrets.remove(ref);
      throw new Error(`a autorizacao de "${route.server}" venceu, comece de novo`);
    }
    if (!sameSecret(pending.state, route.state)) {
      throw new Error(`o state do retorno de "${route.server}" nao confere`);
    }
    this.secrets.remove(ref);

    const token = await exchange({
      tokenUrl: pending.tokenUrl,
      clientId: pending.clientId,
      code: route.code,
      codeVerifier: pending.codeVerifier,
      redirectUri: `${OAUTH_REDIRECT_URI}?server=${route.server}`,
    });

    // O que vai para o cofre e o valor do cabecalho pronto, e nao o token cru:
    // a substituicao de `${credential}` troca o valor inteiro da entrada, entao
    // nao ha onde montar o "Bearer " depois.
    const credentialRef = `mcp/${route.server}`;
    this.secrets.set(credentialRef, `${token.tokenType ?? "Bearer"} ${token.accessToken}`);
    if (token.refreshToken !== undefined) {
      this.secrets.set(this.refreshRef(route.server), token.refreshToken);
    }
    await this.mcp.setCredentialRef(route.server, credentialRef);

    return { server: route.server, credentialRef, hasRefresh: token.refreshToken !== undefined };
  }

  /** Ha autorizacao esperando retorno para este servidor. */
  isAwaitingCallback(server: string): boolean {
    return this.secrets.has(this.stateRef(server));
  }

  private readPending(ref: string): PendingAuthorization | undefined {
    const raw = this.secrets.get(ref);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as PendingAuthorization;
    } catch {
      return undefined;
    }
  }

  private stateRef(server: string): string {
    return `oauth-state/${server}`;
  }

  private refreshRef(server: string): string {
    return `oauth-refresh/${server}`;
  }
}

/**
 * A troca de verdade, contra o servidor de autorizacao.
 *
 * Fica trocavel porque nao ha servidor remoto cadastrado ainda: o smoke prova o
 * caminho inteiro com uma troca de mentira, sem chamada de rede e sem segredo
 * de verdade em lugar nenhum.
 */
export async function exchangeCode(request: TokenRequest): Promise<TokenResponse> {
  const response = await clienteHttp(request.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: request.code,
      redirect_uri: request.redirectUri,
      client_id: request.clientId,
      code_verifier: request.codeVerifier,
    }),
  });

  // O corpo do erro pode trazer de volta o codigo mandado, entao so o status
  // sai daqui: mensagem de erro vira log e log nao e lugar de segredo.
  if (!response.ok) {
    throw new Error(`o servidor de autorizacao respondeu ${response.status} na troca do codigo`);
  }

  const body = (await response.json()) as Record<string, unknown>;
  const accessToken = body.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("a resposta da troca nao trouxe access_token");
  }

  return {
    accessToken,
    tokenType: typeof body.token_type === "string" ? body.token_type : undefined,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
  };
}

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Comparacao de tamanho constante, porque `state` e defesa contra forjar retorno. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const deepLinkService = new DeepLinkService();
