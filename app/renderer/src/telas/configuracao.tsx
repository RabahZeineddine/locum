import { Badge } from "@/components/ui/badge";
import { AjustesDeLimites } from "./limites";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Select } from "@/components/ui/select";
import { StatusDot } from "@/components/ui/status-dot";
import { pontoDaFerramenta } from "@/lib/estado-do-ponto";
import { CabecalhoDaTela } from "@/components/cabecalho-da-tela";
import { Button } from "@/components/ui/button";
import { call, useRead, type ReadResult } from "@/lib/bridge";
import { useAtualizacao } from "@/lib/atualizacao";
import { cn } from "@/lib/utils";
import { EscolhaDoModelo } from "../assistente-modelo";
import { Vazio } from "./blocos";
import { BlocoDeAjustes, Interruptor, LinhaDeAjuste } from "./linhas-de-ajuste";
import {
  Clock,
  Download,
  Gauge,
  Languages,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useIdioma } from "../idioma";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Language } from "../../../src/services/i18n-service.js";
import type { WorkingHoursConfig } from "../../../src/config/types.js";
import type { TelaProps } from "../rotas";

type Fallback = ReadResult<"providers.fallbacks">[number];
type Orcamento = ReadResult<"agents.budgets">[number];
type EstadoDoClaudeCode = ReadResult<"claudeCode.status">;
type EstadoDoOpencode = ReadResult<"opencode.status">;

/**
 * A tela de configuração: só o comportamento do app. Idioma, atualização,
 * limites, horário de trabalho, o assistente, e o Locum dentro das ferramentas
 * de código. Provedores de modelo moram em Modelos, e tudo que é externo, em
 * Conexões.
 *
 * Segredo nenhum passa por aqui: o que a tela mostra de credencial é o
 * endereço dela e se existe valor guardado.
 */

/**
 * As seções da Configuração, cada uma com rota própria (`#/settings/<id>`),
 * na ordem da lista. `general`, `assistant` e `tools` já eram endereços
 * antes de a lista crescer, e seguem valendo.
 */
export const SECOES = ["general", "language", "updates", "limits", "hours", "assistant", "tools", "advanced"] as const;
export type SecaoId = (typeof SECOES)[number];

