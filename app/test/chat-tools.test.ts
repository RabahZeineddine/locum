import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chatTools } from "../electron/chat-tools.js";
import { AgentSpec } from "../src/config/types.js";
import { migrateDb } from "../src/db/migrate.js";
import { AgentService } from "../src/services/agent-service.js";
import { mcpService } from "../src/services/mcp-service.js";

before(() => {
  migrateDb();
});

/** Chama a ferramenta do catalogo como o SDK do assistente chamaria. */
async function chamar(nome: string, input: unknown): Promise<unknown> {
  const ferramenta = chatTools()[nome];
  assert.ok(ferramenta?.execute, `ferramenta "${nome}" nao esta no catalogo do chat`);
  return ferramenta.execute(input as never, {} as never);
}

test("catalogo do chat nao tem ferramenta que decida pendencia, abra sessao ou rode agent", () => {
  const nomes = Object.keys(chatTools());
  for (const proibida of ["approvals_decide", "aprovar", "run_agent", "rerun_step", "open_session"]) {
    assert.ok(!nomes.includes(proibida), `"${proibida}" nao pode estar no catalogo do chat`);
  }
});

test(
  "so por ferramentas do chat: cria iniciativa, liga servidor, liga agent, poe workspace e link, grava prompt e propoe contexto",
  async () => {
    const slug = `frente-${randomUUID().slice(0, 8)}`;
    const servidor = `srv-${randomUUID().slice(0, 8)}`;
    const agentId = `agente-${randomUUID().slice(0, 8)}`;

    const criada = (await chamar("create_initiative", {
      slug,
      title: "Frente do chat",
      objective: "objetivo",
      doneCriteria: "criterio",
    })) as { slug: string };
    assert.equal(criada.slug, slug);

    await mcpService.register({ name: servidor, transport: "stdio", command: ["true"] });
    const servidores = (await chamar("set_initiative_servers", { slug, names: [servidor] })) as {
      affectedAgents: unknown[];
    };
    assert.deepEqual(servidores.affectedAgents, []);

    await new AgentService().upsert(
      AgentSpec.parse({
        id: agentId,
        name: "Agent do chat",
        steps: [{ type: "model", key: "passo", name: "Passo", model: "ollama/modelo", prompt: "oi" }],
      }),
      undefined,
      "human",
    );
    const ligado = (await chamar("link_agent_to_initiative", { agentId, slug })) as { agentId: string; slug: string };
    assert.equal(ligado.slug, slug);

    await chamar("set_initiative_workspace", {
      slug,
      workspaces: [{ repoPath: process.cwd() }],
    });

    await chamar("add_initiative_link", { slug, kind: "doc", url: "https://exemplo.org" });

    const nomeDoPrompt = `prompt-${randomUUID().slice(0, 8)}`;
    const prompt = (await chamar("upsert_prompt", { name: nomeDoPrompt, body: "corpo" })) as { version: number };
    assert.equal(prompt.version, 1);

    const antes = (await chamar("read_initiative_context", { slug })) as { content: string };

    const proposta = (await chamar("propose_context_update", {
      slug,
      mode: "append",
      content: "bloco do chat",
    })) as { approvalId: string };
    assert.ok(proposta.approvalId.length > 0);

    const depois = (await chamar("read_initiative_context", { slug })) as { content: string };
    assert.equal(depois.content, antes.content, "propose_context_update nao pode escrever no arquivo");

    const detalhe = (await chamar("get_initiative", { slug })) as { slug: string } | undefined;
    assert.equal(detalhe?.slug, slug);
  },
);
