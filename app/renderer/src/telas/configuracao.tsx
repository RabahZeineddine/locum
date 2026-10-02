import { Badge } from "@/components/ui/badge";
import { CabecalhoDaTela } from "@/components/cabecalho-da-tela";
import { Button } from "@/components/ui/button";
import { call, read, useRead, type ReadResult } from "@/lib/bridge";
import { instalarResposta } from "@/lib/editar-agent";
import { nomeDoPadrao, padraoDoRepo } from "@/lib/padrao-do-repo";
import { rotuloDoModelo, rotuloDoProvedor } from "@/lib/rotulos";
import { cn } from "@/lib/utils";
import { EscolhaDoModelo } from "../assistente-modelo";
import { Vitrine } from "./conexoes";
import { useIdioma } from "../idioma";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Language } from "../../../src/services/i18n-service.js";
import type { UpdaterState } from "../../../src/update/state.js";
import type { TelaProps } from "../rotas";

type Provedor = ReadResult<"providers.list">[number];
type Fallback = ReadResult<"providers.fallbacks">[number];
type Servidor = ReadResult<"mcp.list">[number];
type Orcamento = ReadResult<"agents.budgets">[number];
type Preco = ReadResult<"providers.prices">[number];
type Credencial = ReadResult<"credentials.overview">["refs"][number];
type ChaveDeProvedor = ReadResult<"providers.credentials">[number];
type ConferenciaDeProvedor = ReadResult<"providers.checkSecret">;
type EstadoDoGithub = ReadResult<"github.status">;
type ConferenciaDoGithub = ReadResult<"github.check">;
type EstadoDoClaudeCode = ReadResult<"claudeCode.status">;
type Tracker = ReadResult<"trackers.list">[number];
type TesteDoTracker = ReadResult<"trackers.test">;
type Gatilho = ReadResult<"triggers.schedule">[number];
type CadastroDoSlack = ReadResult<"slack.get">;
type AppDoSlack = ReadResult<"connections.slackApp">;
type AppDoTeams = ReadResult<"connections.teamsApp">;
type CanalDoTeams = ReadResult<"connections.teamsChannels">[number];
type Ferramenta = ReadResult<"mcp.tools">[number];
type Teste = ReadResult<"mcp.test">;

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
export const SECOES = ["geral", "modelos", "conexoes"] as const;
export type SecaoId = (typeof SECOES)[number];

