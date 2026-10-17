import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executionService } from "../services/execution-service.js";
import { passoAvulsoService } from "../services/passo-avulso-service.js";
import { runService } from "../services/run-service.js";
import { respond } from "./respond.js";
import { def } from "./tool-def.js";

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
  def(server, "list_findings_by_run", "read",
    "Findings of several runs in one call, by run id, as the inbox reads them.",
    { runIds: z.array(z.string().min(1)).min(1).max(200) },
    ({ runIds }) => runService.findingsByRun(runIds));

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
          .describe("may be left out only when exactly one agent is registered; the version is always the latest"),
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
        instruction: z
          .string()
          .optional()
          .describe(
            "extra instruction for a model step, appended after its prompt (it comes from the person, not from outside data). Refused for steps that are not model steps. With it, every downstream action in auto waits in the queue as approve in this re-run; see preview_rerun",
          ),
        instructionLabel: z
          .string()
          .optional()
          .describe("text that heads the instruction block in the prompt; the default says it came from whoever re-ran the step"),
      },
    },
    async ({ runId, stepKey, wait, instruction, instructionLabel }) =>
      respond(async () => ({
        runId,
        stepKey,
        status: await runService.rerunStep(runId, stepKey, {
          wait: wait ?? false,
          ...(instruction === undefined ? {} : { instrucao: instruction }),
          ...(instructionLabel === undefined ? {} : { rotuloDaInstrucao: instructionLabel }),
        }),
      })),
  );

  def(server, "preview_rerun", "read",
    "What rerun_step would do, before confirming: the steps that run again and, when withInstruction is true, the downstream actions in auto that go to the queue as approve because of the instruction. Writes nothing.",
    {
      runId: z.string().min(1),
      stepKey: z.string().min(1).describe("step key in the spec, as shown by get_run"),
      withInstruction: z.boolean().optional().describe("true previews a re-run with an instruction (refused for steps that are not model steps)"),
    },
    ({ runId, stepKey, withInstruction }) => runService.rerunPreview(runId, stepKey, { comInstrucao: withInstruction ?? false }));

  def(server, "propose_run_action", "write",
    "Proposes a new action on a run that already ran (a standalone step). It only creates a pending approval in the queue; a person approves it there, and nothing is published here. The content must follow the inputSchema that describe_steps gives for the action kind (only kinds with an inputSchema are accepted). The target (repository, pull request, conversation) always comes from the run's event and cannot be set in the content. Refused while the run is queued or running, for an archived automation and for a dry run. Approving it runs only this step and does not resume the run.",
    {
      runId: z.string().min(1),
      kind: z.string().min(1).describe("action kind, as listed by describe_steps"),
      content: z.record(z.string(), z.unknown()).describe("the action content, validated by the inputSchema of the kind"),
      derivedFrom: z.string().optional().describe("key of the flow step this action derives from; re-running that step expires the pending approval"),
    },
    ({ runId, kind, content, derivedFrom }) =>
      passoAvulsoService.proporAcao(runId, { kind, conteudo: content, ...(derivedFrom === undefined ? {} : { derivaDe: derivedFrom }) }));
}
