import type { TFunction } from "i18next";
import type { FonteDaSkill } from "../../src/skills/loader.js";

/** O nome curto da origem, como a tela mostra. */
export function rotuloDaFonte(fonte: FonteDaSkill, t: TFunction): string {
  if (fonte.tipo === "plugin") return fonte.versao === "" ? fonte.plugin : t("skills.group.plugin", { plugin: fonte.plugin, version: fonte.versao });
  return t(`skills.group.${fonte.tipo}`);
}

/** A ordem dos grupos: minhas, plugins, projeto, Locum. */
const ORDEM: Record<FonteDaSkill["tipo"], number> = { minhas: 0, plugin: 1, projeto: 2, locum: 3 };

export function chaveDoGrupo(fonte: FonteDaSkill): string {
  return fonte.tipo === "plugin" ? `plugin:${fonte.plugin}:${fonte.versao}` : fonte.tipo;
}

/** Agrupa por origem na ordem da tela; dentro de plugin, por nome e versão. */
export function agruparPorFonte<T extends { fonte: FonteDaSkill }>(lista: readonly T[]): { chave: string; fonte: FonteDaSkill; itens: T[] }[] {
  const grupos = new Map<string, { chave: string; fonte: FonteDaSkill; itens: T[] }>();
  for (const item of lista) {
    const chave = chaveDoGrupo(item.fonte);
    const grupo = grupos.get(chave) ?? { chave, fonte: item.fonte, itens: [] };
    grupo.itens.push(item);
    grupos.set(chave, grupo);
  }
  return [...grupos.values()].sort(
    (a, b) => ORDEM[a.fonte.tipo] - ORDEM[b.fonte.tipo] || a.chave.localeCompare(b.chave),
  );
}
