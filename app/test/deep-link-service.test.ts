import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseDeepLink } from "../src/services/deep-link-service.js";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

test("fim de sessao com sessao e token validos", () => {
  const session = randomUUID();
  assert.deepEqual(parseDeepLink(`locum://session/ended?session=${session}&token=${TOKEN}`), {
    kind: "session-ended",
    session,
    token: TOKEN,
  });
});

test("parametro a mais no fim de sessao e ignorado", () => {
  const session = randomUUID();
  assert.deepEqual(parseDeepLink(`locum://session/ended?session=${session}&token=${TOKEN}&extra=1`), {
    kind: "session-ended",
    session,
    token: TOKEN,
  });
});

test("fim de sessao sem sessao ou token valido e recusado", () => {
  const session = randomUUID();
  for (const url of [
    `locum://session/ended?session=${session}`,
    `locum://session/ended?token=${TOKEN}`,
    `locum://session/ended?session=nao-e-uuid&token=${TOKEN}`,
    `locum://session/ended?session=${session}&token=curto`,
    `locum://session/ended?session=${session}&token=${TOKEN}%24(x)`,
    `locum://session/ended?session=${session}&token=${"a".repeat(129)}`,
  ]) {
    assert.equal(parseDeepLink(url).kind, "unknown", url);
  }
});

test("outro esquema com a mesma rota e recusado", () => {
  assert.equal(parseDeepLink(`https://session/ended?session=${randomUUID()}&token=${TOKEN}`).kind, "unknown");
});
