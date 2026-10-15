import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ehComandoDeCofre, politicaDoDock } from "../electron/dock-policy.js";

const bin = "/Applications/Locum.app/Contents/MacOS/Locum";

describe("politicaDoDock", () => {
  it("o modo normal, com janela, é um app comum com ícone no Dock", () => {
    assert.equal(politicaDoDock([bin]), "regular");
    assert.equal(politicaDoDock(["electron", "dist/main.cjs"]), "regular");
  });

  it("servidor MCP e ferramentas nunca ganham Dock", () => {
    assert.equal(politicaDoDock([bin, "--mcp"]), "accessory");
    assert.equal(politicaDoDock([bin, "--ferramentas"]), "accessory");
  });

  it("a fumaça roda sem Dock", () => {
    assert.equal(politicaDoDock([bin, "--smoke"]), "accessory");
  });

  it("comando de cofre não tem janela nem Dock, com ou sem valor", () => {
    assert.equal(politicaDoDock([bin, "--set-secret", "github"]), "accessory");
    assert.equal(politicaDoDock([bin, "--set-secret"]), "accessory");
    assert.equal(politicaDoDock([bin, "--remove-secret", "github"]), "accessory");
    assert.equal(ehComandoDeCofre([bin, "--set-secret"]), true);
    assert.equal(ehComandoDeCofre([bin, "--mcp"]), false);
  });
});
