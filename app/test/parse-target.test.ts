import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTarget } from "../src/services/execution-service.js";

const PR = { kind: "github", owner: "acme", repo: "loja", pull: 20 };

test("o alvo aceita a forma curta e o link do pull request", () => {
  assert.deepEqual(parseTarget("acme/loja#20"), PR);
  assert.deepEqual(parseTarget("https://github.com/acme/loja/pull/20"), PR);
  assert.deepEqual(parseTarget("  https://github.com/acme/loja/pull/20/files?w=1 "), PR);
});

test("link que não é de pull request continua recusado", () => {
  assert.throws(() => parseTarget("https://github.com/acme/loja/issues/20"), /alvo invalido/);
  assert.throws(() => parseTarget("https://gitlab.com/acme/loja/pull/20"), /alvo invalido/);
});
