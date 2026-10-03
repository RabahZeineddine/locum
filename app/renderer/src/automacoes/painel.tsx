import { Button } from "@/components/ui/button";
import {
  anteriores,
  ehGatilho,
  FORMATOS,
  formatoDe,
  trocarPasso,
  variaveis,
  type Formato,
  type PassoDeAcao,
  type PassoDeIA,
  type Problema,
  type Rascunho,
} from "@/lib/automacao";
import { call, type ReadResult } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import { Trash2, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TriggerConfig } from "../../../src/config/types";
import { parseCron, proximaOcorrencia } from "../../../src/triggers/cron";
import { SeletorDeFerramentas, SeletorDeModelo, useCatalogo } from "../editor-agent";
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
  problemas,
  remover,
  fechar,
}: {
  chave: string;
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
          const id = passo!.type === "model" ? "ai" : passo!.action;
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
      ) : passo!.type === "model" ? (
        <ConfigDaIA chave={chave} passo={passo as PassoDeIA} rascunho={rascunho} setRascunho={setRascunho} />
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

function ConfigDaIA({
  chave,
  passo,
  rascunho,
  setRascunho,
}: {
  chave: string;
  passo: PassoDeIA;
  rascunho: Rascunho;
  setRascunho: (f: (r: Rascunho) => Rascunho) => void;
}) {
  const { t } = useTranslation();
  const catalogo = useCatalogo();
  const caixa = useRef<HTMLTextAreaElement>(null);
  const trocar = (novo: PassoDeIA): void => setRascunho((r) => ({ ...r, spec: trocarPasso(r.spec, passo.key, novo) }));
  const formato = formatoDe(passo);

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
      <Campo rotulo={t("automations.panel.name")}>
        <input className={CAMPO} onChange={(e) => trocar({ ...passo, name: e.target.value })} value={passo.name} />
      </Campo>
      <Campo rotulo={t("automations.steps.ai.model")}>
        <SeletorDeModelo catalogo={catalogo} trocar={(model) => trocar({ ...passo, model })} valor={passo.model} />
      </Campo>
      <Campo rotulo={t("automations.steps.ai.prompt")}>
        <textarea
          className={cn(CAMPO, "min-h-40 resize-y font-mono text-xs leading-relaxed")}
          data-locum-prompt=""
          onChange={(e) => trocar({ ...passo, prompt: e.target.value })}
          ref={caixa}
          value={passo.prompt}
        />
        {variaveis(rascunho, chave).length > 0 ? (
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-[11px]">{t("automations.steps.ai.variables")}</span>
            <div className="flex flex-wrap gap-1">
              {variaveis(rascunho, chave).map((v) => (
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
      {passo.mode === "approve" ? <p className="text-amber-500 text-xs">{t("automations.panel.approval")}</p> : null}
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
