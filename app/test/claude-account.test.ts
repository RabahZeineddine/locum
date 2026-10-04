import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogoDoInit,
  ClaudeAccountService,
  ehLeitura,
  recusarEscritaDaConta,
  separarDaConta,
  SERVIDOR_CONTA,
} from "../src/runtimes/claude-account.js";
import { claudeArgs } from "../src/runtimes/claude-code.js";

const M365 = "mcp__claude_ai_Microsoft_365__";

test("leitura pelo nome: só verbo de leitura sem verbo de escrita", () => {
  for (const nome of ["get_me", "teams_list_chats", "outlook_email_search", "incident_list", "list_recent_issues", "getJiraIssue"]) {
    assert.equal(ehLeitura(`${M365}${nome}`), true, nome);
  }
  for (const nome of ["outlook_send_mail", "teams_send_chat_message", "alarms_ack", "outlook_modify_labels", "executeRead", "insuremo_call", "frobnicate"]) {
    assert.equal(ehLeitura(`${M365}${nome}`), false, nome);
  }
});

test("catálogo do init fica só com leitura e tira o próprio Locum", () => {
  const { servidores, ferramentas } = catalogoDoInit({
    type: "system",
    subtype: "init",
    tools: ["Bash", `${M365}get_me`, `${M365}outlook_send_mail`, "mcp__locum__list_agents", "mcp__plugin_akad_waroom__incident_list"],
    mcp_servers: [
      { name: "claude.ai Microsoft 365", status: "connected" },
      { name: "plugin:akad:waroom", status: "connected" },
      { name: "locum", status: "connected" },
    ],
  });
  assert.deepEqual(servidores.map((s) => s.name), ["claude.ai Microsoft 365", "plugin:akad:waroom"]);
  assert.deepEqual(ferramentas.map((f) => f.name), [`${M365}get_me`, "mcp__plugin_akad_waroom__incident_list"]);
  assert.equal(ferramentas[0]?.description, "claude.ai Microsoft 365: get_me");
});

test("passo com ferramenta da conta carrega a configuração da pessoa sem hook, CLAUDE.md nem modo automático", () => {
  const args = claudeArgs({ provider: "claude-code", model: "sonnet", prompt: "oi", tools: {}, maxSteps: 3, accountTools: [`${M365}get_me`] });
  assert.ok(!args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--setting-sources") + 1], "user");
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]!) as { disableAllHooks: boolean; claudeMdExcludes: string[] };
  assert.equal(settings.disableAllHooks, true);
  assert.ok(settings.claudeMdExcludes.includes("**/CLAUDE.md"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(args[args.indexOf("--tools") + 1], "ToolSearch");
  assert.equal(args[args.indexOf("--allowedTools") + 1], `${M365}get_me`);

  const isolado = claudeArgs({ provider: "claude-code", model: "sonnet", prompt: "oi", tools: {}, maxSteps: 3 });
  assert.ok(isolado.includes("--strict-mcp-config"));
  assert.equal(isolado[isolado.indexOf("--setting-sources") + 1], "");
});

test("ferramenta de escrita da conta é recusada ao rodar e ao gravar", () => {
  assert.throws(
    () => claudeArgs({ provider: "claude-code", model: "sonnet", prompt: "oi", tools: {}, maxSteps: 3, accountTools: [`${M365}outlook_send_mail`] }),
    /escrita/,
  );
  assert.throws(() => recusarEscritaDaConta([{ server: SERVIDOR_CONTA, tool: `${M365}outlook_send_mail` }]), /só lê/);
  recusarEscritaDaConta([{ server: SERVIDOR_CONTA, tool: `${M365}get_me` }, { server: "github", tool: "merge_pull_request" }]);
});

test("ferramenta da conta só roda no runtime do Claude Code", () => {
  const refs = [{ server: SERVIDOR_CONTA, tool: `${M365}get_me` }, { server: "github", tool: "list_prs" }];
  assert.throws(() => separarDaConta(refs, "native"), /Claude Code/);
  const { doLocum, daConta } = separarDaConta(refs, "claude-code");
  assert.deepEqual(doLocum.map((r) => r.server), ["github"]);
  assert.deepEqual(daConta, [`${M365}get_me`]);
  assert.deepEqual(separarDaConta([refs[1]!], "native").daConta, []);
});

test("listar lê o init, encerra o processo e guarda em cache", async () => {
  let aberturas = 0;
  let encerrado = 0;
  const servico = new ClaudeAccountService(
    async () => "/bin/claude",
    (_comando, args) => {
      aberturas++;
      assert.ok(args.includes("--permission-mode"));
      return {
        linhas: (async function* () {
          yield "lixo";
          yield JSON.stringify({ type: "system", subtype: "init", tools: [`${M365}get_me`], mcp_servers: [{ name: "claude.ai Microsoft 365", status: "connected" }] });
          throw new Error("não deveria ler depois do init");
        })(),
        encerrar: () => encerrado++,
      };
    },
  );
  assert.deepEqual((await servico.tools()).map((f) => f.name), [`${M365}get_me`]);
  await servico.tools();
  assert.equal(aberturas, 1);
  assert.equal(encerrado, 1);

  const semClaude = new ClaudeAccountService(async () => undefined);
  assert.deepEqual(await semClaude.listar(), { servidores: [], ferramentas: [] });
});
