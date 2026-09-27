import { Canvas } from "@/components/ai-elements/canvas";
import { Controls } from "@/components/ai-elements/controls";
import { Edge } from "@/components/ai-elements/edge";
import {
  Node,
  NodeContent,
  NodeDescription,
  NodeHeader,
  NodeTitle,
} from "@/components/ai-elements/node";
import type { ReadResult } from "@/lib/bridge";
import { ALTURA_DO_NO, LARGURA_DO_NO, montarGrafo } from "@/lib/grafo";
import { cn } from "@/lib/utils";
import type {
  Edge as ArestaDoFluxo,
  Node as NoDoFluxo,
  NodeProps as PropsDoNo,
} from "@xyflow/react";
import { MarkerType } from "@xyflow/react";
import { rotuloDeEstado, rotuloDoMotivo } from "@/lib/rotulos";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

type Detalhe = NonNullable<ReadResult<"runs.get">>;
type PassoDoSpec = Detalhe["spec"]["steps"][number];
type PassoDoRun = Detalhe["steps"][number];

/**
 * O grafo de uma execucao, somente leitura.
 *
 * A forma vem do spec, porque e la que mora o `needs`: a tabela `steps` guarda
 * a ordem em que o executor rodou, que e uma linearizacao, e desenhar a partir
 * dela transformaria todo grafo numa fila. O estado vem do run, casado por
 * chave de passo.
 *
 * Nao existe edicao aqui, e nao e falta de tempo: o editor de agent continua
 * sendo a lista, onde uma dependencia se escreve por nome. Arrastar caixa para
 * ligar uma na outra pareceria edicao e nao gravaria versao nenhuma.
 */
