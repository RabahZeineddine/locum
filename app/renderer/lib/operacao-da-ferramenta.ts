/**
 * O que uma ferramenta de servidor MCP faz, lido do nome: o verbo vira
 * ler/escrever/alterar/apagar, o substantivo vira o recurso (mensagem, canal,
 * reação, pull request...), e o título sai das tabelas do i18n. Nada aqui é
 * lista por conexão: ferramenta que não casa vai para "Outras" e mantém o nome
 * humanizado. Sem React, para o editor e os testes usarem o mesmo código.
 */
import type { i18n as Instancia } from "i18next";
import { ehLeitura } from "../../src/config/leitura";
import { humanizar } from "./paleta-conexoes";

export type AcaoDaOperacao = "read" | "write" | "update" | "delete";

export interface OperacaoClassificada {
  acao: AcaoDaOperacao;
  /** O verbo do nome, ou nulo quando o nome não abre nem fecha com um conhecido. */
  verbo: string | null;
  /** Chave do recurso (`message`, `pull_request`...), ou nula quando nenhum casou. */
  recurso: string | null;
}

/** Devolve o texto da chave sob `automations.operations`, ou nada quando ela não existe. */
export type Traduzir = (chave: string, count?: number) => string | undefined;

export function tradutorDe(i18n: Instancia): Traduzir {
  return (chave, count) => {
    const completa = `automations.operations.${chave}`;
    const opcoes = count === undefined ? {} : { count };
    return i18n.exists(completa, opcoes) ? String(i18n.t(completa, opcoes)) : undefined;
  };
}

const VERBOS: Record<string, AcaoDaOperacao> = {};
for (const [acao, verbos] of Object.entries({
  read: "get list read search find fetch query describe show view lookup retrieve download count history replies preview",
  write: "send post create add upload reply write publish push fork draft invite schedule react",
  update: "update set edit modify move rename mark merge resolve close reopen assign pin unpin archive enable disable transition",
  delete: "delete remove trash purge drop clear destroy revoke cancel",
})) {
  for (const v of verbos.split(" ")) VERBOS[v] = acao as AcaoDaOperacao;
}

/** Verbos que pedem o recurso no plural: "Listar mensagens". */
const VERBOS_DE_LISTA = new Set(["list", "search", "history", "replies"]);

const PALAVRAS_SOLTAS = new Set(["to", "in", "from", "the", "of", "by", "for", "and", "or", "a", "an", "on", "with"]);

/** Recursos conhecidos, e o nome pelo qual cada um aparece nas ferramentas. */
const RECURSOS: Record<string, string> = Object.fromEntries(
  (
    "message chat channel conversation=channel reaction thread file folder drive=file issue comment review " +
    "repository repo=repository branch commit user team mail email=mail event calendar page project label workflow " +
    "release document ticket=issue task member=user"
  )
    .split(" ")
    .map((par) => {
      const [nome, recurso] = par.split("=");
      return [nome!, recurso ?? nome!];
    }),
);

/** Dois substantivos que juntos são outro recurso: "mail message" é e-mail, não mensagem. */
const FRASES: Record<string, string> = {
  "pull request": "pull_request",
  "mail message": "mail",
  "mail folder": "mail",
  "chat message": "message",
  "channel message": "message",
  "calendar event": "event",
  "drive item": "file",
};

function palavras(nome: string, servidor: string | undefined): string[] {
  const limpo = nome
    .replace(/^mcp__.+?__/, "")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((p) => p !== "" && !PALAVRAS_SOLTAS.has(p));
  const dono = servidor?.toLowerCase();
  return dono !== undefined && limpo[0] === dono ? limpo.slice(1) : limpo;
}

function singular(p: string): string {
  if (p in RECURSOS) return p;
  return p.endsWith("s") && !p.endsWith("ss") ? p.slice(0, -1) : p;
}

export function classificarOperacao(nome: string, servidor?: string): OperacaoClassificada {
  const todas = palavras(nome, servidor);
  let verbo: string | null = null;
  let resto = todas;
  if (todas[0] !== undefined && todas[0] in VERBOS) {
    verbo = todas[0];
    resto = todas.slice(1);
  } else if (todas.length > 1 && todas[todas.length - 1]! in VERBOS) {
    verbo = todas[todas.length - 1]!;
    resto = todas.slice(0, -1);
  }
  const subs = resto.map(singular);
  let recurso: string | null = null;
  for (let i = subs.length - 1; i >= 0 && recurso === null; i--) {
    const frase = i > 0 ? FRASES[`${subs[i - 1]} ${subs[i]}`] : undefined;
    recurso = frase ?? RECURSOS[subs[i]!] ?? null;
  }
  const acao = verbo !== null ? VERBOS[verbo]! : ehLeitura(nome) ? "read" : "write";
  return { acao, verbo, recurso };
}

/** "Enviar mensagem", "Listar canais", "Reagir"; sem tabela para o nome, o nome humanizado. */
export function tituloDaOperacao(nome: string, traduzir: Traduzir, servidor?: string): string {
  const { acao, verbo, recurso } = classificarOperacao(nome, servidor);
  if (recurso === null) return humanizar(nome);
  const combinado = traduzir(`combo.${acao}_${recurso}`);
  if (combinado !== undefined) return combinado;
  const nomeDoVerbo = (verbo !== null ? traduzir(`verb.${verbo}`) : undefined) ?? traduzir(`action.${acao}`);
  const nomeDoRecurso = traduzir(`resource.${recurso}`, verbo !== null && VERBOS_DE_LISTA.has(verbo) ? 2 : 1);
  if (nomeDoVerbo === undefined || nomeDoRecurso === undefined) return humanizar(nome);
  return `${nomeDoVerbo} ${nomeDoRecurso}`;
}

/** O cabeçalho de um grupo: "Mensagens", ou "Outras" para o que não casou. */
export function tituloDoGrupo(recurso: string | null, traduzir: Traduzir): string {
  const nome = recurso === null ? undefined : traduzir(`resource.${recurso}`, 2);
  if (nome === undefined) return traduzir("group.other") ?? "Other";
  return nome.charAt(0).toUpperCase() + nome.slice(1);
}

/** Os itens por recurso, na ordem em que cada recurso aparece; "Outras" (nulo) sempre por último. */
export function agruparPor<T>(itens: readonly T[], recursoDe: (item: T) => string | null): { recurso: string | null; itens: T[] }[] {
  const grupos = new Map<string | null, T[]>();
  for (const item of itens) {
    const recurso = recursoDe(item);
    grupos.set(recurso, [...(grupos.get(recurso) ?? []), item]);
  }
  const ordem: (string | null)[] = [...grupos.keys()].filter((k) => k !== null);
  if (grupos.has(null)) ordem.push(null);
  return ordem.map((recurso) => ({ recurso, itens: grupos.get(recurso)! }));
}

export function agruparOperacoes<T extends { nome: string }>(itens: readonly T[], servidor?: string) {
  return agruparPor(itens, (i) => classificarOperacao(i.nome, servidor).recurso);
}
