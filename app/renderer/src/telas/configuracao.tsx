import { Badge } from "@/components/ui/badge";
import { ProtecaoDeLimites } from "./limites";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { StatusDot } from "@/components/ui/status-dot";
import { pontoDaFerramenta } from "@/lib/estado-do-ponto";
import { CabecalhoDaTela } from "@/components/cabecalho-da-tela";
import { Button } from "@/components/ui/button";
import { call, useRead, type ReadResult } from "@/lib/bridge";
import { useAtualizacao } from "@/lib/atualizacao";
import { cn } from "@/lib/utils";
import { EscolhaDoModelo } from "../assistente-modelo";
import { GrupoDeLinhas, LinhaDePreferencia, Vazio } from "./blocos";
import { SlidersHorizontal, Sparkles, SquareTerminal, type LucideIcon } from "lucide-react";
import { quando } from "./sessoes";
import { useIdioma } from "../idioma";
import { useState } from "react";
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
 * horário de trabalho, o assistente, e o Locum dentro das ferramentas de
 * código. Provedores de modelo moram em Modelos, e tudo que é externo, em
 * Conexões.
 *
 * Segredo nenhum passa por aqui: o que a tela mostra de credencial é o
 * endereço dela e se existe valor guardado.
 */

/** As seções da Configuração, cada uma com rota própria. */
export const SECOES = ["general", "assistant", "tools"] as const;
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
      className="mx-auto flex w-full max-w-5xl flex-col gap-6"
      data-estado={estado}
      data-locum-cofre={credenciais.data?.available === true ? "legivel" : "fechado"}
      data-locum-fallbacks={fallbacks.data?.length ?? -1}
      data-locum-maquina={machineId ?? ""}
      data-locum-secao-ativa={secao}
      data-locum-probe="settings"
    >
      <CabecalhoDaTela descricao={t("settings.lead")} titulo={t("nav.settings")} />

      {erro === undefined ? null : (
        <p className="text-destructive text-sm">
          {t("settings.refused", { channel: erro.channel, message: erro.message })}
        </p>
      )}

      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <NavDaConfiguracao atual={secao} navegar={navegar} />

        <div className="flex min-w-0 max-w-2xl flex-1 flex-col gap-6">
          <TopoDaSecao secao={secao} />

          {secao === "general" ? (
            <GrupoDeLinhas>
              <LinhaDePreferencia descricao={t("settings.language.description")} titulo={t("settings.language.title")}>
                <EscolhaDoIdioma />
              </LinhaDePreferencia>
              <LinhaDePreferencia descricao={t("settings.updates.description")} titulo={t("settings.updates.title")}>
                <Atualizacao />
              </LinhaDePreferencia>
              <LinhaDePreferencia descricao={t("settings.staleDays.description")} titulo={t("settings.staleDays.title")}>
                <EscolhaDeStaleDays />
              </LinhaDePreferencia>
              <LinhaDePreferencia descricao={t("settings.workingHours.description")} titulo={t("settings.workingHours.title")}>
                <EscolhaDeWorkingHours />
              </LinhaDePreferencia>
              <LinhaDePreferencia descricao={t("limits.settings.description")} empilhado titulo={t("limits.settings.title")}>
                <ProtecaoDeLimites />
              </LinhaDePreferencia>
              <LinhaDePreferencia
                descricao={t("settings.initiativesRoot.description")}
                empilhado
                titulo={t("settings.initiativesRoot.title")}
              >
                <EscolhaDaRaiz />
              </LinhaDePreferencia>
            </GrupoDeLinhas>
          ) : null}

          {secao === "assistant" ? (
            <>
              <GrupoDeLinhas
                descricao={t("settings.assistantModel.description")}
                titulo={t("settings.assistantModel.title")}
              >
                <EscolhaDoModelo />
              </GrupoDeLinhas>

              <GrupoDeLinhas
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
              </GrupoDeLinhas>
            </>
          ) : null}

          {secao === "tools" ? (
            <>
              <GrupoDeLinhas
                descricao={t("settings.toolsLocum.description")}
                titulo={t("settings.toolsLocum.title")}
              >
                <ClaudeCode />
                <Opencode />
              </GrupoDeLinhas>
              <GrupoDeLinhas>
                <LinhaDePreferencia
                  descricao={t("settings.sessionTerminal.description")}
                  titulo={t("settings.sessionTerminal.title")}
                >
                  <EscolhaDoTerminal />
                </LinhaDePreferencia>
              </GrupoDeLinhas>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const ICONE_DA_SECAO: Record<SecaoId, LucideIcon> = {
  general: SlidersHorizontal,
  assistant: Sparkles,
  tools: SquareTerminal,
};

/**
 * A navegação entre as seções, de lado, como nas preferências do sistema: com
 * quatro seções e mais por vir, abas em linha viravam uma fila de palavras sem
 * dizer o que cada uma guarda.
 */
function NavDaConfiguracao({ atual, navegar }: { atual: SecaoId; navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t("nav.settings")}
      className="flex shrink-0 gap-0.5 overflow-x-auto md:sticky md:top-4 md:w-44 md:flex-col"
      data-locum-probe="secoes"
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
            type="button"
          >
            <Icone aria-hidden className="size-3.5" />
            <span>{t(`settings.sections.${id}`)}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** Título grande e o que a seção guarda, no topo do conteúdo. */
function TopoDaSecao({ secao }: { secao: SecaoId }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-0.5">
      <h2 className="text-[15px] font-medium tracking-tight">{t(`settings.sections.${secao}`)}</h2>
      <p className="text-muted-foreground max-w-[68ch] text-xs">{t(`settings.sectionLead.${secao}`)}</p>
    </div>
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
    <div
      className="flex flex-col items-end gap-1.5"
      data-locum-idioma-ativo={language}
      data-locum-idioma-preferencia={preference ?? ""}
      data-locum-idioma-sistema={system}
      data-locum-probe="idioma-escolha"
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

      <p className="text-muted-foreground text-xs">
        {t("settings.language.active", { language: autonimo(language) })}
      </p>

      {erro === null ? null : (
        <p className="text-destructive text-xs">
          {t("settings.language.refused", { message: erro })}
        </p>
      )}
    </div>
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

  if (estado === undefined) return <Vazio>{t("settings.updates.loading")}</Vazio>;

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
    <div
      className="flex max-w-80 flex-col items-end gap-1.5 text-right"
      data-locum-probe="atualizacao"
      data-locum-atualizacao-fase={estado.phase}
      data-locum-atualizacao-motivo={estado.reason ?? ""}
    >
      <p className="text-[13px]">
        {t("settings.updates.current", { version: estado.current })}
        <span className="text-muted-foreground"> · {situacao}</span>
      </p>
      {estado.lastCheckAt === null ? null : (
        <p className="text-muted-foreground text-xs">
          {t("settings.updates.lastCheck", { when: new Date(estado.lastCheckAt).toLocaleString() })}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-1">
        {estado.phase === "ready" ? (
          <Button onClick={() => void call("updates.apply")} size="sm">
            {t("settings.updates.apply", { version: estado.available?.version ?? "" })}
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
        <Button
          disabled={ocupado}
          onClick={() => agir("updates.setEnabled", !estado.enabled)}
          size="sm"
          variant="ghost"
        >
          {estado.enabled ? t("settings.updates.turnOff") : t("settings.updates.turnOn")}
        </Button>
      </div>
    </div>
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
    <div className="flex items-center gap-2" data-locum-probe="stale-days">
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
      {erro && <span className="text-sev-critical text-xs">{erro}</span>}
    </div>
  );
}

function EscolhaDeWorkingHours() {
  const { t } = useTranslation();
  const lido = useRead("scheduler.getWorkingHours");
  const [config, setConfig] = useState<WorkingHoursConfig | null>(null);
  const [ocupado, setOcupado] = useState(false);
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
    setOcupado(true);
    call("scheduler.setWorkingHours", novo)
      .then(() => {
        setSalvo(true);
        setTimeout(() => setSalvo(false), 1500);
      })
      .finally(() => setOcupado(false));
  };

  return (
    <div className="flex flex-col items-end gap-2 text-[13px]" data-locum-probe="working-hours">
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            checked={atual.enabled}
            className="size-4 rounded border-border"
            onChange={(e) => salvar({ ...atual, enabled: e.target.checked })}
            type="checkbox"
          />
          <span className="text-[13px]">{t("settings.workingHours.enableLabel")}</span>
        </label>
        {salvo && <span className="text-muted-foreground text-xs">{t("settings.workingHours.saved")}</span>}
      </div>

      {atual.enabled && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">{t("settings.workingHours.start")}</span>
            <Input
              aria-label={t("settings.workingHours.start")}
              className="h-7 w-24 font-mono text-xs"
              onChange={(e) => salvar({ ...atual, start: e.target.value })}
              type="time"
              value={atual.start}
            />
            <span className="text-muted-foreground text-xs">{t("settings.workingHours.end")}</span>
            <Input
              aria-label={t("settings.workingHours.end")}
              className="h-7 w-24 font-mono text-xs"
              onChange={(e) => salvar({ ...atual, end: e.target.value })}
              type="time"
              value={atual.end}
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">{t("settings.workingHours.offHoursLabel")}</span>
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
          </div>
        </div>
      )}
    </div>
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
    <div className="flex items-center gap-2" data-locum-probe="initiatives-root">
      <label className="sr-only" htmlFor="initiatives-root">
        {t("settings.initiativesRoot.label")}
      </label>
      <Input
        className="h-8 flex-1 font-mono text-xs"
        id="initiatives-root"
        onChange={(e) => setRascunho(e.target.value)}
        placeholder={t("settings.initiativesRoot.label")}
        type="text"
        value={valor}
      />
      <Button disabled={ocupado || valor === lido.data} onClick={gravar} size="sm" variant="secondary">
        {t("common.save")}
      </Button>
      {erro && <span className="text-sev-critical text-xs">{erro}</span>}
    </div>
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
    <div
      aria-label={t("settings.sessionTerminal.title")}
      className="flex flex-wrap items-center justify-end gap-1"
      data-locum-probe="session-terminal"
      role="group" data-locum-terminal={atual}>
      {TERMINAIS.filter((terminal) => terminal === atual || (instalados.data ?? TERMINAIS).includes(terminal)).map((terminal) => (
        <Button
          data-locum-escolhido={atual === terminal ? "sim" : "nao"}
          key={terminal}
          onClick={() => escolher(terminal)}
          size="sm"
          variant={atual === terminal ? "secondary" : "ghost"}
        >
          {t(`settings.sessionTerminal.${terminal}`)}
        </Button>
      ))}
      {erro && <span className="text-sev-critical text-xs">{erro}</span>}
    </div>
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



/**
 * O Locum dentro do Claude Code, num clique.
 *
 * O botão roda o `claude mcp add` apontando para este aplicativo, que serve o
 * MCP por `--mcp` com o mesmo cofre da janela: é o que deixa o token guardado
 * aqui valer numa sessão do terminal sem a pessoa exportar nada. A linha do
 * comando aparece para quem preferir colar ela mesma.
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
    <div
      className="border-border flex flex-col gap-2 border-b px-3 py-2.5 last:border-b-0"
      data-locum-claude-code={situacao ?? ""}
      data-locum-probe="claude-code"
    >
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <span className="font-medium">{t("settings.claudeCode.title")}</span>
        {situacao === null ? null : (
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <StatusDot estado={pontoDaFerramenta(situacao)} />
            {t(`settings.claudeCode.${situacao}`)}
          </span>
        )}
        {estado !== null && estado.cli === null ? (
          <Badge variant="outline">{t("settings.claudeCode.noCli")}</Badge>
        ) : null}
        <div className="ml-auto">
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
        </div>
      </div>
      {situacao === "connected" ? (
        <p className="text-muted-foreground text-xs">{t("settings.claudeCode.connectedHint")}</p>
      ) : null}
      {erro === null ? null : <p className="text-sev-critical text-xs">{erro}</p>}
      {estado === null ? null : (
        <code className="bg-muted text-muted-foreground block overflow-x-auto rounded-md px-2 py-1 font-mono text-[11px] whitespace-nowrap">
          {estado.command}
        </code>
      )}
    </div>
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
    <div className="border-border flex flex-col gap-2 border-b px-3 py-2.5 last:border-b-0" data-locum-probe="opencode">
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <span className="font-medium">{t("settings.opencode.title")}</span>
        {situacao === null ? null : (
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <StatusDot estado={pontoDaFerramenta(situacao)} />
            {t(`settings.claudeCode.${situacao}`)}
          </span>
        )}
        <div className="ml-auto">
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
        </div>
      </div>
      {situacao === "connected" ? (
        <p className="text-muted-foreground text-xs">{t("settings.opencode.connectedHint")}</p>
      ) : null}
      {erro === null ? null : <p className="text-sev-critical text-xs">{erro}</p>}
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
    </div>
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
