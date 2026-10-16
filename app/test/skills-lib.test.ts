import { test } from "node:test";
import assert from "node:assert/strict";
import { agruparPorFonte } from "../renderer/lib/skills.js";
import type { FonteDaSkill } from "../src/skills/loader.js";

test("as skills se agrupam por origem: minhas, um grupo por plugin com versão, projeto e Locum", () => {
  const f = (fonte: FonteDaSkill, name: string) => ({ fonte, name });
  const grupos = agruparPorFonte([
    f({ tipo: "locum" }, "a"),
    f({ tipo: "plugin", plugin: "zeta", versao: "1.0.0" }, "b"),
    f({ tipo: "minhas" }, "c"),
    f({ tipo: "plugin", plugin: "akad", versao: "0.21.1" }, "d"),
    f({ tipo: "plugin", plugin: "akad", versao: "0.21.1" }, "e"),
    f({ tipo: "projeto" }, "g"),
  ]);
  assert.deepEqual(grupos.map((g) => [g.chave, g.itens.length]), [
    ["minhas", 1],
    ["plugin:akad:0.21.1", 2],
    ["plugin:zeta:1.0.0", 1],
    ["projeto", 1],
    ["locum", 1],
  ]);
});
