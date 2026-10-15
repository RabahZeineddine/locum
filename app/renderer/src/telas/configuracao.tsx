import { Badge } from "@/components/ui/badge";
import { CabecalhoDaTela } from "@/components/cabecalho-da-tela";
import { Button } from "@/components/ui/button";
import { call, read, useRead, type ReadResult } from "@/lib/bridge";
import { rotuloDoModelo, rotuloDoProvedor } from "@/lib/rotulos";
import { cn } from "@/lib/utils";
import { EscolhaDoModelo } from "../assistente-modelo";
import { Grupo, Preferencia, Secao, SecaoEmGrade, Vazio } from "./blocos";
import { Cpu, Plus, SlidersHorizontal, Sparkles, SquareTerminal, type LucideIcon } from "lucide-react";
import { quando } from "./sessoes";
import { useIdioma } from "../idioma";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Language } from "../../../src/services/i18n-service.js";
import type { UpdaterState } from "../../../src/update/state.js";
import type { WorkingHoursConfig } from "../../../src/config/types.js";
import type { TelaProps } from "../rotas";

type Provedor = ReadResult<"providers.list">[number];
type Fallback = ReadResult<"providers.fallbacks">[number];
type Orcamento = ReadResult<"agents.budgets">[number];
type Preco = ReadResult<"providers.prices">[number];
type Credencial = ReadResult<"credentials.overview">["refs"][number];
type ChaveDeProvedor = ReadResult<"providers.credentials">[number];
type ConferenciaDeProvedor = ReadResult<"providers.checkSecret">;
type EstadoDoClaudeCode = ReadResult<"claudeCode.status">;
type EstadoDoOpencode = ReadResult<"opencode.status">;

/**
 * A tela de configuracao: o que esta maquina tem, para onde ela troca, o que
 * ela sabe conectar, e quanto ela pode gastar.
 *
 * Segredo nenhum passa por aqui. O que as secoes de provedor e de servidor
 * mostram e o endereco da credencial e se existe valor guardado nele, que e
 * tudo que `credentials.overview` devolve: o cofre so se abre no caminho de
 * quem vai conectar, e a janela nao e esse caminho.
 *
 * Testar conexao e listar ferramentas ficam atras de botao, e nao na leitura
 * que dispara ao montar. As duas sobem o servidor que vao examinar, e abrir a
 * tela subiria todo cadastro de uma vez, o que num app que fica na bandeja o
 * dia todo e barulho caro.
 */
/**
 * As seções da Configuração, cada uma com rota própria.
 *
 * Era uma página só com doze blocos, e metade não era configuração do app:
 * repositório observado e orçamento são de um agent, e moram no detalhe dele.
 * O que ficou se divide pelo que a pessoa veio fazer: ajustar o app, dizer
 * quais modelos rodam, ou ligar o Locum a outro serviço.
 */
export const SECOES = ["general", "models", "assistant", "tools"] as const;
export type SecaoId = (typeof SECOES)[number];

