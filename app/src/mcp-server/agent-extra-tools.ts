import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentSpec } from "../config/types.js";
import { REPLY_SPECS } from "../examples/agents.js";
import { agentService } from "../services/agent-service.js";
import { instalarTemplate } from "../services/template-install.js";
import type { Ambiente } from "./ambiente.js";
import { specAtual } from "./config-tools.js";
import { redactSecrets, restoreSpec } from "./redact.js";
import { def } from "./tool-def.js";

/**
 * O que a tela de agents faz além de listar e gravar como agent: salvar como
 * pessoa, duplicar, importar e exportar o spec como texto, o marketplace e a
 * resposta pronta. `upsert_agent`, ao contrário de `save_agent_edited`, grava
 * como agent e rebaixa a ação para aprovação.
 */
/** O texto de um spec exportado, com o que veio oculto devolvido pela versão atual do mesmo agent. */
async function restaurarTexto(texto: string): Promise<{ texto: string; semValor: string[] }> {
  let spec: unknown;
  try {
    spec = JSON.parse(texto);
  } catch {
    return { texto, semValor: [] };
  }
  const { spec: inteiro, semValor } = restoreSpec(await specAtual(spec), spec);
  return { texto: JSON.stringify(inteiro), semValor };
}

export function registerAgentExtraTools(server: McpServer, amb: Ambiente): void {
  def(server, "list_agent_budgets", "read",
    "Spending cap of each agent with what was spent today (dollars, tokens, runs) and the models that have no registered price.",
    {}, () => agentService.budgets());

  def(server, "get_agents_overview", "read",
    "What the agents list screen shows without opening any agent: model, cadence and spending of each.",
    {}, () => agentService.overview());

  def(server, "save_agent_edited", "danger",
    "Records an edited AgentSpec as a new version AS A PERSON, like the Save button of the editor: unlike upsert_agent, an action step can be raised to draft or auto here, and an auto action publishes without approval whenever the agent runs. Requires a note saying what changed, and the spec id must be the agent edited.",
    {
      agentId: z.string(),
      spec: z.record(z.string(), z.unknown()).describe("full AgentSpec"),
      note: z.string().min(1).describe("what changed, stored with the version"),
    },
    async ({ agentId, spec, note }) => {
      const { spec: inteiro, semValor } = restoreSpec(await specAtual({ id: agentId }), spec);
      const v = await agentService.saveEdited(agentId, inteiro as unknown as AgentSpec, note);
      return { agentId: v.agentId, version: v.version, note: v.note, ...(semValor.length > 0 ? { hiddenWithoutValue: semValor } : {}) };
    });

  def(server, "duplicate_agent", "write",
    "A new agent copied from an existing one, keeping the action modes of the original (the copy is made as a person).",
    { fromId: z.string(), newId: z.string().describe("lowercase, digits and dashes, 2 to 63 chars"), newName: z.string().min(1) },
    async ({ fromId, newId, newName }) => {
      const v = await agentService.duplicate(fromId, newId, newName);
      return { agentId: v.agentId, version: v.version };
    });

  def(server, "export_agent", "read",
    "The spec of an agent as JSON text, ready to save as a file (the screen opens a save dialog; here the text comes back).",
    { agentId: z.string() },
    async ({ agentId }) => ({
      fileName: `${agentId}.json`,
      // Sai para outra máquina: o valor literal de headers e env fica de fora, e só a referência vai no texto.
      text: `${JSON.stringify(redactSecrets(JSON.parse(await agentService.exportSpec(agentId))), null, 2)}\n`,
    }));

  def(server, "import_agent", "danger",
    "Imports an agent spec from JSON text as a person, like the Import button: a new agent, or a new version of the one with the same id. The modes of action steps are kept as the text has them, so an auto action in the file publishes without approval when the agent runs.",
    { text: z.string().min(1), origin: z.string().optional().describe("a label for the error messages, like the file name") },
    async ({ text, origin }) => {
      const { texto, semValor } = await restaurarTexto(text);
      const { version, created } = await agentService.importSpec(texto, origin ?? "texto");
      return { agentId: version.agentId, version: version.version, created, ...(semValor.length > 0 ? { hiddenWithoutValue: semValor } : {}) };
    });

  def(server, "save_agent_draft", "write",
    "Records a draft written from a description (what the 'create with AI' screen saves after the person accepts it) as a new agent. Refused if the id exists. Action steps start in approval mode.",
    { spec: z.record(z.string(), z.unknown()), description: z.string().min(1).describe("the request that produced the draft, stored in the note") },
    async ({ spec, description }) => {
      const v = await agentService.saveDraft(restoreSpec(undefined, spec).spec as unknown as AgentSpec, description);
      return { agentId: v.agentId, version: v.version };
    });

  def(server, "list_agent_templates", "read-external",
    "The marketplace of ready agents: the examples of the Locum repository on GitHub, or the bundled copy when it does not answer (origem says which). Each template shows its model steps by index and name.",
    {}, () => amb.templates().listar());

  def(server, "install_agent_template", "write",
    "Installs a marketplace template by id (as listed by list_agent_templates) as a new agent or a new version of the one with the same id. substitutions maps the index of a model step to provider/model, checked against the models of this machine.",
    {
      id: z.string().min(1),
      substitutions: z.record(z.string(), z.string()).optional().describe("model step index to provider/model"),
    },
    ({ id, substitutions }) =>
      instalarTemplate(amb.templates(), id, substitutions === undefined ? undefined : Object.fromEntries(Object.entries(substitutions).map(([k, v]) => [Number(k), v]))));

  def(server, "install_reply_agent", "write",
    "Installs the ready reply agent of Slack or Teams. An agent with the same id that already exists stays as it is.",
    { service: z.enum(["slack", "teams"]) },
    async ({ service }) => {
      const spec = REPLY_SPECS[service];
      if (spec === undefined) throw new Error(`não há resposta pronta para ${service}`);
      if ((await agentService.get(spec.id)) !== undefined) return { agentId: spec.id, created: false };
      await agentService.upsert(spec, "resposta pronta", "human");
      return { agentId: spec.id, created: true };
    });
}
