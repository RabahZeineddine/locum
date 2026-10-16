import { before, test } from "node:test";
import assert from "node:assert/strict";
import { jsonSchema, tool, type ToolSet } from "ai";
import { ConversasDeAgent, legivel, type DepsDoChat } from "../src/agent-chat/conversas.js";
import { chaveDoAgent, type EventoDaConversa } from "../src/agent-chat/tipos.js";
import { AgentProfile, type ToolRef } from "../src/config/types.js";
import { migrateDb } from "../src/db/migrate.js";
import { BudgetExceeded } from "../src/executor/budget.js";
import { modeloFalso, type ModeloFalso, type Roteiro } from "../src/fixtures/modelo-falso.js";
import type { ResolvedProfile } from "../src/services/library-service.js";
import { SettingsService } from "../src/services/settings-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/**
 * O chat do agent: conversa com o que `resolveProfile` entrega, leitura roda
 * direto e escrita para num cartão até a pessoa decidir.
 */

before(() => migrateDb());

const LEITURA: ToolRef = { server: "painel", tool: "pid", class: "read" };
const ESCRITA: ToolRef = { server: "painel", tool: "echo", class: "external_write" };

function perfilDe(id: string, extra: Partial<ResolvedProfile> = {}, budget: Record<string, number> = {}): ResolvedProfile {
  const spec = AgentProfile.parse({ id, name: `Agent ${id}`, model: "falso/roteiro", budget });
  return {
    version: { id: "v", profileId: id, version: 3, spec, note: null, createdAt: 0 },
    tools: [LEITURA],
    confirmar: [ESCRITA],
    semServidor: [],
    fixas: [],
    grupos: [],
    system: "Você é o agent de teste.",
    ...extra,
  };
}

/** O registro de mentira entrega as mesmas ferramentas que o de verdade: a de escrita já marcada para aprovação. */
function registroDeMentira(chamadas: { tool: string; entrada: unknown }[], demoraDaLeituraMs = 0) {
  const feita = (nome: string, aprovacao: boolean) => {
    const f = tool({
      description: nome,
      inputSchema: jsonSchema({ type: "object", additionalProperties: true }),
      execute: async (entrada: unknown) => {
        if (!aprovacao) await new Promise((r) => setTimeout(r, demoraDaLeituraMs));
        chamadas.push({ tool: nome, entrada });
        return `${nome} feito`;
      },
    });
    return aprovacao ? { ...f, needsApproval: true } : f;
  };
  const doAgent = (refs: ToolRef[], aprovacao: boolean): { tools: ToolSet; release: () => void } => ({
    tools: Object.fromEntries(refs.map((r) => [`${r.server}__${r.tool}`, feita(r.tool, aprovacao)])),
    release: () => undefined,
  });
  return {
    toolsFor: async (refs: ToolRef[]) => doAgent(refs, false),
    toolsComAprovacao: async (refs: ToolRef[]) => doAgent(refs, true),
  };
}

interface Cenario {
  conversas: ConversasDeAgent;
  eventos: EventoDaConversa[];
  chamadas: { tool: string; entrada: unknown }[];
  modelo: ModeloFalso;
  gastos: { chave: string; usd: number; tokens: number }[];
  settings: SettingsService;
}

function montar(id: string, opcoes: { demoraDaLeituraMs?: number; perfil?: ResolvedProfile; roteiro?: Roteiro; deps?: Partial<DepsDoChat>; settings?: SettingsService; modelo?: ModeloFalso } = {}): Cenario {
  const eventos: EventoDaConversa[] = [];
  const chamadas: { tool: string; entrada: unknown }[] = [];
  const gastos: { chave: string; usd: number; tokens: number }[] = [];
  const modelo = opcoes.modelo ?? modeloFalso(opcoes.roteiro);
  const settings = opcoes.settings ?? new SettingsService(bancoDeTeste());
  const perfil = opcoes.perfil ?? perfilDe(id);
  const conversas = new ConversasDeAgent({
    library: { resolveProfile: async () => perfil },
    mcp: async () => registroDeMentira(chamadas, opcoes.demoraDaLeituraMs),
    modelo: async () => ({ via: "api", provedor: "falso", modelo: "roteiro", model: modelo }),
    settings,
    orcamento: {
      checar: async () => undefined,
      gastar: async (chave, gasto) => void gastos.push({ chave, ...gasto }),
    },
    preco: async () => undefined,
    emitir: (e) => eventos.push(e),
    texto: (chave) => chave,
    ...opcoes.deps,
  });
  return { conversas, eventos, chamadas, modelo, gastos, settings };
}

