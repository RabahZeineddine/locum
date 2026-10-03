import { Button } from "@/components/ui/button";
import {
  ACOES_POR_PARAMETRO,
  anteriores,
  componenteDoPasso,
  ehGatilho,
  FORMATOS,
  formatoDe,
  trocarPasso,
  variaveis,
  type AgentDaBiblioteca,
  type Formato,
  type PassoDeAcao,
  type PassoDeIA,
  type Problema,
  type Rascunho,
} from "@/lib/automacao";
import { call, useRead, type ReadResult } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import { Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TriggerConfig } from "../../../src/config/types";
import { parseCron, proximaOcorrencia } from "../../../src/triggers/cron";
import { SeletorDeFerramentas, SeletorDeModelo, useCatalogo } from "../editor-agent";
import type { RotaId } from "../rotas";
import { appDoGatilho, appDoPasso, Selo, tituloDoGatilho, tituloDoPasso } from "./visual";

type Tracker = ReadResult<"trackers.list">[number];

const CAMPO =
  "border-border bg-background focus-visible:ring-ring w-full rounded-md border px-2.5 py-1.5 text-sm outline-none focus-visible:ring-1";

const PRESETS_DE_CRON = [
  ["weekdays9", "0 9 * * 1-5"],
  ["daily8", "0 8 * * *"],
  ["hourly", "0 * * * *"],
  ["monday9", "0 9 * * 1"],
] as const;

/**
 * O painel do nó selecionado. Mexe só no rascunho: nada grava até o Salvar do
 * cabeçalho, e por isso fechar o painel não perde o que foi escrito.
 */
export function PainelDoNo({
  chave,
  rascunho,
  setRascunho,
  trackers,
  agents,
  problemas,
  remover,
  fechar,
  navegar,
  relerBiblioteca,
}: {
  chave: string;
  agents: readonly AgentDaBiblioteca[];
  navegar: (id: RotaId, detalhe?: string) => void;
  relerBiblioteca: () => Promise<void>;
  rascunho: Rascunho;
  setRascunho: (f: (r: Rascunho) => Rascunho) => void;
  trackers: readonly Tracker[];
  problemas: readonly Problema[];
  remover: () => void;
  fechar: () => void;
}) {
  const { t } = useTranslation();
  const gatilho = ehGatilho(chave) ? rascunho.gatilhos.find((g) => g.chave === chave) : undefined;
  const passo = ehGatilho(chave) ? undefined : rascunho.spec.steps.find((p) => p.key === chave);
  if (gatilho === undefined && passo === undefined) return null;

  const cabecalho =
    gatilho !== undefined
      ? { app: appDoGatilho(gatilho.config.kind), id: gatilho.config.kind, titulo: tituloDoGatilho(t, gatilho.config) }
      : (() => {
          const id = componenteDoPasso(passo!);
          return { app: appDoPasso(id), id, titulo: tituloDoPasso(t, id) };
        })();

  const trocarGatilho = (config: TriggerConfig): void =>
    setRascunho((r) => ({ ...r, gatilhos: r.gatilhos.map((g) => (g.chave === chave ? { ...g, config } : g)) }));

  return (
    <aside
      className="border-border superficie flex w-80 shrink-0 flex-col gap-4 overflow-y-auto rounded-lg border p-3"
      data-locum-probe="automacao-painel"
      data-locum-painel={chave}
    >
      <div className="flex items-center gap-2">
        <Selo app={cabecalho.app} id={cabecalho.id} />
        <span className="flex-1 truncate font-medium text-sm">{cabecalho.titulo}</span>
        <button
          aria-label={t("automations.panel.close")}
          className="text-muted-foreground hover:text-foreground cursor-pointer rounded p-1"
          onClick={fechar}
          type="button"
        >
          <X className="size-4" />
        </button>
      </div>

      {problemas.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs">
          {problemas.map((p, i) => (
            <li className={p.bloqueia ? "text-sev-critical" : "text-amber-500"} key={i}>
              {t(p.chave)}
            </li>
          ))}
        </ul>
      ) : null}

      {gatilho !== undefined ? (
        <>
          <p className="text-muted-foreground text-xs">{t(`automations.triggers.${gatilho.config.kind}.help`, { defaultValue: "" })}</p>
          <ConfigDoGatilho config={gatilho.config} trocar={trocarGatilho} />
          <Alternador
            ligado={gatilho.enabled}
            rotulo={t("automations.panel.enabled")}
            trocar={(enabled) =>
              setRascunho((r) => ({ ...r, gatilhos: r.gatilhos.map((g) => (g.chave === chave ? { ...g, enabled } : g)) }))
            }
          />
        </>
      ) : passo!.type === "model" && passo!.profile !== undefined ? (
        <ConfigDoAgent agents={agents} chave={chave} navegar={navegar} passo={passo as PassoDeIA} rascunho={rascunho} setRascunho={setRascunho} />
      ) : passo!.type === "model" ? (
        <ConfigDaIA
          chave={chave}
          passo={passo as PassoDeIA}
          rascunho={rascunho}
          relerBiblioteca={relerBiblioteca}
          setRascunho={setRascunho}
        />
      ) : (
        <ConfigDaAcao passo={passo as PassoDeAcao} rascunho={rascunho} setRascunho={setRascunho} trackers={trackers} />
      )}

      <Button className="mt-auto cursor-pointer self-start" onClick={remover} size="sm" variant="ghost">
        <Trash2 className="size-4" />
        {t("automations.panel.remove")}
      </Button>
    </aside>
  );
}

