import { afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb } from "../src/db/migrate.js";
import { configurarGh, limparCacheDoGh } from "../src/services/gh-cli.js";
import { GithubService, githubToken } from "../src/services/github-service.js";
import { McpService } from "../src/services/mcp-service.js";
import { SecretService } from "../src/services/secret-service.js";
import { SettingsService } from "../src/services/settings-service.js";
import { bancoDeTeste } from "./helpers/db.js";
import { criarGhFalso } from "./helpers/gh-falso.js";

before(() => migrateDb());

let pathAntes: string | undefined;
let ambienteAntes: string | undefined;
beforeEach(() => {
  pathAntes = process.env["PATH"];
  ambienteAntes = process.env["GITHUB_TOKEN"];
  delete process.env["GITHUB_TOKEN"];
  configurarGh({ diretoriosExtras: [], ttlMs: 60_000 });
  limparCacheDoGh();
});
afterEach(() => {
  process.env["PATH"] = pathAntes;
  if (ambienteAntes === undefined) delete process.env["GITHUB_TOKEN"];
  else process.env["GITHUB_TOKEN"] = ambienteAntes;
  delete process.env["FAKE_GH_DIR"];
  delete process.env["FAKE_GH_MODE"];
  configurarGh({ semGh: false });
});

function cofre(): SecretService {
  const secrets = new SecretService(mkdtempSync(join(tmpdir(), "locum-vinculo-gh-")));
  secrets.useBackend({
    available: () => true,
    encrypt: (plain) => Buffer.from(plain),
    decrypt: (blob) => blob.toString(),
  });
  return secrets;
}

function montar(sonda?: (token: string) => Promise<{ login: string; scopes: string[] }>) {
  const secrets = cofre();
  const settings = new SettingsService(bancoDeTeste());
  const servico = new GithubService(secrets, settings, sonda);
  return { secrets, settings, servico };
}

const OCTO = { origem: "gh", host: "github.com", login: "octo" } as const;

test("a conta do gh vira o token na hora do uso, sem passar pelo cofre", async () => {
  const gh = criarGhFalso();
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;
  const { secrets, servico } = montar();

  await servico.usarGh(OCTO);

  assert.equal(githubToken(secrets), "valor-falso-de-octo");
});

test("a escolha explícita vence o GITHUB_TOKEN do ambiente, nos dois sentidos", async () => {
  const gh = criarGhFalso();
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;
  process.env["GITHUB_TOKEN"] = "valor-do-ambiente";
  const { secrets, servico } = montar();

  assert.equal(githubToken(secrets), "valor-do-ambiente");

  await servico.usarGh(OCTO);
  assert.equal(githubToken(secrets), "valor-falso-de-octo");

  await servico.setToken("valor-colado");
  assert.equal(githubToken(secrets), "valor-colado");
});

test("a conferência roda com o token do gh e guarda login e escopos", async () => {
  const gh = criarGhFalso();
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;
  const recebidos: string[] = [];
  const { servico } = montar(async (token) => {
    recebidos.push(token);
    return { login: "octo", scopes: ["repo", "read:org"] };
  });

  await servico.usarGh(OCTO);
  const r = await servico.check();

  assert.deepEqual(recebidos, ["valor-falso-de-octo"]);
  assert.equal(r.ok, true);
  const s = await servico.status();
  assert.equal(s.identity?.login, "octo");
  assert.deepEqual(s.vinculo, { host: "github.com", login: "octo" });
});

test("gh sumido ou conta deslogada: githubToken lança o erro claro e o estado da conexão é erro", async () => {
  const { secrets, servico } = montar();
  process.env["GITHUB_TOKEN"] = "valor-do-ambiente";
  await servico.usarGh({ ...OCTO, login: "deslogado" });
  process.env["PATH"] = "/usr/bin:/bin";

  assert.throws(() => githubToken(secrets), /a conta deslogado do gh não respondeu; rode gh auth login ou troque a conexão/);

  const r = await servico.check();
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason === "gh" && /rode gh auth login/.test(r.message), true);
});

test("o token do gh não aparece no cofre, nas settings, nem no erro da conferência", async () => {
  const gh = criarGhFalso();
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;
  const { secrets, settings, servico } = montar(async (token) => {
    throw new Error(`falha com ${token}`);
  });

  await servico.usarGh(OCTO);
  const r = await servico.check();

  assert.equal(r.ok === false && r.reason === "refused" && r.message.includes("valor-falso-de-octo"), false);
  const guardado = secrets.get("source/github") ?? "";
  assert.equal(guardado.includes("valor-falso-de-octo"), false);
  assert.equal(((await settings.get("github:source/github:login")) ?? "").includes("valor-falso"), false);
});

