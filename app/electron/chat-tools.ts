import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { agentService } from "../src/services/agent-service.js";
import { approvalService } from "../src/services/approval-service.js";
import { initiativeService } from "../src/services/initiative-service.js";
import { LocalFolderContextStore } from "../src/services/context-store.js";
import { mcpService } from "../src/services/mcp-service.js";
import { metricsService } from "../src/services/metrics-service.js";
import { promptService } from "../src/services/prompt-service.js";
import { providerService } from "../src/services/provider-service.js";
import { runService } from "../src/services/run-service.js";
import { machineService } from "../src/services/machine-service.js";

/**
 * Catalogo do assistente, escrito a mao, uma entrada por vez.
 *
 * Derivar esta lista dos canais da ponte seria mais curto e seria o erro que a
 * emenda 5 do ADR 0003 descreve: o assistente le diff, achado e log, que sao
 * conteudo de terceiro, e uma instrucao plantada la dentro viraria chamada de
 * ferramenta. O que ele nao pode fazer precisa ficar fora por ausencia, nao por
 * filtro que alguem lembra de aplicar.
 *
 * Fora daqui de proposito:
 *
 * - `approvals.decide`, aprovar e rejeitar. Nao e acao da janela, e o clique de
 *   uma pessoa. O assistente pode mostrar a pendencia e propor o texto; quem
 *   decide clica no botao, que fala com a ponte por outro caminho.
 * - `run_agent` e `rerun_step`. Gastam cota e levam minutos. Entram quando
 *   houver confirmacao explicita na propria conversa, nao antes.
 *
 * Gravar agent entra, porque a gravacao vinda de agent ja nasce com teto: passo
 * de acao em rascunho ou automatico volta rebaixado para aprovacao.
 *
 * As escritas de iniciativa e prompt entram pela mesma razao do ADR 0004
 * (decisao 5): nenhuma delas publica fora, decide pendencia ou roda agent, e
 * `propose_context_update` so cria a pendencia, sem tocar no `context.md`. O
 * teto do paragrafo acima e especifico do rebaixamento de agent e nao se
 * estende a elas. O risco que sobra e o ADR que registra: conteudo lido pelo
 * chat pode induzir uma mudanca de configuracao, como ligar um servidor a uma
 * iniciativa; a mudanca aparece na conversa e e reversivel.
 */