const cartoes = (eventos: EventoDaConversa[]) => eventos.flatMap((e) => (e.tipo === "cartao" ? [e.cartao] : []));
const textoDoAssistente = async (c: Cenario, id: string) => (await c.conversas.estado(id)).falas.at(-1)?.texto ?? "";

test("conversa com o system, o modelo e as ferramentas do agent, e a leitura roda direto", async () => {
  const c = montar("leitor");
  await c.conversas.enviar("leitor", 'olha [[chama painel__pid]]');
  assert.deepEqual(c.chamadas, [{ tool: "pid", entrada: {} }]);
  assert.equal(cartoes(c.eventos).length, 0);
  // O texto de antes e o de depois da ferramenta não colam um no outro.
  assert.match(await textoDoAssistente(c, "leitor"), /Vou chamar\.\n\nVoltou: pid feito/);
  assert.ok(c.eventos.every((e) => e.chave === "agent:leitor"));
  assert.equal(c.eventos.at(-1)?.tipo, "fim");
  assert.ok(JSON.stringify(c.modelo.recebidos[0]).includes("Você é o agent de teste."));
});

test("a escrita para num cartão com servidor, ferramenta e argumentos, e nada roda antes do clique", async () => {
  const c = montar("escritor");
  await c.conversas.enviar("escritor", '[[chama painel__echo {"text":"oi"}]]');
  const [cartao] = cartoes(c.eventos);
  assert.equal(cartao?.servidor, "painel");
  assert.equal(cartao?.ferramenta, "echo");
  assert.deepEqual(cartao?.argumentos, { text: "oi" });
  assert.equal(cartao?.estado, "pendente");
  assert.deepEqual(c.chamadas, []);

  const estado = await c.conversas.estado("escritor");
  assert.equal(estado.respondendo, false);
  assert.equal(estado.falas.at(-1)?.cartoes[0]?.estado, "pendente");
});

test("Executar roda só aquela chamada e devolve o resultado ao modelo, que continua", async () => {
  const c = montar("executa");
  await c.conversas.enviar("executa", '[[chama painel__echo {"text":"oi"}]]');
  const [cartao] = cartoes(c.eventos);
  await c.conversas.decidir("executa", cartao!.id, "executar");

  assert.deepEqual(c.chamadas, [{ tool: "echo", entrada: { text: "oi" } }]);
  const fala = (await c.conversas.estado("executa")).falas.at(-1);
  assert.equal(fala?.cartoes[0]?.estado, "executado");
  assert.match(fala?.texto ?? "", /Vou chamar\.\n\nVoltou: echo feito/, "o texto da continuação não cola no anterior");
  assert.equal(c.eventos.at(-1)?.tipo, "fim");
});

test("Recusar devolve ao modelo que a pessoa recusou, e a ferramenta não roda", async () => {
  const c = montar("recusa");
  await c.conversas.enviar("recusa", '[[chama painel__echo {"text":"oi"}]]');
  await c.conversas.decidir("recusa", cartoes(c.eventos)[0]!.id, "recusar");

  assert.deepEqual(c.chamadas, []);
  const fala = (await c.conversas.estado("recusa")).falas.at(-1);
  assert.equal(fala?.cartoes[0]?.estado, "recusado");
  assert.match(fala?.texto ?? "", /Voltou: recusado/);
});

test("ferramenta que o agent não tem é recusada sem cartão e sem rodar", async () => {
  const c = montar("fora");
  await c.conversas.enviar("fora", '[[chama painel__drop_table]]');
  assert.deepEqual(c.chamadas, []);
  assert.equal(cartoes(c.eventos).length, 0);
  // O modelo recebe o erro e segue: a conversa não trava.
  assert.equal(c.eventos.at(-1)?.tipo, "fim");
  assert.match(JSON.stringify(c.modelo.recebidos.at(-1)?.at(-1)), /unavailable tool 'painel__drop_table'/);
});

