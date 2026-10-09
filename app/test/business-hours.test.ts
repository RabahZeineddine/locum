import { test } from "node:test";
import assert from "node:assert/strict";
import { businessHours } from "../src/native-tools/business-hours.js";

/** O relógio de horas úteis: tudo em instante UTC, janela em fuso nomeado. */

const horas = (since: string, now: string, extra: Record<string, unknown> = {}) => {
  const [r] = businessHours({ items: [{ id: "a", since }], now, ...extra }).results;
  assert.ok(r && "hours" in r, JSON.stringify(r));
  return r.hours;
};

test("Brasília: 23:30Z de sexta já é 20:30 local e não conta; segunda cheia conta", () => {
  // sexta 2026-10-09 23:30Z (20:30 em Brasília) até segunda 12:00Z (09:00 local)
  assert.equal(horas("2026-10-09T23:30:00Z", "2026-10-12T12:00:00Z"), 0);
  // até segunda 15:00Z (12:00 local): 3h
  assert.equal(horas("2026-10-09T23:30:00Z", "2026-10-12T15:00:00Z"), 3);
});

test("instante UTC cai no dia local certo: 02:00Z de sábado ainda é sexta à noite", () => {
  // sexta 17:00 local (20:00Z) até sábado 02:00Z (sexta 23:00 local): só 1h até as 18:00
  assert.equal(horas("2026-10-09T20:00:00Z", "2026-10-10T02:00:00Z"), 1);
});

test("fim de semana inteiro vale zero", () => {
  assert.equal(horas("2026-10-10T12:00:00Z", "2026-10-11T22:00:00Z"), 0);
});

test("início e fim fora da janela são cortados nas bordas", () => {
  // quinta 06:00 local até quinta 21:00 local: 9h
  assert.equal(horas("2026-10-08T09:00:00Z", "2026-10-09T00:00:00Z"), 9);
});

test("vários dias: quinta 15:00 local até segunda 10:30 local", () => {
  // quinta 3h + sexta 9h + segunda 1,5h = 13,5
  assert.equal(horas("2026-10-08T18:00:00Z", "2026-10-12T13:30:00Z"), 13.5);
});

test("feriado tira o dia inteiro, no fuso da janela", () => {
  assert.equal(horas("2026-10-08T15:00:00Z", "2026-10-09T21:00:00Z", { holidays: ["2026-10-09"] }), 6);
});

test("ts do Slack em segundos epoch vale como instante", () => {
  const since = String(Date.parse("2026-10-08T13:00:00Z") / 1000) + ".123456";
  assert.equal(horas(since, "2026-10-08T16:00:01Z"), 3);
});

test("since no futuro ou igual a now dá zero", () => {
  assert.equal(horas("2026-10-08T16:00:00Z", "2026-10-08T15:00:00Z"), 0);
  assert.equal(horas("2026-10-08T16:00:00Z", "2026-10-08T16:00:00Z"), 0);
});

test("faixa: ok abaixo de p1, p1 a partir de p1, p0 a partir de p0, e limites próprios", () => {
  const faixa = (h: number, th?: { p1: number; p0: number }) => {
    // segunda 12:00Z = 09:00 local; h horas depois, no mesmo dia
    const now = new Date(Date.parse("2026-10-12T12:00:00Z") + h * 3_600_000).toISOString();
    return businessHours({ items: [{ id: "a", since: "2026-10-12T12:00:00Z" }], now, thresholds: th }).results[0];
  };
  assert.deepEqual(faixa(3.9), { id: "a", hours: 3.9, band: "ok" });
  assert.deepEqual(faixa(4), { id: "a", hours: 4, band: "p1" });
  assert.deepEqual(faixa(8), { id: "a", hours: 8, band: "p0" });
  assert.deepEqual(faixa(2, { p1: 1, p0: 2 }), { id: "a", hours: 2, band: "p0" });
});

test("horas arredondam para baixo: 3h59 mostra 3,9 e nunca 4 com faixa ok", () => {
  const [r] = businessHours({ items: [{ id: "a", since: "2026-10-12T12:00:00Z" }], now: "2026-10-12T15:59:00Z" }).results;
  assert.deepEqual(r, { id: "a", hours: 3.9, band: "ok" });
});

test("since e id numéricos valem: since vira epoch em segundos e id vira texto", () => {
  const since = Date.parse("2026-10-12T12:00:00Z") / 1000;
  const { results } = businessHours({ items: [{ id: 7, since }], now: "2026-10-12T15:00:00Z" });
  assert.deepEqual(results, [{ id: "7", hours: 3, band: "ok" }]);
});

