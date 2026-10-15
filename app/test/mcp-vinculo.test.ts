import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { McpSource } from "../src/config/types.js";
import { ClaudeImportService, pareceOMesmoServidor } from "../src/services/claude-import.js";
import { configMascarada, diferencas, ehChaveDeSegredo, impressao, lerJsonCacheado, mascararArgs, OrigemResolver, preparar, semVersaoDoPlugin } from "../src/services/mcp-origem.js";
import { McpService } from "../src/services/mcp-service.js";
import { SecretService } from "../src/services/secret-service.js";
import { SettingsService } from "../src/services/settings-service.js";
import { bancoDeTeste } from "./helpers/db.js";

const MS365_ANTIGO = {
  command: "npx",
  args: ["-y", "@softeria/ms-365-mcp-server@0.150.0", "--org-mode", "--preset", "onedrive,excel,mail,calendar,teams,search,users"],
  env: { MS365_MCP_CLIENT_ID: "app-1", MS365_MCP_ALLOWED_SCOPES: "User.Read Mail.ReadWrite" },
};
const MS365_NOVO = {
  command: "npx",
  args: ["-y", "@softeria/ms-365-mcp-server@0.155.0", "--org-mode", "--preset", "teams,files,outlook,search,work"],
  env: {
    MS365_MCP_CLIENT_ID: "app-1",
    MS365_MCP_ALLOWED_SCOPES: "User.Read Mail.ReadWrite Chat.ReadWrite Files.ReadWrite.All",
    MS365_MCP_REQUIRE_CONFIRM: "true",
  },
};

/** Uma casa falsa com o plugin `akad` em uma versão, como o Claude Code o guarda. */
class Casa {
  readonly home = mkdtempSync(join(tmpdir(), "locum-vinculo-"));
  private ligado = true;
  private versao = "";

  instalar(versao: string, servidores: Record<string, unknown>): string {
    this.versao = versao;
    const raiz = join(this.home, ".claude", "plugins", "cache", "akad", "akad", versao);
    mkdirSync(raiz, { recursive: true });
    writeFileSync(join(raiz, ".mcp.json"), JSON.stringify({ mcpServers: servidores }));
    this.gravar(raiz);
    return raiz;
  }

  desligar(): void {
    this.ligado = false;
    this.gravar(join(this.home, ".claude", "plugins", "cache", "akad", "akad", this.versao));
  }

  usuario(servidores: Record<string, unknown>): void {
    writeFileSync(join(this.home, ".claude.json"), JSON.stringify({ mcpServers: servidores }));
  }

  private gravar(raiz: string): void {
    mkdirSync(join(this.home, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      join(this.home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "akad@akad": [{ scope: "user", installPath: raiz, version: this.versao }] } }),
    );
    writeFileSync(join(this.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "akad@akad": this.ligado } }));
  }

  limpar(): void {
    rmSync(this.home, { recursive: true, force: true });
  }
}

function montar(casa: Casa) {
  const secrets = new SecretService(mkdtempSync(join(tmpdir(), "locum-vinculo-cofre-")));
  secrets.useBackend({ available: () => true, encrypt: (p) => Buffer.from(p), decrypt: (b) => b.toString() });
  const db = bancoDeTeste();
  const origem = new OrigemResolver({ home: casa.home, ambiente: async () => ({}), ttlMs: 0 });
  const mcp = new McpService(db, secrets, origem);
  const settings = new SettingsService(db);
  const importacao = new ClaudeImportService({ home: casa.home, ambiente: async () => ({}), mcp, secrets, settings });
  return { mcp, importacao, secrets, settings };
}

const PLUGIN: McpSource = { kind: "claude-plugin", marketplace: "akad", plugin: "akad", server: "ms365" };

test("importar guarda a origem, e a configuração vem da origem na hora do uso", async () => {
  const casa = new Casa();
  const raiz = casa.instalar("0.17.1", { insuremo: { command: "${CLAUDE_PLUGIN_ROOT}/scripts/insuremo.sh", args: ["sandbox"] }, ms365: MS365_ANTIGO });
  const { mcp, importacao } = montar(casa);

  await importacao.importar(["insuremo", "ms365"]);
  const entrada = await mcp.get("insuremo");
  assert.deepEqual(entrada?.source, { kind: "claude-plugin", marketplace: "akad", plugin: "akad", server: "insuremo" });
  // O cadastro guarda o caminho aceito, mas quem conecta lê a origem.
  assert.deepEqual(entrada?.config.command, [`${raiz}/scripts/insuremo.sh`, "sandbox"]);
  await mcp.setEnabled("insuremo", true);
  const [config] = await mcp.enabledConfigs();
  assert.deepEqual(config?.command, [`${raiz}/scripts/insuremo.sh`, "sandbox"]);
  casa.limpar();
});

