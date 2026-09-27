import { test } from "node:test";
import assert from "node:assert/strict";
import { iniciarI18n } from "../electron/i18n.js";
import { promptDoSistema } from "../electron/chat.js";

/**
 * O prompt de sistema leva so o slug da iniciativa atual, nunca o texto do
 * arquivo de contexto: `context.md` e conteudo de terceiro, e colar o texto
 * dele no prompt de sistema seria tratar dado como instrucao.
 */
for (const idioma of ["en", "pt-BR"] as const) {
  test(`prompt de sistema leva o slug da iniciativa em ${idioma}, nao o texto do contexto`, () => {
    iniciarI18n({ idioma, estrito: true });

    const semIniciativa = promptDoSistema();
    assert.doesNotMatch(semIniciativa, /example/);

    const conteudoDoContexto = "Objective: ganhar o mundo com automacao";
    const comIniciativa = promptDoSistema({ initiative: "example" });
    assert.match(comIniciativa, /example/);
    assert.doesNotMatch(comIniciativa, new RegExp(conteudoDoContexto));
    assert.ok(comIniciativa.startsWith(semIniciativa));
  });
}
