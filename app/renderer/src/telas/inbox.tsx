import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { decidir } from "@/lib/aprovar";
import { read, useRead, type ReadResult } from "@/lib/bridge";
import { rotuloDeSeveridade, SEVERIDADES, type Severidade } from "@/lib/rotulos";
import { cn } from "@/lib/utils";
import { AlertTriangle, Check, ChevronRight, Inbox as InboxIcon, Pencil, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { TelaProps } from "../rotas";
import { Revisao } from "./revisao";

type Pendencia = ReadResult<"approvals.listPending">[number];
type Execucao = ReadResult<"runs.list">[number];
type Achado = ReadResult<"runs.findings">[number];

/**
 * Palavra junto da cor, sempre. Cor sozinha nao chega para quem nao distingue
 * vermelho de verde, e tambem nao chega para quem esta de relance.
 */
/**
 * A severidade é uma régua na borda esquerda do registro, de altura inteira,
 * como a aba de uma pasta num arquivo.
 *
 * É o único lugar da tela onde há ousadia visual. Bolinha colorida se perde
 * quando a lista cresce, e obriga o olho a procurar; a régua dá a leitura da
 * pilha inteira de relance, ainda de longe.
 */
const REGUA: Record<Severidade, string> = {
  critical: "bg-sev-critical",
  high: "bg-sev-high",
  medium: "bg-sev-medium",
  low: "bg-sev-low",
};

const TINTA: Record<Severidade, string> = {
  critical: "text-sev-critical",
  high: "text-sev-high",
  medium: "text-sev-medium",
  low: "text-muted-foreground",
};

function pior(achados: Achado[]): Severidade {
  for (const s of SEVERIDADES) {
    if (achados.some((a) => a.severity === s)) return s;
  }
  return "low";
}

/** Idade em palavra, porque timestamp exige conta mental. */
function idade(t: TFunction, segundos: number): { texto: string; velho: boolean } {
  const h = Math.floor((Date.now() / 1000 - segundos) / 3600);
  if (h < 1) return { texto: t("inbox.age.now"), velho: false };
  if (h < 24) return { texto: t("inbox.age.hours", { hours: h }), velho: false };
  const d = Math.floor(h / 24);
  return { texto: t("inbox.age.days", { days: d }), velho: d >= 2 };
}

interface Item {
  pendencia: Pendencia;
  achados: Achado[];
  severidade: Severidade;
  /** A iniciativa, para contexto; o repositório, para pull request. */
  grupo: string;
}

/**
 * Onde o item mora na fila.
 *
 * Cinco propostas da mesma iniciativa espalhadas entre pull requests viram
 * cinco linhas soltas que parecem iguais; juntas, elas se leem como uma pauta.
 */
function grupoDaPendencia(p: Pendencia): string {
  if (p.kind === "context.update") return `contexto:${(p.payload as { slug?: string } | null)?.slug ?? ""}`;
  const c = p.payload as Partial<CargaDePr> | null;
  if (c?.pull) return `pr:${c.owner ? `${c.owner}/` : ""}${c.repo ?? ""}`;
  return "outros";
}

function rotuloDoGrupo(t: TFunction, grupo: string): string {
  if (grupo.startsWith("contexto:")) return grupo.slice("contexto:".length);
  if (grupo.startsWith("pr:")) return `${t("inbox.group.reviews")} · ${grupo.slice("pr:".length)}`;
  return t("inbox.group.other");
}

/**
 * A fila, ou o que vai sair de um item dela.
 *
 * O botão Editar levava ao detalhe da execução, que é rastro de auditoria e não
 * edita nada: prometia uma coisa e entregava outra. Agora ele abre a revisão do
 * que vai ser publicado, e a auditoria continua a um link de distância.
 */
export function Inbox(props: TelaProps) {
  if (props.detalhe) return <Revisao {...props} />;
  return <Fila {...props} />;
}

function Fila({ navegar }: TelaProps) {
  const { t } = useTranslation();
  const pendentes = useRead("approvals.listPending");
  const execucoes = useRead("runs.list", { status: "failed", limit: 20 });
  const [itens, setItens] = useState<Item[] | null>(null);
  const [aberto, setAberto] = useState<string | null>(null);
  const [foco, setFoco] = useState(0);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [conflitos, setConflitos] = useState<Set<string>>(new Set());
  const listaRef = useRef<HTMLUListElement>(null);
  const [alvo, setAlvo] = useState<string | null>(null);

  // Os achados vivem no run, nao na pendencia. Carregados aqui para que a linha
  // fechada ja diga o suficiente para decidir, que e o ponto da tela.
  useEffect(() => {
    if (pendentes.status !== "ready") return;
    let cancelado = false;
    void (async () => {
      // Uma ida só para a fila inteira: pedir por pendência fazia a tela
      // esperar tantas viagens à ponte quantas linhas houvesse.
      const porRun = await read(
        "runs.findingsByRun",
        [...new Set(pendentes.data.map((p) => p.runId))],
      ).catch(() => ({}) as Record<string, Achado[]>);
      const carregados = pendentes.data.map((p) => {
        const achados = porRun[p.runId] ?? [];
        return { pendencia: p, achados, severidade: pior(achados), grupo: grupoDaPendencia(p) };
      });
      if (!cancelado) setItens(ordenar(carregados));
    })();
    return () => {
      cancelado = true;
    };
  }, [pendentes.status, pendentes.status === "ready" ? pendentes.data : null]);

  // O alvo vindo do clique na notificacao abre direto o item daquele run.
  useEffect(() => {
    void read("window.inboxTarget").then(setAlvo).catch(() => setAlvo(null));
  }, []);

  useEffect(() => {
    if (!alvo || !itens) return;
    const i = itens.findIndex((x) => x.pendencia.runId === alvo);
    if (i >= 0) {
      setFoco(i);
      setAberto(itens[i]!.pendencia.id);
    }
  }, [alvo, itens]);

  const resolver = useCallback(
    async (item: Item, decisao: "approved" | "rejected") => {
      setOcupado(item.pendencia.id);
      try {
        const resultado = await decidir(item.pendencia.id, decisao);
        if (resultado.status === "conflict") {
          // O alvo mudou por fora antes do clique: a pendencia ja fechou como
          // `conflict`, e o item continua na tela so para explicar o que
          // aconteceu, sem mais botao de decisao. O motivo completo, com
          // diff quando fizer sentido, mora na revisao.
          setConflitos((atual) => new Set(atual).add(item.pendencia.id));
        } else {
          setItens((atual) => atual?.filter((x) => x.pendencia.id !== item.pendencia.id) ?? null);
        }
      } finally {
        setOcupado(null);
      }
    },
    [],
  );

  // Teclado antes do mouse: a fila e trabalho repetitivo, e tirar a mao do
  // teclado a cada item e o que faz uma inbox parecer longa.
  useEffect(() => {
    const lista = itens ?? [];
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const alvo = e.target as HTMLElement | null;
      if (alvo && ["INPUT", "TEXTAREA"].includes(alvo.tagName)) return;
      const item = lista[foco];

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setFoco((f) => Math.min(f + 1, Math.max(lista.length - 1, 0)));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setFoco((f) => Math.max(f - 1, 0));
      } else if (e.key === "Enter" && item) {
        e.preventDefault();
        setAberto((a) => (a === item.pendencia.id ? null : item.pendencia.id));
      } else if (e.key === "a" && item) {
        e.preventDefault();
        void resolver(item, "approved");
      } else if (e.key === "x" && item) {
        e.preventDefault();
        void resolver(item, "rejected");
      } else if (e.key === "e" && item) {
        e.preventDefault();
        navegar("inbox", item.pendencia.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [itens, foco, resolver, navegar]);

  useEffect(() => {
    listaRef.current
      ?.querySelectorAll("li[data-item]")
      [foco]?.scrollIntoView({ block: "nearest" });
  }, [foco]);

  const falhas = execucoes.status === "ready" ? execucoes.data : [];

  if (itens === null) return <Esqueleto />;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      <PainelDeIniciativas navegar={navegar} />
      <Cabecalho quantidade={itens.length} />
      {falhas.length > 0 && <FaixaDeFalha quantidade={falhas.length} navegar={navegar} />}

      {itens.length === 0 ? (
        <Vazio />
      ) : (
        <ul
          className="divide-border border-border bg-card divide-y overflow-hidden rounded-lg border"
          ref={listaRef}
        >
          {itens.map((item, i) => (
            <Fragment key={item.pendencia.id}>
              {(i === 0 || itens[i - 1]!.grupo !== item.grupo) && (
                <li className="bg-muted/40 text-muted-foreground px-5 py-1.5 font-mono text-xs">
                  {rotuloDoGrupo(t, item.grupo)}
                </li>
              )}
              <Linha
                item={item}
                focada={i === foco}
                aberta={aberto === item.pendencia.id}
                ocupada={ocupado === item.pendencia.id}
                emConflito={conflitos.has(item.pendencia.id)}
                aoFocar={() => setFoco(i)}
                aoAlternar={() =>
                  setAberto((a) => (a === item.pendencia.id ? null : item.pendencia.id))
                }
                aoAprovar={() => void resolver(item, "approved")}
                aoDescartar={() => void resolver(item, "rejected")}
                aoEditar={() => navegar("inbox", item.pendencia.id)}
              />
            </Fragment>
          ))}
        </ul>
      )}

      <Atalhos />
    </div>
  );
}

/**
 * Ordem: quem espera ha mais tempo sobe, e a severidade decide o empate.
 *
 * O contrario, severidade pura, deixa achado medio apodrecendo no fim da fila
 * para sempre. A severidade pesa no visual, que e onde ela precisa pesar.
 *
 * Depois, os grupos: cada um sobe pelo seu item mais antigo, e dentro dele a
 * ordem acima continua valendo.
 */
function ordenar(itens: Item[]): Item[] {
  const peso = (s: Severidade) => SEVERIDADES.indexOf(s);
  const porIdade = [...itens].sort((a, b) => {
    const idadeA = a.pendencia.createdAt;
    const idadeB = b.pendencia.createdAt;
    if (Math.abs(idadeA - idadeB) > 3600) return idadeA - idadeB;
    return peso(a.severidade) - peso(b.severidade);
  });
  const primeiro = new Map<string, number>();
  porIdade.forEach((item, i) => {
    if (!primeiro.has(item.grupo)) primeiro.set(item.grupo, i);
  });
  return porIdade
    .map((item, i) => ({ item, i }))
    .sort((a, b) => primeiro.get(a.item.grupo)! - primeiro.get(b.item.grupo)! || a.i - b.i)
    .map(({ item }) => item);
}

/**
 * O painel das iniciativas, acima da fila.
 *
 * Não bloqueia a fila: sem dado ainda, ou com erro, ele some. A fila é o que
 * importa nesta tela, e uma iniciativa que não carregou não pode travar a
 * aprovação de nada.
 */
function PainelDeIniciativas({ navegar }: { navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  const iniciativas = useRead("initiatives.overview");

  if (iniciativas.status !== "ready" || iniciativas.data.length === 0) return null;

  return (
    <div className="border-border bg-card flex flex-wrap gap-2 rounded-lg border p-2">
      {iniciativas.data.map((f) => (
        <button
          key={f.slug}
          type="button"
          onClick={() => navegar("initiatives", f.slug)}
          className="border-border/60 hover:bg-accent/40 focus-visible:ring-ring flex min-h-8 cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1 text-left text-xs transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none"
        >
          <span className="font-medium">{f.title}</span>
          <span className="text-muted-foreground">{t(`initiatives.status.${f.status}`)}</span>
          {f.stale && (
            <Badge className="text-sev-medium border-sev-medium/40" variant="outline">
              {t("home.overview.stale")}
            </Badge>
          )}
          <span className="text-muted-foreground">
            {t("home.overview.daysSinceUpdate", { count: f.daysSinceUpdate })}
          </span>
        </button>
      ))}
    </div>
  );
}

function Cabecalho({ quantidade }: { quantidade: number }) {
  const { t } = useTranslation();

  return (
    <div className="flex items-baseline justify-between">
      <h1 className="text-lg font-semibold tracking-tight">{t("inbox.title")}</h1>
      {/*
        O marcador existe para o smoke, que confere o texto contra o dicionario
        nos dois idiomas: atributo com a contagem provaria que o estado chegou,
        e nao que a frase trocou de idioma.
      */}
      <p
        className="text-muted-foreground text-sm tabular-nums"
        data-locum-probe="inbox"
        data-pendencias={quantidade}
      >
        {t("inbox.waiting", { count: quantidade })}
      </p>
    </div>
  );
}

/**
 * Execucao que falhou nao e decisao, e atencao. Misturar as duas na mesma lista
 * apaga a pergunta que a tela faz, que e "o que eu decido agora".
 */
function FaixaDeFalha({
  quantidade,
  navegar,
}: {
  quantidade: number;
  navegar: TelaProps["navegar"];
}) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      onClick={() => navegar("execucoes")}
      className="border-border/60 bg-muted/40 hover:bg-muted focus-visible:ring-ring flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-left text-sm transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none"
    >
      <AlertTriangle className="size-4 shrink-0 text-amber-500" aria-hidden />
      <span className="text-muted-foreground">{t("inbox.failures", { count: quantidade })}</span>
      <ChevronRight className="text-muted-foreground ml-auto size-4" aria-hidden />
    </button>
  );
}

interface LinhaProps {
  item: Item;
  focada: boolean;
  aberta: boolean;
  ocupada: boolean;
  emConflito: boolean;
  aoFocar: () => void;
  aoAlternar: () => void;
  aoAprovar: () => void;
  aoDescartar: () => void;
  aoEditar: () => void;
}

function Linha({
  item,
  focada,
  aberta,
  ocupada,
  emConflito,
  aoFocar,
  aoAlternar,
  aoAprovar,
  aoDescartar,
  aoEditar,
}: LinhaProps) {
  const { t } = useTranslation();
  const { pendencia, achados, severidade } = item;
  const { texto: quando, velho } = idade(t, pendencia.createdAt);
  const principal = achados[0];
  const alvo = alvoDaPendencia(pendencia, t);

  return (
    <li
      data-item
      className={cn(
        "group relative transition-colors duration-200",
        focada && "bg-accent/40",
        ocupada && "opacity-50",
      )}
      onMouseEnter={aoFocar}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-0 bottom-0 left-0 w-[3px]",
          alvo.semSeveridade ? "bg-border" : REGUA[severidade],
        )}
      />

      <div className="py-3 pr-4 pl-5">
        <div className="flex items-baseline gap-2.5">
          <span className="shrink-0 font-mono text-[13px] font-medium">{alvo.principal}</span>
          {alvo.detalhe && (
            <span className="text-muted-foreground truncate font-mono text-xs">{alvo.detalhe}</span>
          )}
          {alvo.repo && (
            <span className="text-muted-foreground truncate font-mono text-xs">{alvo.repo}</span>
          )}
          {alvo.rascunho && (
            <span className="text-muted-foreground border-border shrink-0 rounded border px-1 text-[10px]">
              {t("inbox.draft")}
            </span>
          )}
          <span
            className={cn(
              "text-muted-foreground ml-auto shrink-0 font-mono text-xs tabular-nums",
              velho && "text-sev-medium",
            )}
          >
            {quando}
          </span>
        </div>

        {alvo.titulo && (
          <p className="mt-0.5 max-w-[68ch] truncate text-[15px] font-medium tracking-tight">
            {alvo.titulo}
          </p>
        )}

        <div className="text-muted-foreground mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
          {alvo.autor && <span>{alvo.autor}</span>}
          {alvo.ramos && <span className="font-mono">{alvo.ramos}</span>}
          {alvo.tamanho && <span className="font-mono tabular-nums">{alvo.tamanho}</span>}
        </div>

        {alvo.resumo && (
          <p className="text-muted-foreground mt-1 line-clamp-2 max-w-[68ch] text-sm leading-relaxed">
            {alvo.resumo}
          </p>
        )}

        {alvo.origem && <p className="text-muted-foreground/80 mt-1 text-xs">{alvo.origem}</p>}

        {!alvo.semSeveridade && (
          <div className="mt-1.5 flex items-baseline gap-2 text-sm">
            <span className={cn("shrink-0 font-medium", TINTA[severidade])}>
              {rotuloDeSeveridade(t, severidade)}
            </span>
            {achados.length > 0 && (
              <span className="text-muted-foreground shrink-0">
                {t("inbox.findings", { count: achados.length })}
              </span>
            )}
          </div>
        )}

        {principal && (
          <p className="text-muted-foreground mt-1.5 line-clamp-2 max-w-[68ch] text-sm leading-relaxed">
            {principal.problem}
          </p>
        )}

        {emConflito && (
          <p className="border-sev-medium/40 bg-sev-medium/10 text-sev-medium mt-1.5 max-w-[68ch] rounded border px-2 py-1 text-xs">
            {t("inbox.conflict")}
          </p>
        )}

        <div className="mt-2.5 flex items-center gap-1">
          {!emConflito && (
            <Button className="h-7 cursor-pointer px-2.5" disabled={ocupada} onClick={aoAprovar} size="sm">
              {t("inbox.approve")}
            </Button>
          )}
          <Button
            className="text-muted-foreground hover:text-foreground h-7 cursor-pointer px-2.5"
            disabled={ocupada}
            onClick={aoEditar}
            size="sm"
            variant="ghost"
          >
            {alvo.somenteLeitura ? t("inbox.review") : t("inbox.edit")}
          </Button>
          {!emConflito && (
            <Button
              className="text-muted-foreground hover:text-foreground h-7 cursor-pointer px-2.5"
              disabled={ocupada}
              onClick={aoDescartar}
              size="sm"
              variant="ghost"
            >
              {t("inbox.discard")}
            </Button>
          )}
          {achados.length > 1 && (
            <button
              aria-expanded={aberta}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring ml-auto cursor-pointer rounded px-2 py-1 text-xs transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none"
              onClick={aoAlternar}
              type="button"
            >
              {aberta ? t("inbox.collapse") : t("inbox.expand", { count: achados.length })}
            </button>
          )}
        </div>
      </div>

      {aberta && achados.length > 0 && (
        <ul className="border-border bg-background/40 border-t">
          {achados.map((a, i) => (
            <li className="flex gap-3 py-2 pr-4 pl-5 text-sm" key={i}>
              <span
                aria-hidden
                className={cn(
                  "mt-[7px] h-[3px] w-3 shrink-0 rounded-full",
                  REGUA[(a.severity as Severidade) ?? "low"],
                )}
              />
              <div className="min-w-0 max-w-[68ch]">
                <span className="text-muted-foreground font-mono text-xs">
                  {a.file ?? ""}
                  {a.line ? `:${a.line}` : ""}
                </span>
                <p className="mt-0.5 leading-relaxed">{a.problem}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * O que a linha nomeia.
 *
 * Em duas partes, e não numa string juntada por ponto do meio: o número do
 * pull request carrega o peso, o repositório fica em monoespaçada apagada. A
 * junção por ponto empilha tudo no mesmo tom e obriga a ler a linha inteira
 * para achar o que importa.
 */
interface Alvo {
  principal: string;
  /** Ao lado do principal, apagado: o modo e o tamanho de uma proposta de contexto. */
  detalhe?: string;
  /** O começo do que vai entrar, para decidir sem abrir. */
  resumo?: string;
  origem?: string;
  /** Proposta de contexto não tem achado, e "Baixa" ali seria invenção. */
  semSeveridade?: boolean;
  /** A revisão só mostra o diff: o botão diz "Revisar" e não promete edição. */
  somenteLeitura?: boolean;
  repo?: string;
  titulo?: string;
  autor?: string;
  ramos?: string;
  tamanho?: string;
  rascunho?: boolean;
}

function alvoDaPendencia(p: Pendencia, t: TFunction): Alvo {
  if (p.kind === "context.update") {
    const carga = p.payload as Partial<CargaDeContexto> | null;
    const linhas = (carga?.content ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const titulo = linhas.find((l) => l.startsWith("#"))?.replace(/^#+\s*/, "") ?? linhas[0];
    const corpo = linhas.filter((l) => !l.startsWith("#") && l !== titulo).join(" ");
    return {
      principal: t("inbox.context_update.kind"),
      detalhe: carga?.mode
        ? t(`inbox.context_update.mode.${carga.mode}`, { count: linhas.length })
        : undefined,
      titulo: titulo ?? t("inbox.context_update.untitled"),
      resumo: corpo.length > 0 ? corpo : undefined,
      origem: origemDaProposta(t, carga?.origin),
      semSeveridade: true,
      somenteLeitura: true,
    };
  }

  const c = p.payload as Partial<CargaDePr> | null;
  if (!c?.pull) {
    return { principal: t("inbox.target_unknown", { agent: p.agentName, step: p.stepName }) };
  }

  return {
    principal: `PR #${c.pull}`,
    repo: `${c.owner ? `${c.owner}/` : ""}${c.repo ?? ""}`,
    titulo: c.title,
    autor: c.author ? t("inbox.by", { author: c.author }) : undefined,
    ramos:
      c.headBranch && c.baseBranch
        ? t("inbox.branch", { head: c.headBranch, base: c.baseBranch })
        : undefined,
    tamanho:
      c.fileCount === undefined
        ? undefined
        : t("inbox.diff", {
            files: c.fileCount,
            additions: c.additions ?? 0,
            deletions: c.deletions ?? 0,
          }),
    rascunho: c.draft,
  };
}

/** O que `context.update` guarda na pendencia. Ver `src/context/proposal.ts`. */
interface CargaDeContexto {
  slug: string;
  mode: "append" | "replace";
  content: string;
  origin: string;
}

function origemDaProposta(t: TFunction, origem: string | undefined): string | undefined {
  if (!origem) return undefined;
  if (origem === "mcp" || origem === "chat") return t(`inbox.context_update.origin.${origem}`);
  return t("inbox.context_update.origin.other", { origin: origem });
}

interface CargaDePr {
  owner: string;
  repo: string;
  pull: number;
  title: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  additions: number;
  deletions: number;
  fileCount: number;
  draft: boolean;
}

/**
 * Vazio confirma que o sistema rodou, e nao que ele parou. Sem isso, fila vazia
 * e fila quebrada sao a mesma tela.
 */
function Vazio() {
  const { t } = useTranslation();

  return (
    <div className="border-border/60 flex flex-col items-center gap-2 rounded-md border border-dashed px-6 py-14 text-center">
      <InboxIcon className="text-muted-foreground/60 size-6" aria-hidden />
      <p className="text-sm font-medium">{t("inbox.empty.title")}</p>
      <p className="text-muted-foreground max-w-sm text-sm">{t("inbox.empty.body")}</p>
    </div>
  );
}

function Atalhos() {
  const { t } = useTranslation();
  // A tecla e a mesma em qualquer idioma: ela e o que se aperta, e nao o que se
  // le. So a acao ao lado passa pelo dicionario.
  const teclas: [string, string][] = [
    ["j / k", t("inbox.shortcuts.move")],
    ["enter", t("inbox.shortcuts.open")],
    ["a", t("inbox.shortcuts.approve")],
    ["e", `${t("inbox.shortcuts.review")} / ${t("inbox.shortcuts.edit")}`],
    ["x", t("inbox.shortcuts.discard")],
  ];
  return (
    <p className="text-muted-foreground/70 mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {teclas.map(([k, o]) => (
        <span key={k}>
          <kbd className="bg-muted rounded px-1 py-0.5 font-mono text-[10px]">{k}</kbd> {o}
        </span>
      ))}
    </p>
  );
}

function Esqueleto() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="border-border/60 bg-card h-24 animate-pulse rounded-md border" />
      ))}
    </div>
  );
}
