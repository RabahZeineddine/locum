import { before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProfile } from "../src/config/types.js";
import { migrateDb } from "../src/db/migrate.js";
import { CATALOG, ConnectionService } from "../src/services/connection-service.js";
import type { GithubService } from "../src/services/github-service.js";
import type { McpOAuthService } from "../src/services/mcp-oauth-service.js";
import { McpService } from "../src/services/mcp-service.js";
import { SecretService } from "../src/services/secret-service.js";
import type { SettingsService } from "../src/services/settings-service.js";
import { SLACK_MCP_URL, SLACK_REDIRECT_URI, slackManifest } from "../src/services/slack-app.js";
import { SlackService } from "../src/services/slack-service.js";
import { TEAMS_REDIRECT_URI, TEAMS_SERVER } from "../src/services/teams-app.js";

before(() => {
  migrateDb();
});

/**
 * Vitrine com cadastro de verdade num cofre de rascunho, e o resto de mentira.
 * O OAuth falso grava o que o de verdade gravaria, para o estado seguinte bater.
 */
function montar(sonda = { oauth: true, registration: true }, clienteDoClaude: (nome: string) => Promise<undefined | { clientId: string; redirectUri: string }> = async () => undefined) {
  const secrets = new SecretService(mkdtempSync(join(tmpdir(), "locum-vitrine-")));
  secrets.useBackend({
    available: () => true,
    encrypt: (plain) => Buffer.from(plain),
    decrypt: (blob) => blob.toString(),
  });
  const mcp = new McpService(undefined, secrets);
  const ligados = new Set<string>();
  const chamadas: string[] = [];
  const clientes: unknown[] = [];
  const oauth = {
    probe: async () => sonda,
    status: (name: string) => ({ connected: ligados.has(name), expiresAt: null, renewable: false }),
    connect: async (name: string, client?: unknown) => {
      chamadas.push(`connect:${name}`);
      clientes.push(client);
      ligados.add(name);
      return { connected: true, expiresAt: null, renewable: false };
    },
    disconnect: async (name: string) => {
      chamadas.push(`disconnect:${name}`);
      ligados.delete(name);
    },
  } as unknown as McpOAuthService;

  const servico = new ConnectionService({
    mcp,
    oauth,
    github: { status: async () => ({ stored: true, env: false, identity: { login: "octo" } }) } as unknown as GithubService,
    slack: { get: async () => ({ server: null }) } as unknown as SlackService,
    clienteDoClaude,
  });
  return { servico, mcp, chamadas, clientes };
}

test("o catálogo inteiro aparece, com o estado de cada um", async () => {
  const { servico } = montar();
  const lista = await servico.list();
  for (const entrada of CATALOG) assert.ok(lista.some((c) => c.id === entrada.id), entrada.id);

  const porId = new Map(lista.map((c) => [c.id, c]));
  assert.equal(porId.get("github")?.state, "connected");
  assert.equal(porId.get("github")?.account, "octo");
  assert.equal(porId.get("teams")?.state, "available");
});

test("conectar servidor do catálogo cadastra pelo id e autoriza", async () => {
  const { servico, mcp, chamadas } = montar();
  const id = "notion";
  try {
    const conexao = await servico.connect(id);
    assert.equal(conexao.state, "connected");
    assert.deepEqual(chamadas, [`connect:${id}`]);
    assert.equal((await mcp.get(id))?.config.url, CATALOG.find((c) => c.id === id)?.url);

    const desligada = await servico.disconnect(id);
    assert.equal(desligada?.state, "available");
    assert.equal(await mcp.get(id), undefined);
  } finally {
    await mcp.remove(id);
  }
});

test("servidor próprio sem OAuth só entra no cadastro", async () => {
  const { servico, mcp, chamadas } = montar({ oauth: false, registration: false });
  const name = `proprio-${Date.now()}`;
  try {
    const conexao = await servico.addCustom({ name, url: "https://exemplo.test/mcp" });
    assert.equal(conexao.custom, true);
    assert.equal(conexao.state, "connected");
    assert.deepEqual(chamadas, []);
  } finally {
    await mcp.remove(name);
  }
});

test("servidor próprio com OAuth sem registro automático é recusado antes de cadastrar", async () => {
  const { servico, mcp } = montar({ oauth: true, registration: false });
  const name = `semdcr-${Date.now()}`;
  await assert.rejects(servico.addCustom({ name, url: "https://exemplo.test/mcp" }), /registro automático/);
  assert.equal(await mcp.get(name), undefined);
});

