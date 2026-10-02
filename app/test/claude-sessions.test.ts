import { test } from "node:test";
import assert from "node:assert/strict";
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