test("plugin em versão nova, mesmo conteúdo: usa a versão instalada e não pede aceite", async () => {
  const casa = new Casa();
  casa.instalar("0.17.1", { insuremo: { command: "${CLAUDE_PLUGIN_ROOT}/scripts/insuremo.sh", args: ["sandbox"] } });
  const { mcp, importacao } = montar(casa);
  await importacao.importar(["insuremo"]);
  await mcp.setEnabled("insuremo", true);

  const nova = casa.instalar("0.21.1", { insuremo: { command: "${CLAUDE_PLUGIN_ROOT}/scripts/insuremo.sh", args: ["sandbox"] } });
  const vinculos = await mcp.vinculos();
  assert.equal(vinculos.insuremo?.estado, "ok");
  assert.deepEqual(vinculos.insuremo?.mudancas, []);

  const [config] = await mcp.enabledConfigs();
  assert.deepEqual(config?.command, [`${nova}/scripts/insuremo.sh`, "sandbox"]);
  // A cópia aceita acompanhou, para continuar servindo se a origem sumir depois.
  assert.deepEqual((await mcp.get("insuremo"))?.config.command, [`${nova}/scripts/insuremo.sh`, "sandbox"]);
  casa.limpar();
});

test("mudança de preset e de escopos na origem pede aceite, mostra o diff e usa a anterior até aceitar", async () => {
  const casa = new Casa();
  casa.instalar("0.17.1", { ms365: MS365_ANTIGO });
  const { mcp, importacao } = montar(casa);
  await importacao.importar(["ms365"]);
  await mcp.setEnabled("ms365", true);

  casa.instalar("0.21.1", { ms365: MS365_NOVO });
  const v = (await mcp.vinculos()).ms365!;
  assert.equal(v.estado, "mudou");
  assert.equal(v.mantida, false);
  const campos = v.mudancas.map((m) => `${m.campo}${m.chave === undefined ? "" : `:${m.chave}`}`);
  assert.deepEqual(campos, ["args", "env:MS365_MCP_ALLOWED_SCOPES", "env:MS365_MCP_REQUIRE_CONFIRM"]);
  const args = v.mudancas.find((m) => m.campo === "args")!;
  assert.match(args.antes ?? "", /onedrive,excel/);
  assert.match(args.depois ?? "", /teams,files,outlook/);

  // Até aceitar, conecta com a anterior.
  const [antes] = await mcp.enabledConfigs();
  assert.ok(antes?.command?.includes("onedrive,excel,mail,calendar,teams,search,users"));
  assert.equal(antes?.env?.MS365_MCP_REQUIRE_CONFIRM, undefined);

  await mcp.aceitarOrigem("ms365", (await mcp.vinculos()).ms365!.hash!);
  assert.equal((await mcp.vinculos()).ms365?.estado, "ok");
  const [depois] = await mcp.enabledConfigs();
  assert.ok(depois?.command?.includes("teams,files,outlook,search,work"));
  assert.equal(depois?.env?.MS365_MCP_REQUIRE_CONFIRM, "true");
  casa.limpar();
});

test("manter a anterior silencia o aviso até a origem mudar de novo", async () => {
  const casa = new Casa();
  casa.instalar("0.17.1", { ms365: MS365_ANTIGO });
  const { mcp, importacao } = montar(casa);
  await importacao.importar(["ms365"]);

  casa.instalar("0.21.1", { ms365: MS365_NOVO });
  await mcp.manterAnterior("ms365", (await mcp.vinculos()).ms365!.hash!);
  const mantida = (await mcp.vinculos()).ms365!;
  assert.equal(mantida.estado, "mudou");
  assert.equal(mantida.mantida, true);

  casa.instalar("0.22.0", { ms365: { ...MS365_NOVO, args: [...MS365_NOVO.args, "--read-only"] } });
  assert.equal((await mcp.vinculos()).ms365?.mantida, false);
  casa.limpar();
});

test("diff mascara segredo: a chave de API muda de nome sem o valor aparecer", () => {
  const antes = { name: "x", transport: "stdio" as const, command: ["npx", "srv", "--api-key=abc123"], env: { MINHA_API_KEY: "valor-antigo", MODO: "a" } };
  const depois = { name: "x", transport: "stdio" as const, command: ["npx", "srv", "--api-key=zzz999"], env: { MINHA_API_KEY: "valor-novo", MODO: "b", NOVO_TOKEN: "sigiloso" } };
  const mudancas = diferencas(antes, depois);
  const texto = JSON.stringify(mudancas);
  assert.ok(!/abc123|zzz999|valor-antigo|valor-novo|sigiloso/.test(texto), texto);
  assert.ok(mudancas.some((m) => m.chave === "MODO" && m.antes === "a" && m.depois === "b"));
  assert.ok(mudancas.some((m) => m.chave === "NOVO_TOKEN" && m.antes === null && m.depois === "<oculto>"));
});

test("a impressão ignora a versão do diretório do plugin, mas não o resto", () => {
  const velha = { name: "s", transport: "stdio" as const, command: ["/h/.claude/plugins/cache/akad/akad/0.17.1/scripts/s.sh", "prod"] };
  const nova = { name: "s", transport: "stdio" as const, command: ["/h/.claude/plugins/cache/akad/akad/0.21.1/scripts/s.sh", "prod"] };
  const outroArg = { ...nova, command: [...nova.command.slice(0, 1), "dev"] };
  assert.equal(impressao(velha, PLUGIN), impressao(nova, PLUGIN));
  assert.notEqual(impressao(nova, PLUGIN), impressao(outroArg, PLUGIN));
  assert.equal(semVersaoDoPlugin("/h/.claude/plugins/cache/akad/akad/0.17.1/a", PLUGIN, undefined), "${CLAUDE_PLUGIN_ROOT}/a");
  // Só o que foi para o cofre fica fora da impressão; variável por resolver compara.
  const a = { name: "s", transport: "stdio" as const, command: ["x"], env: { API_KEY: "${credential}" } };
  assert.equal(impressao(a), impressao({ ...a }));
  assert.notEqual(impressao(a), impressao({ ...a, env: { API_KEY: "${MINHA_VAR}" } }));
});