test("endereço sem https e nome do catálogo são recusados", async () => {
  const { servico } = montar();
  await assert.rejects(servico.addCustom({ name: "x", url: "http://exemplo.test/mcp" }), /https/);
  await assert.rejects(servico.addCustom({ name: "notion", url: "https://exemplo.test/mcp" }), /catálogo/);
});

/** Configuração em memória, para o Slack de um teste não vazar para o outro. */
function memoria(): SettingsService {
  const mapa = new Map<string, string>();
  return {
    get: async (k: string) => mapa.get(k),
    set: async (k: string, v: string) => void mapa.set(k, v),
    remove: async (k: string) => mapa.delete(k),
  } as unknown as SettingsService;
}

function montarSlack() {
  const secrets = new SecretService(mkdtempSync(join(tmpdir(), "locum-slack-")));
  secrets.useBackend({
    available: () => true,
    encrypt: (plain) => Buffer.from(plain),
    decrypt: (blob) => blob.toString(),
  });
  const mcp = new McpService(undefined, secrets);
  const settings = memoria();
  const slack = new SlackService(memoria());
  const pedidos: Array<{ name: string; client: unknown }> = [];
  let ligado = false;
  const oauth = {
    status: () => ({ connected: ligado, expiresAt: null, renewable: false }),
    connect: async (name: string, client: unknown) => {
      pedidos.push({ name, client });
      ligado = true;
      return { connected: true, expiresAt: null, renewable: false };
    },
    disconnect: async () => {
      ligado = false;
    },
  } as unknown as McpOAuthService;
  const servico = new ConnectionService({
    mcp,
    oauth,
    slack,
    settings,
    github: { status: async () => ({ stored: false, env: false, identity: null }) } as unknown as GithubService,
  });
  return { servico, mcp, slack, pedidos };
}

test("Slack oficial conecta com o client id da pessoa e aponta a origem para as ferramentas oficiais", async () => {
  const { servico, mcp, slack, pedidos } = montarSlack();
  await slack.addChannel("C0CANAL");
  try {
    const conexao = await servico.connectSlack(" 123.456 ");
    assert.equal(conexao.state, "connected");
    assert.equal((await mcp.get("slack"))?.config.url, SLACK_MCP_URL);
    assert.equal(pedidos.length, 1);
    const pedido = pedidos[0]!.client as { clientId: string; redirectUri: string; scope: string };
    assert.equal(pedido.clientId, "123.456");
    assert.equal(pedido.redirectUri, SLACK_REDIRECT_URI);
    assert.match(pedido.scope, /channels:history/);

    const origem = await slack.get();
    assert.equal(origem.server, "slack");
    assert.equal(origem.tool, "slack_read_channel");
    assert.equal(origem.postTool, "slack_send_message");
    assert.equal(origem.textArg, "message");
    assert.deepEqual(origem.channels, ["C0CANAL"], "os canais observados continuam");

    const app = await servico.slackApp();
    assert.equal(app.clientId, "123.456");
    assert.equal(app.connected, true);

    const desligada = await servico.disconnectSlack();
    assert.equal(desligada.state, "available");
    assert.equal(await mcp.get("slack"), undefined);
    assert.equal((await slack.get()).server, null);
    assert.equal((await servico.slackApp()).clientId, "123.456", "o client id fica para reconectar");
  } finally {
    if ((await mcp.get("slack")) !== undefined) await mcp.remove("slack");
  }
});

test("client id fora do formato do Slack é recusado antes de abrir o navegador", async () => {
  const { servico, pedidos } = montarSlack();
  await assert.rejects(servico.connectSlack("nao-e-client-id"), /formato/);
  assert.equal(pedidos.length, 0);
});

test("manifesto do Slack é cliente público com PKCE e retorno no loopback", () => {
  const manifesto = slackManifest() as {
    oauth_config: { pkce_enabled: boolean; redirect_urls: string[]; scopes: { user: string[] } };
  };
  assert.equal(manifesto.oauth_config.pkce_enabled, true);
  assert.deepEqual(manifesto.oauth_config.redirect_urls, [SLACK_REDIRECT_URI]);
  assert.ok(manifesto.oauth_config.scopes.user.includes("chat:write"));
});

