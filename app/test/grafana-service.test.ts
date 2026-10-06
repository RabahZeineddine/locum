import { test } from "node:test";
import assert from "node:assert/strict";
import type { McpServerInput } from "../src/config/types.js";
import { GrafanaService, nomeDaInstancia } from "../src/services/grafana-service.js";
import { CREDENTIAL_PLACEHOLDER } from "../src/services/secret-service.js";

function falso() {
  const cadastro = new Map<string, { config: McpServerInput; credentialRef: string | null }>();
  const tokens = new Map<string, string>();
  const mcp = {
    list: async () =>
      [...cadastro.values()].map((c) => ({ config: c.config, enabled: true, credentialRef: c.credentialRef, health: {} })) as never,
    register: async (config: McpServerInput) => {
      cadastro.set(config.name, { config, credentialRef: cadastro.get(config.name)?.credentialRef ?? null });
      return {} as never;
    },
    setCredential: async (name: string, e: { campo: string; valor: string }) => {
      const atual = cadastro.get(name)!;
      tokens.set(name, e.valor);
      cadastro.set(name, { config: { ...atual.config, env: { ...atual.config.env, [e.campo]: CREDENTIAL_PLACEHOLDER } }, credentialRef: `mcp/${name}` });
      return {} as never;
    },
    remove: async (name: string) => cadastro.delete(name),
  };
  return { servico: new GrafanaService(mcp), cadastro, tokens };
}

test("nome curto ganha o prefixo e o resto fica", () => {
  assert.equal(nomeDaInstancia("Dev"), "grafana-dev");
  assert.equal(nomeDaInstancia("grafana-prod"), "grafana-prod");
  assert.equal(nomeDaInstancia("grafana"), "grafana");
  assert.throws(() => nomeDaInstancia("  "), /nome/);
});

test("duas instâncias, cada uma com seu endereço e token, e editar sem token mantém o guardado", async () => {
  const { servico, cadastro, tokens } = falso();
  await servico.save({ nome: "dev", url: "https://grafana-dev.exemplo/", token: "t-dev" });
  await servico.save({ nome: "prod", url: "https://grafana.exemplo", token: "t-prod" });
  assert.deepEqual((await servico.list()).map((i) => [i.name, i.url, i.hasToken]), [
    ["grafana-dev", "https://grafana-dev.exemplo", true],
    ["grafana-prod", "https://grafana.exemplo", true],
  ]);
  assert.equal(tokens.get("grafana-prod"), "t-prod");
  assert.equal(cadastro.get("grafana-dev")?.config.env?.GRAFANA_SERVICE_ACCOUNT_TOKEN, CREDENTIAL_PLACEHOLDER);

  await servico.save({ nome: "dev", url: "https://outro.exemplo", token: "" });
  assert.equal(cadastro.get("grafana-dev")?.config.env?.GRAFANA_URL, "https://outro.exemplo");
  assert.equal(cadastro.get("grafana-dev")?.config.env?.GRAFANA_SERVICE_ACCOUNT_TOKEN, CREDENTIAL_PLACEHOLDER);

  await assert.rejects(servico.save({ nome: "nova", url: "https://x.exemplo", token: "" }), /token/);
  await assert.rejects(servico.save({ nome: "x", url: "grafana.exemplo", token: "t" }), /endereço/);
  await servico.remove("grafana-dev");
  assert.deepEqual((await servico.list()).map((i) => i.name), ["grafana-prod"]);
});