export function chatTools(): ToolSet {
  return {
    listar_agents: tool({
      description: "Lists the registered agents, with name and whether each is enabled.",
      inputSchema: z.object({}),
      execute: async () => agentService.list(),
    }),

    ver_agent: tool({
      description:
        "Details of one agent: the latest version of its spec, with steps, models, tools and budget.",
      inputSchema: z.object({ agentId: z.string() }),
      execute: async ({ agentId }) => agentService.getLatestVersion(agentId),
    }),

    versoes_do_agent: tool({
      description: "Version history of an agent, newest first.",
      inputSchema: z.object({ agentId: z.string() }),
      execute: async ({ agentId }) => agentService.listVersions(agentId),
    }),

    listar_execucoes: tool({
      description:
        "Recent runs, optionally filtered by status (queued, running, paused, done, failed) or by agent.",
      inputSchema: z.object({
        status: z.string().optional(),
        agentId: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async (filtro) => runService.list(filtro),
    }),

    ver_execucao: tool({
      description:
        "Details of one run: each step with the model used, fallback, tools, tokens, cost and error.",
      inputSchema: z.object({ runId: z.string() }),
      execute: async ({ runId }) => runService.get(runId),
    }),

    achados_da_execucao: tool({
      description: "Findings of a run, with file, line, severity and issue.",
      inputSchema: z.object({ runId: z.string() }),
      execute: async ({ runId }) => runService.findings(runId),
    }),

    fila_de_aprovacao: tool({
      description:
        "Pending approvals awaiting a decision. Read only: deciding is a person's click, never your action.",
      inputSchema: z.object({}),
      execute: async () => approvalService.listPending(),
    }),

    metricas: tool({
      description: "Precision and agreement per agent version, from the outcomes already reconciled.",
      inputSchema: z.object({ agentId: z.string().optional() }),
      execute: async ({ agentId }) => metricsService.report({ agentId }),
    }),

    listar_provedores: tool({
      description: "Model providers and whether each is available on this machine.",
      inputSchema: z.object({}),
      execute: async () => providerService.listProviders(),
    }),

    perfil_da_maquina: tool({
      description: "This machine's identifier and its model fallback table.",
      inputSchema: z.object({}),
      execute: async () => machineService.profile(),
    }),

    listar_servidores_mcp: tool({
      description: "Registered MCP servers, with transport, scope and whether each is enabled.",
      inputSchema: z.object({}),
      execute: async () => mcpService.list(),
    }),

    ferramentas_do_servidor: tool({
      description:
        "Tools an MCP server exposes, with the description and estimated schema tokens of each.",
      inputSchema: z.object({ nome: z.string() }),
      execute: async ({ nome }) => mcpService.listTools(nome),
    }),

    testar_servidor_mcp: tool({
      description: "Connects to a registered MCP server and reports whether it answered.",
      inputSchema: z.object({ nome: z.string() }),
      execute: async ({ nome }) => mcpService.testConnection(nome),
    }),

    list_initiatives: tool({
      description: "Lists every registered initiative.",
      inputSchema: z.object({}),
      execute: async () => initiativeService.list(),
    }),

    get_initiative: tool({
      description: "Details of one initiative, by slug.",
      inputSchema: z.object({ slug: z.string() }),
      execute: async ({ slug }) => initiativeService.get(slug),
    }),

    read_initiative_context: tool({
      description: "Reads a file from the initiative's context folder, with its hash.",
      inputSchema: z.object({ slug: z.string(), file: z.string().optional() }),
      execute: async ({ slug, file }) => {
        const initiative = await initiativeService.get(slug);
        if (!initiative) throw new Error(`iniciativa "${slug}" nao cadastrada`);
        const store = new LocalFolderContextStore(initiative.contextPath);
        const alvo = file ?? "context.md";
        const [content, hash] = await Promise.all([store.read(alvo), store.hash(alvo)]);
        return { content, hash };
      },
    }),

    list_prompts: tool({
      description: "Lists prompts, optionally filtered by initiative id.",
      inputSchema: z.object({ initiativeId: z.string().optional() }),
      execute: async ({ initiativeId }) => promptService.list(initiativeId),
    }),

    get_prompt: tool({
      description: "A prompt with the body of its latest version.",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => promptService.get(name),
    }),

    create_initiative: tool({
      description:
        "Creates an initiative, with its context folder and initial context.md, or updates the fields of an existing one. Never rewrites context.md after the first write.",
      inputSchema: z.object({
        slug: z.string().describe("lowercase letters, digits and hyphen, 2 to 63 characters"),
        title: z.string(),
        objective: z.string(),
        doneCriteria: z.string(),
        dueAt: z.number().int().optional(),
        goalRef: z.string().optional(),
      }),
      execute: async (input) => initiativeService.upsert(input),
    }),

    set_initiative_status: tool({
      description: "Sets the status of an initiative.",
      inputSchema: z.object({ slug: z.string(), status: z.enum(["active", "paused", "done", "dropped"]) }),
      execute: async ({ slug, status }) => initiativeService.setStatus(slug, status),
    }),

    set_initiative_servers: tool({
      description:
        "Replaces the MCP servers the initiative can see, validated against the registry. Returns the already-linked agents that would lose a tool with the new list.",
      inputSchema: z.object({ slug: z.string(), names: z.array(z.string()) }),
      execute: async ({ slug, names }) => initiativeService.setServers(slug, names),
    }),

    link_agent_to_initiative: tool({
      description:
        'Links an agent to an initiative, or unlinks it with slug null. Refuses to link when the agent\'s latest version uses a tool or "requiresServers" outside the initiative\'s servers.',
      inputSchema: z.object({ agentId: z.string(), slug: z.string().nullable() }),
      execute: async ({ agentId, slug }) => {
        await initiativeService.linkAgent(agentId, slug);
        return { agentId, slug };
      },
    }),

    set_initiative_workspace: tool({
      description: "Replaces the workspaces (repo, worktree, branch) of an initiative.",
      inputSchema: z.object({
        slug: z.string(),
        workspaces: z.array(
          z.object({
            repoPath: z.string().describe("absolute path to an existing directory"),
            worktreePath: z.string().nullable().optional(),
            branch: z.string().nullable().optional(),
            label: z.string().nullable().optional(),
          }),
        ),
      }),
      execute: async ({ slug, workspaces }) => {
        await initiativeService.setWorkspaces(slug, workspaces);
        return { slug, count: workspaces.length };
      },
    }),

    add_initiative_link: tool({
      description: "Adds a link (doc, board, repo or other) to an initiative.",
      inputSchema: z.object({
        slug: z.string(),
        kind: z.enum(["doc", "board", "repo", "other"]),
        url: z.string(),
        label: z.string().optional(),
      }),
      execute: async ({ slug, kind, url, label }) => {
        await initiativeService.addLink(slug, { kind, url, label });
        return { slug, kind, url, label: label ?? null };
      },
    }),

    upsert_prompt: tool({
      description:
        "Records a prompt as a new immutable version. A second call with the same body does not open a new version.",
      inputSchema: z.object({ name: z.string(), body: z.string(), note: z.string().optional() }),
      execute: async ({ name, body, note }) => promptService.upsert(name, body, note),
    }),

    propose_context_update: tool({
      description:
        'Proposes a change to context.md through the approval queue. Creates nothing but a pending decision: it never writes to the file. "replace" requires baseHash (from read_initiative_context); "append" does not accept one.',
      inputSchema: z.object({
        slug: z.string(),
        mode: z.enum(["replace", "append"]),
        content: z.string(),
        baseHash: z.string().optional(),
      }),
      execute: async ({ slug, mode, content, baseHash }) =>
        initiativeService.proposeContextUpdate({ slug, mode, content, baseHash, origin: "chat" }),
    }),
  };
}
