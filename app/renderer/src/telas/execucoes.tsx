import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskItemFile,
  TaskTrigger,
} from "@/components/ai-elements/task";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { call, useRead, type ReadResult } from "@/lib/bridge";
import { useJanela } from "@/lib/janela";
import { rotuloDeEstado, rotuloDeSeveridade, rotuloDoMotivo, type Estado } from "@/lib/rotulos";
import { cn } from "@/lib/utils";
import { ArrowLeft, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import type { TFunction } from "i18next";
import { Trans, useTranslation } from "react-i18next";
import { useCurrentInitiative } from "../current-initiative";
import { GrafoDaExecucao } from "../grafo";
import type { TelaProps } from "../rotas";

type Execucao = ReadResult<"runs.list">[number];
type Detalhe = NonNullable<ReadResult<"runs.get">>;
type Passo = Detalhe["steps"][number];

/** Altura de cada linha da lista. Fixa, porque a janela virtual conta com isso. */
const ALTURA_DA_LINHA = 76;

/**
 * A tela de execucoes: a lista, e o detalhe de uma delas.
 *
 * Qual das duas aparece sai do hash, e nao de estado local, porque recarregar
 * a janela no detalhe de um run precisa voltar para o mesmo run. O roteador
 * entrega o identificador em `detalhe`.
 */
export function Execucoes({ detalhe, navegar }: TelaProps) {
  return detalhe === null ? (
    <Lista navegar={navegar} />
  ) : (
    <Execucao navegar={navegar} runId={detalhe} />
  );
}

/* ------------------------------------------------------------------ lista */

function Lista({ navegar }: { navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  const { slug } = useCurrentInitiative();
  // O chip so aparece quando ha iniciativa atual; filtrar a lista por ela e um
  // clique a mais, nunca o padrao, porque quem entra em execucoes sem escolher
  // iniciativa nenhuma espera ver todas.
  const [filtrando, setFiltrando] = useState(false);
  const iniciativas = useRead("initiatives.list");
  const iniciativaAtual = slug === null ? undefined : iniciativas.data?.find((i) => i.slug === slug);
  const aplicarFiltro = filtrando && iniciativaAtual !== undefined;

  // O limite e alto de proposito: a janela virtual abaixo e quem sustenta a
  // lista longa, e pedir de vinte em vinte traria paginacao para uma tela que
  // ninguem pagina, ela rola.
  const runs = useRead(
    "runs.list",
    aplicarFiltro ? { limit: 500, initiativeId: iniciativaAtual.id } : { limit: 500 },
  );
  const linhas = runs.data ?? [];
  const janela = useJanela(linhas.length, ALTURA_DA_LINHA);

  return (
    <div className="flex h-full flex-col items-stretch">
      {iniciativaAtual !== undefined ? (
        <div className="mb-3 flex items-center gap-1.5">
          <button
            aria-pressed={aplicarFiltro}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors",
              aplicarFiltro
                ? "bg-primary text-primary-foreground"
                : "bg-accent text-accent-foreground hover:bg-accent/70",
            )}
            data-aplicado={aplicarFiltro}
            data-locum-probe="execucoes-initiative"
            data-slug={iniciativaAtual.slug}
            onClick={() => setFiltrando((v) => !v)}
            title={t("common.filterByInitiative")}
            type="button"
          >
            {iniciativaAtual.title}
            {aplicarFiltro ? <X className="size-3" /> : null}
          </button>
        </div>
      ) : null}

      <div
        className="mb-3 text-muted-foreground text-xs"
        data-estado={runs.status}
        data-locum-probe="execucoes"
        data-runs={linhas.map((r) => r.id).join(",")}
        data-total={linhas.length}
      >
        {runs.status === "error"
          ? t("runs.refused", { message: runs.error.message })
          : runs.status === "loading"
            ? t("runs.loading")
            : t("runs.count", { count: linhas.length })}
      </div>

      {runs.status === "ready" && linhas.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {/*
            O comando fica dentro da frase traduzida, e nao colado de fora: a
            posicao dele muda com o idioma, e frase partida em dois pedacos
            perde a ordem no primeiro idioma que nao siga a do portugues.
          */}
          <Trans components={{ code: <code /> }} i18nKey="runs.empty" />
        </p>
      ) : (
        <div
          className="border-border bg-card max-h-full min-h-0 overflow-auto rounded-lg border"
          ref={janela.ref}
        >
          {/*
            Os espacadores sustentam a barra de rolagem no tamanho da lista
            inteira enquanto so as linhas visiveis existem no DOM.
          */}
          <div style={{ height: janela.antes }} />
          {linhas.slice(janela.inicio, janela.fim).map((run) => (
            <LinhaDeExecucao key={run.id} navegar={navegar} run={run} />
          ))}
          <div style={{ height: janela.depois }} />
        </div>
      )}
    </div>
  );
}

