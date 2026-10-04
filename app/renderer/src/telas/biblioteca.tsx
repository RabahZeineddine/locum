import { CabecalhoDaTela } from "@/components/cabecalho-da-tela";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { call, read, useRead, type ReadResult } from "@/lib/bridge";
import { rotuloDoModelo } from "@/lib/rotulos";
import { cn } from "@/lib/utils";
import { ArrowLeft, Bot, Plus, Trash2, Wrench } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AgentProfile, ToolRef, Toolset } from "../../../src/config/types";
import { FerramentasDoServidor, SeletorDeModelo, useCatalogo } from "../editor-agent";
import type { TelaProps } from "../rotas";

type ResumoDoAgent = ReadResult<"library.profiles">[number];
type ResumoDoToolset = ReadResult<"library.toolsets">[number];

const CAMPO =
  "border-border bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-1.5 text-sm outline-none focus-visible:ring-1";

/** O detalhe que abre a aba de toolsets, e não um agent. */
const ABA_TOOLSETS = "toolsets";
/** O detalhe do agent novo, ainda sem id. */
const NOVO = "novo";

/**
 * Agents: a biblioteca de especialidades e os toolsets que elas usam.
 *
 * Agent aqui não tem gatilho nem passo. É quem trabalha; a automação diz
 * quando e com que tarefa. Por isso a mesma especialidade, "chamados" ou
 * "parcerias", entra em quantos fluxos precisar sem ser copiada.
 */
export function Biblioteca({ detalhe, navegar }: TelaProps) {
  const { t } = useTranslation();
  const aba = detalhe === ABA_TOOLSETS ? "toolsets" : "agents";

  if (detalhe !== null && detalhe !== ABA_TOOLSETS) {
    return <EditorDoAgent id={detalhe === NOVO ? null : detalhe} voltar={() => navegar("library")} abrir={(id) => navegar("library", id)} />;
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6" data-locum-probe="biblioteca">
      <CabecalhoDaTela
        acoes={
          aba === "agents" ? (
            <Button className="cursor-pointer" data-locum-agent-novo="" onClick={() => navegar("library", NOVO)}>
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
            key={a}
            onClick={() => (a === "agents" ? navegar("library") : navegar("library", ABA_TOOLSETS))}
            type="button"
          >
            {t(`library.tabs.${a}`)}
          </button>
        ))}
      </div>
      {aba === "agents" ? <ListaDeAgents abrir={(id) => navegar("library", id)} /> : <ListaDeToolsets />}
    </div>
  );
}

/* ------------------------------------------------------------------ agents */

function ListaDeAgents({ abrir }: { abrir: (id: string) => void }) {
  const { t } = useTranslation();
  const lista = useRead("library.profiles");
  if (lista.status === "loading") return <p className="text-muted-foreground text-sm">{t("library.loading")}</p>;
  const agents = lista.data ?? [];
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
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3" data-locum-biblioteca-total={agents.length}>
      {agents.map((a) => (
        <CartaoDoAgent agent={a} abrir={() => abrir(a.id)} key={a.id} />
      ))}
    </ul>
  );
}

function CartaoDoAgent({ agent, abrir }: { agent: ResumoDoAgent; abrir: () => void }) {
  const { t } = useTranslation();
  return (
    <li>
      <button
        className="border-border superficie hover:border-foreground/30 flex h-full w-full cursor-pointer flex-col gap-2 rounded-lg border p-4 text-left transition-colors"
        data-locum-agent-da-biblioteca={agent.id}
        onClick={abrir}
        type="button"
      >
        <span className="flex items-center gap-2.5">
          <span aria-hidden className="ia-gradiente text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
            <Bot className="size-4" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-sm">{agent.name}</span>
            <span className="text-muted-foreground truncate text-xs">{rotuloDoModelo(agent.model)}</span>
          </span>
        </span>
        {agent.description === "" ? null : <span className="text-muted-foreground line-clamp-2 text-xs">{agent.description}</span>}
        <span className="text-muted-foreground mt-auto flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          <span>{t("library.toolsetsCount", { count: agent.toolsets.length })}</span>
          <span>{t("library.usedBy", { count: agent.usedBy.length })}</span>
          <span>{t("library.version", { version: agent.version })}</span>
        </span>
      </button>
    </li>
  );
}

function EditorDoAgent({ id, voltar, abrir }: { id: string | null; voltar: () => void; abrir: (id: string) => void }) {
  const { t } = useTranslation();
  const lido = useRead("library.profile", id ?? "");
  if (id !== null && lido.status === "loading") return <p className="text-muted-foreground pt-6 text-sm">{t("library.loading")}</p>;
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
  return <FormularioDoAgent abrir={abrir} inicial={id === null ? null : (lido.data ?? null)} voltar={voltar} />;
}