export function GrafoDaExecucao({ detalhe }: { detalhe: Detalhe }) {
  const { nos, arestas } = useMemo(() => {
    const porChave = new Map(detalhe.steps.map((s) => [s.stepKey, s]));
    const grafo = montarGrafo(detalhe.spec.steps);

    const flowNodes: NoDoFluxo<DadosDoPasso>[] = grafo.nos.map((no) => {
      const doSpec = detalhe.spec.steps.find((s) => s.key === no.key);
      const doRun = porChave.get(no.key);

      return {
        id: no.key,
        type: "passo",
        position: { x: no.x, y: no.y },
        data: dados(no.key, doSpec, doRun),
      };
    });

    const flowEdges: ArestaDoFluxo[] = grafo.arestas.map((aresta) => {
      // A aresta so anima quando o passo do outro lado esta rodando agora: em
      // run parado, bolinha andando em toda seta viraria enfeite e ainda
      // acordaria o compositor de graus em graus a toa.
      const alvo = porChave.get(aresta.target);
      return {
        ...aresta,
        type: alvo?.status === "running" ? "animada" : "default",
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--muted-foreground)" },
        style: { stroke: "var(--muted-foreground)" },
      };
    });

    return { arestas: flowEdges, nos: flowNodes };
  }, [detalhe]);

  return (
    <div
      className="bg-card border-border h-96 w-full overflow-hidden rounded-lg border"
      data-arestas={arestas.map((a) => a.id).join(",")}
      data-locum-probe="grafo"
      data-nos={nos.map((n) => n.id).join(",")}
    >
      <Canvas
        edges={arestas}
        edgeTypes={TIPOS_DE_ARESTA}
        edgesFocusable={false}
        // Somente leitura, item por item: sem isso o React Flow aceita
        // arrastar caixa e puxar ligacao, e o desenho passaria a discordar do
        // spec sem nada gravado em lugar nenhum.
        elementsSelectable={false}
        // Sem enquadrar, o desenho nasce no canto e os nós das colunas da
        // direita ficam cortados pela borda. A margem evita que a caixa encoste
        // na moldura.
        fitView
        fitViewOptions={{ padding: 0.18, minZoom: 0.4, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        nodes={nos}
        nodesConnectable={false}
        nodesDraggable={false}
        nodesFocusable={false}
        nodeTypes={TIPOS_DE_NO}
        selectionOnDrag={false}
      >
        <Controls showInteractive={false} />
      </Canvas>
    </div>
  );
}

/* -------------------------------------------------------------------- no */

// Tipo, e nao interface: o React Flow exige `Record<string, unknown>` no dado
// do no, e so o alias de objeto ganha a assinatura de indice implicita que
// satisfaz essa restricao.
type DadosDoPasso = {
  chave: string;
  nome: string;
  status: string;
  detalhe: string;
  /** Codigo de passo pulado ou rejeitado, traduzido so na hora de pintar o no. */
  erro: string | null;
  substituicao: string | null;
  opcional: boolean;
  /** Preenchido so no passo de acao: e o que sai, ou nao, sem clique. */
  modo: string | null;
  temEntrada: boolean;
  temSaida: boolean;
};

function dados(
  chave: string,
  doSpec: PassoDoSpec | undefined,
  doRun: PassoDoRun | undefined,
): DadosDoPasso {
  const acao = doSpec?.type === "action" ? doSpec : undefined;

  return {
    chave,
    detalhe:
      doRun?.modelUsed ?? (doSpec?.type === "model" ? doSpec.model : (acao?.action ?? chave)),
    modo: acao?.mode ?? null,
    erro: doRun?.error ?? null,
    substituicao: doRun?.error ? null : (doRun?.substitutionReason ?? null),
    nome: doSpec?.name ?? doRun?.name ?? chave,
    opcional: doSpec?.optional ?? false,
    status: doRun?.status ?? "pending",
    temEntrada: (doSpec?.needs.length ?? 0) > 0,
    temSaida: true,
  };
}

/**
 * A borda diz o estado.
 *
 * Pulado e tracejado e apagado, porque ele nao falhou nem rodou: ele nao
 * aconteceu, e a linha cheia de quem rodou faria a leitura rapida contar um
 * passo a mais. Aguardando aprovacao e o unico que pisca, porque e o unico que
 * espera uma pessoa.
 */
const BORDAS: Record<string, string> = {
  awaiting_approval: "border-amber-500/70 ring-1 ring-amber-500/40",
  cancelled: "border-dashed border-border opacity-60",
  done: "border-emerald-600/60",
  failed: "border-destructive",
  paused: "border-amber-500/50",
  running: "border-sky-500/70 ring-1 ring-sky-500/30",
  skipped: "border-dashed border-border opacity-60",
};

function NoDoPasso({ data }: PropsDoNo<NoDoFluxo<DadosDoPasso>>) {
  const { t } = useTranslation();

  return (
    <Node
      className={cn("w-full", BORDAS[data.status] ?? "border-border")}
      data-locum-estado={data.status}
      data-locum-no={data.chave}
      handles={{ source: data.temSaida, target: data.temEntrada }}
      style={{ height: ALTURA_DO_NO, width: LARGURA_DO_NO }}
    >
      <NodeHeader>
        <NodeTitle className="truncate text-sm">{data.nome}</NodeTitle>
        <NodeDescription className="truncate font-mono text-xs">{data.chave}</NodeDescription>
      </NodeHeader>
      <NodeContent className="flex flex-col gap-1 text-xs">
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">{rotuloDeEstado(t, data.status)}</span>
          {data.opcional ? (
            <span className="text-muted-foreground">{t("graph.optional")}</span>
          ) : null}
          {data.modo === "approve" ? (
            <span className="text-amber-500">{t("graph.onlyWithClick")}</span>
          ) : null}
        </span>
        <span className="truncate text-muted-foreground">{data.detalhe}</span>
        {data.erro !== null ? (
          <span className="truncate text-muted-foreground" title={rotuloDoMotivo(t, data.erro)}>
            {rotuloDoMotivo(t, data.erro)}
          </span>
        ) : data.substituicao !== null ? (
          <span className="truncate text-muted-foreground" title={data.substituicao}>
            {data.substituicao}
          </span>
        ) : null}
      </NodeContent>
    </Node>
  );
}

// Const de modulo, e nao objeto literal na prop: o React Flow avisa no console
// e remonta todo no a cada render quando o mapa muda de identidade.
const TIPOS_DE_NO = { passo: NoDoPasso };
const TIPOS_DE_ARESTA = { animada: Edge.Animated };
