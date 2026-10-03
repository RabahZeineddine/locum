import { Canvas } from "@/components/ai-elements/canvas";
import { Controls } from "@/components/ai-elements/controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  adicionarPasso,
  arestas,
  componenteDoPasso,
  desligar,
  ehGatilho,
  GATILHOS,
  gatilhosDoCadastro,
  ligar,
  mover,
  PASSOS,
  passoDoAgent,
  PREFIXO_DE_GATILHO,
  posicoes,
  problemas,
  removerPasso,
  type AgentDaBiblioteca,
  type AppDoComponente,
  type GatilhoNoCanvas,
  type Problema,
  type Rascunho,
} from "@/lib/automacao";
import { call, read, useRead, type ReadResult } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import {
  applyNodeChanges,
  Handle,
  MarkerType,
  Position,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { AlertTriangle, ArrowLeft, List, Loader2, Play, Power } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RotaId } from "../rotas";
import { PainelDoNo } from "./painel";
import { appDoGatilho, appDoPasso, resumoDoGatilho, Selo, tituloDoGatilho, tituloDoPasso } from "./visual";

type Automacao = NonNullable<ReadResult<"automations.get">>;

/**
 * O canvas de uma automação.
 *
 * Lê a automação gravada, edita um rascunho em memória e grava tudo de uma vez
 * no "Salvar", como versão nova do agent. Ligar e executar falam com o que
 * está gravado, e por isso "Executar agora" com alteração pendente pede para
 * salvar antes: rodaria a versão anterior, e a pessoa acharia que rodou a da
 * tela.
 */
export function EditorDeAutomacao({
  agentId,
  voltar,
  navegar,
}: {
  agentId: string;
  voltar: () => void;
  navegar: (id: RotaId, detalhe?: string) => void;
}) {
  const { t } = useTranslation();
  const lida = useRead("automations.get", agentId);

  if (lida.status === "loading") {
    return <p className="text-muted-foreground pt-6 text-sm">{t("automations.editor.loading")}</p>;
  }
  if (lida.status === "error" || lida.data === null) {
    return (
      <div className="flex flex-col items-start gap-3 pt-6">
        <p className="text-sm">{lida.status === "error" ? lida.error.message : t("automations.editor.notFound")}</p>
        <Button className="cursor-pointer" onClick={voltar} size="sm" variant="outline">
          {t("automations.editor.back")}
        </Button>
      </div>
    );
  }
  return <EditorCarregado automacao={lida.data} navegar={navegar} voltar={voltar} />;
}

function paraRascunho(a: Automacao): Rascunho {
  return { spec: a.version.spec, gatilhos: gatilhosDoCadastro(a.triggers) };
}