/* ----------------------------------------------------------------- gatilho */

function ConfigDoGatilho({ config, trocar }: { config: TriggerConfig; trocar: (c: TriggerConfig) => void }) {
  const { t } = useTranslation();
  switch (config.kind) {
    case "cron":
      return <ConfigDoCron expressao={config.expression} trocar={(expression) => trocar({ ...config, expression })} />;
    case "schedule":
      return (
        <Minutos rotulo={t("automations.panel.everyMinutes")} valor={config.everyMinutes} trocar={(everyMinutes) => trocar({ ...config, everyMinutes })} />
      );
    case "slack-channel":
      return (
        <>
          <CanaisDoSlack canais={config.channels} trocar={(channels) => trocar({ ...config, channels })} />
          <Minutos rotulo={t("automations.panel.everyMinutes")} valor={config.everyMinutes} trocar={(everyMinutes) => trocar({ ...config, everyMinutes })} />
        </>
      );
    case "slack-inbox":
    case "teams-inbox":
      return (
        <>
          <Alternador
            ligado={config.mentions}
            rotulo={t(`automations.triggers.${config.kind}.mentions`)}
            trocar={(mentions) => trocar({ ...config, mentions })}
          />
          <Alternador
            ligado={config.dms}
            rotulo={t(`automations.triggers.${config.kind}.dms`)}
            trocar={(dms) => trocar({ ...config, dms })}
          />
          {config.kind === "teams-inbox" ? (
            <CanaisDoTeams canais={config.channels} trocar={(channels) => trocar({ ...config, channels })} />
          ) : null}
          <Minutos rotulo={t("automations.panel.everyMinutes")} valor={config.everyMinutes} trocar={(everyMinutes) => trocar({ ...config, everyMinutes })} />
        </>
      );
    case "poll":
      return (
        <>
          <Campo rotulo={t("automations.triggers.poll.owner")}>
            <input
              className={CAMPO}
              onChange={(e) => {
                const owner = e.target.value.trim();
                const { owner: _antigo, ...resto } = config;
                trocar(owner === "" ? resto : { ...resto, owner });
              }}
              value={config.owner ?? ""}
            />
          </Campo>
          <Campo rotulo={t("automations.triggers.poll.repoMatch")}>
            <input className={CAMPO} onChange={(e) => trocar({ ...config, repoMatch: e.target.value || ".*" })} value={config.repoMatch} />
          </Campo>
          <Campo rotulo={t("automations.triggers.poll.authorship")}>
            <select
              className={CAMPO}
              onChange={(e) => trocar({ ...config, authorship: e.target.value as typeof config.authorship })}
              value={config.authorship}
            >
              {(["any", "mine", "others"] as const).map((a) => (
                <option key={a} value={a}>
                  {t(`automations.triggers.poll.${a}`)}
                </option>
              ))}
            </select>
          </Campo>
          <Minutos rotulo={t("automations.panel.everyMinutes")} valor={config.everyMinutes} trocar={(everyMinutes) => trocar({ ...config, everyMinutes })} />
        </>
      );
    default:
      return null;
  }
}

function ConfigDoCron({ expressao, trocar }: { expressao: string; trocar: (e: string) => void }) {
  const { t, i18n } = useTranslation();
  let erro: string | null = null;
  let proxima: number | null = null;
  try {
    proxima = proximaOcorrencia(parseCron(expressao), Date.now());
  } catch (e) {
    erro = e instanceof Error ? e.message : String(e);
  }
  return (
    <>
      <Campo rotulo={t("automations.triggers.cron.expression")}>
        <input
          className={cn(CAMPO, "font-mono", erro !== null && "border-destructive")}
          data-locum-cron=""
          onChange={(e) => trocar(e.target.value)}
          value={expressao}
        />
      </Campo>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS_DE_CRON.map(([id, valor]) => (
          <button
            className={cn(
              "border-border cursor-pointer rounded-full border px-2.5 py-0.5 text-xs transition-colors",
              valor === expressao ? "border-primary bg-primary/10" : "hover:border-foreground/30",
            )}
            key={id}
            onClick={() => trocar(valor)}
            type="button"
          >
            {t(`automations.triggers.cron.presets.${id}`)}
          </button>
        ))}
      </div>
      <p className={cn("text-xs", erro === null ? "text-muted-foreground" : "text-sev-critical")}>
        {erro !== null
          ? t("automations.triggers.cron.invalid", { message: erro })
          : proxima === null
            ? t("automations.triggers.cron.never")
            : t("automations.triggers.cron.next", {
                when: new Date(proxima).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" }),
              })}
      </p>
    </>
  );
}