function montarTeams() {
  const settings = memoria();
  const diretas: Array<{ name: string; servidor: string; metadata: { authorization_endpoint: string }; client: unknown }> = [];
  const abertas: string[] = [];
  let volta = new URLSearchParams({ admin_consent: "True" });
  let ligado = false;
  const oauth = {
    status: () => ({ connected: ligado, expiresAt: null, renewable: false }),
    connectDirect: async (name: string, servidor: string, metadata: { authorization_endpoint: string }, client: unknown) => {
      diretas.push({ name, servidor, metadata, client });
      ligado = true;
      return { connected: true, expiresAt: null, renewable: false };
    },
    openAndWait: async (_redirect: string, montarUrl: (state: string) => string) => {
      abertas.push(montarUrl("estado"));
      return volta;
    },
    disconnect: async () => {
      ligado = false;
    },
  } as unknown as McpOAuthService;
  const servico = new ConnectionService({
    mcp: new McpService(),
    oauth,
    settings,
    slack: { get: async () => ({ server: null }) } as unknown as SlackService,
    github: { status: async () => ({ stored: false, env: false, identity: null }) } as unknown as GithubService,
  });
  return { servico, diretas, abertas, voltar: (v: URLSearchParams) => (volta = v) };
}

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENTE = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

test("Teams conecta direto no Entra do tenant, sem servidor MCP, e lembra os ids", async () => {
  const { servico, diretas } = montarTeams();

  const conexao = await servico.connectTeams(` ${TENANT} `, CLIENTE);

  assert.equal(conexao.state, "connected");
  assert.equal(diretas.length, 1);
  assert.equal(diretas[0]!.name, TEAMS_SERVER);
  assert.equal(diretas[0]!.servidor, `https://login.microsoftonline.com/${TENANT}/v2.0`);
  assert.equal(diretas[0]!.metadata.authorization_endpoint, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
  const pedido = diretas[0]!.client as { clientId: string; redirectUri: string; scope: string };
  assert.equal(pedido.clientId, CLIENTE.toLowerCase());
  assert.equal(pedido.redirectUri, TEAMS_REDIRECT_URI);
  assert.equal(pedido.scope, "offline_access User.Read Chat.Read ChatMessage.Send");

  const app = await servico.teamsApp();
  assert.equal(app.tenantId, TENANT);
  assert.equal(app.clientId, CLIENTE.toLowerCase());
  assert.equal(app.connected, true);
  assert.match(app.command, /--public-client-redirect-uris http:\/\/localhost:41754\/callback/);

  assert.equal((await servico.disconnectTeams()).state, "available");
  assert.equal((await servico.teamsApp()).tenantId, TENANT, "os ids ficam para reconectar");
});

test("tenant e client id fora do formato são recusados antes de abrir o navegador", async () => {
  const { servico, diretas } = montarTeams();
  await assert.rejects(servico.connectTeams("common", CLIENTE), /tenant/);
  await assert.rejects(servico.connectTeams("empresa.com.br", "nao-e-guid"), /GUID/);
  assert.equal(diretas.length, 0);
});

test("consentimento do administrador abre o link do tenant e exige a confirmação na volta", async () => {
  const { servico, abertas, voltar } = montarTeams();

  await servico.teamsAdminConsent("empresa.com.br", CLIENTE);
  const url = new URL(abertas[0]!);
  assert.equal(url.pathname, "/empresa.com.br/v2.0/adminconsent");
  assert.equal(url.searchParams.get("state"), "estado");
  assert.equal(url.searchParams.get("redirect_uri"), TEAMS_REDIRECT_URI);
  assert.match(url.searchParams.get("scope")!, /https:\/\/graph\.microsoft\.com\/Chat\.Read/);

  voltar(new URLSearchParams());
  await assert.rejects(servico.teamsAdminConsent("empresa.com.br", CLIENTE), /sem confirmar/);
});

test("conectar pela vitrine recadastra o servidor que tem o nome do catálogo e outro endereço", async () => {
  const { servico, mcp, pedidos } = montarSlack();
  await mcp.register({ name: "notion", transport: "http", url: "https://outro.exemplo.dev/mcp" });
  try {
    await servico.connect("notion");
    assert.equal((await mcp.get("notion"))?.config.url, "https://mcp.notion.com/mcp");
    assert.deepEqual(
      pedidos.map((p) => p.name),
      ["notion"],
    );
  } finally {
    await mcp.remove("notion");
  }
});

test("servidor próprio autoriza com o app OAuth que o plugin declara", async () => {
  const declarado = { clientId: "app-da-casa", redirectUri: "http://localhost:53682/callback" };
  const { servico, mcp, clientes } = montar(undefined, async (nome) => (nome === "casa-oauth" ? declarado : undefined));
  await mcp.register({ name: "casa-oauth", transport: "http", url: "https://casa.example/mcp" });
  try {
    await servico.connect("casa-oauth");
    assert.deepEqual(clientes.at(-1), declarado);
  } finally {
    await mcp.remove("casa-oauth");
  }
});

test("o agent que escolhe a conexão aparece em quem usa, mesmo sem ferramenta avulsa dela", async () => {
  const { servico } = montar();
  const agent = AgentProfile.parse({ id: "revisor", name: "Revisor", model: "a/b", connections: [{ connectionId: "github" }] });
  const comFontes = new ConnectionService({
    ...(servico as unknown as { deps: object }).deps,
    fontesDeUso: async () => ({ automacoes: [], agents: [agent], toolsets: [] }),
  });
  assert.deepEqual(await comFontes.usage("github"), [{ tipo: "agent", id: "revisor", nome: "Revisor", como: ["ferramenta"] }]);
  assert.deepEqual(await comFontes.usage("notion"), []);
});

/** Vitrine para os casos em que o servidor MCP de um item do catálogo existe. */
function montarFusao(token: { stored: boolean } = { stored: true }, slackServer: string | null = null) {
  const secrets = new SecretService(mkdtempSync(join(tmpdir(), "locum-fusao-")));
  secrets.useBackend({
    available: () => true,
    encrypt: (plain) => Buffer.from(plain),
    decrypt: (blob) => blob.toString(),
  });
  const mcp = new McpService(undefined, secrets);
  const oauth = {
    status: () => ({ connected: false, expiresAt: null, renewable: false }),
  } as unknown as McpOAuthService;
  if (token.stored) secrets.set("source/github", "ghp_exemplo");
  const servico = new ConnectionService({
    mcp,
    oauth,
    github: { status: async () => ({ stored: token.stored, env: false, identity: null }) } as unknown as GithubService,
    slack: { get: async () => ({ server: slackServer }) } as unknown as SlackService,
  });
  return { servico, mcp, secrets };
}

const SERVIDOR_GITHUB = {
  name: "github",
  transport: "http",
  url: "https://api.githubcopilot.com/mcp/",
  headers: { Authorization: "${credential}" },
} as const;

test("servidor github desligado aparece na conexão GitHub como desligado, em vez de sumir", async () => {
  const { servico, mcp } = montarFusao({ stored: false });
  await mcp.register(SERVIDOR_GITHUB);
  await mcp.setEnabled("github", false);
  try {
    const lista = await servico.list();
    assert.equal(lista.filter((c) => c.id === "github").length, 1, "uma conexão só, e não um cartão solto");
    const github = lista.find((c) => c.id === "github")!;
    assert.deepEqual(github.servers, ["github"]);
    assert.equal(github.state, "attention");
    assert.equal(github.reason, "disabled");
    assert.deepEqual(github.partes, { token: "missing", servidor: "disabled", nome: "github" });
  } finally {
    await mcp.remove("github");
  }
});

test("com token e servidor desligado, a conexão não diz conectado", async () => {
  const { servico, mcp } = montarFusao();
  await mcp.register(SERVIDOR_GITHUB);
  await mcp.setEnabled("github", false);
  try {
    const github = (await servico.list()).find((c) => c.id === "github")!;
    assert.equal(github.state, "attention");
    assert.deepEqual(github.partes, { token: "ok", servidor: "disabled", nome: "github" });
  } finally {
    await mcp.remove("github");
  }
});

test("o token guardado no GitHub alimenta o servidor MCP, que então conta como ok", async () => {
  const { servico, mcp } = montarFusao();
  await mcp.register(SERVIDOR_GITHUB);
  try {
    const github = (await servico.list()).find((c) => c.id === "github")!;
    assert.equal(github.state, "connected");
    assert.deepEqual(github.partes, { token: "ok", servidor: "untested", nome: "github" });
  } finally {
    await mcp.remove("github");
  }
});

test("servidor github sem credencial nenhuma pede o token, e não fica conectado", async () => {
  const { servico, mcp } = montarFusao({ stored: false });
  await mcp.register(SERVIDOR_GITHUB);
  try {
    const github = (await servico.list()).find((c) => c.id === "github")!;
    assert.equal(github.state, "attention");
    assert.equal(github.reason, "no-credential");
    assert.deepEqual(github.partes, { token: "missing", servidor: "no-credential", nome: "github" });
  } finally {
    await mcp.remove("github");
  }
});

test("GitHub sem servidor cadastrado não tem parte de servidor", async () => {
  const { servico } = montarFusao();
  const github = (await servico.list()).find((c) => c.id === "github")!;
  assert.equal(github.state, "connected");
  assert.deepEqual(github.partes, { token: "ok", servidor: null, nome: null });
});

test("servidor slack importado entra em Slack, e não vira conexão própria", async () => {
  const { servico, mcp } = montarFusao();
  await mcp.register({ name: "slack", transport: "http", url: "https://mcp.slack.com/mcp" });
  try {
    const lista = await servico.list();
    assert.equal(lista.filter((c) => c.id === "slack").length, 1);
    const slack = lista.find((c) => c.id === "slack")!;
    assert.deepEqual(slack.servers, ["slack"]);
    assert.notEqual(slack.state, "available");
    assert.equal(lista.some((c) => c.custom && c.id === "slack"), false);
  } finally {
    await mcp.remove("slack");
  }
});

test("servidor de outro nome, mas com o host de um item do catálogo, entra nesse item", async () => {
  const { servico, mcp } = montarFusao();
  await mcp.register({ name: "figma-da-casa", transport: "http", url: "https://mcp.figma.com/mcp" });
  await mcp.register({ name: "ms365", transport: "stdio", command: ["npx", "-y", "@softeria/ms-365-mcp-server"] });
  try {
    const lista = await servico.list();
    assert.deepEqual(lista.find((c) => c.id === "figma")!.servers, ["figma-da-casa"]);
    assert.deepEqual(lista.find((c) => c.id === "teams")!.servers, ["ms365"]);
    assert.equal(lista.some((c) => c.custom && (c.id === "figma-da-casa" || c.id === "ms365")), false);
  } finally {
    await mcp.remove("figma-da-casa");
    await mcp.remove("ms365");
  }
});

test("servidor que não é de nenhum item continua como conexão própria", async () => {
  const { servico, mcp } = montarFusao();
  await mcp.register({ name: "locum-fixture", transport: "http", url: "https://exemplo.test/mcp" });
  try {
    const propria = (await servico.list()).find((c) => c.id === "locum-fixture");
    assert.equal(propria?.custom, true);
  } finally {
    await mcp.remove("locum-fixture");
  }
});

test("conectar um item cujo servidor foi importado com outro nome autoriza o importado, sem cadastrar um segundo", async () => {
  const { servico, mcp, chamadas } = montar();
  await mcp.register({ name: "figma-da-casa", transport: "http", url: "https://mcp.figma.com/mcp" });
  try {
    await servico.connect("figma");
    assert.deepEqual(chamadas, ["connect:figma-da-casa"]);
    assert.equal(await mcp.get("figma"), undefined);
  } finally {
    await mcp.remove("figma-da-casa");
  }
});

test("desconectar remove só o servidor que a conexão cadastrou; o importado com outro nome só perde a credencial", async () => {
  const { servico, mcp, chamadas } = montar();
  await mcp.register({ name: "notion", transport: "http", url: "https://mcp.notion.com/mcp" });
  await mcp.register({ name: "notion-trabalho", transport: "http", url: "https://mcp.notion.com/mcp" });
  try {
    const antes = (await servico.list()).find((c) => c.id === "notion")!;
    assert.deepEqual(antes.desligar, { remove: ["notion"], forget: ["notion-trabalho"], keep: [] });

    await servico.disconnect("notion");
    assert.equal(await mcp.get("notion"), undefined);
    assert.notEqual(await mcp.get("notion-trabalho"), undefined, "o outro servidor continua cadastrado");
    assert.deepEqual(chamadas, ["disconnect:notion", "disconnect:notion-trabalho"]);
  } finally {
    await mcp.remove("notion");
    await mcp.remove("notion-trabalho");
  }
});

test("servidor vinculado a uma origem nunca é apagado nem tem a credencial esquecida ao desconectar", async () => {
  const { servico, mcp, chamadas } = montar();
  await mcp.register(
    { name: "notion", transport: "http", url: "https://mcp.notion.com/mcp" },
    { source: { kind: "claude-user", server: "notion" }, hash: "h" },
  );
  try {
    const conexao = (await servico.list()).find((c) => c.id === "notion")!;
    assert.deepEqual(conexao.desligar, { remove: [], forget: [], keep: ["notion"] });
    await assert.rejects(servico.disconnect("notion"), /vinculad/);
    assert.notEqual(await mcp.get("notion"), undefined);
    assert.deepEqual(chamadas, []);
  } finally {
    await mcp.remove("notion");
  }
});

test("servidor importado no host de um item OAuth, com cabeçalho escrito à mão, não pede autorização", async () => {
  const { servico, mcp } = montar();
  await mcp.register({ name: "sentry-casa", transport: "http", url: "https://mcp.sentry.dev/mcp", headers: { Authorization: "Bearer abc" } });
  await mcp.register({ name: "linear-casa", transport: "http", url: "https://mcp.linear.app/mcp" });
  try {
    const lista = await servico.list();
    const sentry = lista.find((c) => c.id === "sentry")!;
    assert.equal(sentry.state, "connected");
    assert.equal(sentry.reason, "untested");
    assert.equal(lista.find((c) => c.id === "linear")!.reason, "untested", "sem marcador, vale como não testado, e não como autorização faltando");
  } finally {
    await mcp.remove("sentry-casa");
    await mcp.remove("linear-casa");
  }
});

test("a pior instância do item decide o estado, em OAuth e no Teams", async () => {
  const { servico, mcp } = montar();
  await servico.connect("notion");
  await mcp.register({ name: "notion-trabalho", transport: "http", url: "https://mcp.notion.com/mcp" });
  await mcp.setEnabled("notion-trabalho", false);
  await mcp.register({ name: "ms365", transport: "stdio", command: ["npx", "-y", "@softeria/ms-365-mcp-server"] });
  await mcp.register({ name: "ms365-b", transport: "stdio", command: ["npx", "-y", "@softeria/ms-365-mcp-server"] });
  await mcp.setEnabled("ms365-b", false);
  try {
    const lista = await servico.list();
    assert.equal(lista.find((c) => c.id === "notion")!.reason, "disabled");
    const teams = lista.find((c) => c.id === "teams")!;
    assert.equal(teams.state, "attention");
    assert.equal(teams.reason, "disabled");
  } finally {
    for (const n of ["notion", "notion-trabalho", "ms365", "ms365-b"]) await mcp.remove(n);
  }
});

test("GitHub com servidor ok por credencial própria e sem token pede atenção", async () => {
  const { servico, mcp, secrets } = montarFusao({ stored: false });
  await mcp.register({ name: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "${credential}" } });
  await mcp.setCredential("github", { campo: "Authorization", valor: "ghp_proprio" });
  void secrets;
  try {
    const github = (await servico.list()).find((c) => c.id === "github")!;
    assert.deepEqual(github.partes, { token: "missing", servidor: "untested", nome: "github" });
    assert.equal(github.state, "attention");
    assert.equal(github.reason, "no-token");
  } finally {
    await mcp.remove("github");
  }
});