/**
 * A linha diz sobre o que a execução foi, e não só quando ela aconteceu.
 *
 * Nome do agent com horário obriga a abrir cada uma para saber de que trabalho
 * se trata. O alvo vem do evento; o andamento vem da contagem de passos, que é
 * o que responde se ela terminou, parou esperando você, ou quebrou.
 */
function LinhaDeExecucao({
  navegar,
  run,
}: {
  navegar: TelaProps["navegar"];
  run: Execucao;
}) {
  const { t } = useTranslation();
  const alvo = run.target;

  return (
    <button
      className="hover:bg-accent/40 focus-visible:ring-ring border-border relative w-full cursor-pointer border-b px-4 py-2.5 text-left transition-colors duration-200 last:border-b-0 focus-visible:ring-2 focus-visible:-outline-offset-2"
      data-locum-run={run.id}
      onClick={() => navegar("execucoes", run.id)}
      style={{ height: ALTURA_DA_LINHA }}
      type="button"
    >
      <div className="flex items-baseline gap-2.5">
        {alvo?.pull ? (
          <>
            <span className="shrink-0 font-mono text-[13px] font-medium">{t("common.pull", { number: alvo.pull })}</span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">
              {alvo.title ?? alvo.repo}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">
            {t("runs.no_target")}
          </span>
        )}
        <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
          {quando(t, run.createdAt)}
        </span>
        <span className="w-24 shrink-0 text-right font-mono text-xs tabular-nums">
          {dinheiro(t, run)}
        </span>
      </div>

      <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
        <Estado status={run.status} />
        <span className="font-mono">
          {run.agentId} {t("common.version", { version: run.agentVersion })}
        </span>
        <span className="tabular-nums">
          {t("runs.progress", { done: run.stepDone, total: run.stepTotal })}
        </span>
        {run.stepPending > 0 && (
          <span className="text-sev-medium">{t("runs.waiting_steps", { count: run.stepPending })}</span>
        )}
        {run.stepFailed > 0 && (
          <span className="text-sev-critical">{t("runs.failed_steps", { count: run.stepFailed })}</span>
        )}
        {run.findingCount > 0 && (
          <span>{t("runs.findings", { count: run.findingCount })}</span>
        )}
      </div>
    </button>
  );
}

/* ----------------------------------------------------------------- detalhe */

