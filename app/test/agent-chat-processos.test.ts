import { before, test } from "node:test";
import assert from "node:assert/strict";
import { jsonSchema, tool, type ToolSet } from "ai";
import { ConversasDeAgent } from "../src/agent-chat/conversas.js";
import { chaveDoAgent } from "../src/agent-chat/tipos.js";
import { AgentProfile, type ToolRef } from "../src/config/types.js";
import { migrateDb } from "../src/db/migrate.js";
import { modeloFalso } from "../src/fixtures/modelo-falso.js";
import type { ResolvedProfile } from "../src/services/library-service.js";
import { SettingsService } from "../src/services/settings-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/**
 * O app aberto e o `--mcp` são dois processos sobre o mesmo banco, cada um com
 * a sua `ConversasDeAgent`: não podem se sobrescrever, e a fala que um deixou
 * tem de aparecer no outro.
 */

before(() => migrateDb());

const ESCRITA: ToolRef = { server: "painel", tool: "echo", class: "external_write" };

function perfilDe(id: string): ResolvedProfile {
  const spec = AgentProfile.parse({ id, name: `Agent ${id}`, model: "falso/roteiro" });
  return { version: { id: "v", profileId: id, version: 1, spec, note: null, createdAt: 0 }, tools: [], confirmar: [ESCRITA], semServidor: [], fixas: [], grupos: [], system: "teste" };
}

const registro = {
  toolsFor: async () => ({ tools: {} as ToolSet, release: () => undefined }),
  toolsComAprovacao: async (refs: ToolRef[]) => ({
    tools: Object.fromEntries(
      refs.map((r) => [`${r.server}__${r.tool}`, { ...tool({ description: r.tool, inputSchema: jsonSchema({ type: "object", additionalProperties: true }), execute: async () => "feito" }), needsApproval: true }]),
    ) as ToolSet,
    release: () => undefined,
  }),
};

/** Um processo: a sua instância sobre o banco compartilhado, com um pid dele. */
function processo(id: string, settings: SettingsService, pid: number, vivos: Set<number>) {
  vivos.add(pid);
  return new ConversasDeAgent({
    library: { resolveProfile: async () => perfilDe(id) },
    mcp: async () => registro,
    modelo: async () => ({ via: "api", provedor: "falso", modelo: "roteiro", model: modeloFalso() }),
    settings,
    orcamento: { checar: async () => undefined, gastar: async () => undefined },
    preco: async () => undefined,
    emitir: () => undefined,
    texto: (chave) => chave,
    processo: { pid, vivo: (p) => vivos.has(p) },
  });
}

test("a fala que um processo deixou aparece no outro, e os dois seguem a mesma conversa sem se sobrescrever", async () => {
  const settings = new SettingsService(bancoDeTeste());
  const vivos = new Set<number>();
  const app = processo("dois-processos", settings, 101, vivos);
  const mcp = processo("dois-processos", settings, 202, vivos);

  await app.enviar("dois-processos", "primeira, pelo app");
  assert.deepEqual((await mcp.estado("dois-processos")).falas.map((f) => f.texto).slice(0, 1), ["primeira, pelo app"]);

  await mcp.enviar("dois-processos", "segunda, pelo mcp");
  await app.enviar("dois-processos", "terceira, pelo app");
  const pedidos = (await mcp.estado("dois-processos")).falas.filter((f) => f.de === "user").map((f) => f.texto);
  assert.deepEqual(pedidos, ["primeira, pelo app", "segunda, pelo mcp", "terceira, pelo app"]);
});

test("com o outro processo no meio de uma fala, enviar, decidir e limpar recusam com o motivo", async () => {
  const settings = new SettingsService(bancoDeTeste());
  const vivos = new Set<number>();
  const app = processo("trava", settings, 101, vivos);
  const mcp = processo("trava", settings, 202, vivos);

  // O app deixa a volta parada num cartão: a conversa continua dele, e o mcp enxerga isso.
  await app.enviar("trava", '[[chama painel__echo {"text":"oi"}]]');
  const cartao = (await app.estado("trava")).falas.at(-1)!.cartoes[0]!;
  assert.equal(cartao.estado, "pendente");

  assert.equal((await mcp.estado("trava")).respondendo, true);
  assert.equal((await mcp.estado("trava")).falas.at(-1)!.cartoes[0]!.estado, "pendente");
  await assert.rejects(mcp.enviar("trava", "furando a vez"), /agentChat.errors.otherProcess/);
  await assert.rejects(mcp.decidir("trava", cartao.id, "executar"), /agentChat.errors.otherProcess/);
  await assert.rejects(mcp.limpar("trava"), /agentChat.errors.otherProcess/);

  await app.decidir("trava", cartao.id, "recusar");
  assert.equal((await mcp.estado("trava")).respondendo, false);
  await mcp.enviar("trava", "agora pode");
});

test("o processo que morreu com cartão à espera deixa expirado, e o que estava executando vira sem saber se saiu", async () => {
  const settings = new SettingsService(bancoDeTeste());
  const vivos = new Set<number>();
  const app = processo("morreu", settings, 101, vivos);
  const mcp = processo("morreu", settings, 202, vivos);
  const cartao = (estado: string, id: string) => ({ id, servidor: "painel", ferramenta: "echo", argumentos: {}, estado });
  await settings.set(
    `chat.falas.${chaveDoAgent("morreu")}`,
    JSON.stringify([{ de: "user", texto: "x", ferramentas: [], cartoes: [] }, { de: "assistant", texto: "", ferramentas: [], cartoes: [cartao("pendente", "a"), cartao("executando", "b")] }]),
  );
  await settings.set(`chat.trava.${chaveDoAgent("morreu")}`, JSON.stringify({ pid: 101, em: Date.now() }));

  // Com o dono vivo, o mcp mostra como está.
  assert.deepEqual((await mcp.estado("morreu")).falas.at(-1)!.cartoes.map((c) => c.estado), ["pendente", "executando"]);
  // O dono morreu: nenhum clique chega mais.
  vivos.delete(101);
  assert.deepEqual((await mcp.estado("morreu")).falas.at(-1)!.cartoes.map((c) => c.estado), ["expirado", "incerto"]);
  await app.estado("morreu");
});
