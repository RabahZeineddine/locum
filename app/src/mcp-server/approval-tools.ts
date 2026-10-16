import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { approvalService } from "../services/approval-service.js";
import { redactSecrets } from "./redact.js";
import { respond } from "./respond.js";

/**
 * A fila de aprovação, só para ler.
 *
 * Quem decide a fila é uma pessoa, pela bandeja ou pela linha de comando:
 * aprovar publica em nome dela, e é por isso que `approvals.decide` fica fora
 * (ADR 0002). O texto do payload é livre e pode trazer um token colado num
 * comentário, então passa pela mesma redação das outras leituras.
 */
export function registerApprovalTools(server: McpServer): void {
  server.registerTool(
    "list_pending_approvals",
    {
      description:
        "The approval queue: what is waiting for a person to approve or reject, with the exact payload that would be published, the run, the step and the agent. Read only; deciding is done by a person in the app. Credentials in the text are hidden.",
      inputSchema: {},
    },
    async () => respond(async () => redactSecrets(await approvalService.listPending())),
  );

  server.registerTool(
    "get_approval",
    {
      description:
        "One approval of the queue, pending or already decided, with its payload. Read only. Credentials in the text are hidden.",
      inputSchema: { approvalId: z.string().min(1) },
    },
    async ({ approvalId }) =>
      respond(async () => {
        const aprovacao = await approvalService.get(approvalId);
        if (aprovacao === undefined) throw new Error(`aprovacao ${approvalId} nao encontrada`);
        return redactSecrets(aprovacao);
      }),
  );
}