test("origem que sumiu: usa a última aceita e avisa", async () => {
  const casa = new Casa();
  casa.instalar("0.21.1", { ms365: MS365_NOVO });
  const { mcp, importacao } = montar(casa);
  await importacao.importar(["ms365"]);
  await mcp.setEnabled("ms365", true);

  casa.desligar();
  const v = (await mcp.vinculos()).ms365!;
  assert.equal(v.estado, "sumiu");
  const [config] = await mcp.enabledConfigs();
  assert.ok(config?.command?.includes("teams,files,outlook,search,work"));
  casa.limpar();
});

test("desvincular vira cadastro manual com a configuração de hoje, editável", async () => {
  const casa = new Casa();
  casa.instalar("0.21.1", { ms365: MS365_NOVO });
  const { mcp, importacao } = montar(casa);
  await importacao.importar(["ms365"]);

  await assert.rejects(
    () => mcp.register({ name: "ms365", transport: "stdio", command: ["outro"], scope: "write" }),
    /vinculado a akad@akad.*edite na origem/,
  );
  // O que é do Locum muda sem desvincular.
  await mcp.register({ ...(await mcp.get("ms365"))!.config, scope: "read", idleTimeoutMs: 60_000 });
  assert.equal((await mcp.get("ms365"))?.config.scope, "read");

  await mcp.desvincular("ms365");
  const manual = await mcp.get("ms365");
  assert.equal(manual?.source, null);
  assert.deepEqual(Object.keys(await mcp.vinculos()), []);
  await mcp.register({ ...manual!.config, command: ["npx", "outro"] });
  assert.deepEqual((await mcp.get("ms365"))?.config.command, ["npx", "outro"]);
  casa.limpar();
});

test("segredo literal da origem vai para o cofre e a conexão o recebe; trocar a chave na origem é seguido sem aceite", async () => {
  const casa = new Casa();
  casa.usuario({ plataforma: { type: "http", url: "https://p.exemplo/mcp", headers: { "x-api-key": "chave-1" } } });
  const { mcp, importacao, secrets } = montar(casa);
  await importacao.importar(["plataforma"]);
  await mcp.setEnabled("plataforma", true);
  assert.equal(secrets.get("mcp/plataforma"), "chave-1");
  assert.deepEqual((await mcp.get("plataforma"))?.source, { kind: "claude-user", server: "plataforma" });

  casa.usuario({ plataforma: { type: "http", url: "https://p.exemplo/mcp", headers: { "x-api-key": "chave-2" } } });
  assert.equal((await mcp.vinculos()).plataforma?.estado, "ok");
  const [config] = await mcp.enabledConfigs();
  assert.equal(config?.headers?.["x-api-key"], "chave-2");

  // Já o endereço novo é mudança sensível: a chave não vai para lá sem aceite.
  casa.usuario({ plataforma: { type: "http", url: "https://outro.exemplo/mcp", headers: { "x-api-key": "chave-2" } } });
  const v = (await mcp.vinculos()).plataforma!;
  assert.equal(v.estado, "mudou");
  assert.deepEqual(v.mudancas.map((m) => m.campo), ["url"]);
  assert.equal((await mcp.enabledConfigs())[0]?.url, "https://p.exemplo/mcp");
  casa.limpar();
});