test("duas escritas na mesma volta só seguem depois que as duas foram decididas", async () => {
  const c = montar("duas");
  await c.conversas.enviar("duas", '[[chama painel__echo {"text":"a"}]] [[chama painel__echo {"text":"b"}]]');
  const [a, b] = cartoes(c.eventos);
  assert.equal(cartoes(c.eventos).length, 2);
  await c.conversas.decidir("duas", a!.id, "executar");
  assert.deepEqual(c.chamadas, [], "enquanto a segunda espera, nada roda");
  await c.conversas.decidir("duas", b!.id, "recusar");
  assert.deepEqual(c.chamadas, [{ tool: "echo", entrada: { text: "a" } }]);
});

test("cartão pendente sobrevive à janela e expira quando o app reabre", async () => {
  const settings = new SettingsService(bancoDeTeste());
  const c = montar("sobrevive", { settings });
  await c.conversas.enviar("sobrevive", '[[chama painel__echo {"text":"oi"}]]');
  assert.equal((await c.conversas.estado("sobrevive")).falas.at(-1)?.cartoes[0]?.estado, "pendente");

  // Outro processo: a memória do cartão ficou para trás, o histórico guardado não.
  const reaberto = montar("sobrevive", { settings });
  const fala = (await reaberto.conversas.estado("sobrevive")).falas.at(-1);
  assert.equal(fala?.cartoes[0]?.estado, "expirado");
  await assert.rejects(reaberto.conversas.decidir("sobrevive", fala!.cartoes[0]!.id, "executar"), /errors\.expired/);
  assert.deepEqual(reaberto.chamadas, []);
});

test("limpar a conversa expira o cartão pendente, e o clique atrasado não roda nada", async () => {
  const c = montar("limpa");
  await c.conversas.enviar("limpa", '[[chama painel__echo {"text":"oi"}]]');
  const id = cartoes(c.eventos)[0]!.id;
  await c.conversas.limpar("limpa");
  assert.deepEqual((await c.conversas.estado("limpa")).falas, []);
  await assert.rejects(c.conversas.decidir("limpa", id, "executar"), /errors\.expired/);
  assert.deepEqual(c.chamadas, []);
});

test("mandar outra mensagem com cartão pendente é recusado, sem gastar o modelo", async () => {
  const c = montar("espera");
  await c.conversas.enviar("espera", '[[chama painel__echo {"text":"oi"}]]');
  const vistas = c.modelo.recebidos.length;
  await c.conversas.enviar("espera", "e então?");
  assert.equal(c.modelo.recebidos.length, vistas);
  const erro = c.eventos.at(-1);
  assert.equal(erro?.tipo === "erro" ? erro.mensagem : "", "agentChat.errors.pending");
});

test("o orçamento do agent é checado antes de cada volta e o gasto entra no dia do agent", async () => {
  const pedidos: { chave: string; limites: unknown; nome: string | undefined }[] = [];
  const c = montar("orcado", {
    perfil: perfilDe("orcado", {}, { perDayTokens: 100 }),
    deps: { orcamento: { checar: async (chave, _run, limites, nome) => void pedidos.push({ chave, limites, nome }), gastar: async () => undefined } },
  });
  await c.conversas.enviar("orcado", "oi");
  assert.deepEqual(pedidos, [{ chave: "biblioteca:orcado", limites: { perDayTokens: 100 }, nome: "Agent orcado" }]);

  // A volta que continua depois do clique também passa pela checagem.
  await c.conversas.enviar("orcado", '[[chama painel__echo {"text":"x"}]]');
  assert.equal(pedidos.length, 2);
  await c.conversas.decidir("orcado", (await c.conversas.estado("orcado")).falas.at(-1)!.cartoes[0]!.id, "recusar");
  assert.equal(pedidos.length, 3);
});

test("estourou o orçamento: a mensagem diz o limite, o modelo não é chamado e nada é gasto", async () => {
  const c = montar("estourou", {
    deps: {
      orcamento: {
        checar: async () => {
          throw new BudgetExceeded("day", "tokens", 100, 120, "Agent estourou");
        },
        gastar: async () => assert.fail("não gasta quando nem chamou"),
      },
      texto: (chave, vars) => (vars === undefined ? chave : `${chave}:${JSON.stringify(vars)}`),
    },
  });
  await c.conversas.enviar("estourou", "oi");
  assert.equal(c.modelo.recebidos.length, 0);
  const erro = c.eventos.find((e) => e.tipo === "erro");
  assert.equal(erro?.tipo === "erro" ? erro.mensagem : "", 'agentChat.errors.budget:{"scope":"agentChat.scopes.day","limit":"100 tokens","spent":"120 tokens"}');
});

