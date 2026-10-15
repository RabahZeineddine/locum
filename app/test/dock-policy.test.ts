import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { politicaDoDock } from "../electron/dock-policy.js";

describe("politicaDoDock", () => {
  it("o modo normal, com janela, é um app comum com ícone no Dock", () => {
    assert.equal(politicaDoDock({ modoMcp: false, smoke: false, comandoDeCofre: false }), "regular");
  });

  it("servidor MCP e ferramentas nunca ganham Dock", () => {
    assert.equal(politicaDoDock({ modoMcp: true, smoke: false, comandoDeCofre: false }), "accessory");
  });

  it("a fumaça roda sem Dock", () => {
    assert.equal(politicaDoDock({ modoMcp: false, smoke: true, comandoDeCofre: false }), "accessory");
  });

  it("comando de cofre não tem janela nem Dock", () => {
    assert.equal(politicaDoDock({ modoMcp: false, smoke: false, comandoDeCofre: true }), "accessory");
  });
});
