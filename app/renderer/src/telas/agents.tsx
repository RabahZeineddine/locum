import { AvisoDeEscrita } from "@/components/aviso-de-escrita";
import { CabecalhoDaTela } from "@/components/cabecalho-da-tela";
import { MarcaLogo } from "@/components/marca-logo";
import { SeloDeAcesso } from "@/components/selo-de-acesso";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ListGroup, ListRow } from "@/components/ui/list-row";
import { Select } from "@/components/ui/select";
import { StatusDot, type Estado as EstadoDoPonto } from "@/components/ui/status-dot";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { call, invalidateReads, read, useRead, type ReadResult } from "@/lib/bridge";
import { rotuloDoModelo } from "@/lib/rotulos";
import { cn } from "@/lib/utils";
import { ChatDoAgent } from "../agent-chat";
import { ArrowLeft, Bot, Copy, Loader2, Plug, Plus, RefreshCw, Search, Trash2, Workflow, Wrench, X } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ehLeitura, ehLeituraDa, escolhaDe, escolhaInicial, ligadaPorPadrao, type EscolhaDeFerramenta } from "../../../src/config/leitura.js";
import { agruparPorArea, filtrarFerramentas, LIMITE_PARA_AGRUPAR } from "@/lib/ferramentas-do-agent";
import { SERVIDOR_NATIVO, type AgentBudget, type AgentConnection, type AgentProfile, type ToolRef, type Toolset } from "../../../src/config/types";
import { SeletorDeModelo, ServidoresComBusca, servidoresDoModelo, useCatalogo } from "../editor-agent";
import type { TelaProps } from "../rotas";

type ResumoDoAgent = ReadResult<"library.profiles">[number];
type ResumoDoToolset = ReadResult<"library.toolsets">[number];
type Conexao = ReadResult<"connections.list">[number];

/** O detalhe que abre a aba de toolsets, e não um agent. */
const ABA_TOOLSETS = "toolsets";
/** O detalhe do agent novo, ainda sem id. */
const NOVO = "novo";

const SECOES = ["instructions", "model", "tools", "skills", "budget", "chat", "usage"] as const;
type Secao = (typeof SECOES)[number];

const LIMITES = ["perRunUsd", "perDayUsd", "perRunTokens", "perDayTokens"] as const;

const AGENT_EM_BRANCO: AgentProfile = {
  id: "",
  name: "",
  description: "",
  context: "",
  instructions: "",
  model: "claude-code/claude-sonnet-5",
  toolsets: [],
  tools: [],
  connections: [],
  skills: [],
  budget: {},
  maxSteps: 12,
};

/**
 * Agents: quem trabalha. Instruções, modelo, o que pode usar em cada conexão,
 * skills e orçamento. Não tem gatilho nem ação: a automação decide quando ele
 * trabalha e o que fazer com a saída. Os toolsets, atalhos de ferramentas que
 * vários agents compartilham, ficam numa aba à parte.
 */
