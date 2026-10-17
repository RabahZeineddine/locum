import { test } from "node:test";
import assert from "node:assert/strict";
import { alvoDoValor, marcaDaAlteracao, situacaoDaConversa, valorDoAlvo, valorDoSeletor } from "../renderer/lib/conversa-do-run.js";
import { pedeRecarregar } from "../renderer/lib/erro-do-servico.js";
import { erroComCodigo } from "../src/services/erro-com-codigo.js";
import type { DoRunNaConversa } from "../src/agent-chat/tipos.js";

const t = (chave: string, v?: Record<string, unknown>) => `${chave}|${String(v?.hora ?? "")}`;

test("a marca diz a hora da alteração em 24 horas, e some quando a conversa não mexeu", () => {
  // 2026-10-17 14:05:00 UTC
  const segundos = Date.UTC(2026, 9, 17, 14, 5) / 1000;
  assert.equal(marcaDaAlteracao(t, segundos, "pt-BR", "UTC"), "inbox.alteradaPelaConversa|14:05");
  assert.equal(marcaDaAlteracao(t, segundos, "en", "UTC"), "inbox.alteradaPelaConversa|14:05");
  assert.equal(marcaDaAlteracao(t, Date.UTC(2026, 9, 17, 0, 7) / 1000, "en", "UTC"), "inbox.alteradaPelaConversa|00:07");
  assert.equal(marcaDaAlteracao(t, null, "pt-BR"), null);
  assert.equal(marcaDaAlteracao(t, undefined, "pt-BR"), null);
});

test("só pendencia_mudou oferece recarregar", () => {
  assert.equal(pedeRecarregar(erroComCodigo("pendencia_mudou", "", "mudou").message), true);
  assert.equal(pedeRecarregar(`Error: ${erroComCodigo("pendencia_mudou", "", "mudou").message}`), true);
  assert.equal(pedeRecarregar(erroComCodigo("pendencia_resolvida", "x", "feita").message), false);
  assert.equal(pedeRecarregar("o disco encheu"), false);
});

const run = (parcial: Partial<DoRunNaConversa> = {}): DoRunNaConversa => ({
  alvo: { tipo: "agent", id: "revisor" },
  motivoSemAlvo: null,
  padrao: true,
  arquivada: false,
  contexto: { teto: 32_000, cortado: [] },
  gasto: { usd: 0, tokens: 0 },
  limites: { passosDaVolta: 12, passosDoAgent: false, tetoDaLeitura: 20_000 },
  ...parcial,
});

test("o seletor de alvo ida e volta: vazio é o padrão, o resto leva o tipo", () => {
  assert.equal(valorDoSeletor(run()), "");
  assert.equal(valorDoSeletor(run({ padrao: false })), "agent:revisor");
  assert.equal(valorDoSeletor(run({ padrao: false, alvo: { tipo: "modelo", id: "anthropic/claude-sonnet" } })), "modelo:anthropic/claude-sonnet");
  assert.equal(valorDoSeletor(run({ alvo: null })), "");
  assert.deepEqual(alvoDoValor("agent:revisor"), { agent: "revisor" });
  assert.deepEqual(alvoDoValor(valorDoAlvo({ modelo: "provedor/modelo:v1" })), { modelo: "provedor/modelo:v1" });
  assert.equal(alvoDoValor(""), null);
  assert.equal(alvoDoValor("outro:x"), null);
  assert.equal(alvoDoValor("agent:"), null);
});

test("a situação sai do retrato: sem alvo, só leitura, ou conversando", () => {
  const base = { respondendo: false, outroProcesso: false };
  assert.deepEqual(situacaoDaConversa({ ...base, run: run() }), { situacao: "conversando", podeEnviar: true, podeTrocarAlvo: true, podeAssumir: false, cortouContexto: false });
  assert.equal(situacaoDaConversa({ ...base, run: run({ alvo: null, motivoSemAlvo: "x" }) })?.podeEnviar, false);
  assert.equal(situacaoDaConversa({ ...base, run: run({ alvo: null }) })?.situacao, "sem-alvo");
  const leitura = situacaoDaConversa({ ...base, run: run({ arquivada: true }) });
  assert.equal(leitura?.situacao, "somente-leitura");
  assert.equal(leitura?.podeEnviar, true);
  assert.equal(situacaoDaConversa({ ...base, run: run({ contexto: { teto: 10, cortado: ["passo:a"] } }) })?.cortouContexto, true);
  const presa = situacaoDaConversa({ respondendo: true, outroProcesso: true, run: run() });
  assert.equal(presa?.podeAssumir, true);
  assert.equal(presa?.podeTrocarAlvo, false);
  assert.equal(situacaoDaConversa({ ...base }), null);
});
