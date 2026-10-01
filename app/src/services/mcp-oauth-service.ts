import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { mcpService, type McpService } from "./mcp-service.js";
import { CREDENTIAL_PLACEHOLDER, secretService, type SecretService } from "./secret-service.js";

type FetchLike = typeof fetch;

/** Quanto antes do vencimento o token é trocado, para não vencer no meio de um passo. */
const REFRESH_MARGIN_MS = 2 * 60_000;

/** Quanto a janela espera a pessoa autorizar no navegador. */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** O que se descobre de um servidor MCP remoto antes de cadastrar. */
export interface OAuthProbe {
  /** O servidor pede OAuth. */
  oauth: boolean;
  /** O servidor de autorização aceita registro de cliente sem cadastro prévio. */
  registration: boolean;
}

export interface OAuthStatus {
  connected: boolean;
  /** Vencimento do token de acesso, em milissegundos, quando o servidor informou. */
  expiresAt: number | null;
  /** Dá para renovar sem abrir o navegador de novo. */
  renewable: boolean;
}

/** Tudo que a renovação precisa, guardado no cofre ao lado do token. */
interface StoredGrant {
  authorizationServerUrl: string;
  metadata?: AuthorizationServerMetadata;
  clientInformation: OAuthClientInformationMixed;
  refreshToken?: string;
  expiresAt: number | null;
  resource?: string;
}

export interface McpOAuthDeps {
  mcp: McpService;
  secrets: SecretService;
  openBrowser: (url: string) => Promise<void>;
  fetchFn: FetchLike;
  now: () => number;
  timeoutMs: number;
}

/**
 * Conecta servidor MCP remoto pelo OAuth do próprio protocolo, num clique.
 *
 * O caminho é o da especificação de autorização do MCP: o servidor diz quem
 * autoriza (RFC 9728), o Locum se registra lá sozinho (RFC 7591), e o
 * navegador volta para um endereço de loopback (RFC 8252) com o código. Não há
 * client id para a pessoa colar, que era o que fazia o cadastro de servidor
 * remoto exigir terminal.
 *
 * O retorno é por loopback, e não pelo `locum://`: servidor de autorização
 * aceita `http://127.0.0.1` de qualquer cliente nativo, e esquema próprio
 * depende de cada um. A janela fica aberta enquanto a pessoa autoriza, então
 * não há o problema de o processo ter morrido no meio.
 *
 * O token vai para o cofre em `mcp/<nome>` já com o "Bearer ", e o resto do
 * que a renovação precisa vai em `oauth/<nome>`. O cadastro só guarda a
 * referência, como em qualquer credencial.
 */
export class McpOAuthService {
  private readonly deps: McpOAuthDeps;

  constructor(deps: Partial<McpOAuthDeps> = {}) {
    this.deps = {
      mcp: mcpService,
      secrets: secretService,
      openBrowser: async () => {
        throw new Error("o processo principal não disse como abrir o navegador");
      },
      fetchFn: fetch,
      now: Date.now,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      ...deps,
    };
  }

  /** O processo principal entrega o `shell.openExternal`, que só ele tem. */
  useBrowser(openBrowser: (url: string) => Promise<void>): void {
    this.deps.openBrowser = openBrowser;
  }

  /** Pergunta ao servidor se ele pede OAuth e se aceita registro automático. */
  async probe(url: string): Promise<OAuthProbe> {
    try {
      const info = await discoverOAuthServerInfo(url, { fetchFn: this.deps.fetchFn });
      if (info.authorizationServerMetadata === undefined) return { oauth: false, registration: false };
      return {
        oauth: true,
        registration: info.authorizationServerMetadata.registration_endpoint !== undefined,
      };
    } catch {
      return { oauth: false, registration: false };
    }
  }

  status(name: string): OAuthStatus {
    const grant = this.readGrant(name);
    const connected = grant !== undefined && this.deps.secrets.has(this.tokenRef(name));
    return {
      connected,
      expiresAt: grant?.expiresAt ?? null,
      renewable: grant?.refreshToken !== undefined,
    };
  }