function FormularioDoAgent({
  inicial,
  voltar,
  abrir,
}: {
  inicial: ReadResult<"library.profile">;
  voltar: () => void;
  abrir: (id: string) => void;
}) {
  const { t } = useTranslation();
  const catalogo = useCatalogo();
  const toolsets = useRead("library.toolsets");
  const usos = useRead("library.profiles");
  const [spec, setSpec] = useState<AgentProfile>(
    () =>
      inicial?.spec ?? {
        id: "",
        name: "",
        description: "",
        context: "",
        instructions: "",
        model: "claude-code/claude-sonnet-5",
        toolsets: [],
        tools: [],
        maxSteps: 12,
      },
  );
  const [salvo, setSalvo] = useState(inicial);
  const [nota, setNota] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
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

  const remover = (): void => {
    setOcupado(true);
    call("library.removeProfile", spec.id).then(voltar, (e: unknown) => {
      setOcupado(false);
      setAviso({ tipo: "erro", texto: e instanceof Error ? e.message : String(e) });
    });
  };

  return (
    <div className="flex max-w-3xl flex-col gap-5 pt-2" data-locum-probe="agent-da-biblioteca">
      <div className="flex flex-wrap items-center gap-2">
        <Button className="cursor-pointer" onClick={voltar} size="sm" variant="ghost">
          <ArrowLeft className="size-4" />
          {t("library.back")}
        </Button>
        <span className="flex-1" />
        {salvo === null ? null : <span className="text-muted-foreground text-xs">{t("library.version", { version: salvo.version })}</span>}
        {!novo && mudou ? <Badge variant="outline">{t("library.editor.unsaved")}</Badge> : null}
      </div>

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
          className={cn(CAMPO, "min-h-28 resize-y text-[13px] leading-relaxed")}
          onChange={(e) => trocar("context", e.target.value)}
          value={spec.context}
        />
      </Campo>
      <Campo dica={t("library.editor.instructionsHint")} rotulo={t("library.editor.instructions")}>
        <textarea
          className={cn(CAMPO, "min-h-36 resize-y text-[13px] leading-relaxed")}
          data-locum-agent-instrucoes=""
          onChange={(e) => trocar("instructions", e.target.value)}
          value={spec.instructions}
        />
      </Campo>

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

      <Campo dica={t("library.editor.extraToolsHint")} rotulo={t("library.editor.extraTools")}>
        <EscolhaDeFerramentas trocar={(v) => trocar("tools", v)} valor={spec.tools} />
      </Campo>

      <Campo rotulo={t("library.editor.maxSteps")}>
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

      <div className="border-border flex flex-wrap items-center gap-2 border-t pt-4">
        {novo ? null : (
          <input
            className={cn(CAMPO, "min-w-56 flex-1")}
            onChange={(e) => setNota(e.target.value)}
            placeholder={t("library.editor.note")}
            value={nota}
          />
        )}
        <Button
          className="cursor-pointer"
          data-locum-agent-salvar=""
          disabled={ocupado || !mudou || spec.name.trim() === ""}
          onClick={() => void salvar()}
        >
          {t(novo ? "library.editor.create" : "library.editor.save")}
        </Button>
        {novo ? null : (
          <Button
            className="cursor-pointer"
            disabled={ocupado || usadoPor.length > 0}
            onClick={remover}
            title={usadoPor.length > 0 ? t("library.editor.inUse", { list: usadoPor.join(", ") }) : undefined}
            variant="ghost"
          >
            <Trash2 className="size-4" />
            {t("library.editor.remove")}
          </Button>
        )}
      </div>
      {usadoPor.length > 0 ? (
        <p className="text-muted-foreground text-xs">{t("library.editor.inUse", { list: usadoPor.join(", ") })}</p>
      ) : null}
      {aviso === null ? null : (
        <p className={cn("text-xs", aviso.tipo === "erro" ? "text-sev-critical" : "text-emerald-400")}>{aviso.texto}</p>
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
  const ligados = (servidores.data ?? []).filter((s) => s.enabled);
  if (ligados.length === 0) return <p className="text-muted-foreground text-xs">{t("agents.editor.tools.noServers")}</p>;
  return (
    <div className="flex flex-col gap-2">
      {ligados.map(({ config }) => (
        <FerramentasDoServidor
          key={config.name}
          marcadas={valor.filter((r) => r.server === config.name)}
          servidor={config.name}
          trocar={(doServidor) => trocar([...valor.filter((r) => r.server !== config.name), ...doServidor])}
        />
      ))}
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
