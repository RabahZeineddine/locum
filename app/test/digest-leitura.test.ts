import { test } from "node:test";
import assert from "node:assert/strict";
import { lerDigest, partirResumo } from "../renderer/lib/digest.js";

test("a primeira linha do resumo é o valor, o resto é detalhe", () => {
  assert.deepEqual(partirResumo("16 · planilha 16 · bate\nFonte: /api/toil/PAR, 08:10."), {
    valor: "16 · planilha 16 · bate",
    detalhe: "Fonte: /api/toil/PAR, 08:10.",
  });
  assert.deepEqual(partirResumo("100%"), { valor: "100%", detalhe: "" });
  const antigo = `Sem dado. ${"A resposta do dashboard veio grande demais. ".repeat(5)}`;
  assert.equal(partirResumo(antigo).valor, "Sem dado.");
});

test("lê o digest da saída do passo e da pendência", () => {
  const item = { channel: "Parcerias", subject: "Toil", kind: "info", summary: "16" };
  assert.equal(lerDigest({ headline: "W-40", items: [item] })?.items.length, 1);
  const daFila = lerDigest({
    headline: "W-40",
    channels: [{ channel: "Parcerias", items: [{ subject: "Toil", kind: "needs_reply", summary: "16" }] }],
  });
  assert.equal(daFila?.items[0]?.channel, "Parcerias");
  assert.equal(lerDigest({ headline: "x", items: [] }), null);
  assert.equal(lerDigest({ resumo: "não é digest" }), null);
});
