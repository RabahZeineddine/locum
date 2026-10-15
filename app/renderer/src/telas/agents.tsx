import { CabecalhoDaTela } from "@/components/cabecalho-da-tela";
import { MarcaLogo } from "@/components/marca-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { call, read, useRead, type ReadResult } from "@/lib/bridge";
import { rotuloDoModelo } from "@/lib/rotulos";
import { cn } from "@/lib/utils";
import { ChatDoAgent } from "../agent-chat";
import { ArrowLeft, Bot, Copy, Loader2, Plus, RefreshCw, Trash2, Workflow, Wrench, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ehLeitura, ehLeituraDa, escolhaDe, type EscolhaDeFerramenta } from "../../../src/config/leitura.js";
import type { AgentBudget, AgentConnection, AgentProfile, ToolRef, Toolset } from "../../../src/config/types";
import { SeletorDeModelo, ServidoresComBusca, servidoresDoModelo, useCatalogo } from "../editor-agent";
import type { TelaProps } from "../rotas";

type ResumoDoAgent = ReadResult<"library.profiles">[number];
type ResumoDoToolset = ReadResult<"library.toolsets">[number];
type Conexao = ReadResult<"connections.list">[number];

const CAMPO =
  "border-border bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-1.5 text-sm outline-none focus-visible:ring-1";

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
      <div className="border-border flex gap-1 border-b">
        {(["agents", "toolsets"] as const).map((a) => (
          <button
            aria-pressed={aba === a}
            className={cn(
              "-mb-px cursor-pointer border-b-2 px-3 py-2 text-sm transition-colors",
              aba === a ? "border-primary text-foreground" : "text-muted-foreground hover:text-foreground border-transparent",
            )}
            data-locum-agents-aba={a}
            key={a}
            onClick={() => (a === "agents" ? navegar("agents") : navegar("agents", ABA_TOOLSETS))}
            type="button"
          >
            {t(`library.tabs.${a}`)}
          </button>
        ))}
      </div>
      {aba === "agents" ? <ListaDeAgents abrir={(id) => navegar("agents", id)} /> : <ListaDeToolsets />}
    </div>
  );
}

/** Copia o agent com nome novo, como versão 1 de outro id, e devolve o id. */
async function duplicar(spec: AgentProfile, sufixo: string): Promise<string> {
  const nome = `${spec.name} ${sufixo}`;
  const id = await call("library.suggestId", nome, "profile");
  const gravado = await call("library.saveProfile", { spec: { ...spec, id, name: nome }, create: true, note: sufixo });
  return gravado.profileId;
}

/* ------------------------------------------------------------------ agents */

function ListaDeAgents({ abrir }: { abrir: (id: string) => void }) {
  const { t } = useTranslation();
  const lista = useRead("library.profiles");
  const conexoes = useRead("connections.list");
  const [erro, setErro] = useState<string | null>(null);
  if (lista.status === "loading") return <p className="text-muted-foreground text-sm">{t("library.loading")}</p>;
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
      <div className="border-border text-muted-foreground flex flex-col items-start gap-3 rounded-lg border border-dashed p-6 text-sm">
        {t("library.empty")}
        <Button className="cursor-pointer" onClick={() => abrir(NOVO)} size="sm" variant="outline">
          {t("library.newAgent")}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {erro === null ? null : <p className="text-destructive text-xs">{erro}</p>}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3" data-locum-biblioteca-total={agents.length}>
        {agents.map((a) => (
          <CartaoDoAgent agent={a} abrir={() => abrir(a.id)} copiar={() => copiar(a.id)} key={a.id} nomes={nomes} urls={urls} />
        ))}
      </ul>
    </div>
  );
}

