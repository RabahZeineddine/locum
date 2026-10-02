import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executionService } from "../services/execution-service.js";
import { runService } from "../services/run-service.js";
import { respond } from "./respond.js";

/**
 * Ferramentas de execucao do servidor MCP.
 *
 * Disparar e diferente de publicar. O run roda, os achados ficam no banco, e o
 * passo de acao para na fila de aprovacao esperando decisao humana. Nenhuma
 * ferramenta daqui decide por essa fila, conforme o ADR 0002.
 *
 * As duas nao esperam o pipeline terminar por padrao. Uma execucao completa
 * leva minutos e estoura o tempo de espera do cliente; o identificador volta na
 * hora e o andamento sai por `get_run`.
 */
export function registerRunTools(server: McpServer): void {
  server.registerTool(
    "run_agent",
    {
      description:
        "Runs an agent against a pull request or against the synthetic event. Returns the run id; follow progress with get_run.",
      inputSchema: {
        target: z
          .string()
          .describe(
            '"owner/repo#123" for a real target, "sintetico" for the smoke event with a planted defect, or "sintetico-limpo" for the clean diff',
          ),
        agentId: z
          .string()
          .optional()
          .describe("when absent, uses the seed agent; the version is always the latest"),
        wait: z
          .boolean()
          .optional()
          .describe("true holds the response until the run stops, which can take minutes"),
      },
    },
    async ({ target, agentId, wait }) =>
      respond(() => executionService.start({ target, agentId, wait: wait ?? false })),
  );

  server.registerTool(
    "rerun_step",
    {
      description:
        "Resets a step and every step that depends on it, then runs the run again from there. The cost of the reset steps leaves the total.",
      inputSchema: {
        runId: z.string(),
        stepKey: z.string().describe("step key in the spec, as shown by get_run"),
        wait: z.boolean().optional().describe("true holds the response until the run stops"),
      },
    },
    async ({ runId, stepKey, wait }) =>
      respond(async () => ({
        runId,
        stepKey,
        status: await runService.rerunStep(runId, stepKey, { wait: wait ?? false }),
      })),
  );
}
