export interface ChatListado {
  chatId: string;
  label: string;
  chatType: "oneOnOne" | "group";
}

/** Os chats filtrados pela busca no rótulo, com os marcados no topo e o resto em ordem alfabética. */
export function organizarChats(lista: readonly ChatListado[], marcados: ReadonlySet<string>, termo: string): ChatListado[] {
  const t = termo.trim().toLowerCase();
  const achados = t === "" ? lista : lista.filter((c) => c.label.toLowerCase().includes(t));
  const marcado = (c: ChatListado): number => (marcados.has(c.chatId) ? 0 : 1);
  return [...achados].sort((a, b) => marcado(a) - marcado(b) || a.label.localeCompare(b.label));
}