test("o gasto da volta, em tokens e dólar, entra na chave do agent da biblioteca", async () => {
  const c = montar("gasta", {
    deps: { preco: async () => ({ provider: "falso", model: "roteiro", inputUsdPerMtok: 1_000_000, outputUsdPerMtok: 2_000_000, updatedAt: 0 }) },
  });
  await c.conversas.enviar("gasta", "oi");
  assert.deepEqual(c.gastos, [{ chave: "biblioteca:gasta", usd: 20, tokens: 15 }]);
});

test("o chat do agent conta o gasto no provedor do modelo, para o orçamento local", async () => {
  const { aoGastar } = await import("../src/runtimes/limites-lidos.js");
  const vistos: unknown[] = [];
  const parar = aoGastar((provedor, gasto) => vistos.push([provedor, gasto]));
  try {
    const c = montar("conta", {
      deps: { preco: async () => ({ provider: "falso", model: "roteiro", inputUsdPerMtok: 1_000_000, outputUsdPerMtok: 2_000_000, updatedAt: 0 }) },
    });
    await c.conversas.enviar("conta", "oi");
  } finally {
    parar();
  }
  assert.deepEqual(vistos, [["falso", { usd: 20, tokens: 15 }]]);
});

test("cada agent tem a sua conversa guardada, e ela volta com o histórico para o modelo", async () => {
  const settings = new SettingsService(bancoDeTeste());
  const a = montar("um", { settings });
  const b = montar("dois", { settings });
  await a.conversas.enviar("um", "primeira do um");
  await b.conversas.enviar("dois", "primeira do dois");
  assert.ok(await settings.get(`chat.falas.${chaveDoAgent("um")}`));
  assert.deepEqual((await b.conversas.estado("dois")).falas.map((f) => f.texto)[0], "primeira do dois");

  const reaberto = montar("um", { settings });
  const falas = (await reaberto.conversas.estado("um")).falas;
  assert.equal(falas[0]?.texto, "primeira do um");
  await reaberto.conversas.enviar("um", "segunda do um");
  // O processo novo não tem a memória do modelo, mas relê as falas guardadas.
  assert.ok(JSON.stringify(reaberto.modelo.recebidos[0]).includes("primeira do um"));
  assert.ok(!JSON.stringify(reaberto.modelo.recebidos[0]).includes("primeira do dois"));
});

test("a conversa comprida é compactada como a do assistente, e a tela é avisada", async () => {
  const c = montar("longa", { deps: { teto: 600 } });
  for (let i = 0; i < 8; i++) await c.conversas.enviar("longa", `pergunta ${i} ${"x".repeat(200)}`);
  assert.ok(c.eventos.some((e) => e.tipo === "resumido"));
  assert.equal((await c.conversas.estado("longa")).falas.length, 16, "as falas continuam todas na tela");
});

test("conexão sem servidor aparece como aviso, e a conversa segue", async () => {
  const c = montar("aviso", {
    perfil: perfilDe("aviso", { semServidor: [{ connectionId: "jira", motivo: "sem servidor ligado nesta máquina" }] }),
  });
  assert.deepEqual((await c.conversas.estado("aviso")).semServidor, [{ connectionId: "jira", motivo: "sem servidor ligado nesta máquina" }]);
  await c.conversas.enviar("aviso", "oi");
  assert.match(await textoDoAssistente(c, "aviso"), /Resposta do modelo falso/);
});

test("cancelar com cartão pendente expira o cartão e a conversa pode seguir", async () => {
  const c = montar("cancela");
  await c.conversas.enviar("cancela", '[[chama painel__echo {"text":"oi"}]]');
  const id = cartoes(c.eventos)[0]!.id;
  c.conversas.cancelar("cancela");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await c.conversas.estado("cancela")).falas.at(-1)?.cartoes[0]?.estado, "expirado");
  await assert.rejects(c.conversas.decidir("cancela", id, "executar"), /errors\.expired/);
  await c.conversas.enviar("cancela", "oi de novo");
  assert.match(await textoDoAssistente(c, "cancela"), /Resposta do modelo falso a: oi de novo/);
});

