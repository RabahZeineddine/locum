import { test } from "node:test";
import assert from "node:assert/strict";
import type { TFunction } from "i18next";
import { quandoReseta } from "../renderer/lib/limites.js";

const t = ((chave: string, v: Record<string, unknown>) =>
  chave === "limits.justNow" ? "agora" : chave === "limits.inMinutes" ? `em ${v.count} min · ${v.time}` : `em ${v.hours}h${v.minutes} · ${v.time}`) as unknown as TFunction;

const agora = new Date(2026, 9, 15, 22, 58).getTime();
const s = (d: Date) => d.getTime() / 1000;

test("a janela de 5h diz quanto falta e a hora, mesmo virando o dia", () => {
  assert.equal(quandoReseta(t, s(new Date(2026, 9, 16, 2, 13)), "pt-BR", agora), "em 3h15 · 02:13");
  assert.equal(quandoReseta(t, s(new Date(2026, 9, 15, 23, 40)), "pt-BR", agora), "em 42 min · 23:40");
});

test("mais de um dia: dia da semana, data e hora", () => {
  assert.match(quandoReseta(t, s(new Date(2026, 9, 18, 9, 0)), "pt-BR", agora), /18\/10 09:00$/);
});

test("reset que já passou diz agora, e não em 0 min", () => {
  assert.equal(quandoReseta(t, s(new Date(2026, 9, 15, 22, 50)), "pt-BR", agora), "agora");
});
