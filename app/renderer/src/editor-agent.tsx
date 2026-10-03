import { Button } from "@/components/ui/button";
import { call, useRead } from "@/lib/bridge";
import { comContexto, diffJson, type LinhaDoDiff } from "@/lib/diff";
import { salvarAgent } from "@/lib/editar-agent";
import { rotuloDoModelo, rotuloDoProvedor } from "@/lib/rotulos";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ActionMode, AgentSpec, ToolRef } from "../../src/config/types";

type Passo = AgentSpec["steps"][number];
type PassoDeModelo = Extract<Passo, { type: "model" }>;
type PassoDeAcao = Extract<Passo, { type: "action" }>;
type Catalogo = { provedor: string; modelos: string[]; erro?: string }[];
type ModosPorAcao = Map<string, { modes: readonly ActionMode[]; holdsByContent: boolean }>;

/**
 * Edição de um agent, na mesma forma da leitura.
 *
 * A edição mora dentro da tela de detalhe e não numa tela à parte: o passo tem
 * a mesma cara lendo e editando, então dá para ver exatamente o que muda. Parte
 * sempre da versão mais recente, porque editar uma versão antiga bifurcaria o
 * histórico sem ninguém perceber.
 *
 * Salvar passa por uma revisão da diferença e pede uma nota do que mudou. A
 * nota vira o registro da versão, e é o que torna o histórico legível depois.
 *
 * Fica de fora nesta versão: acrescentar, remover e reordenar passos, e editar
 * regra de skill e esquema de saída. Criar agent novo é duplicar um existente.
 */