export function Configuracao({ detalhe, navegar }: TelaProps) {
  const { t } = useTranslation();
  const secao: SecaoId = (SECOES as readonly string[]).includes(detalhe ?? "")
    ? (detalhe as SecaoId)
    : "general";
  const maquina = useRead("machine.profile");
  const machineId = maquina.data?.machineId ?? null;

  const provedores = useRead("providers.list");
  const chaves = useRead("providers.credentials");
  /*
   * Guardar chave muda duas leituras ao mesmo tempo: a chave em si e a
   * disponibilidade do provedor. Elas voltam juntas para que a linha nunca
   * apareça com chave guardada e provedor ainda apagado, que é o meio segundo
   * em que alguém acharia que não funcionou.
   */
  const [provedoresRecarregados, setProvedoresRecarregados] = useState<{
    lista: Provedor[];
    chaves: ChaveDeProvedor[];
  } | null>(null);

  const recarregarProvedores = (): Promise<void> =>
    Promise.all([read("providers.list"), read("providers.credentials")]).then(
      ([lista, novasChaves]) => setProvedoresRecarregados({ lista, chaves: novasChaves }),
      () => undefined,
    );

  const listaDeProvedores = provedoresRecarregados?.lista ?? provedores.data ?? [];
  // O desligado fica entre os ligados, com o botão de religar: foi a pessoa
  // que desligou, e ele não precisa de chave nenhuma para voltar.
  const ligados = listaDeProvedores.filter((p) => p.available || p.disabled);
  // Gateway cadastrado sem chave guarda a chave na própria linha, na seção de
  // gateways: aqui ele apareceria duas vezes, e longe de onde foi cadastrado.
  const paraLigar = listaDeProvedores.filter((p) => !p.available && !p.disabled && p.registered === null);
  const modelos = useModelosLigados(ligados.filter((p) => p.available).map((p) => p.name).join(","));
  const chavesPorProvedor = new Map(
    (provedoresRecarregados?.chaves ?? chaves.data ?? []).map((c) => [c.provider, c]),
  );
  // A tabela de substituicao e por maquina, e o identificador chega por outra
  // leitura. Com ele ainda nulo o canal responde lista vazia sem tocar no
  // banco, e a tela repinta quando ele chegar.
  const fallbacks = useRead("providers.fallbacks", machineId ?? "");
  const servidores = useRead("mcp.list");
  const orcamentos = useRead("agents.budgets");
  const credenciais = useRead("credentials.overview");
  const precos = useRead("providers.prices");
  /*
   * Gravar preço muda o aviso do orçamento: modelo que ganhou preço deixa de
   * ser medido só em tokens. As duas leituras voltam juntas pelo mesmo motivo
   * das de provedor logo acima.
   */
  const [precosRecarregados, setPrecosRecarregados] = useState<{
    precos: Preco[];
    orcamentos: Orcamento[];
  } | null>(null);

  const recarregarPrecos = (): Promise<void> =>
    Promise.all([read("providers.prices"), read("agents.budgets")]).then(
      ([novosPrecos, novosOrcamentos]) =>
        setPrecosRecarregados({ precos: novosPrecos, orcamentos: novosOrcamentos }),
      () => undefined,
    );

  const listaDePrecos = precosRecarregados?.precos ?? precos.data ?? [];
  const listaDeOrcamentos = precosRecarregados?.orcamentos ?? orcamentos.data ?? [];

  const leituras = [provedores, chaves, fallbacks, servidores, orcamentos, credenciais, precos];
  const erro = leituras.find((l) => l.status === "error")?.error;
  const pronto =
    machineId !== null && leituras.every((l) => l.status === "ready");
  const estado = erro !== undefined ? "erro" : pronto ? "pronto" : "carregando";

  // Por quem aponta, e nao por convencao de nome: a referencia de um cadastro
  // e escolhida por quem liga os dois, entao adivinha-la a partir do nome do
  // provider acertaria hoje e erraria no dia em que alguem apontasse dois
  // cadastros para a mesma credencial.
  const porCadastro = new Map<string, Credencial>();
  for (const credencial of credenciais.data?.refs ?? []) {
    for (const uso of credencial.users) porCadastro.set(`${uso.kind}:${uso.name}`, credencial);
  }

  const ligadosEmCartao = ligados.map((provedor) => (
    <LinhaDoProvedor
      chave={chavesPorProvedor.get(provedor.name)}
      key={provedor.name}
      modelos={modelos === null ? null : (modelos.get(provedor.name) ?? null)}
      precos={listaDePrecos.filter((p) => p.provider === provedor.name)}
      provedor={provedor}
      recarregar={recarregarProvedores}
      recarregarPrecos={recarregarPrecos}
    />
  ));

  return (
    <div
      className="mx-auto flex w-full max-w-5xl flex-col gap-6"
      data-estado={estado}
      data-locum-cofre={credenciais.data?.available === true ? "legivel" : "fechado"}
      data-locum-fallbacks={fallbacks.data?.length ?? -1}
      data-locum-maquina={machineId ?? ""}
      data-locum-secao-ativa={secao}
      data-locum-probe="settings"
      data-locum-provedores={listaDeProvedores.map((p) => p.name).join(",")}
      data-locum-servidores={(servidores.data ?? []).map((s) => s.config.name).join(",")}
    >
      <CabecalhoDaTela descricao={t("settings.lead")} titulo={t("nav.settings")} />

      {erro === undefined ? null : (
        <p className="text-destructive text-sm">
          {t("settings.refused", { channel: erro.channel, message: erro.message })}
        </p>
      )}

      <div className="flex flex-col gap-8 md:flex-row md:items-start">
        <NavDaConfiguracao atual={secao} navegar={navegar} />

        <div className="flex min-w-0 max-w-2xl flex-1 flex-col gap-8">
          <TopoDaSecao secao={secao} />

          {secao === "general" ? (
            <Grupo>
              <Preferencia descricao={t("settings.language.description")} titulo={t("settings.language.title")}>
                <EscolhaDoIdioma />
              </Preferencia>
              <Preferencia descricao={t("settings.updates.description")} titulo={t("settings.updates.title")}>
                <Atualizacao />
              </Preferencia>
              <Preferencia descricao={t("settings.staleDays.description")} titulo={t("settings.staleDays.title")}>
                <EscolhaDeStaleDays />
              </Preferencia>
              <Preferencia descricao={t("settings.workingHours.description")} titulo={t("settings.workingHours.title")}>
                <EscolhaDeWorkingHours />
              </Preferencia>
              <Preferencia
                descricao={t("settings.initiativesRoot.description")}
                empilhado
                titulo={t("settings.initiativesRoot.title")}
              >
                <EscolhaDaRaiz />
              </Preferencia>
            </Grupo>
          ) : null}

          {secao === "models" ? (
            <>
              <SecaoEmGrade descricao={t("settings.providers.description")} titulo={t("settings.providers.title")}>
                {ligados.length === 0 ? <Vazio>{t("settings.providers.empty")}</Vazio> : ligadosEmCartao}
              </SecaoEmGrade>

              {paraLigar.length === 0 ? null : (
                <SecaoEmGrade
                  colunas
                  descricao={t("settings.providers.addDescription")}
                  titulo={t("settings.providers.addTitle")}
                >
                  {paraLigar.map((provedor) => (
                    <LinhaDoProvedor
                      chave={chavesPorProvedor.get(provedor.name)}
                      key={provedor.name}
                      modelos={null}
                      precos={[]}
                      provedor={provedor}
                      recarregar={recarregarProvedores}
                      recarregarPrecos={recarregarPrecos}
                    />
                  ))}
                </SecaoEmGrade>
              )}

              <Secao descricao={t("settings.registered.description")} titulo={t("settings.registered.title")}>
                <ProvedoresCadastrados
                  chaves={chavesPorProvedor}
                  provedores={listaDeProvedores}
                  recarregar={recarregarProvedores}
                />
              </Secao>
            </>
          ) : null}

          {secao === "assistant" ? (
            <>
              <section className="superficie relative overflow-hidden rounded-xl">
                <div aria-hidden className="ia-gradiente absolute inset-x-0 top-0 h-px opacity-80" />
                <div className="flex items-start gap-3 px-4 pt-4 pb-2">
                  <span className="ia-gradiente flex size-8 shrink-0 items-center justify-center rounded-lg">
                    <Sparkles className="text-primary-foreground size-4" aria-hidden />
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <h2 className="text-[15px] font-medium tracking-tight">{t("settings.assistantModel.title")}</h2>
                    <p className="text-muted-foreground max-w-[68ch] text-xs">{t("settings.assistantModel.description")}</p>
                  </div>
                </div>
                <EscolhaDoModelo />
              </section>

              <Secao
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
              </Secao>
            </>
          ) : null}

          {secao === "tools" ? (
            <>
              <Secao descricao={t("settings.toolsLocum.description")} titulo={t("settings.toolsLocum.title")}>
                <ClaudeCode />
                <Opencode />
              </Secao>
              <Grupo>
                <Preferencia
                  descricao={t("settings.sessionTerminal.description")}
                  titulo={t("settings.sessionTerminal.title")}
                >
                  <EscolhaDoTerminal />
                </Preferencia>
              </Grupo>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const ICONE_DA_SECAO: Record<SecaoId, LucideIcon> = {
  general: SlidersHorizontal,
  models: Cpu,
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
      className="flex shrink-0 gap-1 overflow-x-auto md:sticky md:top-4 md:w-56 md:flex-col"
      data-locum-probe="secoes"
      role="tablist"
    >
      <div className="hidden md:block px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
        {t("nav.settingsTitle")}
      </div>
      {SECOES.map((id) => {
        const Icone = ICONE_DA_SECAO[id];
        const ativo = id === atual;
        return (
          <button
            aria-selected={ativo}
            className={cn(
              "focus-visible:ring-ring flex shrink-0 cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-all duration-150 focus-visible:ring-2 focus-visible:outline-none",
              ativo
                ? "bg-muted font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
            data-locum-secao={id}
            key={id}
            onClick={() => navegar("settings", id)}
            role="tab"
            type="button"
          >
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-lg transition-colors",
                ativo ? (id === "assistant" ? "ia-gradiente text-primary-foreground" : "bg-primary/10 text-primary") : "text-muted-foreground",
              )}
            >
              <Icone aria-hidden className="size-3.5" />
            </span>
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
    <div className="flex flex-col gap-1">
      <h2 className="text-xl font-semibold tracking-[-0.01em]">{t(`settings.sections.${secao}`)}</h2>
      <p className="text-muted-foreground max-w-[68ch] text-sm">{t(`settings.sectionLead.${secao}`)}</p>
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
      className="flex flex-col gap-2 px-4 py-3"
      data-locum-idioma-ativo={language}
      data-locum-idioma-preferencia={preference ?? ""}
      data-locum-idioma-sistema={system}
      data-locum-probe="idioma-escolha"
    >
      <div className="flex flex-wrap gap-2">
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
  const lido = useRead("updates.state");
  const [recarregado, setRecarregado] = useState<UpdaterState | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const estado = recarregado ?? lido.data;

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
      className="flex flex-col gap-2 px-4 py-3"
      data-locum-probe="atualizacao"
      data-locum-atualizacao-fase={estado.phase}
      data-locum-atualizacao-motivo={estado.reason ?? ""}
    >
      <p className="text-sm">
        {t("settings.updates.current", { version: estado.current })}
        <span className="text-muted-foreground"> · {situacao}</span>
      </p>
      {estado.lastCheckAt === null ? null : (
        <p className="text-muted-foreground text-xs">
          {t("settings.updates.lastCheck", { when: new Date(estado.lastCheckAt).toLocaleString() })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
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
    <div className="flex items-center gap-3 px-4 py-3" data-locum-probe="stale-days">
      <label className="text-sm" htmlFor="stale-days">
        {t("settings.staleDays.label")}
      </label>
      <input
        className="border-border bg-background w-16 rounded border px-2 py-1 text-right text-sm tabular-nums"
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
    <div className="flex flex-col gap-3 px-4 py-3 text-sm" data-locum-probe="working-hours">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            checked={atual.enabled}
            className="size-4 rounded border-border"
            onChange={(e) => salvar({ ...atual, enabled: e.target.checked })}
            type="checkbox"
          />
          <span className="font-medium text-sm">{t("settings.workingHours.enableLabel")}</span>
        </label>
        {salvo && <span className="text-emerald-500 font-medium text-xs">{t("settings.workingHours.saved")}</span>}
      </div>

      {atual.enabled && (
        <div className="flex flex-wrap items-center gap-4 pt-1">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">{t("settings.workingHours.start")}</span>
            <input
              className="border-border bg-background rounded border px-2 py-1 text-xs font-mono"
              onChange={(e) => salvar({ ...atual, start: e.target.value })}
              type="time"
              value={atual.start}
            />
            <span className="text-muted-foreground text-xs">{t("settings.workingHours.end")}</span>
            <input
              className="border-border bg-background rounded border px-2 py-1 text-xs font-mono"
              onChange={(e) => salvar({ ...atual, end: e.target.value })}
              type="time"
              value={atual.end}
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">{t("settings.workingHours.offHoursLabel")}</span>
            <select
              className="border-border bg-background rounded border px-2 py-1 text-xs"
              onChange={(e) => salvar({ ...atual, offHoursBehavior: e.target.value as WorkingHoursConfig["offHoursBehavior"] })}
              value={atual.offHoursBehavior}
            >
              <option value="pause">{t("settings.workingHours.behaviorPause")}</option>
              <option value="slow">{t("settings.workingHours.behaviorSlow")}</option>
              <option value="unrestricted">{t("settings.workingHours.behaviorUnrestricted")}</option>
            </select>
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
    <div className="flex items-center gap-3 px-4 py-3" data-locum-probe="initiatives-root">
      <label className="sr-only" htmlFor="initiatives-root">
        {t("settings.initiativesRoot.label")}
      </label>
      <input
        className="border-border bg-background flex-1 rounded border px-2 py-1 font-mono text-sm"
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
    <div className="flex flex-wrap items-center gap-2 px-4 py-3" data-locum-probe="session-terminal" data-locum-terminal={atual}>
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

/* --------------------------------------------------------------- provedores */

type ModelosDoProvedor = { modelos: string[]; erro?: string };

/*
 * Os modelos de cada provedor ligado, lidos uma vez por conjunto de ligados.
 * Bate no catálogo de quem tem chave, que é de graça e só lista nomes; guardar
 * ou esquecer uma chave muda o conjunto, e a leitura refaz sozinha. Enquanto
 * não volta, o valor é nulo, e a linha diz que está lendo.
 */
function useModelosLigados(nomes: string): Map<string, ModelosDoProvedor> | null {
  const [lidos, setLidos] = useState<{ nomes: string; mapa: Map<string, ModelosDoProvedor> } | null>(null);
  useEffect(() => {
    if (nomes === "") return;
    let vivo = true;
    call("providers.allModels", { assinatura: true }).then(
      (lista) => vivo && setLidos({ nomes, mapa: new Map(lista.map((c) => [c.provedor, c])) }),
      () => vivo && setLidos({ nomes, mapa: new Map() }),
    );
    return () => {
      vivo = false;
    };
  }, [nomes]);
  return lidos?.nomes === nomes ? lidos.mapa : null;
}

const MODELOS_VISIVEIS = 12;

function ListaDeModelos({ modelos, provedor }: { modelos: ModelosDoProvedor | null; provedor: string }) {
  const { t } = useTranslation();
  const [todos, setTodos] = useState(false);

  if (modelos === null) {
    return <p className="text-muted-foreground pl-5 text-xs">{t("settings.providers.modelsLoading")}</p>;
  }
  if (modelos.erro !== undefined && modelos.modelos.length === 0) {
    return (
      <p className="text-muted-foreground pl-5 text-xs">
        {t("settings.providers.modelsError", { message: modelos.erro })}
      </p>
    );
  }
  if (modelos.modelos.length === 0) {
    return <p className="text-muted-foreground pl-5 text-xs">{t("settings.providers.modelsNone")}</p>;
  }

  const visiveis = todos ? modelos.modelos : modelos.modelos.slice(0, MODELOS_VISIVEIS);
  const resto = modelos.modelos.length - visiveis.length;
  return (
    <div className="flex flex-wrap gap-1.5 pl-5" data-locum-modelos={provedor}>
      {visiveis.map((m) => (
        <span
          className="bg-muted text-foreground rounded px-2 py-0.5 text-xs"
          data-locum-modelo={m}
          key={m}
          title={m}
        >
          {rotuloDoModelo(m)}
        </span>
      ))}
      {resto > 0 ? (
        <button
          className="text-muted-foreground hover:text-foreground cursor-pointer rounded px-2 py-0.5 text-xs"
          onClick={() => setTodos(true)}
          type="button"
        >
          {t("settings.providers.modelsMore", { count: resto })}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Desligar vale para o que o Locum acha sozinho, como o Claude Code instalado
 * na máquina: o provedor some do chat, dos agents e da substituição, sem
 * apagar chave nem desinstalar nada.
 */
function LigaDesligaProvedor({ provedor, recarregar }: { provedor: Provedor; recarregar: () => Promise<void> }) {
  const { t } = useTranslation();
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const alternar = (): void => {
    setEnviando(true);
    setErro(null);
    call("providers.setEnabled", provedor.name, provedor.disabled).then(
      async () => {
        await recarregar();
        setEnviando(false);
      },
      (falha: unknown) => {
        setEnviando(false);
        setErro(falha instanceof Error ? falha.message : String(falha));
      },
    );
  };

  return (
    <span className="ml-auto flex items-center gap-2">
      {erro === null ? null : <span className="text-sev-critical text-xs">{erro}</span>}
      <Button className="h-7 cursor-pointer" disabled={enviando} onClick={alternar} size="sm" variant="ghost">
        {t(provedor.disabled ? "settings.providers.enable" : "settings.providers.disable")}
      </Button>
    </span>
  );
}

/** Cor de cada provedor no monograma; o resto usa o cinza da interface. */
const COR_DO_PROVEDOR: Record<string, string> = {
  "claude-code": "#D97757",
  anthropic: "#D97757",
  openai: "#10A37F",
  codex: "#10A37F",
  google: "#4285F4",
  glm: "#3859FF",
  ollama: "#64748B",
};

/** A inicial do provedor numa pastilha com a cor da marca, apagada quando ele não roda. */
function Monograma({ nome, apagado }: { nome: string; apagado: boolean }) {
  const rotulo = rotuloDoProvedor(nome);
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg text-[13px] font-semibold text-white ring-1 ring-white/10",
        apagado && "opacity-45 grayscale",
      )}
      style={{ backgroundColor: COR_DO_PROVEDOR[nome] ?? "#475569" }}
    >
      {rotulo.slice(0, 1).toUpperCase()}
    </span>
  );
}

function LinhaDoProvedor({
  chave,
  modelos,
  precos,
  provedor,
  recarregar,
  recarregarPrecos,
}: {
  chave: ChaveDeProvedor | undefined;
  modelos: ModelosDoProvedor | null;
  precos: Preco[];
  provedor: Provedor;
  recarregar: () => Promise<void>;
  recarregarPrecos: () => Promise<void>;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="superficie flex flex-col gap-3 rounded-xl px-4 py-3 text-sm"
      data-locum-chave-ambiente={chave?.env === true ? "sim" : "nao"}
      data-locum-chave-conferida={chave?.checkedAt ?? ""}
      data-locum-chave-guardada={chave === undefined ? "" : chave.stored ? "sim" : "nao"}
      data-locum-chave-modelos={chave?.modelCount ?? ""}
      data-locum-chave-ref={chave?.ref ?? ""}
      data-locum-disponivel={provedor.available ? "sim" : "nao"}
      data-locum-provider={provedor.name}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Monograma apagado={!provedor.available} nome={provedor.name} />
        <span className="min-w-28 truncate text-sm font-medium" title={provedor.name}>
          {rotuloDoProvedor(provedor.name)}
        </span>
        {/* Na seção de adicionar, dizer "indisponível" em cada linha só repete o título. */}
        {provedor.available ? (
          <span className="text-chart-2 shrink-0 text-xs">{t("settings.providers.available")}</span>
        ) : null}
        {provedor.subscription ? (
          <span className="text-muted-foreground border-border shrink-0 rounded border px-1.5 text-[11px]">
            {t("settings.providers.subscription")}
          </span>
        ) : null}
        {provedor.disabled ? (
          <span className="text-muted-foreground shrink-0 text-xs">{t("settings.providers.disabled")}</span>
        ) : null}
        {provedor.available || provedor.disabled ? (
          <LigaDesligaProvedor provedor={provedor} recarregar={recarregar} />
        ) : null}
        {chave === undefined || chave.ref === null || (!chave.stored && !provedor.available) ? null : (
          <Badge
            data-locum-credencial={chave.ref}
            data-locum-guardado={chave.stored ? "sim" : "nao"}
            variant={chave.stored ? "secondary" : "outline"}
          >
            {t(chave.stored ? "settings.credential.stored" : "settings.credential.missing", {
              ref: chave.ref,
            })}
          </Badge>
        )}
        {/* Com campo de chave logo abaixo, o nome da variável de ambiente só repete o campo. */}
        {provedor.requires.length > 0 && (chave === undefined || chave.variable === null) ? (
          <span className="text-muted-foreground text-xs">
            {t(provedor.available ? "settings.providers.uses" : "settings.providers.missing", {
              requirements: provedor.requires.join(", "),
            })}
          </span>
        ) : null}
      </div>

      {provedor.available ? <ListaDeModelos modelos={modelos} provedor={provedor.name} /> : null}

      {chave === undefined || chave.variable === null ? null : provedor.available || provedor.disabled ? (
        <ChaveDoProvedor chave={chave} provedor={provedor} recarregar={recarregar} />
      ) : (
        // Recolhida enquanto o provedor não está em uso: cinco campos de senha
        // abertos viravam o assunto da tela. Fechada, ela continua no DOM.
        <details className="group">
          <summary className="text-primary hover:text-foreground w-fit cursor-pointer list-none text-xs font-medium">
            <Plus aria-hidden className="mr-1 inline size-3.5 align-[-2px]" />
            {t("settings.providers.addKey")}
          </summary>
          <div className="mt-2">
            <ChaveDoProvedor chave={chave} provedor={provedor} recarregar={recarregar} />
          </div>
        </details>
      )}

      {/*
        A assinatura gasta cota do plano, e não token cobrado: preço ali não mede
        nada. Nos outros, o preço só serve ao orçamento, então fica recolhido e
        só aparece no provedor que já roda.
      */}
      {provedor.subscription || !provedor.available ? null : (
        <details className="group">
          <summary className="text-muted-foreground hover:text-foreground w-fit cursor-pointer text-xs">
            {t("settings.prices.summary", { count: precos.length })}
          </summary>
          <div className="pt-2">
            <PrecosDoProvedor precos={precos} provedor={provedor.name} recarregar={recarregarPrecos} />
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * O preço de cada modelo deste provedor, em dólar por milhão de tokens.
 *
 * É o que o runtime nativo multiplica pelo uso de cada passo. Modelo sem
 * preço aqui custa zero no registro, e o orçamento dele só vale em tokens; a
 * seção de orçamentos avisa quando é esse o caso.
 */
function PrecosDoProvedor({
  precos,
  provedor,
  recarregar,
}: {
  precos: Preco[];
  provedor: string;
  recarregar: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [modelo, setModelo] = useState("");
  const [entrada, setEntrada] = useState("");
  const [saida, setSaida] = useState("");
  const [recusa, setRecusa] = useState<string | null>(null);

  const numero = (texto: string): number => Number(texto.replace(",", "."));
  const valido =
    modelo.trim().length > 0 &&
    entrada.trim().length > 0 &&
    saida.trim().length > 0 &&
    numero(entrada) >= 0 &&
    numero(saida) >= 0;

  const recusar = (erro: unknown): void => setRecusa(erro instanceof Error ? erro.message : String(erro));

  const gravar = (): void => {
    setRecusa(null);
    call("providers.setPrice", {
      provider: provedor,
      model: modelo.trim(),
      inputUsdPerMtok: numero(entrada),
      outputUsdPerMtok: numero(saida),
    }).then(() => {
      setModelo("");
      setEntrada("");
      setSaida("");
      return recarregar();
    }, recusar);
  };

  const apagar = (nome: string): void => {
    setRecusa(null);
    call("providers.removePrice", provedor, nome).then(recarregar, recusar);
  };

  const campo =
    "border-border bg-background focus-visible:ring-ring rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1";

  return (
    <div className="flex flex-col gap-1.5 pl-5" data-locum-precos={provedor}>
      {precos.map((preco) => (
        <div
          className="flex flex-wrap items-center gap-3 text-xs"
          data-locum-preco={`${preco.provider}/${preco.model}`}
          key={preco.model}
        >
          <span className="w-48 shrink-0 truncate font-mono">{preco.model}</span>
          <span className="tabular-nums">
            {t("settings.prices.rate", {
              input: preco.inputUsdPerMtok,
              output: preco.outputUsdPerMtok,
            })}
          </span>
          <Button onClick={() => apagar(preco.model)} size="sm" variant="ghost">
            {t("settings.prices.remove")}
          </Button>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={t("settings.prices.model", { provider: provedor })}
          className={cn(campo, "min-w-40 flex-1")}
          onChange={(evento) => setModelo(evento.target.value)}
          placeholder={t("settings.prices.modelPlaceholder")}
          spellCheck={false}
          value={modelo}
        />
        <input
          aria-label={t("settings.prices.input")}
          className={cn(campo, "w-28")}
          inputMode="decimal"
          onChange={(evento) => setEntrada(evento.target.value)}
          placeholder={t("settings.prices.input")}
          value={entrada}
        />
        <input
          aria-label={t("settings.prices.output")}
          className={cn(campo, "w-28")}
          inputMode="decimal"
          onChange={(evento) => setSaida(evento.target.value)}
          placeholder={t("settings.prices.output")}
          value={saida}
        />
        <Button disabled={!valido} onClick={gravar} size="sm" variant="secondary">
          {t("settings.prices.save")}
        </Button>
      </div>

      {recusa === null ? null : (
        <p className="text-destructive text-xs">{t("settings.prices.refused", { message: recusa })}</p>
      )}
    </div>
  );
}

type Exame =
  | { fase: "parado" }
  | { fase: "conferindo" }
  | { fase: "respondeu"; resultado: ConferenciaDeProvedor }
  | { fase: "recusado"; erro: string };

/**
 * A chave de um provedor: guardar, esquecer e perguntar o catálogo.
 *
 * Mesma viagem de mão única da credencial do GitHub. O valor digitado sai
 * daqui para o keychain e nunca volta, porque não existe canal que devolva
 * segredo: o que fica visível é se há algo guardado, quando foi a última
 * conferência e quantos modelos ela contou.
 *
 * Guardar deixa o provedor disponível na hora, sem reabrir a janela. Quem faz
 * isso é o serviço, que remonta o registro com a chave nova antes de
 * responder; aqui só se relê o que mudou.
 *
 * Conferir fica atrás de um clique pela mesma razão do teste de servidor MCP:
 * ele sai para a rede, e abrir a tela de configuração não é pedir exame.
 */
function ChaveDoProvedor({
  chave,
  provedor,
  recarregar,
}: {
  chave: ChaveDeProvedor;
  provedor: Provedor;
  recarregar: () => Promise<void>;
}) {
  const { i18n, t } = useTranslation();
  const [valor, setValor] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [exame, setExame] = useState<Exame>({ fase: "parado" });

  const guardar = (): void => {
    setSalvando(true);
    // O campo é limpo antes mesmo da resposta, como no token do GitHub: o que
    // foi digitado já está a caminho do cofre, e deixá-lo na tela só aumenta a
    // chance de ele aparecer numa captura ou num ombro alheio.
    const digitado = valor;
    setValor("");
    call("providers.saveSecret", provedor.name, digitado)
      .then(recarregar, () => undefined)
      .finally(() => {
        setSalvando(false);
        // A conferência anterior era da chave antiga, e o serviço já a apagou.
        setExame({ fase: "parado" });
      });
  };

  const esquecer = (): void => {
    call("providers.forgetSecret", provedor.name)
      .then(recarregar, () => undefined)
      .finally(() => setExame({ fase: "parado" }));
  };

  const conferir = (): void => {
    setExame({ fase: "conferindo" });
    call("providers.checkSecret", provedor.name).then(
      (resultado) => {
        setExame({ fase: "respondeu", resultado });
        void recarregar();
      },
      // `checkSecret` devolve a recusa do provedor como dado, então chegar
      // aqui quer dizer que a ponte recusou, e não que a chave está errada.
      (erro: unknown) =>
        setExame({
          fase: "recusado",
          erro: erro instanceof Error ? erro.message : String(erro),
        }),
    );
  };

  const conferidaEm =
    chave.checkedAt === null ? null : new Date(chave.checkedAt * 1000).toLocaleString(i18n.language);

  return (
    <div className="flex flex-col gap-1.5 pl-5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={t("settings.providerKey.field", { provider: provedor.name })}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring min-w-56 flex-1 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-chave-campo={provedor.name}
          disabled={!chave.vault}
          onChange={(evento) => setValor(evento.target.value)}
          placeholder={t(
            chave.vault ? "settings.providerKey.placeholder" : "settings.providerKey.noVault",
            { variable: chave.variable },
          )}
          spellCheck={false}
          type="password"
          value={valor}
        />
        <Button
          data-locum-chave-salvar={provedor.name}
          disabled={salvando || !chave.vault || valor.trim().length === 0}
          onClick={guardar}
          size="sm"
          variant="secondary"
        >
          {t(salvando ? "settings.providerKey.saving" : "settings.providerKey.save")}
        </Button>
        {/* Sem chave guardada nem no ambiente, conferir só responderia "falta chave". */}
        {chave.stored || chave.env ? (
        <Button
          data-locum-chave-conferir={provedor.name}
          disabled={exame.fase === "conferindo"}
          onClick={conferir}
          size="sm"
          variant="ghost"
        >
          {t(
            exame.fase === "conferindo"
              ? "settings.providerKey.checking"
              : "settings.providerKey.check",
          )}
        </Button>
        ) : null}
        {chave.stored ? (
          <Button
            data-locum-chave-esquecer={provedor.name}
            onClick={esquecer}
            size="sm"
            variant="ghost"
          >
            {t("settings.providerKey.forget")}
          </Button>
        ) : null}
      </div>

      {chave.env && !chave.stored ? (
        <p className="text-muted-foreground text-xs">
          {t("settings.providerKey.fromEnv", { variable: chave.variable })}
        </p>
      ) : null}

      {conferidaEm === null ? null : (
        <p className="text-muted-foreground text-xs" data-locum-chave-historico={provedor.name}>
          {t("settings.providerKey.lastCheck", {
            count: chave.modelCount ?? 0,
            when: conferidaEm,
          })}
        </p>
      )}

      <ResultadoDaChave exame={exame} provedor={provedor.name} />
    </div>
  );
}

/* ---------------------------------------------- provedores cadastrados */

type Cadastrado = ReadResult<"providers.registered">[number];
type Remocao = ReadResult<"providers.remove">;

/**
 * Gateway compatível com OpenAI: cadastrar, ver e remover.
 *
 * A lista de provedores acima é fixa no código, e é por isso que esta seção
 * existe: um segundo gateway da empresa, um Ollama em outra máquina ou um
 * OpenRouter não têm onde entrar sem ela. O que se cadastra aqui aparece lá em
 * cima como qualquer outro provedor, com campo de chave próprio, e um passo
 * pode apontar para ele pelo identificador.
 *
 * Remover pede dois cliques quando o provedor está em uso. O primeiro volta
 * com a lista de onde ele aparece, e é o serviço que a monta: a tela mostra o
 * que recebeu e oferece o segundo clique, mas a decisão de não apagar em
 * silêncio é do lado que apaga.
 */
function ProvedoresCadastrados({
  chaves,
  provedores,
  recarregar,
}: {
  chaves: Map<string, ChaveDeProvedor>;
  provedores: Provedor[];
  recarregar: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const inicial = useRead("providers.registered");
  const [relido, setRelido] = useState<Cadastrado[] | null>(null);
  const [id, setId] = useState("");
  const [nome, setNome] = useState("");
  const [url, setUrl] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // Por provedor, e não um só para a seção: duas remoções avisadas ao mesmo
  // tempo mostrariam a lista de uso de uma na linha da outra.
  const [avisos, setAvisos] = useState<Record<string, Remocao>>({});

  const lista = relido ?? inicial.data ?? [];
  const recusa = erro ?? inicial.error?.message ?? null;

  const reler = (): Promise<void> =>
    Promise.all([read("providers.registered").then(setRelido), recarregar()]).then(
      () => undefined,
      (falha: unknown) => setErro(falha instanceof Error ? falha.message : String(falha)),
    );

  const agir = (acao: Promise<unknown>): Promise<unknown> => {
    setOcupado(true);
    return acao
      .then(
        (resultado) => {
          setErro(null);
          return resultado;
        },
        (falha: unknown) => {
          setErro(falha instanceof Error ? falha.message : String(falha));
          return undefined;
        },
      )
      .then(async (resultado) => {
        await reler();
        return resultado;
      })
      .finally(() => setOcupado(false));
  };

  const cadastrar = (): void => {
    void agir(
      call("providers.register", { id: id.trim(), label: nome.trim(), baseUrl: url.trim() }).then(
        () => {
          setId("");
          setNome("");
          setUrl("");
        },
      ),
    );
  };

  const remover = (alvo: string, force: boolean): void => {
    void agir(call("providers.remove", alvo, force)).then((resultado) => {
      const remocao = resultado as Remocao | undefined;
      setAvisos((antes) => {
        const proximos = { ...antes };
        // Removido ou recusado pela ponte, o aviso anterior sai: ele descrevia
        // um provedor que não está mais lá, ou uma tentativa que não chegou.
        if (remocao === undefined || remocao.removed) delete proximos[alvo];
        else proximos[alvo] = remocao;
        return proximos;
      });
    });
  };

  const valido = id.trim() !== "" && nome.trim() !== "" && url.trim() !== "";

  return (
    <div
      className="flex flex-col gap-3 px-4 py-3"
      data-locum-cadastrados={lista.map((p) => p.id).join(",")}
      data-locum-probe="provedores-cadastrados"
    >
      {lista.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("settings.registered.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {lista.map((cadastrado) => (
            <LinhaDoCadastrado
              aoRemover={(force) => remover(cadastrado.id, force)}
              aviso={avisos[cadastrado.id]}
              cadastrado={cadastrado}
              chave={chaves.get(cadastrado.id)}
              key={cadastrado.id}
              ocupado={ocupado}
              provedor={provedores.find((p) => p.name === cadastrado.id)}
              recarregar={reler}
            />
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={t("settings.registered.id")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-40 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-cadastrar-id=""
          onChange={(evento) => setId(evento.target.value)}
          placeholder={t("settings.registered.idHint")}
          spellCheck={false}
          value={id}
        />
        <input
          aria-label={t("settings.registered.label")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-44 rounded-md border px-3 py-1.5 text-xs outline-none focus-visible:ring-1"
          data-locum-cadastrar-nome=""
          onChange={(evento) => setNome(evento.target.value)}
          placeholder={t("settings.registered.labelHint")}
          spellCheck={false}
          value={nome}
        />
        <input
          aria-label={t("settings.registered.baseUrl")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring min-w-56 flex-1 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-cadastrar-url=""
          onChange={(evento) => setUrl(evento.target.value)}
          placeholder={t("settings.registered.baseUrlHint")}
          spellCheck={false}
          value={url}
        />
        <Button
          data-locum-cadastrar-salvar=""
          disabled={ocupado || !valido}
          onClick={cadastrar}
          size="sm"
          variant="secondary"
        >
          {t("settings.registered.add")}
        </Button>
      </div>

      <p className="text-muted-foreground max-w-[68ch] text-xs">{t("settings.registered.howTo")}</p>

      {recusa === null ? null : (
        <p className="text-destructive text-xs" data-locum-cadastrados-erro={recusa}>
          {t("settings.registered.refused", { message: recusa })}
        </p>
      )}
    </div>
  );
}

function LinhaDoCadastrado({
  aoRemover,
  aviso,
  cadastrado,
  chave,
  ocupado,
  provedor,
  recarregar,
}: {
  aoRemover: (force: boolean) => void;
  aviso: Remocao | undefined;
  cadastrado: Cadastrado;
  chave: ChaveDeProvedor | undefined;
  ocupado: boolean;
  provedor: Provedor | undefined;
  recarregar: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const usos = aviso === undefined || aviso.removed ? [] : aviso.usedBy;

  return (
    <li
      className="border-border flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm"
      data-locum-cadastrado={cadastrado.id}
      data-locum-cadastrado-nome={cadastrado.label}
      data-locum-cadastrado-url={cadastrado.baseUrl}
      data-locum-cadastrado-usos={usos.length}
    >
      <span className="font-mono text-[13px]">{cadastrado.id}</span>
      <span className="text-muted-foreground text-xs">{cadastrado.label}</span>
      <span className="text-muted-foreground font-mono text-xs">{cadastrado.baseUrl}</span>

      <div className="ml-auto flex items-center gap-1">
        <Button
          data-locum-cadastrado-remover={cadastrado.id}
          disabled={ocupado}
          onClick={() => aoRemover(false)}
          size="sm"
          variant="ghost"
        >
          {t("settings.registered.remove")}
        </Button>
        {usos.length === 0 ? null : (
          <Button
            data-locum-cadastrado-forcar={cadastrado.id}
            disabled={ocupado}
            onClick={() => aoRemover(true)}
            size="sm"
            variant="ghost"
          >
            {t("settings.registered.removeAnyway")}
          </Button>
        )}
      </div>

      {usos.length === 0 ? null : (
        <p className="text-destructive w-full text-xs">
          {t("settings.registered.inUse", {
            count: usos.length,
            where: usos
              .map((uso) =>
                uso.kind === "step"
                  ? t("settings.registered.useStep", { agent: uso.agentId, step: uso.stepKey })
                  : t("settings.registered.useFallback", { from: uso.from, to: uso.to }),
              )
              .join(", "),
          })}
        </p>
      )}
      {chave === undefined || chave.variable === null || provedor === undefined ? null : (
        <div className="w-full">
          <ChaveDoProvedor chave={chave} provedor={provedor} recarregar={recarregar} />
        </div>
      )}
    </li>
  );
}

function ResultadoDaChave({ exame, provedor }: { exame: Exame; provedor: string }) {
  const { t } = useTranslation();

  if (exame.fase === "parado" || exame.fase === "conferindo") return null;

  if (exame.fase === "recusado") {
    return (
      <p className="text-destructive text-xs" data-locum-chave-resultado="recusado">
        {t("settings.providerKey.bridgeRefused", { message: exame.erro })}
      </p>
    );
  }

  const { resultado } = exame;
  if (resultado.ok) {
    return (
      <p className="text-chart-2 text-xs" data-locum-chave-resultado="ok">
        {t("settings.providerKey.answered", { count: resultado.count, provider: provedor })}
      </p>
    );
  }

  return (
    <p className="text-destructive text-xs" data-locum-chave-resultado={resultado.reason}>
      {resultado.reason === "missing"
        ? t("settings.providerKey.missing", { provider: provedor })
        : t("settings.providerKey.failed", { message: resultado.message })}
    </p>
  );
}

/* ---------------------------------------------------------------- fallbacks */

function LinhaDoFallback({ fallback }: { fallback: Fallback }) {
  const { t } = useTranslation();

  return (
    <div
      className="flex flex-wrap items-center gap-3 border-border border-b px-4 py-2 text-sm last:border-b-0"
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
      className="flex flex-col gap-3 px-4 py-3"
      data-locum-claude-code={situacao ?? ""}
      data-locum-probe="claude-code"
    >
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium">{t("settings.claudeCode.title")}</span>
        {situacao === null ? null : (
          <Badge variant={situacao === "connected" ? "secondary" : situacao === "stale" ? "outline" : "destructive"}>
            {t(`settings.claudeCode.${situacao}`)}
          </Badge>
        )}
        {estado !== null && estado.cli === null ? (
          <Badge variant="outline">{t("settings.claudeCode.noCli")}</Badge>
        ) : null}
        <div className="ml-auto">
          <Button
            className="cursor-pointer"
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
    <div className="flex flex-col gap-3 px-4 py-3" data-locum-probe="opencode">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium">{t("settings.opencode.title")}</span>
        {situacao === null ? null : (
          <Badge variant={situacao === "connected" ? "secondary" : situacao === "stale" ? "outline" : "destructive"}>
            {t(`settings.claudeCode.${situacao}`)}
          </Badge>
        )}
        <div className="ml-auto">
          <Button
            className="cursor-pointer"
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
