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
  lembrarFalhaDoGh,
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
  delete process.env["FAKE_GH_DESLOGADO"];
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

test("gh sem --json (anterior à 2.40): a detecção mostra o aviso de atualizar em vez de listar contas", async () => {
  const gh = criarGhFalso({ texto: "github.com\n  Logged in to github.com account octo (keyring)\n", modo: "texto" });
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;

  await assert.rejects(
    contasDoGh(),
    (e: unknown) => e instanceof GhIndisponivelError && e.message === "o Locum precisa do gh 2.40 ou mais novo (brew upgrade gh)",
  );
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

test("gh sem --user (anterior à 2.40): um processo só, erro de atualizar, lembrado no cache de falha", () => {
  const gh = criarGhFalso({ json: JSON_STATUS, modo: "json" });
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;
  process.env["FAKE_GH_ANTIGO"] = "1";
  process.env["FAKE_GH_ATIVO"] = "octo";
  const ref = { origem: "gh", host: "github.com", login: "octo" } as const;

  for (let i = 0; i < 3; i++) {
    assert.throws(
      () => tokenDoGh(ref),
      (e: unknown) => e instanceof GhIndisponivelError && e.message === "o Locum precisa do gh 2.40 ou mais novo (brew upgrade gh)",
    );
  }
  assert.equal(gh.execucoes(), 1);
  assert.deepEqual(gh.chamadas(), []);
});

test("configDir inválido vira GhIndisponivelError lembrado, sem abrir o gh", async () => {
  const gh = criarGhFalso();
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;
  const ref = { origem: "gh", host: "github.com", login: "octo", configDir: "relativo/cfg" } as const;

  for (let i = 0; i < 2; i++) {
    assert.throws(() => tokenDoGh(ref), (e: unknown) => e instanceof GhIndisponivelError && /caminho absoluto/.test(e.message));
  }
  assert.equal(gh.execucoes(), 0);
  assert.ok(erroLembradoDoGh(ref) instanceof GhIndisponivelError);
  await assert.rejects(contasDoGh("relativo/cfg"), /caminho absoluto/);
});

test("lembrarFalhaDoGh segura só a conta dela e limparCacheDoGh limpa tudo", () => {
  const gh = criarGhFalso();
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;
  const octo = { origem: "gh", host: "github.com", login: "octo" } as const;
  const outra = { origem: "gh", host: "github.com", login: "outra" } as const;
  tokenDoGh(octo);
  tokenDoGh(outra);
  lembrarFalhaDoGh(octo);
  assert.throws(() => tokenDoGh(octo), GhIndisponivelError);
  assert.equal(tokenDoGh(outra), "valor-falso-de-outra");
  assert.equal(gh.execucoes(), 2);
  limparCacheDoGh();
  assert.equal(tokenDoGh(octo), "valor-falso-de-octo");
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
