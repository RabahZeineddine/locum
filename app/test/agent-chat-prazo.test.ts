import { before, test } from "node:test";
import assert from "node:assert/strict";
import { jsonSchema, tool, type ToolSet } from "ai";
import { ConversasDeAgent } from "../src/agent-chat/conversas.js";
import { AgentProfile, type ToolRef } from "../src/config/types.js";
import { migrateDb } from "../src/db/migrate.js";
import { modeloFalso } from "../src/fixtures/modelo-falso.js";
import type { ResolvedProfile } from "../src/services/library-service.js";
import { SettingsService } from "../src/services/settings-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/**
 * Cartão à espera de um clique não segura a conversa para sempre, e a trava de
 * um dono vivo não vence por idade enquanto ele trabalha.
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

const relogio = { agora: 1_000_000 };

function processo(id: string, settings: SettingsService, pid: number, vivos: Set<number>, prazos?: { cartaoMs?: number; travaMs?: number }) {
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
    agora: () => relogio.agora,
    ...(prazos === undefined ? {} : { prazos }),
  });
}

const PEDE_ESCRITA = '[[chama painel__echo {"text":"oi"}]]';

test("cartão pendente de quem chamou pela API expira em 10 minutos e solta a conversa", async () => {
  const settings = new SettingsService(bancoDeTeste());
  const vivos = new Set<number>();
  const app = processo("prazo", settings, 101, vivos);
  const mcp = processo("prazo", settings, 202, vivos);
  await app.enviar("prazo", PEDE_ESCRITA);
  const cartao = (await app.estado("prazo")).falas.at(-1)!.cartoes[0]!;
  assert.equal(cartao.estado, "pendente");

  relogio.agora += 9 * 60_000;
  assert.equal((await app.estado("prazo")).falas.at(-1)!.cartoes[0]!.estado, "pendente");

  relogio.agora += 2 * 60_000;
  const depois = await app.estado("prazo");
  assert.equal(depois.falas.at(-1)!.cartoes[0]!.estado, "expirado");
  assert.equal(depois.respondendo, false);
  await mcp.enviar("prazo", "agora pode");
  await assert.rejects(app.decidir("prazo", cartao.id, "executar"), /agentChat.errors.expired/);
});

test("a trava de um dono vivo é renovada a cada operação e não vence por idade", async () => {
  const settings = new SettingsService(bancoDeTeste());
  const vivos = new Set<number>();
  const prazos = { cartaoMs: 60 * 60_000, travaMs: 1_000 };
  const app = processo("renova", settings, 101, vivos, prazos);
  const mcp = processo("renova", settings, 202, vivos, prazos);
  await app.enviar("renova", PEDE_ESCRITA);

  relogio.agora += 800;
  await app.estado("renova");
  relogio.agora += 700;
  assert.equal((await mcp.estado("renova")).respondendo, true);
  // Sem nenhuma operação do dono, a trava velha se perde.
  relogio.agora += 2_000;
  assert.equal((await mcp.estado("renova")).respondendo, false);
});

test("o outro processo aparece no estado, e tomar a conversa expira o cartão dele e libera a vez", async () => {
  const settings = new SettingsService(bancoDeTeste());
  const vivos = new Set<number>();
  const app = processo("toma", settings, 101, vivos);
  const mcp = processo("toma", settings, 202, vivos);
  await app.enviar("toma", PEDE_ESCRITA);
  const cartao = (await app.estado("toma")).falas.at(-1)!.cartoes[0]!;

  assert.equal((await app.estado("toma")).outroProcesso, false);
  const visto = await mcp.estado("toma");
  assert.equal(visto.outroProcesso, true);
  assert.equal(visto.falas.at(-1)!.cartoes[0]!.estado, "pendente");

  await mcp.tomar("toma");
  const depois = await mcp.estado("toma");
  assert.equal(depois.outroProcesso, false);
  assert.equal(depois.falas.at(-1)!.cartoes[0]!.estado, "expirado");
  await assert.rejects(app.decidir("toma", cartao.id, "executar"), /agentChat.errors.expired/);
  await mcp.enviar("toma", "minha vez");
});

test("enviar só avisa que começou depois de tomar a conversa: a recusa do outro processo chega como erro", async () => {
  const settings = new SettingsService(bancoDeTeste());
  const vivos = new Set<number>();
  const app = processo("comeca", settings, 101, vivos);
  const mcp = processo("comeca", settings, 202, vivos);
  await app.enviar("comeca", PEDE_ESCRITA);

  let avisos = 0;
  await assert.rejects(mcp.enviar("comeca", "furando", () => avisos++), /agentChat.errors.otherProcess/);
  assert.equal(avisos, 0);
  await mcp.tomar("comeca");
  await mcp.enviar("comeca", "minha vez", () => avisos++);
  assert.equal(avisos, 1);
});
