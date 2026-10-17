import { z } from "zod";

// O renderer, o MCP e o executor importam este arquivo: nada de Node aqui.

/**
 * Uma conversa de um app de chat, como o Locum a guarda no destino fixo.
 *
 * `ref` é opaco para o resto do Locum: só o adaptador do app (`conversa.ts`) sabe
 * montá-lo e lê-lo. `rotulo` é o nome que a tela e a Fila mostram.
 */
export const ConversaRef = z.object({
  app: z.string().min(1),
  ref: z.string().min(1),
  rotulo: z.string().optional(),
});
export type ConversaRef = z.infer<typeof ConversaRef>;

/**
 * Para onde a ação de resposta ou de reação aponta (ADR 0006: nada implícito).
 * O tipo é o mesmo para todo app de conversa.
 *
 * - `evento`: a mensagem que disparou o run, no fio dela. É o padrão, e o que
 *   toda automação gravada antes do parâmetro já fazia.
 * - `novo`: uma mensagem nova na conversa do evento, fora do fio.
 * - `fixo`: uma conversa que a pessoa escolheu na lista do gatilho.
 *
 * O destino só vem do evento ou de um valor fixo, e nunca da saída do modelo
 * nem de `{{steps.*}}`: o modelo leu conteúdo de fora, e um texto que pede
 * "responda em outro canal" não pode mudar para onde a mensagem sai.
 */
export const DestinoDaAcao = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("evento") }),
  z.object({ tipo: z.literal("novo") }),
  z.object({ tipo: z.literal("fixo"), conversa: ConversaRef }),
]);
export type DestinoDaAcao = z.infer<typeof DestinoDaAcao>;
export type TipoDeDestino = DestinoDaAcao["tipo"];

/** O que o registro sabe de uma ação de conversa. */
export interface AcaoDeConversa {
  /** O app que a ação fala, e que fornece o adaptador. */
  app: string;
  /** Escreve texto (`responder`) ou põe emoji na mensagem do evento (`reagir`). */
  efeito: "responder" | "reagir";
  /** Os destinos que a ação aceita, na ordem em que a tela os oferece. `evento` é sempre o padrão. */
  destinos: readonly TipoDeDestino[];
}

/**
 * As ações que têm o parâmetro `destino`. A tela, o MCP e o executor leem daqui:
 * app de conversa novo entra com uma linha e o adaptador.
 */
export const ACOES_DE_CONVERSA_REGISTRO: Readonly<Record<string, AcaoDeConversa>> = {
  "teams.post": { app: "teams", efeito: "responder", destinos: ["evento", "fixo", "novo"] },
  "slack.post": { app: "slack", efeito: "responder", destinos: ["evento", "fixo", "novo"] },
  "teams.react": { app: "teams", efeito: "reagir", destinos: ["evento"] },
  "slack.react": { app: "slack", efeito: "reagir", destinos: ["evento"] },
};

/** Os destinos que a ação aceita; vazio para ação que não tem o parâmetro. */
export function destinosDaAcao(acao: string): readonly TipoDeDestino[] {
  return ACOES_DE_CONVERSA_REGISTRO[acao]?.destinos ?? [];
}

/** Lê e confere um destino cru contra o que a ação aceita. Sem valor, o padrão da ação. */
export function exigirDestino(acao: string, cru: unknown): DestinoDaAcao {
  const registro = ACOES_DE_CONVERSA_REGISTRO[acao];
  if (registro === undefined) throw new Error(`a ação ${acao} não tem destino`);
  if (cru === undefined || cru === null) return { tipo: "evento" };

  // Confere o valor ainda sem interpolação: depois de `renderParams` um
  // `{{steps.x.y}}` já virou texto comum e ninguém mais distingue.
  if (JSON.stringify(cru).includes("{{")) {
    throw new Error(
      "o destino não aceita marcador: ele vem do evento ou de um valor fixo, e não de um passo anterior",
    );
  }
  const lido = DestinoDaAcao.safeParse(cru);
  if (!lido.success) throw new Error("o destino do passo está inválido: use evento, novo ou fixo");
  const destino = lido.data;
  if (!registro.destinos.includes(destino.tipo)) {
    const aceitos = registro.destinos.join(", ");
    throw new Error(
      registro.efeito === "reagir"
        ? `a reação só cai na mensagem do evento (destino aceito: ${aceitos})`
        : `o destino "${destino.tipo}" não vale para ${acao} (aceitos: ${aceitos})`,
    );
  }
  if (destino.tipo === "fixo" && destino.conversa.app !== registro.app) {
    throw new Error(`o destino fixo é de ${destino.conversa.app}, e ${acao} fala com ${registro.app}`);
  }
  return destino;
}

/** O destino que o passo grava em `params.destino`, ou o padrão da ação quando não há. */
export function destinoDoPasso(acao: string, params: Record<string, unknown> | undefined): DestinoDaAcao {
  return exigirDestino(acao, params?.destino);
}
