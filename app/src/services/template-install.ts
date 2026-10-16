import { validarSubstituicoes } from "../config/escolha-de-modelo.js";
import { agentService } from "./agent-service.js";
import { providerService } from "./provider-service.js";
import type { TemplateSource } from "./template-source.js";

/**
 * Instala um template do marketplace pelo id, a partir do que a última
 * listagem mostrou, como o importar de arquivo faria. As substituições trocam o
 * modelo dos passos de IA antes de gravar: índice do passo para `provedor/modelo`,
 * validado contra o catálogo desta máquina. Escolha inválida é erro, e não
 * descarte, senão o agent nasceria com o modelo do template sem aviso.
 */
export async function instalarTemplate(
  fonte: TemplateSource,
  id: string,
  substituicoes?: Record<number, string>,
): Promise<{ agentId: string; version: number; created: boolean }> {
  const bruto = (await fonte.ler(id)) as { steps?: { model?: string }[] };
  if (substituicoes && Object.keys(substituicoes).length > 0) {
    const passos = Array.isArray(bruto.steps) ? bruto.steps : [];
    validarSubstituicoes(passos, substituicoes, await providerService.listAllModels({ assinatura: true }));
    for (const [indice, modelo] of Object.entries(substituicoes)) passos[Number(indice)]!.model = modelo;
  }
  const { version, created } = await agentService.importSpec(JSON.stringify(bruto), `marketplace:${id}`);
  return { agentId: version.agentId, version: version.version, created };
}