test("migração: cópias antigas voltam a seguir a origem; o que mudou espera aceite; sem origem fica manual", async () => {
  const casa = new Casa();
  const raiz017 = join(casa.home, ".claude", "plugins", "cache", "akad", "akad", "0.17.1");
  const raiz = casa.instalar("0.21.1", {
    ms365: MS365_NOVO,
    "insuremo-sandbox": { command: "${CLAUDE_PLUGIN_ROOT}/scripts/insuremo-mcp.sh", args: ["sandbox"] },
  });
  const { mcp, importacao, settings } = montar(casa);

  // Como estava no banco do usuário: cópias de antes do vínculo.
  await mcp.register({ name: "ms365", transport: "stdio", command: [MS365_ANTIGO.command, ...MS365_ANTIGO.args], env: MS365_ANTIGO.env, scope: "write" });
  await mcp.register({ name: "insuremo-sandbox", transport: "stdio", command: [`${raiz017}/scripts/insuremo-mcp.sh`, "sandbox"], scope: "write" });
  await mcp.register({ name: "meu-proprio", transport: "stdio", command: ["meu-servidor"], scope: "read" });
  // Nenhuma origem declara este nome.
  await mcp.register({ name: "ms365-teste", transport: "stdio", command: ["/bin/cat"], scope: "read" });
  await mcp.setEnabled("ms365", true);
  await mcp.setEnabled("insuremo-sandbox", true);

  const r = await importacao.revincular();
  assert.deepEqual(r.vinculados.sort(), ["insuremo-sandbox", "ms365"]);
  assert.deepEqual(r.manuais.sort(), ["meu-proprio", "ms365-teste"]);
  assert.equal((await mcp.get("meu-proprio"))?.source, null);

  const v = await mcp.vinculos();
  // O insuremo apontava para o cache 0.17.1: é o mesmo servidor, agora na versão instalada.
  assert.equal(v["insuremo-sandbox"]?.estado, "ok");
  const configs = await mcp.enabledConfigs();
  assert.deepEqual(configs.find((c) => c.name === "insuremo-sandbox")?.command, [`${raiz}/scripts/insuremo-mcp.sh`, "sandbox"]);
  // O ms365 ficou com o preset antigo, e o novo passa pelo aceite.
  assert.equal(v.ms365?.estado, "mudou");
  assert.ok(v.ms365?.mudancas.some((m) => m.chave === "MS365_MCP_REQUIRE_CONFIRM"));
  assert.ok(configs.find((c) => c.name === "ms365")?.command?.includes("onedrive,excel,mail,calendar,teams,search,users"));

  // Roda uma vez só: quem desvincula depois não é religado na subida seguinte.
  await mcp.desvincular("insuremo-sandbox");
  assert.deepEqual(await importacao.revincular(), { vinculados: [], manuais: [] });
  assert.equal((await mcp.get("insuremo-sandbox"))?.source, null);
  assert.ok(await settings.get("mcp.vinculo.migrado"));
  casa.limpar();
});

test("nome igual não basta: outro programa ou outro host é cadastro de mão, não cópia da origem", () => {
  assert.equal(pareceOMesmoServidor({ transport: "stdio", command: ["/velho/caminho/s.sh", "a"] }, { command: "${CLAUDE_PLUGIN_ROOT}/scripts/s.sh" }), true);
  assert.equal(pareceOMesmoServidor({ transport: "stdio", command: ["/bin/cat"] }, { command: "npx" }), false);
  assert.equal(pareceOMesmoServidor({ transport: "http", url: "https://a.exemplo/mcp" }, { type: "http", url: "https://a.exemplo/outro" }), true);
  assert.equal(pareceOMesmoServidor({ transport: "http", url: "https://a.exemplo/mcp" }, { type: "http", url: "https://b.exemplo/mcp" }), false);
  assert.equal(pareceOMesmoServidor({ transport: "stdio", command: ["npx"] }, { type: "http", url: "https://a.exemplo/mcp" }), false);
});

/* ------------------------------------------------ revisão: nomes, aceite e ambiente */

test("nome de chave: só palavra inteira de segredo vai para o cofre; endereço e escopo comparam", () => {
  for (const nome of ["MINHA_API_KEY", "x-api-key", "clientSecret", "JIRA_TOKEN", "Authorization", "DB_PASSWORD"]) assert.equal(ehChaveDeSegredo(nome), true, nome);
  for (const nome of ["MS365_OAUTH_SCOPES", "OAUTH_TOKEN_URL", "AUTH_SERVER_URL", "AZURE_AUTHORITY_HOST", "KEYCLOAK_URL", "TOKEN_FILE"]) assert.equal(ehChaveDeSegredo(nome), false, nome);

  const p = preparar(
    "x",
    "usuário",
    { command: "npx", env: { OAUTH_TOKEN_URL: "https://idp.exemplo/token", AUTH_SERVER_URL: "https://idp.exemplo", AZURE_AUTHORITY_HOST: "login.exemplo", GH_TOKEN: "ghp_abc" } },
    undefined,
    {},
    new Set(),
  );
  // O segredo é o token de verdade, e nunca uma URL.
  assert.equal(p.segredo, "ghp_abc");
  assert.equal(p.config.env?.OAUTH_TOKEN_URL, "https://idp.exemplo/token");
  assert.equal(p.config.env?.GH_TOKEN, "${credential}");
  // Chave de segredo cujo valor é URL (webhook, ?token=) continua segredo.
  assert.equal(preparar("y", "usuário", { command: "x", env: { WEBHOOK_SECRET: "https://hooks.exemplo/T123/B456" } }, undefined, {}, new Set()).segredo, "https://hooks.exemplo/T123/B456");
});

test("mudar escopo, URL de token ou servidor de auth na origem pede aceite, com o valor à vista", async () => {
  const casa = new Casa();
  const base = { command: "npx", args: ["srv"], env: { MS365_OAUTH_SCOPES: "a b", OAUTH_TOKEN_URL: "https://idp.exemplo/token", AUTH_SERVER_URL: "https://idp.exemplo", KEYCLOAK_URL: "https://k.exemplo" } };
  casa.instalar("1.0.0", { srv: base });
  const { mcp, importacao } = montar(casa);
  await importacao.importar(["srv"]);
  for (const [chave, novo] of [["MS365_OAUTH_SCOPES", "a b c"], ["OAUTH_TOKEN_URL", "https://malicioso.exemplo/token"], ["AUTH_SERVER_URL", "https://outro.exemplo"], ["KEYCLOAK_URL", "https://x.exemplo"]] as const) {
    casa.instalar("1.0.0", { srv: { ...base, env: { ...base.env, [chave]: novo } } });
    const v = (await mcp.vinculos()).srv!;
    assert.equal(v.estado, "mudou", chave);
    assert.deepEqual(v.mudancas.map((m) => [m.chave, m.depois]), [[chave, novo]], chave);
    // E a conexão segue com a aceita.
    await mcp.setEnabled("srv", true);
    assert.equal((await mcp.enabledConfigs())[0]?.env?.[chave], base.env[chave]);
  }
  casa.limpar();
});