  /**
   * Abre o navegador, espera a autorização e guarda o token.
   *
   * O servidor precisa já estar cadastrado como `http`; o cabeçalho
   * `Authorization` é posto aqui, para que conectar seja o único passo.
   */
  async connect(name: string): Promise<OAuthStatus> {
    const entry = await this.deps.mcp.get(name);
    if (entry === undefined) throw new Error(`servidor MCP "${name}" nao cadastrado`);
    const url = entry.config.url;
    if (entry.config.transport === "stdio" || url === undefined) {
      throw new Error(`"${name}" não é servidor remoto, e OAuth só vale para http`);
    }

    const { fetchFn } = this.deps;
    const info = await discoverOAuthServerInfo(url, { fetchFn });
    const metadata = info.authorizationServerMetadata;
    if (metadata === undefined) throw new Error(`${url} não anunciou servidor de autorização`);
    if (metadata.registration_endpoint === undefined) {
      throw new Error(`o servidor de autorização de ${url} não aceita registro automático de cliente`);
    }
    const resource = info.resourceMetadata?.resource === undefined ? undefined : new URL(info.resourceMetadata.resource);
    const scope = info.resourceMetadata?.scopes_supported?.join(" ") || undefined;

    const retorno = await this.listen();
    try {
      const clientInformation = await registerClient(info.authorizationServerUrl, {
        metadata,
        fetchFn,
        scope,
        clientMetadata: {
          client_name: "Locum",
          redirect_uris: [retorno.redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: metadata.token_endpoint_auth_methods_supported?.includes("none") === false
            ? "client_secret_post"
            : "none",
        },
      });

      const state = randomBytes(32).toString("base64url");
      const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
        metadata,
        clientInformation,
        redirectUrl: retorno.redirectUri,
        scope,
        state,
        resource,
      });

      await this.deps.openBrowser(authorizationUrl.toString());
      const code = await retorno.code(state);

      const tokens = await exchangeAuthorization(info.authorizationServerUrl, {
        metadata,
        clientInformation,
        authorizationCode: code,
        codeVerifier,
        redirectUri: retorno.redirectUri,
        resource,
        fetchFn,
      });

      await this.store(name, tokens, {
        authorizationServerUrl: info.authorizationServerUrl,
        metadata,
        clientInformation,
        resource: resource?.toString(),
      });
      await this.ensureHeader(name);
      return this.status(name);
    } finally {
      retorno.close();
    }
  }

  /** Troca o token quando ele está para vencer. Sem refresh token, não faz nada. */
  async refreshIfNeeded(name: string): Promise<void> {
    const grant = this.readGrant(name);
    if (grant?.refreshToken === undefined || grant.expiresAt === null) return;
    if (grant.expiresAt - this.deps.now() > REFRESH_MARGIN_MS) return;

    const tokens = await refreshAuthorization(grant.authorizationServerUrl, {
      metadata: grant.metadata,
      clientInformation: grant.clientInformation,
      refreshToken: grant.refreshToken,
      resource: grant.resource === undefined ? undefined : new URL(grant.resource),
      fetchFn: this.deps.fetchFn,
    });
    await this.store(name, tokens, grant);
  }

  /** Esquece token e registro. O cadastro do servidor fica, sem credencial. */
  async disconnect(name: string): Promise<void> {
    this.deps.secrets.remove(this.tokenRef(name));
    this.deps.secrets.remove(this.grantRef(name));
    if ((await this.deps.mcp.get(name)) !== undefined) await this.deps.mcp.setCredentialRef(name, null);
  }

  private async store(
    name: string,
    tokens: OAuthTokens,
    grant: Omit<StoredGrant, "refreshToken" | "expiresAt"> & { refreshToken?: string },
  ): Promise<void> {
    const tokenRef = this.tokenRef(name);
    this.deps.secrets.set(tokenRef, `Bearer ${tokens.access_token}`);
    const stored: StoredGrant = {
      authorizationServerUrl: grant.authorizationServerUrl,
      metadata: grant.metadata,
      clientInformation: grant.clientInformation,
      resource: grant.resource,
      // Renovação que não devolve refresh token novo continua valendo o antigo.
      refreshToken: tokens.refresh_token ?? grant.refreshToken,
      expiresAt: tokens.expires_in === undefined ? null : this.deps.now() + tokens.expires_in * 1000,
    };
    this.deps.secrets.set(this.grantRef(name), JSON.stringify(stored));
    await this.deps.mcp.setCredentialRef(name, tokenRef);
  }

  /** Põe o `Authorization: ${credential}` no cadastro, se ele ainda não tiver. */
  private async ensureHeader(name: string): Promise<void> {
    const entry = await this.deps.mcp.get(name);
    if (entry === undefined) return;
    const headers = entry.config.headers ?? {};
    if (headers["Authorization"] === CREDENTIAL_PLACEHOLDER) return;
    await this.deps.mcp.register({ ...entry.config, headers: { ...headers, Authorization: CREDENTIAL_PLACEHOLDER } });
  }

  /**
   * Sobe o endereço de loopback numa porta livre e devolve quem espera o código.
   *
   * Só `/callback` responde. Qualquer outra coisa recebe 404 e não encerra a
   * espera, para que um favicon pedido pelo navegador não conte como retorno.
   */
  private async listen(): Promise<{
    redirectUri: string;
    code: (state: string) => Promise<string>;
    close: () => void;
  }> {
    let entregar: ((query: URLSearchParams) => void) | null = null;
    const chegou = new Promise<URLSearchParams>((resolve) => {
      entregar = resolve;
    });

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const falhou = url.searchParams.has("error");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(paginaDeRetorno(falhou));
      entregar?.(url.searchParams);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;

    return {
      redirectUri: `http://127.0.0.1:${port}/callback`,
      close: () => server.close(),
      code: async (state) => {
        let teto: NodeJS.Timeout | undefined;
        const venceu = new Promise<never>((_, reject) => {
          teto = setTimeout(
            () => reject(new Error("a autorização não voltou do navegador a tempo, tente de novo")),
            this.deps.timeoutMs,
          );
        });
        try {
          const query = await Promise.race([chegou, venceu]);
          const erro = query.get("error");
          if (erro !== null) throw new Error(`o serviço recusou a autorização: ${erro}`);
          if (!mesmoValor(query.get("state") ?? "", state)) throw new Error("o state do retorno não confere");
          const code = query.get("code");
          if (code === null || code === "") throw new Error("o retorno veio sem código de autorização");
          return code;
        } finally {
          clearTimeout(teto);
        }
      },
    };
  }

  private readGrant(name: string): StoredGrant | undefined {
    const raw = this.deps.secrets.get(this.grantRef(name));
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as StoredGrant;
    } catch {
      return undefined;
    }
  }

  private tokenRef(name: string): string {
    return `mcp/${name}`;
  }

  private grantRef(name: string): string {
    return `oauth/${name}`;
  }
}

function mesmoValor(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A página que o navegador mostra ao voltar. Sai nos dois idiomas, porque o navegador não sabe o do app. */
function paginaDeRetorno(falhou: boolean): string {
  const texto = falhou
    ? "A autorização foi recusada. Volte para o Locum. / Authorization was declined. Go back to Locum."
    : "Conectado. Pode fechar esta aba e voltar para o Locum. / Connected. You can close this tab and go back to Locum.";
  return `<!doctype html><meta charset="utf-8"><title>Locum</title><body style="font:16px system-ui;display:grid;place-items:center;height:90vh;color:#222"><p>${texto}</p></body>`;
}

export const mcpOAuthService = new McpOAuthService();