export function Configuracao({ detalhe, navegar }: TelaProps) {
  const { t } = useTranslation();
  const secao: SecaoId = (SECOES as readonly string[]).includes(detalhe ?? "")
    ? (detalhe as SecaoId)
    : "geral";
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
  const ligados = listaDeProvedores.filter((p) => p.available);
  const paraLigar = listaDeProvedores.filter((p) => !p.available);
  const modelos = useModelosLigados(ligados.map((p) => p.name).join(","));
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

  return (
    <div
      className="flex max-w-5xl flex-col gap-8"
      data-estado={estado}
      data-locum-cofre={credenciais.data?.available === true ? "legivel" : "fechado"}
      data-locum-fallbacks={fallbacks.data?.length ?? -1}
      data-locum-maquina={machineId ?? ""}
      data-locum-secao-ativa={secao}
      data-locum-probe="configuracao"
      data-locum-provedores={listaDeProvedores.map((p) => p.name).join(",")}
      data-locum-servidores={(servidores.data ?? []).map((s) => s.config.name).join(",")}
    >
      <CabecalhoDaTela descricao={t("settings.lead")} titulo={t("nav.settings")} />
      <div className="flex gap-1 -mt-3" data-locum-probe="secoes" role="tablist">
        {SECOES.map((id) => (
          <Button
            aria-selected={id === secao}
            className="cursor-pointer"
            data-locum-secao={id}
            key={id}
            onClick={() => navegar("configuracao", id)}
            role="tab"
            size="sm"
            variant={id === secao ? "secondary" : "ghost"}
          >
            {t(`settings.sections.${id}`)}
          </Button>
        ))}
      </div>

      {erro === undefined ? null : (
        <p className="text-destructive text-sm">
          {t("settings.refused", { channel: erro.channel, message: erro.message })}
        </p>
      )}

      {secao === "geral" ? (
        <>
          <Secao
            descricao={t("settings.language.description")}
            titulo={t("settings.language.title")}
          >
            <EscolhaDoIdioma />
          </Secao>

          <Secao descricao={t("settings.updates.description")} titulo={t("settings.updates.title")}>
            <Atualizacao />
          </Secao>

          <Secao descricao={t("settings.staleDays.description")} titulo={t("settings.staleDays.title")}>
            <EscolhaDeStaleDays />
          </Secao>

          <Secao descricao={t("settings.initiativesRoot.description")} titulo={t("settings.initiativesRoot.title")}>
            <EscolhaDaRaiz />
          </Secao>

          <Secao descricao={t("settings.sessionTerminal.description")} titulo={t("settings.sessionTerminal.title")}>
            <EscolhaDoTerminal />
          </Secao>
        </>
      ) : null}

      {secao === "modelos" ? (
        <>
          <Secao
            descricao={t("settings.providers.description")}
            titulo={t("settings.providers.title")}
          >
            {ligados.length === 0 ? (
              <Vazio>{t("settings.providers.empty")}</Vazio>
            ) : (
              ligados.map((provedor) => (
                <LinhaDoProvedor
                  chave={chavesPorProvedor.get(provedor.name)}
                  key={provedor.name}
                  modelos={modelos === null ? null : (modelos.get(provedor.name) ?? null)}
                  precos={listaDePrecos.filter((p) => p.provider === provedor.name)}
                  provedor={provedor}
                  recarregar={recarregarProvedores}
                  recarregarPrecos={recarregarPrecos}
                />
              ))
            )}
          </Secao>

          {paraLigar.length === 0 ? null : (
            <Secao
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
            </Secao>
          )}

          <Secao
            descricao={t("settings.registered.description")}
            titulo={t("settings.registered.title")}
          >
            <ProvedoresCadastrados recarregar={recarregarProvedores} />
          </Secao>

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

          <Secao
            descricao={t("settings.assistantModel.description")}
            titulo={t("settings.assistantModel.title")}
          >
            <EscolhaDoModelo />
          </Secao>
        </>
      ) : null}

      {secao === "conexoes" ? (
        <>
          <Vitrine
            paineis={{
              "claude-code": <ClaudeCode />,
              github: (
                <>
                  <Github />
                  <Trackers kinds={["github-issues"]} />
                </>
              ),
              slack: (
                <>
                  <SlackOficial />
                  <Slack />
                </>
              ),
              teams: <TeamsPeloGraph />,
              atlassian: <Trackers kinds={["jira-atlassian", "jira"]} />,
            }}
          />

          <Secao
            descricao={t("settings.servers.description")}
            titulo={t("settings.servers.title")}
          >
            {(servidores.data ?? []).length === 0 ? (
              <Vazio>{t("settings.servers.empty")}</Vazio>
            ) : (
              (servidores.data ?? []).map((servidor) => (
                <LinhaDoServidor
                  credencial={porCadastro.get(`mcp:${servidor.config.name}`)}
                  key={servidor.config.name}
                  servidor={servidor}
                />
              ))
            )}
          </Secao>
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ secoes */

export function Secao({
  children,
  descricao,
  titulo,
}: {
  children: React.ReactNode;
  descricao: string;
  titulo: string;
}) {
  /*
   * Uma moldura só por seção.
   *
   * Antes a seção tinha borda e cada linha dentro dela também, então duas
   * molduras disputavam a mesma fronteira e o olho perdia onde um grupo
   * termina. Agora o fio separa linha de linha, e o grupo é delimitado pelo
   * espaço acima dele e pelo título.
   */
  return (
    <section className="flex flex-col gap-1">
      <h2 className="font-medium text-[15px] tracking-tight">{titulo}</h2>
      <p className="text-muted-foreground max-w-[68ch] text-xs">{descricao}</p>
      <div className="divide-border border-border superficie mt-2 divide-y overflow-hidden rounded-lg border">
        {children}
      </div>
    </section>
  );
}

function Vazio({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-3 text-muted-foreground text-sm">{children}</p>;
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
      {TERMINAIS.map((terminal) => (
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
const TERMINAIS: readonly SessionTerminal[] = ["terminal", "iterm"];

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
      className="flex flex-col gap-2 px-3 py-2 text-sm"
      data-locum-chave-ambiente={chave?.env === true ? "sim" : "nao"}
      data-locum-chave-conferida={chave?.checkedAt ?? ""}
      data-locum-chave-guardada={chave === undefined ? "" : chave.stored ? "sim" : "nao"}
      data-locum-chave-modelos={chave?.modelCount ?? ""}
      data-locum-chave-ref={chave?.ref ?? ""}
      data-locum-disponivel={provedor.available ? "sim" : "nao"}
      data-locum-provider={provedor.name}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            provedor.available ? "bg-chart-2" : "bg-muted-foreground/40",
          )}
        />
        <span className="w-36 shrink-0 truncate text-[13px] font-medium" title={provedor.name}>
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

      {chave === undefined || chave.variable === null ? null : (
        <ChaveDoProvedor chave={chave} provedor={provedor} recarregar={recarregar} />
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
function ProvedoresCadastrados({ recarregar }: { recarregar: () => Promise<void> }) {
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
              key={cadastrado.id}
              ocupado={ocupado}
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
  ocupado,
}: {
  aoRemover: (force: boolean) => void;
  aviso: Remocao | undefined;
  cadastrado: Cadastrado;
  ocupado: boolean;
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

/**
 * A credencial de um cadastro: onde ela mora, e se existe valor la.
 *
 * O valor nao chega ate aqui nem por acidente. `credentials.overview` devolve
 * endereco e um booleano, e e isso que a tela tem para mostrar.
 */
function Credenciais({ credencial }: { credencial: Credencial | undefined }) {
  const { t } = useTranslation();

  if (credencial === undefined) return null;
  return (
    <Badge
      data-locum-credencial={credencial.ref}
      data-locum-guardado={credencial.stored ? "sim" : "nao"}
      variant={credencial.stored ? "secondary" : "destructive"}
    >
      {t(credencial.stored ? "settings.credential.stored" : "settings.credential.missing", {
        ref: credencial.ref,
      })}
    </Badge>
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

/* ---------------------------------------------------------------- servidores */

type EstadoDoTeste =
  | { fase: "parado" }
  | { fase: "testando" }
  | { fase: "respondeu"; teste: Teste }
  | { fase: "recusado"; erro: string };

/**
 * Um servidor MCP cadastrado, com os dois exames que ele aceita.
 *
 * Testar conexao e listar ferramentas sobem o mesmo processo, mas respondem
 * perguntas diferentes: a primeira diz se o cadastro esta certo, a segunda diz
 * o que cada ferramenta pesa antes de alguem marca-la num passo. Por isso sao
 * dois botoes, e nao um exame que sempre faz as duas coisas.
 */
function LinhaDoServidor({
  credencial,
  servidor,
}: {
  credencial: Credencial | undefined;
  servidor: Servidor;
}) {
  const { t } = useTranslation();
  const nome = servidor.config.name;
  const [teste, setTeste] = useState<EstadoDoTeste>({ fase: "parado" });
  const [ferramentas, setFerramentas] = useState<Ferramenta[] | null>(null);
  const [listando, setListando] = useState(false);

  const testar = (): void => {
    setTeste({ fase: "testando" });
    call("mcp.test", nome).then(
      (resultado) => setTeste({ fase: "respondeu", teste: resultado }),
      // `testConnection` devolve a falha como dado, entao chegar aqui quer
      // dizer que a ponte recusou, e nao que o servidor esta fora do ar.
      (erro: unknown) =>
        setTeste({ fase: "recusado", erro: erro instanceof Error ? erro.message : String(erro) }),
    );
  };

  const listar = (): void => {
    setListando(true);
    call("mcp.tools", nome).then(
      (lista) => {
        setFerramentas(lista);
        setListando(false);
      },
      () => {
        setFerramentas([]);
        setListando(false);
      },
    );
  };

  return (
    <div
      className="flex flex-col gap-2 border-border border-b px-4 py-3 last:border-b-0"
      data-locum-escopo={servidor.config.scope}
      data-locum-habilitado={servidor.enabled ? "sim" : "nao"}
      data-locum-servidor={nome}
      data-locum-transporte={servidor.config.transport}
    >
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="w-40 shrink-0 truncate font-medium">{nome}</span>
        <Badge variant="outline">{servidor.config.transport}</Badge>
        <Badge variant={servidor.config.scope === "write" ? "destructive" : "outline"}>
          {servidor.config.scope}
        </Badge>
        <Badge variant={servidor.enabled ? "secondary" : "outline"}>
          {t(servidor.enabled ? "settings.servers.enabled" : "settings.servers.disabled")}
        </Badge>
        <Credenciais credencial={credencial} />
        <div className="ml-auto flex items-center gap-1">
          <Button
            data-locum-testar={nome}
            disabled={teste.fase === "testando"}
            onClick={testar}
            size="sm"
            variant="ghost"
          >
            {t(teste.fase === "testando" ? "settings.servers.testing" : "settings.servers.test")}
          </Button>
          <Button
            data-locum-listar={nome}
            disabled={listando}
            onClick={listar}
            size="sm"
            variant="ghost"
          >
            {t(listando ? "settings.servers.listing" : "settings.servers.list")}
          </Button>
        </div>
      </div>

      <ResultadoDoTeste estado={teste} nome={nome} />

      {ferramentas === null ? null : (
        <div className="flex flex-wrap gap-1" data-locum-ferramentas-de={nome}>
          {ferramentas.length === 0 ? (
            <span className="text-muted-foreground text-xs">{t("settings.servers.noTools")}</span>
          ) : (
            ferramentas.map((ferramenta) => (
              <Badge
                data-locum-ferramenta={`${nome}/${ferramenta.name}`}
                data-locum-tokens={ferramenta.estimatedTokens}
                key={ferramenta.name}
                variant="outline"
              >
                {t("settings.servers.tool", {
                  name: ferramenta.name,
                  tokens: ferramenta.estimatedTokens,
                })}
              </Badge>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ResultadoDoTeste({ estado, nome }: { estado: EstadoDoTeste; nome: string }) {
  const { t } = useTranslation();

  if (estado.fase === "parado" || estado.fase === "testando") return null;

  if (estado.fase === "recusado") {
    return (
      <p className="text-destructive text-xs" data-locum-ok="nao" data-locum-teste={nome}>
        {t("settings.servers.refused", { message: estado.erro })}
      </p>
    );
  }

  const { teste } = estado;
  return (
    <p
      className={teste.ok ? "text-muted-foreground text-xs" : "text-destructive text-xs"}
      data-locum-ferramentas={teste.toolCount}
      data-locum-ok={teste.ok ? "sim" : "nao"}
      data-locum-teste={nome}
    >
      {teste.ok
        ? t("settings.servers.ok", { count: teste.toolCount, elapsed: teste.elapsedMs })
        : t("settings.servers.failed", {
            elapsed: teste.elapsedMs,
            error: teste.error ?? t("settings.servers.noReason"),
          })}
    </p>
  );
}


/* ------------------------------------------------------------------- github */

type Conferencia =
  | { fase: "parado" }
  | { fase: "conferindo" }
  | { fase: "respondeu"; resultado: ConferenciaDoGithub }
  | { fase: "recusado"; erro: string };

/**
 * O Locum dentro do Claude Code, num clique.
 *
 * O botão roda o `claude mcp add` apontando para este aplicativo, que serve o
 * MCP por `--mcp` com o mesmo cofre da janela: é o que deixa o token guardado
 * aqui valer numa sessão do terminal sem a pessoa exportar nada. A linha do
 * comando aparece para quem preferir colar ela mesma.
 */
function ClaudeCode() {
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
 * A credencial do GitHub: guardar, esquecer e perguntar de quem ela é.
 *
 * O valor digitado sai daqui numa direção só, para o keychain, e nunca volta:
 * não existe canal que devolva segredo, então nem recarregando a tela o campo
 * reaparece preenchido. O que fica visível é se há algo guardado, de quem é a
 * conta e quando foi a última conferência, que é o suficiente para alguém saber
 * se pode ligar um gatilho.
 *
 * Conferir fica atrás de um clique pela mesma razão do teste de servidor MCP:
 * ele sai para a rede, e abrir a tela de configuração não é pedir exame.
 */
function Github() {
  const { i18n, t } = useTranslation();
  const inicial = useRead("github.status");
  const [recarregado, setRecarregado] = useState<EstadoDoGithub | null>(null);
  const [token, setToken] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [conferencia, setConferencia] = useState<Conferencia>({ fase: "parado" });

  const estado = recarregado ?? inicial.data ?? null;

  const recarregar = (): Promise<void> =>
    read("github.status").then(setRecarregado, () => undefined);

  const guardar = (): void => {
    setSalvando(true);
    // O campo é limpo antes mesmo da resposta: o que foi digitado já está a
    // caminho do cofre, e deixá-lo na tela só aumenta a chance de ele aparecer
    // numa captura ou num ombro alheio.
    const valor = token;
    setToken("");
    call("github.save", valor)
      .then(recarregar, () => undefined)
      .finally(() => {
        setSalvando(false);
        // A conferência anterior era do token antigo, e o serviço já a apagou.
        setConferencia({ fase: "parado" });
      });
  };

  const esquecer = (): void => {
    call("github.forget")
      .then(recarregar, () => undefined)
      .finally(() => setConferencia({ fase: "parado" }));
  };

  const conferir = (): void => {
    setConferencia({ fase: "conferindo" });
    call("github.check").then(
      (resultado) => {
        setConferencia({ fase: "respondeu", resultado });
        void recarregar();
      },
      // `check` devolve a recusa do GitHub como dado, então chegar aqui quer
      // dizer que a ponte recusou, e não que o token está errado.
      (erro: unknown) =>
        setConferencia({
          fase: "recusado",
          erro: erro instanceof Error ? erro.message : String(erro),
        }),
    );
  };

  const conferidoEm =
    estado?.checkedAt == null
      ? null
      : new Date(estado.checkedAt * 1000).toLocaleString(i18n.language);

  return (
    <div
      className="flex flex-col gap-3 px-4 py-3"
      data-locum-github-ambiente={estado?.env === true ? "sim" : "nao"}
      data-locum-github-cofre={estado?.vault === true ? "aberto" : "fechado"}
      data-locum-github-conferido={estado?.checkedAt ?? ""}
      data-locum-github-guardado={estado === null ? "" : estado.stored ? "sim" : "nao"}
      data-locum-github-login={estado?.identity?.login ?? ""}
      data-locum-probe="github"
    >
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="w-40 shrink-0 truncate font-medium">{estado?.ref ?? ""}</span>
        <Badge variant={estado?.stored === true ? "secondary" : "destructive"}>
          {t(estado?.stored === true ? "settings.github.stored" : "settings.github.absent")}
        </Badge>
        {estado?.env === true ? (
          <Badge variant="outline">{t("settings.github.fromEnv")}</Badge>
        ) : null}
        {estado?.vault === false ? (
          <Badge variant="outline">{t("settings.github.noVault")}</Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Button
            data-locum-github-conferir=""
            disabled={conferencia.fase === "conferindo"}
            onClick={conferir}
            size="sm"
            variant="ghost"
          >
            {t(
              conferencia.fase === "conferindo"
                ? "settings.github.checking"
                : "settings.github.check",
            )}
          </Button>
          {estado?.stored === true ? (
            <Button data-locum-github-esquecer="" onClick={esquecer} size="sm" variant="ghost">
              {t("settings.github.forget")}
            </Button>
          ) : null}
        </div>
      </div>

      {estado?.identity == null ? null : (
        <p className="text-muted-foreground text-xs" data-locum-github-identidade="">
          {t("settings.github.identity", {
            login: estado.identity.login,
            scopes:
              estado.identity.scopes.length === 0
                ? t("settings.github.fineGrained")
                : estado.identity.scopes.join(", "),
          })}
          {conferidoEm === null ? null : ` · ${t("settings.github.when", { when: conferidoEm })}`}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/*
         * Campo de senha, e não de texto: o valor colado aqui aparece em
         * gravação de tela e em quem estiver olhando de lado, e o campo fica
         * numa tela que se abre para conferir outras coisas.
         */}
        <input
          aria-label={t("settings.github.field")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring min-w-64 flex-1 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-github-token=""
          onChange={(evento) => setToken(evento.target.value)}
          placeholder={t("settings.github.placeholder")}
          spellCheck={false}
          type="password"
          value={token}
        />
        <Button
          data-locum-github-salvar=""
          disabled={salvando || token.trim().length === 0}
          onClick={guardar}
          size="sm"
          variant="secondary"
        >
          {t(salvando ? "settings.github.saving" : "settings.github.save")}
        </Button>
      </div>

      <p className="text-muted-foreground max-w-[68ch] text-xs">
        {t("settings.github.howTo")}
      </p>

      <ResultadoDoGithub conferencia={conferencia} />
    </div>
  );
}

function ResultadoDoGithub({ conferencia }: { conferencia: Conferencia }) {
  const { t } = useTranslation();

  if (conferencia.fase === "parado" || conferencia.fase === "conferindo") return null;

  if (conferencia.fase === "recusado") {
    return (
      <p
        className="text-destructive text-xs"
        data-locum-github-resultado="recusado"
        data-locum-ok="nao"
      >
        {t("settings.github.refused", { message: conferencia.erro })}
      </p>
    );
  }

  const { resultado } = conferencia;
  if (resultado.ok) {
    return (
      <p
        className="text-muted-foreground text-xs"
        data-locum-github-resultado="ok"
        data-locum-ok="sim"
      >
        {t("settings.github.answered", {
          login: resultado.login,
          scopes:
            resultado.scopes.length === 0
              ? t("settings.github.fineGrained")
              : resultado.scopes.join(", "),
        })}
      </p>
    );
  }

  return (
    <p
      className="text-destructive text-xs"
      data-locum-github-resultado={resultado.reason}
      data-locum-ok="nao"
    >
      {resultado.reason === "missing"
        ? t("settings.github.missing")
        : t("settings.github.failed", { error: resultado.message })}
    </p>
  );
}

/* ----------------------------------------------------------------- trackers */

type ExameDoTracker =
  | { fase: "parado" }
  | { fase: "testando" }
  | { fase: "respondeu"; resultado: TesteDoTracker }
  | { fase: "recusado"; erro: string };

/**
 * Onde a tarefa vai parar: um Jira ou um repositório de issues do GitHub.
 *
 * O cadastro é o mesmo desenho da credencial do GitHub, logo acima: o que se
 * digita sai daqui numa direção só, para o keychain, e o que fica visível é se
 * existe algo guardado, quando foi o último teste e quantos destinos ele
 * enxergou. Não existe canal que devolva o valor.
 *
 * Testar pergunta ao tracker quais projetos a credencial alcança. É o teste de
 * conexão inteiro, e não um endpoint de saúde à parte: "o serviço está no ar"
 * responde bem para um token sem permissão de projeto nenhum, que é justamente
 * o caso em que alguém precisa saber que não vai funcionar.
 *
 * Abrir tarefa não tem botão aqui, e nem canal na ponte. Quem abre é o passo
 * de ação, que nasce em modo de aprovação e para na fila até alguém clicar.
 */
const ROTULO_DO_TRACKER: Record<Tracker["kind"], string> = {
  "jira-atlassian": "settings.trackers.kindJiraAtlassian",
  jira: "settings.trackers.kindJira",
  "github-issues": "settings.trackers.kindGithub",
};

function Trackers({ kinds }: { kinds: Tracker["kind"][] }) {
  const { t } = useTranslation();
  const inicial = useRead("trackers.list");
  const [relido, setRelido] = useState<Tracker[] | null>(null);
  const [tipo, setTipo] = useState<Tracker["kind"]>(kinds[0] ?? "jira");
  const [id, setId] = useState("");
  const [nome, setNome] = useState("");
  const [url, setUrl] = useState("");
  const [conta, setConta] = useState("");
  const [projeto, setProjeto] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // Cada painel da vitrine mostra só os trackers do serviço dele: o Jira mora
  // com a Atlassian, o GitHub Issues com o GitHub.
  const lista = (relido ?? inicial.data ?? []).filter((tracker) => kinds.includes(tracker.kind));
  const recusa = erro ?? inicial.error?.message ?? null;

  const reler = (): Promise<void> =>
    read("trackers.list").then(setRelido, (falha: unknown) =>
      setErro(falha instanceof Error ? falha.message : String(falha)),
    );

  const agir = (acao: Promise<unknown>): Promise<void> => {
    setOcupado(true);
    return acao
      .then(
        () => setErro(null),
        (falha: unknown) => setErro(falha instanceof Error ? falha.message : String(falha)),
      )
      .then(reler)
      .finally(() => setOcupado(false));
  };

  const cadastrar = (): void => {
    void agir(
      call("trackers.register", {
        id: id.trim(),
        kind: tipo,
        label: nome.trim(),
        baseUrl: url.trim(),
        account: tipo === "jira" ? conta.trim() : "",
        project: projeto.trim(),
      }).then(() => {
        setId("");
        setNome("");
        setUrl("");
        setConta("");
        setProjeto("");
      }),
    );
  };

  // O e-mail só é exigido no Jira por token, e o endereço só no Jira: o GitHub
  // tem um de fábrica, e pedir que alguém digite api.github.com é cerimônia.
  // Pela Atlassian o site basta, porque a credencial é a da conexão.
  const jira = tipo === "jira" || tipo === "jira-atlassian";
  const valido =
    id.trim() !== "" &&
    nome.trim() !== "" &&
    (!jira || url.trim() !== "") &&
    (tipo !== "jira" || conta.trim() !== "");

  return (
    <div
      className="flex flex-col gap-3 px-4 py-3"
      data-locum-probe="trackers"
      data-locum-trackers={lista.map((tracker) => tracker.id).join(",")}
    >
      {lista.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("settings.trackers.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {lista.map((tracker) => (
            <LinhaDoTracker
              key={tracker.id}
              ocupado={ocupado}
              recarregar={reler}
              tracker={tracker}
            />
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {kinds.length > 1 ? (
          <select
            aria-label={t("settings.trackers.kind")}
            className="border-border bg-background focus-visible:ring-ring rounded-md border px-2 py-1.5 text-xs outline-none focus-visible:ring-1"
            data-locum-tracker-tipo=""
            onChange={(evento) => setTipo(evento.target.value as Tracker["kind"])}
            value={tipo}
          >
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {t(ROTULO_DO_TRACKER[kind])}
              </option>
            ))}
          </select>
        ) : null}
        <input
          aria-label={t("settings.trackers.id")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-36 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-tracker-id=""
          onChange={(evento) => setId(evento.target.value)}
          placeholder={t("settings.trackers.idHint")}
          spellCheck={false}
          value={id}
        />
        <input
          aria-label={t("settings.trackers.label")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-40 rounded-md border px-3 py-1.5 text-xs outline-none focus-visible:ring-1"
          data-locum-tracker-nome=""
          onChange={(evento) => setNome(evento.target.value)}
          placeholder={t("settings.trackers.labelHint")}
          spellCheck={false}
          value={nome}
        />
        <input
          aria-label={t("settings.trackers.baseUrl")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring min-w-48 flex-1 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-tracker-url=""
          onChange={(evento) => setUrl(evento.target.value)}
          placeholder={t(
            jira ? "settings.trackers.baseUrlHint" : "settings.trackers.baseUrlDefault",
          )}
          spellCheck={false}
          value={url}
        />
        {tipo === "jira" ? (
          <input
            aria-label={t("settings.trackers.account")}
            autoComplete="off"
            className="border-border bg-background focus-visible:ring-ring w-52 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
            data-locum-tracker-conta=""
            onChange={(evento) => setConta(evento.target.value)}
            placeholder={t("settings.trackers.accountHint")}
            spellCheck={false}
            value={conta}
          />
        ) : null}
        <input
          aria-label={t("settings.trackers.project")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-40 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-tracker-projeto=""
          onChange={(evento) => setProjeto(evento.target.value)}
          placeholder={t(
            jira ? "settings.trackers.projectHint" : "settings.trackers.repoHint",
          )}
          spellCheck={false}
          value={projeto}
        />
        <Button
          data-locum-tracker-salvar=""
          disabled={ocupado || !valido}
          onClick={cadastrar}
          size="sm"
          variant="secondary"
        >
          {t("settings.trackers.add")}
        </Button>
      </div>

      <p className="text-muted-foreground max-w-[68ch] text-xs">
        {t(tipo === "jira-atlassian" ? "settings.trackers.howToAtlassian" : "settings.trackers.howTo")}
      </p>

      {recusa === null ? null : (
        <p className="text-destructive text-xs" data-locum-trackers-erro={recusa}>
          {t("settings.trackers.refused", { message: recusa })}
        </p>
      )}
    </div>
  );
}

function LinhaDoTracker({
  ocupado,
  recarregar,
  tracker,
}: {
  ocupado: boolean;
  recarregar: () => Promise<void>;
  tracker: Tracker;
}) {
  const { i18n, t } = useTranslation();
  const [valor, setValor] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [exame, setExame] = useState<ExameDoTracker>({ fase: "parado" });

  const guardar = (): void => {
    setSalvando(true);
    // O campo é limpo antes da resposta, como na chave de provedor: o que foi
    // digitado já está a caminho do cofre, e deixá-lo na tela só aumenta a
    // chance de aparecer numa captura ou num ombro alheio.
    const digitado = valor;
    setValor("");
    void call("trackers.saveSecret", tracker.id, digitado)
      .then(recarregar, () => undefined)
      .finally(() => {
        setSalvando(false);
        // O teste anterior era da credencial antiga, e o serviço já o apagou.
        setExame({ fase: "parado" });
      });
  };

  const esquecer = (): void => {
    void call("trackers.forgetSecret", tracker.id)
      .then(recarregar, () => undefined)
      .finally(() => setExame({ fase: "parado" }));
  };

  const testar = (): void => {
    setExame({ fase: "testando" });
    void call("trackers.test", tracker.id).then(
      (resultado) => {
        setExame({ fase: "respondeu", resultado });
        void recarregar();
      },
      // `test` devolve a recusa do tracker como dado, então chegar aqui quer
      // dizer que a ponte recusou, e não que a credencial está errada.
      (falha: unknown) =>
        setExame({ fase: "recusado", erro: falha instanceof Error ? falha.message : String(falha) }),
    );
  };

  // Pela Atlassian não há token do tracker: a credencial é a da conexão, que
  // se autoriza e se esquece no próprio cartão da Atlassian.
  const pelaConexao = tracker.kind === "jira-atlassian";

  const testadoEm =
    tracker.checkedAt === null
      ? null
      : new Date(tracker.checkedAt * 1000).toLocaleString(i18n.language);

  return (
    <li
      className="border-border flex flex-col gap-1.5 rounded-md border px-3 py-2 text-sm"
      data-locum-tracker={tracker.id}
      data-locum-tracker-destino={tracker.project ?? ""}
      data-locum-tracker-guardado={tracker.stored ? "sim" : "nao"}
      data-locum-tracker-ligado={tracker.enabled ? "sim" : "nao"}
      data-locum-tracker-kind={tracker.kind}
      data-locum-tracker-projetos={tracker.projectCount ?? -1}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-[13px]">{tracker.id}</span>
        <span className="text-muted-foreground text-xs">{tracker.label}</span>
        <Badge variant="outline">
          {t(ROTULO_DO_TRACKER[tracker.kind])}
        </Badge>
        <span className="text-muted-foreground font-mono text-xs">{tracker.baseUrl}</span>
        {tracker.project === null ? null : (
          <span className="text-muted-foreground font-mono text-xs">{tracker.project}</span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Button
            data-locum-tracker-ligar={tracker.id}
            disabled={ocupado}
            onClick={() => {
              void call("trackers.setEnabled", tracker.id, !tracker.enabled).then(
                recarregar,
                () => undefined,
              );
            }}
            size="sm"
            variant="ghost"
          >
            {t(tracker.enabled ? "settings.trackers.disable" : "settings.trackers.enable")}
          </Button>
          <Button
            data-locum-tracker-remover={tracker.id}
            disabled={ocupado}
            onClick={() => {
              void call("trackers.remove", tracker.id).then(recarregar, () => undefined);
            }}
            size="sm"
            variant="ghost"
          >
            {t("settings.trackers.remove")}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {pelaConexao ? null : (
          <>
            <input
              aria-label={t("settings.trackers.field", { tracker: tracker.id })}
              autoComplete="off"
              className="border-border bg-background focus-visible:ring-ring min-w-56 flex-1 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
              data-locum-tracker-credencial={tracker.id}
              disabled={!tracker.vault}
              onChange={(evento) => setValor(evento.target.value)}
              placeholder={t(
                tracker.vault ? "settings.trackers.placeholder" : "settings.trackers.noVault",
              )}
              spellCheck={false}
              type="password"
              value={valor}
            />
            <Button
              data-locum-tracker-guardar={tracker.id}
              disabled={salvando || !tracker.vault || valor.trim().length === 0}
              onClick={guardar}
              size="sm"
              variant="secondary"
            >
              {t(salvando ? "settings.trackers.saving" : "settings.trackers.save")}
            </Button>
          </>
        )}
        <Button
          data-locum-tracker-testar={tracker.id}
          disabled={exame.fase === "testando"}
          onClick={testar}
          size="sm"
          variant="ghost"
        >
          {t(exame.fase === "testando" ? "settings.trackers.testing" : "settings.trackers.test")}
        </Button>
        {tracker.stored && !pelaConexao ? (
          <Button
            data-locum-tracker-esquecer={tracker.id}
            onClick={esquecer}
            size="sm"
            variant="ghost"
          >
            {t("settings.trackers.forget")}
          </Button>
        ) : null}
      </div>

      <p className="text-muted-foreground text-xs">
        {t(
          pelaConexao
            ? tracker.stored
              ? "settings.trackers.viaAtlassian"
              : "settings.trackers.atlassianMissing"
            : tracker.stored
              ? "settings.trackers.stored"
              : "settings.trackers.absent",
        )}
        {testadoEm === null
          ? null
          : ` · ${t("settings.trackers.lastCheck", {
              count: tracker.projectCount ?? 0,
              when: testadoEm,
            })}`}
      </p>

      <ResultadoDoTracker exame={exame} pelaConexao={pelaConexao} tracker={tracker.id} />
    </li>
  );
}

function ResultadoDoTracker({
  exame,
  pelaConexao,
  tracker,
}: {
  exame: ExameDoTracker;
  pelaConexao: boolean;
  tracker: string;
}) {
  const { t } = useTranslation();
  if (exame.fase === "parado" || exame.fase === "testando") return null;

  if (exame.fase === "recusado") {
    return (
      <p
        className="text-destructive text-xs"
        data-locum-tracker-resultado="recusado"
        data-locum-tracker-teste={tracker}
      >
        {t("settings.trackers.bridgeRefused", { message: exame.erro })}
      </p>
    );
  }

  const resultado = exame.resultado;
  if (resultado.ok) {
    return (
      <p
        className="text-muted-foreground text-xs"
        data-locum-ok="sim"
        data-locum-projetos={resultado.count}
        data-locum-tracker-resultado="ok"
        data-locum-tracker-teste={tracker}
      >
        {t("settings.trackers.answered", { count: resultado.count })}
      </p>
    );
  }

  return (
    <p
      className="text-destructive text-xs"
      data-locum-ok="nao"
      data-locum-projetos={-1}
      data-locum-tracker-resultado={resultado.reason}
      data-locum-tracker-teste={tracker}
    >
      {resultado.reason === "missing"
        ? t(pelaConexao ? "settings.trackers.atlassianMissing" : "settings.trackers.missing")
        : t("settings.trackers.failed", { error: resultado.message })}
    </p>
  );
}

/* --------------------------------------------------------------- observados */

/** Fonte da varredura. Hoje só existe uma, e o cadastro guarda o nome dela. */
const FONTE = "github";

/** Cadência de estreia, em minutos. A mesma que o zod usa quando ninguém diz. */
const CADENCIA_PADRAO = "15";

/**
 * Filtro de autoria, na ordem em que aparece na lista.
 *
 * Escrito à mão e não derivado do zod, porque quem lê a tela lê rótulo e não
 * valor: a lista precisa de uma tradução por opção, e um laço sobre o enum
 * traria "others" para dentro do que a pessoa vê.
 */
const AUTORIAS = ["any", "mine", "others"] as const;
type Autoria = (typeof AUTORIAS)[number];

const ROTULO_DA_AUTORIA: Record<Autoria, string> = {
  any: "settings.watched.authorshipAny",
  mine: "settings.watched.authorshipMine",
  others: "settings.watched.authorshipOthers",
};

/**
 * O que esta máquina observa: dono, padrão de repositório e de quanto em
 * quanto tempo o Locum vai olhar.
 *
 * O gatilho nasce parado, e ligar é outro clique. Não é cerimônia: um cadastro
 * que já acordasse sozinho colocaria o executor para rodar em cima de um
 * repositório que alguém ainda está terminando de escolher, gastando modelo
 * antes de a pessoa ter conferido o que digitou.
 *
 * Nada aqui publica. Um gatilho ligado varre, cria execução e o passo de ação
 * para na fila de aprovação, que continua sendo o único lugar onde sai
 * comentário, e só com clique.
 */
export function Observados({ agentId: fixo }: { agentId?: string } = {}) {
  const { i18n, t } = useTranslation();
  const agents = useRead("agents.list");
  const inicial = useRead("triggers.schedule");
  const [recarregado, setRecarregado] = useState<Gatilho[] | null>(null);
  const [agentId, setAgentId] = useState("");
  const [dono, setDono] = useState("");
  const [repo, setRepo] = useState("");
  const [autoria, setAutoria] = useState<Autoria>("any");
  const [cadencia, setCadencia] = useState(CADENCIA_PADRAO);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const agenda = recarregado ?? inicial.data ?? null;
  const recusa = erro ?? inicial.error?.message ?? null;
  // Só a varredura: gatilho de relógio e de MCP entram por outro caminho e não
  // têm dono nem padrão de repositório para esta seção mostrar.
  const gatilhos = (agenda ?? []).filter(
    (g) => g.kind === "poll" && (fixo === undefined || g.agentId === fixo),
  );

  const listaDeAgents = agents.data ?? [];
  // O primeiro da lista é o padrão, e não uma opção vazia: quem tem um agent só
  // não deveria precisar escolhê-lo para cadastrar o que observar.
  const escolhido = fixo ?? (agentId !== "" ? agentId : (listaDeAgents[0]?.id ?? ""));

  // A leitura que falha vira texto na tela e não lista vazia: sem isso, ponte
  // recusada e nenhum repositório observado ficam iguais para quem olha.
  const recarregar = (): Promise<void> =>
    read("triggers.schedule").then(setRecarregado, (falha: unknown) =>
      setErro(falha instanceof Error ? falha.message : String(falha)),
    );

  const agir = (acao: Promise<unknown>): void => {
    setOcupado(true);
    acao
      .then(
        () => setErro(null),
        (falha: unknown) => setErro(falha instanceof Error ? falha.message : String(falha)),
      )
      .then(recarregar)
      .finally(() => setOcupado(false));
  };

  const minutos = Number(cadencia);
  const valido =
    escolhido !== "" &&
    dono.trim() !== "" &&
    repo.trim() !== "" &&
    Number.isInteger(minutos) &&
    minutos >= 1;

  const observar = (): void => {
    agir(
      call("triggers.set", escolhido, {
        kind: "poll",
        source: FONTE,
        owner: dono.trim(),
        repoMatch: padraoDoRepo(repo),
        authorship: autoria,
        everyMinutes: minutos,
      }).then(() => {
        setDono("");
        setRepo("");
      }),
    );
  };

  return (
    <div
      className="flex flex-col gap-3 px-4 py-3"
      data-locum-observados={gatilhos.map((g) => g.triggerId).join(",")}
      data-locum-probe="observados"
    >
      {gatilhos.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("settings.watched.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {gatilhos.map((gatilho) => (
            <LinhaDoObservado
              aoLigar={(ligado) => agir(call("triggers.setEnabled", gatilho.triggerId, ligado))}
              aoRemover={() => agir(call("triggers.remove", gatilho.triggerId))}
              gatilho={gatilho}
              idioma={i18n.language}
              key={gatilho.triggerId}
              ocupado={ocupado}
            />
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* Dentro do agent, o agent já está escolhido: a lista só aparece fora dele. */}
        {fixo === undefined ? (
          <select
            aria-label={t("settings.watched.agent")}
            className="border-border bg-background cursor-pointer rounded-md border px-2 py-1.5 text-xs"
            data-locum-observar-agent=""
            onChange={(evento) => setAgentId(evento.target.value)}
            value={escolhido}
          >
            {listaDeAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.id}
              </option>
            ))}
          </select>
        ) : null}

        <input
          aria-label={t("settings.watched.owner")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-40 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-observar-dono=""
          onChange={(evento) => setDono(evento.target.value)}
          placeholder={t("settings.watched.ownerHint")}
          spellCheck={false}
          value={dono}
        />

        <input
          aria-label={t("settings.watched.repo")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-44 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-observar-repo=""
          onChange={(evento) => setRepo(evento.target.value)}
          placeholder={t("settings.watched.repoHint")}
          spellCheck={false}
          value={repo}
        />

        <select
          aria-label={t("settings.watched.authorship")}
          className="border-border bg-background cursor-pointer rounded-md border px-2 py-1.5 text-xs"
          data-locum-observar-autoria=""
          onChange={(evento) => setAutoria(evento.target.value as Autoria)}
          value={autoria}
        >
          {AUTORIAS.map((valor) => (
            <option key={valor} value={valor}>
              {t(ROTULO_DA_AUTORIA[valor])}
            </option>
          ))}
        </select>

        <input
          aria-label={t("settings.watched.cadence")}
          className="border-border bg-background focus-visible:ring-ring w-20 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-observar-cadencia=""
          min={1}
          onChange={(evento) => setCadencia(evento.target.value)}
          step={1}
          type="number"
          value={cadencia}
        />

        <Button
          data-locum-observar-salvar=""
          disabled={ocupado || !valido}
          onClick={observar}
          size="sm"
          variant="secondary"
        >
          {t("settings.watched.add")}
        </Button>
      </div>

      <p className="text-muted-foreground max-w-[68ch] text-xs">{t("settings.watched.howTo")}</p>
      <details className="text-muted-foreground max-w-[68ch] text-xs">
        <summary className="cursor-pointer">{t("settings.watched.advanced")}</summary>
        <p className="mt-1">{t("settings.watched.advancedHow")}</p>
      </details>

      {recusa === null ? null : (
        <p className="text-destructive text-xs" data-locum-observados-erro={recusa}>
          {t("settings.watched.refused", { message: recusa })}
        </p>
      )}
    </div>
  );
}

function LinhaDoObservado({
  aoLigar,
  aoRemover,
  gatilho,
  idioma,
  ocupado,
}: {
  aoLigar: (ligado: boolean) => void;
  aoRemover: () => void;
  gatilho: Gatilho;
  idioma: string;
  ocupado: boolean;
}) {
  const { t } = useTranslation();
  const config = gatilho.config;
  // O `kind` já foi filtrado por quem monta a lista, e este estreitamento é o
  // que dá acesso a dono e padrão sem espalhar a checagem pelo JSX.
  const alvo =
    config.kind === "poll"
      ? t("settings.watched.target", {
          owner: config.owner ?? t("settings.watched.fromEnv"),
          repo: nomeDoPadrao(config.repoMatch),
        })
      : config.kind === "slack-inbox" || config.kind === "teams-inbox"
        ? t(ROTULO_DA_CAIXA[config.mentions ? (config.dms ? "both" : "mentions") : "dms"]) +
          (config.kind === "teams-inbox" && config.mentions && config.channels.length > 0
            ? t("settings.teamsChannels.inLine", {
                channels: config.channels.map((c) => c.label ?? c.channelId).join(", "),
              })
            : "")
        : "";

  // "De qualquer pessoa" é o padrão e não vira texto: repetir o que vale para
  // todo gatilho em toda linha só faria a distinção pesar menos onde ela existe.
  const autoria =
    config.kind === "poll" && config.authorship !== "any"
      ? t("settings.watched.by", { authorship: t(ROTULO_DA_AUTORIA[config.authorship]) })
      : "";

  const quando = (ms: number | null): string =>
    ms === null ? t("settings.watched.never") : new Date(ms).toLocaleString(idioma);

  return (
    <li
      className="border-border flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm"
      data-locum-gatilho={gatilho.triggerId}
      data-locum-gatilho-alvo={config.kind === "poll" ? `${config.owner ?? ""}/${config.repoMatch}` : ""}
      data-locum-gatilho-autoria={config.kind === "poll" ? config.authorship : ""}
      data-locum-gatilho-habilitado={gatilho.enabled ? "sim" : "nao"}
      data-locum-gatilho-proxima={gatilho.nextDueAt ?? ""}
      data-locum-gatilho-ultima={gatilho.lastFireAt ?? ""}
    >
      <span className="font-mono text-xs">{alvo}</span>
      {autoria === "" ? null : <span className="text-muted-foreground text-xs">{autoria}</span>}
      <Badge variant={gatilho.enabled ? "secondary" : "outline"}>
        {t(gatilho.enabled ? "settings.watched.on" : "settings.watched.off")}
      </Badge>
      <span className="text-muted-foreground text-xs">
        {t("settings.watched.every", { count: gatilho.everyMinutes ?? 0 })}
      </span>
      <span className="text-muted-foreground text-xs">{gatilho.agentId}</span>

      <div className="ml-auto flex items-center gap-1">
        <Button
          data-locum-gatilho-ligar={gatilho.triggerId}
          disabled={ocupado}
          onClick={() => aoLigar(!gatilho.enabled)}
          size="sm"
          variant="ghost"
        >
          {t(gatilho.enabled ? "settings.watched.disable" : "settings.watched.enable")}
        </Button>
        <Button
          data-locum-gatilho-remover={gatilho.triggerId}
          disabled={ocupado}
          onClick={aoRemover}
          size="sm"
          variant="ghost"
        >
          {t("settings.watched.remove")}
        </Button>
      </div>

      <p className="text-muted-foreground w-full text-xs">
        {t("settings.watched.beats", {
          last: quando(gatilho.lastFireAt),
          next: gatilho.enabled ? quando(gatilho.nextDueAt) : t("settings.watched.parked"),
        })}
      </p>
    </li>
  );
}

/* -------------------------------------------------------------------- slack */

/**
 * O que esta máquina observa no Slack.
 *
 * Não há campo de token, e não é esquecimento: quem fala com o Slack é o
 * servidor MCP que alguém já autorizou, e aqui só se escolhe qual dos
 * cadastrados é ele. Uma credencial própria seria um segundo lugar de onde a
 * mesma conversa poderia vazar.
 *
 * Os nomes de argumento aparecem porque variam de um servidor de Slack para
 * outro: um chama o canal de `channel_id` e o outro de `channel`. Vêm
 * preenchidos com os mais comuns para que ninguém precise descobri-los antes de
 * observar o primeiro canal.
 *
 * Os da resposta são outros que os da leitura, e por isso têm campo próprio: a
 * ferramenta que lista histórico e a que publica em thread raramente chamam o
 * canal pelo mesmo nome.
 *
 * Nada aqui publica. Cadastrar canal faz o Locum ler, e cadastrar a ferramenta
 * de resposta só diz por onde ela sairia: responder em thread é passo de ação,
 * que para na fila de aprovação e espera o clique de alguém.
 */
/**
 * Slack pelo servidor MCP oficial, com o app que a pessoa cria no workspace.
 *
 * O Slack não tem registro automático de cliente, então o caminho é guiado:
 * criar o app pelo manifesto, ligar o MCP nele, colar o client id e autorizar.
 * O client id não é segredo (o app é público, com PKCE) e fica na máquina.
 */
function SlackOficial() {
  const { t } = useTranslation();
  const inicial = useRead("connections.slackApp");
  const [relido, setRelido] = useState<AppDoSlack | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  const app = relido ?? inicial.data ?? null;
  const valorDoClientId = clientId ?? app?.clientId ?? "";
  const recusa = erro ?? inicial.error?.message ?? null;

  const agir = (acao: Promise<unknown>): void => {
    setOcupado(true);
    acao
      .then(
        () => setErro(null),
        (falha: unknown) => setErro(falha instanceof Error ? falha.message : String(falha)),
      )
      .then(() => read("connections.slackApp").then(setRelido, () => undefined))
      .finally(() => setOcupado(false));
  };

  const copiar = (): void => {
    if (app === null) return;
    void navigator.clipboard.writeText(app.manifest).then(() => {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    });
  };

  return (
    <div
      className="border-border flex flex-col gap-3 border-b px-4 py-3"
      data-locum-probe="slack-oficial"
      data-locum-slack-oficial-conectado={app?.connected ? "sim" : "nao"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t("settings.slackOfficial.title")}</span>
        {app?.connected ? <Badge variant="secondary">{t("settings.slackOfficial.connected")}</Badge> : null}
      </div>
      <p className="text-muted-foreground text-xs">{t("settings.slackOfficial.description")}</p>

      <ol className="text-muted-foreground flex list-decimal flex-col gap-1 pl-5 text-xs">
        <li>{t("settings.slackOfficial.stepCreate")}</li>
        <li>{t("settings.slackOfficial.stepMcp")}</li>
        <li>{t("settings.slackOfficial.stepInstall")}</li>
        <li>{t("settings.slackOfficial.stepClientId")}</li>
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-locum-slack-manifesto=""
          disabled={ocupado}
          onClick={() => agir(call("connections.openSlackManifest"))}
          size="sm"
          variant="secondary"
        >
          {t("settings.slackOfficial.openManifest")}
        </Button>
        <Button disabled={app === null} onClick={copiar} size="sm" variant="ghost">
          {copiado ? t("settings.slackOfficial.copied") : t("settings.slackOfficial.copyManifest")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={t("settings.slackOfficial.clientId")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-64 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-slack-client-id=""
          onChange={(evento) => setClientId(evento.target.value)}
          placeholder={t("settings.slackOfficial.clientIdHint")}
          spellCheck={false}
          value={valorDoClientId}
        />
        <Button
          data-locum-slack-conectar=""
          disabled={ocupado || valorDoClientId.trim() === ""}
          onClick={() => agir(call("connections.connectSlack", valorDoClientId.trim()))}
          size="sm"
        >
          {app?.connected ? t("settings.slackOfficial.reconnect") : t("settings.slackOfficial.connect")}
        </Button>
        {app?.connected ? (
          <Button
            disabled={ocupado}
            onClick={() => agir(call("connections.disconnectSlack"))}
            size="sm"
            variant="ghost"
          >
            {t("settings.slackOfficial.disconnect")}
          </Button>
        ) : null}
      </div>

      {app?.connected ? <CaixaDeEntrada servico="slack" /> : null}

      {ocupado ? <p className="text-muted-foreground text-xs">{t("settings.slackOfficial.waiting")}</p> : null}
      {recusa !== null ? (
        <p className="text-destructive text-xs" data-locum-slack-oficial-erro="">
          {recusa}
        </p>
      ) : null}
    </div>
  );
}

type Caixa = "both" | "mentions" | "dms";
const CAIXAS: Caixa[] = ["both", "mentions", "dms"];
const ROTULO_DA_CAIXA: Record<Caixa, string> = {
  both: "settings.slackInbox.both",
  mentions: "settings.slackInbox.mentions",
  dms: "settings.slackInbox.dms",
};

/**
 * O gatilho de menção e mensagem direta, que só existe com a conexão do
 * serviço: a oficial do Slack ou a do Teams.
 *
 * Fica dentro do bloco da conexão, e não em Gatilhos, porque não tem o que
 * escolher além do agent e do que avisar: servidor, ferramenta e conversa são
 * os da conta de quem conectou.
 */
function CaixaDeEntrada({ servico, canais = false }: { servico: "slack" | "teams"; canais?: boolean }) {
  const kind = servico === "slack" ? "slack-inbox" : "teams-inbox";
  const pronto = servico === "slack" ? "slack-reply" : "teams-reply";
  const { i18n, t } = useTranslation();
  const agentsIniciais = useRead("agents.list");
  const [agentsRelidos, setAgentsRelidos] = useState<typeof agentsIniciais.data>(undefined);
  const inicial = useRead("triggers.schedule");
  const [recarregado, setRecarregado] = useState<Gatilho[] | null>(null);
  const [agentId, setAgentId] = useState("");
  const [caixa, setCaixa] = useState<Caixa>("both");
  const [opcoesDeCanal, setOpcoesDeCanal] = useState<CanalDoTeams[] | null>(null);
  const [canaisEscolhidos, setCanaisEscolhidos] = useState<ReadonlySet<string>>(new Set());
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const agenda = recarregado ?? inicial.data ?? null;
  const recusa = erro ?? inicial.error?.message ?? null;
  const gatilhos = (agenda ?? []).filter((g) => g.kind === kind);
  const listaDeAgents = agentsRelidos ?? agentsIniciais.data ?? [];
  const escolhido = agentId !== "" ? agentId : (listaDeAgents[0]?.id ?? "");
  const temPronto = listaDeAgents.some((agent) => agent.id === pronto);

  const agir = (acao: Promise<unknown>): void => {
    setOcupado(true);
    acao
      .then(
        () => setErro(null),
        (falha: unknown) => setErro(falha instanceof Error ? falha.message : String(falha)),
      )
      .then(() => read("triggers.schedule").then(setRecarregado, () => undefined))
      .finally(() => setOcupado(false));
  };

  const chaveDoCanal = (c: CanalDoTeams) => `${c.teamId}|${c.channelId}`;
  const escolhidos =
    servico === "teams" && canais && caixa !== "dms"
      ? (opcoesDeCanal ?? [])
          .filter((c) => canaisEscolhidos.has(chaveDoCanal(c)))
          .map((c) => ({ teamId: c.teamId, channelId: c.channelId, label: `${c.teamName} / ${c.channelName}` }))
      : [];

  const gatilhoPara = (id: string) =>
    call(
      "triggers.set",
      id,
      kind === "teams-inbox"
        ? { kind, mentions: caixa !== "dms", dms: caixa !== "mentions", channels: escolhidos }
        : { kind, mentions: caixa !== "dms", dms: caixa !== "mentions" },
    );

  const carregarCanais = (): void => {
    agir(call("connections.teamsChannels").then(setOpcoesDeCanal));
  };

  const alternarCanal = (chave: string): void => {
    setCanaisEscolhidos((atual) => {
      const proximo = new Set(atual);
      if (proximo.has(chave)) proximo.delete(chave);
      else proximo.add(chave);
      return proximo;
    });
  };

  const ligar = (): void => {
    agir(gatilhoPara(escolhido));
  };

  /**
   * Quem acabou de conectar ainda não tem agent que responda, e a lista de
   * agents vazia trava o Ligar. Este clique grava a resposta pronta e já liga
   * o gatilho nela; a resposta continua parando na fila.
   */
  const usarPronto = (): void => {
    agir(
      instalarResposta(servico).then(async (id) => {
        setAgentId(id);
        setAgentsRelidos(await read("agents.list"));
        await gatilhoPara(id);
      }),
    );
  };

  return (
    <div className="flex flex-col gap-2" data-locum-probe={`${servico}-caixa`}>
      <span className="text-sm font-medium">{t("settings.slackInbox.title")}</span>
      <p className="text-muted-foreground text-xs">
        {t(servico === "slack" ? "settings.slackInbox.description" : "settings.teamsInbox.description")}
      </p>

      {gatilhos.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {gatilhos.map((gatilho) => (
            <LinhaDoObservado
              aoLigar={(ligado) => agir(call("triggers.setEnabled", gatilho.triggerId, ligado))}
              aoRemover={() => agir(call("triggers.remove", gatilho.triggerId))}
              gatilho={gatilho}
              idioma={i18n.language}
              key={gatilho.triggerId}
              ocupado={ocupado}
            />
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={t("settings.watched.agent")}
          className="border-border bg-background cursor-pointer rounded-md border px-2 py-1.5 text-xs"
          {...{ [`data-locum-${servico}-caixa-agent`]: "" }}
          onChange={(evento) => setAgentId(evento.target.value)}
          value={escolhido}
        >
          {listaDeAgents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        <select
          aria-label={t("settings.slackInbox.what")}
          className="border-border bg-background cursor-pointer rounded-md border px-2 py-1.5 text-xs"
          {...{ [`data-locum-${servico}-caixa-tipo`]: "" }}
          onChange={(evento) => setCaixa(evento.target.value as Caixa)}
          value={caixa}
        >
          {CAIXAS.map((valor) => (
            <option key={valor} value={valor}>
              {t(ROTULO_DA_CAIXA[valor])}
            </option>
          ))}
        </select>
        <Button
          {...{ [`data-locum-${servico}-caixa-ligar`]: "" }}
          disabled={ocupado || escolhido === ""}
          onClick={ligar}
          size="sm"
          variant="secondary"
        >
          {t("settings.slackInbox.add")}
        </Button>
      </div>

      {servico === "teams" && canais && caixa !== "dms" ? (
        <div className="flex flex-col gap-1.5" data-locum-teams-canais="">
          {opcoesDeCanal === null ? (
            <div>
              <Button data-locum-teams-canais-carregar="" disabled={ocupado} onClick={carregarCanais} size="sm" variant="ghost">
                {t("settings.teamsChannels.load")}
              </Button>
            </div>
          ) : opcoesDeCanal.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t("settings.teamsChannels.none")}</p>
          ) : (
            <>
              <span className="text-muted-foreground text-xs">{t("settings.teamsChannels.pick")}</span>
              <ul className="border-border flex max-h-48 flex-col overflow-y-auto rounded-md border p-1">
                {opcoesDeCanal.map((c) => (
                  <li key={chaveDoCanal(c)}>
                    <label className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs">
                      <input
                        checked={canaisEscolhidos.has(chaveDoCanal(c))}
                        disabled={!canaisEscolhidos.has(chaveDoCanal(c)) && canaisEscolhidos.size >= 20}
                        onChange={() => alternarCanal(chaveDoCanal(c))}
                        type="checkbox"
                      />
                      <span className="text-muted-foreground">{c.teamName}</span>
                      <span>/ {c.channelName}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}

      {temPronto || agentsIniciais.data === undefined ? null : (
        <div className="border-border flex flex-wrap items-center gap-2 rounded-md border border-dashed p-2">
          <p className="text-muted-foreground min-w-0 flex-1 text-xs">{t("settings.inboxReply.hint")}</p>
          <Button
            {...{ [`data-locum-${servico}-resposta-pronta`]: "" }}
            disabled={ocupado}
            onClick={usarPronto}
            size="sm"
          >
            {t("settings.inboxReply.use")}
          </Button>
        </div>
      )}

      {recusa === null ? null : <p className="text-destructive text-xs">{recusa}</p>}
    </div>
  );
}

/* -------------------------------------------------------------------- teams */

/**
 * Teams pelo Microsoft Graph, com o app que a organização registra no Entra.
 *
 * O caminho é guiado como o do Slack: registrar o app (pelo portal ou pelo
 * comando da CLI do Azure), colar tenant e client id e autorizar. Nenhum dos
 * dois é segredo, e os dois ficam na máquina. O consentimento do administrador
 * é opcional e só serve à empresa que não deixa o usuário consentir sozinho.
 */
function TeamsPeloGraph() {
  const { t } = useTranslation();
  const inicial = useRead("connections.teamsApp");
  const [relido, setRelido] = useState<AppDoTeams | null>(null);
  const [tenant, setTenant] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  const app = relido ?? inicial.data ?? null;
  const valorDoTenant = tenant ?? app?.tenantId ?? "";
  const valorDoClientId = clientId ?? app?.clientId ?? "";
  const preenchido = valorDoTenant.trim() !== "" && valorDoClientId.trim() !== "";
  const recusa = erro ?? inicial.error?.message ?? null;

  const agir = (acao: Promise<unknown>, sucesso: string | null = null): void => {
    setOcupado(true);
    setAviso(null);
    acao
      .then(
        () => {
          setErro(null);
          setAviso(sucesso);
        },
        (falha: unknown) => setErro(falha instanceof Error ? falha.message : String(falha)),
      )
      .then(() => read("connections.teamsApp").then(setRelido, () => undefined))
      .finally(() => setOcupado(false));
  };

  const copiar = (): void => {
    if (app === null) return;
    void navigator.clipboard.writeText(app.command).then(() => {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    });
  };

  const campo =
    "border-border bg-background focus-visible:ring-ring w-80 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1";

  return (
    <div
      className="border-border flex flex-col gap-3 border-b px-4 py-3"
      data-locum-probe="teams"
      data-locum-teams-conectado={app?.connected ? "sim" : "nao"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t("settings.teams.title")}</span>
        {app?.connected ? <Badge variant="secondary">{t("settings.teams.connected")}</Badge> : null}
      </div>
      <p className="text-muted-foreground text-xs">{t("settings.teams.description")}</p>

      <ol className="text-muted-foreground flex list-decimal flex-col gap-1 pl-5 text-xs">
        <li>{t("settings.teams.stepRegister", { redirect: app?.redirectUri ?? "" })}</li>
        <li>
          {t(app?.channels ? "settings.teams.stepPermissionsChannels" : "settings.teams.stepPermissions", {
            scopes: (app?.scopes ?? []).join(", "),
          })}
        </li>
        <li>{t("settings.teams.stepIds")}</li>
      </ol>

      <div className="flex flex-col gap-1">
        <code className="bg-muted text-muted-foreground block overflow-x-auto rounded-md px-2 py-1 font-mono text-[11px] whitespace-nowrap">
          {app?.command ?? ""}
        </code>
        <div>
          <Button disabled={app === null} onClick={copiar} size="sm" variant="ghost">
            {copiado ? t("settings.teams.copied") : t("settings.teams.copyCommand")}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={t("settings.teams.tenant")}
          autoComplete="off"
          className={campo}
          data-locum-teams-tenant=""
          onChange={(evento) => setTenant(evento.target.value)}
          placeholder={t("settings.teams.tenantHint")}
          spellCheck={false}
          value={valorDoTenant}
        />
        <input
          aria-label={t("settings.teams.clientId")}
          autoComplete="off"
          className={campo}
          data-locum-teams-client-id=""
          onChange={(evento) => setClientId(evento.target.value)}
          placeholder={t("settings.teams.clientIdHint")}
          spellCheck={false}
          value={valorDoClientId}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-locum-teams-conectar=""
          disabled={ocupado || !preenchido}
          onClick={() => agir(call("connections.connectTeams", valorDoTenant.trim(), valorDoClientId.trim()))}
          size="sm"
        >
          {app?.connected ? t("settings.teams.reconnect") : t("settings.teams.connect")}
        </Button>
        <Button
          data-locum-teams-admin=""
          disabled={ocupado || !preenchido}
          onClick={() =>
            agir(
              call("connections.teamsAdminConsent", valorDoTenant.trim(), valorDoClientId.trim()),
              t("settings.teams.adminDone"),
            )
          }
          size="sm"
          variant="secondary"
        >
          {t("settings.teams.admin")}
        </Button>
        {app?.connected ? (
          <Button
            disabled={ocupado}
            onClick={() => agir(call("connections.disconnectTeams"))}
            size="sm"
            variant="ghost"
          >
            {t("settings.teams.disconnect")}
          </Button>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">{t("settings.teams.adminHow")}</p>

      <label className="flex cursor-pointer items-start gap-2 text-xs">
        <input
          checked={app?.channels ?? false}
          className="mt-0.5"
          data-locum-teams-canais-ligar=""
          disabled={ocupado || app === null}
          onChange={(evento) =>
            agir(
              call("connections.setTeamsChannels", evento.target.checked),
              app?.connected ? t("settings.teamsChannels.reconnect") : null,
            )
          }
          type="checkbox"
        />
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">{t("settings.teamsChannels.toggle")}</span>
          <span className="text-muted-foreground">
            {t("settings.teamsChannels.toggleHint", { scopes: (app?.channelScopes ?? []).join(", ") })}
          </span>
        </span>
      </label>

      {app?.connected ? <CaixaDeEntrada canais={app.channels} servico="teams" /> : null}

      {ocupado ? <p className="text-muted-foreground text-xs">{t("settings.teams.waiting")}</p> : null}
      {aviso !== null ? <p className="text-muted-foreground text-xs">{aviso}</p> : null}
      {recusa !== null ? (
        <p className="text-destructive text-xs" data-locum-teams-erro="">
          {recusa}
        </p>
      ) : null}
    </div>
  );
}

function Slack() {
  const { t } = useTranslation();
  const servidores = useRead("mcp.list");
  const inicial = useRead("slack.get");
  const [recarregado, setRecarregado] = useState<CadastroDoSlack | null>(null);
  const [canal, setCanal] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const cadastro = recarregado ?? inicial.data ?? null;
  const recusa = erro ?? inicial.error?.message ?? null;

  // Enquanto a leitura não voltou não há o que editar, e um formulário vazio
  // que aceitasse clique gravaria cadastro por cima do que ainda estava vindo.
  const [servidor, setServidor] = useState<string | null>(null);
  const [ferramenta, setFerramenta] = useState<string | null>(null);
  const [argCanal, setArgCanal] = useState<string | null>(null);
  const [argJanela, setArgJanela] = useState<string | null>(null);
  const [ferramentaDaResposta, setFerramentaDaResposta] = useState<string | null>(null);
  const [argCanalDaResposta, setArgCanalDaResposta] = useState<string | null>(null);
  const [argTexto, setArgTexto] = useState<string | null>(null);
  const [argThread, setArgThread] = useState<string | null>(null);

  const valorDoServidor = servidor ?? cadastro?.server ?? "";
  const valorDaFerramenta = ferramenta ?? cadastro?.tool ?? "";
  const valorDoArgCanal = argCanal ?? cadastro?.channelArg ?? "";
  const valorDoArgJanela = argJanela ?? cadastro?.sinceArg ?? "";
  const valorDaResposta = ferramentaDaResposta ?? cadastro?.postTool ?? "";
  const valorDoArgCanalDaResposta = argCanalDaResposta ?? cadastro?.postChannelArg ?? "";
  const valorDoArgTexto = argTexto ?? cadastro?.textArg ?? "";
  const valorDoArgThread = argThread ?? cadastro?.threadArg ?? "";

  const recarregar = (): Promise<void> =>
    read("slack.get").then(setRecarregado, (falha: unknown) =>
      setErro(falha instanceof Error ? falha.message : String(falha)),
    );

  const agir = (acao: Promise<unknown>): void => {
    setOcupado(true);
    acao
      .then(
        () => setErro(null),
        (falha: unknown) => setErro(falha instanceof Error ? falha.message : String(falha)),
      )
      .then(recarregar)
      .finally(() => setOcupado(false));
  };

  const podeSalvar =
    valorDoServidor !== "" &&
    valorDaFerramenta.trim() !== "" &&
    valorDoArgCanal.trim() !== "" &&
    valorDoArgJanela.trim() !== "" &&
    valorDaResposta.trim() !== "" &&
    valorDoArgCanalDaResposta.trim() !== "" &&
    valorDoArgTexto.trim() !== "" &&
    valorDoArgThread.trim() !== "";

  const salvar = (): void => {
    agir(
      call("slack.setSource", {
        server: valorDoServidor,
        tool: valorDaFerramenta.trim(),
        channelArg: valorDoArgCanal.trim(),
        sinceArg: valorDoArgJanela.trim(),
        postTool: valorDaResposta.trim(),
        postChannelArg: valorDoArgCanalDaResposta.trim(),
        textArg: valorDoArgTexto.trim(),
        threadArg: valorDoArgThread.trim(),
      }),
    );
  };

  const observar = (): void => {
    agir(call("slack.addChannel", canal.trim()).then(() => setCanal("")));
  };

  const canais = cadastro?.channels ?? [];

  return (
    <div
      className="flex flex-col gap-3 px-4 py-3"
      data-locum-probe="slack"
      data-locum-slack-canais={canais.join(",")}
      data-locum-slack-ferramenta-atual={cadastro?.tool ?? ""}
      data-locum-slack-resposta-atual={cadastro?.postTool ?? ""}
      data-locum-slack-servidor={cadastro?.server ?? ""}
    >
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={t("settings.slack.server")}
          className="border-border bg-background cursor-pointer rounded-md border px-2 py-1.5 text-xs"
          data-locum-slack-escolha=""
          onChange={(evento) => setServidor(evento.target.value)}
          value={valorDoServidor}
        >
          <option value="">{t("settings.slack.serverNone")}</option>
          {(servidores.data ?? []).map((s) => (
            <option key={s.config.name} value={s.config.name}>
              {s.config.name}
            </option>
          ))}
        </select>

        <input
          aria-label={t("settings.slack.tool")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-52 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-slack-ferramenta=""
          onChange={(evento) => setFerramenta(evento.target.value)}
          placeholder={t("settings.slack.toolHint")}
          spellCheck={false}
          value={valorDaFerramenta}
        />

        <input
          aria-label={t("settings.slack.channelArg")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-32 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-slack-arg-canal=""
          onChange={(evento) => setArgCanal(evento.target.value)}
          placeholder={t("settings.slack.channelArgHint")}
          spellCheck={false}
          value={valorDoArgCanal}
        />

        <input
          aria-label={t("settings.slack.sinceArg")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-32 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-slack-arg-janela=""
          onChange={(evento) => setArgJanela(evento.target.value)}
          placeholder={t("settings.slack.sinceArgHint")}
          spellCheck={false}
          value={valorDoArgJanela}
        />

        <input
          aria-label={t("settings.slack.postTool")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-52 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-slack-ferramenta-resposta=""
          onChange={(evento) => setFerramentaDaResposta(evento.target.value)}
          placeholder={t("settings.slack.postToolHint")}
          spellCheck={false}
          value={valorDaResposta}
        />

        <input
          aria-label={t("settings.slack.postChannelArg")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-32 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-slack-arg-canal-resposta=""
          onChange={(evento) => setArgCanalDaResposta(evento.target.value)}
          placeholder={t("settings.slack.postChannelArgHint")}
          spellCheck={false}
          value={valorDoArgCanalDaResposta}
        />

        <input
          aria-label={t("settings.slack.textArg")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-32 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-slack-arg-texto=""
          onChange={(evento) => setArgTexto(evento.target.value)}
          placeholder={t("settings.slack.textArgHint")}
          spellCheck={false}
          value={valorDoArgTexto}
        />

        <input
          aria-label={t("settings.slack.threadArg")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-32 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-slack-arg-thread=""
          onChange={(evento) => setArgThread(evento.target.value)}
          placeholder={t("settings.slack.threadArgHint")}
          spellCheck={false}
          value={valorDoArgThread}
        />

        <Button
          data-locum-slack-salvar=""
          disabled={ocupado || !podeSalvar}
          onClick={salvar}
          size="sm"
          variant="secondary"
        >
          {t("settings.slack.save")}
        </Button>
      </div>

      {canais.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("settings.slack.empty")}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {canais.map((observado) => (
            <li
              className="border-border flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
              data-locum-slack-canal={observado}
              key={observado}
            >
              <span className="font-mono text-xs">{observado}</span>
              <Button
                data-locum-slack-remover={observado}
                disabled={ocupado}
                onClick={() => agir(call("slack.removeChannel", observado))}
                size="sm"
                variant="ghost"
              >
                {t("settings.slack.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={t("settings.slack.channel")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-44 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-slack-novo-canal=""
          onChange={(evento) => setCanal(evento.target.value)}
          placeholder={t("settings.slack.channelHint")}
          spellCheck={false}
          value={canal}
        />
        <Button
          data-locum-slack-adicionar=""
          disabled={ocupado || canal.trim() === "" || cadastro?.server === null}
          onClick={observar}
          size="sm"
          variant="secondary"
        >
          {t("settings.slack.add")}
        </Button>
      </div>

      <p className="text-muted-foreground max-w-[68ch] text-xs">{t("settings.slack.howTo")}</p>

      {recusa === null ? null : (
        <p className="text-destructive text-xs" data-locum-slack-erro={recusa}>
          {t("settings.slack.refused", { message: recusa })}
        </p>
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
