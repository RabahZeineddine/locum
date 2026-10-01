/**
 * O app de Slack que cada pessoa cria no próprio workspace para o Locum.
 *
 * O servidor MCP oficial do Slack não aceita registro automático de cliente, e
 * só atende app interno ou publicado no diretório. Usar o client id de outro
 * produto seria se passar por ele, então o caminho é cada workspace ter o seu
 * app, criado a partir do manifesto abaixo, e o Locum só guardar o client id.
 *
 * O app é cliente público com PKCE, sem segredo: o Slack só aceita retorno em
 * `localhost` assim, e um segredo dentro de app de desktop não seria segredo.
 */

/** O servidor MCP oficial. */
export const SLACK_MCP_URL = "https://mcp.slack.com/mcp";

/**
 * Retorno fixo do OAuth. O Slack confere contra o que está no manifesto, então
 * a porta não pode ser sorteada como nos servidores com registro automático.
 */
export const SLACK_REDIRECT_URI = "http://localhost:41753/callback";

/** Nome do cadastro do servidor oficial. */
export const SLACK_SERVER = "slack";

/**
 * Escopos de usuário: ler canal público e privado, achar canal e pessoa, e
 * responder em thread. Responder continua passando pela fila de aprovação; o
 * escopo só existe para que a resposta aprovada consiga sair.
 *
 * Os seis `search:read.*` são os que a busca de menções e mensagens diretas
 * (`assistant.search.context`) pede a token de usuário. Sem os de `im` e
 * `mpim`, a busca simplesmente não enxerga conversa direta.
 */
export const SLACK_USER_SCOPES = [
  "channels:history",
  "groups:history",
  "search:read.public",
  "search:read.private",
  "search:read.im",
  "search:read.mpim",
  "search:read.files",
  "search:read.users",
  "users:read",
  "chat:write",
];

/**
 * As ferramentas do servidor oficial e os nomes dos argumentos delas, no
 * formato que o cadastro de origem do Slack espera.
 */
export const SLACK_OFFICIAL_SOURCE = {
  tool: "slack_read_channel",
  channelArg: "channel_id",
  sinceArg: "oldest",
  postTool: "slack_send_message",
  postChannelArg: "channel_id",
  textArg: "message",
  threadArg: "thread_ts",
};

/**
 * O manifesto do app.
 *
 * O usuário bot existe só porque o Slack exige um para autorizar; o Locum não
 * fala como bot. O escopo de bot é o mínimo que o manifesto aceita.
 */
export function slackManifest(): Record<string, unknown> {
  return {
    display_information: {
      name: "Locum",
      description: "Agents locais que leem canais e propõem respostas para aprovação.",
    },
    features: {
      bot_user: { display_name: "Locum", always_online: false },
    },
    oauth_config: {
      redirect_urls: [SLACK_REDIRECT_URI],
      pkce_enabled: true,
      scopes: {
        bot: ["users:read"],
        user: SLACK_USER_SCOPES,
      },
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: true,
    },
  };
}

/** Link que abre a criação de app no Slack já com o manifesto preenchido. */
export function slackManifestUrl(): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackManifest()))}`;
}

/** Client id do Slack tem o formato `<número>.<número>`. */
export function validSlackClientId(valor: string): boolean {
  return /^\d+\.\d+$/.test(valor);
}
