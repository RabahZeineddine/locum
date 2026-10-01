import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * O app do Microsoft Entra que cada organização registra para o Locum.
 *
 * Não existe servidor MCP oficial do Teams que atenda um app de desktop, então
 * o Locum fala direto com o Microsoft Graph, com a identidade de quem conectou.
 * O registro é de um tenant só, cliente público com PKCE e retorno em
 * `localhost`: é o formato que o Entra prevê para app nativo, sem segredo,
 * porque segredo dentro de app de desktop não seria segredo.
 *
 * Cada organização registra o seu app em vez de usar um app multi-tenant do
 * projeto. Assim quem decide o que o Locum pode ler é o administrador do
 * próprio tenant, e o projeto não precisa de verificação de publicador para
 * funcionar em qualquer empresa.
 */

/** Nome da conexão, no cofre e no estado do OAuth. */
export const TEAMS_SERVER = "teams";

/**
 * Retorno fixo do OAuth. O Entra confere contra o que está no registro do app,
 * então a porta não pode ser sorteada. É outra que a do Slack para as duas
 * conexões poderem acontecer ao mesmo tempo.
 */
export const TEAMS_REDIRECT_URI = "http://localhost:41754/callback";

/** Onde mora o Graph. */
export const GRAPH_URL = "https://graph.microsoft.com/v1.0";

const LOGIN = "https://login.microsoftonline.com";

/**
 * Escopos delegados: ler as conversas de chat da pessoa e mandar mensagem
 * nelas. Nenhum deles pede consentimento de administrador, e mandar continua
 * passando pela fila de aprovação; o escopo só existe para que a resposta
 * aprovada consiga sair.
 *
 * Canal de equipe fica de fora por enquanto. Ler canal pede
 * `ChannelMessage.Read.All`, que só o administrador libera, e pedir um escopo
 * que nada usa ainda seria pedir acesso a mais.
 */
export const TEAMS_SCOPES = ["User.Read", "Chat.Read", "ChatMessage.Send"];

/** O que vai no pedido de autorização: os do Graph e o de renovar o token. */
export function teamsScope(): string {
  return ["offline_access", ...TEAMS_SCOPES].join(" ");
}

/**
 * Os endereços do Entra para um tenant, no formato que o SDK do MCP espera.
 *
 * Montados à mão e não descobertos: o documento de descoberta do Entra não
 * lista `code_challenge_methods_supported`, embora aceite S256, e anunciar o
 * método aqui é o que faz o SDK mandar o desafio. Sem métodos de autenticação
 * listados, o SDK trata o cliente como público e manda só o `client_id`, que é
 * o que o Entra quer de app nativo.
 */
export function entraMetadata(tenant: string): AuthorizationServerMetadata {
  const base = `${LOGIN}/${encodeURIComponent(tenant)}`;
  return {
    issuer: `${base}/v2.0`,
    authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
    token_endpoint: `${base}/oauth2/v2.0/token`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
  };
}

/** Endereço do servidor de autorização, que identifica a conexão no SDK. */
export function entraAuthorizationServer(tenant: string): string {
  return `${LOGIN}/${encodeURIComponent(tenant)}/v2.0`;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMINIO = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Client id do Entra é um GUID. */
export function validTeamsClientId(valor: string): boolean {
  return GUID.test(valor);
}

/**
 * Tenant aceito como GUID ou como domínio verificado (`empresa.com.br`).
 *
 * `common` e `organizations` ficam de fora de propósito: o app é de um tenant
 * só, e o Entra recusaria a entrada por eles com um erro que ninguém entende.
 */
export function validTeamsTenant(valor: string): boolean {
  return GUID.test(valor) || DOMINIO.test(valor);
}

/**
 * Link de consentimento do administrador.
 *
 * Nenhum escopo de hoje precisa dele, mas há empresa que desliga o
 * consentimento do próprio usuário, e aí só o administrador libera o app. Com
 * este link ele aprova uma vez pelo tenant inteiro, e ninguém mais vê a tela de
 * permissão.
 */
export function teamsAdminConsentUrl(tenant: string, clientId: string, state: string): string {
  const url = new URL(`${LOGIN}/${encodeURIComponent(tenant)}/v2.0/adminconsent`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", TEAMS_SCOPES.map((s) => `https://graph.microsoft.com/${s}`).join(" "));
  url.searchParams.set("redirect_uri", TEAMS_REDIRECT_URI);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * O comando que registra o app pela CLI do Azure, para quem prefere não clicar
 * pelo portal. Sem lista de permissões: o Locum pede os escopos na hora de
 * conectar, e o Entra aceita pedido dinâmico de escopo delegado.
 */
export function teamsAppCommand(): string {
  return [
    "az ad app create",
    "--display-name Locum",
    "--sign-in-audience AzureADMyOrg",
    `--public-client-redirect-uris ${TEAMS_REDIRECT_URI}`,
    "--query appId -o tsv",
  ].join(" ");
}