test("item com id ou since de tipo errado vira erro do item, não do lote", () => {
  const { results } = businessHours({
    items: [{ id: "a", since: null }, { id: { x: 1 }, since: "2026-10-12T12:00:00Z" }, "solto", { id: "b", since: 1e30 }],
    now: "2026-10-12T15:00:00Z",
  });
  assert.equal(results.length, 4);
  assert.ok(results.every((r) => "error" in r));
  assert.equal(results[0]!.id, "a");
  assert.equal(results[3]!.id, "b");
});

test("data inexistente em since é recusada", () => {
  const { results } = businessHours({ items: [{ id: "a", since: "2026-02-30T10:00:00Z" }], now: "2026-10-12T15:00:00Z" });
  assert.ok("error" in results[0]!);
});

test("since a mais de 366 dias de now vira erro do item", () => {
  const { results } = businessHours({
    items: [{ id: "velho", since: "2025-09-01T12:00:00Z" }, { id: "limite", since: "2025-10-12T12:00:00Z" }],
    now: "2026-10-12T15:00:00Z",
  });
  assert.ok("error" in results[0]! && /366/.test((results[0] as { error: string }).error));
  assert.ok("hours" in results[1]!);
});

test("500 itens de um ano de intervalo respondem em menos de 1 s", () => {
  const items = Array.from({ length: 500 }, (_, i) => ({ id: String(i), since: new Date(Date.parse("2025-10-20T12:00:00Z") + i * 3_600_000).toISOString() }));
  const t0 = Date.now();
  const { results } = businessHours({ items, now: "2026-10-12T15:00:00Z" });
  assert.equal(results.length, 500);
  assert.ok(Date.now() - t0 < 1000);
});

test("New York na virada de março e de novembro: a janela de 9h local segue 9h", () => {
  const janela = { start: "09:00", end: "18:00", days: [0, 1, 2, 3, 4, 5, 6], timeZone: "America/New_York" };
  // 2026-03-08, domingo, o relógio avança: 00:00 EST (05:00Z) a 00:00 EDT do dia 9 (04:00Z)
  assert.equal(horas("2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z", { window: janela }), 9);
  // 2026-11-01, o relógio recua: 00:00 EDT (04:00Z) a 00:00 EST do dia 2 (05:00Z)
  assert.equal(horas("2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z", { window: janela }), 9);
  // a borda cai no instante certo: 09:00 EDT é 13:00Z no dia 8 de março
  assert.equal(horas("2026-03-08T13:00:00Z", "2026-03-08T14:00:00Z", { window: janela }), 1);
  assert.equal(horas("2026-03-08T12:00:00Z", "2026-03-08T13:00:00Z", { window: janela }), 0);
});

test("item inválido vira erro do item sem derrubar o lote", () => {
  const { results } = businessHours({
    items: [
      { id: "ruim", since: "ontem" },
      { id: "sem-zona", since: "2026-10-08T10:00:00" },
      { id: "bom", since: "2026-10-08T15:00:00Z" },
    ],
    now: "2026-10-08T18:00:00Z",
  });
  assert.ok("error" in results[0]! && results[0].id === "ruim");
  assert.ok("error" in results[1]!);
  assert.deepEqual(results[2], { id: "bom", hours: 3, band: "ok" });
});

test("now inválido derruba o lote com mensagem clara", () => {
  assert.throws(() => businessHours({ items: [{ id: "a", since: "2026-10-08T15:00:00Z" }], now: "agora" }), /now/);
});

test("configuração inválida vira erro de lote, nunca RangeError cru", () => {
  const base = { items: [{ id: "a", since: "2026-10-08T15:00:00Z" }], now: "2026-10-08T18:00:00Z" };
  const janela = { start: "09:00", end: "18:00", days: [1], timeZone: "America/Sao_Paulo" };
  const recusa = (extra: Record<string, unknown>, esperado: RegExp) =>
    assert.throws(
      () => businessHours({ ...base, ...extra }),
      (e: unknown) => !(e instanceof RangeError) && esperado.test(String((e as Error).message)),
    );
  recusa({ window: { ...janela, timeZone: "Marte/Olimpo" } }, /timeZone/);
  recusa({ window: { ...janela, start: "9:00" } }, /start/);
  recusa({ window: { ...janela, end: "24:00" } }, /end/);
  recusa({ window: { ...janela, start: "18:00", end: "09:00" } }, /start/);
  recusa({ window: { ...janela, start: "09:00", end: "09:00" } }, /start/);
  recusa({ window: { ...janela, days: [] } }, /days/);
  recusa({ window: { ...janela, days: [7] } }, /days/);
  recusa({ thresholds: { p1: 9, p0: 8 } }, /p1/);
  recusa({ thresholds: { p1: -1, p0: 8 } }, /p1/);
  recusa({ holidays: ["09/10/2026"] }, /holidays/);
  recusa({ holidays: ["2026-02-31"] }, /holidays/);
});
