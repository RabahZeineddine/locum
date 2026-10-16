import { ehLeituraDa, escolhaDe, ligadaPorPadrao, type EscolhaDeFerramenta } from "../../src/config/leitura.js";

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

export type TipoDeFerramenta = "leitura" | "escrita";

/** Leitura e escrita, nesta ordem, sem o grupo que ficou vazio. */
export function agruparPorTipo<T>(lista: readonly T[], eLeitura: (f: T) => boolean): { tipo: TipoDeFerramenta; itens: T[] }[] {
  const grupos: { tipo: TipoDeFerramenta; itens: T[] }[] = [
    { tipo: "leitura", itens: lista.filter(eLeitura) },
    { tipo: "escrita", itens: lista.filter((f) => !eLeitura(f)) },
  ];
  return grupos.filter((g) => g.itens.length > 0);
}

export interface ContagemDaConexao {
  total: number;
  ligadas: number;
  /** Ligadas que escrevem. */
  escrita: number;
  /** Ferramentas do servidor que o mapa da conexão não cita: na lista explícita, nascem desligadas. */
  novas: number;
  /** Havia lista guardada de todos os servidores. Sem ela, `total` é 0 e `ligadas` conta só o que está marcado. */
  conhecida: boolean;
}

/** O que o cabeçalho recolhido da conexão diz, a partir da última lista guardada de cada servidor. */
export function contarDaConexao(
  conexao: { tools: Readonly<Record<string, EscolhaDeFerramenta>>; leituraPadrao?: "todas" | "limitada" },
  servidores: readonly { nome: string; ferramentas: readonly { name: string; readOnlyHint?: boolean; destructiveHint?: boolean }[] | null }[],
): ContagemDaConexao {
  const conhecida = servidores.length > 0 && servidores.every((s) => s.ferramentas !== null);
  if (!conhecida) {
    return { total: 0, ligadas: Object.values(conexao.tools).filter((e) => e !== false).length, escrita: 0, novas: 0, conhecida: false };
  }
  const explicita = conexao.leituraPadrao === "limitada" && Object.keys(conexao.tools).length > 0;
  let total = 0;
  let ligadas = 0;
  let escrita = 0;
  let novas = 0;
  for (const { nome, ferramentas } of servidores) {
    for (const f of ferramentas ?? []) {
      const escolha = escolhaDe(conexao.tools, nome, f.name);
      const ligada = escolha === undefined ? ligadaPorPadrao(f, conexao.leituraPadrao) : escolha !== false;
      total += 1;
      if (escolha === undefined && explicita) novas += 1;
      if (!ligada) continue;
      ligadas += 1;
      if (!(ehLeituraDa(f) || escolha === "read")) escrita += 1;
    }
  }
  return { total, ligadas, escrita, novas, conhecida };
}