export function EditorDeAgent({
  agentId,
  spec,
  versao,
  aoSair,
  aoSalvar,
}: {
  agentId: string;
  spec: AgentSpec;
  versao: number;
  aoSair: () => void;
  aoSalvar: (versao: number) => void;
}) {
  const { t } = useTranslation();
  const [rascunho, setRascunho] = useState<AgentSpec>(() => structuredClone(spec));
  const [fase, setFase] = useState<"editando" | "revisando" | "descartando">("editando");
  const [nota, setNota] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const catalogo = useCatalogo();
  const acoes = useRead("actions.describe");
  const modos: ModosPorAcao = useMemo(
    () => new Map((acoes.data ?? []).map((a) => [a.kind, a])),
    [acoes.data],
  );

  const mudou = JSON.stringify(rascunho) !== JSON.stringify(spec);

  function trocarPasso(key: string, novo: Passo) {
    setRascunho((r) => ({ ...r, steps: r.steps.map((p) => (p.key === key ? novo : p)) }));
  }

  async function salvar() {
    setSalvando(true);
    setErro(null);
    try {
      aoSalvar(await salvarAgent(agentId, rascunho, nota));
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setSalvando(false);
    }
  }

  if (fase === "revisando") {
    return (
      <RevisaoAntesDeSalvar
        antes={spec}
        depois={rascunho}
        erro={erro}
        nota={nota}
        proxima={versao + 1}
        salvando={salvando}
        setNota={setNota}
        aoSalvar={() => void salvar()}
        aoVoltar={() => setFase("editando")}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4" data-locum-probe="editor">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-muted-foreground text-xs">
          {t("agents.editor.editing", { version: versao })}
        </span>
        <span className="ml-auto" />
        {fase === "descartando" ? (
          <>
            <span className="text-sm">{t("agents.editor.discardAsk")}</span>
            <Button className="cursor-pointer" onClick={aoSair} size="sm" variant="ghost">
              {t("agents.editor.discardYes")}
            </Button>
            <Button className="cursor-pointer" onClick={() => setFase("editando")} size="sm">
              {t("agents.editor.keepEditing")}
            </Button>
          </>
        ) : (
          <>
            <Button
              className="cursor-pointer"
              onClick={() => (mudou ? setFase("descartando") : aoSair())}
              size="sm"
              variant="ghost"
            >
              {t("agents.editor.cancel")}
            </Button>
            <Button
              className="cursor-pointer"
              data-locum-editor-revisar=""
              disabled={!mudou}
              onClick={() => setFase("revisando")}
              size="sm"
            >
              {t("agents.editor.review")}
            </Button>
          </>
        )}
      </div>

      <Campo rotulo={t("agents.editor.name")}>
        <input
          className="border-border bg-background focus-visible:ring-ring w-full max-w-md rounded-md border px-3 py-1.5 text-sm outline-none focus-visible:ring-1"
          onChange={(e) => setRascunho((r) => ({ ...r, name: e.target.value }))}
          value={rascunho.name}
        />
      </Campo>

      <ol className="flex flex-col gap-3">
        {rascunho.steps.map((passo, i) => (
          <li key={passo.key}>
            {passo.type === "model" ? (
              <PassoDeModeloEditavel
                catalogo={catalogo}
                defaultTools={rascunho.defaultTools}
                indice={i}
                passo={passo}
                trocar={(novo) => trocarPasso(passo.key, novo)}
              />
            ) : (
              <PassoDeAcaoEditavel
                indice={i}
                modos={modos.get(passo.action)}
                passo={passo}
                trocar={(novo) => trocarPasso(passo.key, novo)}
              />
            )}
          </li>
        ))}
      </ol>

      <EditorDeOrcamento
        orcamento={rascunho.budget}
        trocar={(budget) => setRascunho((r) => ({ ...r, budget }))}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ passos */

function PassoDeModeloEditavel({
  catalogo,
  defaultTools,
  indice,
  passo,
  trocar,
}: {
  catalogo: Catalogo | null;
  defaultTools: ToolRef[];
  indice: number;
  passo: PassoDeModelo;
  trocar: (p: PassoDeModelo) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="border-border superficie rounded-lg border px-4 py-3" data-locum-passo-editavel={passo.key}>
      <Cabecalho indice={indice} tipo={passo.type}>
        <input
          aria-label={passo.key}
          className="border-border bg-background focus-visible:ring-ring min-w-40 flex-1 rounded-md border px-2 py-1 text-sm font-medium outline-none focus-visible:ring-1"
          onChange={(e) => trocar({ ...passo, name: e.target.value })}
          value={passo.name}
        />
      </Cabecalho>

      <div className="mt-3 grid gap-3">
        <Campo rotulo={t("agents.editor.step.model")}>
          <SeletorDeModelo
            catalogo={catalogo}
            trocar={(model) => trocar({ ...passo, model })}
            valor={passo.model}
          />
        </Campo>

        <Campo rotulo={t("agents.editor.step.prompt")}>
          <textarea
            className="border-border bg-background focus-visible:ring-ring w-full resize-y rounded-md border px-3 py-2 font-mono text-xs leading-relaxed outline-none focus-visible:ring-1"
            onChange={(e) => trocar({ ...passo, prompt: e.target.value })}
            rows={Math.min(18, Math.max(4, passo.prompt.split("\n").length + 1))}
            spellCheck={false}
            value={passo.prompt}
          />
        </Campo>

        <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs">
          <input
            checked={passo.optional}
            className="accent-primary cursor-pointer"
            onChange={(e) => trocar({ ...passo, optional: e.target.checked })}
            type="checkbox"
          />
          {t("agents.editor.step.optional")}
        </label>

        <Campo rotulo={t("agents.editor.step.tools")}>
          <SeletorDeFerramentas
            defaultTools={defaultTools}
            trocar={(tools) => trocar({ ...passo, tools })}
            valor={passo.tools}
          />
        </Campo>
      </div>
    </div>
  );
}

/**
 * O modo de uma ação, com o que ela aceita dito pelo próprio handler.
 *
 * Modo que o handler não aceita não aparece como opção. Criar tarefa só aceita
 * aprovação, então a tela mostra o motivo em vez de três botões e um erro
 * depois. A fila recusa o modo errado de qualquer jeito na hora de publicar.
 */
function PassoDeAcaoEditavel({
  indice,
  modos,
  passo,
  trocar,
}: {
  indice: number;
  modos: { modes: readonly ActionMode[]; holdsByContent: boolean } | undefined;
  passo: PassoDeAcao;
  trocar: (p: PassoDeAcao) => void;
}) {
  const { t } = useTranslation();
  const aceitos = modos?.modes ?? (["approve"] as const);

  return (
    <div className="border-border superficie rounded-lg border px-4 py-3" data-locum-passo-editavel={passo.key}>
      <Cabecalho indice={indice} tipo={passo.type}>
        <input
          aria-label={passo.key}
          className="border-border bg-background focus-visible:ring-ring min-w-40 flex-1 rounded-md border px-2 py-1 text-sm font-medium outline-none focus-visible:ring-1"
          onChange={(e) => trocar({ ...passo, name: e.target.value })}
          value={passo.name}
        />
        <code className="text-muted-foreground text-xs">{passo.action}</code>
      </Cabecalho>

      <Campo className="mt-3" rotulo={t("agents.editor.step.mode")}>
        {aceitos.length === 1 ? (
          <p className="text-muted-foreground text-xs">{t("agents.editor.mode.locked")}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {aceitos.map((modo) => (
              <label className="flex cursor-pointer items-center gap-2 text-sm" key={modo}>
                <input
                  checked={passo.mode === modo}
                  className="accent-primary cursor-pointer"
                  name={`modo-${passo.key}`}
                  onChange={() => trocar({ ...passo, mode: modo })}
                  type="radio"
                />
                <span className={cn(modo === "auto" && "text-sev-medium")}>
                  {t(`agents.editor.mode.${modo}`)}
                </span>
              </label>
            ))}
            {modos?.holdsByContent && (
              <p className="text-muted-foreground mt-1 text-xs">{t("agents.editor.mode.verdictHold")}</p>
            )}
          </div>
        )}
      </Campo>
    </div>
  );
}

/* ------------------------------------------------------------------ modelo */

/** O catálogo de todos os provedores, lido uma vez por edição. */
export function useCatalogo(): Catalogo | null {
  const [catalogo, setCatalogo] = useState<Catalogo | null>(null);
  useEffect(() => {
    let vivo = true;
    // Bate na rede de cada provedor, então lê uma vez e compartilha entre os
    // passos, em vez de uma leitura por seletor.
    call("providers.allModels", { assinatura: true })
      .then((c) => vivo && setCatalogo(c))
      .catch(() => vivo && setCatalogo([]));
    return () => {
      vivo = false;
    };
  }, []);
  return catalogo;
}

/**
 * Modelo escolhido do catálogo que cada provedor publica.
 *
 * Nunca texto livre: id de modelo digitado à mão quebra tarde, dentro de uma
 * execução, e acusa credencial quando o problema era o nome. O valor atual
 * aparece mesmo fora do catálogo, marcado, porque a tabela de substituição
 * desta máquina pode estar cobrindo ele.
 */
export function SeletorDeModelo({
  catalogo,
  trocar,
  valor,
}: {
  catalogo: Catalogo | null;
  trocar: (v: string) => void;
  valor: string;
}) {
  const { t } = useTranslation();

  if (catalogo === null) {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        {t("agents.editor.step.loadingCatalog")}
      </p>
    );
  }

  const conhecidos = new Set(catalogo.flatMap((c) => c.modelos.map((m) => `${c.provedor}/${m}`)));
  // Valor fora da lista continua escolhível: pode ser um id datado que o
  // Claude Code ainda aceita, ou um modelo que a tabela de substituição desta
  // máquina cobre. O aviso fica só para o provedor que não está ligado aqui,
  // que é o caso em que o passo de fato não roda.
  const fora = valor !== "" && !conhecidos.has(valor);
  const desligado = fora && !catalogo.some((c) => valor.startsWith(`${c.provedor}/`));
  const comModelo = catalogo.filter((c) => c.modelos.length > 0);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label={t("agents.editor.step.model")}
        className="border-border bg-background focus-visible:ring-ring max-w-md cursor-pointer rounded-md border px-2 py-1.5 text-sm outline-none focus-visible:ring-1"
        onChange={(e) => trocar(e.target.value)}
        title={valor}
        value={valor}
      >
        {fora && <option value={valor}>{rotuloDoModelo(valor)}</option>}
        {comModelo.map((c) => (
          <optgroup key={c.provedor} label={rotuloDoProvedor(c.provedor)}>
            {c.modelos.map((m) => (
              <option key={m} value={`${c.provedor}/${m}`}>
                {rotuloDoModelo(m)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {desligado && <span className="text-sev-medium text-xs">{t("agents.editor.step.notInCatalog")}</span>}
      {comModelo.length === 0 && (
        <span className="text-muted-foreground text-xs">{t("agents.editor.step.catalogEmpty")}</span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ ferramentas */

/**
 * Ferramenta escolhida por ferramenta, e não por servidor.
 *
 * Servidor inteiro põe dezenas de schemas no contexto a cada chamada, o que
 * custa token e piora a escolha do modelo. Por isso a lista de um servidor só
 * abre quando pedida, e a contagem de token aparece ao lado de cada uma e no
 * total. Sem ferramentas próprias, o passo herda as do agent.
 */
export function SeletorDeFerramentas({
  defaultTools,
  trocar,
  valor,
}: {
  defaultTools: ToolRef[];
  trocar: (v: ToolRef[] | undefined) => void;
  valor: ToolRef[] | undefined;
}) {
  const { t } = useTranslation();
  const servidores = useRead("mcp.list");

  if (valor === undefined) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">
          {t("agents.editor.tools.inherits", { count: defaultTools.length })}
        </span>
        <button
          className="text-primary cursor-pointer hover:underline"
          onClick={() => trocar([...defaultTools])}
          type="button"
        >
          {t("agents.editor.tools.customize")}
        </button>
      </div>
    );
  }

  const lista = servidores.data ?? [];

  return (
    <div className="flex flex-col gap-2">
      <button
        className="text-primary w-fit cursor-pointer text-xs hover:underline"
        onClick={() => trocar(undefined)}
        type="button"
      >
        {t("agents.editor.tools.inherit")}
      </button>
      {lista.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t("agents.editor.tools.noServers")}</p>
      ) : (
        lista
          .filter((s) => s.enabled)
          .map(({ config }) => (
            <FerramentasDoServidor
              key={config.name}
              marcadas={valor.filter((r) => r.server === config.name)}
              servidor={config.name}
              trocar={(doServidor) =>
                trocar([...valor.filter((r) => r.server !== config.name), ...doServidor])
              }
            />
          ))
      )}
    </div>
  );
}

export function FerramentasDoServidor({
  marcadas,
  servidor,
  trocar,
}: {
  marcadas: ToolRef[];
  servidor: string;
  trocar: (v: ToolRef[]) => void;
}) {
  const { t } = useTranslation();
  const [aberto, setAberto] = useState(marcadas.length > 0);
  const [ferramentas, setFerramentas] = useState<{ name: string; description: string; estimatedTokens: number }[] | null>(null);
  const [carregando, setCarregando] = useState(false);

  useEffect(() => {
    if (!aberto || ferramentas !== null || carregando) return;
    setCarregando(true);
    // Listar sobe o servidor, então só acontece quando alguém abriu a lista.
    call("mcp.tools", servidor)
      .then(setFerramentas)
      .catch(() => setFerramentas([]))
      .finally(() => setCarregando(false));
  }, [aberto, ferramentas, carregando, servidor]);

  const marcadasPorNome = new Set(marcadas.map((m) => m.tool));
  const tokens = (ferramentas ?? [])
    .filter((f) => marcadasPorNome.has(f.name))
    .reduce((acc, f) => acc + f.estimatedTokens, 0);

  return (
    <div className="border-border rounded-md border">
      <button
        className="hover:bg-accent/40 flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs"
        onClick={() => setAberto((a) => !a)}
        type="button"
      >
        {aberto ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
        <span className="font-mono">{servidor}</span>
        {marcadas.length > 0 && (
          <span className="text-muted-foreground ml-auto">
            {t("agents.editor.tools.total", { count: marcadas.length, tokens })}
          </span>
        )}
      </button>

      {aberto && (
        <div className="border-border border-t px-3 py-2">
          {carregando || ferramentas === null ? (
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              {t("agents.editor.tools.loading")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {ferramentas.map((f) => (
                <li key={f.name}>
                  <label className="flex cursor-pointer items-baseline gap-2 text-xs">
                    <input
                      checked={marcadasPorNome.has(f.name)}
                      className="accent-primary cursor-pointer"
                      onChange={(e) =>
                        trocar(
                          e.target.checked
                            ? [...marcadas, { server: servidor, tool: f.name, class: "read" }]
                            : marcadas.filter((m) => m.tool !== f.name),
                        )
                      }
                      type="checkbox"
                    />
                    <span className="font-mono">{f.name}</span>
                    <span className="text-muted-foreground min-w-0 flex-1 truncate">{f.description}</span>
                    <span className="text-muted-foreground shrink-0 font-mono tabular-nums">
                      {t("agents.editor.tools.tokens", { tokens: f.estimatedTokens })}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- orçamento */

function EditorDeOrcamento({
  orcamento,
  trocar,
}: {
  orcamento: AgentSpec["budget"];
  trocar: (b: AgentSpec["budget"]) => void;
}) {
  const { t } = useTranslation();
  const campos = ["perRunUsd", "perDayUsd", "perRunTokens", "perDayTokens"] as const;

  return (
    <Campo rotulo={t("agents.editor.budget.title")}>
      <div className="grid max-w-xl grid-cols-2 gap-2">
        {campos.map((campo) => (
          <label className="flex flex-col gap-1 text-xs" key={campo}>
            <span className="text-muted-foreground">{t(`agents.editor.budget.${campo}`)}</span>
            <input
              className="border-border bg-background focus-visible:ring-ring rounded-md border px-2 py-1 font-mono tabular-nums outline-none focus-visible:ring-1"
              inputMode="decimal"
              min={0}
              onChange={(e) => {
                const texto = e.target.value.trim();
                const numero = Number(texto);
                const proximo = { ...orcamento };
                if (texto === "" || !Number.isFinite(numero) || numero <= 0) delete proximo[campo];
                else proximo[campo] = campo.endsWith("Tokens") ? Math.round(numero) : numero;
                trocar(proximo);
              }}
              placeholder={t("agents.editor.budget.empty")}
              type="number"
              value={orcamento[campo] ?? ""}
            />
          </label>
        ))}
      </div>
    </Campo>
  );
}

/* ---------------------------------------------------------------- revisão */

/**
 * A diferença antes de gravar, e a nota que vira o registro.
 *
 * Salvar sem ver o que mudou é o jeito mais comum de gravar um passo com o
 * modelo errado sem perceber. A nota é obrigatória, e o serviço recusa sem ela.
 */
function RevisaoAntesDeSalvar({
  antes,
  depois,
  erro,
  nota,
  proxima,
  salvando,
  setNota,
  aoSalvar,
  aoVoltar,
}: {
  antes: AgentSpec;
  depois: AgentSpec;
  erro: string | null;
  nota: string;
  proxima: number;
  salvando: boolean;
  setNota: (n: string) => void;
  aoSalvar: () => void;
  aoVoltar: () => void;
}) {
  const { t } = useTranslation();
  const linhas = useMemo(() => comContexto(diffJson(antes, depois)), [antes, depois]);
  const mudadas = linhas.filter((l) => l.tipo !== "igual").length;

  return (
    <div className="flex flex-col gap-4" data-locum-probe="editor-revisao">
      <div className="flex items-center gap-3">
        <Button className="cursor-pointer" onClick={aoVoltar} size="sm" variant="ghost">
          {t("agents.editor.back")}
        </Button>
        <span className="text-muted-foreground text-xs">
          {mudadas === 0 ? t("agents.editor.unchanged") : t("agents.editor.changes", { count: mudadas })}
        </span>
      </div>

      <div className="border-border superficie max-h-96 overflow-auto rounded-lg border py-2 font-mono text-xs">
        {linhas.map((linha, i) => (
          <LinhaDeDiff key={i} linha={linha} />
        ))}
      </div>

      <Campo rotulo={t("agents.editor.note")}>
        <textarea
          className="border-border bg-background focus-visible:ring-ring w-full max-w-xl resize-y rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-1"
          onChange={(e) => setNota(e.target.value)}
          placeholder={t("agents.editor.notePlaceholder")}
          rows={2}
          value={nota}
        />
        <p className="text-muted-foreground mt-1 text-xs">{t("agents.editor.noteHint")}</p>
      </Campo>

      {erro && <p className="text-sev-critical text-sm">{erro}</p>}

      <div>
        <Button
          className="cursor-pointer"
          data-locum-editor-salvar=""
          disabled={salvando || nota.trim().length === 0 || mudadas === 0}
          onClick={aoSalvar}
        >
          {salvando ? t("agents.editor.saving") : t("agents.editor.save", { version: proxima })}
        </Button>
      </div>
    </div>
  );
}

function LinhaDeDiff({ linha }: { linha: LinhaDoDiff }) {
  return (
    <div
      className={cn(
        "px-3 whitespace-pre",
        linha.tipo === "entrou" && "bg-chart-2/15",
        linha.tipo === "saiu" && "bg-sev-critical/15 text-muted-foreground",
      )}
    >
      {linha.tipo === "entrou" ? "+ " : linha.tipo === "saiu" ? "- " : "  "}
      {linha.texto}
    </div>
  );
}

/* ------------------------------------------------------------------ comuns */

function Cabecalho({
  children,
  indice,
  tipo,
}: {
  children: React.ReactNode;
  indice: number;
  tipo: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground tabular-nums text-sm">{indice + 1}</span>
      {children}
      <span className="border-border text-muted-foreground rounded border px-1.5 text-[11px]">
        {t(`agents.editor.kind.${tipo}`, { defaultValue: tipo })}
      </span>
    </div>
  );
}

function Campo({
  children,
  className,
  rotulo,
}: {
  children: React.ReactNode;
  className?: string;
  rotulo: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-xs font-medium">{rotulo}</span>
      {children}
    </div>
  );
}
