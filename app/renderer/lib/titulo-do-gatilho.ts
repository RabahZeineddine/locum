import type { TFunction } from "i18next";
import type { TriggerConfig } from "../../src/config/types";

/**
 * O nome do gatilho vem do que está configurado. "Menção ou DM no Teams" é o
 * nome do modo padrão, e um gatilho que só acorda por link de PR não pode
 * levá-lo: a pessoa lia o nó e achava que a automação respondia a menção.
 */

/** As letras dos modos ligados, na ordem do nome: menção, DM, link de PR. */
function modos(config: { mentions: boolean; dms: boolean; prLinks?: boolean }): string {
  return `${config.mentions ? "m" : ""}${config.dms ? "d" : ""}${config.prLinks === true ? "p" : ""}` || "none";
}

export function tituloDoGatilho(t: TFunction, config: TriggerConfig): string {
  if (config.kind === "teams-inbox" || config.kind === "slack-inbox") {
    return t(`automations.triggers.${config.kind}.titles.${modos(config)}`);
  }
  return t(`automations.triggers.${config.kind}.title`);
}

type Teams = Extract<TriggerConfig, { kind: "teams-inbox" }>;

/**
 * Onde o gatilho do Teams olha: o primeiro canal ou chat com o nome, e o
 * resto contado. Sem rótulo gravado conta em vez de mostrar o identificador
 * do Graph. Vazio vale para todas as conversas.
 */
export function escopoDoTeams(t: TFunction, config: Teams): string {
  const itens = [
    ...config.channels.map((c) => ({ tipo: "canal" as const, rotulo: c.label })),
    ...config.chats.map((c) => ({ tipo: "chat" as const, rotulo: c.label })),
  ];
  if (itens.length === 0) return t("automations.triggers.teams-inbox.scope.all");
  const contar = (lista: typeof itens): string[] => {
    const canais = lista.filter((i) => i.tipo === "canal").length;
    const chats = lista.length - canais;
    return [
      ...(canais > 0 ? [t("automations.triggers.teams-inbox.scope.channels", { count: canais })] : []),
      ...(chats > 0 ? [t("automations.triggers.teams-inbox.scope.chats", { count: chats })] : []),
    ];
  };
  const [primeiro, ...resto] = itens;
  const nome = primeiro?.rotulo?.trim();
  if (nome === undefined || nome === "") return contar(itens).join(" + ");
  return [nome, ...contar(resto)].join(" + ");
}

/** O escopo do gatilho que tem um; vazio para o que não tem. */
export function escopoDoGatilho(t: TFunction, config: TriggerConfig): string {
  return config.kind === "teams-inbox" ? escopoDoTeams(t, config) : "";
}

/**
 * "Link de PR no Teams · Integrados - Devs + 1 chat": nome e resumo numa linha
 * só. O resumo é o escopo, a não ser que quem chama traga outro.
 */
export function linhaDoGatilho(t: TFunction, config: TriggerConfig, resumo: string = escopoDoGatilho(t, config)): string {
  return [tituloDoGatilho(t, config), resumo].filter((parte) => parte !== "").join(" · ");
}
