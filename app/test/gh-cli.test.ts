import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import {
  GhIndisponivelError,
  configurarGh,
  contasDoGh,
  erroLembradoDoGh,
  normalizarConfigDir,
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
  configurarGh({ diretoriosExtras: [], ttlMs: 60_000, ttlFalhaMs: 60_000 });
  limparCacheDoGh();
});
afterEach(() => {
  process.env["PATH"] = pathAntes;
  delete process.env["FAKE_GH_DIR"];
  delete process.env["FAKE_GH_MODE"];
  delete process.env["GH_CONFIG_DIR"];
  delete process.env["FAKE_GH_ANTIGO"];
  delete process.env["FAKE_GH_ATIVO"];
  configurarGh({ semGh: false, ttlFalhaMs: 60_000 });
});

test("detecta as contas pelo json, com ativa e escopos, sem token", async () => {
  const gh = criarGhFalso({ json: JSON_STATUS, modo: "json" });
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;

  const contas = await contasDoGh();
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

test("sem suporte a json, lê o texto de gh auth status", async () => {
  const gh = criarGhFalso({ texto: TEXTO_STATUS, modo: "texto" });
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;

  const contas = await contasDoGh();
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

test("acha o gh num diretório extra quando o PATH do app é curto", async () => {
  const gh = criarGhFalso({ json: JSON_STATUS, modo: "json" });
  process.env["PATH"] = "/usr/bin:/bin";
  configurarGh({ diretoriosExtras: [gh.dir] });
  assert.equal((await contasDoGh()).length, 3);
});

test("sem gh na máquina, devolve lista vazia na detecção e erro claro no uso", async () => {
  process.env["PATH"] = "/usr/bin:/bin";
  assert.deepEqual(await contasDoGh(), []);
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

test("a falha fica lembrada e o gh não roda de novo dentro do prazo", () => {
  const gh = criarGhFalso();
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;
  const ref = { origem: "gh", host: "github.com", login: "deslogado" } as const;

  assert.throws(() => tokenDoGh(ref), GhIndisponivelError);
  assert.throws(() => tokenDoGh(ref), GhIndisponivelError);
  assert.equal(gh.chamadas().length, 1);
  assert.ok(erroLembradoDoGh(ref) instanceof GhIndisponivelError);

  limparCacheDoGh();
  assert.equal(erroLembradoDoGh(ref), undefined);
  assert.throws(() => tokenDoGh(ref), GhIndisponivelError);
  assert.equal(gh.chamadas().length, 2);
});

test("gh antigo sem --user: usa o token da conta ativa só se for a vinculada", () => {
  const gh = criarGhFalso({ json: JSON_STATUS, modo: "json" });
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;
  process.env["FAKE_GH_ANTIGO"] = "1";
  process.env["FAKE_GH_ATIVO"] = "octo";

  assert.equal(tokenDoGh({ origem: "gh", host: "github.com", login: "octo" }), "valor-falso-de-octo");
  assert.throws(
    () => tokenDoGh({ origem: "gh", host: "github.com", login: "outra" }),
    (e: unknown) => e instanceof GhIndisponivelError && /atualize o gh \(2\.40\+\) ou torne outra a conta ativa/.test(e.message),
  );
});

test("configDir relativo é recusado e ~ vira a casa; entrada relativa do PATH é ignorada", async () => {
  assert.throws(() => normalizarConfigDir("relativo/cfg"), /caminho absoluto/);
  assert.equal(normalizarConfigDir("~/cfg"), join(homedir(), "cfg"));

  const gh = criarGhFalso({ json: JSON_STATUS, modo: "json" });
  process.env["PATH"] = `${relative(process.cwd(), gh.dir)}:/usr/bin:/bin`;
  assert.deepEqual(await contasDoGh(), []);
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;
  assert.equal((await contasDoGh()).length, 3);
});
