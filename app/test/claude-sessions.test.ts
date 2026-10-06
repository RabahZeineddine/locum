import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSessionsService } from "../src/services/claude-sessions-service.js";
import { escreverSessoesDeExemplo, SESSOES_DE_EXEMPLO } from "../src/services/claude-sessions-sample.js";
import { SettingsService } from "../src/services/settings-service.js";
import { bancoDeTeste } from "./helpers/db.js";

const PID_VIVO = 4242;

function montar(extra: Partial<ConstructorParameters<typeof ClaudeSessionsService>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "locum-claude-"));
  escreverSessoesDeExemplo(dir, "/projetos/exemplo", PID_VIVO);
  const chamadas: [string, string[]][] = [];
  const servico = new ClaudeSessionsService({
    claudeDir: dir,
    settings: new SettingsService(bancoDeTeste()),
    sessions: { terminal: async () => "terminal" },
    isAlive: (pid) => pid === PID_VIVO,
    gitChanges: async () => 2,
    exec: async (comando, args) => {
      chamadas.push([comando, args]);
    },
    resolveClaude: async () => "/usr/local/bin/claude",
    opencodeDb: join(dir, "sem-opencode.db"),
    scriptDir: join(dir, "scripts"),
    ...extra,
  });
  return { servico, chamadas };
}

test("classifica cada sessão e deixa de fora a chamada por programa", async () => {
  const { servico } = montar();
  const lista = await servico.list();
  const porId = new Map(lista.map((s) => [s.id, s]));

  assert.equal(porId.has(SESSOES_DE_EXEMPLO.programatica), false);
  assert.equal(porId.get(SESSOES_DE_EXEMPLO.aberta)?.state, "working");
  assert.equal(porId.get(SESSOES_DE_EXEMPLO.interrompida)?.state, "interrupted");

  const metade = porId.get(SESSOES_DE_EXEMPLO.pelaMetade);
  assert.equal(metade?.state, "unfinished");
  assert.equal(metade?.askedQuestion, true);
  // O comando de barra não é pedido: o título sai do primeiro texto digitado.
  assert.equal(metade?.title, "Revisar a tela de login");
  assert.equal(metade?.uncommitted, 2);

  assert.equal(porId.get(SESSOES_DE_EXEMPLO.interrompida)?.title, "Corrigir teste de datas");
  assert.deepEqual(
    lista.map((s) => s.id),
    [SESSOES_DE_EXEMPLO.aberta, SESSOES_DE_EXEMPLO.interrompida, SESSOES_DE_EXEMPLO.pelaMetade],
  );
});

test("marca de terminada vale até a conversa andar de novo", async () => {
  const { servico } = montar();
  const metade = (await servico.list()).find((s) => s.id === SESSOES_DE_EXEMPLO.pelaMetade);
  assert.ok(metade);

  await servico.markDone(metade.id, metade.lastActivityAt);
  assert.equal((await servico.list()).find((s) => s.id === metade.id)?.state, "done");

  // Atividade depois da marca: a sessão volta a aparecer como pela metade.
  await servico.markDone(metade.id, metade.lastActivityAt - 1);
  assert.equal((await servico.list()).find((s) => s.id === metade.id)?.state, "unfinished");

  await servico.markDone(metade.id, metade.lastActivityAt);
  await servico.reopen(metade.id);
  assert.equal((await servico.list()).find((s) => s.id === metade.id)?.state, "unfinished");
});

test("retomar abre o terminal na pasta da sessão e recusa sessão aberta", async () => {
  const { servico, chamadas } = montar();
  const { cwd } = await servico.resume(SESSOES_DE_EXEMPLO.interrompida);
  assert.equal(cwd, "/projetos/exemplo");
  assert.deepEqual(chamadas[0], ["open", ["-Ra", "Terminal"]]);
  assert.equal(chamadas.length, 2);
  const [comando, args] = chamadas[1] as [string, string[]];
  assert.equal(comando, "open");
  assert.deepEqual(args.slice(0, 2), ["-a", "Terminal"]);
  const script = readFileSync(args[2] as string, "utf8");
  assert.match(script, /cd '\/projetos\/exemplo'/);
  assert.match(script, /--resume '11111111-1111-4111-8111-111111111111'/);

  await assert.rejects(servico.resume(SESSOES_DE_EXEMPLO.aberta), /ainda está aberta/);
  await assert.rejects(servico.resume("../../etc"), /inválida/);
});