function Execucao({ navegar, runId }: { navegar: TelaProps["navegar"]; runId: string }) {
  const { t } = useTranslation();
  const run = useRead("runs.get", runId);
  const achados = useRead("runs.findings", runId);

  if (run.status === "error") {
    return <Aviso probe="execucao">{t("runs.refused", { message: run.error.message })}</Aviso>;
  }
  if (run.status === "loading") {
    return <Aviso probe="execucao">{t("runs.detail.loading")}</Aviso>;
  }
  if (run.data === undefined) {
    return <Aviso probe="execucao">{t("runs.detail.missing", { runId })}</Aviso>;
  }

  const detalhe = run.data;
  // O primeiro passo com saida carrega o marcador do bloco de codigo, que e
  // por onde o smoke confere que o destaque do shiki chegou: ele precisa de um
  // alvo estavel, e nao do primeiro `pre` que aparecer na tela.
  const comSaida = detalhe.steps.find((p) => p.output !== null)?.stepKey ?? null;

  return (
    <div
      className="flex flex-col gap-4"
      data-achados={achados.data?.length ?? -1}
      data-chaves={detalhe.steps.map((p) => p.stepKey).join(",")}
      data-locum-probe="execucao"
      data-passos={detalhe.steps.length}
      data-run={detalhe.id}
    >
      <div className="flex items-center gap-3">
        <Button onClick={() => navegar("execucoes")} size="sm" variant="ghost">
          <ArrowLeft className="size-4" />
          {t("runs.title")}
        </Button>
        <Estado status={detalhe.status} />
        <span className="font-medium text-sm">
          {detalhe.agentId}{" "}
          <span className="text-muted-foreground">
            {t("common.version", { version: detalhe.agentVersion })}
          </span>
        </span>
        <span className="text-muted-foreground text-xs">{quando(t, detalhe.createdAt)}</span>
        <span className="ml-auto text-sm tabular-nums">{dinheiro(t, detalhe)}</span>
      </div>

      {detalhe.error !== null ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          {detalhe.error}
        </p>
      ) : null}

      {/*
        O grafo antes da linha do tempo de proposito: ele responde "o que esta
        esperando o que", e a lista abaixo responde "o que aconteceu em cada
        um". Quem abre um run parado quer a primeira pergunta.
      */}
      <GrafoDaExecucao detalhe={detalhe} />

      <ol className="flex flex-col gap-3">
        {detalhe.steps.map((passo) => (
          <li key={passo.id}>
            <PassoDaExecucao
              marcado={passo.stepKey === comSaida}
              passo={passo}
              runId={detalhe.id}
            />
          </li>
        ))}
      </ol>

      <Achados achados={achados.data ?? []} />
    </div>
  );
}

/**
 * Um passo na linha do tempo.
 *
 * O `Reasoning` guarda como o passo foi resolvido, que e a parte que some da
 * tela quando tudo da certo e e a primeira que se procura quando nao da: qual
 * modelo foi pedido, qual rodou, por que trocou, e quais skills entraram.
 */
function PassoDaExecucao({
  marcado,
  passo,
  runId,
}: {
  marcado: boolean;
  passo: Passo;
  runId: string;
}) {
  const { t } = useTranslation();
  const segundos =
    passo.startedAt !== null && passo.endedAt !== null ? passo.endedAt - passo.startedAt : undefined;
  const ferramentas = lista(passo.toolsUsed);
  const skills = lista(passo.skillsUsed).map((s) =>
    typeof s === "object" && s !== null && "name" in s ? String((s as { name: unknown }).name) : String(s),
  );

  return (
    <div className="rounded-lg border border-border px-4 py-3" data-locum-passo={passo.stepKey}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground tabular-nums">{passo.idx + 1}</span>
        <span className="font-medium">{passo.name}</span>
        <Estado status={passo.status} />
        <span className="text-muted-foreground text-xs">
          {passo.modelUsed ?? t("runs.step.action")}
          {passo.substitutionReason !== null ? ` ${t("runs.step.substituted")}` : ""}
        </span>
        <span className="ml-auto flex items-center gap-3 text-muted-foreground text-xs tabular-nums">
          <span>{segundos === undefined ? "-" : t("runs.step.seconds", { seconds: segundos })}</span>
          <span>
            {t("runs.step.tokens", { tokens: passo.promptTokens + passo.completionTokens })}
          </span>
          <span>{t("runs.step.cost", { cost: passo.costUsd.toFixed(3) })}</span>
          <Reexecutar runId={runId} stepKey={passo.stepKey} />
        </span>
      </div>

      {passo.error !== null ? (
        <p className="mt-2 text-destructive text-xs">{rotuloDoMotivo(t, passo.error)}</p>
      ) : null}

      {ferramentas.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {ferramentas.map((nome) => (
            <Badge key={String(nome)} variant="outline">
              {String(nome)}
            </Badge>
          ))}
        </div>
      ) : null}

      {passo.modelRequested !== null ? (
        <Reasoning defaultOpen={false} duration={segundos}>
          <ReasoningTrigger>{t("runs.step.reasoning.trigger")}</ReasoningTrigger>
          <ReasoningContent>
            {[
              t("runs.step.reasoning.requested", { model: passo.modelRequested }),
              t("runs.step.reasoning.used", {
                model: passo.modelUsed ?? t("runs.step.reasoning.none"),
              }),
              passo.substitutionReason !== null
                ? t("runs.step.reasoning.substitution", { reason: passo.substitutionReason })
                : t("runs.step.reasoning.noSubstitution"),
              skills.length > 0
                ? t("runs.step.reasoning.skills", { skills: skills.join(", ") })
                : t("runs.step.reasoning.noSkills"),
              t("runs.step.reasoning.attempt", {
                attempt: passo.attempt,
                count: passo.promptTokens,
                completion: passo.completionTokens,
              }),
            ].join("\n\n")}
          </ReasoningContent>
        </Reasoning>
      ) : null}

      {/*
        Entrada vazia não vira bloco. O primeiro passo de um pipeline não
        depende de ninguém, e mostrar `{"needs": []}` num bloco de código
        ocupa oito linhas para dizer nada.
      */}
      {temConteudo(passo.input) ? (
        <Json rotulo={t("runs.step.input")} valor={passo.input} />
      ) : null}
      {passo.output !== null ? (
        <Json marcado={marcado} rotulo={t("runs.step.output")} valor={passo.output} />
      ) : null}
    </div>
  );
}