test("o aceite vale só para a impressão que a pessoa viu", async () => {
  const casa = new Casa();
  casa.instalar("1.0.0", { ms365: MS365_ANTIGO });
  const { mcp, importacao } = montar(casa);
  await importacao.importar(["ms365"]);

  casa.instalar("1.1.0", { ms365: MS365_NOVO });
  const visto = (await mcp.vinculos()).ms365!.hash!;
  // A origem muda de novo antes do clique.
  casa.instalar("1.2.0", { ms365: { ...MS365_NOVO, args: [...MS365_NOVO.args, "--read-only"] } });
  await assert.rejects(() => mcp.aceitarOrigem("ms365", visto), /mudou de novo/);
  await assert.rejects(() => mcp.manterAnterior("ms365", visto), /mudou de novo/);
  const agora = (await mcp.vinculos()).ms365!;
  assert.equal(agora.estado, "mudou");
  assert.ok(agora.mudancas.some((m) => /--read-only/.test(m.depois ?? "")));
  assert.ok((await mcp.get("ms365"))?.config.command?.includes("onedrive,excel,mail,calendar,teams,search,users"));
  await mcp.aceitarOrigem("ms365", agora.hash!);
  assert.equal((await mcp.vinculos()).ms365?.estado, "ok");
  casa.limpar();
});

test("aceitar mudança só de args em stdio mantém a credencial; mudar o programa a desfaz", async () => {
  const casa = new Casa();
  casa.instalar("1.0.0", { srv: { command: "npx", args: ["srv@1"] } });
  const { mcp, importacao, secrets } = montar(casa);
  await importacao.importar(["srv"]);
  secrets.set("mcp/srv", "token-colado");
  await mcp.setCredentialRef("srv", "mcp/srv");

  casa.instalar("1.1.0", { srv: { command: "npx", args: ["srv@2"] } });
  await mcp.aceitarOrigem("srv", (await mcp.vinculos()).srv!.hash!);
  assert.equal((await mcp.get("srv"))?.credentialRef, "mcp/srv");

  casa.instalar("1.2.0", { srv: { command: "outro-programa", args: ["srv@2"] } });
  await mcp.aceitarOrigem("srv", (await mcp.vinculos()).srv!.hash!);
  assert.equal((await mcp.get("srv"))?.credentialRef ?? null, null);
  casa.limpar();
});

test("migração: http com Authorization do OAuth na cópia não vira mudança, e diferença protegida aparece", async () => {
  const casa = new Casa();
  casa.usuario({ remoto: { type: "http", url: "https://r.exemplo/mcp" }, outro: { type: "http", url: "https://o.exemplo/mcp", headers: { "x-api-key": "${CHAVE_A}" } } });
  const { mcp, importacao } = montar(casa);
  await mcp.register({ name: "remoto", transport: "http", url: "https://r.exemplo/mcp", headers: { Authorization: "${credential}" }, scope: "write" });
  await mcp.register({ name: "outro", transport: "http", url: "https://o.exemplo/mcp", headers: { "x-api-key": "${credential}" }, scope: "write" });
  await importacao.revincular();
  const v = await mcp.vinculos();
  assert.equal(v.remoto?.estado, "ok");
  // O marcador do OAuth segue valendo na conexão.
  await mcp.setEnabled("remoto", true);
  const remoto = (await mcp.enabledConfigs()).find((c) => c.name === "remoto");
  assert.equal(remoto?.headers?.Authorization, undefined); // sem segredo no cofre, a entrada sai, como sempre
  // "outro": a origem cita ${CHAVE_A} sem valor nesta máquina, mas a cópia já a cobre com o marcador do cofre: resolvida.
  assert.equal(v.outro?.estado, "ok");
  assert.deepEqual(v.outro?.faltando, []);
  casa.limpar();
});

test("diferença só em valor protegido aparece como tal, e o segredo nunca sai", () => {
  const antes = { name: "s", transport: "stdio" as const, command: ["x", "--token", "AAA", "--api-key=BBB"], env: { CLIENT_SECRET: "um" } };
  const depois = { ...antes, command: ["x", "--token", "CCC", "--api-key=DDD"], env: { CLIENT_SECRET: "dois" } };
  const m = diferencas(antes, depois);
  assert.ok(m.length >= 2 && m.every((x) => x.protegido === true), JSON.stringify(m));
  assert.ok(!/AAA|BBB|CCC|DDD|um|dois/.test(JSON.stringify(m).replace(/oculto/g, "")), JSON.stringify(m));
  assert.deepEqual(mascararArgs(["--token", "AAA", "--nome", "x", "--api-key=BBB"]), ["--token", "<oculto>", "--nome", "x", "--api-key=<oculto>"]);
  assert.deepEqual(configMascarada(antes).command, ["x", "--token", "<oculto>", "--api-key=<oculto>"]);
});

