import assert from "node:assert/strict";
import { test } from "node:test";
import { installedTerminals, openInTerminal, usarTerminalEmbutido } from "../src/services/session-service.js";
import { TerminalService, type AbrirPty, type EventoDoTerminal } from "../src/terminal/terminal-service.js";

function falso() {
  const escritos: string[] = [];
  const tamanhos: [number, number][] = [];
  let mortos = 0;
  let dados: (d: string) => void = () => undefined;
  let fim: (f: { exitCode: number }) => void = () => undefined;
  const chamadas: { comando: string; args: string[]; cwd: string; env: Record<string, string> }[] = [];
  const abrir: AbrirPty = (comando, args, opcoes) => {
    chamadas.push({ comando, args, cwd: opcoes.cwd, env: opcoes.env });
    return {
      onData: (o) => void (dados = o),
      onExit: (o) => void (fim = o),
      write: (d) => void escritos.push(d),
      resize: (c, l) => void tamanhos.push([c, l]),
      kill: () => void mortos++,
    };
  };
  return { abrir, escritos, tamanhos, chamadas, mortos: () => mortos, sair: (d: string) => dados(d), terminar: (c: number) => fim({ exitCode: c }) };
}

test("abre o script pelo shell de login, guarda a saída e avisa o fim", () => {
  const pty = falso();
  const servico = new TerminalService(pty.abrir);
  const eventos: EventoDoTerminal[] = [];
  servico.ouvir((e) => eventos.push(e));

  const t = servico.abrir({ script: "/x/open session.command", cwd: "/repo", titulo: "Hub", iniciativa: "hub" });
  assert.deepEqual(pty.chamadas[0]?.args, ["-lc", "exec '/x/open session.command'"]);
  assert.equal(pty.chamadas[0]?.cwd, "/repo");
  assert.equal(pty.chamadas[0]?.env.TERM, "xterm-256color");
  assert.equal(pty.chamadas[0]?.env.ELECTRON_RUN_AS_NODE, undefined);

  pty.sair("olá ");
  pty.sair("mundo");
  assert.equal(servico.buffer(t.id), "olá mundo");
  servico.escrever(t.id, "ls\r");
  servico.redimensionar(t.id, 100.7, 30);
  assert.deepEqual(pty.escritos, ["ls\r"]);
  assert.deepEqual(pty.tamanhos, [[100, 30]]);

  pty.terminar(0);
  assert.equal(servico.listar("hub")[0]?.vivo, false);
  servico.escrever(t.id, "depois do fim");
  assert.deepEqual(pty.escritos, ["ls\r"]);
  assert.deepEqual(eventos.map((e) => e.tipo), ["dados", "dados", "fim"]);
  assert.ok(!("buffer" in servico.listar()[0]!));
});

test("lista por iniciativa, sem iniciativa e todos; fechar mata o vivo e esquece", () => {
  const pty = falso();
  const servico = new TerminalService(pty.abrir);
  const a = servico.abrir({ script: "/a", cwd: "/", titulo: "a", iniciativa: "hub" });
  servico.abrir({ script: "/b", cwd: "/", titulo: "b" });
  assert.equal(servico.listar().length, 2);
  assert.deepEqual(servico.listar("hub").map((t) => t.titulo), ["a"]);
  assert.deepEqual(servico.listar(null).map((t) => t.titulo), ["b"]);
  servico.fechar(a.id);
  assert.equal(pty.mortos(), 1);
  assert.throws(() => servico.buffer(a.id), /não existe/);
});

test("sem node-pty o terminal embutido não aparece como instalado", async () => {
  const servico = new TerminalService(null);
  assert.equal(servico.disponivel(), false);
  assert.throws(() => servico.abrir({ script: "/a", cwd: "/", titulo: "a" }), /indisponível/);

  const exec = async () => {
    throw new Error("não instalado");
  };
  usarTerminalEmbutido(null);
  assert.deepEqual(await installedTerminals(exec), []);
  await assert.rejects(openInTerminal(exec, "locum", "/s", { cwd: "/", titulo: "x" }), /terminal do Locum/);

  const abertos: { script: string; iniciativa?: string }[] = [];
  usarTerminalEmbutido((e) => void abertos.push(e));
  try {
    assert.deepEqual(await installedTerminals(exec), ["locum"]);
    await openInTerminal(exec, "locum", "/s", { cwd: "/", titulo: "x", iniciativa: "hub" });
    assert.deepEqual(abertos, [{ script: "/s", cwd: "/", titulo: "x", iniciativa: "hub" }]);
  } finally {
    usarTerminalEmbutido(null);
  }
});
