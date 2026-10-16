import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { claudeSessionsService } from "../services/claude-sessions-service.js";
import { sessionService, TERMINALS } from "../services/session-service.js";
import type { Ambiente } from "./ambiente.js";
import { def } from "./tool-def.js";

/** Os aplicativos de terminal; o embutido (`locum`) só existe com a janela do app aberta neste processo. */
const TERMINAL_DE_FORA = z.enum(["terminal", "iterm", "warp"]);

/**
 * As sessões: as do Claude Code e do opencode desta máquina (a tela do que
 * ficou pela metade) e as de iniciativa, que o Locum abre com o contexto dela.
 * O terminal embutido fica de fora: ele vive na janela do app, e o `--mcp` é
 * outro processo.
 */
export function registerSessionTools(server: McpServer, amb: Ambiente): void {
  def(server, "list_claude_sessions", "read",
    "The Claude Code and opencode sessions of this machine (from ~/.claude and opencode): title, folder, branch, state, last activity, uncommitted files and whether a process still holds it. includeText true also brings the last prompt and the last reply, which can carry anything that was typed there; off by default.",
    { includeText: z.boolean().optional() },
    async ({ includeText }) => {
      const sessoes = await amb.sessions();
      return includeText === true ? sessoes : sessoes.map(({ lastPrompt: _p, lastReply: _r, ...resto }) => resto);
    });

  def(server, "mark_claude_session_done", "write",
    "Marks a session as done, like the screen. The mark drops by itself if the conversation moves again.",
    { id: z.string().min(1), lastActivityAt: z.number().int().optional().describe("seconds; when absent, the one list_claude_sessions shows") },
    async ({ id, lastActivityAt }) => {
      const momento = lastActivityAt ?? (await amb.sessions()).find((s) => s.id === id)?.lastActivityAt;
      if (momento === undefined) throw new Error(`sessão ${id} não encontrada`);
      await claudeSessionsService.markDone(id, momento);
      return { id, done: true };
    });

  def(server, "reopen_claude_session", "write",
    "Takes the done mark off a session.",
    { id: z.string().min(1) },
    async ({ id }) => {
      await claudeSessionsService.reopen(id);
      return { id, done: false };
    });

  def(server, "resume_claude_session", "external",
    "Opens a terminal application on this machine running `claude --resume` (or `opencode --session`) in the folder of the session, which then works with the permissions that tool has. A session still held by a process is refused.",
    { id: z.string().min(1), initiative: z.string().optional(), terminal: TERMINAL_DE_FORA.optional().describe("when absent, the preferred terminal") },
    ({ id, initiative, terminal }) => claudeSessionsService.resume(id, initiative, terminal));

  def(server, "open_initiative_session", "external",
    "Opens a Claude session with the context of an initiative in a terminal application on this machine, in the folder of the chosen workspace. The session writes its handoff at the end; read it with read_session_handoff.",
    { slug: z.string().min(1), workspaceId: z.string().optional(), terminal: TERMINAL_DE_FORA.optional().describe("when absent, the preferred terminal") },
    ({ slug, workspaceId, terminal }) =>
      sessionService.open(slug, { ...(workspaceId === undefined ? {} : { workspaceId }), ...(terminal === undefined ? {} : { terminal }) }));

  def(server, "list_initiative_sessions", "read",
    "The sessions opened for an initiative, with state and whether each left a handoff.",
    { slug: z.string().min(1) }, ({ slug }) => sessionService.list(slug));

  def(server, "read_session_handoff", "write",
    "Reads the handoff a session of the initiative left and creates the pending context update from it; context.md only changes when that approval is decided. null when no session left one.",
    { slug: z.string().min(1), sessionId: z.string().optional() },
    ({ slug, sessionId }) => sessionService.readHandoff(slug, sessionId));

  def(server, "close_initiative_session", "write",
    "Marks an initiative session as ended in Locum. The terminal is not touched.",
    { sessionId: z.string().min(1) }, async ({ sessionId }) => ({ closed: await sessionService.close(sessionId) }));

  def(server, "get_session_terminal", "read",
    "The preferred terminal for sessions and the ones installed on this machine.",
    {}, async () => ({ terminal: await sessionService.terminal(), installed: await sessionService.installedTerminals() }));

  def(server, "set_session_terminal", "write",
    "Sets the preferred terminal for sessions. locum is the terminal embedded in the app window.",
    { terminal: z.enum(TERMINALS) }, async ({ terminal }) => ({ terminal: await sessionService.setTerminal(terminal) }));
}
