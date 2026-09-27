import { eq } from "drizzle-orm";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, schema } from "../db/index.js";
import { InitiativeService, initiativeService } from "../services/initiative-service.js";
import { LocalFolderContextStore } from "../services/context-store.js";
import { PromptService, promptService } from "../services/prompt-service.js";
import { respond } from "./respond.js";

/**
 * Ferramentas de iniciativa e prompt do servidor MCP.
 *
 * Leitura e as escritas `internal_write` do desenho (ADR 0004, decisao 5):
 * nenhuma delas publica no `context.md`, decide pendencia ou roda agent.
 * `propose_context_update` so cria a pendencia; a publicacao de verdade
 * continua so pelo clique de aprovacao, fora do MCP e do chat.
 */
export function registerInitiativeTools(
  server: McpServer,
  initiatives: InitiativeService = initiativeService,
  prompts: PromptService = promptService,
): void {
  server.registerTool(
    "list_initiatives",
    {
      description: "Lists every registered initiative.",
      inputSchema: {},
    },
    async () => respond(() => initiatives.list()),
  );

  server.registerTool(
    "get_initiative",
    {
      description:
        "Details of one initiative: the row, its MCP servers, workspaces, links and linked agents.",
      inputSchema: { slug: z.string() },
    },
    async ({ slug }) => respond(() => getInitiative(initiatives, slug)),
  );

  server.registerTool(
    "read_initiative_context",
    {
      description: "Reads a file from the initiative's context folder, with its hash.",
      inputSchema: {
        slug: z.string(),
        file: z.string().optional().describe('defaults to "context.md"'),
      },
    },
    async ({ slug, file }) => respond(() => readContext(initiatives, slug, file ?? "context.md")),
  );

  server.registerTool(
    "list_prompts",
    {
      description: "Lists prompts, optionally filtered by initiative id.",
      inputSchema: { initiativeId: z.string().optional() },
    },
    async ({ initiativeId }) => respond(() => prompts.list(initiativeId)),
  );

  server.registerTool(
    "get_prompt",
    {
      description: "A prompt with the body of its latest version.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => respond(() => getPrompt(prompts, name)),
  );

  server.registerTool(
    "upsert_initiative",
    {
      description:
        "Creates an initiative, with its context folder and initial context.md, or updates the fields of an existing one. Never rewrites context.md after the first write.",
      inputSchema: {
        slug: z.string().describe("lowercase letters, digits and hyphen, 2 to 63 characters"),
        title: z.string(),
        objective: z.string(),
        doneCriteria: z.string(),
        dueAt: z.number().int().optional(),
        goalRef: z.string().optional(),
      },
    },
    async (input) => respond(() => initiatives.upsert(input)),
  );

  server.registerTool(
    "set_initiative_status",
    {
      description: "Sets the status of an initiative.",
      inputSchema: {
        slug: z.string(),
        status: z.enum(["active", "paused", "done", "dropped"]),
      },
    },
    async ({ slug, status }) => respond(() => initiatives.setStatus(slug, status)),
  );

  server.registerTool(
    "set_initiative_servers",
    {
      description:
        "Replaces the MCP servers the initiative can see, validated against the registry. Returns the already-linked agents that would lose a tool with the new list.",
      inputSchema: {
        slug: z.string(),
        names: z.array(z.string()),
      },
    },
    async ({ slug, names }) => respond(() => initiatives.setServers(slug, names)),
  );

  server.registerTool(
    "link_agent_to_initiative",
    {
      description:
        'Links an agent to an initiative, or unlinks it with slug null. Refuses to link when the agent\'s latest version uses a tool or "requiresServers" outside the initiative\'s servers.',
      inputSchema: {
        agentId: z.string(),
        slug: z.string().nullable(),
      },
    },
    async ({ agentId, slug }) =>
      respond(async () => {
        await initiatives.linkAgent(agentId, slug);
        return { agentId, slug };
      }),
  );

  server.registerTool(
    "set_initiative_workspace",
    {
      description: "Replaces the workspaces (repo, worktree, branch) of an initiative.",
      inputSchema: {
        slug: z.string(),
        workspaces: z.array(
          z.object({
            repoPath: z.string().describe("absolute path to an existing directory"),
            worktreePath: z.string().nullable().optional(),
            branch: z.string().nullable().optional(),
            label: z.string().nullable().optional(),
          }),
        ),
      },
    },
    async ({ slug, workspaces }) =>
      respond(async () => {
        await initiatives.setWorkspaces(slug, workspaces);
        return { slug, count: workspaces.length };
      }),
  );

  server.registerTool(
    "add_initiative_link",
    {
      description: "Adds a link (doc, board, repo or other) to an initiative.",
      inputSchema: {
        slug: z.string(),
        kind: z.enum(["doc", "board", "repo", "other"]),
        url: z.string(),
        label: z.string().optional(),
      },
    },
    async ({ slug, kind, url, label }) =>
      respond(async () => {
        await initiatives.addLink(slug, { kind, url, label });
        return { slug, kind, url, label: label ?? null };
      }),
  );

  server.registerTool(
    "upsert_prompt",
    {
      description:
        "Records a prompt as a new immutable version. A second call with the same body does not open a new version.",
      inputSchema: {
        name: z.string(),
        body: z.string(),
        note: z.string().optional(),
      },
    },
    async ({ name, body, note }) => respond(() => prompts.upsert(name, body, note)),
  );

  server.registerTool(
    "propose_context_update",
    {
      description:
        'Proposes a change to context.md through the approval queue. Creates nothing but a pending decision: it never writes to the file. "replace" requires baseHash (from read_initiative_context); "append" does not accept one.',
      inputSchema: {
        slug: z.string(),
        mode: z.enum(["replace", "append"]),
        content: z.string(),
        baseHash: z.string().optional(),
      },
    },
    async ({ slug, mode, content, baseHash }) =>
      respond(() => initiatives.proposeContextUpdate({ slug, mode, content, baseHash, origin: "mcp" })),
  );
}

async function getInitiative(initiatives: InitiativeService, slug: string) {
  const initiative = await initiatives.get(slug);
  if (!initiative) throw new Error(`iniciativa "${slug}" nao cadastrada`);

  const [servers, workspaces, links, agents] = await Promise.all([
    db
      .select({ serverName: schema.initiativeMcpServers.serverName })
      .from(schema.initiativeMcpServers)
      .where(eq(schema.initiativeMcpServers.initiativeId, initiative.id)),
    db
      .select()
      .from(schema.initiativeWorkspaces)
      .where(eq(schema.initiativeWorkspaces.initiativeId, initiative.id)),
    db.select().from(schema.initiativeLinks).where(eq(schema.initiativeLinks.initiativeId, initiative.id)),
    db
      .select({ id: schema.agents.id, name: schema.agents.name })
      .from(schema.agents)
      .where(eq(schema.agents.initiativeId, initiative.id)),
  ]);

  return {
    ...initiative,
    servers: servers.map((s) => s.serverName),
    workspaces,
    links,
    agents,
  };
}

async function readContext(initiatives: InitiativeService, slug: string, file: string) {
  const initiative = await initiatives.get(slug);
  if (!initiative) throw new Error(`iniciativa "${slug}" nao cadastrada`);

  const store = new LocalFolderContextStore(initiative.contextPath);
  const [content, hash] = await Promise.all([store.read(file), store.hash(file)]);
  return { slug, file, content, hash };
}

async function getPrompt(prompts: PromptService, name: string) {
  const prompt = await prompts.get(name);
  if (!prompt) throw new Error(`prompt "${name}" nao cadastrado`);
  return prompt;
}