function CanaisDoSlack({ canais, trocar }: { canais: readonly string[]; trocar: (c: string[]) => void }) {
  const { t } = useTranslation();
  const [novo, setNovo] = useState("");
  const valido = /^[CG][A-Z0-9]{6,}$/.test(novo.trim().toUpperCase());
  const acrescentar = (): void => {
    const id = novo.trim().toUpperCase();
    if (!valido || canais.includes(id)) return;
    trocar([...canais, id]);
    setNovo("");
  };
  return (
    <Campo rotulo={t("automations.triggers.slack-channel.channels")}>
      <div className="flex flex-wrap gap-1.5">
        {canais.map((c) => (
          <span className="bg-muted flex items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5 font-mono text-xs" key={c}>
            {c}
            <button
              aria-label={t("automations.triggers.slack-channel.remove", { channel: c })}
              className="hover:text-foreground text-muted-foreground cursor-pointer rounded-full p-0.5"
              onClick={() => trocar(canais.filter((x) => x !== c))}
              type="button"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1.5">
        <input
          className={cn(CAMPO, "font-mono")}
          data-locum-canal-novo=""
          onChange={(e) => setNovo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") acrescentar();
          }}
          placeholder={t("automations.triggers.slack-channel.placeholder")}
          value={novo}
        />
        <Button className="cursor-pointer" disabled={!valido} onClick={acrescentar} size="sm" variant="outline">
          {t("automations.triggers.slack-channel.add")}
        </Button>
      </div>
      <p className="text-muted-foreground text-[11px]">{t("automations.triggers.slack-channel.hint")}</p>
    </Campo>
  );
}

type CanalDoTeams = Extract<TriggerConfig, { kind: "teams-inbox" }>["channels"][number];

/**
 * Canais de equipe do Teams. A lista vem do Graph e só chega por clique: é
 * rede, e pede os escopos de canal que a conexão pode não ter.
 */
function CanaisDoTeams({ canais, trocar }: { canais: readonly CanalDoTeams[]; trocar: (c: CanalDoTeams[]) => void }) {
  const { t } = useTranslation();
  const [opcoes, setOpcoes] = useState<ReadResult<"connections.teamsChannels"> | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [lendo, setLendo] = useState(false);
  const marcado = (teamId: string, channelId: string): boolean =>
    canais.some((c) => c.teamId === teamId && c.channelId === channelId);

  const listar = (): void => {
    setLendo(true);
    setErro(null);
    call("connections.teamsChannels").then(
      (lista) => {
        setOpcoes(lista);
        setLendo(false);
      },
      (e: unknown) => {
        setErro(e instanceof Error ? e.message : String(e));
        setLendo(false);
      },
    );
  };

  return (
    <Campo rotulo={t("automations.triggers.teams-inbox.channels")}>
      {canais.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5">
          {canais.map((c) => (
            <span className="bg-muted flex items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5 text-xs" key={`${c.teamId}/${c.channelId}`}>
              {c.label ?? c.channelId}
              <button
                aria-label={t("automations.triggers.slack-channel.remove", { channel: c.label ?? c.channelId })}
                className="hover:text-foreground text-muted-foreground cursor-pointer rounded-full p-0.5"
                onClick={() => trocar(canais.filter((x) => !(x.teamId === c.teamId && x.channelId === c.channelId)))}
                type="button"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {opcoes === null ? (
        <Button className="cursor-pointer self-start" disabled={lendo} onClick={listar} size="sm" variant="outline">
          {t(lendo ? "automations.triggers.teams-inbox.loading" : "automations.triggers.teams-inbox.list")}
        </Button>
      ) : (
        <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto text-xs">
          {opcoes.map((o) => (
            <li key={`${o.teamId}/${o.channelId}`}>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  checked={marcado(o.teamId, o.channelId)}
                  className="accent-primary cursor-pointer"
                  onChange={(e) =>
                    trocar(
                      e.target.checked
                        ? [...canais, { teamId: o.teamId, channelId: o.channelId, label: `${o.teamName} / ${o.channelName}` }]
                        : canais.filter((x) => !(x.teamId === o.teamId && x.channelId === o.channelId)),
                    )
                  }
                  type="checkbox"
                />
                {o.teamName} / {o.channelName}
              </label>
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground text-[11px]">{t("automations.triggers.teams-inbox.channelsHint")}</p>
      {erro === null ? null : <p className="text-sev-critical text-xs">{erro}</p>}
    </Campo>
  );
}

/* ------------------------------------------------------------------- passo */

/** Instrução com as variáveis clicáveis e o formato da saída: igual no agent e na IA avulsa. */
function TarefaEFormato({
  chave,
  passo,
  rascunho,
  trocar,
  rotulo,
  dica,
}: {
  chave: string;
  passo: PassoDeIA;
  rascunho: Rascunho;
  trocar: (novo: PassoDeIA) => void;
  rotulo: string;
  dica?: string;
}) {
  const { t } = useTranslation();
  const caixa = useRef<HTMLTextAreaElement>(null);
  const formato = formatoDe(passo);
  const disponiveis = variaveis(rascunho, chave);

  const inserir = (variavel: string): void => {
    const el = caixa.current;
    const trecho = `{{${variavel}}}`;
    const inicio = el?.selectionStart ?? passo.prompt.length;
    const fim = el?.selectionEnd ?? passo.prompt.length;
    trocar({ ...passo, prompt: passo.prompt.slice(0, inicio) + trecho + passo.prompt.slice(fim) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(inicio + trecho.length, inicio + trecho.length);
    });
  };

  return (
    <>
      <Campo rotulo={rotulo}>
        <textarea
          className={cn(CAMPO, "min-h-40 resize-y font-mono text-xs leading-relaxed")}
          data-locum-prompt=""
          onChange={(e) => trocar({ ...passo, prompt: e.target.value })}
          ref={caixa}
          value={passo.prompt}
        />
        {dica === undefined ? null : <p className="text-muted-foreground text-[11px]">{dica}</p>}
        {disponiveis.length > 0 ? (
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-[11px]">{t("automations.steps.ai.variables")}</span>
            <div className="flex flex-wrap gap-1">
              {disponiveis.map((v) => (
                <button
                  className="bg-muted hover:bg-muted/70 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px]"
                  key={v}
                  onClick={() => inserir(v)}
                  type="button"
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </Campo>
      <Campo rotulo={t("automations.steps.ai.format")}>
        <select
          className={CAMPO}
          onChange={(e) => {
            const f = e.target.value as Formato | "livre";
            const { outputSchema: _antigo, ...resto } = passo;
            trocar(f === "livre" ? resto : { ...resto, outputSchema: FORMATOS[f] });
          }}
          value={formato}
        >
          <option value="livre">{t("automations.steps.ai.formats.livre")}</option>
          {(Object.keys(FORMATOS) as Formato[]).map((f) => (
            <option key={f} value={f}>
              {t(`automations.steps.ai.formats.${f}`)}
            </option>
          ))}
          {formato === "outro" ? (
            <option disabled value="outro">
              {t("automations.steps.ai.formats.outro")}
            </option>
          ) : null}
        </select>
      </Campo>
    </>
  );
}

/** Passo com agent da biblioteca: quem trabalha vem de lá, a tarefa é daqui. */
function ConfigDoAgent({
  chave,
  passo,
  rascunho,
  setRascunho,
  agents,
  navegar,
}: {
  chave: string;
  passo: PassoDeIA;
  rascunho: Rascunho;
  setRascunho: (f: (r: Rascunho) => Rascunho) => void;
  agents: readonly AgentDaBiblioteca[];
  navegar: (id: RotaId, detalhe?: string) => void;
}) {
  const { t } = useTranslation();
  const trocar = (novo: PassoDeIA): void => setRascunho((r) => ({ ...r, spec: trocarPasso(r.spec, passo.key, novo) }));
  const atual = agents.find((a) => a.id === passo.profile);

  return (
    <>
      <Campo rotulo={t("automations.steps.agent.choose")}>
        {agents.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("automations.steps.agent.none")}</p>
        ) : (
          <select
            className={CAMPO}
            data-locum-passo-agent=""
            onChange={(e) => {
              const escolhido = agents.find((a) => a.id === e.target.value);
              if (escolhido === undefined) return;
              // O nome acompanha a troca só quando ainda era o do agent antigo:
              // nome escrito à mão pela pessoa fica.
              const nome = passo.name === (atual?.name ?? "") ? escolhido.name : passo.name;
              trocar({ ...passo, profile: escolhido.id, model: escolhido.model, name: nome });
            }}
            value={passo.profile}
          >
            {atual === undefined ? <option value={passo.profile}>{passo.profile}</option> : null}
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        {atual === undefined ? null : (
          <button
            className="text-primary w-fit cursor-pointer text-xs hover:underline"
            onClick={() => navegar("library", atual.id)}
            type="button"
          >
            {t("automations.steps.agent.open")}
          </button>
        )}
      </Campo>
      <Campo rotulo={t("automations.panel.name")}>
        <input className={CAMPO} onChange={(e) => trocar({ ...passo, name: e.target.value })} value={passo.name} />
      </Campo>
      <TarefaEFormato
        chave={chave}
        dica={t("automations.steps.agent.taskHint")}
        passo={passo}
        rascunho={rascunho}
        rotulo={t("automations.steps.agent.task")}
        trocar={trocar}
      />
    </>
  );
}

function ConfigDaIA({
  chave,
  passo,
  rascunho,
  setRascunho,
  relerBiblioteca,
}: {
  chave: string;
  passo: PassoDeIA;
  rascunho: Rascunho;
  setRascunho: (f: (r: Rascunho) => Rascunho) => void;
  relerBiblioteca: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const catalogo = useCatalogo();
  const [levando, setLevando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const trocar = (novo: PassoDeIA): void => setRascunho((r) => ({ ...r, spec: trocarPasso(r.spec, passo.key, novo) }));

  // O agent nasce com o que é de quem trabalha (modelo, ferramentas, limite de
  // passos); a instrução fica no passo como tarefa, porque cita o evento e os
  // passos anteriores deste fluxo e não faria sentido em outro.
  const levarParaBiblioteca = async (): Promise<void> => {
    setLevando(true);
    setErro(null);
    try {
      const id = await call("library.suggestId", passo.name, "profile");
      await call("library.saveProfile", {
        spec: {
          id,
          name: passo.name,
          model: passo.model,
          tools: passo.tools ?? rascunho.spec.defaultTools,
          maxSteps: passo.maxSteps,
        },
        create: true,
      });
      await relerBiblioteca();
      const { tools: _tools, ...resto } = passo;
      trocar({ ...resto, profile: id });
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setLevando(false);
    }
  };

  return (
    <>
      <Campo rotulo={t("automations.panel.name")}>
        <input className={CAMPO} onChange={(e) => trocar({ ...passo, name: e.target.value })} value={passo.name} />
      </Campo>
      <Campo rotulo={t("automations.steps.ai.model")}>
        <SeletorDeModelo catalogo={catalogo} trocar={(model) => trocar({ ...passo, model })} valor={passo.model} />
      </Campo>
      <TarefaEFormato chave={chave} passo={passo} rascunho={rascunho} rotulo={t("automations.steps.ai.prompt")} trocar={trocar} />
      <Campo rotulo={t("automations.steps.ai.tools")}>
        <SeletorDeFerramentas
          defaultTools={rascunho.spec.defaultTools}
          trocar={(tools) => {
            const { tools: _antigas, ...resto } = passo;
            trocar(tools === undefined ? resto : { ...resto, tools });
          }}
          valor={passo.tools}
        />
      </Campo>
      <div className="border-border flex flex-col gap-1.5 border-t pt-3">
        <Button
          className="cursor-pointer self-start"
          data-locum-levar-para-biblioteca=""
          disabled={levando || passo.name.trim() === ""}
          onClick={() => void levarParaBiblioteca()}
          size="sm"
          variant="outline"
        >
          {t("automations.steps.agent.toLibrary")}
        </Button>
        <p className="text-muted-foreground text-[11px]">{t("automations.steps.agent.toLibraryHint")}</p>
        {erro === null ? null : <p className="text-sev-critical text-xs">{erro}</p>}
      </div>
    </>
  );
}

function ConfigDaAcao({
  passo,
  rascunho,
  setRascunho,
  trackers,
}: {
  passo: PassoDeAcao;
  rascunho: Rascunho;
  setRascunho: (f: (r: Rascunho) => Rascunho) => void;
  trackers: readonly Tracker[];
}) {
  const { t } = useTranslation();
  const trocar = (novo: PassoDeAcao): void => setRascunho((r) => ({ ...r, spec: trocarPasso(r.spec, passo.key, novo) }));
  const antes = anteriores(rascunho.spec, passo.key);
  const doModelo = antes.filter((k) => rascunho.spec.steps.find((p) => p.key === k)?.type === "model");

  return (
    <>
      <p className="text-muted-foreground text-xs">{t(`automations.steps.${passo.action}.description`, { defaultValue: "" })}</p>
      <Campo rotulo={t("automations.panel.name")}>
        <input className={CAMPO} onChange={(e) => trocar({ ...passo, name: e.target.value })} value={passo.name} />
      </Campo>
      {ACOES_POR_PARAMETRO.has(passo.action) ? null : (
        <Campo rotulo={t("automations.panel.input")}>
          <select
            className={CAMPO}
            onChange={(e) => {
              const { input: _antigo, ...resto } = passo;
              trocar(e.target.value === "" ? resto : { ...resto, input: e.target.value });
            }}
            value={passo.input ?? ""}
          >
            <option value="">{t("automations.panel.inputNone")}</option>
            {doModelo.map((k) => (
              <option key={k} value={k}>
                {rascunho.spec.steps.find((p) => p.key === k)?.name ?? k}
              </option>
            ))}
          </select>
        </Campo>
      )}
      {passo.action === "mcp.call" ? <ConfigDaChamada passo={passo} rascunho={rascunho} trocar={trocar} /> : null}
      {passo.action === "http.request" ? <ConfigDoHttp passo={passo} rascunho={rascunho} trocar={trocar} /> : null}
      {passo.action === "tracker.create_issue" ? (
        <Campo rotulo={t("automations.steps.tracker.create_issue.tracker")}>
          {trackers.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t("automations.steps.tracker.create_issue.none")}</p>
          ) : (
            <select
              className={CAMPO}
              onChange={(e) => {
                const { target: _antigo, ...resto } = passo;
                trocar(e.target.value === "" ? resto : { ...resto, target: e.target.value });
              }}
              value={passo.target ?? ""}
            >
              <option value="">{t("automations.steps.tracker.create_issue.choose")}</option>
              {trackers.map((tr) => (
                <option key={tr.id} value={tr.id}>
                  {tr.label}
                </option>
              ))}
            </select>
          )}
        </Campo>
      ) : null}
      <ModoDaAcao passo={passo} trocar={trocar} />
    </>
  );
}

/**
 * Aprovar ou automático. Os modos vêm do próprio handler: ação que só aceita
 * aprovação (abrir tarefa, por exemplo) mostra o aviso e não oferece troca.
 */
function ModoDaAcao({ passo, trocar }: { passo: PassoDeAcao; trocar: (novo: PassoDeAcao) => void }) {
  const { t } = useTranslation();
  const descricao = useRead("actions.describe");
  const modos = descricao.data?.find((d) => d.kind === passo.action)?.modes ?? ["approve"];
  const oferecidos = modos.filter((m) => m !== "draft" || passo.action === "github.review_comment");
  return (
    <Campo rotulo={t("automations.panel.mode")}>
      {oferecidos.length > 1 ? (
        <div className="flex gap-1.5">
          {oferecidos.map((m) => (
            <button
              aria-pressed={passo.mode === m}
              className={cn(
                "border-border cursor-pointer rounded-full border px-3 py-1 text-xs transition-colors",
                passo.mode === m ? "border-primary bg-primary/10" : "hover:border-foreground/30",
              )}
              data-locum-modo={m}
              key={m}
              onClick={() => trocar({ ...passo, mode: m })}
              type="button"
            >
              {t(`automations.panel.modes.${m}`)}
            </button>
          ))}
        </div>
      ) : null}
      <p className={cn("text-xs", passo.mode === "auto" ? "text-sev-critical" : "text-amber-500")}>
        {t(passo.mode === "auto" ? "automations.panel.autoHint" : oferecidos.length > 1 ? "automations.panel.approval" : "automations.panel.approvalOnly")}
      </p>
    </Campo>
  );
}

/* ------------------------------------------------------ ações por parâmetro */

/**
 * Insere `{{variavel}}` no último campo de texto que teve foco. Um painel de
 * ação tem vários campos, e uma fileira de botões por campo esconderia o
 * formulário.
 */
function useInsercao() {
  const alvo = useRef<{ el: HTMLInputElement | HTMLTextAreaElement; aplicar: (v: string) => void } | null>(null);
  const focar = (aplicar: (v: string) => void) => (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
    alvo.current = { el: e.currentTarget, aplicar };
  };
  const inserir = (variavel: string): void => {
    const atual = alvo.current;
    if (atual === null) return;
    const { el, aplicar } = atual;
    const trecho = `{{${variavel}}}`;
    const inicio = el.selectionStart ?? el.value.length;
    const fim = el.selectionEnd ?? el.value.length;
    aplicar(el.value.slice(0, inicio) + trecho + el.value.slice(fim));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(inicio + trecho.length, inicio + trecho.length);
    });
  };
  return { focar, inserir };
}

function Variaveis({ lista, inserir }: { lista: readonly string[]; inserir: (v: string) => void }) {
  const { t } = useTranslation();
  if (lista.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-[11px]">{t("automations.panel.variablesFocused")}</span>
      <div className="flex flex-wrap gap-1">
        {lista.map((v) => (
          <button
            className="bg-muted hover:bg-muted/70 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px]"
            key={v}
            // mousedown, e não click: o click tiraria o foco do campo antes de inserir.
            onMouseDown={(e) => {
              e.preventDefault();
              inserir(v);
            }}
            type="button"
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  );
}

type Esquema = { properties?: Record<string, { type?: string | string[]; description?: string }>; required?: string[] };
type FerramentaDoApp = { name: string; description: string; inputSchema?: Record<string, unknown> };

/** Texto do campo de volta ao tipo que o esquema pede, quando é literal. */
function valorDoCampo(texto: string, tipo: string | undefined): unknown {
  if (texto.includes("{{")) return texto;
  if ((tipo === "number" || tipo === "integer") && texto.trim() !== "" && Number.isFinite(Number(texto))) return Number(texto);
  if (tipo === "boolean" && (texto === "true" || texto === "false")) return texto === "true";
  if ((tipo === "object" || tipo === "array") && texto.trim() !== "") {
    try {
      return JSON.parse(texto);
    } catch {
      return texto;
    }
  }
  return texto;
}

function textoDoValor(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Qualquer ferramenta de um app conectado, com o formulário do esquema dela. */
function ConfigDaChamada({
  passo,
  rascunho,
  trocar,
}: {
  passo: PassoDeAcao;
  rascunho: Rascunho;
  trocar: (novo: PassoDeAcao) => void;
}) {
  const { t } = useTranslation();
  const servidores = useRead("mcp.list");
  const params = (passo.params ?? {}) as { server?: string; tool?: string; args?: Record<string, unknown> };
  const servidor = params.server ?? "";
  const [ferramentas, setFerramentas] = useState<{ de: string; lista: FerramentaDoApp[] } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const { focar, inserir } = useInsercao();

  useEffect(() => {
    if (servidor === "" || ferramentas?.de === servidor) return;
    let vivo = true;
    setErro(null);
    // Listar sobe o servidor do app, então só acontece com um escolhido.
    call("mcp.tools", servidor).then(
      (lista) => vivo && setFerramentas({ de: servidor, lista }),
      (e: unknown) => vivo && setErro(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      vivo = false;
    };
  }, [servidor, ferramentas?.de]);

  const mudar = (novo: Partial<typeof params>): void => trocar({ ...passo, params: { ...params, ...novo } });
  const escolhida = ferramentas?.de === servidor ? ferramentas.lista.find((f) => f.name === params.tool) : undefined;
  const esquema = (escolhida?.inputSchema ?? {}) as Esquema;
  const campos = Object.entries(esquema.properties ?? {});
  const obrigatorios = new Set(esquema.required ?? []);
  const args = params.args ?? {};

  return (
    <>
      <Campo rotulo={t("automations.steps.mcp.call.server")}>
        <select
          className={CAMPO}
          data-locum-acao-servidor=""
          onChange={(e) => mudar({ server: e.target.value, tool: "", args: {} })}
          value={servidor}
        >
          <option value="">{t("automations.steps.mcp.call.chooseServer")}</option>
          {(servidores.data ?? [])
            .filter((s) => s.enabled)
            .map(({ config }) => (
              <option key={config.name} value={config.name}>
                {config.name}
              </option>
            ))}
        </select>
      </Campo>
      {servidor === "" ? null : (
        <Campo rotulo={t("automations.steps.mcp.call.tool")}>
          {erro !== null ? (
            <p className="text-sev-critical text-xs">{erro}</p>
          ) : ferramentas?.de !== servidor ? (
            <p className="text-muted-foreground text-xs">{t("automations.steps.mcp.call.loading")}</p>
          ) : (
            <select
              className={CAMPO}
              data-locum-acao-ferramenta=""
              onChange={(e) => mudar({ tool: e.target.value, args: {} })}
              value={params.tool ?? ""}
            >
              <option value="">{t("automations.steps.mcp.call.chooseTool")}</option>
              {ferramentas.lista.map((f) => (
                <option key={f.name} title={f.description} value={f.name}>
                  {f.name}
                </option>
              ))}
            </select>
          )}
          {escolhida?.description ? <p className="text-muted-foreground line-clamp-3 text-[11px]">{escolhida.description}</p> : null}
        </Campo>
      )}
      {escolhida === undefined ? null : (
        <>
          <Variaveis inserir={inserir} lista={variaveis(rascunho, passo.key)} />
          {campos.length === 0 ? (
            <Campo rotulo={t("automations.steps.mcp.call.argsJson")}>
              <textarea
                className={cn(CAMPO, "min-h-24 font-mono text-xs")}
                onChange={(e) => mudar({ args: (valorDoCampo(e.target.value, "object") as Record<string, unknown>) ?? {} })}
                value={textoDoValor(args)}
              />
            </Campo>
          ) : (
            campos.map(([nome, prop]) => {
              const tipo = Array.isArray(prop.type) ? prop.type[0] : prop.type;
              const aplicar = (texto: string): void => {
                const { [nome]: _antigo, ...resto } = args;
                mudar({ args: texto === "" ? resto : { ...resto, [nome]: valorDoCampo(texto, tipo) } });
              };
              const longo = tipo === "object" || tipo === "array" || /text|body|message|content|description/i.test(nome);
              return (
                <Campo key={nome} rotulo={`${nome}${obrigatorios.has(nome) ? " *" : ""}`}>
                  {longo ? (
                    <textarea
                      className={cn(CAMPO, "min-h-20 font-mono text-xs")}
                      data-locum-arg={nome}
                      onChange={(e) => aplicar(e.target.value)}
                      onFocus={focar(aplicar)}
                      value={textoDoValor(args[nome])}
                    />
                  ) : (
                    <input
                      className={cn(CAMPO, "font-mono text-xs")}
                      data-locum-arg={nome}
                      onChange={(e) => aplicar(e.target.value)}
                      onFocus={focar(aplicar)}
                      value={textoDoValor(args[nome])}
                    />
                  )}
                  {prop.description ? <p className="text-muted-foreground line-clamp-2 text-[11px]">{prop.description}</p> : null}
                </Campo>
              );
            })
          )}
        </>
      )}
    </>
  );
}

const METODOS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Qualquer API: método, endereço, cabeçalhos e corpo, todos com marcadores. */
function ConfigDoHttp({
  passo,
  rascunho,
  trocar,
}: {
  passo: PassoDeAcao;
  rascunho: Rascunho;
  trocar: (novo: PassoDeAcao) => void;
}) {
  const { t } = useTranslation();
  const params = (passo.params ?? {}) as { method?: string; url?: string; headers?: Record<string, string>; body?: unknown };
  const mudar = (novo: Partial<typeof params>): void => trocar({ ...passo, params: { ...params, ...novo } });
  const cabecalhos = Object.entries(params.headers ?? {});
  const { focar, inserir } = useInsercao();
  const [novoCabecalho, setNovoCabecalho] = useState("");

  return (
    <>
      <Variaveis inserir={inserir} lista={variaveis(rascunho, passo.key)} />
      <div className="flex gap-1.5">
        <select className={cn(CAMPO, "w-28")} onChange={(e) => mudar({ method: e.target.value })} value={params.method ?? "POST"}>
          {METODOS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          aria-label={t("automations.steps.http.request.url")}
          className={cn(CAMPO, "font-mono text-xs")}
          data-locum-http-url=""
          onChange={(e) => mudar({ url: e.target.value })}
          onFocus={focar((url) => mudar({ url }))}
          placeholder={t("automations.steps.http.request.urlPlaceholder")}
          value={params.url ?? ""}
        />
      </div>
      <Campo rotulo={t("automations.steps.http.request.headers")}>
        {cabecalhos.map(([nome, valor]) => {
          const aplicar = (v: string): void => mudar({ headers: { ...params.headers, [nome]: v } });
          return (
            <div className="flex items-center gap-1.5" key={nome}>
              <span className="w-28 shrink-0 truncate font-mono text-xs">{nome}</span>
              <input
                className={cn(CAMPO, "font-mono text-xs")}
                onChange={(e) => aplicar(e.target.value)}
                onFocus={focar(aplicar)}
                value={valor}
              />
              <button
                aria-label={t("automations.steps.http.request.removeHeader", { name: nome })}
                className="text-muted-foreground hover:text-foreground cursor-pointer rounded p-1"
                onClick={() => {
                  const { [nome]: _fora, ...resto } = params.headers ?? {};
                  mudar({ headers: resto });
                }}
                type="button"
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
        <div className="flex gap-1.5">
          <input
            className={cn(CAMPO, "font-mono text-xs")}
            onChange={(e) => setNovoCabecalho(e.target.value)}
            placeholder={t("automations.steps.http.request.headerPlaceholder")}
            value={novoCabecalho}
          />
          <Button
            className="cursor-pointer"
            disabled={novoCabecalho.trim() === "" || novoCabecalho.trim() in (params.headers ?? {})}
            onClick={() => {
              mudar({ headers: { ...params.headers, [novoCabecalho.trim()]: "" } });
              setNovoCabecalho("");
            }}
            size="sm"
            variant="outline"
          >
            {t("automations.steps.http.request.addHeader")}
          </Button>
        </div>
        <p className="text-muted-foreground text-[11px]">{t("automations.steps.http.request.headersHint")}</p>
      </Campo>
      {params.method === "GET" ? null : (
        <Campo rotulo={t("automations.steps.http.request.body")}>
          <textarea
            className={cn(CAMPO, "min-h-28 font-mono text-xs")}
            data-locum-http-corpo=""
            onChange={(e) => mudar({ body: e.target.value })}
            onFocus={focar((body) => mudar({ body }))}
            value={textoDoValor(params.body)}
          />
          <p className="text-muted-foreground text-[11px]">{t("automations.steps.http.request.bodyHint")}</p>
        </Campo>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ campos */

function Campo({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs">{rotulo}</span>
      {children}
    </div>
  );
}

function Minutos({ rotulo, valor, trocar }: { rotulo: string; valor: number; trocar: (n: number) => void }) {
  return (
    <Campo rotulo={rotulo}>
      <input
        className={cn(CAMPO, "w-28")}
        min={1}
        onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10);
          if (Number.isFinite(n) && n >= 1) trocar(n);
        }}
        type="number"
        value={valor}
      />
    </Campo>
  );
}

function Alternador({ ligado, rotulo, trocar }: { ligado: boolean; rotulo: string; trocar: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input checked={ligado} className="accent-primary size-4 cursor-pointer" onChange={(e) => trocar(e.target.checked)} type="checkbox" />
      {rotulo}
    </label>
  );
}