test("trocar do gh para o token, ou esquecer, apaga o vínculo e a conferência", async () => {
  const { servico } = montar(async () => ({ login: "octo", scopes: [] }));
  await servico.usarGh(OCTO);
  await servico.check();

  await servico.setToken("valor-colado");
  let s = await servico.status();
  assert.equal(s.vinculo, null);
  assert.equal(s.identity, null);

  await servico.usarGh(OCTO);
  assert.equal(await servico.clearToken(), true);
  s = await servico.status();
  assert.equal(s.vinculo, null);
  assert.equal(s.stored, false);
});

test("recusa host e login que virariam opção da linha de comando", async () => {
  const { servico } = montar();
  await assert.rejects(servico.usarGh({ ...OCTO, login: "--show-token" }));
  await assert.rejects(servico.usarGh({ ...OCTO, host: "" }));
});

test("o servidor MCP do GitHub recebe o token do gh, sem gravá-lo na configuração", async () => {
  const gh = criarGhFalso();
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;
  const secrets = cofre();
  const servico = new GithubService(secrets, new SettingsService(bancoDeTeste()));
  await servico.usarGh(OCTO);
  const mcp = new McpService(undefined, secrets);
  await mcp.register({ name: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "${credential}" } });
  try {
    const config = (await mcp.enabledConfigs()).find((c) => c.name === "github");
    assert.equal(config?.headers?.["Authorization"], "Bearer valor-falso-de-octo");
    const gravado = JSON.stringify(await mcp.get("github"));
    assert.equal(gravado.includes("valor-falso-de-octo"), false);
    assert.equal(await mcp.credencialDoServidor("github"), "ok");

    // gh some: o servidor fica sem credencial, sem derrubar a listagem.
    limparCacheDoGh();
    process.env["PATH"] = "/usr/bin:/bin";
    const sem = (await mcp.enabledConfigs()).find((c) => c.name === "github");
    assert.equal(sem?.headers?.["Authorization"], undefined);
    assert.equal(await mcp.credencialDoServidor("github"), "falta");
  } finally {
    await mcp.remove("github");
  }
});

test("a detecção pelo serviço lista as contas do gh", async () => {
  const gh = criarGhFalso({ json: JSON.stringify({ hosts: { "github.com": [{ host: "github.com", login: "octo", active: true, scopes: "repo" }] } }) });
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;
  const { servico } = montar();
  assert.deepEqual(await servico.contasDoGh(), [{ host: "github.com", login: "octo", active: true, scopes: "repo" }]);
});

test("o status do serviço traz o erro claro quando o gh vinculado não responde", async () => {
  const { servico } = montar();
  await servico.usarGh({ ...OCTO, login: "deslogado" });
  process.env["PATH"] = "/usr/bin:/bin";
  await servico.check();
  const s = await servico.status();
  assert.match(s.erro ?? "", /a conta deslogado do gh não respondeu; rode gh auth login ou troque a conexão/);
});

test("conta de outro host é recusada, porque o token iria para o api.github.com", async () => {
  const { servico } = montar();
  await assert.rejects(servico.usarGh({ ...OCTO, host: "ghe.exemplo.com" }), /outro servidor do GitHub/);
  assert.equal((await servico.status()).vinculo, null);
});

test("status não abre processo: só devolve a falha que o cache já tem", async () => {
  const gh = criarGhFalso();
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;
  const { servico } = montar();
  await servico.usarGh({ ...OCTO, login: "deslogado" });

  assert.equal((await servico.status()).erro, null);
  assert.equal(gh.chamadas().length, 0);

  await servico.check();
  assert.equal(gh.chamadas().length, 1);
  assert.match((await servico.status()).erro ?? "", /rode gh auth login/);
  assert.equal(gh.chamadas().length, 1);
});

test("esquecer e vincular de novo pede o token ao gh outra vez", async () => {
  const gh = criarGhFalso();
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;
  const { secrets, servico } = montar();

  await servico.usarGh(OCTO);
  githubToken(secrets);
  githubToken(secrets);
  assert.equal(gh.chamadas().length, 1);

  await servico.clearToken();
  await servico.usarGh(OCTO);
  githubToken(secrets);
  assert.equal(gh.chamadas().length, 2);
});

test("401 do GitHub faz o token do gh ser pedido de novo", async () => {
  const gh = criarGhFalso();
  process.env["PATH"] = `${gh.dir}:/usr/bin:/bin`;
  const { secrets, servico } = montar(async () => {
    throw Object.assign(new Error("Bad credentials"), { status: 401 });
  });
  await servico.usarGh(OCTO);
  githubToken(secrets);
  assert.equal(gh.chamadas().length, 1);

  // check limpa o cache antes de pedir (2 chamadas) e o 401 limpa depois.
  await servico.check();
  assert.equal(gh.chamadas().length, 2);
  githubToken(secrets);
  assert.equal(gh.chamadas().length, 3);
});