test("shell de login que falha é indisponibilidade, não mudança: não se aceita, e a falha vale 30 s sem reabrir o shell", async () => {
  const casa = new Casa();
  casa.usuario({ api: { type: "http", url: "${URL_DA_API}" } });
  let relogio = 1_000_000;
  let chamadas = 0;
  let shellFuncionando = false;
  const secrets = new SecretService(mkdtempSync(join(tmpdir(), "locum-vinculo-cofre-")));
  secrets.useBackend({ available: () => true, encrypt: (p) => Buffer.from(p), decrypt: (b) => b.toString() });
  const db = bancoDeTeste();
  const ambiente = async (): Promise<Record<string, string>> => {
    chamadas++;
    if (!shellFuncionando) throw new Error("zsh estourou o tempo");
    return { URL_DA_API: "https://a.exemplo/mcp" };
  };
  const mcp = new McpService(db, secrets, new OrigemResolver({ home: casa.home, ambiente, ttlMs: 0, agora: () => relogio }));
  const importacao = new ClaudeImportService({ home: casa.home, ambiente: async () => ({ URL_DA_API: "https://a.exemplo/mcp" }), mcp, secrets, settings: new SettingsService(db) });
  await importacao.importar(["api"]);

  const falho = (await mcp.vinculos()).api!;
  assert.equal(falho.estado, "indisponivel");
  assert.deepEqual(falho.mudancas, []);
  await assert.rejects(() => mcp.aceitarOrigem("api", falho.hash!), /nao resolveu/);
  await mcp.setEnabled("api", true);
  await mcp.enabledConfigs();
  // Vários caminhos quentes, um shell só.
  assert.equal(chamadas, 1);

  // Passados 30 s e com o shell de volta, a origem volta ao normal.
  relogio += 31_000;
  shellFuncionando = true;
  assert.equal((await mcp.vinculos()).api?.estado, "ok");
  assert.equal(chamadas, 2);
  casa.limpar();
});

test("variável que não existe é resposta do shell: vale 5 min, e nenhuma leitura abre outro shell", async () => {
  const casa = new Casa();
  casa.usuario({ api: { type: "http", url: "${URL_DA_API}" } });
  let relogio = 1_000_000;
  let chamadas = 0;
  const secrets = new SecretService(mkdtempSync(join(tmpdir(), "locum-vinculo-cofre-")));
  secrets.useBackend({ available: () => true, encrypt: (p) => Buffer.from(p), decrypt: (b) => b.toString() });
  const db = bancoDeTeste();
  const ambiente = async (): Promise<Record<string, string>> => {
    chamadas++;
    return {};
  };
  const mcp = new McpService(db, secrets, new OrigemResolver({ home: casa.home, ambiente, ttlMs: 0, agora: () => relogio }));
  await mcp.register({ name: "api", transport: "http", url: "https://a.exemplo/mcp", scope: "write" }, { source: { kind: "claude-user", server: "api" }, hash: "x" });
  await mcp.setEnabled("api", true);
  for (let i = 0; i < 5; i++) {
    await mcp.vinculos();
    await mcp.enabledConfigs();
  }
  assert.equal(chamadas, 1);
  relogio += 5 * 60_000 + 1;
  await mcp.vinculos();
  assert.equal(chamadas, 2);
  casa.limpar();
});

test("ambiente que respondeu fica guardado entre as leituras: o shell de login não abre a cada vinculos()", async () => {
  const casa = new Casa();
  casa.usuario({ api: { type: "http", url: "${URL_DA_API}" } });
  let chamadas = 0;
  const secrets = new SecretService(mkdtempSync(join(tmpdir(), "locum-vinculo-cofre-")));
  secrets.useBackend({ available: () => true, encrypt: (p) => Buffer.from(p), decrypt: (b) => b.toString() });
  const db = bancoDeTeste();
  const ambiente = async () => {
    chamadas++;
    return { URL_DA_API: "https://a.exemplo/mcp" };
  };
  const mcp = new McpService(db, secrets, new OrigemResolver({ home: casa.home, ambiente, ttlMs: 0 }));
  const importacao = new ClaudeImportService({ home: casa.home, ambiente, mcp, secrets, settings: new SettingsService(db) });
  await importacao.importar(["api"]);
  const depoisDaImportacao = chamadas;
  await mcp.vinculos();
  await mcp.vinculos();
  await mcp.vinculos();
  assert.equal(chamadas, depoisDaImportacao + 1);
  casa.limpar();
});

test("origem que sumiu diz por quê: plugin desligado no Claude Code, ou removido", async () => {
  const casa = new Casa();
  casa.instalar("1.0.0", { ms365: MS365_NOVO });
  const { mcp, importacao } = montar(casa);
  await importacao.importar(["ms365"]);
  casa.desligar();
  assert.equal((await mcp.vinculos()).ms365?.motivo, "plugin-desligado");
  writeFileSync(join(casa.home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {} }));
  writeFileSync(join(casa.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: {} }));
  assert.equal((await mcp.vinculos()).ms365?.motivo, "plugin-removido");
  casa.limpar();
});