test("pela assinatura do Claude Code, a escrita pede o clique no cartão e o resto é negado sem cartão", async () => {
  let decisoes: { dentro: unknown; fora: unknown } | undefined;
  let estadoAntes: string | undefined;
  const c: Cenario = montar("assina", {
    deps: {
      modelo: async () => ({ via: "claude-code", modelo: "sonnet" }),
      assinatura: async (pedido) => {
        const fora = await pedido.aprovar("mcp__painel__drop_table", {}, "uso-0");
        const dentro = await pedido.aprovar("mcp__painel__echo", { text: "oi" }, "uso-1");
        decisoes = { dentro, fora };
        // O resultado só chega depois da execução, ligado à chamada pelo id.
        estadoAntes = (await c.conversas.estado("assina")).falas.at(-1)?.cartoes[0]?.estado;
        pedido.emitir({ tipo: "resultado", nome: "", id: "uso-1", texto: "oi" });
        pedido.emitir({ tipo: "texto", delta: "pronto" });
        pedido.emitir({ tipo: "fim", motivo: "success" });
        return { sessao: "sessao-1", gasto: { usd: 0.5, tokens: 30 } };
      },
    },
  });
  const turno = c.conversas.enviar("assina", "faz");
  await new Promise((r) => setTimeout(r, 20));
  const [cartao] = cartoes(c.eventos);
  assert.equal(cartao?.ferramenta, "echo");
  assert.equal(cartoes(c.eventos).length, 1, "a ferramenta de fora não ganha cartão");
  assert.equal((await c.conversas.estado("assina")).respondendo, true);

  await c.conversas.decidir("assina", cartao!.id, "executar");
  await turno;
  assert.deepEqual(decisoes?.dentro, { permitir: true, entrada: { text: "oi" } });
  assert.equal((decisoes?.fora as { permitir: boolean }).permitir, false);
  assert.equal(estadoAntes, "executando", "até a ferramenta responder, o cartão só está executando");
  const executado = (await c.conversas.estado("assina")).falas.at(-1)?.cartoes[0];
  assert.deepEqual([executado?.estado, executado?.resultado], ["executado", "oi"]);
  assert.deepEqual(c.gastos, [{ chave: "biblioteca:assina", usd: 0.5, tokens: 30 }]);
  assert.equal(await c.settings.get(`chat.sessao.${chaveDoAgent("assina")}`), "sessao-1");
});

test("pela assinatura, Recusar nega a chamada com a explicação para o modelo", async () => {
  let decisao: { permitir: boolean; mensagem?: string } | undefined;
  const c = montar("assina-nao", {
    deps: {
      modelo: async () => ({ via: "claude-code", modelo: "sonnet" }),
      assinatura: async (pedido) => {
        decisao = await pedido.aprovar("mcp__painel__echo", { text: "oi" });
        pedido.emitir({ tipo: "fim", motivo: "success" });
        return { sessao: undefined, gasto: { usd: 0, tokens: 0 } };
      },
    },
  });
  const turno = c.conversas.enviar("assina-nao", "faz");
  await new Promise((r) => setTimeout(r, 20));
  await c.conversas.decidir("assina-nao", cartoes(c.eventos)[0]!.id, "recusar");
  await turno;
  assert.equal(decisao?.permitir, false);
  assert.match(decisao?.mensagem ?? "", /recusou/);
});


test("leitura lenta e escrita no mesmo passo: o cartão só aparece quando a volta termina", async () => {
  const c = montar("lenta", { demoraDaLeituraMs: 80 });
  const turno = c.conversas.enviar("lenta", '[[chama painel__pid]] [[chama painel__echo {"text":"x"}]]');
  await new Promise((r) => setTimeout(r, 30));
  // O SDK já pediu a aprovação no meio do passo, mas a leitura ainda corre: nada de cartão ainda.
  assert.equal(cartoes(c.eventos).length, 0);
  assert.deepEqual((await c.conversas.estado("lenta")).falas.at(-1)?.cartoes, []);
  await turno;

  const tipos = c.eventos.map((e) => e.tipo);
  assert.ok(tipos.indexOf("cartao") > tipos.indexOf("fim"), "o cartão vem depois do fim da volta");
  const estado = await c.conversas.estado("lenta");
  assert.equal(estado.respondendo, false);
  const cartao = estado.falas.at(-1)!.cartoes[0]!;
  assert.equal(cartao.estado, "pendente");
  await c.conversas.decidir("lenta", cartao.id, "executar");
  assert.deepEqual(c.chamadas.map((x) => x.tool).sort(), ["echo", "pid"]);
});