export function Agents({ detalhe, navegar }: TelaProps) {
  const { t } = useTranslation();
  const aba = detalhe === ABA_TOOLSETS ? "toolsets" : "agents";

  if (detalhe !== null && detalhe !== ABA_TOOLSETS) {
    return (
      <EditorDoAgent
        abrir={(id) => navegar("agents", id)}
        id={detalhe === NOVO ? null : detalhe}
        navegar={navegar}
        voltar={() => navegar("agents")}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6" data-locum-probe="agents-v3">
      <CabecalhoDaTela
        acoes={
          aba === "agents" ? (
            <Button className="cursor-pointer" data-locum-agent-novo="" onClick={() => navegar("agents", NOVO)}>
              <Plus className="size-4" />
              {t("library.newAgent")}
            </Button>
          ) : null
        }
        descricao={t("library.lead")}
        titulo={t("library.title")}
      />
      <Tabs onValueChange={(a) => (a === "agents" ? navegar("agents") : navegar("agents", ABA_TOOLSETS))} value={aba}>
        <TabsList>
          {(["agents", "toolsets"] as const).map((a) => (
            <TabsTrigger
              className="cursor-pointer"
              data-locum-agents-aba={a}
              key={a}
              onClick={() => (a === "agents" ? navegar("agents") : navegar("agents", ABA_TOOLSETS))}
              value={a}
            >
              {t(`library.tabs.${a}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {aba === "agents" ? <ListaDeAgents abrir={(id) => navegar("agents", id)} /> : <ListaDeToolsets />}
    </div>
  );
}

/** Copia o agent com nome novo, como versão 1 de outro id, e devolve o id. */
async function duplicar(spec: AgentProfile, sufixo: string): Promise<string> {
  const nome = `${spec.name} ${sufixo}`;
  const id = await call("library.suggestId", nome, "profile");
  const gravado = await call("library.saveProfile", { spec: { ...spec, id, name: nome }, create: true, note: sufixo });
  invalidateReads("library.profiles");
  return gravado.profileId;
}

/* ------------------------------------------------------------------ agents */

function ListaDeAgents({ abrir }: { abrir: (id: string) => void }) {
  const { t } = useTranslation();
  const lista = useRead("library.profiles");
  const conexoes = useRead("connections.list");
  const [erro, setErro] = useState<string | null>(null);
  if (lista.status === "loading") return <p className="text-muted-foreground text-[13px]">{t("library.loading")}</p>;
  const agents = lista.data ?? [];
  const nomes = new Map((conexoes.data ?? []).map((c) => [c.id, c.name]));
  const urls = new Map((conexoes.data ?? []).map((c) => [c.id, c.url]));

  const copiar = (id: string): void => {
    setErro(null);
    (async () => {
      const original = await read("library.profile", id);
      if (original === null) return;
      abrir(await duplicar(original.spec, t("library.copySuffix")));
    })().catch((e: unknown) => setErro(e instanceof Error ? e.message : String(e)));
  };

  if (agents.length === 0) {
    return (
      <EmptyState
        acao={
          <Button className="cursor-pointer" data-locum-agent-novo-vazio="" onClick={() => abrir(NOVO)} size="sm" variant="outline">
            <Plus aria-hidden />
            {t("library.newAgent")}
          </Button>
        }
        descricao={t("library.empty")}
        icone={<Bot aria-hidden />}
        titulo={t("library.emptyTitle")}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {erro === null ? null : <p className="text-destructive text-xs">{erro}</p>}
      <ListGroup data-locum-biblioteca-total={agents.length}>
        {agents.map((a) => (
          <LinhaDoAgent agent={a} abrir={() => abrir(a.id)} copiar={() => copiar(a.id)} key={a.id} nomes={nomes} urls={urls} />
        ))}
      </ListGroup>
    </div>
  );
}

/** Quantas marcas cabem na linha antes do "+N". */
const MARCAS_NA_LINHA = 4;

function LinhaDoAgent({
  agent,
  abrir,
  copiar,
  nomes,
  urls,
}: {
  agent: ResumoDoAgent;
  abrir: () => void;
  copiar: () => void;
  nomes: Map<string, string>;
  urls: Map<string, string | undefined>;
}) {
  const { t } = useTranslation();
  const nomesDasConexoes = agent.connections.map((id) => nomes.get(id) ?? id).join(", ");
  return (
    <ListRow className="min-h-11" data-locum-agent-da-biblioteca={agent.id} onClick={abrir} rotulo={agent.name}>
      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
        <Bot className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{agent.name}</span>
          <span className="num shrink-0 text-[11px] text-muted-foreground">{t("library.versionShort", { version: agent.version })}</span>
        </span>
        {agent.description === "" ? null : <span className="truncate text-xs text-muted-foreground">{agent.description}</span>}
      </span>
      <span className="hidden w-48 shrink-0 truncate text-xs text-muted-foreground lg:block" title={agent.model}>
        {rotuloDoModelo(agent.model)}
      </span>
      {/* O que ele alcança: as marcas das conexões, e os nomes por extenso para o leitor de tela e a dica. */}
      <span
        className="flex w-32 shrink-0 items-center gap-1 text-xs text-muted-foreground"
        data-locum-agent-alcance={agent.id}
        title={agent.connections.length === 0 ? t("library.card.noConnections") : t("library.card.uses", { list: nomesDasConexoes })}
      >
        {agent.connections.slice(0, MARCAS_NA_LINHA).map((id) => (
          <MarcaLogo fonte={{ name: id, url: urls.get(id) }} key={id} tamanho="sm" />
        ))}
        {agent.connections.length > MARCAS_NA_LINHA ? <span className="num">+{agent.connections.length - MARCAS_NA_LINHA}</span> : null}
        {agent.connections.length === 0 ? <span>{t("library.row.noConnections")}</span> : null}
        <span className="sr-only">{nomesDasConexoes}</span>
      </span>
      <span className="flex w-32 shrink-0 items-center justify-end" title={agent.writes > 0 ? t("library.card.writes", { count: agent.writes }) : undefined}>
        {agent.writes > 0 ? <AvisoDeEscrita texto={t("library.row.writes", { count: agent.writes })} /> : null}
      </span>
      <span className="num w-28 shrink-0 text-right text-xs text-muted-foreground">{t("library.usedBy", { count: agent.usedBy.length })}</span>
      <Button
        aria-label={t("library.duplicate")}
        className="shrink-0"
        data-locum-agent-duplicar={agent.id}
        onClick={(e) => {
          // A linha inteira abre o agent; o botão só duplica.
          e.stopPropagation();
          copiar();
        }}
        size="icon-sm"
        title={t("library.duplicate")}
        variant="ghost"
      >
        <Copy />
      </Button>
    </ListRow>
  );
}

function EditorDoAgent({
  id,
  voltar,
  abrir,
  navegar,
}: {
  id: string | null;
  voltar: () => void;
  abrir: (id: string) => void;
  navegar: TelaProps["navegar"];
}) {
  const { t } = useTranslation();
  const lido = useRead("library.profile", id ?? "");
  const automacoes = useRead("agents.list");
  // `agents/<id>` já foi o detalhe de uma automação: sem agent com esse id e
  // com automação do modelo antigo, o link velho vai para onde ela mora agora.
  const deAutomacao = id !== null && lido.status === "ready" && lido.data === null && (automacoes.data ?? []).some((a) => a.id === id);
  useEffect(() => {
    if (deAutomacao) navegar("automations", `legacy/${id}`);
  }, [deAutomacao, id, navegar]);
  if (deAutomacao) return null;
  if (id !== null && (lido.status === "loading" || (lido.data === null && automacoes.status === "loading"))) return <p className="pt-6 text-[13px] text-muted-foreground">{t("library.loading")}</p>;
  if (id !== null && (lido.status === "error" || lido.data === null)) {
    return (
      <div className="flex flex-col items-start gap-3 pt-6">
        <p className="text-[13px]">{lido.error?.message ?? t("library.notFound")}</p>
        <Button className="cursor-pointer" onClick={voltar} size="sm" variant="outline">
          {t("library.back")}
        </Button>
      </div>
    );
  }
  return <FormularioDoAgent abrir={abrir} inicial={id === null ? null : (lido.data ?? null)} key={id ?? NOVO} navegar={navegar} voltar={voltar} />;
}

function FormularioDoAgent({
  inicial,
  voltar,
  abrir,
  navegar,
}: {
  inicial: ReadResult<"library.profile">;
  voltar: () => void;
  abrir: (id: string) => void;
  navegar: TelaProps["navegar"];
}) {
  const { t } = useTranslation();
  const catalogo = useCatalogo();
  const toolsets = useRead("library.toolsets");
  const usos = useRead("library.profiles");
  const [spec, setSpec] = useState<AgentProfile>(() => inicial?.spec ?? AGENT_EM_BRANCO);
  const [salvo, setSalvo] = useState(inicial);
  const [nota, setNota] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [secao, setSecao] = useState<Secao>("instructions");
  const novo = salvo === null;
  const mudou = salvo === null || JSON.stringify(salvo.spec) !== JSON.stringify(spec);
  const usadoPor = (usos.data ?? []).find((u) => u.id === spec.id)?.usedBy ?? [];
  const trocar = <K extends keyof AgentProfile>(campo: K, valor: AgentProfile[K]): void => setSpec((s) => ({ ...s, [campo]: valor }));

  const salvar = async (): Promise<void> => {
    setOcupado(true);
    setAviso(null);
    try {
      const id = novo ? await call("library.suggestId", spec.name, "profile") : spec.id;
      const gravado = await call("library.saveProfile", {
        spec: { ...spec, id },
        note: nota.trim() || (novo ? t("library.editor.created") : t("library.editor.edited")),
        create: novo,
      });
      invalidateReads("library.profiles");
      setSalvo(gravado);
      setSpec(gravado.spec);
      setNota("");
      setAviso({ tipo: "ok", texto: t("library.editor.saved", { version: gravado.version }) });
      if (novo) abrir(gravado.profileId);
    } catch (e) {
      setAviso({ tipo: "erro", texto: e instanceof Error ? e.message : String(e) });
    } finally {
      setOcupado(false);
    }
  };

  const copiar = (): void => {
    setOcupado(true);
    setAviso(null);
    duplicar(spec, t("library.copySuffix")).then(abrir, (e: unknown) => {
      setOcupado(false);
      setAviso({ tipo: "erro", texto: e instanceof Error ? e.message : String(e) });
    });
  };

  const remover = (): void => {
    setOcupado(true);
    call("library.removeProfile", spec.id).then(
      () => {
        invalidateReads("library.profiles");
        voltar();
      },
      (e: unknown) => {
        setOcupado(false);
        setAviso({ tipo: "erro", texto: e instanceof Error ? e.message : String(e) });
      },
    );
  };

  const ferramentasNoTotal =
    spec.tools.length +
    (toolsets.data ?? []).filter((ts) => spec.toolsets.includes(ts.id)).reduce((n, ts) => n + ts.tools.length, 0);
  const contagem: Partial<Record<Secao, number>> = {
    tools: spec.connections.length + ferramentasNoTotal,
    skills: spec.skills.length,
    usage: usadoPor.length,
  };

  // As seções ficam todas montadas e só a escolhida aparece: o que se digitou
  // numa não some ao trocar, e o salvar vale para o agent inteiro.
  return (
    <Tabs className="mx-auto w-full max-w-4xl gap-5 pt-1" data-locum-probe="agent-da-biblioteca" onValueChange={(a) => setSecao(a as Secao)} value={secao}>
      {/* Título, salvar e seções ficam presos no topo: a lista de ferramentas do ms365 é longa. */}
      <div className="sticky top-0 z-10 -mx-2 flex flex-col gap-3 bg-background/95 px-2 pt-1 backdrop-blur">
        <div className="flex items-center gap-3">
          <Button className="-ml-2 cursor-pointer text-muted-foreground" onClick={voltar} size="sm" variant="ghost">
            <ArrowLeft aria-hidden />
            {t("library.back")}
          </Button>
          <span aria-hidden className="text-muted-foreground">/</span>
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground" aria-hidden>
            <Bot className="size-3.5" />
          </span>
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <h1 className="truncate text-[15px] font-semibold">{spec.name.trim() === "" ? t("library.editor.untitled") : spec.name}</h1>
            <span className="shrink-0 truncate text-xs text-muted-foreground">{rotuloDoModelo(spec.model)}</span>
            {salvo === null ? null : <span className="num shrink-0 text-xs text-muted-foreground">{t("library.version", { version: salvo.version })}</span>}
            {!novo && mudou ? (
              <Badge variant="outline">
                <StatusDot estado="aviso" />
                {t("library.editor.unsaved")}
              </Badge>
            ) : null}
          </div>
          {novo ? null : (
            <Button className="cursor-pointer" data-locum-agent-duplicar-aqui="" disabled={ocupado || mudou} onClick={copiar} variant="outline">
              <Copy aria-hidden />
              {t("library.duplicate")}
            </Button>
          )}
          <Button
            className="cursor-pointer"
            data-locum-agent-salvar=""
            disabled={ocupado || !mudou || spec.name.trim() === ""}
            onClick={() => void salvar()}
          >
            {t(novo ? "library.editor.create" : "library.editor.save")}
          </Button>
        </div>

        <TabsList className="flex-wrap">
          {SECOES.map((a) => (
            <TabsTrigger className="cursor-pointer" data-locum-agent-aba={a} key={a} onClick={() => setSecao(a)} value={a}>
              {t(`library.editor.tabs.${a}`)}
              {contagem[a] === undefined || contagem[a] === 0 ? null : (
                <span className="num rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{contagem[a]}</span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        {aviso === null ? null : (
          <p className="-mt-1 flex items-center gap-1.5 text-xs text-muted-foreground" data-locum-agent-aviso={aviso.tipo} role="status">
            <StatusDot estado={aviso.tipo === "erro" ? "erro" : "ok"} />
            {aviso.texto}
          </p>
        )}
      </div>

      <TabsContent className="flex flex-col gap-5" forceMount value="instructions">
        <Pergunta texto={t("library.editor.leads.instructions")} />
        <Campo rotulo={t("library.editor.name")}>
          <Input
            className="font-medium"
            data-locum-agent-nome=""
            onChange={(e) => trocar("name", e.target.value)}
            placeholder={t("library.editor.namePlaceholder")}
            value={spec.name}
          />
        </Campo>
        <Campo rotulo={t("library.editor.description")}>
          <Input
            onChange={(e) => trocar("description", e.target.value)}
            placeholder={t("library.editor.descriptionPlaceholder")}
            value={spec.description}
          />
        </Campo>
        <Campo dica={t("library.editor.contextHint")} rotulo={t("library.editor.context")}>
          <Textarea
            className="min-h-40 font-mono text-[12.5px] leading-relaxed"
            onChange={(e) => trocar("context", e.target.value)}
            value={spec.context}
          />
        </Campo>
        <Campo dica={t("library.editor.instructionsHint")} rotulo={t("library.editor.instructions")}>
          <Textarea
            className="min-h-[22rem] font-mono text-[12.5px] leading-relaxed"
            data-locum-agent-instrucoes=""
            onChange={(e) => trocar("instructions", e.target.value)}
            value={spec.instructions}
          />
        </Campo>
      </TabsContent>

      <TabsContent className="flex flex-col gap-5" forceMount value="model">
        <Pergunta texto={t("library.editor.leads.model")} />
        <div className="grid gap-5 sm:grid-cols-2">
          <Campo rotulo={t("library.editor.model")}>
            <SeletorDeModelo catalogo={catalogo} trocar={(v) => trocar("model", v)} valor={spec.model} />
          </Campo>
          <Campo dica={t("library.editor.temperatureHint")} rotulo={t("library.editor.temperature")}>
            <div className="flex h-8 items-center gap-3">
              <input
                aria-label={t("library.editor.temperature")}
                className="flex-1 cursor-pointer accent-primary"
                disabled={spec.temperature === undefined}
                max={1}
                min={0}
                onChange={(e) => trocar("temperature", Number(e.target.value))}
                step={0.1}
                type="range"
                value={spec.temperature ?? 0.7}
              />
              <span className="num w-8 text-right font-mono text-xs">
                {spec.temperature === undefined ? "" : spec.temperature.toFixed(1)}
              </span>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  checked={spec.temperature === undefined}
                  className="cursor-pointer accent-primary"
                  onChange={(e) =>
                    setSpec((s) => {
                      const { temperature: _antiga, ...resto } = s;
                      return e.target.checked ? resto : { ...resto, temperature: 0.7 };
                    })
                  }
                  type="checkbox"
                />
                {t("library.editor.temperatureDefault")}
              </label>
            </div>
          </Campo>
        </div>
        <Campo dica={t("library.editor.maxStepsHint")} rotulo={t("library.editor.maxSteps")}>
          <Input
            className="num w-28"
            min={1}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(n) && n >= 1) trocar("maxSteps", n);
            }}
            type="number"
            value={spec.maxSteps}
          />
        </Campo>
      </TabsContent>

      <TabsContent className="flex flex-col gap-6" data-locum-agent-secao="tools" forceMount value="tools">
        <Pergunta texto={t("library.editor.leads.tools")} />
        <ConexoesDoAgent conexoes={spec.connections} trocar={(v) => trocar("connections", v)} />
        <details className="rounded-lg border border-border bg-card px-3 py-2.5" open={spec.toolsets.length + spec.tools.length > 0}>
          <summary className="cursor-pointer text-[13px] font-medium">{t("library.editor.shortcuts")}</summary>
          <div className="mt-4 flex flex-col gap-6">
            <p className="text-xs text-muted-foreground">{t("library.editor.shortcutsHint")}</p>
            <FerramentasEscolhidas
              remover={(r) => trocar("tools", spec.tools.filter((x) => x.server !== r.server || x.tool !== r.tool))}
              tools={spec.tools}
            />
            <Campo dica={t("library.editor.toolsetsHint")} rotulo={t("library.editor.toolsets")}>
              {(toolsets.data ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("library.editor.toolsetsNone")}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {(toolsets.data ?? []).map((ts) => {
                    const marcado = spec.toolsets.includes(ts.id);
                    return (
                      <button
                        aria-pressed={marcado}
                        className={cn(
                          "flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                          marcado ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                        )}
                        data-locum-agent-toolset={ts.id}
                        key={ts.id}
                        onClick={() => trocar("toolsets", marcado ? spec.toolsets.filter((x) => x !== ts.id) : [...spec.toolsets, ts.id])}
                        title={ts.description}
                        type="button"
                      >
                        <Wrench aria-hidden className="size-3" />
                        {ts.name}
                        <span className="num text-muted-foreground">{t("library.toolsCount", { count: ts.tools.length })}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </Campo>
            <Campo dica={t("library.editor.extraToolsHint")} rotulo={t("library.editor.addTools")}>
              <EscolhaDeFerramentas trocar={(v) => trocar("tools", v)} valor={spec.tools} />
            </Campo>
          </div>
        </details>
      </TabsContent>

      <TabsContent className="flex flex-col gap-5" forceMount value="skills">
        <Pergunta texto={t("library.editor.leads.skills")} />
        <SkillsDoAgent skills={spec.skills} trocar={(v) => trocar("skills", v)} />
      </TabsContent>

      <TabsContent className="flex flex-col gap-5" forceMount value="budget">
        <Pergunta texto={t("library.editor.leads.budget")} />
        <OrcamentoDoAgent orcamento={spec.budget} trocar={(v) => trocar("budget", v)} />
      </TabsContent>

      <TabsContent className="flex flex-col gap-5" data-locum-agent-secao="chat" forceMount value="chat">
        <Pergunta texto={t("library.editor.leads.chat")} />
        {novo ? (
          <p className="text-[13px] text-muted-foreground" data-locum-agent-chat-salvar="">
            {t("agentChat.saveFirst")}
          </p>
        ) : secao === "chat" ? (
          // Só monta com a aba aberta: o retrato da conversa pede ao serviço as ferramentas do agent.
          <ChatDoAgent id={spec.id} modelo={salvo.spec.model} naoSalvo={mudou} versao={salvo.version} />
        ) : null}
      </TabsContent>

      <TabsContent className="flex flex-col gap-5" forceMount value="usage">
        <Pergunta texto={t("library.editor.leads.usage")} />
        <Campo dica={t("library.editor.usageHint")} rotulo={t("library.editor.usage")}>
          {usadoPor.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t("library.editor.usageNone")}</p>
          ) : (
            <ListGroup>
              {usadoPor.map((id) => (
                <ListRow data-locum-agent-usado-em={id} key={id} onClick={() => navegar("automations", id)} rotulo={id}>
                  <Workflow aria-hidden className="size-4 text-muted-foreground" />
                  <span className="font-mono text-xs">{id}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{t("library.editor.openAutomation")}</span>
                </ListRow>
              ))}
            </ListGroup>
          )}
        </Campo>
        {novo ? null : (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2.5">
            <span className="flex-1 text-xs text-muted-foreground">
              {usadoPor.length > 0 ? t("library.editor.inUse", { list: usadoPor.join(", ") }) : t("library.editor.removeHint")}
            </span>
            <Button
              className="cursor-pointer"
              data-locum-agent-remover=""
              disabled={ocupado || usadoPor.length > 0}
              onClick={remover}
              size="sm"
              variant="ghost"
            >
              <Trash2 aria-hidden />
              {t("library.editor.remove")}
            </Button>
          </div>
        )}
      </TabsContent>

      {novo ? null : (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Input
            className="min-w-56 flex-1"
            onChange={(e) => setNota(e.target.value)}
            placeholder={t("library.editor.note")}
            value={nota}
          />
        </div>
      )}
    </Tabs>
  );
}

/** A frase que abre cada seção: a pergunta que ela responde. */
function Pergunta({ texto }: { texto: string }) {
  return <p className="text-[13px] text-muted-foreground">{texto}</p>;
}

/* ------------------------------------------------------------- conexões */

/**
 * O que o agent usa de cada conexão. Dentro de cada uma, a leitura vem ligada e
 * a escrita desligada; o interruptor de cada ferramenta só guarda o que foge do
 * padrão.
 */
function ConexoesDoAgent({ conexoes, trocar }: { conexoes: AgentConnection[]; trocar: (v: AgentConnection[]) => void }) {
  const { t } = useTranslation();
  const lista = useRead("connections.list");
  const todas = lista.data ?? [];
  const livres = todas.filter((c) => c.servers.length > 0 && !conexoes.some((x) => x.connectionId === c.id));

  // A escolha inicial sai da última lista guardada de cada servidor, e fica gravada: depois disso nenhuma regra tira o que estava ligado.
  const adicionar = async (id: string): Promise<void> => {
    const servidores = todas.find((c) => c.id === id)?.servers ?? [];
    const lidos = await Promise.all(
      servidores.map(async (nome) => ({ nome, ferramentas: (await read("mcp.toolsCached", nome).catch(() => null))?.tools ?? null })),
    );
    trocar([...conexoes, { connectionId: id, ...escolhaInicial(lidos) }]);
  };

  const mudar = (id: string, depois: AgentConnection | null): void =>
    trocar(conexoes.flatMap((c) => (c.connectionId !== id ? [c] : depois === null ? [] : [depois])));

  return (
    <div className="flex flex-col gap-3" data-locum-agent-conexoes={conexoes.length}>
      {conexoes.length === 0 ? (
        <EmptyState className="py-5" icone={<Plug aria-hidden />} titulo={t("library.connections.none")} />
      ) : (
        <ul className="flex flex-col gap-3">
          {conexoes.map((c) => (
            <li key={c.connectionId}>
              <BlocoDaConexao
                conexao={todas.find((x) => x.id === c.connectionId)}
                escolha={c}
                mudar={(depois) => mudar(c.connectionId, depois)}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {livres.length === 0 ? (
          <span className="text-xs text-muted-foreground">{t("library.connections.noneToAdd")}</span>
        ) : (
          <Select
            aria-label={t("library.connections.add")}
            className="w-auto min-w-56"
            data-locum-agent-conexao-adicionar=""
            onChange={(e) => {
              if (e.target.value !== "") void adicionar(e.target.value);
            }}
            value=""
          >
            <option value="">{t("library.connections.add")}</option>
            {livres.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </div>
    </div>
  );
}

/** A última lista de ferramentas guardada de cada servidor, sem subir nenhum. */
function useGuardadas(servidores: string[]): Record<string, ReadResult<"mcp.tools">> {
  const [porServidor, setPorServidor] = useState<Record<string, ReadResult<"mcp.tools">>>({});
  const chave = servidores.join("\u0000");
  useEffect(() => {
    let vivo = true;
    for (const servidor of chave === "" ? [] : chave.split("\u0000")) {
      void read("mcp.toolsCached", servidor).then((guardada) => {
        if (vivo && guardada !== null) setPorServidor((atual) => ({ ...atual, [servidor]: guardada.tools }));
      });
    }
    return () => {
      vivo = false;
    };
  }, [chave]);
  return porServidor;
}

function BlocoDaConexao({
  conexao,
  escolha,
  mudar,
}: {
  conexao: Conexao | undefined;
  escolha: AgentConnection;
  mudar: (depois: AgentConnection | null) => void;
}) {
  const { t } = useTranslation();
  // O servidor interno do Locum não está na lista da tela, mas o agent salvo pode citá-lo: está sempre ligado.
  const interno = conexao === undefined && escolha.connectionId === SERVIDOR_NATIVO;
  const servidores = conexao?.servers ?? (interno ? [SERVIDOR_NATIVO] : []);
  const guardadas = useGuardadas(servidores);
  // A anotação que o servidor deixou no cache manda; o nome só decide sem ela.
  const ligadas = Object.entries(escolha.tools).filter(([chave, e]) => {
    if (e !== true) return false;
    const corte = chave.indexOf("/");
    const nome = chave.slice(corte + 1);
    const achada = (corte < 0 ? servidores : [chave.slice(0, corte)]).map((s) => guardadas[s]?.find((f) => f.name === nome)).find((f) => f !== undefined);
    return achada === undefined ? !ehLeitura(nome) : !ehLeituraDa(achada);
  }).length;
  const nomeDaConexao = conexao?.name ?? escolha.connectionId;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card" data-locum-agent-conexao={escolha.connectionId}>
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
        <MarcaLogo fonte={{ name: escolha.connectionId, url: conexao?.url }} tamanho="sm" />
        <span className="text-[13px] font-medium">{interno ? t("library.connections.internal") : nomeDaConexao}</span>
        {conexao === undefined ? null : (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <StatusDot estado={pontoDaConexao(conexao)} />
            {t(`connections.state.${estadoDaConexao(conexao)}`)}
          </span>
        )}
        <span className="text-xs text-muted-foreground">{t("library.connections.default")}</span>
        {ligadas === 0 ? null : <AvisoDeEscrita count={ligadas} />}
        <Button
          aria-label={t("library.connections.remove", { name: nomeDaConexao })}
          className="ml-auto cursor-pointer"
          onClick={() => mudar(null)}
          size="icon-sm"
          variant="ghost"
        >
          <X aria-hidden />
        </Button>
      </div>
      <div className="flex flex-col gap-4 border-t border-border px-3 py-3">
        {servidores.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("library.connections.noServer")}</p>
        ) : (
          servidores.map((servidor) => <FerramentasDoServidor escolha={escolha} key={servidor} mudar={mudar} servidor={servidor} />)
        )}
      </div>
    </div>
  );
}

/** O estado que a lista de conexões mostra: ligada sem teste e desligada têm palavra própria e ponto neutro. */
function estadoDaConexao(c: Conexao): string {
  return c.state === "connected" && c.reason === "untested" ? "untested" : c.state;
}

function pontoDaConexao(c: Conexao): EstadoDoPonto {
  if (c.state === "off" || (c.state === "connected" && c.reason === "untested")) return "ocioso";
  if (c.state === "connected") return "ok";
  if (c.state === "attention") return "aviso";
  return "erro";
}

function FerramentasDoServidor({
  servidor,
  escolha: escolha_,
  mudar,
}: {
  servidor: string;
  escolha: AgentConnection;
  mudar: (depois: AgentConnection) => void;
}) {
  const { t } = useTranslation();
  const guardadas = useRead("mcp.toolsCached", servidor);
  const [vindas, setVindas] = useState<ReadResult<"mcp.tools"> | null>(null);
  const [lendo, setLendo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const ferramentas = vindas ?? guardadas.data?.tools ?? null;

  const carregar = (): void => {
    setLendo(true);
    setErro(null);
    call("mcp.tools", servidor).then(
      (f) => {
        setVindas(f);
        setLendo(false);
      },
      (e: unknown) => {
        setErro(e instanceof Error ? e.message : String(e));
        setLendo(false);
      },
    );
  };

  type Ferramenta = ReadResult<"mcp.tools">[number];
  const [busca, setBusca] = useState("");
  const todas = ferramentas ?? [];
  const leituras = todas.filter((f) => ehLeituraDa(f));
  const escritas = todas.filter((f) => !ehLeituraDa(f));
  // Na conexão `limitada` a leitura não liga sozinha.
  const padrao = (f: Ferramenta): boolean => ligadaPorPadrao(f, escolha_.leituraPadrao);
  const efetiva = (f: Ferramenta): { ligada: boolean; leitura: boolean; declarada: boolean } => {
    const escolha = escolhaDe(escolha_.tools, servidor, f.name);
    const classe = ehLeituraDa(f);
    return {
      ligada: escolha === undefined ? padrao(f) : escolha !== false,
      leitura: classe || escolha === "read",
      declarada: escolha === "read",
    };
  };
  // Grava a escolha na chave `servidor/ferramenta`, e só quando ela difere do
  // que a chave antiga, só pelo nome, ou o padrão já dariam. Várias de uma vez
  // partem do mesmo mapa, para "ligar todas" não perder escolha no caminho.
  const definirVarias = (pares: [Ferramenta, EscolhaDeFerramenta][]): void => {
    let tools = escolha_.tools;
    for (const [f, valor] of pares) {
      const chave = `${servidor}/${f.name}`;
      const { [chave]: _antes, ...resto } = tools;
      const base = escolhaDe(resto, servidor, f.name);
      const normal = (x: EscolhaDeFerramenta | undefined): EscolhaDeFerramenta => {
        const v = x === undefined ? padrao(f) : x;
        return v === "read" && ehLeituraDa(f) ? true : v;
      };
      tools = normal(valor) === normal(base) ? resto : { ...resto, [chave]: valor };
    }
    mudar({ ...escolha_, tools });
  };
  const definir = (f: Ferramenta, valor: EscolhaDeFerramenta): void => definirVarias([[f, valor]]);
  const ligarLeituras = (doGrupo: Ferramenta[]): void => definirVarias(doGrupo.filter((f) => ehLeituraDa(f)).map((f) => [f, true]));
  const desligar = (doGrupo: Ferramenta[]): void => definirVarias(doGrupo.map((f) => [f, false]));

  const visiveis = filtrarFerramentas(todas, busca);
  const visiveisOrdenadas = [...visiveis.filter((f) => ehLeituraDa(f)), ...visiveis.filter((f) => !ehLeituraDa(f))];
  const grupos = agruparPorArea(visiveisOrdenadas, todas.length);
  const ligadasNoTotal = todas.filter((f) => efetiva(f).ligada).length;
  const grande = todas.length > LIMITE_PARA_AGRUPAR;

  const linha = (f: Ferramenta) => {
    const { ligada, leitura, declarada } = efetiva(f);
    return (
      <ListRow className="min-h-9 py-1" key={f.name}>
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
          <input
            checked={ligada}
            className="cursor-pointer accent-primary"
            data-locum-agent-ferramenta={`${servidor}/${f.name}`}
            onChange={(e) => definir(f, e.target.checked ? (declarada ? "read" : true) : false)}
            type="checkbox"
          />
          <span className="shrink-0 font-mono text-xs">{f.name}</span>
          <SeloDeAcesso leitura={leitura} />
          {f.description === "" ? null : <span className="line-clamp-1 min-w-0 flex-1 text-xs text-muted-foreground">{f.description}</span>}
        </label>
        {ehLeituraDa(f) || !ligada ? null : (
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground" title={t("library.connections.declareReadHint")}>
            <input
              checked={declarada}
              className="cursor-pointer accent-primary"
              data-locum-agent-declarar-leitura={`${servidor}/${f.name}`}
              onChange={(e) => definir(f, e.target.checked ? "read" : true)}
              type="checkbox"
            />
            {t("library.connections.declareRead")}
          </label>
        )}
      </ListRow>
    );
  };

  return (
    <div className="flex flex-col gap-3" data-locum-agent-servidor={servidor}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs">{servidor}</span>
        {ferramentas === null ? null : (
          <span className="num text-xs text-muted-foreground" data-locum-agent-ligadas={`${ligadasNoTotal}/${todas.length}`}>
            {t("library.connections.ligadas", { on: ligadasNoTotal, total: todas.length })}
          </span>
        )}
        <span className="flex-1" />
        {ferramentas === null || todas.length === 0 ? null : (
          <>
            <Button
              className="cursor-pointer"
              data-locum-agent-ligar-leituras={servidor}
              onClick={() => ligarLeituras(busca.trim() === "" ? todas : visiveis)}
              size="sm"
              variant="outline"
            >
              {t("library.connections.enableReads")}
            </Button>
            <Button
              className="cursor-pointer"
              data-locum-agent-desligar-todas={servidor}
              onClick={() => desligar(busca.trim() === "" ? todas : visiveis)}
              size="sm"
              variant="outline"
            >
              {t("library.connections.disableAll")}
            </Button>
          </>
        )}
        <Button
          className="cursor-pointer"
          data-locum-agent-carregar={servidor}
          disabled={lendo}
          onClick={carregar}
          size="sm"
          variant="ghost"
        >
          {lendo ? <Loader2 aria-hidden className="animate-spin" /> : <RefreshCw aria-hidden />}
          {t(ferramentas === null ? "library.connections.load" : "library.connections.reload")}
        </Button>
      </div>
      {grande && ligadasNoTotal === 0 ? (
        <p className="text-xs text-muted-foreground" data-locum-agent-escolha-as-que-precisa="">
          {t("library.connections.pickThem")}
        </p>
      ) : null}
      {ferramentas !== null && todas.length > 8 ? (
        <div className="relative max-w-sm">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={t("library.connections.search")}
            className="pl-8"
            data-locum-agent-ferramentas-busca={servidor}
            onChange={(e) => setBusca(e.target.value)}
            placeholder={t("library.connections.search")}
            value={busca}
          />
        </div>
      ) : null}
      {erro === null ? null : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot estado="erro" />
          {erro}
        </p>
      )}
      {ferramentas === null ? (
        <p className="text-xs text-muted-foreground">{t("library.connections.notListed")}</p>
      ) : visiveis.length === 0 && busca.trim() !== "" ? (
        <p className="text-xs text-muted-foreground">{t("library.connections.noMatch", { termo: busca.trim() })}</p>
      ) : (
        grupos.map((g) => (
          <div className="flex flex-col gap-1.5" data-locum-agent-grupo={g.area ?? ""} key={g.area ?? "todas"}>
            {g.area === null ? null : (
              <div className="mt-1 flex items-center gap-2">
                <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  {t(`library.connections.areas.${g.area}`)}
                </span>
                <span className="num text-[11px] text-muted-foreground">
                  {t("library.connections.ligadas", { on: g.itens.filter((f) => efetiva(f).ligada).length, total: g.itens.length })}
                </span>
                <Button className="ml-auto cursor-pointer" onClick={() => ligarLeituras(g.itens)} size="xs" variant="ghost">
                  {t("library.connections.enableReads")}
                </Button>
                <Button className="cursor-pointer" onClick={() => desligar(g.itens)} size="xs" variant="ghost">
                  {t("library.connections.disableAll")}
                </Button>
              </div>
            )}
            <ListGroup className="bg-transparent">{g.itens.map(linha)}</ListGroup>
          </div>
        ))
      )}
      {escritas.some((f) => efetiva(f).ligada && !efetiva(f).leitura) ? (
        <AvisoDeEscrita texto={t("library.connections.writeNote")} />
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- skills */

function SkillsDoAgent({ skills, trocar }: { skills: AgentProfile["skills"]; trocar: (v: AgentProfile["skills"]) => void }) {
  const { t } = useTranslation();
  const achadas = useRead("skills.list");
  const nomes = new Set(skills.map((s) => s.skill));
  const livres = (achadas.data ?? []).filter((s) => !nomes.has(s.name));
  const noDisco = new Set((achadas.data ?? []).map((s) => s.name));
  return (
    <div className="flex flex-col gap-3" data-locum-agent-skills={skills.length}>
      {skills.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-[13px] text-muted-foreground">{t("library.skills.none")}</p>
      ) : (
        <ListGroup>
          {skills.map((s) => (
            <ListRow className="min-h-9 py-1" data-locum-agent-skill={s.skill} key={s.skill}>
              <span className="font-mono text-xs">{s.skill}</span>
              {achadas.status === "ready" && !noDisco.has(s.skill) ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <StatusDot estado="aviso" />
                  {t("library.skills.missing")}
                </span>
              ) : null}
              <Button
                aria-label={t("library.skills.remove", { name: s.skill })}
                className="ml-auto cursor-pointer"
                onClick={() => trocar(skills.filter((x) => x.skill !== s.skill))}
                size="icon-xs"
                variant="ghost"
              >
                <X aria-hidden />
              </Button>
            </ListRow>
          ))}
        </ListGroup>
      )}
      {livres.length === 0 ? (
        <span className="text-xs text-muted-foreground">{t("library.skills.noneToAdd")}</span>
      ) : (
        <CampoComBusca
          aoEscolher={(nome) => trocar([...skills, { skill: nome, when: { always: true } }])}
          opcoes={livres.map((s) => ({ name: s.name, description: s.description }))}
          rotulo={t("library.skills.add")}
          semResultado={t("library.skills.noMatch")}
        />
      )}
    </div>
  );
}

/**
 * Campo com busca no lugar de um `<select>` de muitos itens: digita, a lista
 * afunila por nome ou descrição, e Enter ou o clique escolhe. Setas movem a
 * escolha e Esc fecha.
 */
function CampoComBusca({
  aoEscolher,
  opcoes,
  rotulo,
  semResultado,
}: {
  aoEscolher: (nome: string) => void;
  opcoes: { name: string; description?: string }[];
  rotulo: string;
  semResultado: string;
}) {
  const [termo, setTermo] = useState("");
  const [aberto, setAberto] = useState(false);
  const [ativa, setAtiva] = useState(0);
  const idDaLista = useId();
  const achadas = useMemo(() => filtrarFerramentas(opcoes, termo).slice(0, 40), [opcoes, termo]);
  const escolher = (nome: string): void => {
    aoEscolher(nome);
    setTermo("");
    setAberto(false);
    setAtiva(0);
  };
  return (
    <div className="relative w-full max-w-sm" data-locum-campo-com-busca="">
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-activedescendant={aberto && achadas[ativa] !== undefined ? `${idDaLista}-${ativa}` : undefined}
        aria-autocomplete="list"
        aria-controls={idDaLista}
        aria-expanded={aberto}
        aria-label={rotulo}
        className="pl-8"
        onBlur={() => setTimeout(() => setAberto(false), 120)}
        onChange={(e) => {
          setTermo(e.target.value);
          setAberto(true);
          setAtiva(0);
        }}
        onFocus={() => setAberto(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setAberto(true);
            setAtiva((i) => Math.min(i + 1, achadas.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setAtiva((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const alvo = achadas[ativa];
            if (alvo !== undefined) escolher(alvo.name);
          } else if (e.key === "Escape") {
            setAberto(false);
          }
        }}
        placeholder={rotulo}
        role="combobox"
        value={termo}
      />
      {aberto ? (
        <ul
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg"
          id={idDaLista}
          role="listbox"
        >
          {achadas.length === 0 ? (
            <li className="px-2 py-1.5 text-xs text-muted-foreground">{semResultado}</li>
          ) : (
            achadas.map((o, i) => (
              <li
                aria-selected={i === ativa}
                className={cn("flex cursor-pointer flex-col gap-0.5 rounded px-2 py-1", i === ativa && "bg-accent")}
                id={`${idDaLista}-${i}`}
                key={o.name}
                onMouseDown={(e) => {
                  e.preventDefault();
                  escolher(o.name);
                }}
                onMouseEnter={() => setAtiva(i)}
                role="option"
              >
                <span className="font-mono text-xs">{o.name}</span>
                {o.description ? <span className="line-clamp-1 text-[11px] text-muted-foreground">{o.description}</span> : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ orçamento */

function OrcamentoDoAgent({ orcamento, trocar }: { orcamento: AgentBudget; trocar: (v: AgentBudget) => void }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2" data-locum-agent-orcamento="">
      {LIMITES.map((campo) => (
        <LimiteDoOrcamento campo={campo} key={campo} orcamento={orcamento} trocar={trocar} />
      ))}
    </div>
  );
}

/**
 * Um teto. O que se digita fica como texto ("0." e "0,25" a meio caminho não
 * somem), e só o número válido e positivo vai para o spec; o resto tira o teto.
 */
function LimiteDoOrcamento({
  campo,
  orcamento,
  trocar,
}: {
  campo: (typeof LIMITES)[number];
  orcamento: AgentBudget;
  trocar: (v: AgentBudget) => void;
}) {
  const { t } = useTranslation();
  const dinheiro = campo.endsWith("Usd");
  const [texto, setTexto] = useState(() => (orcamento[campo] === undefined ? "" : String(orcamento[campo])));
  const mudar = (digitado: string): void => {
    setTexto(digitado);
    const { [campo]: _antes, ...resto } = orcamento;
    const normal = digitado.trim().replace(",", ".");
    const n = Number(normal);
    const valido = normal !== "" && Number.isFinite(n) && n > 0 && (dinheiro || Number.isInteger(n));
    trocar(valido ? { ...resto, [campo]: n } : resto);
  };
  return (
    <Campo dica={t(`library.budget.${campo}Hint`)} rotulo={t(`library.budget.${campo}`)}>
      <Input
        className="num w-40"
        data-locum-agent-limite={campo}
        inputMode={dinheiro ? "decimal" : "numeric"}
        onChange={(e) => mudar(e.target.value)}
        placeholder={t("library.budget.noLimit")}
        type="text"
        value={texto}
      />
    </Campo>
  );
}

/**
 * O que o agent já pode usar por fora das conexões: as ferramentas avulsas por
 * servidor, cada uma dizendo se só lê ou se escreve, e um x para tirar.
 */
function FerramentasEscolhidas({ tools, remover }: { tools: ToolRef[]; remover: (r: ToolRef) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-muted-foreground">{t("library.editor.chosenTools")}</span>
      {tools.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-[13px] text-muted-foreground">{t("library.editor.chosenNone")}</p>
      ) : (
        <ListGroup data-locum-agent-escolhidas={tools.length}>
          {tools.map((r) => (
            <ListRow className="min-h-9 py-1" key={`${r.server}/${r.tool}`}>
              <span className="font-mono text-xs">{r.tool}</span>
              <SeloDeAcesso leitura={ehLeitura(r.tool)} />
              <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-muted-foreground">{r.server}</span>
              <Button
                aria-label={t("library.editor.removeTool", { tool: r.tool })}
                className="cursor-pointer"
                onClick={() => remover(r)}
                size="icon-xs"
                variant="ghost"
              >
                <X aria-hidden />
              </Button>
            </ListRow>
          ))}
        </ListGroup>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- toolsets */

function ListaDeToolsets() {
  const { t } = useTranslation();
  const inicial = useRead("library.toolsets");
  const [relida, setRelida] = useState<ResumoDoToolset[] | null>(null);
  const [aberto, setAberto] = useState<string | null>(null);
  const lista = relida ?? inicial.data ?? [];
  const reler = (): void => {
    read("library.toolsets").then(setRelida, () => undefined);
  };

  return (
    <div className="flex flex-col gap-3" data-locum-probe="toolsets" data-total={lista.length}>
      <div className="flex items-center gap-3">
        <p className="flex-1 text-[13px] text-muted-foreground">{t("library.toolsets.lead")}</p>
        <Button className="cursor-pointer" data-locum-toolset-novo="" onClick={() => setAberto(NOVO)} size="sm" variant="outline">
          <Plus aria-hidden />
          {t("library.toolsets.new")}
        </Button>
      </div>
      {aberto === NOVO ? (
        <EditorDoToolset
          fechar={() => setAberto(null)}
          inicial={null}
          aoGravar={() => {
            setAberto(null);
            reler();
          }}
        />
      ) : null}
      {lista.length === 0 && aberto !== NOVO ? (
        <EmptyState descricao={t("library.toolsets.empty")} icone={<Wrench aria-hidden />} titulo={t("library.toolsets.emptyTitle")} />
      ) : lista.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          {lista.map((ts) =>
            aberto === ts.id ? (
              <EditorDoToolset
                aoGravar={() => {
                  setAberto(null);
                  reler();
                }}
                fechar={() => setAberto(null)}
                inicial={ts}
                key={ts.id}
              />
            ) : null,
          )}
          <ListGroup>
            {lista
              .filter((ts) => aberto !== ts.id)
              .map((ts) => (
                <ListRow className="min-h-11" data-locum-toolset={ts.id} key={ts.id} onClick={() => setAberto(ts.id)} rotulo={ts.name}>
                  <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
                    <Wrench className="size-3.5" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{ts.name}</span>
                    {ts.description === "" ? null : <span className="truncate text-xs text-muted-foreground">{ts.description}</span>}
                  </span>
                  <span className="num shrink-0 text-xs text-muted-foreground">{t("library.toolsCount", { count: ts.tools.length })}</span>
                  <span className="num w-24 shrink-0 text-right text-xs text-muted-foreground">{t("library.toolsets.usedBy", { count: ts.usedBy.length })}</span>
                </ListRow>
              ))}
          </ListGroup>
        </div>
      )}
    </div>
  );
}

function EditorDoToolset({
  inicial,
  fechar,
  aoGravar,
}: {
  inicial: ResumoDoToolset | null;
  fechar: () => void;
  aoGravar: () => void;
}) {
  const { t } = useTranslation();
  const [toolset, setToolset] = useState<Toolset>(
    () => (inicial === null ? { id: "", name: "", description: "", tools: [] } : { id: inicial.id, name: inicial.name, description: inicial.description, tools: inicial.tools }),
  );
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const salvar = async (): Promise<void> => {
    setOcupado(true);
    setErro(null);
    try {
      const id = inicial === null ? await call("library.suggestId", toolset.name, "toolset") : toolset.id;
      await call("library.saveToolset", { toolset: { ...toolset, id }, create: inicial === null });
      aoGravar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
      setOcupado(false);
    }
  };

  const remover = (): void => {
    setOcupado(true);
    call("library.removeToolset", toolset.id).then(aoGravar, (e: unknown) => {
      setErro(e instanceof Error ? e.message : String(e));
      setOcupado(false);
    });
  };

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-primary/40 bg-card p-4" data-locum-probe="toolset-editor">
      <div className="grid gap-4 sm:grid-cols-2">
        <Campo rotulo={t("library.toolsets.name")}>
          <Input
            autoFocus
            data-locum-toolset-nome=""
            onChange={(e) => setToolset((s) => ({ ...s, name: e.target.value }))}
            value={toolset.name}
          />
        </Campo>
        <Campo rotulo={t("library.toolsets.description")}>
          <Input onChange={(e) => setToolset((s) => ({ ...s, description: e.target.value }))} value={toolset.description} />
        </Campo>
      </div>
      <Campo dica={t("library.toolsets.toolsHint")} rotulo={t("library.toolsets.tools")}>
        <EscolhaDeFerramentas trocar={(tools) => setToolset((s) => ({ ...s, tools }))} valor={toolset.tools} />
      </Campo>
      <div className="flex flex-wrap items-center gap-2">
        <Button className="cursor-pointer" data-locum-toolset-salvar="" disabled={ocupado || toolset.name.trim() === ""} onClick={() => void salvar()} size="sm">
          {t(inicial === null ? "library.toolsets.create" : "library.toolsets.save")}
        </Button>
        <Button className="cursor-pointer" onClick={fechar} size="sm" variant="ghost">
          {t("library.toolsets.cancel")}
        </Button>
        <span className="flex-1" />
        {inicial === null ? null : (
          <Button
            className="cursor-pointer"
            disabled={ocupado || inicial.usedBy.length > 0}
            onClick={remover}
            size="sm"
            title={inicial.usedBy.length > 0 ? t("library.editor.inUse", { list: inicial.usedBy.join(", ") }) : undefined}
            variant="ghost"
          >
            <Trash2 className="size-4" />
            {t("library.editor.remove")}
          </Button>
        )}
      </div>
      {erro === null ? null : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot estado="erro" />
          {erro}
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ campos */

/** Ferramentas por servidor MCP ligado, cada lista aberta só quando pedida. */
function EscolhaDeFerramentas({ valor, trocar }: { valor: ToolRef[]; trocar: (v: ToolRef[]) => void }) {
  const { t } = useTranslation();
  const servidores = useRead("mcp.list");
  const nomes = servidoresDoModelo(servidores.data);
  return (
    <div className="flex flex-col gap-2">
      {nomes.length === 1 && <p className="text-muted-foreground text-xs">{t("agents.editor.tools.noServers")}</p>}
      <ServidoresComBusca nomes={nomes} trocar={trocar} valor={valor} />
    </div>
  );
}

function Campo({ rotulo, dica, children }: { rotulo: string; dica?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{rotulo}</span>
      {children}
      {dica === undefined ? null : <span className="text-[11px] text-muted-foreground">{dica}</span>}
    </div>
  );
}
