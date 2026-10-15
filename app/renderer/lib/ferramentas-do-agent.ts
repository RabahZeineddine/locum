export type Area = "teams" | "mail" | "calendar" | "files" | "other";

/** A ordem em que as áreas aparecem. */
export const AREAS: readonly Area[] = ["teams", "mail", "calendar", "files", "other"];

/** Servidor com mais ferramentas que isto ganha grupos por área. */
export const LIMITE_PARA_AGRUPAR = 30;

const PALAVRAS: readonly [Area, readonly string[]][] = [
  ["teams", ["chat", "chats", "channel", "channels", "team", "teams"]],
  ["mail", ["mail", "mails", "email", "emails"]],
  ["calendar", ["calendar", "calendars", "event", "events", "meeting", "meetings"]],
  ["files", ["drive", "drives", "file", "files", "sharepoint"]],
];

/** A área pelas palavras do nome (`list-chats`, `getCalendarEvent`); o que não casa é "other". */
export function areaDaFerramenta(nome: string): Area {
  const palavras = nome
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  for (const [area, lista] of PALAVRAS) if (palavras.some((p) => lista.includes(p))) return area;
  return "other";
}

/** Nome ou descrição contém o termo, sem diferenciar maiúscula. Termo vazio deixa tudo. */
export function filtrarFerramentas<T extends { name: string; description?: string }>(lista: readonly T[], termo: string): T[] {
  const t = termo.trim().toLowerCase();
  if (t === "") return [...lista];
  return lista.filter((f) => f.name.toLowerCase().includes(t) || (f.description ?? "").toLowerCase().includes(t));
}

/** Os grupos não vazios, na ordem de `AREAS`. Servidor pequeno vem num grupo só, sem área. */
export function agruparPorArea<T extends { name: string }>(lista: readonly T[], total = lista.length): { area: Area | null; itens: T[] }[] {
  if (total <= LIMITE_PARA_AGRUPAR) return lista.length === 0 ? [] : [{ area: null, itens: [...lista] }];
  return AREAS.map((area) => ({ area, itens: lista.filter((f) => areaDaFerramenta(f.name) === area) })).filter((g) => g.itens.length > 0);
}