test("o cartão fica executando até a ferramenta responder, e mostra o resultado como texto legível", async () => {
  const c = montar("estados");
  await c.conversas.enviar("estados", '[[chama painel__echo {"text":"oi"}]]');
  const id = cartoes(c.eventos)[0]!.id;
  await c.conversas.decidir("estados", id, "executar");
  const sequencia = c.eventos.flatMap((e) => (e.tipo === "cartao-estado" ? [e.estado] : []));
  assert.deepEqual(sequencia, ["executando", "executado"]);
  assert.equal((await c.conversas.estado("estados")).falas.at(-1)?.cartoes[0]?.resultado, "echo feito");
});

test("o resultado do MCP vira o texto do content, e JSON só quando não há texto", () => {
  assert.equal(legivel({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], isError: false }), "a\nb");
  assert.equal(legivel("já é texto"), "já é texto");
  assert.equal(legivel({ ok: true }), '{\n  "ok": true\n}');
});

test("o Claude Code que morre com cartão pendente expira o cartão, e o clique não marca executado", async () => {
  const c = montar("morre", {
    deps: {
      modelo: async () => ({ via: "claude-code", modelo: "sonnet" }),
      assinatura: async (pedido) => {
        // O cartão abre e o CLI sai sem esperar a resposta.
        void pedido.aprovar("mcp__painel__echo", { text: "oi" }, "uso-1");
        await new Promise((r) => setTimeout(r, 10));
        return { sessao: undefined, gasto: { usd: 0, tokens: 0 } };
      },
    },
  });
  await c.conversas.enviar("morre", "faz");
  const cartao = (await c.conversas.estado("morre")).falas.at(-1)!.cartoes[0]!;
  assert.equal(cartao.estado, "expirado");
  await assert.rejects(c.conversas.decidir("morre", cartao.id, "executar"), /errors\.expired/);
  assert.ok(!c.eventos.some((e) => e.tipo === "cartao-estado" && (e.estado === "executando" || e.estado === "executado")));
});

test("as skills do agent entram no system, como na consulta entre agents", async () => {
  const skills = new Map([["estilo", { name: "estilo", description: "d", body: "Responda sempre em haicai.", origin: "teste", hash: "h" }]]);
  const perfil = perfilDe("com-skill");
  perfil.version.spec.skills = [{ skill: "estilo", when: { always: true } }];
  const c = montar("com-skill", { perfil, deps: { skills } });
  await c.conversas.enviar("com-skill", "oi");
  const system = JSON.stringify(c.modelo.recebidos[0]);
  assert.match(system, /Você é o agent de teste\./);
  assert.match(system, /Skill: estilo/);
  assert.match(system, /Responda sempre em haicai\./);
});

test("o teto por execução vale sobre a conversa: o gasto acumulado entra na checagem de cada volta", async () => {
  const vistos: unknown[] = [];
  const c = montar("acumula", { deps: { orcamento: { checar: async (_c, run) => void vistos.push({ ...run }), gastar: async () => undefined } } });
  await c.conversas.enviar("acumula", "um");
  await c.conversas.enviar("acumula", "dois");
  assert.deepEqual(vistos, [{ usd: 0, tokens: 0 }, { usd: 0, tokens: 15 }]);
  await c.conversas.limpar("acumula");
  await c.conversas.enviar("acumula", "três");
  assert.deepEqual(vistos.at(-1), { usd: 0, tokens: 0 }, "limpar zera o acumulado");
});

test("a volta cancelada grava o que o Claude Code já tinha contado", async () => {
  const c = montar("cancelada", {
    deps: {
      modelo: async () => ({ via: "claude-code", modelo: "sonnet" }),
      assinatura: async (pedido) => {
        await new Promise<void>((r) => pedido.sinal.addEventListener("abort", () => r()));
        return { sessao: undefined, gasto: { usd: 0.01, tokens: 7 } };
      },
    },
  });
  const turno = c.conversas.enviar("cancelada", "faz");
  await new Promise((r) => setTimeout(r, 10));
  c.conversas.cancelar("cancelada");
  await turno;
  assert.deepEqual(c.gastos, [{ chave: "biblioteca:cancelada", usd: 0.01, tokens: 7 }]);
});

