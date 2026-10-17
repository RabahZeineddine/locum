// O renderer também importa este arquivo: nada de Node aqui.

/** Uma conversa do Teams no formato opaco do destino fixo: `chat/<id>` ou `canal/<equipe>/<canal>`. */
export type ConversaDoTeams = { tipo: "chat"; chatId: string } | { tipo: "canal"; teamId: string; channelId: string };

export function refDoTeams(c: ConversaDoTeams): string {
  return c.tipo === "chat" ? `chat/${c.chatId}` : `canal/${c.teamId}/${c.channelId}`;
}

/** Lê o `ref`; estoura quando não é um chat ou canal do Teams bem formado. */
export function lerRefDoTeams(ref: string): ConversaDoTeams {
  const partes = ref.split("/");
  if (partes[0] === "chat" && partes.length === 2 && partes[1] !== "") return { tipo: "chat", chatId: partes[1]! };
  if (partes[0] === "canal" && partes.length === 3 && partes[1] !== "" && partes[2] !== "") {
    return { tipo: "canal", teamId: partes[1]!, channelId: partes[2]! };
  }
  throw new Error(`"${ref}" não é um chat nem um canal do Teams`);
}