test("nome igual com programa genérico: npx de outro pacote é cadastro de mão", () => {
  const github = { transport: "stdio", command: ["npx", "-y", "@modelcontextprotocol/server-github"] };
  assert.equal(pareceOMesmoServidor(github, { command: "npx", args: ["-y", "@acme/outro-github-mcp"] }), false);
  assert.equal(pareceOMesmoServidor(github, { command: "npx", args: ["-y", "@modelcontextprotocol/server-github@1.2.0"] }), true);
  assert.equal(pareceOMesmoServidor({ transport: "stdio", command: ["uvx", "mcp-a"] }, { command: "uvx", args: ["mcp-b"] }), false);
});

test("o ~/.claude.json só é relido quando o arquivo muda", () => {
  const dir = mkdtempSync(join(tmpdir(), "locum-vinculo-mtime-"));
  const arquivo = join(dir, ".claude.json");
  writeFileSync(arquivo, '{"a":1}');
  const primeiro = lerJsonCacheado(arquivo);
  assert.equal(lerJsonCacheado(arquivo), primeiro, "mesmo objeto: veio do cache");
  writeFileSync(arquivo, '{"a":22}');
  assert.deepEqual(lerJsonCacheado(arquivo), { a: 22 });
  rmSync(arquivo);
  assert.equal(lerJsonCacheado(arquivo), undefined);
  rmSync(dir, { recursive: true, force: true });
});

/* --------------------------------------------- terceira rodada: classificação de chaves */

const SEGREDO = [
  "MCP_SERVER_TOKEN", "SERVER_API_KEY", "PGPASSWORD", "APP_ID_TOKEN", "TOKEN_ID", "MINHA_API_KEY", "x-api-key", "clientSecret", "JIRA_TOKEN",
  "Authorization", "DB_PASSWORD", "APIKEY", "GITHUB_PERSONAL_ACCESS_TOKEN", "SLACK_WEBHOOK_SECRET", "COOKIE", "X_AUTH", "AWS_SECRET_ACCESS_KEY", "OPENAI_API_KEY",
];
const CONFIGURACAO = [
  "OAUTH_TOKEN_URL", "AUTH_SERVER_URL", "MS365_OAUTH_SCOPES", "MS365_MCP_ALLOWED_SCOPES", "AZURE_AUTHORITY_HOST", "KEYCLOAK_URL", "TOKEN_FILE", "TENANT_ID", "CLIENT_ID",
  "MS365_MCP_CLIENT_ID", "MS365_MCP_TENANT_ID", "AWS_REGION", "DATA_DIR", "CONFIG_PATH", "SERVER_HOST", "API_URL", "TOKEN_ENDPOINT", "OAUTH_SCOPE", "DB_NAME", "MS365_MCP_REQUIRE_CONFIRM", "KEY_PATH",
];

test("tabela de chaves: segredo só pela palavra de segredo, configuração só pela última palavra", () => {
  for (const nome of SEGREDO) assert.equal(ehChaveDeSegredo(nome), true, `${nome} deveria ser segredo`);
  for (const nome of CONFIGURACAO) assert.equal(ehChaveDeSegredo(nome), false, `${nome} deveria ser configuração`);
});

test("segredo em texto puro nunca fica no cadastro nem sai no diff, mesmo com URL no valor", async () => {
  const casa = new Casa();
  const env = { MCP_SERVER_TOKEN: "tok-abc", PGPASSWORD: "senha-pg", OAUTH_TOKEN_URL: "https://idp.exemplo/token" };
  casa.instalar("1.0.0", { srv: { command: "npx", args: ["srv"], env } });
  const { mcp, importacao, secrets } = montar(casa);
  await importacao.importar(["srv"]);
  const gravado = (await mcp.get("srv"))!;
  // Um segredo por servidor no cofre; o cadastro guarda o marcador e nunca o valor.
  assert.equal(gravado.config.env?.MCP_SERVER_TOKEN, "${credential}");
  assert.equal(secrets.get("mcp/srv"), "tok-abc");
  assert.equal(gravado.config.env?.OAUTH_TOKEN_URL, "https://idp.exemplo/token");

  const mascarada = JSON.stringify(configMascarada({ name: "s", transport: "stdio", command: ["x"], env: { ...env } }));
  assert.ok(!/tok-abc|senha-pg/.test(mascarada), mascarada);
  const d = JSON.stringify(diferencas({ name: "s", transport: "stdio", command: ["x"], env: { PGPASSWORD: "a" } }, { name: "s", transport: "stdio", command: ["x"], env: { PGPASSWORD: "b" } }));
  assert.ok(!/"a"|"b"/.test(d) && /protegido/.test(d), d);
  casa.limpar();
});

