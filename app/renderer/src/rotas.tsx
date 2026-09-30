import { Bot, Inbox as InboxIcon, ListTree, Settings, Sun, Target } from "lucide-react";
import type { ComponentType } from "react";
import { Agents } from "./telas/agents";
import { Configuracao } from "./telas/configuracao";
import { Execucoes } from "./telas/execucoes";
import { Hoje } from "./telas/hoje";
import { Inbox } from "./telas/inbox";
import { Initiatives } from "./telas/initiatives";

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
  { id: "hoje", rotulo: "nav.today", icone: Sun, Tela: Hoje },
  { id: "inbox", rotulo: "nav.queue", icone: InboxIcon, Tela: Inbox },
  { id: "initiatives", rotulo: "nav.initiatives", icone: Target, Tela: Initiatives },
  { id: "execucoes", rotulo: "nav.runs", icone: ListTree, Tela: Execucoes },
  { id: "agents", rotulo: "nav.agents", icone: Bot, Tela: Agents },
  { id: "configuracao", rotulo: "nav.settings", icone: Settings, Tela: Configuracao },
] as const satisfies readonly {
  id: string;
  rotulo: string;
  icone: ComponentType<{ className?: string }>;
  Tela: ComponentType<TelaProps>;
}[];

export type RotaId = (typeof ROTAS)[number]["id"];

/**
 * O padrao com hash vazio. Ao abrir o Locum, a pergunta e o que ha para hoje:
 * a fila responde so o que espera decisao, e a Hoje junta isso ao que vai rodar
 * e ao que ja terminou.
 */
export const ROTA_PADRAO: RotaId = "hoje";

/**
 * Identificadores soltos, para o roteador. Const de modulo de proposito: a
 * lista entra numa dependencia de efeito e montar outra a cada render trocaria
 * o ouvinte de `hashchange` a toa.
 */
export const ROTA_IDS: readonly RotaId[] = ROTAS.map((rota) => rota.id);