test("sem pasta do Claude a lista sai vazia, sem erro", async () => {
  const { servico } = montar({ claudeDir: join(tmpdir(), "nao-existe-locum") });
  assert.deepEqual(await servico.list(), []);
});

/** Um `opencode.db` mínimo, só com as colunas que a leitura usa. */
function bancoDoOpencode(dir: string, agora: number): string {
  const caminho = join(dir, "opencode.db");
  const banco = new Database(caminho);
  banco.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT NOT NULL, directory TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL);
  `);
  const sessao = banco.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, NULL)");
  const mensagem = banco.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
  const parte = banco.prepare("INSERT INTO part VALUES (?, ?, ?, ?)");
  const hora = agora - 3 * 3600_000;
  // Parada há três horas, com a última resposta terminada numa pergunta.
  sessao.run("ses_parada", null, "Ajustar o importador", "/projetos/oc", hora - 60_000, hora);
  mensagem.run("msg_1", "ses_parada", hora - 60_000, JSON.stringify({ role: "user", time: { created: hora - 60_000 } }));
  parte.run("prt_1", "msg_1", "ses_parada", JSON.stringify({ type: "text", text: "importa do cursor também" }));
  mensagem.run("msg_2", "ses_parada", hora, JSON.stringify({ role: "assistant", time: { created: hora, completed: hora } }));
  parte.run("prt_2", "msg_2", "ses_parada", JSON.stringify({ type: "text", text: "Feito. Quer que eu teste?" }));
  // Mexida agora há pouco e sem resposta: está trabalhando.
  sessao.run("ses_viva", null, "Rodar os testes", "/projetos/oc", agora - 120_000, agora - 30_000);
  mensagem.run("msg_3", "ses_viva", agora - 30_000, JSON.stringify({ role: "user", time: { created: agora - 30_000 } }));
  parte.run("prt_3", "msg_3", "ses_viva", JSON.stringify({ type: "text", text: "roda tudo" }));
  // Subagent não aparece sozinho.
  sessao.run("ses_filha", "ses_viva", "subagent", "/projetos/oc", agora - 60_000, agora - 60_000);
  mensagem.run("msg_4", "ses_filha", agora - 60_000, JSON.stringify({ role: "user", time: { created: agora - 60_000 } }));
  banco.close();
  return caminho;
}

test("as conversas do opencode entram na mesma lista e retomam pelo opencode", async () => {
  const agora = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "locum-opencode-"));
  const { servico, chamadas } = montar({ opencodeDb: bancoDoOpencode(dir, agora), now: () => agora });
  const lista = await servico.list();
  const porId = new Map(lista.map((s) => [s.id, s]));

  assert.equal(porId.has("ses_filha"), false);
  const parada = porId.get("ses_parada");
  assert.equal(parada?.tool, "opencode");
  assert.equal(parada?.state, "unfinished");
  assert.equal(parada?.askedQuestion, true);
  assert.equal(parada?.lastPrompt, "importa do cursor também");
  assert.equal(parada?.turns, 1);
  assert.equal(porId.get("ses_viva")?.state, "working");
  assert.equal(porId.get(SESSOES_DE_EXEMPLO.aberta)?.tool, "claude-code");

  await servico.resume("ses_parada");
  const [, args] = chamadas.at(-1) as [string, string[]];
  const script = readFileSync(args[2] as string, "utf8");
  assert.match(script, /--session 'ses_parada'/);
  assert.match(script, /cd '\/projetos\/oc'/);
});
