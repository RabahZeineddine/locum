import { Blocks, Bot, Inbox as InboxIcon, ListTree, Settings, Sun, Target, TerminalSquare, Workflow } from "lucide-react";
import type { ComponentType } from "react";
import type { Antigos } from "@/lib/router";
import { Agents } from "./telas/agents";
import { Apps } from "./telas/apps";
import { Automacoes } from "./telas/automacoes";
import { Biblioteca } from "./telas/biblioteca";
import { Configuracao } from "./telas/configuracao";
import { Execucoes } from "./telas/execucoes";
import { Hoje } from "./telas/hoje";
import { Inbox } from "./telas/inbox";
import { Initiatives } from "./telas/initiatives";
import { Sessoes } from "./telas/sessoes";

/**
 * O que uma tela recebe do layout.
 *
 * O detalhe sai do roteador do layout, e nao de um `useRota` dentro de cada
 * tela: o ouvinte de `hashchange` e um so e a tela recebe o que ele leu. Dois
 * ouvintes discordariam por um quadro na troca de destino.
 */
export interface TelaProps {
  /** O que veio depois do destino no hash, ou nulo. */
  detalhe: string | null;
  navegar: (id: RotaId, detalhe?: string) => void;
}

/**
 * Os destinos da janela, na ordem em que aparecem na barra lateral.
 *
 * A lista e escrita a mao, e e a unica fonte tanto da barra quanto do hash:
 * destino novo se acrescenta aqui e aparece nos dois lugares, sem chance de a
 * barra oferecer rota que nao existe nem de existir rota que a barra esconde.
 *
 * O destino carrega a chave do dicionário, e não o título já escrito: a barra e
 * o cabeçalho leem a mesma chave, então a troca de idioma muda os dois de uma
 * vez e nenhum dos dois guarda uma cópia do texto.
 */
export const ROTAS = [
  // COCKPIT
  { id: "today", rotulo: "nav.today", icone: Sun, Tela: Hoje, secao: "cockpit" },
  { id: "inbox", rotulo: "nav.queue", icone: InboxIcon, Tela: Inbox, secao: "cockpit" },

  // OPERAÇÕES & ENGENHARIA
  { id: "automations", rotulo: "nav.automations", icone: Workflow, Tela: Automacoes, secao: "operacoes" },
  { id: "runs", rotulo: "nav.runs", icone: ListTree, Tela: Execucoes, secao: "operacoes" },
  { id: "sessions", rotulo: "nav.sessions", icone: TerminalSquare, Tela: Sessoes, secao: "operacoes" },

  // RECURSOS & CONTEXTO
  { id: "library", rotulo: "nav.library", icone: Bot, Tela: Biblioteca, secao: "recursos" },
  { id: "initiatives", rotulo: "nav.initiatives", icone: Target, Tela: Initiatives, secao: "recursos" },
  { id: "apps", rotulo: "nav.apps", icone: Blocks, Tela: Apps, secao: "recursos" },
  { id: "settings", rotulo: "nav.settings", icone: Settings, Tela: Configuracao, secao: "recursos" },

  // FORA DA BARRA
  { id: "agents", rotulo: "nav.agents", icone: ListTree, Tela: Agents, naBarra: false, secao: "operacoes" },
] as const satisfies readonly {
  id: string;
  rotulo: string;
  icone: ComponentType<{ className?: string }>;
  Tela: ComponentType<TelaProps>;
  naBarra?: boolean;
  secao: "cockpit" | "operacoes" | "recursos";
}[];

/** Os destinos que aparecem na barra lateral, na ordem dela. */
export const ROTAS_DA_BARRA = ROTAS.filter((rota) => !("naBarra" in rota) || rota.naBarra !== false);

export type RotaId = (typeof ROTAS)[number]["id"];

/**
 * O padrao com hash vazio. Ao abrir o Locum, a pergunta e o que ha para hoje:
 * a fila responde so o que espera decisao, e a Hoje junta isso ao que vai rodar
 * e ao que ja terminou.
 */
export const ROTA_PADRAO: RotaId = "today";

/**
 * Identificadores soltos, para o roteador. Const de modulo de proposito: a
 * lista entra numa dependencia de efeito e montar outra a cada render trocaria
 * o ouvinte de `hashchange` a toa.
 */
export const ROTA_IDS: readonly RotaId[] = ROTAS.map((rota) => rota.id);

/**
 * Os nomes em português que os destinos tiveram até a 0.1.19. A seção da
 * Configuração vem antes do destino sozinho, porque o primeiro prefixo que
 * casa é o que vale.
 */
export const ROTAS_ANTIGAS: Antigos = [
  ["configuracao/geral", "settings/general"],
  ["configuracao/modelos", "settings/models"],
  // Conexões saíram da Configuração e viraram Apps na 0.1.39.
  ["configuracao/conexoes", "apps"],
  ["settings/connections", "apps"],
  ["configuracao", "settings"],
  ["execucoes", "runs"],
  ["sessoes", "sessions"],
  ["hoje", "today"],
];