function CartaoDoAgent({
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
  return (
    <li className="relative">
      <button
        className="border-border superficie hover:border-foreground/30 flex h-full w-full cursor-pointer flex-col gap-2 rounded-lg border p-4 text-left transition-colors"
        data-locum-agent-da-biblioteca={agent.id}
        onClick={abrir}
        type="button"
      >
        <span className="flex items-center gap-2.5 pr-8">
          <span aria-hidden className="ia-gradiente text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
            <Bot className="size-4" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-sm">{agent.name}</span>
            <span className="text-muted-foreground truncate text-xs">{rotuloDoModelo(agent.model)}</span>
          </span>
        </span>
        {agent.description === "" ? null : <span className="text-muted-foreground line-clamp-2 text-xs">{agent.description}</span>}
        {/* O que ele alcança, em palavras: as conexões e o que cada uma deixa fazer. */}
        <span className="flex flex-col gap-0.5 text-xs" data-locum-agent-alcance={agent.id}>
          <span className="flex flex-wrap items-center gap-1.5">
            {agent.connections.slice(0, 6).map((id) => (
              <MarcaLogo fonte={{ name: id, url: urls.get(id) }} key={id} tamanho="sm" />
            ))}
            {agent.connections.length === 0
              ? t("library.card.noConnections")
              : t("library.card.uses", { list: agent.connections.map((id) => nomes.get(id) ?? id).join(", ") })}
          </span>
          {agent.connections.length === 0 ? null : (
            <span className={agent.writes > 0 ? "text-amber-400" : "text-muted-foreground"}>
              {agent.writes > 0 ? t("library.card.writes", { count: agent.writes }) : t("library.card.readOnly")}
            </span>
          )}
        </span>
        <span className="text-muted-foreground mt-auto flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          <span>{t("library.toolsetsCount", { count: agent.toolsets.length })}</span>
          <span>{t("library.card.skills", { count: agent.skills })}</span>
          <span>{t("library.usedBy", { count: agent.usedBy.length })}</span>
          <span>{t("library.version", { version: agent.version })}</span>
        </span>
      </button>
      <button
        aria-label={t("library.duplicate")}
        className="text-muted-foreground hover:text-foreground hover:bg-accent absolute top-3 right-3 cursor-pointer rounded-md p-1.5"
        data-locum-agent-duplicar={agent.id}
        onClick={copiar}
        title={t("library.duplicate")}
        type="button"
      >
        <Copy className="size-3.5" />
      </button>
    </li>
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
  if (id !== null && (lido.status === "loading" || (lido.data === null && automacoes.status === "loading"))) return <p className="text-muted-foreground pt-6 text-sm">{t("library.loading")}</p>;
  if (id !== null && (lido.status === "error" || lido.data === null)) {
    return (
      <div className="flex flex-col items-start gap-3 pt-6">
        <p className="text-sm">{lido.error?.message ?? t("library.notFound")}</p>
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
    call("library.removeProfile", spec.id).then(voltar, (e: unknown) => {
      setOcupado(false);
      setAviso({ tipo: "erro", texto: e instanceof Error ? e.message : String(e) });
    });
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
    <div className="flex max-w-4xl flex-col gap-5 pt-2" data-locum-probe="agent-da-biblioteca">
      <div className="flex flex-wrap items-center gap-2">
        <Button className="cursor-pointer" onClick={voltar} size="sm" variant="ghost">
          <ArrowLeft className="size-4" />
          {t("library.back")}
        </Button>
      </div>

      {/* Título, salvar e seções ficam presos no topo: a lista de ferramentas do ms365 é longa. */}
      <div className="bg-background/95 sticky top-0 z-10 -mx-2 flex flex-col gap-4 px-2 pt-2 backdrop-blur">
        <div className="flex flex-wrap items-start gap-4">
          <span aria-hidden className="ia-gradiente text-primary-foreground flex size-11 shrink-0 items-center justify-center rounded-lg">
            <Bot className="size-5" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 className="truncate text-xl font-semibold">{spec.name.trim() === "" ? t("library.editor.untitled") : spec.name}</h1>
            <p className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span>{rotuloDoModelo(spec.model)}</span>
              {salvo === null ? null : <span>{t("library.version", { version: salvo.version })}</span>}
              {!novo && mudou ? <Badge variant="outline">{t("library.editor.unsaved")}</Badge> : null}
            </p>
            {spec.description === "" ? null : <p className="text-muted-foreground text-sm">{spec.description}</p>}
          </div>
          {novo ? null : (
            <Button className="cursor-pointer" data-locum-agent-duplicar-aqui="" disabled={ocupado || mudou} onClick={copiar} variant="outline">
              <Copy className="size-4" />
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

        <div className="border-border flex flex-wrap gap-1 border-b" role="tablist">
          {SECOES.map((a) => (
            <button
              aria-selected={secao === a}
              className={cn(
                "-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
                secao === a ? "border-primary text-foreground" : "text-muted-foreground hover:text-foreground border-transparent",
              )}
              data-locum-agent-aba={a}
              key={a}
              onClick={() => setSecao(a)}
              role="tab"
              type="button"
            >
              {t(`library.editor.tabs.${a}`)}
              {contagem[a] === undefined || contagem[a] === 0 ? null : (
                <span className="bg-muted text-muted-foreground rounded-full px-1.5 text-[11px] tabular-nums">{contagem[a]}</span>
              )}
            </button>
          ))}
        </div>
        {aviso === null ? null : (
          <p className={cn("-mt-2 text-xs", aviso.tipo === "erro" ? "text-sev-critical" : "text-emerald-400")}>{aviso.texto}</p>
        )}
      </div>

      <section className="flex flex-col gap-5" hidden={secao !== "instructions"} role="tabpanel">
        <Pergunta texto={t("library.editor.leads.instructions")} />
        <Campo rotulo={t("library.editor.name")}>
          <input
            className={cn(CAMPO, "font-medium")}
            data-locum-agent-nome=""
            onChange={(e) => trocar("name", e.target.value)}
            placeholder={t("library.editor.namePlaceholder")}
            value={spec.name}
          />
        </Campo>
        <Campo rotulo={t("library.editor.description")}>
          <input
            className={CAMPO}
            onChange={(e) => trocar("description", e.target.value)}
            placeholder={t("library.editor.descriptionPlaceholder")}
            value={spec.description}
          />
        </Campo>
        <Campo dica={t("library.editor.contextHint")} rotulo={t("library.editor.context")}>
          <textarea
            className={cn(CAMPO, "min-h-40 resize-y font-mono text-[12.5px] leading-relaxed")}
            onChange={(e) => trocar("context", e.target.value)}
            value={spec.context}
          />
        </Campo>
        <Campo dica={t("library.editor.instructionsHint")} rotulo={t("library.editor.instructions")}>
          <textarea
            className={cn(CAMPO, "min-h-[22rem] resize-y font-mono text-[12.5px] leading-relaxed")}
            data-locum-agent-instrucoes=""
            onChange={(e) => trocar("instructions", e.target.value)}
            value={spec.instructions}
          />
        </Campo>
      </section>

      <section className="flex flex-col gap-5" hidden={secao !== "model"} role="tabpanel">
        <Pergunta texto={t("library.editor.leads.model")} />
        <div className="grid gap-5 sm:grid-cols-2">
          <Campo rotulo={t("library.editor.model")}>
            <SeletorDeModelo catalogo={catalogo} trocar={(v) => trocar("model", v)} valor={spec.model} />
          </Campo>
          <Campo dica={t("library.editor.temperatureHint")} rotulo={t("library.editor.temperature")}>
            <div className="flex items-center gap-3">
              <input
                aria-label={t("library.editor.temperature")}
                className="accent-primary flex-1 cursor-pointer"
                disabled={spec.temperature === undefined}
                max={1}
                min={0}
                onChange={(e) => trocar("temperature", Number(e.target.value))}
                step={0.1}
                type="range"
                value={spec.temperature ?? 0.7}
              />
              <span className="w-8 text-right font-mono text-xs tabular-nums">
                {spec.temperature === undefined ? "" : spec.temperature.toFixed(1)}
              </span>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                <input
                  checked={spec.temperature === undefined}
                  className="accent-primary cursor-pointer"
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
          <input
            className={cn(CAMPO, "w-28")}
            min={1}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(n) && n >= 1) trocar("maxSteps", n);
            }}
            type="number"
            value={spec.maxSteps}
          />
        </Campo>
      </section>

      <section className="flex flex-col gap-6" data-locum-agent-secao="tools" hidden={secao !== "tools"} role="tabpanel">
        <Pergunta texto={t("library.editor.leads.tools")} />
        <ConexoesDoAgent conexoes={spec.connections} trocar={(v) => trocar("connections", v)} />
        <details className="border-border rounded-md border p-3" open={spec.toolsets.length + spec.tools.length > 0}>
          <summary className="cursor-pointer text-sm font-medium">{t("library.editor.shortcuts")}</summary>
          <div className="mt-4 flex flex-col gap-6">
            <p className="text-muted-foreground text-xs">{t("library.editor.shortcutsHint")}</p>
            <FerramentasEscolhidas
              remover={(r) => trocar("tools", spec.tools.filter((x) => x.server !== r.server || x.tool !== r.tool))}
              tools={spec.tools}
            />
            <Campo dica={t("library.editor.toolsetsHint")} rotulo={t("library.editor.toolsets")}>
              {(toolsets.data ?? []).length === 0 ? (
                <p className="text-muted-foreground text-xs">{t("library.editor.toolsetsNone")}</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {(toolsets.data ?? []).map((ts) => {
                    const marcado = spec.toolsets.includes(ts.id);
                    return (
                      <button
                        aria-pressed={marcado}
                        className={cn(
                          "border-border flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
                          marcado ? "border-primary bg-primary/10" : "hover:border-foreground/30",
                        )}
                        data-locum-agent-toolset={ts.id}
                        key={ts.id}
                        onClick={() => trocar("toolsets", marcado ? spec.toolsets.filter((x) => x !== ts.id) : [...spec.toolsets, ts.id])}
                        title={ts.description}
                        type="button"
                      >
                        <Wrench className="size-3" />
                        {ts.name}
                        <span className="text-muted-foreground">{t("library.toolsCount", { count: ts.tools.length })}</span>
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
      </section>

      <section className="flex flex-col gap-5" hidden={secao !== "skills"} role="tabpanel">
        <Pergunta texto={t("library.editor.leads.skills")} />
        <SkillsDoAgent skills={spec.skills} trocar={(v) => trocar("skills", v)} />
      </section>

      <section className="flex flex-col gap-5" hidden={secao !== "budget"} role="tabpanel">
        <Pergunta texto={t("library.editor.leads.budget")} />
        <OrcamentoDoAgent orcamento={spec.budget} trocar={(v) => trocar("budget", v)} />
      </section>

      <section className="flex flex-col gap-5" data-locum-agent-secao="chat" hidden={secao !== "chat"} role="tabpanel">
        <Pergunta texto={t("library.editor.leads.chat")} />
        {novo ? (
          <p className="text-muted-foreground text-sm" data-locum-agent-chat-salvar="">
            {t("agentChat.saveFirst")}
          </p>
        ) : secao === "chat" ? (
          // Só monta com a aba aberta: o retrato da conversa pede ao serviço as ferramentas do agent.
          <ChatDoAgent id={spec.id} modelo={salvo.spec.model} naoSalvo={mudou} versao={salvo.version} />
        ) : null}
      </section>

      <section className="flex flex-col gap-5" hidden={secao !== "usage"} role="tabpanel">
        <Pergunta texto={t("library.editor.leads.usage")} />
        <Campo dica={t("library.editor.usageHint")} rotulo={t("library.editor.usage")}>
          {usadoPor.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("library.editor.usageNone")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {usadoPor.map((id) => (
                <li key={id}>
                  <button
                    className="border-border superficie hover:border-foreground/30 flex w-full cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors"
                    onClick={() => navegar("automations", id)}
                    type="button"
                  >
                    <Workflow className="text-muted-foreground size-4" />
                    <span className="font-mono text-xs">{id}</span>
                    <span className="text-muted-foreground ml-auto text-xs">{t("library.editor.openAutomation")}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Campo>
        {novo ? null : (
          <div className="border-sev-critical/30 flex flex-wrap items-center gap-3 rounded-md border p-3">
            <span className="text-muted-foreground flex-1 text-xs">
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
              <Trash2 className="size-4" />
              {t("library.editor.remove")}
            </Button>
          </div>
        )}
      </section>

      {novo ? null : (
        <div className="border-border flex flex-wrap items-center gap-2 border-t pt-4">
          <input
            className={cn(CAMPO, "min-w-56 flex-1")}
            onChange={(e) => setNota(e.target.value)}
            placeholder={t("library.editor.note")}
            value={nota}
          />
        </div>
      )}
    </div>
  );
}

/** A frase que abre cada seção: a pergunta que ela responde. */
function Pergunta({ texto }: { texto: string }) {
  return <p className="text-muted-foreground text-sm">{texto}</p>;
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

  const mudar = (id: string, depois: AgentConnection | null): void =>
    trocar(conexoes.flatMap((c) => (c.connectionId !== id ? [c] : depois === null ? [] : [depois])));

  return (
    <div className="flex flex-col gap-3" data-locum-agent-conexoes={conexoes.length}>
      {conexoes.length === 0 ? (
        <p className="border-border text-muted-foreground rounded-md border border-dashed p-3 text-sm">{t("library.connections.none")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {conexoes.map((c) => (
            <li key={c.connectionId}>
              <CartaoDaConexao
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
          <span className="text-muted-foreground text-xs">{t("library.connections.noneToAdd")}</span>
        ) : (
          <select
            aria-label={t("library.connections.add")}
            className={cn(CAMPO, "w-auto min-w-56 cursor-pointer")}
            data-locum-agent-conexao-adicionar=""
            onChange={(e) => {
              if (e.target.value !== "") trocar([...conexoes, { connectionId: e.target.value, tools: {} }]);
            }}
            value=""
          >
            <option value="">{t("library.connections.add")}</option>
            {livres.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
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

function CartaoDaConexao({
  conexao,
  escolha,
  mudar,
}: {
  conexao: Conexao | undefined;
  escolha: AgentConnection;
  mudar: (depois: AgentConnection | null) => void;
}) {
  const { t } = useTranslation();
  const servidores = conexao?.servers ?? [];
  const guardadas = useGuardadas(servidores);
  // A anotação que o servidor deixou no cache manda; o nome só decide sem ela.
  const ligadas = Object.entries(escolha.tools).filter(([chave, e]) => {
    if (e !== true) return false;
    const corte = chave.indexOf("/");
    const nome = chave.slice(corte + 1);
    const achada = (corte < 0 ? servidores : [chave.slice(0, corte)]).map((s) => guardadas[s]?.find((f) => f.name === nome)).find((f) => f !== undefined);
    return achada === undefined ? !ehLeitura(nome) : !ehLeituraDa(achada);
  }).length;
  return (
    <div className="border-border superficie flex flex-col gap-3 rounded-lg border p-3" data-locum-agent-conexao={escolha.connectionId}>
      <div className="flex flex-wrap items-center gap-2">
        <MarcaLogo fonte={{ name: escolha.connectionId, url: conexao?.url }} tamanho="sm" />
        <span className="text-sm font-medium">{conexao?.name ?? escolha.connectionId}</span>
        {conexao === undefined ? null : <Badge variant="outline">{t(conexao.state === "connected" && conexao.reason === "untested" ? "connections.state.untested" : `connections.state.${conexao.state}`)}</Badge>}
        <span className="text-muted-foreground text-xs">{t("library.connections.default")}</span>
        {ligadas === 0 ? null : (
          <Badge className="text-amber-400" variant="outline">
            {t("library.card.writes", { count: ligadas })}
          </Badge>
        )}
        <button
          aria-label={t("library.connections.remove", { name: conexao?.name ?? escolha.connectionId })}
          className="hover:bg-accent ml-auto cursor-pointer rounded-md p-1"
          onClick={() => mudar(null)}
          type="button"
        >
          <X className="size-4" />
        </button>
      </div>
      {servidores.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t("library.connections.noServer")}</p>
      ) : (
        servidores.map((servidor) => <FerramentasDoServidor escolha={escolha} key={servidor} mudar={mudar} servidor={servidor} />)
      )}
    </div>
  );
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
  const efetiva = (f: Ferramenta): { ligada: boolean; leitura: boolean; declarada: boolean } => {
    const escolha = escolhaDe(escolha_.tools, servidor, f.name);
    const classe = ehLeituraDa(f);
    return {
      ligada: escolha === undefined ? classe : escolha !== false,
      leitura: classe || escolha === "read",
      declarada: escolha === "read",
    };
  };
  // Grava a escolha na chave `servidor/ferramenta`, e só quando ela difere do
  // que a chave antiga, só pelo nome, ou o padrão já dariam.
  const definir = (f: Ferramenta, valor: EscolhaDeFerramenta): void => {
    const chave = `${servidor}/${f.name}`;
    const { [chave]: _antes, ...resto } = escolha_.tools;
    const base = escolhaDe(resto, servidor, f.name);
    const normal = (x: EscolhaDeFerramenta | undefined): EscolhaDeFerramenta => {
      const v = x === undefined ? ehLeituraDa(f) : x;
      return v === "read" && ehLeituraDa(f) ? true : v;
    };
    mudar({ ...escolha_, tools: normal(valor) === normal(base) ? resto : { ...resto, [chave]: valor } });
  };

  const leituras = (ferramentas ?? []).filter((f) => ehLeituraDa(f));
  const escritas = (ferramentas ?? []).filter((f) => !ehLeituraDa(f));

  return (
    <div className="flex flex-col gap-2" data-locum-agent-servidor={servidor}>
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs">{servidor}</span>
        {ferramentas === null ? null : (
          <span className="text-muted-foreground text-xs">
            {t("library.connections.counts", { read: leituras.length, write: escritas.length })}
          </span>
        )}
        <Button
          className="ml-auto cursor-pointer"
          data-locum-agent-carregar={servidor}
          disabled={lendo}
          onClick={carregar}
          size="sm"
          variant="ghost"
        >
          {lendo ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          {t(ferramentas === null ? "library.connections.load" : "library.connections.reload")}
        </Button>
      </div>
      {erro === null ? null : <p className="text-destructive text-xs">{erro}</p>}
      {ferramentas === null ? (
        <p className="text-muted-foreground text-xs">{t("library.connections.notListed")}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {[...leituras, ...escritas].map((f) => {
            const { ligada, leitura, declarada } = efetiva(f);
            return (
              <li className="hover:bg-muted/40 flex items-center gap-2 rounded-md px-2 py-1" key={f.name}>
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                  <input
                    checked={ligada}
                    className="accent-primary cursor-pointer"
                    data-locum-agent-ferramenta={`${servidor}/${f.name}`}
                    onChange={(e) => definir(f, e.target.checked ? (declarada ? "read" : true) : false)}
                    type="checkbox"
                  />
                  <span className="font-mono text-xs">{f.name}</span>
                  <span
                    className={cn(
                      "rounded border px-1.5 text-[10px] leading-4",
                      leitura ? "border-border text-muted-foreground" : "border-sev-medium/40 text-sev-medium",
                    )}
                  >
                    {t(leitura ? "library.editor.read" : "library.editor.write")}
                  </span>
                  {f.description === "" ? null : (
                    <span className="text-muted-foreground line-clamp-1 min-w-0 flex-1 text-xs">{f.description}</span>
                  )}
                </label>
                {ehLeituraDa(f) || !ligada ? null : (
                  <label className="text-muted-foreground flex shrink-0 cursor-pointer items-center gap-1 text-[11px]" title={t("library.connections.declareReadHint")}>
                    <input
                      checked={declarada}
                      className="accent-primary cursor-pointer"
                      data-locum-agent-declarar-leitura={`${servidor}/${f.name}`}
                      onChange={(e) => definir(f, e.target.checked ? "read" : true)}
                      type="checkbox"
                    />
                    {t("library.connections.declareRead")}
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {escritas.some((f) => efetiva(f).ligada && !efetiva(f).leitura) ? (
        <p className="text-amber-400 text-xs">{t("library.connections.writeNote")}</p>
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
        <p className="border-border text-muted-foreground rounded-md border border-dashed p-3 text-sm">{t("library.skills.none")}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {skills.map((s) => (
            <li className="border-border flex items-center gap-1.5 rounded-full border py-0.5 pr-1 pl-2.5 text-xs" key={s.skill}>
              <span className="font-mono">{s.skill}</span>
              {achadas.status === "ready" && !noDisco.has(s.skill) ? (
                <span className="text-amber-400 text-[10px]">{t("library.skills.missing")}</span>
              ) : null}
              <button
                aria-label={t("library.skills.remove", { name: s.skill })}
                className="hover:bg-accent cursor-pointer rounded-full p-0.5"
                onClick={() => trocar(skills.filter((x) => x.skill !== s.skill))}
                type="button"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {livres.length === 0 ? (
        <span className="text-muted-foreground text-xs">{t("library.skills.noneToAdd")}</span>
      ) : (
        <select
          aria-label={t("library.skills.add")}
          className={cn(CAMPO, "w-auto min-w-56 cursor-pointer")}
          onChange={(e) => {
            if (e.target.value !== "") trocar([...skills, { skill: e.target.value, when: { always: true } }]);
          }}
          value=""
        >
          <option value="">{t("library.skills.add")}</option>
          {livres.map((s) => (
            <option key={s.name} title={s.description} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
      )}
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
      <input
        className={cn(CAMPO, "w-40")}
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
  const porServidor = new Map<string, ToolRef[]>();
  for (const r of tools) porServidor.set(r.server, [...(porServidor.get(r.server) ?? []), r]);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-muted-foreground text-xs">{t("library.editor.chosenTools")}</span>
      {tools.length === 0 ? (
        <p className="border-border text-muted-foreground rounded-md border border-dashed p-3 text-sm">{t("library.editor.chosenNone")}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-locum-agent-escolhidas={tools.length}>
          {[...porServidor].map(([servidor, refs]) => (
            <li className="border-border superficie flex flex-col gap-2 rounded-md border p-3" key={servidor}>
              <span className="font-mono text-xs">{servidor}</span>
              <span className="flex flex-wrap gap-1.5">
                {refs.map((r) => {
                  const leitura = ehLeitura(r.tool);
                  return (
                    <span
                      className="border-border flex items-center gap-1.5 rounded-full border py-0.5 pr-1 pl-2.5 text-xs"
                      key={r.tool}
                    >
                      <span className="font-mono">{r.tool}</span>
                      <span className={cn("text-[10px]", leitura ? "text-muted-foreground" : "text-amber-400")}>
                        {t(leitura ? "library.editor.read" : "library.editor.write")}
                      </span>
                      <button
                        aria-label={t("library.editor.removeTool", { tool: r.tool })}
                        className="hover:bg-accent cursor-pointer rounded-full p-0.5"
                        onClick={() => remover(r)}
                        type="button"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  );
                })}
              </span>
            </li>
          ))}
        </ul>
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
        <p className="text-muted-foreground flex-1 text-sm">{t("library.toolsets.lead")}</p>
        <Button className="cursor-pointer" data-locum-toolset-novo="" onClick={() => setAberto(NOVO)} size="sm" variant="outline">
          <Plus className="size-4" />
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
        <p className="border-border text-muted-foreground rounded-lg border border-dashed p-6 text-sm">{t("library.toolsets.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {lista.map((ts) =>
            aberto === ts.id ? (
              <li key={ts.id}>
                <EditorDoToolset
                  fechar={() => setAberto(null)}
                  inicial={ts}
                  aoGravar={() => {
                    setAberto(null);
                    reler();
                  }}
                />
              </li>
            ) : (
              <li key={ts.id}>
                <button
                  className="border-border superficie hover:border-foreground/30 flex w-full cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors"
                  data-locum-toolset={ts.id}
                  onClick={() => setAberto(ts.id)}
                  type="button"
                >
                  <Wrench className="text-muted-foreground size-4 shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium text-sm">{ts.name}</span>
                    {ts.description === "" ? null : <span className="text-muted-foreground truncate text-xs">{ts.description}</span>}
                  </span>
                  <span className="text-muted-foreground text-xs">{t("library.toolsCount", { count: ts.tools.length })}</span>
                  <span className="text-muted-foreground text-xs">{t("library.toolsets.usedBy", { count: ts.usedBy.length })}</span>
                </button>
              </li>
            ),
          )}
        </ul>
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
    <section className="border-primary/40 superficie flex flex-col gap-4 rounded-lg border p-4" data-locum-probe="toolset-editor">
      <div className="grid gap-4 sm:grid-cols-2">
        <Campo rotulo={t("library.toolsets.name")}>
          <input
            autoFocus
            className={CAMPO}
            data-locum-toolset-nome=""
            onChange={(e) => setToolset((s) => ({ ...s, name: e.target.value }))}
            value={toolset.name}
          />
        </Campo>
        <Campo rotulo={t("library.toolsets.description")}>
          <input className={CAMPO} onChange={(e) => setToolset((s) => ({ ...s, description: e.target.value }))} value={toolset.description} />
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
      {erro === null ? null : <p className="text-sev-critical text-xs">{erro}</p>}
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
      <span className="text-muted-foreground text-xs">{rotulo}</span>
      {children}
      {dica === undefined ? null : <span className="text-muted-foreground text-[11px]">{dica}</span>}
    </div>
  );
}