/**
 * O botao de reexecutar.
 *
 * Ele manda `wait: false` porque o pipeline leva minutos: esperar o desfecho
 * deixaria a promessa do IPC pendurada e a tela travada com um botao que nao
 * volta. O servico zera o passo e os que dependem dele antes de soltar o
 * executor, entao o que a tela le depois ja e o estado novo.
 */
function Reexecutar({ runId, stepKey }: { runId: string; stepKey: string }) {
  const { t } = useTranslation();
  const [estado, setEstado] = useState<"parado" | "pedindo" | "erro">("parado");

  return (
    <Button
      data-locum-rerun={stepKey}
      disabled={estado === "pedindo"}
      onClick={() => {
        setEstado("pedindo");
        call("runs.rerunStep", runId, stepKey, { wait: false }).then(
          () => globalThis.location.reload(),
          () => setEstado("erro"),
        );
      }}
      size="sm"
      title={
        estado === "erro" ? t("runs.rerun.refused") : t("runs.rerun.title", { step: stepKey })
      }
      variant="ghost"
    >
      <RotateCcw className={cn("size-3.5", estado === "erro" && "text-destructive")} />
    </Button>
  );
}

function Achados({ achados }: { achados: ReadResult<"runs.findings"> }) {
  const { t } = useTranslation();

  if (achados.length === 0) return null;

  return (
    <Task defaultOpen>
      <TaskTrigger title={t("findings.count", { count: achados.length })} />
      <TaskContent>
        {achados.map((achado, i) => (
          <TaskItem key={`${achado.file ?? "sem-arquivo"}-${achado.line ?? i}`}>
            <Badge variant={achado.severity === "critical" ? "destructive" : "secondary"}>
              {rotuloDeSeveridade(t, achado.severity)}
            </Badge>{" "}
            <TaskItemFile>
              {achado.file ?? t("findings.general")}
              {achado.line === undefined ? "" : `:${achado.line}`}
            </TaskItemFile>{" "}
            {achado.problem}
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}

/* ----------------------------------------------------------------- pedacos */

function Json({
  marcado = false,
  rotulo,
  valor,
}: {
  marcado?: boolean;
  rotulo: string;
  valor: unknown;
}) {
  return (
    <div className="mt-2" {...(marcado ? { "data-locum-probe": "code-block" } : {})}>
      <p className="mb-1 text-muted-foreground text-xs">{rotulo}</p>
      <CodeBlock code={JSON.stringify(valor, null, 2)} language="json">
        <CodeBlockCopyButton />
      </CodeBlock>
    </div>
  );
}

/** As cores dos estados, num lugar so, porque lista e detalhe mostram os mesmos. */
const CORES: Record<Estado, "default" | "secondary" | "destructive" | "outline"> = {
  done: "secondary",
  running: "default",
  queued: "outline",
  pending: "outline",
  paused: "default",
  awaiting_approval: "default",
  skipped: "outline",
  failed: "destructive",
  cancelled: "outline",
};

/**
 * O crachá de estado.
 *
 * O marcador guarda o estado cru, e não o traduzido: o smoke compara com o que
 * o serviço devolve, e comparar contra texto de tela faria a verificação
 * depender do idioma da máquina que roda o loop.
 */
/**
 * Cor de estado é vocabulário próprio, e não o azul de ação.
 *
 * Um selo azul em "pausado" compete com o botão que a pessoa deve clicar, e
 * pinta de importante um estado que só está esperando.
 */
const TINTA_DE_ESTADO: Record<string, string> = {
  done: "text-chart-2",
  running: "text-primary",
  queued: "text-muted-foreground",
  paused: "text-sev-medium",
  failed: "text-sev-critical",
  cancelled: "text-muted-foreground",
};

/** Vazio, objeto sem chave, ou objeto cujas chaves estão todas vazias. */
function temConteudo(valor: unknown): boolean {
  if (valor === null || valor === undefined) return false;
  if (Array.isArray(valor)) return valor.length > 0;
  if (typeof valor !== "object") return true;

  const entradas = Object.values(valor as Record<string, unknown>);
  return entradas.length > 0 && entradas.some((v) => temConteudo(v));
}

function Estado({ status }: { status: string }) {
  const { t } = useTranslation();

  return (
    <span
      className={cn("shrink-0 font-medium", TINTA_DE_ESTADO[status] ?? "text-muted-foreground")}
      data-locum-estado={status}
    >
      {rotuloDeEstado(t, status)}
    </span>
  );
}

function Aviso({ children, probe }: { children: React.ReactNode; probe: string }) {
  return (
    <p className="text-muted-foreground text-sm" data-locum-probe={probe} data-passos={-1}>
      {children}
    </p>
  );
}

/** O que sai de coluna JSON chega como `unknown`: so vira lista se for uma. */
function lista(valor: unknown): unknown[] {
  return Array.isArray(valor) ? valor : [];
}

/**
 * Tempo em palavra, e não carimbo de máquina.
 *
 * `2026-09-20 02:06` obriga a fazer a conta de cabeça para saber se foi hoje.
 * Perto do agora, a distância é o que importa; longe, a data.
 */
function quando(t: TFunction, segundos: number): string {
  const horas = Math.floor((Date.now() / 1000 - segundos) / 3600);
  if (horas < 1) return t("runs.when_now");
  if (horas < 24) return t("runs.when_hours", { hours: horas });
  if (horas < 24 * 7) return t("runs.when_days", { days: Math.floor(horas / 24) });
  return t("runs.when_date", {
    date: new Date(segundos * 1000).toLocaleDateString(undefined, {
      day: "2-digit",
      month: "2-digit",
    }),
  });
}

/**
 * O par cobrado e equivalente, sempre junto.
 *
 * Passo que roda na assinatura nao cobra dinheiro, e mostrar so o cobrado faria
 * toda execucao parecer gratuita.
 */
/**
 * Um número, não um par separado por barra.
 *
 * O que interessa de relance é quanto aquela execução custou. Quando o gasto
 * saiu da assinatura, ele não é dinheiro cobrado, e o til diz isso sem precisar
 * de uma segunda coluna que nunca cabe na linha.
 */
function dinheiro(t: TFunction, run: { costUsd: number; estimateUsd: number }): string {
  if (run.costUsd > 0) return t("runs.money_billed", { amount: run.costUsd.toFixed(2) });
  if (run.estimateUsd > 0) return t("runs.money_equivalent", { amount: run.estimateUsd.toFixed(2) });
  return t("runs.money_free");
}
