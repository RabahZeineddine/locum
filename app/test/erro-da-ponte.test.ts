import { test } from "node:test";
import assert from "node:assert/strict";
import { semPrefixoDoIpc } from "../renderer/lib/erro-da-ponte.js";

test("tira o prefixo do Electron e deixa a mensagem do serviço", () => {
  assert.equal(
    semPrefixoDoIpc("Error invoking remote method 'connections.teamsChannels': Error: O Teams não está conectado. Em Conexões, entre."),
    "O Teams não está conectado. Em Conexões, entre.",
  );
  assert.equal(semPrefixoDoIpc("Error invoking remote method 'x.y': TypeError: falhou"), "falhou");
});

test("mensagem sem o prefixo passa intacta", () => {
  assert.equal(semPrefixoDoIpc("pendencia nao encontrada"), "pendencia nao encontrada");
  assert.equal(semPrefixoDoIpc("Error: coisa"), "Error: coisa");
});
