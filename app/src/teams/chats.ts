import { eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { abrirTeams, type TeamsGraphOptions } from "./graph.js";

/** Um chat que a pessoa pode observar, com o rótulo que a tela mostra. */
export interface TeamsChatOption {
  chatId: string;
  /** Tópico do chat ou nomes dos outros membros. */
  label: string;
  chatType: "oneOnOne" | "group";
}

/** Páginas de `/me/chats` lidas, de cinquenta em cinquenta. */
const PAGINAS = 4;

export interface ListTeamsChatsOptions extends TeamsGraphOptions {
  /** O gatilho que vai ler: a lista sai pela conta que ele gravou, como a varredura. */
  triggerId?: string;
  db?: typeof defaultDb;
}

/**
 * O rótulo do chat: o tópico, quando tem, e senão os nomes dos membros sem a
 * própria pessoa. Chat sem nome nenhum cai no identificador.
 */
export function rotuloDoChat(chat: Record<string, unknown>, eu: string): string {
  const topico = typeof chat.topic === "string" ? chat.topic.trim() : "";
  if (topico !== "") return topico;
  const membros = Array.isArray(chat.members) ? (chat.members as Record<string, unknown>[]) : [];
  const nomes = membros
    .filter((m) => m.userId !== eu && typeof m.displayName === "string" && m.displayName !== "")
    .map((m) => String(m.displayName));
  return nomes.length > 0 ? nomes.join(", ") : String(chat.id);
}

/**
 * Os chats diretos e em grupo da pessoa. Reunião fica de fora porque o gatilho
 * só olha conversa direta e em grupo. Só leitura de nome, para a tela montar a
 * escolha.
 */
export async function listTeamsChats(options: ListTeamsChatsOptions = {}): Promise<TeamsChatOption[]> {
  const { triggerId, db = defaultDb, ...graph } = options;
  const guardada =
    triggerId === undefined || graph.account !== undefined
      ? null
      : ((
          await db
            .select({ value: schema.settings.value })
            .from(schema.settings)
            .where(eq(schema.settings.key, `teams.account.inbox:${triggerId}`))
        )[0]?.value ?? null);
  const teams = await abrirTeams(guardada === null ? graph : { ...graph, account: guardada });
  try {
    const eu = (await teams.get("/me?$select=id,userPrincipalName")).id;
    const opcoes: TeamsChatOption[] = [];
    let proxima: string | null = "/me/chats?$expand=members&$top=50";
    for (let pagina = 0; pagina < PAGINAS && proxima !== null; pagina++) {
      const corpo: Record<string, unknown> = await teams.get(proxima);
      for (const item of Array.isArray(corpo.value) ? (corpo.value as Record<string, unknown>[]) : []) {
        if (typeof item.id !== "string") continue;
        if (item.chatType !== "oneOnOne" && item.chatType !== "group") continue;
        opcoes.push({ chatId: item.id, label: rotuloDoChat(item, String(eu)), chatType: item.chatType });
      }
      proxima = typeof corpo["@odata.nextLink"] === "string" ? corpo["@odata.nextLink"] : null;
    }
    return opcoes.sort((a, b) => a.label.localeCompare(b.label));
  } finally {
    await teams.close();
  }
}