test("Slack com origem escolhida continua listando os outros servidores do item", async () => {
  const { servico, mcp } = montarFusao({ stored: false }, "slack-oficial");
  await mcp.register({ name: "slack-oficial", transport: "http", url: "https://exemplo.test/slack-mcp" });
  await mcp.register({ name: "slack", transport: "http", url: "https://mcp.slack.com/mcp" });
  try {
    const slack = (await servico.list()).find((c) => c.id === "slack")!;
    assert.deepEqual([...slack.servers].sort(), ["slack", "slack-oficial"]);
  } finally {
    await mcp.remove("slack-oficial");
    await mcp.remove("slack");
  }
});

test("a conexão diz quantas ferramentas escrevem, pelas anotações guardadas", async () => {
  const { servico, mcp } = montar();
  await mcp.register({ name: "notion", transport: "http", url: "https://mcp.notion.com/mcp" });
  try {
    // O cache de ferramentas só se enche subindo o servidor; aqui entra pelo mesmo gravador.
    await (mcp as unknown as { guardarFerramentas: (n: string, t: unknown[]) => Promise<void> }).guardarFerramentas("notion", [
      { name: "search", description: "", estimatedTokens: 1, readOnlyHint: true },
      { name: "create_page", description: "", estimatedTokens: 1 },
      { name: "delete_page", description: "", estimatedTokens: 1, destructiveHint: true },
    ]);
    const notion = (await servico.list()).find((c) => c.id === "notion")!;
    assert.equal(notion.toolCount, 3);
    assert.equal(notion.toolWrites, 2);
  } finally {
    await mcp.remove("notion");
  }
});