function EditorCarregado({
  automacao,
  voltar,
  navegar,
}: {
  automacao: Automacao;
  voltar: () => void;
  navegar: (id: RotaId, detalhe?: string) => void;
}) {
  const { t } = useTranslation();
  const agentId = automacao.version.agentId;
  const [salvo, setSalvo] = useState<Rascunho>(() => paraRascunho(automacao));
  const [rascunho, setRascunho] = useState<Rascunho>(salvo);
  const [versao, setVersao] = useState(automacao.version.version);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [nota, setNota] = useState("");
  const [ocupado, setOcupado] = useState<"salvar" | "rodar" | "ligar" | null>(null);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);

  const conexoes = useRead("connections.list");
  const trackers = useRead("trackers.list");
  const biblioteca = useRead("library.profiles");
  // Relida depois de o painel transformar um passo em agent da biblioteca:
  // sem isso o agent recém-criado contaria como inexistente e travaria o Salvar.
  const [bibliotecaRelida, setBibliotecaRelida] = useState<ReadResult<"library.profiles"> | null>(null);
  const agentsDaBiblioteca = bibliotecaRelida ?? biblioteca.data ?? [];
  const conectado = (id: string): boolean => (conexoes.data ?? []).some((c) => c.id === id && c.state === "connected");
  const listaDeTrackers = (trackers.data ?? []).filter((tr) => tr.enabled);
  const ctx = {
    slackConectado: conectado("slack"),
    teamsConectado: conectado("teams"),
    trackers: listaDeTrackers.map((tr) => tr.id),
    ...(bibliotecaRelida === null && biblioteca.data === undefined ? {} : { agents: agentsDaBiblioteca.map((a) => a.id) }),
  };
  const appsLigados: Record<AppDoComponente, boolean> = {
    locum: true,
    slack: ctx.slackConectado,
    teams: ctx.teamsConectado,
    github: conectado("github"),
    atlassian: listaDeTrackers.length > 0 || conectado("atlassian"),
  };

  const mudou = JSON.stringify(rascunho) !== JSON.stringify(salvo);
  const lista = problemas(rascunho, ctx);
  const bloqueado = lista.some((p) => p.bloqueia);
  const ligada = salvo.gatilhos.some((g) => g.enabled);

  const salvar = (): void => {
    setOcupado("salvar");
    setAviso(null);
    call("automations.save", {
      spec: rascunho.spec,
      triggers: rascunho.gatilhos.map((g) => ({
        ...(g.id === undefined ? {} : { id: g.id }),
        config: g.config,
        enabled: g.enabled,
      })),
      note: nota.trim() || t("automations.editor.noteDefault"),
    }).then(
      (gravada) => {
        const novo = paraRascunho(gravada);
        setSalvo(novo);
        setRascunho(novo);
        setVersao(gravada.version.version);
        setNota("");
        setOcupado(null);
        setAviso({ tipo: "ok", texto: t("automations.editor.saved", { version: gravada.version.version }) });
      },
      (e: unknown) => {
        setOcupado(null);
        setAviso({ tipo: "erro", texto: e instanceof Error ? e.message : String(e) });
      },
    );
  };

  const executar = (): void => {
    if (mudou) {
      setAviso({ tipo: "erro", texto: t("automations.editor.runUnsaved") });
      return;
    }
    setOcupado("rodar");
    call("automations.runNow", agentId).then(
      () => {
        setOcupado(null);
        setAviso({ tipo: "ok", texto: t("automations.list.started") });
      },
      (e: unknown) => {
        setOcupado(null);
        setAviso({ tipo: "erro", texto: e instanceof Error ? e.message : String(e) });
      },
    );
  };

  const alternar = (): void => {
    setOcupado("ligar");
    call("automations.setEnabled", agentId, !ligada).then(
      (gatilhos) => {
        const porId = new Map(gatilhos.map((g) => [g.id, g.enabled]));
        const aplicar = (r: Rascunho): Rascunho => ({
          ...r,
          gatilhos: r.gatilhos.map((g) => (g.id !== undefined && porId.has(g.id) ? { ...g, enabled: porId.get(g.id)! } : g)),
        });
        setSalvo(aplicar);
        setRascunho(aplicar);
        setOcupado(null);
      },
      (e: unknown) => {
        setOcupado(null);
        setAviso({ tipo: "erro", texto: e instanceof Error ? e.message : String(e) });
      },
    );
  };

  /* ----------------------------------------------------- paleta e canvas */

  const acrescentarGatilho = (id: string): void => {
    const componente = GATILHOS.find((g) => g.id === id);
    if (componente === undefined) return;
    setRascunho((r) => {
      const usadas = new Set(r.gatilhos.map((g) => g.chave));
      let n = r.gatilhos.length + 1;
      while (usadas.has(`${PREFIXO_DE_GATILHO}${n}`)) n++;
      const chave = `${PREFIXO_DE_GATILHO}${n}`;
      setSelecionado(chave);
      return { ...r, gatilhos: [...r.gatilhos, { chave, config: componente.novo(), enabled: false }] };
    });
  };

  const acrescentarPasso = (id: string): void => {
    const componente = PASSOS.find((p) => p.id === id);
    if (componente === undefined) return;
    setRascunho((r) => {
      const passo = componente.novo(r.spec);
      const depois = selecionado !== null && !ehGatilho(selecionado) ? selecionado : (r.spec.steps.at(-1)?.key ?? null);
      const lugar = posicoes(r).get(depois ?? "");
      const spec = adicionarPasso(r, passo, depois, lugar === undefined ? undefined : { x: lugar.x + 330, y: lugar.y });
      setSelecionado(passo.key);
      return { ...r, spec };
    });
  };

  const acrescentarAgent = (agent: AgentDaBiblioteca): void => {
    setRascunho((r) => {
      const passo = passoDoAgent(r.spec, agent);
      const depois = selecionado !== null && !ehGatilho(selecionado) ? selecionado : (r.spec.steps.at(-1)?.key ?? null);
      const lugar = posicoes(r).get(depois ?? "");
      const spec = adicionarPasso(r, passo, depois, lugar === undefined ? undefined : { x: lugar.x + 330, y: lugar.y });
      setSelecionado(passo.key);
      return { ...r, spec };
    });
  };

  const remover = (chave: string): void => {
    setRascunho((r) =>
      ehGatilho(chave)
        ? { ...r, gatilhos: r.gatilhos.filter((g) => g.chave !== chave) }
        : { ...r, spec: removerPasso(r.spec, chave) },
    );
    setSelecionado(null);
  };

  const problemasPorNo = new Map<string, Problema[]>();
  for (const p of lista) {
    if (p.no === undefined) continue;
    problemasPorNo.set(p.no, [...(problemasPorNo.get(p.no) ?? []), p]);
  }

  return (
    <div className="flex h-[calc(100vh-5.25rem)] min-h-[520px] flex-col gap-3 pt-2" data-locum-probe="automacao-editor" data-locum-versao={versao}>
      <header className="flex flex-wrap items-center gap-2">
        <Button className="cursor-pointer" onClick={voltar} size="sm" variant="ghost">
          <ArrowLeft className="size-4" />
          {t("automations.editor.back")}
        </Button>
        <input
          aria-label={t("automations.panel.name")}
          className="border-border bg-background focus-visible:ring-ring min-w-48 flex-1 rounded-md border px-3 py-1.5 font-medium text-sm outline-none focus-visible:ring-1"
          onChange={(e) => setRascunho((r) => ({ ...r, spec: { ...r.spec, name: e.target.value } }))}
          value={rascunho.spec.name}
        />
        <span className="text-muted-foreground text-xs">{t("automations.editor.version", { version: versao })}</span>
        {mudou ? <Badge variant="outline">{t("automations.editor.unsaved")}</Badge> : null}
        <Button className="cursor-pointer" onClick={() => navegar("agents", agentId)} size="sm" variant="ghost">
          <List className="size-4" />
          {t("automations.editor.asList")}
        </Button>
        <Button className="cursor-pointer" disabled={ocupado !== null} onClick={executar} size="sm" variant="outline">
          {ocupado === "rodar" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
          {t("automations.editor.runNow")}
        </Button>
        <Button
          className={cn("cursor-pointer", ligada && "text-emerald-400")}
          data-locum-automacao-ligar=""
          disabled={ocupado !== null || salvo.gatilhos.length === 0}
          onClick={alternar}
          size="sm"
          title={t("automations.editor.enabledHint")}
          variant="outline"
        >
          <Power className="size-4" />
          {t(ligada ? "automations.editor.disable" : "automations.editor.enable")}
        </Button>
      </header>

      {mudou ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="border-border bg-background focus-visible:ring-ring min-w-64 flex-1 rounded-md border px-3 py-1.5 text-sm outline-none focus-visible:ring-1"
            onChange={(e) => setNota(e.target.value)}
            placeholder={t("automations.editor.note")}
            value={nota}
          />
          <Button
            className="cursor-pointer"
            onClick={() => {
              setRascunho(salvo);
              setSelecionado(null);
            }}
            size="sm"
            variant="ghost"
          >
            {t("automations.editor.discard")}
          </Button>
          <Button className="cursor-pointer" data-locum-automacao-salvar="" disabled={bloqueado || ocupado !== null} onClick={salvar} size="sm">
            {t(ocupado === "salvar" ? "automations.editor.saving" : "automations.editor.save")}
          </Button>
        </div>
      ) : null}

      {aviso === null ? null : (
        <p className={cn("text-xs", aviso.tipo === "erro" ? "text-sev-critical" : "text-emerald-400")}>{aviso.texto}</p>
      )}

      {lista.length > 0 ? (
        <details className="text-xs" data-locum-problemas={lista.length}>
          <summary className={cn("cursor-pointer", bloqueado ? "text-sev-critical" : "text-amber-500")}>
            <AlertTriangle className="mr-1 inline size-3.5" />
            {t("automations.editor.problems", { count: lista.length })}
            {bloqueado ? ` · ${t("automations.editor.blocked")}` : ""}
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 pl-5">
            {lista.map((p, i) => (
              <li key={i}>
                <button
                  className={cn("cursor-pointer text-left hover:underline", p.bloqueia ? "text-sev-critical" : "text-muted-foreground")}
                  onClick={() => p.no !== undefined && setSelecionado(p.no)}
                  type="button"
                >
                  {t(p.chave)}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-3">
        <Paleta
          agents={agentsDaBiblioteca}
          aoAgent={acrescentarAgent}
          aoGatilho={acrescentarGatilho}
          aoPasso={acrescentarPasso}
          appsLigados={appsLigados}
          criarAgent={() => navegar("library", "novo")}
        />
        <div className="border-border min-w-0 flex-1 overflow-hidden rounded-lg border" data-locum-probe="automacao-canvas">
          <CanvasDaAutomacao
            agents={agentsDaBiblioteca}
            problemasPorNo={problemasPorNo}
            rascunho={rascunho}
            selecionado={selecionado}
            setRascunho={setRascunho}
            setSelecionado={setSelecionado}
          />
        </div>
        {selecionado === null ? null : (
          <PainelDoNo
            agents={agentsDaBiblioteca}
            chave={selecionado}
            navegar={navegar}
            relerBiblioteca={() => read("library.profiles").then(setBibliotecaRelida, () => undefined)}
            fechar={() => setSelecionado(null)}
            problemas={problemasPorNo.get(selecionado) ?? []}
            rascunho={rascunho}
            remover={() => remover(selecionado)}
            setRascunho={setRascunho}
            trackers={listaDeTrackers}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ paleta */

function Paleta({
  appsLigados,
  agents,
  aoGatilho,
  aoPasso,
  aoAgent,
  criarAgent,
}: {
  appsLigados: Record<AppDoComponente, boolean>;
  agents: readonly AgentDaBiblioteca[];
  aoGatilho: (id: string) => void;
  aoPasso: (id: string) => void;
  aoAgent: (agent: AgentDaBiblioteca) => void;
  criarAgent: () => void;
}) {
  const { t } = useTranslation();
  const Item = ({ app, id, titulo, onClick }: { app: AppDoComponente; id: string; titulo: string; onClick: () => void }) => (
    <li>
      <button
        className="hover:bg-muted flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors"
        data-locum-paleta={id}
        onClick={onClick}
        type="button"
      >
        <Selo app={app} id={id} tamanho="sm" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{titulo}</span>
          {appsLigados[app] ? null : (
            <span className="text-muted-foreground text-[10px]">{t("automations.palette.needsApp")}</span>
          )}
        </span>
      </button>
    </li>
  );

  return (
    <aside className="border-border superficie flex w-56 shrink-0 flex-col gap-3 overflow-y-auto rounded-lg border p-2" data-locum-probe="automacao-paleta">
      <p className="text-muted-foreground px-2 pt-1 text-[11px]">{t("automations.palette.hint")}</p>
      <section>
        <h3 className="text-muted-foreground px-2 pb-1 text-[11px] font-medium uppercase tracking-wide">
          {t("automations.palette.triggers")}
        </h3>
        <ul>
          {GATILHOS.map((g) => (
            <Item app={g.app} id={g.id} key={g.id} onClick={() => aoGatilho(g.id)} titulo={t(`automations.triggers.${g.id}.title`)} />
          ))}
        </ul>
      </section>
      <section>
        <h3 className="text-muted-foreground px-2 pb-1 text-[11px] font-medium uppercase tracking-wide">
          {t("automations.palette.agents")}
        </h3>
        <ul>
          {agents.map((a) => (
            <Item app="locum" id="agent" key={a.id} onClick={() => aoAgent(a)} titulo={a.name} />
          ))}
        </ul>
        {agents.length === 0 ? <p className="text-muted-foreground px-2 text-[11px]">{t("automations.palette.agentsEmpty")}</p> : null}
        <button className="text-primary cursor-pointer px-2 pt-1 text-[11px] hover:underline" onClick={criarAgent} type="button">
          {t("automations.palette.newAgent")}
        </button>
      </section>
      <section>
        <h3 className="text-muted-foreground px-2 pb-1 text-[11px] font-medium uppercase tracking-wide">
          {t("automations.palette.steps")}
        </h3>
        <ul>
          {PASSOS.map((p) => (
            <Item app={p.app} id={p.id} key={p.id} onClick={() => aoPasso(p.id)} titulo={tituloDoPasso(t, p.id)} />
          ))}
        </ul>
      </section>
    </aside>
  );
}

/* ------------------------------------------------------------------ canvas */

type DadosDoNo = {
  chave: string;
  app: AppDoComponente;
  componente: string;
  tipo: string;
  titulo: string;
  subtitulo: string;
  gatilho: boolean;
  aprovacao: boolean;
  problema: "bloqueia" | "aviso" | null;
  desligado: boolean;
};

type NoDoCanvas = Node<DadosDoNo, "componente">;

function CanvasDaAutomacao({
  agents,
  rascunho,
  setRascunho,
  selecionado,
  setSelecionado,
  problemasPorNo,
}: {
  rascunho: Rascunho;
  setRascunho: (f: (r: Rascunho) => Rascunho) => void;
  selecionado: string | null;
  setSelecionado: (chave: string | null) => void;
  problemasPorNo: Map<string, Problema[]>;
  agents: readonly AgentDaBiblioteca[];
}) {
  const { t } = useTranslation();
  const [erro, setErro] = useState<string | null>(null);

  const base = useMemo<NoDoCanvas[]>(() => {
    const onde = posicoes(rascunho);
    const nivel = (chave: string): DadosDoNo["problema"] => {
      const doNo = problemasPorNo.get(chave) ?? [];
      return doNo.some((p) => p.bloqueia) ? "bloqueia" : doNo.length > 0 ? "aviso" : null;
    };
    const gatilhos: NoDoCanvas[] = rascunho.gatilhos.map((g: GatilhoNoCanvas) => ({
      id: g.chave,
      type: "componente",
      position: onde.get(g.chave) ?? { x: 0, y: 0 },
      selected: g.chave === selecionado,
      data: {
        chave: g.chave,
        app: appDoGatilho(g.config.kind),
        componente: g.config.kind,
        tipo: t("automations.palette.triggers"),
        titulo: tituloDoGatilho(t, g.config),
        subtitulo: resumoDoGatilho(t, g.config),
        gatilho: true,
        aprovacao: false,
        problema: nivel(g.chave),
        desligado: !g.enabled,
      },
    }));
    const passos: NoDoCanvas[] = rascunho.spec.steps.map((p) => {
      const componente = componenteDoPasso(p);
      return {
        id: p.key,
        type: "componente",
        position: onde.get(p.key) ?? { x: 0, y: 0 },
        selected: p.key === selecionado,
        data: {
          chave: p.key,
          app: appDoPasso(componente),
          componente,
          tipo: tituloDoPasso(t, componente),
          titulo: p.name,
          subtitulo:
            p.type !== "model"
              ? (p.target ?? "")
              : p.profile !== undefined
                ? (agents.find((a) => a.id === p.profile)?.name ?? p.profile)
                : (p.model.split("/").at(-1) ?? p.model),
          gatilho: false,
          aprovacao: p.type === "action" && p.mode === "approve",
          problema: nivel(p.key),
          desligado: false,
        },
      };
    });
    return [...gatilhos, ...passos];
  }, [rascunho, selecionado, problemasPorNo, agents, t]);

  const [nos, setNos] = useState<NoDoCanvas[]>(base);
  useEffect(() => setNos(base), [base]);

  const ligacoes = useMemo<Edge[]>(
    () =>
      arestas(rascunho).map((a) => ({
        id: a.id,
        source: a.source,
        target: a.target,
        deletable: !a.fixa,
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed },
        style: a.fixa ? { strokeDasharray: "5 5", opacity: 0.6 } : undefined,
      })),
    [rascunho],
  );

  const conectar = (c: Connection): void => {
    const resultado = ligar(rascunho.spec, c.source, c.target);
    if ("erro" in resultado) {
      setErro(t(resultado.erro));
      return;
    }
    setErro(null);
    setRascunho((r) => ({ ...r, spec: resultado.spec }));
  };

  return (
    <div className="relative size-full" aria-label={t("automations.canvas.label")}>
      <Canvas
        edges={ligacoes}
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        nodeTypes={TIPOS}
        nodes={nos}
        onConnect={conectar}
        onEdgesDelete={(removidas) =>
          setRascunho((r) => ({
            ...r,
            spec: removidas.reduce((spec, e) => desligar(spec, e.source, e.target), r.spec),
          }))
        }
        onNodeClick={(_, no) => setSelecionado(no.id)}
        onNodeDragStop={(_, no) => setRascunho((r) => ({ ...r, spec: mover(r.spec, no.id, no.position) }))}
        onNodesChange={(mudancas: NodeChange[]) =>
          // Só posição e medida: seleção, inclusão e remoção passam pelo rascunho.
          setNos(
            (atuais) =>
              applyNodeChanges(
                mudancas.filter((m) => m.type === "position" || m.type === "dimensions"),
                atuais as Node[],
              ) as NoDoCanvas[],
          )
        }
        onNodesDelete={(removidos) => {
          const chaves = new Set(removidos.map((n) => n.id));
          setRascunho((r) => ({
            ...r,
            gatilhos: r.gatilhos.filter((g) => !chaves.has(g.chave)),
            spec: [...chaves].filter((c) => !ehGatilho(c)).reduce((spec, c) => removerPasso(spec, c), r.spec),
          }));
          setSelecionado(null);
        }}
        onPaneClick={() => setSelecionado(null)}
        panOnDrag
        selectionOnDrag={false}
        proOptions={{ hideAttribution: true }}
      >
        <Controls showInteractive={false} />
      </Canvas>
      {erro === null ? null : (
        <p className="bg-card text-sev-critical absolute top-2 left-2 rounded-md border px-2 py-1 text-xs">{erro}</p>
      )}
      {rascunho.gatilhos.length === 0 && rascunho.spec.steps.length === 0 ? (
        <p className="text-muted-foreground pointer-events-none absolute inset-0 flex items-center justify-center text-sm">
          {t("automations.canvas.empty")}
        </p>
      ) : null}
    </div>
  );
}

function NoDoComponente({ data, selected }: NodeProps<NoDoCanvas>) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "bg-card w-[248px] rounded-lg border px-3 py-2.5 shadow-sm transition-shadow",
        selected ? "border-primary ring-primary/40 ring-2" : "border-border",
        data.problema === "bloqueia" && !selected && "border-destructive/70",
        data.problema === "aviso" && !selected && "border-amber-500/60",
      )}
      data-locum-no-automacao={data.chave}
    >
      {data.gatilho ? null : <Handle position={Position.Left} type="target" />}
      <div className="flex items-center gap-2.5">
        <Selo app={data.app} id={data.componente} />
        <div className="flex min-w-0 flex-col">
          <span className="text-muted-foreground truncate text-[11px]">{data.tipo}</span>
          <span className="truncate font-medium text-sm">{data.titulo}</span>
        </div>
      </div>
      {data.subtitulo === "" ? null : <p className="text-muted-foreground mt-1.5 truncate text-xs">{data.subtitulo}</p>}
      <div className="mt-1 flex flex-wrap gap-2 text-[11px]">
        {data.aprovacao ? <span className="text-amber-500">{t("automations.canvas.approval")}</span> : null}
        {data.gatilho ? (
          <span className={data.desligado ? "text-muted-foreground" : "text-emerald-400"}>
            {t(data.desligado ? "automations.list.off" : "automations.list.on")}
          </span>
        ) : null}
      </div>
      <Handle position={Position.Right} type="source" />
    </div>
  );
}

// Const de módulo: o React Flow remonta todo nó quando o mapa muda de identidade.
const TIPOS = { componente: NoDoComponente };