export function Configuracao({ detalhe, navegar }: TelaProps) {
  const { t } = useTranslation();
  const secao: SecaoId = (SECOES as readonly string[]).includes(detalhe ?? "")
    ? (detalhe as SecaoId)
    : "general";
  const maquina = useRead("machine.profile");
  const machineId = maquina.data?.machineId ?? null;

  // A tabela de substituicao e por maquina, e o identificador chega por outra
  // leitura. Com ele ainda nulo o canal responde lista vazia sem tocar no
  // banco, e a tela repinta quando ele chegar.
  const fallbacks = useRead("providers.fallbacks", machineId ?? "");
  const credenciais = useRead("credentials.overview");

  const leituras = [fallbacks, credenciais];
  const erro = leituras.find((l) => l.status === "error")?.error;
  const pronto = machineId !== null && leituras.every((l) => l.status === "ready");
  const estado = erro !== undefined ? "erro" : pronto ? "pronto" : "carregando";

  return (
    <div
      className="mx-auto flex w-full max-w-4xl flex-col gap-6"
      data-estado={estado}
      data-locum-cofre={credenciais.data?.available === true ? "legivel" : "fechado"}
      data-locum-fallbacks={fallbacks.data?.length ?? -1}
      data-locum-maquina={machineId ?? ""}
      data-locum-secao-ativa={secao}
      data-locum-probe="settings"
    >
      <CabecalhoDaTela
        acoes={<Kbd aria-label={t("settings.shortcut")}>⌘,</Kbd>}
        titulo={t("nav.settings")}
      />

      {erro === undefined ? null : (
        <p className="text-destructive text-sm">
          {t("settings.refused", { channel: erro.channel, message: erro.message })}
        </p>
      )}

      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <NavDaConfiguracao atual={secao} navegar={navegar} />

        <div className="flex min-w-0 max-w-2xl flex-1 flex-col gap-6">
          <h2 className="text-[15px] font-medium tracking-tight">{t(`settings.sections.${secao}`)}</h2>

          {secao === "general" ? (
            <>
              <BlocoDeAjustes titulo={t("settings.groups.initiatives")}>
                <EscolhaDeStaleDays />
              </BlocoDeAjustes>
              <BlocoDeAjustes titulo={t("settings.groups.sessions")}>
                <EscolhaDoTerminal />
              </BlocoDeAjustes>
            </>
          ) : null}

          {secao === "language" ? (
            <BlocoDeAjustes>
              <EscolhaDoIdioma />
            </BlocoDeAjustes>
          ) : null}

          {secao === "updates" ? <Atualizacao /> : null}

          {secao === "limits" ? <AjustesDeLimites navegar={navegar} /> : null}

          {secao === "hours" ? <EscolhaDeWorkingHours /> : null}

          {secao === "assistant" ? (
            <>
              <BlocoDeAjustes titulo={t("settings.assistantModel.title")}>
                <EscolhaDoModelo />
              </BlocoDeAjustes>

              <BlocoDeAjustes
                descricao={t("settings.fallbacks.description", { machine: machineId ?? "..." })}
                titulo={t("settings.fallbacks.title")}
              >
                {(fallbacks.data ?? []).length === 0 ? (
                  <Vazio>{t("settings.fallbacks.empty")}</Vazio>
                ) : (
                  (fallbacks.data ?? []).map((fallback) => (
                    <LinhaDoFallback fallback={fallback} key={`${fallback.fromModel}>${fallback.toModel}`} />
                  ))
                )}
              </BlocoDeAjustes>
            </>
          ) : null}

          {secao === "tools" ? (
            <BlocoDeAjustes descricao={t("settings.toolsLocum.description")} titulo={t("settings.toolsLocum.title")}>
              <ClaudeCode />
              <Opencode />
            </BlocoDeAjustes>
          ) : null}

          {secao === "advanced" ? (
            <BlocoDeAjustes titulo={t("settings.groups.folders")}>
              <EscolhaDaRaiz />
            </BlocoDeAjustes>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const ICONE_DA_SECAO: Record<SecaoId, LucideIcon> = {
  general: SlidersHorizontal,
  language: Languages,
  updates: Download,
  limits: Gauge,
  hours: Clock,
  assistant: Sparkles,
  tools: SquareTerminal,
  advanced: Wrench,
};

/** Campo onde as setas movem o cursor ou escolhem opção: ali elas não trocam de seção. */
function digitando(alvo: EventTarget | null): boolean {
  return alvo instanceof HTMLElement && alvo.closest("input, select, textarea, [contenteditable=true]") !== null;
}

/**
 * A lista de seções, de lado, como nas preferências do sistema.
 *
 * ↑ e ↓ trocam de seção, com o foco na lista ou com a tela em repouso (sem
 * campo em edição). Um só botão da lista entra na ordem do Tab, o da seção
 * ativa, como numa lista de abas.
 */
function NavDaConfiguracao({ atual, navegar }: { atual: SecaoId; navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  const lista = useRef<HTMLElement>(null);

  useEffect(() => {
    const aoTeclar = (evento: KeyboardEvent): void => {
      if (evento.key !== "ArrowDown" && evento.key !== "ArrowUp") return;
      if (evento.metaKey || evento.ctrlKey || evento.altKey || evento.shiftKey || evento.defaultPrevented) return;
      if (digitando(evento.target)) return;
      const alvo = evento.target as HTMLElement | null;
      const naLista = alvo !== null && lista.current?.contains(alvo) === true;
      // Em repouso o foco está no corpo; em outro botão ou link, a seta é dele.
      if (!naLista && alvo !== document.body) return;
      const proxima = SECOES[SECOES.indexOf(atual) + (evento.key === "ArrowDown" ? 1 : -1)];
      if (proxima === undefined) return;
      evento.preventDefault();
      navegar("settings", proxima);
      if (naLista) {
        requestAnimationFrame(() => lista.current?.querySelector<HTMLElement>(`[data-locum-secao="${proxima}"]`)?.focus());
      }
    };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [atual, navegar]);

  return (
    <nav
      aria-label={t("nav.settings")}
      aria-orientation="vertical"
      className="flex shrink-0 gap-0.5 overflow-x-auto md:sticky md:top-4 md:w-52 md:flex-col"
      data-locum-probe="secoes"
      ref={lista}
      role="tablist"
    >
      {SECOES.map((id) => {
        const Icone = ICONE_DA_SECAO[id];
        const ativo = id === atual;
        return (
          <button
            aria-selected={ativo}
            className={cn(
              "focus-visible:ring-ring flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-[13px] transition-colors focus-visible:ring-2 focus-visible:outline-none",
              ativo
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
            data-locum-secao={id}
            key={id}
            onClick={() => navegar("settings", id)}
            role="tab"
            tabIndex={ativo ? 0 : -1}
            type="button"
          >
            <Icone aria-hidden className="size-3.5" />
            <span className="truncate">{t(`settings.sections.${id}`)}</span>
          </button>
        );
      })}
    </nav>
  );
}

/* ------------------------------------------------------------------- idioma */

/**
 * O nome de um idioma escrito nele mesmo.
 *
 * Não sai do dicionário de propósito: quem abre esta seção é justamente quem
 * está com a janela num idioma que não lê, e "Portuguese" traduzido para o
 * idioma corrente não ajuda nessa hora. O nome no próprio idioma é o que a
 * pessoa reconhece na lista.
 */
function autonimo(codigo: string): string {
  return new Intl.DisplayNames([codigo], { type: "language" }).of(codigo) ?? codigo;
}

/**
 * Em que idioma o Locum fala, escolhido aqui.
 *
 * Seguir o sistema não é o mesmo que escolher o idioma que o sistema está
 * falando agora: quem segue o sistema vira de idioma junto com a máquina, e
 * por isso a opção é botão à parte e não fica marcada quando alguém escolhe
 * `en` numa máquina em inglês.
 *
 * A troca não recarrega a janela nem remonta a árvore: o provedor de idioma
 * muda a instância do i18next que já está no ar, e o mesmo canal avisa o
 * processo principal, que reescreve bandeja e notificação na mesma batida.
 */
function EscolhaDoIdioma() {
  const { t } = useTranslation();
  const { available, language, preference, system, trocar } = useIdioma();
  const [erro, setErro] = useState<string | null>(null);

  const escolher = (escolha: Language | null): void => {
    trocar(escolha).then(
      () => setErro(null),
      (falha: unknown) => setErro(falha instanceof Error ? falha.message : String(falha)),
    );
  };

  return (
    <LinhaDeAjuste
      abaixo={erro === null ? undefined : (
        <p className="text-sev-critical text-xs">{t("settings.language.refused", { message: erro })}</p>
      )}
      data-locum-idioma-ativo={language}
      data-locum-idioma-preferencia={preference ?? ""}
      data-locum-idioma-sistema={system}
      data-locum-probe="idioma-escolha"
      descricao={t("settings.language.active", { language: autonimo(language) })}
      dica={t("settings.language.description")}
      titulo={t("settings.language.title")}
    >
      <div aria-label={t("settings.language.title")} className="flex flex-wrap justify-end gap-1" role="group">
        <Button
          data-locum-escolhido={preference === null ? "sim" : "nao"}
          data-locum-idioma="sistema"
          onClick={() => escolher(null)}
          size="sm"
          variant={preference === null ? "secondary" : "ghost"}
        >
          {t("settings.language.system")}
        </Button>
        {available.map((codigo) => (
          <Button
            data-locum-escolhido={preference === codigo ? "sim" : "nao"}
            data-locum-idioma={codigo}
            key={codigo}
            onClick={() => escolher(codigo)}
            size="sm"
            variant={preference === codigo ? "secondary" : "ghost"}
          >
            {autonimo(codigo)}
          </Button>
        ))}
      </div>
    </LinhaDeAjuste>
  );
}

/* ------------------------------------------------------------- atualização */

/**
 * A versão instalada, a que está esperando e o interruptor.
 *
 * Abrir a tela não pergunta ao GitHub: o estado vem do que o verificador já
 * sabe. Conferir sai para a rede atrás de um clique, e a resposta volta com o
 * download terminado ou com o motivo da falha.
 */
function Atualizacao() {
  const { t } = useTranslation();
  const [estado, setRecarregado] = useAtualizacao();
  const [ocupado, setOcupado] = useState(false);

  if (estado === undefined) {
    return (
      <BlocoDeAjustes>
        <Vazio>{t("settings.updates.loading")}</Vazio>
      </BlocoDeAjustes>
    );
  }

  const agir = (canal: "updates.check" | "updates.setEnabled", ligar?: boolean): void => {
    setOcupado(true);
    const pedido = canal === "updates.check" ? call("updates.check") : call("updates.setEnabled", ligar === true);
    pedido.then(setRecarregado, () => undefined).finally(() => setOcupado(false));
  };

  const parado = estado.reason !== null;
  const situacao = parado
    ? t(`settings.updates.reason.${estado.reason}`, { detail: estado.detail ?? "" })
    : estado.phase === "failed" && estado.errorKind !== null
      ? t(`settings.updates.network.${estado.errorKind}`)
      : t(`settings.updates.phase.${estado.phase}`, {
          version: estado.available?.version ?? "",
          error: estado.error ?? "",
        });

  return (
    <BlocoDeAjustes>
      <LinhaDeAjuste
        data-locum-atualizacao-fase={estado.phase}
        data-locum-atualizacao-motivo={estado.reason ?? ""}
        data-locum-probe="atualizacao"
        descricao={situacao}
        titulo={t("settings.updates.current", { version: estado.current })}
      >
        {estado.phase === "ready" ? (
          <Button onClick={() => void call("updates.apply")} size="sm">
            {t("settings.updates.apply")}
          </Button>
        ) : null}
        <Button
          disabled={ocupado || parado}
          onClick={() => agir("updates.check")}
          size="sm"
          variant="secondary"
        >
          {ocupado ? t("settings.updates.checking") : t("settings.updates.check")}
        </Button>
      </LinhaDeAjuste>
      <LinhaDeAjuste
        descricao={t("settings.updates.autoDescription")}
        dica={t("settings.updates.description")}
        titulo={t("settings.updates.auto")}
      >
        <Interruptor
          ativo={estado.enabled}
          desabilitado={ocupado}
          mudar={(ligar) => agir("updates.setEnabled", ligar)}
          rotulo={t("settings.updates.auto")}
        />
      </LinhaDeAjuste>
      {estado.lastCheckAt === null ? null : (
        <LinhaDeAjuste titulo={t("settings.updates.lastCheck")}>
          <span className="text-muted-foreground text-xs tabular-nums">
            {new Date(estado.lastCheckAt).toLocaleString()}
          </span>
        </LinhaDeAjuste>
      )}
    </BlocoDeAjustes>
  );
}

/* ------------------------------------------------------------ iniciativas */

/**
 * Depois de quantos dias sem atualização uma iniciativa entra como parada.
 *
 * O valor gravado é sempre um inteiro de 1 a 90; o serviço já cai para o
 * padrão de 7 quando o que está guardado não bate essa faixa, então o único
 * jeito de a gravação falhar aqui é digitar fora dela.
 */
function EscolhaDeStaleDays() {
  const { t } = useTranslation();
  const lido = useRead("initiatives.staleDays");
  const [rascunho, setRascunho] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  if (lido.data === undefined) return <Vazio>{t("settings.staleDays.title")}</Vazio>;

  const valor = rascunho ?? String(lido.data);

  const gravar = (): void => {
    const n = Number(valor);
    setOcupado(true);
    setErro(null);
    call("initiatives.setStaleDays", n).then(
      () => setRascunho(null),
      () => setErro(t("settings.staleDays.refused")),
    ).finally(() => setOcupado(false));
  };

  return (
    <LinhaDeAjuste
      data-locum-probe="stale-days"
      descricao={t("settings.staleDays.description")}
      titulo={t("settings.staleDays.title")}
    >
      {erro && <span className="text-sev-critical text-xs">{erro}</span>}
      <label className="text-muted-foreground text-xs" htmlFor="stale-days">
        {t("settings.staleDays.label")}
      </label>
      <Input
        className="h-7 w-16 text-right tabular-nums"
        id="stale-days"
        max={90}
        min={1}
        onChange={(e) => setRascunho(e.target.value)}
        type="number"
        value={valor}
      />
      <Button
        disabled={ocupado || Number(valor) === lido.data}
        onClick={gravar}
        size="sm"
        variant="secondary"
      >
        {t("common.save")}
      </Button>
    </LinhaDeAjuste>
  );
}

function EscolhaDeWorkingHours() {
  const { t } = useTranslation();
  const lido = useRead("scheduler.getWorkingHours");
  const [config, setConfig] = useState<WorkingHoursConfig | null>(null);
  const [salvo, setSalvo] = useState(false);

  const atual: WorkingHoursConfig = config ?? lido.data ?? {
    enabled: false,
    start: "08:00",
    end: "20:00",
    days: [1, 2, 3, 4, 5],
    offHoursBehavior: "pause",
    slowCadenceMinutes: 60,
  };

  const salvar = (novo: WorkingHoursConfig) => {
    setConfig(novo);
    call("scheduler.setWorkingHours", novo).then(() => {
      setSalvo(true);
      setTimeout(() => setSalvo(false), 1500);
    });
  };

  return (
    <BlocoDeAjustes>
      <LinhaDeAjuste
        data-locum-probe="working-hours"
        descricao={t("settings.workingHours.enableDescription")}
        dica={t("settings.workingHours.description")}
        titulo={t("settings.workingHours.enableLabel")}
      >
        {salvo && <span className="text-muted-foreground text-xs">{t("settings.workingHours.saved")}</span>}
        <Interruptor
          ativo={atual.enabled}
          mudar={(ligado) => salvar({ ...atual, enabled: ligado })}
          rotulo={t("settings.workingHours.enableLabel")}
        />
      </LinhaDeAjuste>
      {atual.enabled ? (
        <>
          <LinhaDeAjuste titulo={t("settings.workingHours.shift")}>
            <Input
              aria-label={t("settings.workingHours.start")}
              className="h-7 w-24 font-mono text-xs"
              onChange={(e) => salvar({ ...atual, start: e.target.value })}
              type="time"
              value={atual.start}
            />
            <span className="text-muted-foreground text-xs">{t("settings.workingHours.to")}</span>
            <Input
              aria-label={t("settings.workingHours.end")}
              className="h-7 w-24 font-mono text-xs"
              onChange={(e) => salvar({ ...atual, end: e.target.value })}
              type="time"
              value={atual.end}
            />
          </LinhaDeAjuste>
          <LinhaDeAjuste titulo={t("settings.workingHours.offHoursLabel")}>
            <Select
              aria-label={t("settings.workingHours.offHoursLabel")}
              className="h-7 text-xs"
              onChange={(e) => salvar({ ...atual, offHoursBehavior: e.target.value as WorkingHoursConfig["offHoursBehavior"] })}
              value={atual.offHoursBehavior}
            >
              <option value="pause">{t("settings.workingHours.behaviorPause")}</option>
              <option value="slow">{t("settings.workingHours.behaviorSlow")}</option>
              <option value="unrestricted">{t("settings.workingHours.behaviorUnrestricted")}</option>
            </Select>
          </LinhaDeAjuste>
        </>
      ) : null}
    </BlocoDeAjustes>
  );
}

/**
 * A pasta raiz onde a pasta de contexto de cada iniciativa mora.
 *
 * Vazio volta ao padrao; caminho relativo e recusado pelo servico, porque a
 * pasta de contexto sai daqui concatenada com o slug.
 */
function EscolhaDaRaiz() {
  const { t } = useTranslation();
  const lido = useRead("initiatives.root");
  const [rascunho, setRascunho] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  if (lido.data === undefined) return <Vazio>{t("settings.initiativesRoot.title")}</Vazio>;

  const valor = rascunho ?? lido.data;

  const gravar = (): void => {
    setOcupado(true);
    setErro(null);
    call("initiatives.setRoot", valor).then(
      () => setRascunho(null),
      () => setErro(t("settings.initiativesRoot.refused")),
    ).finally(() => setOcupado(false));
  };

  return (
    <LinhaDeAjuste
      abaixo={erro === null ? undefined : <span className="text-sev-critical text-xs">{erro}</span>}
      data-locum-probe="initiatives-root"
      descricao={t("settings.initiativesRoot.description")}
      titulo={t("settings.initiativesRoot.title")}
    >
      <label className="sr-only" htmlFor="initiatives-root">
        {t("settings.initiativesRoot.label")}
      </label>
      <Input
        className="h-7 w-72 font-mono text-xs"
        id="initiatives-root"
        onChange={(e) => setRascunho(e.target.value)}
        placeholder={t("settings.initiativesRoot.label")}
        type="text"
        value={valor}
      />
      <Button disabled={ocupado || valor === lido.data} onClick={gravar} size="sm" variant="secondary">
        {t("common.save")}
      </Button>
    </LinhaDeAjuste>
  );
}

/**
 * O terminal onde a sessao da iniciativa abre. O `useRead` nao relê depois da
 * gravacao, entao a escolha feita aqui fica no estado local ate a tela remontar.
 */
function EscolhaDoTerminal() {
  const { t } = useTranslation();
  const lido = useRead("sessions.terminal");
  const instalados = useRead("sessions.installedTerminals");
  const [escolhido, setEscolhido] = useState<SessionTerminal | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  if (lido.data === undefined) return <Vazio>{t("settings.sessionTerminal.title")}</Vazio>;

  const atual = escolhido ?? lido.data;

  const escolher = (terminal: SessionTerminal): void => {
    setErro(null);
    call("sessions.setTerminal", terminal).then(
      () => setEscolhido(terminal),
      () => setErro(t("settings.sessionTerminal.refused")),
    );
  };

  return (
    <LinhaDeAjuste
      abaixo={erro === null ? undefined : <span className="text-sev-critical text-xs">{erro}</span>}
      data-locum-probe="session-terminal"
      data-locum-terminal={atual}
      descricao={t("settings.sessionTerminal.description")}
      titulo={t("settings.sessionTerminal.title")}
    >
      <Select
        aria-label={t("settings.sessionTerminal.title")}
        className="h-7 text-xs"
        onChange={(e) => escolher(e.target.value as SessionTerminal)}
        value={atual}
      >
        {TERMINAIS.filter((terminal) => terminal === atual || (instalados.data ?? TERMINAIS).includes(terminal)).map(
          (terminal) => (
            <option key={terminal} value={terminal}>
              {t(`settings.sessionTerminal.${terminal}`)}
            </option>
          ),
        )}
      </Select>
    </LinhaDeAjuste>
  );
}

type SessionTerminal = ReadResult<"sessions.terminal">;
const TERMINAIS: readonly SessionTerminal[] = ["locum", "terminal", "iterm", "warp"];

/* ---------------------------------------------------------------- fallbacks */

function LinhaDoFallback({ fallback }: { fallback: Fallback }) {
  const { t } = useTranslation();

  return (
    <div
      className="flex flex-wrap items-center gap-3 border-border border-b px-3 py-2 text-[13px] last:border-b-0"
      data-locum-fallback={`${fallback.fromModel}>${fallback.toModel}`}
      data-locum-ordem={fallback.order}
    >
      <code className="text-xs">{fallback.fromModel}</code>
      <span className="text-muted-foreground text-xs">{t("settings.fallbacks.becomes")}</span>
      <code className="text-xs">{fallback.toModel}</code>
      <span className="ml-auto text-muted-foreground text-xs tabular-nums">
        {t("settings.fallbacks.order", { order: fallback.order })}
      </span>
    </div>
  );
}

/** O estado de uma ferramenta: ponto colorido e texto neutro. */
function EstadoDaFerramenta({ situacao }: { situacao: "connected" | "stale" | "absent" | null }) {
  const { t } = useTranslation();
  if (situacao === null) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot estado={pontoDaFerramenta(situacao)} />
      {t(`settings.claudeCode.${situacao}`)}
    </span>
  );
}

/**
 * O Locum dentro do Claude Code, num clique.
 *
 * O botão roda o `claude mcp add` apontando para este aplicativo, que serve o
 * MCP por `--mcp` com o mesmo cofre da janela: é o que deixa o token guardado
 * aqui valer numa sessão do terminal sem a pessoa exportar nada. A linha do
 * comando fica recolhida, para quem preferir colar ela mesma.
 */
export function ClaudeCode() {
  const { t } = useTranslation();
  const inicial = useRead("claudeCode.status");
  const [recarregado, setRecarregado] = useState<EstadoDoClaudeCode | null>(null);
  const [ligando, setLigando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const estado = recarregado ?? inicial.data ?? null;

  const ligar = (): void => {
    setLigando(true);
    setErro(null);
    call("claudeCode.connect").then(
      (novo) => {
        setRecarregado(novo);
        setLigando(false);
      },
      (e: unknown) => {
        setErro(e instanceof Error ? e.message : String(e));
        setLigando(false);
      },
    );
  };

  const situacao =
    estado === null
      ? null
      : estado.current
        ? "connected"
        : estado.registered
          ? "stale"
          : "absent";

  return (
    <LinhaDeAjuste
      abaixo={
        <>
          {erro === null ? null : <p className="text-sev-critical mb-1 text-xs">{erro}</p>}
          {estado === null ? null : (
            <details>
              <summary className="text-muted-foreground hover:text-foreground w-fit cursor-pointer text-xs">
                {t("settings.claudeCode.showCommand")}
              </summary>
              <code className="bg-muted text-muted-foreground mt-2 block overflow-x-auto rounded-md px-2 py-1 font-mono text-[11px] whitespace-nowrap">
                {estado.command}
              </code>
            </details>
          )}
        </>
      }
      data-locum-claude-code={situacao ?? ""}
      data-locum-probe="claude-code"
      descricao={<EstadoDaFerramenta situacao={situacao} />}
      dica={t(situacao === "connected" ? "settings.claudeCode.connectedHint" : "settings.claudeCode.description")}
      titulo={t("settings.claudeCode.title")}
    >
      {estado !== null && estado.cli === null ? (
        <Badge variant="outline">{t("settings.claudeCode.noCli")}</Badge>
      ) : null}
      <Button
        data-locum-claude-code-ligar=""
        disabled={ligando || estado === null || estado.cli === null || estado.current}
        onClick={ligar}
        size="sm"
        variant={estado?.current === true ? "ghost" : "default"}
      >
        {t(
          ligando
            ? "settings.claudeCode.connecting"
            : situacao === "stale"
              ? "settings.claudeCode.reconnect"
              : "settings.claudeCode.connect",
        )}
      </Button>
    </LinhaDeAjuste>
  );
}

/**
 * O Locum dentro do opencode, num clique.
 *
 * O opencode não tem comando que cadastre servidor sem perguntar, então o
 * botão grava `mcp.locum` na configuração global, `.json` ou `.jsonc`, sem
 * perder comentário. Com arquivo quebrado, o botão recusa e o trecho fica para
 * colar.
 */
export function Opencode() {
  const { t } = useTranslation();
  const inicial = useRead("opencode.status");
  const [recarregado, setRecarregado] = useState<EstadoDoOpencode | null>(null);
  const [ligando, setLigando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const estado = recarregado ?? inicial.data ?? null;

  const ligar = (): void => {
    setLigando(true);
    setErro(null);
    call("opencode.connect").then(
      (novo) => {
        setRecarregado(novo);
        setLigando(false);
      },
      (e: unknown) => {
        setErro(e instanceof Error ? e.message : String(e));
        setLigando(false);
      },
    );
  };

  const situacao = estado === null ? null : estado.current ? "connected" : estado.registered ? "stale" : "absent";

  return (
    <LinhaDeAjuste
      abaixo={
        <>
          {erro === null ? null : <p className="text-sev-critical mb-1 text-xs">{erro}</p>}
          {estado === null ? null : (
            // Recolhido: o botão resolve quase sempre, e o trecho só interessa a
            // quem precisa colar à mão. Abre sozinho quando o botão falhou.
            <details className="group" open={erro !== null}>
              <summary className="text-muted-foreground hover:text-foreground w-fit cursor-pointer text-xs">
                {t("settings.opencode.showSnippet")}
              </summary>
              <p className="text-muted-foreground mt-2 text-xs">{t("settings.opencode.snippet", { path: estado.configPath })}</p>
              <code className="bg-muted text-muted-foreground mt-2 block overflow-x-auto rounded-md px-2 py-1 font-mono text-[11px] whitespace-pre">
                {estado.snippet}
              </code>
            </details>
          )}
        </>
      }
      data-locum-probe="opencode"
      descricao={<EstadoDaFerramenta situacao={situacao} />}
      dica={situacao === "connected" ? t("settings.opencode.connectedHint") : undefined}
      titulo={t("settings.opencode.title")}
    >
      <Button
        disabled={ligando || estado === null || estado.current}
        onClick={ligar}
        size="sm"
        variant={estado?.current === true ? "ghost" : "default"}
      >
        {t(
          ligando
            ? "settings.claudeCode.connecting"
            : situacao === "stale"
              ? "settings.claudeCode.reconnect"
              : "settings.claudeCode.connect",
        )}
      </Button>
    </LinhaDeAjuste>
  );
}

/* ---------------------------------------------------------------- orcamentos */

export function LinhaDoOrcamento({ orcamento }: { orcamento: Orcamento }) {
  const { t } = useTranslation();
  // Teto ausente e teto ausente, e escrever zero ali mentiria sobre o limite.
  const moeda = (valor: number | null): string =>
    valor === null
      ? t("settings.budgets.noCap")
      : t("settings.budgets.amount", { amount: valor.toFixed(2) });
  const semTetoEmTokens = orcamento.perRunTokens === null && orcamento.perDayTokens === null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-border border-b px-4 py-3 text-sm last:border-b-0"
      data-locum-gasto-hoje={orcamento.spentTodayUsd}
      data-locum-orcamento={orcamento.agentId}
      data-locum-por-dia={orcamento.perDayUsd ?? ""}
      data-locum-por-run={orcamento.perRunUsd ?? ""}
    >
      <span className="text-muted-foreground text-xs">
        {orcamento.version === null
          ? t("settings.budgets.unknownVersion")
          : t("settings.budgets.version", { version: orcamento.version })}
      </span>
      <span className="text-xs tabular-nums">
        {t("settings.budgets.perRun", { amount: moeda(orcamento.perRunUsd) })}
      </span>
      <span className="text-xs tabular-nums">
        {t("settings.budgets.perDay", { amount: moeda(orcamento.perDayUsd) })}
      </span>
      {semTetoEmTokens ? null : (
        <span className="text-xs tabular-nums" data-locum-teto-tokens="">
          {t("settings.budgets.tokenCaps", {
            perRun: orcamento.perRunTokens ?? t("settings.budgets.noCap"),
            perDay: orcamento.perDayTokens ?? t("settings.budgets.noCap"),
          })}
        </span>
      )}
      <span
        className="ml-auto text-muted-foreground text-xs tabular-nums"
        data-locum-hoje={orcamento.runsToday}
      >
        {t("settings.budgets.today", {
          count: orcamento.runsToday,
          spent: orcamento.spentTodayUsd.toFixed(3),
        })}
      </span>
      <span className="text-muted-foreground text-xs tabular-nums" data-locum-tokens-hoje={orcamento.tokensToday}>
        {t("settings.budgets.tokensToday", { count: orcamento.tokensToday })}
      </span>
      {orcamento.unpricedModels.length === 0 ? null : (
        <p
          className="basis-full text-amber-500 text-xs"
          data-locum-medindo-tokens={orcamento.unpricedModels.join(",")}
        >
          {t(semTetoEmTokens ? "settings.budgets.unpricedNoCap" : "settings.budgets.unpriced", {
            models: orcamento.unpricedModels.join(", "),
          })}
        </p>
      )}
    </div>
  );
}
