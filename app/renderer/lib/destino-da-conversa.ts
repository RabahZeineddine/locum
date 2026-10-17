import { destinoDoPasso, REGISTRO_DE_CONVERSA, type DestinoDaAcao, type OpcaoDeConversa, type RegistroDeConversa } from "../../src/acao/destino";

export type { OpcaoDeConversa } from "../../src/acao/destino";

/** A conversa escolhida na lista, no formato que o passo grava: com a conta por onde a lista saiu, se houver. */
export function conversaEscolhida(app: string, o: OpcaoDeConversa | null): { app: string; ref: string; rotulo: string; conta?: string } {
  return { app, ref: o?.ref ?? "", rotulo: o?.rotulo ?? "", ...(o?.conta === undefined ? {} : { conta: o.conta }) };
}

/** As opções de cada lista do app, na ordem em que o registro as declara. */
export function opcoesDoApp(app: string, dados: Readonly<Record<string, readonly unknown[]>>, registro: RegistroDeConversa = REGISTRO_DE_CONVERSA): OpcaoDeConversa[] {
  return (registro.apps[app]?.listas ?? []).flatMap((l) => l.opcoes(dados[l.id] ?? []));
}

/** O destino do passo como a tela o mostra: o gravado, ou o padrão (evento) quando o passo é antigo. */
export function destinoDoNo(acao: string, params: Record<string, unknown> | undefined): DestinoDaAcao {
  try {
    return destinoDoPasso(acao, params);
  } catch {
    // Destino fixo ainda sem conversa escolhida: o campo continua em "fixo" até a pessoa escolher.
    const cru = params?.destino as { tipo?: unknown; conversa?: { app?: unknown; ref?: unknown; rotulo?: unknown } } | undefined;
    if (cru?.tipo === "fixo") {
      return { tipo: "fixo", conversa: { app: String(cru.conversa?.app ?? ""), ref: String(cru.conversa?.ref ?? ""), rotulo: String(cru.conversa?.rotulo ?? "") } };
    }
    return { tipo: "evento" };
  }
}

/** `params` com o destino trocado; o padrão (evento) sai do passo, como num passo antigo. */
export function paramsComDestino(params: Record<string, unknown> | undefined, destino: DestinoDaAcao): Record<string, unknown> {
  const { destino: _antigo, ...resto } = params ?? {};
  return destino.tipo === "evento" ? resto : { ...resto, destino };
}

/** Se algum dos gatilhos entrega uma mensagem do app da ação (manual e cron não entregam). */
export function gatilhoTrazMensagem(acao: string, kinds: readonly string[], registro: RegistroDeConversa = REGISTRO_DE_CONVERSA): boolean {
  const app = registro.acoes[acao]?.app;
  const doApp = app === undefined ? [] : (registro.apps[app]?.gatilhos ?? []);
  return kinds.some((k) => doApp.includes(k));
}