test("as ferramentas da conta Claude não entram no chat, e a tela é avisada", async () => {
  const c = montar("conta", {
    perfil: perfilDe("conta", { tools: [LEITURA, { server: "claude-conta", tool: "mcp__github__list_issues", class: "read" }] }),
  });
  assert.equal((await c.conversas.estado("conta")).contaIgnorada, 1);
  await c.conversas.enviar("conta", "oi [[chama painel__pid]]");
  assert.match(await textoDoAssistente(c, "conta"), /Voltou: pid feito/);
});

test("Recusar pela assinatura continua recusado mesmo com o tool_result de erro que o CLI devolve", async () => {
  const c = montar("assina-erro", {
    deps: {
      modelo: async () => ({ via: "claude-code", modelo: "sonnet" }),
      assinatura: async (pedido) => {
        await pedido.aprovar("mcp__painel__echo", { text: "oi" }, "uso-9");
        pedido.emitir({ tipo: "resultado", nome: "", id: "uso-9", texto: "A pessoa recusou esta chamada.", erro: true });
        pedido.emitir({ tipo: "fim", motivo: "success" });
        return { sessao: undefined, gasto: { usd: 0, tokens: 0 } };
      },
    },
  });
  const turno = c.conversas.enviar("assina-erro", "faz");
  await new Promise((r) => setTimeout(r, 20));
  await c.conversas.decidir("assina-erro", cartoes(c.eventos)[0]!.id, "recusar");
  await turno;
  assert.equal((await c.conversas.estado("assina-erro")).falas.at(-1)?.cartoes[0]?.estado, "recusado");
});

test("Claude Code que morre depois do Executar e antes do resultado: o cartão falha no fim da volta", async () => {
  const c = montar("morre-depois", {
    deps: {
      modelo: async () => ({ via: "claude-code", modelo: "sonnet" }),
      assinatura: async (pedido) => {
        await pedido.aprovar("mcp__painel__echo", { text: "oi" }, "uso-1");
        return { sessao: undefined, gasto: { usd: 0, tokens: 0 } };
      },
    },
  });
  const turno = c.conversas.enviar("morre-depois", "faz");
  await new Promise((r) => setTimeout(r, 20));
  await c.conversas.decidir("morre-depois", cartoes(c.eventos)[0]!.id, "executar");
  await turno;
  const cartao = (await c.conversas.estado("morre-depois")).falas.at(-1)!.cartoes[0]!;
  assert.equal(cartao.estado, "falhou");
  assert.equal(cartao.resultado, "agentChat.errors.noResult");
});

test("escrita pedida e Parar antes do fim da volta não deixa cartão pendente, e a conversa segue", async () => {
  const c = montar("para", { demoraDaLeituraMs: 120 });
  const turno = c.conversas.enviar("para", '[[chama painel__pid]] [[chama painel__echo {"text":"x"}]]');
  await new Promise((r) => setTimeout(r, 30));
  c.conversas.cancelar("para");
  await turno;
  assert.equal(cartoes(c.eventos).length, 0);
  assert.deepEqual((await c.conversas.estado("para")).falas.at(-1)?.cartoes, []);
  await c.conversas.enviar("para", "depois");
  assert.match(await textoDoAssistente(c, "para"), /Resposta do modelo falso a: depois/);
});

test("a continuação que falha antes de a ferramenta rodar marca o cartão como falhou, e a conversa segue sem limpar", async () => {
  let chamadas = 0;
  const c = montar("falha-continua", {
    deps: {
      orcamento: {
        checar: async () => {
          if (++chamadas === 2) throw new BudgetExceeded("day", "tokens", 10, 15, "Agent");
        },
        gastar: async () => undefined,
      },
    },
  });
  await c.conversas.enviar("falha-continua", '[[chama painel__echo {"text":"x"}]]');
  const id = cartoes(c.eventos)[0]!.id;
  await c.conversas.decidir("falha-continua", id, "executar");
  const cartao = (await c.conversas.estado("falha-continua")).falas.at(-1)!.cartoes[0]!;
  assert.equal(cartao.estado, "falhou");
  assert.match(cartao.resultado ?? "", /errors\.budget/);
  assert.deepEqual(c.chamadas, []);

  // O histórico não ficou com pedido de aprovação sem resposta.
  await c.conversas.enviar("falha-continua", "e agora?");
  assert.match(await textoDoAssistente(c, "falha-continua"), /Resposta do modelo falso a: e agora\?/);
});
