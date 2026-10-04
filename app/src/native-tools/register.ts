import { mcpService, type McpService } from "../services/mcp-service.js";
import { SERVIDOR_NATIVO } from "./ask.js";

/**
 * Cadastra o `locum-ferramentas` apontando para este binário.
 *
 * Roda a cada abertura do app. Na primeira vez nasce ligado, porque o comando
 * é o próprio Locum e só lê. Depois, só corrige o comando quando o app mudou
 * de lugar, ou quando alguém regravou o nome com outro programa; ligado ou
 * desligado fica como a pessoa deixou.
 */
export async function cadastrarFerramentasNativas(
  comando: string[],
  service: Pick<McpService, "get" | "register" | "setEnabled"> = mcpService,
): Promise<void> {
  const atual = await service.get(SERVIDOR_NATIVO);
  const igual =
    atual !== undefined &&
    atual.config.transport === "stdio" &&
    JSON.stringify(atual.config.command ?? null) === JSON.stringify(comando) &&
    atual.config.scope === "read";
  if (igual) return;
  await service.register({ name: SERVIDOR_NATIVO, transport: "stdio", command: comando, scope: "read" });
  if (atual === undefined) await service.setEnabled(SERVIDOR_NATIVO, true);
}
