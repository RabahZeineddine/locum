import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { approvalService } from "../services/approval-service.js";
import type { Ambiente } from "./ambiente.js";
import { exigirImpressao, impressaoDe } from "../approval/impressao.js";
import { def } from "./tool-def.js";

/** O que o hash da aprovação cobre: o que vai sair e o estado dela. */
const impressaoDaAprovacao = (a: { kind: string; payload: unknown; status: string }): string => impressaoDe({ kind: a.kind, payload: a.payload, status: a.status });

/**
 * Review proposta sem o commit avaliado (o evento não trouxe o `headSha`): sai
 * sem `commit_id` e pode valer para código novo. Fica à vista, e não só dentro do payload.
 */
const semCommitAvaliado = (a: { payload: unknown }): { semCommitAvaliado: boolean } => ({
  semCommitAvaliado: (a.payload as { semCommitAvaliado?: unknown } | null)?.semCommitAvaliado === true,
});

/**
 * A fila de aprovação, inteira: ler, editar o que vai sair, propor tarefa e
 * decidir. Quem decide é a gate do executor, a mesma da tela, e a confirmação
 * de cada clique é do cliente MCP, pela anotação `destructiveHint`.
 */
export function registerApprovalTools(server: McpServer, amb: Ambiente): void {
  def(server, "list_pending_approvals", "read",
    "The approval queue: what waits for a decision, with the exact payload that would be published (semCommitAvaliado is true when a review has no evaluated commit and goes out without pinning it), the run, the step and the agent, and the hash decide_approval asks for. Credentials of the keychain and literal header values are hidden; the text comes as is.",
    {}, async () => (await approvalService.listPending()).map((a) => ({ ...a, ...semCommitAvaliado(a), hash: impressaoDaAprovacao(a) })));

  def(server, "list_stuck_approvals", "read",
    "Approvals that began to publish and did not finish (the app stopped midway). The message may or may not have gone out: check the destination, then settle_stuck_approval.",
    {}, () => approvalService.listStuck());

  def(server, "get_approval", "read",
    "One approval of the queue, pending or already decided, with its payload and the hash decide_approval asks for. Credentials of the keychain and literal header values are hidden; the text comes as is.",
    { approvalId: z.string().min(1) },
    async ({ approvalId }) => {
      const aprovacao = await approvalService.get(approvalId);
      if (aprovacao === undefined) throw new Error(`aprovacao ${approvalId} nao encontrada`);
      return { ...aprovacao, ...semCommitAvaliado(aprovacao), hash: impressaoDaAprovacao(aprovacao) };
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

  def(server, "decide_approval", "publish",
    "Decides an approval of the queue. approved PUBLISHES IN YOUR NAME what the approval holds: a GitHub review comment, a Slack or Teams message, a task in the tracker, or a call to an external server. rejected publishes nothing. Irreversible once published. hash is the one get_approval or list_pending_approvals showed: if the approval changed since (an edit of the text or of the findings), nothing is decided, so the confirmation is tied to the content that was seen.",
    { approvalId: z.string().min(1), decision: z.enum(["approved", "rejected"]), hash: z.string().min(1).describe("the hash of the approval as get_approval showed it") },
    async ({ approvalId, decision, hash }) => {
      const atual = await approvalService.get(approvalId);
      if (atual === undefined) throw new Error(`aprovacao ${approvalId} nao encontrada`);
      exigirImpressao(hash, impressaoDaAprovacao(atual), "a aprovação");
      return { approvalId, decision, status: (await amb.decidir(approvalId, decision)).status };
    });

  def(server, "settle_stuck_approval", "danger",
    "Closes an approval that got stuck while publishing, after you checked the destination: published means it did go out and the run continues; retry sends it back to the queue (where approving publishes again).",
    { approvalId: z.string().min(1), outcome: z.enum(["published", "retry"]) },
    async ({ approvalId, outcome }) => ({ approvalId, status: (await amb.resolverEstancada(approvalId, outcome)).status }));
}
