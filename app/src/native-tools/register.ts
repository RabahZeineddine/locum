import { mcpService, type McpService } from "../services/mcp-service.js";
import { SERVIDOR_NATIVO } from "./ask.js";
import { decidirRegistro, type AmbienteDoApp } from "./comando-do-locum.js";

/**
 * Cadastra o `locum-ferramentas` apontando para o app instalado.
 *
 * Roda a cada abertura do app. Na primeira vez nasce ligado, porque o comando
 * é o próprio Locum e só lê. Depois, só corrige o comando quando o registro
 * aponta para um binário que sumiu ou que não é o app instalado, ou quando
 * alguém regravou o nome com outro programa; ligado ou desligado fica como a
 * pessoa deixou. Uma cópia do app aberta fora de /Applications não reescreve
 * um registro que funciona (ver `comando-do-locum`).
 */
export async function cadastrarFerramentasNativas(
  ambiente: AmbienteDoApp,
  service: Pick<McpService, "get" | "register" | "setEnabled"> = mcpService,
): Promise<void> {
  const atual = await service.get(SERVIDOR_NATIVO);
  const programa =
    atual !== undefined && atual.config.transport === "stdio" && atual.config.scope === "read" ? (atual.config.command ?? null) : null;
  // Outro programa no lugar do nosso, com outro transporte ou escopo, é
  // regravado: o nome é nosso.
  const decisao = decidirRegistro(ambiente, programa, "--ferramentas");
  if (decisao.acao === "manter") return;
  await service.register({ name: SERVIDOR_NATIVO, transport: "stdio", command: decisao.comando, scope: "read" });
  if (atual === undefined) await service.setEnabled(SERVIDOR_NATIVO, true);
}
