import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  GhIndisponivelError,
  configurarGh,
  contasDoGh,
  limparCacheDoGh,
  tokenDoGh,
} from "../src/services/gh-cli.js";
import { criarGhFalso } from "./helpers/gh-falso.js";

const JSON_STATUS = JSON.stringify({
  hosts: {
    "github.com": [
      { state: "success", active: true, host: "github.com", login: "octo", tokenSource: "keyring", scopes: "repo, read:org", gitProtocol: "https" },
      { state: "success", active: false, host: "github.com", login: "outra", tokenSource: "keyring", scopes: "", gitProtocol: "ssh" },
    ],
    "ghe.exemplo.com": [{ state: "error", active: true, host: "ghe.exemplo.com", login: "corp", error: "token inválido" }],
  },
});

const TEXTO_STATUS = `github.com
  ✓ Logged in to github.com account octo (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: ****************
  - Token scopes: 'gist', 'read:org', 'repo'

  ✓ Logged in to github.com account outra (keyring)
  - Active account: false
  - Git operations protocol: ssh
  - Token: ****************
`;

let pathAntes: string | undefined;
beforeEach(() => {
  pathAntes = process.env["PATH"];
  configurarGh({ diretoriosExtras: [], ttlMs: 60_000 });
  limparCacheDoGh();
});
afterEach(() => {
  process.env["PATH"] = pathAntes;
  delete process.env["FAKE_GH_DIR"];
  delete process.env["FAKE_GH_MODE"];
  delete process.env["GH_CONFIG_DIR"];
});

test("detecta as contas pelo json, com ativa e escopos, sem token", () => {
  const gh = criarGhFalso({ json: JSON_STATUS, modo: "json" });
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;

  const contas = contasDoGh();
  assert.deepEqual(
    contas.map((c) => [c.host, c.login, c.active, c.scopes]),
    [
      ["github.com", "octo", true, "repo, read:org"],
      ["github.com", "outra", false, ""],
      ["ghe.exemplo.com", "corp", true, ""],
    ],
  );
  assert.equal(JSON.stringify(contas).includes("valor-falso"), false);
});

test("sem suporte a json, lê o texto de gh auth status", () => {
  const gh = criarGhFalso({ texto: TEXTO_STATUS, modo: "texto" });
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;

  const contas = contasDoGh();
  assert.deepEqual(
    contas.map((c) => [c.host, c.login, c.active, c.scopes]),
    [
      ["github.com", "octo", true, "gist, read:org, repo"],
      ["github.com", "outra", false, ""],
    ],
  );
  // a linha do token mascarado nunca vira dado
  assert.equal(JSON.stringify(contas).includes("****"), false);
});

test("acha o gh num diretório extra quando o PATH do app é curto", () => {
  const gh = criarGhFalso({ json: JSON_STATUS, modo: "json" });
  process.env["PATH"] = "/usr/bin:/bin";
  configurarGh({ diretoriosExtras: [gh.dir] });
  assert.equal(contasDoGh().length, 3);
});

test("sem gh na máquina, devolve lista vazia na detecção e erro claro no uso", () => {
  process.env["PATH"] = "/usr/bin:/bin";
  assert.deepEqual(contasDoGh(), []);
  assert.throws(
    () => tokenDoGh({ origem: "gh", host: "github.com", login: "octo" }),
    (e: unknown) => e instanceof GhIndisponivelError && /a conta octo do gh não respondeu; rode gh auth login ou troque a conexão/.test(e.message),
  );
});

test("o vínculo resolve o token na hora, com host, usuário e GH_CONFIG_DIR", () => {
  const gh = criarGhFalso();
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;

  const token = tokenDoGh({ origem: "gh", host: "github.com", login: "octo", configDir: "/alt/cfg" });
  assert.equal(token, "valor-falso-de-octo");
  assert.deepEqual(gh.chamadas(), ["github.com octo /alt/cfg"]);
});

test("o cache evita nova chamada ao gh e expira pelo prazo", () => {
  const gh = criarGhFalso();
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;
  const ref = { origem: "gh", host: "github.com", login: "octo" } as const;

  tokenDoGh(ref);
  tokenDoGh(ref);
  assert.equal(gh.chamadas().length, 1);

  tokenDoGh({ ...ref, login: "outra" });
  assert.equal(gh.chamadas().length, 2);

  limparCacheDoGh();
  configurarGh({ ttlMs: 0 });
  tokenDoGh(ref);
  tokenDoGh(ref);
  assert.equal(gh.chamadas().length, 4);
});

test("conta deslogada vira erro claro e o que o gh disse não vaza", () => {
  const gh = criarGhFalso();
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;
  try {
    tokenDoGh({ origem: "gh", host: "github.com", login: "deslogado" });
    assert.fail("devia ter lançado");
  } catch (e) {
    assert.ok(e instanceof GhIndisponivelError);
    assert.match(e.message, /a conta deslogado do gh não respondeu; rode gh auth login ou troque a conexão/);
    assert.doesNotMatch(e.message, /valor-secreto/);
  }
});
