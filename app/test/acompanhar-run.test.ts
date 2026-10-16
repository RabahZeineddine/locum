import { test } from "node:test";
import assert from "node:assert/strict";
import { seguirRun, type Agenda } from "../renderer/lib/acompanhar-run.js";
import { recusaSemEvento } from "../src/executor/dependencia-de-evento.js";
import { rotuloDoErroDeRun, rotuloDoMotivoDoEnsaio } from "../renderer/lib/rotulos.js";

/** Relógio de mentira: os timers ficam numa lista e o teste decide quando eles disparam. */
function relogio() {
  let agora = 0;
  let proximo = 1;
  const timers = new Map<number, { em: number; fn: () => void }>();
  const agenda: Agenda = {
    setTimeout: (fn, ms) => {
      const id = proximo++;
      timers.set(id, { em: agora + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number),
    now: () => agora,
  };
  const avancar = async (ms: number): Promise<void> => {
    agora += ms;
    for (const [id, t] of [...timers]) {
      if (t.em <= agora) {
        timers.delete(id);
        t.fn();
        await new Promise((r) => setImmediate(r));
      }
    }
  };
  return { agenda, avancar, pendentes: () => timers.size };
}

test("o acompanhamento relê até o run terminar e entrega o desfecho uma vez", async () => {
  const { agenda, avancar, pendentes } = relogio();
  const estados = ["running", "running", "done"];
  let leituras = 0;
  const desfechos: string[] = [];
  seguirRun({
    ler: async () => ({ status: estados[Math.min(leituras++, 2)]! }),
    aoTerminar: (_run, d) => desfechos.push(d),
    aoDesistir: () => desfechos.push("desistiu"),
    agenda,
  });
  await new Promise((r) => setImmediate(r));
  await avancar(1500);
  await avancar(1500);
  assert.deepEqual(desfechos, ["ok"]);
  assert.equal(pendentes(), 0);
});

test("parar interrompe a releitura, limpa o timer e ignora a leitura que estava em voo", async () => {
  const { agenda, avancar, pendentes } = relogio();
  let leituras = 0;
  let solta: (v: { status: string } | undefined) => void = () => undefined;
  const desfechos: string[] = [];
  const acompanhamento = seguirRun({
    ler: () => {
      leituras++;
      return leituras === 1 ? Promise.resolve({ status: "running" }) : new Promise<{ status: string } | undefined>((r) => (solta = r));
    },
    aoTerminar: (_run, d) => desfechos.push(d),
    aoDesistir: () => desfechos.push("desistiu"),
    agenda,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(pendentes(), 1);
  await avancar(1500);
  assert.equal(leituras, 2);

  acompanhamento.parar();
  solta({ status: "failed" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(desfechos, []);
  assert.equal(pendentes(), 0);
  await avancar(60_000);
  assert.equal(leituras, 2);
});

test("parar com a leitura agendada não deixa timer para trás", async () => {
  const { agenda, pendentes } = relogio();
  const a = seguirRun({ ler: async () => ({ status: "running" }), aoTerminar: () => undefined, aoDesistir: () => undefined, agenda });
  await new Promise((r) => setImmediate(r));
  assert.equal(pendentes(), 1);
  a.parar();
  assert.equal(pendentes(), 0);
});

test("desiste depois do prazo", async () => {
  const { agenda, avancar } = relogio();
  const desfechos: string[] = [];
  seguirRun({ ler: async () => ({ status: "running" }), aoTerminar: () => undefined, aoDesistir: () => desfechos.push("desistiu"), agenda, desisteMs: 3000 });
  await new Promise((r) => setImmediate(r));
  await avancar(1500);
  await avancar(1500);
  await avancar(1500);
  assert.deepEqual(desfechos, ["desistiu"]);
});

test("a recusa sem evento é traduzida pelo código, e outro erro passa como veio", () => {
  const t = ((chave: string, opcoes?: Record<string, unknown>) => `${chave}|${JSON.stringify(opcoes ?? {})}`) as never;
  const marcador = rotuloDoErroDeRun(t, recusaSemEvento({ codigo: "marcador", marcador: "{{event.repo}}" }));
  assert.equal(marcador, 'automations.runWith.refused|{"reason":"automations.runWith.reason.marker|{\\"marcador\\":\\"{{event.repo}}\\"}"}');
  const acao = rotuloDoErroDeRun(t, recusaSemEvento({ codigo: "acao", acao: "teams.post" }));
  assert.match(acao, /automations\.runWith\.reason\.action/);
  assert.equal(rotuloDoErroDeRun(t, "a ação deu 500"), "a ação deu 500");
});

test("o motivo do ensaio em código é traduzido e o texto livre de run antigo passa como veio", () => {
  const t = ((chave: string) => chave) as never;
  assert.equal(rotuloDoMotivoDoEnsaio(t, "sem-conversa"), "runs.dryRun.reason.sem-conversa");
  assert.equal(rotuloDoMotivoDoEnsaio(t, "evento-colado"), "runs.dryRun.reason.evento-colado");
  assert.equal(rotuloDoMotivoDoEnsaio(t, "ensaio, sem conversa para responder"), "ensaio, sem conversa para responder");
});
