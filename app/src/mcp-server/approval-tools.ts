import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { approvalService } from "../services/approval-service.js";
import type { Ambiente } from "./ambiente.js";
import { def } from "./tool-def.js";

/**
 * A fila de aprovação, inteira: ler, editar o que vai sair, propor tarefa e
 * decidir. Quem decide é a gate do executor, a mesma da tela, e a confirmação
 * de cada clique é do cliente MCP, pela anotação `destructiveHint`.
 */
export function registerApprovalTools(server: McpServer, amb: Ambiente): void {
  def(server, "list_pending_approvals", "read",
    "The approval queue: what waits for a decision, with the exact payload that would be published, the run, the step and the agent. Credentials in the text are hidden.",
    {}, () => approvalService.listPending());

  def(server, "list_stuck_approvals", "read",
    "Approvals that began to publish and did not finish (the app stopped midway). The message may or may not have gone out: check the destination, then settle_stuck_approval.",
    {}, () => approvalService.listStuck());

  def(server, "get_approval", "read",
    "One approval of the queue, pending or already decided, with its payload. Credentials in the text are hidden.",
    { approvalId: z.string().min(1) },
    async ({ approvalId }) => {
      const aprovacao = await approvalService.get(approvalId);
      if (aprovacao === undefined) throw new Error(`aprovacao ${approvalId} nao encontrada`);
      return aprovacao;
    });

  def(server, "edit_approval_findings", "write",
    "Edits the findings, verdict and summary of a pending code review approval before it goes out. Does not publish: the approval keeps waiting for decide_approval. The target (repository, pull request) stays as the executor recorded.",
    {
      approvalId: z.string().min(1),
      findings: z.array(z.record(z.string(), z.unknown())).describe("the whole list of findings, as get_approval shows them"),
      verdict: z.string().optional().describe("APPROVE, REQUEST_CHANGES or COMMENT"),
      summary: z.string().optional(),
    },
    ({ approvalId, findings, verdict, summary }) => approvalService.updateFindings(approvalId, findings, verdict, summary));

  def(server, "edit_approval_text", "write",
    "Edits the text of a pending Slack or Teams reply approval before it goes out. Does not publish: the approval keeps waiting for decide_approval.",
    { approvalId: z.string().min(1), text: z.string() },
    ({ approvalId, text }) => approvalService.updateText(approvalId, text));

  def(server, "propose_tracker_issue", "write",
    "Creates, from a code review approval, a new pending approval to open a task in a registered tracker (Jira, Shortcut, GitHub Issues). Nothing is created in the tracker until that approval is decided.",
    { approvalId: z.string().min(1), trackerId: z.string().min(1) },
    ({ approvalId, trackerId }) => approvalService.createTrackerIssueProposal(approvalId, trackerId));

  def(server, "decide_approval", "publish",
    "Decides an approval of the queue. approved PUBLISHES IN YOUR NAME what the approval holds: a GitHub review comment, a Slack or Teams message, a task in the tracker, or a call to an external server. rejected publishes nothing. Irreversible once published.",
    { approvalId: z.string().min(1), decision: z.enum(["approved", "rejected"]) },
    async ({ approvalId, decision }) => ({ approvalId, decision, status: (await amb.decidir(approvalId, decision)).status }));

  def(server, "settle_stuck_approval", "danger",
    "Closes an approval that got stuck while publishing, after you checked the destination: published means it did go out and the run continues; retry sends it back to the queue (where approving publishes again).",
    { approvalId: z.string().min(1), outcome: z.enum(["published", "retry"]) },
    async ({ approvalId, outcome }) => ({ approvalId, status: (await amb.resolverEstancada(approvalId, outcome)).status }));
}