test("URL com segredo: webhook numa chave de segredo vai ao cofre, e query ?token= sai mascarada no diff", () => {
  const url = "https://api.exemplo/mcp?token=abc123&modo=ro";
  const m = diferencas(
    { name: "s", transport: "http", url: "https://api.exemplo/mcp?token=abc123&modo=ro" },
    { name: "s", transport: "http", url: "https://api.exemplo/mcp?token=zzz999&modo=ro" },
  );
  const txt = JSON.stringify(m);
  assert.ok(!/abc123|zzz999/.test(txt), txt);
  assert.equal(m[0]?.protegido, true);
  assert.ok(!configMascarada({ name: "s", transport: "http", url }).url?.includes("abc123"));
  assert.ok(!configMascarada({ name: "s", transport: "http", url: "https://user:senha@h.exemplo/mcp" }).url?.includes("senha"));
  // Query sem segredo e URL de configuração passam inteiras.
  assert.equal(configMascarada({ name: "s", transport: "http", url: "https://h.exemplo/mcp?modo=ro" }).url, "https://h.exemplo/mcp?modo=ro");
  assert.equal(configMascarada({ name: "s", transport: "stdio", command: ["x"], env: { AUTH_SERVER_URL: "https://idp.exemplo/a?token=zzz" } }).env?.AUTH_SERVER_URL?.includes("zzz"), false);
});

test("reparo: segredo que ficou em texto puro num vinculado vai para o cofre uma vez só", async () => {
  const casa = new Casa();
  casa.instalar("1.0.0", { srv: { command: "npx", args: ["srv"], env: { MCP_SERVER_TOKEN: "tok-abc" } } });
  const { mcp, importacao, secrets } = montar(casa);
  await importacao.importar(["srv"]);
  // Como a classificação antiga deixava: valor em claro, sem credencial.
  await mcp.setCredentialRef("srv", null);
  secrets.remove("mcp/srv");
  const source = (await mcp.get("srv"))!.source!;
  await mcp.register({ name: "srv", transport: "stdio", command: ["npx", "srv"], env: { MCP_SERVER_TOKEN: "tok-abc" }, scope: "write" }, { source, hash: "antigo" });

  assert.deepEqual(await mcp.protegerSegredos(), ["srv"]);
  const depois = (await mcp.get("srv"))!;
  assert.equal(depois.config.env?.MCP_SERVER_TOKEN, "${credential}");
  assert.equal(depois.credentialRef, "mcp/srv");
  assert.equal(secrets.get("mcp/srv"), "tok-abc");
  // A impressão aceita acompanhou: nada de "a origem mudou" por causa do reparo.
  assert.equal((await mcp.vinculos()).srv?.estado, "ok");
  assert.deepEqual(await mcp.protegerSegredos(), []);
  casa.limpar();
});

test("lançadores: o pacote, o script, o módulo ou a imagem identifica, com a versão do plugin normalizada", () => {
  const raiz = "/h/.claude/plugins/cache/akad/akad/0.17.1";
  const source: McpSource = { kind: "claude-plugin", marketplace: "akad", plugin: "akad", server: "x" };
  const ctx = { source, raiz: "/h/.claude/plugins/cache/akad/akad/0.21.1" };
  // node: o script do plugin, em duas versões.
  assert.equal(pareceOMesmoServidor({ transport: "stdio", command: ["node", `${raiz}/dist/index.js`] }, { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/dist/index.js"] }, ctx), true);
  assert.equal(pareceOMesmoServidor({ transport: "stdio", command: ["node", `${raiz}/dist/outro.js`] }, { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/dist/index.js"] }, ctx), false);
  // python: -m modulo.
  assert.equal(pareceOMesmoServidor({ transport: "stdio", command: ["python3", "-m", "meu_mcp"] }, { command: "python3", args: ["-m", "meu_mcp"] }, ctx), true);
  assert.equal(pareceOMesmoServidor({ transport: "stdio", command: ["python3", "-m", "meu_mcp"] }, { command: "python3", args: ["-m", "outro_mcp"] }, ctx), false);
  // uvx --directory: o diretório e o pacote contam.
  assert.equal(pareceOMesmoServidor({ transport: "stdio", command: ["uvx", "--directory", `${raiz}/srv`, "meu-mcp"] }, { command: "uvx", args: ["--directory", "${CLAUDE_PLUGIN_ROOT}/srv", "meu-mcp"] }, ctx), true);
  assert.equal(pareceOMesmoServidor({ transport: "stdio", command: ["uvx", "--directory", "/a", "meu-mcp"] }, { command: "uvx", args: ["--directory", "/b", "meu-mcp"] }, ctx), false);
  // docker run: pula opções com valor para achar a imagem.
  const docker = { transport: "stdio", command: ["docker", "run", "-i", "--rm", "-e", "TOKEN", "-v", "a:b", "--name", "n", "ghcr.io/acme/github-mcp:1.0"] };
  assert.equal(pareceOMesmoServidor(docker, { command: "docker", args: ["run", "--rm", "-i", "-e", "GITHUB_TOKEN", "--name", "outro", "ghcr.io/acme/github-mcp:2.0"] }, ctx), true);
  assert.equal(pareceOMesmoServidor(docker, { command: "docker", args: ["run", "-i", "-e", "X", "ghcr.io/acme/outra-imagem"] }, ctx), false);
});
