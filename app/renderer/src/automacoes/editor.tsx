import { Canvas } from "@/components/ai-elements/canvas";
import { Controls } from "@/components/ai-elements/controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import {
  adicionarPasso,
  arestas,
  componenteDoPasso,
  desligar,
  ehGatilho,
  GATILHOS,
  gatilhosDoCadastro,
  ligar,
  mover,
  PASSOS,
  passoDoAgent,
  caminhosDe,
  comNosDeReacao,
  faltaReacaoNoGatilho,
  LOGICA,
  PREFIXO_DE_GATILHO,
  posicoes,
  problemas,
  removerPasso,
  type AgentDaBiblioteca,
  type AppDoComponente,
  type GatilhoNoCanvas,
  type Problema,
  type Rascunho,
} from "@/lib/automacao";
import { call, invalidateReads, read, useRead, type ReadResult } from "@/lib/bridge";
import { semPrefixoDoIpc } from "@/lib/erro-da-ponte";
import { rotuloDoMotivoDeEvento } from "@/lib/rotulos";
import { gatilhosParaGravar, mesclar, type Conflito, type Escolhas } from "@/lib/mesclar-automacao";
import {
  apagarProvisoria,
  descartarReserva,
  descartarRascunho,
  diferencas,
  diferencasEmTres,
  guardarProvisoria,
  guardarRascunho,
  idSemProvisoria,
  lerProvisoria,
  limparReservas,
  marcarProvisoriaCriada,
  ofertaDeRascunho,
  recusaPorIdOcupado,
  restaurarRascunho,
  reservarRascunho,
  temMudanca,
  type Diferenca,
  type OfertaDeRascunho,
  type Provisoria,
} from "@/lib/rascunho-automacao";
import { registrarGuarda, seguirSeSalvou } from "@/lib/saida-do-editor";
import { cn } from "@/lib/utils";
import {
  applyNodeChanges,
  Handle,
  MarkerType,
  Position,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  useNodesInitialized,
  useReactFlow,
} from "@xyflow/react";
import { ArrowLeft, Download, List, Loader2, Play } from "lucide-react";
import { MarcaLogo } from "@/components/marca-logo";
import { appsDaPaleta, buscarNaPaleta, fonteDaMarca, nomeDoApp, passoDaOperacao, passoSemOperacao, servidorDoNoVazio, type AppDaPaleta, type OperacaoDoApp } from "@/lib/apps-da-paleta";
import { tradutorDe } from "@/lib/operacao-da-ferramenta";
import { casaBusca } from "@/lib/paleta-conexoes";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentSpec, Step } from "../../../src/config/types";
import { esquemasDasConexoes, useFerramentasDasConexoes, useSaidasDoUltimoRun, type FerramentasDasConexoes } from "./ferramentas-das-conexoes";
import { useTranslation } from "react-i18next";
import type { RotaId } from "../rotas";
import { ModalDeAgent } from "./modal-de-agent";
import { useExecutarAgora } from "./executar-com";
import { PainelDoNo } from "./painel";
import { appDoGatilho, appDoPasso, resumoDoGatilho, Selo, tituloDoGatilho, tituloDoPasso } from "./visual";

type Automacao = NonNullable<ReadResult<"automations.get">>;

/**
 * O canvas de uma automação.
 *
 * Lê a automação gravada, edita um rascunho em memória e grava tudo de uma vez
 * no "Salvar", como versão nova do agent. Ligar e executar falam com o que
 * está gravado, e por isso "Executar agora" com alteração pendente pede para
 * salvar antes: rodaria a versão anterior, e a pessoa acharia que rodou a da
 * tela.
 */
export function EditorDeAutomacao({
  agentId,
  abrirGatilho,
  voltar,
  navegar,
}: {
  agentId: string;
  /** `novo` acrescenta um gatilho do GitHub ao rascunho; outro valor escolhe o gatilho de mesmo id. */
  abrirGatilho?: string;
  voltar: () => void;
  navegar: (id: RotaId, detalhe?: string) => void;
}) {
  const { t } = useTranslation();
  const lida = useRead("automations.get", agentId);
  // "Nova automação" não grava nada até o primeiro Salvar: o modelo espera aqui.
  const [provisoria, setProvisoria] = useState(() => lerProvisoria(globalThis.localStorage, agentId));
  // O id passou a existir no banco depois de a provisória ser guardada: ela espera a escolha de abrir ou descartar.
  const [abrindoProvisoria, setAbrindoProvisoria] = useState(false);

  if (lida.status === "loading") {
    return <p className="text-muted-foreground pt-6 text-sm">{t("automations.editor.loading")}</p>;
  }
  if (lida.status === "ready" && lida.data === null && provisoria !== null) {
    return <EditorCarregado abrirGatilho={abrirGatilho} automacao={deProvisoria(agentId, provisoria)} navegar={navegar} provisoria={provisoria} voltar={voltar} />;
  }
  if (lida.status === "error" || lida.data === null) {
    return (
      <div className="flex flex-col items-start gap-3 pt-6">
        <p className="text-sm">{lida.status === "error" ? lida.error.message : t("automations.editor.notFound")}</p>
        <Button className="cursor-pointer" onClick={voltar} size="sm" variant="outline">
          {t("automations.editor.back")}
        </Button>
      </div>
    );
  }
  if (provisoria !== null && abrindoProvisoria) {
    return (
      <EditorCarregado
        abrirGatilho={abrirGatilho}
        automacao={deProvisoria(agentId, provisoria)}
        idOcupado
        key="provisoria"
        navegar={navegar}
        provisoria={provisoria}
        voltar={voltar}
      />
    );
  }
  return (
    <EditorCarregado
      abrirGatilho={abrirGatilho}
      automacao={lida.data}
      key="gravada"
      ligacaoPendente={provisoria?.criada === true ? (provisoria.iniciativa ?? null) : null}
      navegar={navegar}
      provisoriaLocal={
        provisoria === null || provisoria.criada === true
          ? undefined
          : {
              abrir: () => setAbrindoProvisoria(true),
              descartar: () => {
                apagarProvisoria(globalThis.localStorage, agentId);
                setProvisoria(null);
              },
            }
      }
      voltar={voltar}
    />
  );
}

/**
 * O botão "valer para todos os chats": o gatilho gravado esperava a escolha de
 * chats e a pessoa zerou a pendência sem escolher nenhum. O serviço só aceita
 * isso com o aviso explícito.
 */
function valeParaTodosOsChats(g: GatilhoNoCanvas, gravados: readonly GatilhoNoCanvas[]): boolean {
  const antes = gravados.find((x) => x.id !== undefined && x.id === g.id)?.config;
  return (
    antes?.kind === "teams-inbox" &&
    antes.chatsPendentes > 0 &&
    antes.chats.length === 0 &&
    g.config.kind === "teams-inbox" &&
    g.config.chatsPendentes === 0 &&
    g.config.chats.length === 0
  );
}

/** A automação ainda não gravada, no formato da leitura: versão 0 e nenhum gatilho cadastrado. */
function deProvisoria(agentId: string, p: Provisoria): Automacao {
  return { version: { agentId, version: 0, spec: p.rascunho.spec, note: null, createdAt: 0, downgrades: [] }, createdAt: 0, triggers: [] } as unknown as Automacao;
}

function paraRascunho(a: Automacao): Rascunho {
  return { spec: a.version.spec, gatilhos: gatilhosDoCadastro(a.triggers) };
}

function EditorCarregado({
  automacao,
  abrirGatilho,
  voltar,
  navegar,
  provisoria,
  idOcupado: idJaOcupado = false,
  provisoriaLocal,
  ligacaoPendente: iniciativaPendente = null,
}: {
  automacao: Automacao;
  provisoria?: Provisoria;
  /** A provisória aberta sobre um id que já existe no banco: o Salvar grava com um id novo. */
  idOcupado?: boolean;
  /** Há uma provisória guardada com o id desta automação gravada: abrir ou descartar. */
  provisoriaLocal?: { abrir: () => void; descartar: () => void };
  /** A automação foi criada e só falta ligá-la a esta iniciativa. */
  ligacaoPendente?: string | null;
  abrirGatilho?: string;
  voltar: () => void;
  navegar: (id: RotaId, detalhe?: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const agentId = automacao.version.agentId;
  const [salvo, setSalvo] = useState<Rascunho>(() => provisoria?.rascunho ?? paraRascunho(automacao));
  // Ainda sem versão gravada: o primeiro Salvar cria a automação.
  const [nova, setNova] = useState(provisoria !== undefined);
  const [criadaEm, setCriadaEm] = useState(automacao.createdAt);
  const [rascunho, setRascunho] = useState<Rascunho>(salvo);
  const [versao, setVersao] = useState(automacao.version.version);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [nota, setNota] = useState("");
  const [ocupado, setOcupado] = useState<"salvar" | "rodar" | "ligar" | null>(null);
  const executarAgora = useExecutarAgora();
  const [aviso, setAviso] = useState<{ tipo: "ok" | "erro" | "aviso"; texto: string } | null>(null);
  // O rascunho de uma edição que não chegou ao Salvar (ou um reservado antes): espera a decisão da pessoa. `reservada` diz que ele já saiu da chave ativa.
  const [oferta, setOferta] = useState<(OfertaDeRascunho & { reservada: boolean }) | null>(() => {
    const atual = { versao: automacao.version.version, criadaEm: automacao.createdAt, rascunho: provisoria?.rascunho ?? paraRascunho(automacao) };
    limparReservas(globalThis.localStorage, agentId, atual);
    const o = ofertaDeRascunho(globalThis.localStorage, agentId, atual);
    return o === null ? null : { ...o, reservada: o.reserva !== undefined };
  });
  const [vendoDiferencas, setVendoDiferencas] = useState(false);
  // Qual lado fica em cada passo ou gatilho mexido dos dois lados.
  const [escolhas, setEscolhas] = useState<Escolhas>({});
  // O rascunho local não coube no armazém: a rede de segurança não está lá.
  const [rascunhoSemArmazem, setRascunhoSemArmazem] = useState(false);
  // O id da automação nova passou a existir no banco: o Salvar grava com um id novo.
  const [idOcupado, setIdOcupado] = useState(idJaOcupado);
  const [idSugerido, setIdSugerido] = useState<string | null>(null);
  const [irPara, setIrPara] = useState<string | null>(null);
  // A automação foi criada, mas a ligação à iniciativa falhou: espera outra tentativa.
  const [ligacaoPendente, setLigacaoPendente] = useState<string | null>(iniciativaPendente);
  const [trocando, setTrocando] = useState(false);
  // A gravação recusada porque a versão gravada é outra que a da base da edição.
  const [conflito, setConflito] = useState<{ atual: Automacao; confirmando: boolean } | null>(null);
  // A saída que espera a resposta de "salvar, descartar ou cancelar".
  const [saida, setSaida] = useState<{ prosseguir: () => void } | null>(null);
  // O agent da biblioteca aberto sobre o editor.
  const [modalDeAgent, setModalDeAgent] = useState<{ detalhe: string; aoFechar?: (id: string | null, lista: ReadResult<"library.profiles">) => void } | null>(null);

  const conexoes = useRead("connections.list");
  const ferramentas = useFerramentasDasConexoes();
  const saidasDoUltimoRun = useSaidasDoUltimoRun(agentId);
  const trackers = useRead("trackers.list");
  const biblioteca = useRead("library.profiles");
  // Relida depois de o painel transformar um passo em agent da biblioteca:
  // sem isso o agent recém-criado contaria como inexistente e travaria o Salvar.
  const agentsDaBiblioteca = biblioteca.data ?? [];
  const conectado = (id: string): boolean => (conexoes.data ?? []).some((c) => c.id === id && c.state === "connected");
  const listaDeTrackers = (trackers.data ?? []).filter((tr) => tr.enabled);
  const ctx = {
    slackConectado: conectado("slack"),
    teamsConectado: conectado("teams"),
    trackers: listaDeTrackers.map((tr) => tr.id),
    esquemas: esquemasDasConexoes(ferramentas.porServidor),
    ...(conexoes.data === undefined ? {} : { githubComToken: (conexoes.data.find((c) => c.id === "github")?.partes?.token ?? "missing") === "ok" }),
    ...(biblioteca.data === undefined ? {} : { agents: agentsDaBiblioteca.map((a) => a.id) }),
  };
  const appsLigados: Record<AppDoComponente, boolean> = {
    locum: true,
    slack: ctx.slackConectado,
    teams: ctx.teamsConectado,
    github: conectado("github"),
    atlassian: listaDeTrackers.length > 0 || conectado("atlassian"),
  };

  const viaDoTeams = (conexoes.data ?? []).find((c) => c.id === "teams")?.via;

  const mudou = temMudanca(rascunho, salvo);
  // O gatilho do Teams com link de PR já reagiu sozinho. O aviso aparece uma vez por automação: dispensar ou inserir os nós o encerra.
  const chaveDoAviso = `locum.aviso-reacao.${agentId}`;
  const [avisoDispensado, setAvisoDispensado] = useState<boolean>(() => globalThis.localStorage?.getItem(chaveDoAviso) === "1");
  const dispensarAvisoDeReacao = (): void => {
    globalThis.localStorage?.setItem(chaveDoAviso, "1");
    setAvisoDispensado(true);
  };
  const avisoDeReacao = !avisoDispensado && faltaReacaoNoGatilho(salvo) && faltaReacaoNoGatilho(rascunho);
  const lista = problemas(rascunho, ctx);
  const bloqueado = lista.some((p) => p.bloqueia);
  const ligada = salvo.gatilhos.some((g) => g.enabled);

  const quandoDoRascunho =
    oferta === null ? "" : new Date(oferta.guardado.salvoEm).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" });
  // A comparação a três: o que é meu, o que mudou por fora desde o rascunho e o que os dois mexeram.
  const diferencasDaOferta = useMemo(
    () => (oferta === null ? null : diferencasEmTres(oferta.guardado.base ?? salvo, oferta.guardado.rascunho, salvo)),
    [oferta, salvo],
  );
  // Aplica as minhas mudanças do rascunho oferecido sobre o gravado atual, passo a passo e gatilho a gatilho: ligado e estado dos gatilhos ficam os do gravado.
  const aplicarOferta = (): void => {
    if (oferta === null) return;
    setRascunho(restaurarRascunho(oferta.guardado.rascunho, salvo, oferta.guardado.base, escolhas));
    setEscolhas({});
    setSelecionado(null);
    if (oferta.reserva !== undefined) descartarReserva(globalThis.localStorage, oferta.reserva);
    setOferta(null);
    setTrocando(false);
  };

  // O que "salvar por cima" grava: o gravado atual com as minhas mudanças, e o que será desfeito dele.
  const porCima = useMemo(() => {
    if (conflito === null) return null;
    const atual = paraRascunho(conflito.atual);
    const { rascunho: resultado, conflitos } = mesclar(salvo, rascunho, atual, escolhas);
    return { atual, resultado, conflitos, desfeito: diferencas(atual, resultado) };
  }, [conflito, salvo, rascunho, escolhas]);

  const exportar = (): void => {
    setAviso(null);
    call("pacote.exportFile", agentId).then(
      (r) => {
        if (r !== null) setAviso({ tipo: "ok", texto: t("pacote.export.done", { arquivo: r.nomeDoArquivo }) });
      },
      (e: unknown) => setAviso({ tipo: "erro", texto: semPrefixoDoIpc(e instanceof Error ? e.message : String(e)) }),
    );
  };

  // Liga a automação recém-criada à iniciativa. A provisória só é apagada depois: se falhar, ela guarda a iniciativa para outra tentativa.
  const ligarAIniciativa = (iniciativa: string, id: string): void => {
    call("initiatives.linkAgent", id, iniciativa).then(
      () => {
        apagarProvisoria(globalThis.localStorage, id);
        setLigacaoPendente(null);
        setAviso({ tipo: "ok", texto: t("automations.editor.link.done") });
      },
      (e: unknown) => {
        setLigacaoPendente(iniciativa);
        setAviso({ tipo: "erro", texto: t("automations.editor.link.failed", { erro: semPrefixoDoIpc(e instanceof Error ? e.message : String(e)) }) });
      },
    );
  };

  /**
   * Grava o rascunho. `sobre` é a versão mais nova que entrou no meio: a base
   * esperada passa a ser a dela, e o que se grava é o gravado dela com as
   * minhas mudanças por cima. `comId` grava a automação nova com outro id,
   * quando o da provisória passou a existir no banco.
   */
  const salvar = (sobre?: Automacao, comId?: string): Promise<boolean> => {
    setOcupado("salvar");
    setAviso(null);
    const gravadoAgora = sobre === undefined ? salvo : paraRascunho(sobre);
    const resultado = sobre === undefined ? rascunho : mesclar(salvo, rascunho, gravadoAgora, escolhas).rascunho;
    const spec = comId === undefined ? resultado.spec : { ...resultado.spec, id: comId };
    const idGravado = comId ?? agentId;
    return call("automations.save", {
      spec,
      triggers: gatilhosParaGravar(resultado.gatilhos, gravadoAgora.gatilhos),
      knownTriggerIds: gravadoAgora.gatilhos.flatMap((g) => (g.id === undefined ? [] : [g.id])),
      note: nota.trim() || (nova ? provisoria?.nota : undefined) || t("automations.editor.noteDefault"),
      ...(nova ? { create: true } : { expectedVersion: sobre?.version.version ?? versao }),
    }).then(
      (gravada) => {
        const novo = paraRascunho(gravada);
        if (nova) {
          setNova(false);
          setCriadaEm(gravada.createdAt);
          const iniciativa = provisoria?.iniciativa;
          if (iniciativa === undefined) {
            apagarProvisoria(globalThis.localStorage, agentId);
            if (comId !== undefined) apagarProvisoria(globalThis.localStorage, comId);
          } else {
            // A provisória fica, marcada como criada, até a ligação à iniciativa dar certo.
            if (comId === undefined) marcarProvisoriaCriada(globalThis.localStorage, agentId);
            else {
              guardarProvisoria(globalThis.localStorage, comId, { ...provisoria!, criada: true });
              apagarProvisoria(globalThis.localStorage, agentId);
            }
            ligarAIniciativa(iniciativa, idGravado);
          }
        }
        setSalvo(novo);
        setRascunho(novo);
        setVersao(gravada.version.version);
        setNota("");
        setConflito(null);
        setEscolhas({});
        setIdOcupado(false);
        setOcupado(null);
        if (comId !== undefined) setIrPara(comId);
        const semEvento = gravada.avisos[0];
        setAviso(
          semEvento === undefined
            ? { tipo: "ok", texto: t("automations.editor.saved", { version: gravada.version.version }) }
            : {
                tipo: "aviso",
                texto: t("automations.editor.eventWarning", {
                  version: gravada.version.version,
                  reason: rotuloDoMotivoDeEvento(t, semEvento.motivo),
                  triggers: semEvento.gatilhos.map((k) => t(`automations.triggers.${k}.title`)).join(", "),
                }),
              },
        );
        return true;
      },
      async (e: unknown) => {
        setOcupado(null);
        const texto = semPrefixoDoIpc(e instanceof Error ? e.message : String(e));
        // O id da automação nova passou a existir: o rascunho fica, e o Salvar passa a gravar com um id novo.
        if (nova && recusaPorIdOcupado(texto)) {
          setIdOcupado(true);
          return false;
        }
        // Recusa por versão: relê para saber qual é a gravada e oferece recarregar ou salvar por cima.
        const atual = nova ? null : await read("automations.get", agentId).catch(() => null);
        if (atual !== null && atual.version.version !== (sobre?.version.version ?? versao)) setConflito({ atual, confirmando: false });
        else setAviso({ tipo: "erro", texto });
        return false;
      },
    );
  };

  // Id ocupado: sugere o novo desde já, para o botão dizer em que id vai gravar.
  useEffect(() => {
    if (!idOcupado || !nova) return;
    let vivo = true;
    call("automations.suggestId", rascunho.spec.name).then(
      (id) => vivo && setIdSugerido(idSemProvisoria(globalThis.localStorage, id)),
      () => undefined,
    );
    return () => {
      vivo = false;
    };
  }, [idOcupado, nova, rascunho.spec.name]);

  const gravarComIdNovo = async (): Promise<boolean> => {
    const sugerido = await call("automations.suggestId", rascunho.spec.name);
    return salvar(undefined, idSemProvisoria(globalThis.localStorage, sugerido));
  };

  // Depois de gravar com outro id, a rota passa a ser a dele. Só depois do render com o estado já salvo, para a guarda de saída não perguntar.
  const navegarAgora = useRef(navegar);
  navegarAgora.current = navegar;
  useEffect(() => {
    if (irPara !== null) navegarAgora.current("automations", irPara);
  }, [irPara]);

  // Recarregar depois de um conflito: as edições não se perdem, vão para a reserva e a oferta de rascunho aparece sobre o gravado novo.
  const recarregar = (atual: Automacao): void => {
    // Sem onde guardar, recarregar perderia as edições: fica como está, com o aviso.
    if (!guardarRascunho(globalThis.localStorage, agentId, rascunho, salvo, versao, Date.now(), criadaEm)) {
      setConflito(null);
      setAviso({ tipo: "erro", texto: t("automations.editor.draft.storageFull") });
      return;
    }
    reservarRascunho(globalThis.localStorage, agentId);
    const novoSalvo = paraRascunho(atual);
    setSalvo(novoSalvo);
    setRascunho(novoSalvo);
    setVersao(atual.version.version);
    setNota("");
    setSelecionado(null);
    const o = ofertaDeRascunho(globalThis.localStorage, agentId, { versao: atual.version.version, criadaEm, rascunho: novoSalvo });
    setOferta(o === null ? null : { ...o, reservada: o.reserva !== undefined });
    setVendoDiferencas(false);
    setConflito(null);
    // A saída que esperava estava a salvar: com as edições na reserva, não há mais o que confirmar.
    setSaida(null);
  };

  // Cada mudança vai para o rascunho local. Enquanto a oferta de um rascunho antigo está na tela, ele não é sobrescrito: a primeira edição
  // vale como "começar do gravado", e o antigo vai para a reserva (com a data) antes de o novo passar a ser guardado.
  useEffect(() => {
    if (oferta !== null && !oferta.reservada) {
      if (!mudou) return;
      const chave = reservarRascunho(globalThis.localStorage, agentId);
      setOferta((o) => (o === null ? o : { ...o, reservada: true, ...(chave === null ? {} : { reserva: chave }) }));
    }
    setRascunhoSemArmazem(!guardarRascunho(globalThis.localStorage, agentId, rascunho, salvo, versao, Date.now(), criadaEm));
  }, [oferta, mudou, agentId, rascunho, salvo, versao, criadaEm]);

  // Sair com mudança não salva pede confirmação, por qualquer caminho de navegação.
  const mudouAgora = useRef(mudou);
  mudouAgora.current = mudou;
  const novaAgora = useRef(nova);
  novaAgora.current = nova;
  useEffect(
    () =>
      registrarGuarda((prosseguir) => {
        if (!mudouAgora.current) {
          // Automação nova abandonada sem edição: nada foi gravado, e a provisória também some.
          if (novaAgora.current) apagarProvisoria(globalThis.localStorage, agentId);
          return false;
        }
        setSaida({ prosseguir });
        return true;
      }),
    [agentId],
  );

  const abrirAgent = (detalhe: string, aoFechar?: (id: string | null, lista: ReadResult<"library.profiles">) => void): void =>
    setModalDeAgent(aoFechar === undefined ? { detalhe } : { detalhe, aoFechar });
  const fecharAgent = (id: string | null): void => {
    const aoFechar = modalDeAgent?.aoFechar;
    setModalDeAgent(null);
    read("library.profiles").then((lista) => {
      invalidateReads("library.profiles");
      if (id !== null) aoFechar?.(id, lista);
    }, () => undefined);
  };

  const executar = (): void => {
    if (mudou || nova) {
      setAviso({ tipo: "erro", texto: t("automations.editor.runUnsaved") });
      return;
    }
    // Abre a execução na hora: é lá que se acompanha o que o agent vai fazendo.
    // Automação que depende de evento abre antes o diálogo "Executar com".
    void executarAgora.pedir(agentId, rascunho.spec.name, { aoIniciar: (runId) => navegar("runs", runId) });
  };

  const alternar = (): void => {
    setOcupado("ligar");
    call("automations.setEnabled", agentId, !ligada).then(
      (gatilhos) => {
        const porId = new Map(gatilhos.map((g) => [g.id, g.enabled]));
        const aplicar = (r: Rascunho): Rascunho => ({
          ...r,
          gatilhos: r.gatilhos.map((g) => (g.id !== undefined && porId.has(g.id) ? { ...g, enabled: porId.get(g.id)! } : g)),
        });
        setSalvo(aplicar);
        setRascunho(aplicar);
        setOcupado(null);
      },
      (e: unknown) => {
        setOcupado(null);
        setAviso({ tipo: "erro", texto: e instanceof Error ? e.message : String(e) });
      },
    );
  };

  /* ----------------------------------------------------- paleta e canvas */

  const acrescentarGatilho = (id: string): void => {
    const componente = GATILHOS.find((g) => g.id === id);
    if (componente === undefined) return;
    setRascunho((r) => {
      const usadas = new Set(r.gatilhos.map((g) => g.chave));
      let n = r.gatilhos.length + 1;
      while (usadas.has(`${PREFIXO_DE_GATILHO}${n}`)) n++;
      const chave = `${PREFIXO_DE_GATILHO}${n}`;
      setSelecionado(chave);
      return { ...r, gatilhos: [...r.gatilhos, { chave, config: componente.novo(), enabled: false }] };
    });
  };

  // Vindo do resumo do agent: escolhe o gatilho pedido, ou acrescenta o novo.
  // Uma vez só, porque o rascunho é de quem está editando.
  const abriu = useRef(false);
  useEffect(() => {
    if (abriu.current || abrirGatilho === undefined) return;
    abriu.current = true;
    if (abrirGatilho === "novo") {
      acrescentarGatilho("poll");
      return;
    }
    const pedido = rascunho.gatilhos.find((g) => g.id === abrirGatilho);
    if (pedido !== undefined) setSelecionado(pedido.chave);
  });

  const acrescentarPasso = (id: string): void => {
    const componente = PASSOS.find((p) => p.id === id);
    if (componente === undefined) return;
    inserirPasso((spec) => componente.novo(spec));
  };

  // Clicar no app cria o nó sem operação; o painel pergunta "O que fazer?".
  const acrescentarApp = (app: AppDaPaleta): void => {
    inserirPasso((spec) => passoSemOperacao(spec, app.id, nomeDoApp(app.id, tradutorDe(i18n)), servidorDoNoVazio(app)));
  };

  // Vindo da busca: o nó já nasce com a operação.
  const acrescentarOperacao = (operacao: OperacaoDoApp): void => {
    inserirPasso((spec) => passoDaOperacao(spec, operacao));
  };

  const inserirPasso = (criar: (spec: AgentSpec) => Step): void => {
    setRascunho((r) => {
      const passo = criar(r.spec);
      const depois = selecionado !== null && !ehGatilho(selecionado) ? selecionado : (r.spec.steps.at(-1)?.key ?? null);
      const lugar = posicoes(r).get(depois ?? "");
      const spec = adicionarPasso(r, passo, depois, lugar === undefined ? undefined : { x: lugar.x + 330, y: lugar.y });
      setSelecionado(passo.key);
      return { ...r, spec };
    });
  };

  const acrescentarLogica = (op: string): void => {
    const componente = LOGICA.find((l) => l.id === op);
    if (componente === undefined) return;
    setRascunho((r) => {
      const passo = componente.novo(r.spec);
      const depois = selecionado !== null && !ehGatilho(selecionado) ? selecionado : (r.spec.steps.at(-1)?.key ?? null);
      const lugar = posicoes(r).get(depois ?? "");
      const spec = adicionarPasso(r, passo, depois, lugar === undefined ? undefined : { x: lugar.x + 330, y: lugar.y });
      setSelecionado(passo.key);
      return { ...r, spec };
    });
  };

  const acrescentarAgent = (agent: AgentDaBiblioteca): void => {
    setRascunho((r) => {
      const passo = passoDoAgent(r.spec, agent);
      const depois = selecionado !== null && !ehGatilho(selecionado) ? selecionado : (r.spec.steps.at(-1)?.key ?? null);
      const lugar = posicoes(r).get(depois ?? "");
      const spec = adicionarPasso(r, passo, depois, lugar === undefined ? undefined : { x: lugar.x + 330, y: lugar.y });
      setSelecionado(passo.key);
      return { ...r, spec };
    });
  };

  const remover = (chave: string): void => {
    setRascunho((r) =>
      ehGatilho(chave)
        ? { ...r, gatilhos: r.gatilhos.filter((g) => g.chave !== chave) }
        : { ...r, spec: removerPasso(r.spec, chave) },
    );
    setSelecionado(null);
  };

  const problemasPorNo = new Map<string, Problema[]>();
  for (const p of lista) {
    if (p.no === undefined) continue;
    problemasPorNo.set(p.no, [...(problemasPorNo.get(p.no) ?? []), p]);
  }

  return (
    <div className="flex h-[calc(100vh-5.25rem)] min-h-[520px] flex-col gap-2 pt-1" data-locum-probe="automacao-editor" data-locum-versao={versao}>
      <header className="flex flex-wrap items-center gap-1.5">
        <Button className="cursor-pointer" onClick={voltar} size="sm" variant="ghost">
          <ArrowLeft />
          {t("automations.editor.back")}
        </Button>
        <Input
          aria-label={t("automations.panel.name")}
          className="min-w-48 max-w-md flex-1 font-medium"
          onChange={(e) => setRascunho((r) => ({ ...r, spec: { ...r.spec, name: e.target.value } }))}
          value={rascunho.spec.name}
        />
        <span className="text-muted-foreground num mr-auto text-xs" data-locum-automacao-nova-aviso={nova ? "" : undefined}>
          {nova ? t("automations.editor.notCreated") : t("automations.editor.version", { version: versao })}
        </span>
        {mudou ? <Badge variant="outline">{t("automations.editor.unsaved")}</Badge> : null}
        <Button className="cursor-pointer" disabled={nova} onClick={() => navegar("automations", `legacy/${agentId}`)} size="sm" variant="ghost">
          <List />
          {t("automations.editor.asList")}
        </Button>
        <Button
          className="cursor-pointer"
          data-locum-automacao-exportar=""
          disabled={ocupado !== null || mudou || nova}
          onClick={exportar}
          size="sm"
          title={mudou ? t("pacote.export.saveFirst") : t("pacote.export.hint")}
          variant="ghost"
        >
          <Download />
          {t("pacote.export.button")}
        </Button>
        <Button className="cursor-pointer" disabled={ocupado !== null || nova || executarAgora.pedindo} onClick={executar} size="sm" variant="outline">
          {executarAgora.pedindo ? <Loader2 className="animate-spin" /> : <Play />}
          {t("automations.editor.runNow")}
        </Button>
        {executarAgora.dialogo}
        <Button
          className="cursor-pointer"
          data-locum-automacao-ligar=""
          disabled={ocupado !== null || nova || salvo.gatilhos.length === 0}
          onClick={alternar}
          size="sm"
          title={t("automations.editor.enabledHint")}
          variant="outline"
        >
          <StatusDot estado={ligada ? "ok" : "ocioso"} />
          {t(ligada ? "automations.editor.disable" : "automations.editor.enable")}
        </Button>
      </header>

      {mudou || nova ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            className="min-w-64 flex-1"
            onChange={(e) => setNota(e.target.value)}
            placeholder={t("automations.editor.note")}
            value={nota}
          />
          <Button
            className="cursor-pointer"
            onClick={() => {
              setRascunho(salvo);
              setSelecionado(null);
            }}
            size="sm"
            variant="ghost"
          >
            {t("automations.editor.discard")}
          </Button>
          <Button
            className="cursor-pointer"
            data-locum-automacao-salvar=""
            disabled={bloqueado || ocupado !== null || (idOcupado && idSugerido === null)}
            onClick={() => void (idOcupado ? gravarComIdNovo() : salvar())}
            size="sm"
          >
            {ocupado === "salvar"
              ? t("automations.editor.saving")
              : idOcupado && idSugerido !== null
                ? t("automations.editor.newId.save", { id: idSugerido })
                : t("automations.editor.save")}
          </Button>
        </div>
      ) : null}

      {provisoriaLocal === undefined ? null : (
        <div className="bg-card border-border flex flex-wrap items-center gap-2 rounded-md border px-3 py-1.5 text-xs" data-locum-provisoria-local="">
          <StatusDot estado="aviso" />
          <span className="mr-auto">{t("automations.editor.localDraft.found")}</span>
          <Button className="cursor-pointer" onClick={provisoriaLocal.descartar} size="sm" variant="ghost">
            {t("automations.editor.localDraft.discard")}
          </Button>
          <Button className="cursor-pointer" onClick={provisoriaLocal.abrir} size="sm">
            {t("automations.editor.localDraft.open")}
          </Button>
        </div>
      )}

      {nova && idOcupado ? (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs" data-locum-id-ocupado="">
          <StatusDot estado="aviso" />
          {t("automations.editor.newId.taken", { id: agentId, novo: idSugerido ?? "..." })}
        </p>
      ) : null}

      {rascunhoSemArmazem ? (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs" data-locum-rascunho-sem-armazem="">
          <StatusDot estado="aviso" />
          {t("automations.editor.draft.storageFull")}
        </p>
      ) : null}

      {ligacaoPendente === null ? null : (
        <div className="flex items-center gap-2 text-xs" data-locum-ligacao-pendente="">
          <StatusDot estado="aviso" />
          <span>{t("automations.editor.link.pending")}</span>
          <Button className="cursor-pointer" onClick={() => ligarAIniciativa(ligacaoPendente, agentId)} size="sm" variant="outline">
            {t("automations.editor.link.retry")}
          </Button>
        </div>
      )}

      {oferta === null ? null : (
        <div className="bg-card border-border flex flex-col gap-1.5 rounded-md border px-3 py-1.5 text-xs" data-locum-rascunho={oferta.reservada ? "reservado" : ""}>
          <div className="flex flex-wrap items-center gap-2">
            <StatusDot estado="aviso" />
            <span className="mr-auto">
              {oferta.reservada
                ? t("automations.editor.draft.reserved", { quando: quandoDoRascunho })
                : t("automations.editor.draft.found", { quando: quandoDoRascunho })}
              {oferta.baseMudou ? ` ${t("automations.editor.draft.baseChanged", { de: oferta.guardado.versao, para: versao })}` : ""}
            </span>
            <Button className="cursor-pointer" data-locum-rascunho-diferencas="" onClick={() => setVendoDiferencas((v) => !v)} size="sm" variant="ghost">
              {t(vendoDiferencas ? "automations.editor.draft.hideDiff" : "automations.editor.draft.diff")}
            </Button>
            <Button
              className="cursor-pointer"
              data-locum-rascunho-descartar=""
              onClick={() => {
                if (oferta.reserva !== undefined) descartarReserva(globalThis.localStorage, oferta.reserva);
                else descartarRascunho(globalThis.localStorage, agentId);
                setOferta(null);
              }}
              size="sm"
              variant="ghost"
            >
              {t(oferta.reservada ? "automations.editor.draft.discardReserved" : "automations.editor.draft.discard")}
            </Button>
            <Button
              className="cursor-pointer"
              data-locum-rascunho-continuar=""
              onClick={() => {
                // Editar depois de a oferta aparecer já foi uma escolha: trocar agora descarta essas edições, e isso pergunta.
                if (oferta.reservada && mudou) setTrocando(true);
                else aplicarOferta();
              }}
              size="sm"
            >
              {t(oferta.reservada ? "automations.editor.draft.continueReserved" : oferta.baseMudou ? "automations.editor.draft.continueAnyway" : "automations.editor.draft.continue")}
            </Button>
          </div>
          {vendoDiferencas && diferencasDaOferta !== null ? (
            <div className="text-muted-foreground flex flex-col gap-1 pl-5" data-locum-rascunho-lista="">
              <ListaDeDiferencas
                diferencas={diferencasDaOferta.minhas}
                prefixo="minhas"
                titulo={t("automations.editor.draft.mine")}
                vazio={t("automations.editor.draft.diffNone")}
              />
              {diferencasDaOferta.deFora.passos.length + diferencasDaOferta.deFora.gatilhos.length === 0 ? null : (
                <ListaDeDiferencas diferencas={diferencasDaOferta.deFora} prefixo="fora" titulo={t("automations.editor.draft.byOutside")} />
              )}
              <EscolhaDosConflitos conflitos={diferencasDaOferta.conflitos} escolhas={escolhas} setEscolhas={setEscolhas} />
            </div>
          ) : null}
        </div>
      )}

      {aviso === null ? null : (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <StatusDot estado={aviso.tipo === "erro" ? "erro" : aviso.tipo === "aviso" ? "aviso" : "ok"} />
          {aviso.texto}
        </p>
      )}

      {avisoDeReacao ? (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs" data-locum-aviso-reacao="">
          <StatusDot estado="aviso" />
          <span className="mr-auto">{t("automations.editor.reactionNotice.text")}</span>
          <Button
            className="cursor-pointer"
            data-locum-aviso-reacao-adicionar=""
            onClick={() => {
              setRascunho((r) => comNosDeReacao(r, { pegou: t("automations.reactionNodes.pegou"), veredito: t("automations.reactionNodes.verdict") }));
              dispensarAvisoDeReacao();
            }}
            size="sm"
            variant="outline"
          >
            {t("automations.editor.reactionNotice.add")}
          </Button>
          <Button className="cursor-pointer" data-locum-aviso-reacao-dispensar="" onClick={dispensarAvisoDeReacao} size="sm" variant="ghost">
            {t("automations.editor.reactionNotice.dismiss")}
          </Button>
        </p>
      ) : null}

      {lista.length > 0 ? (
        <details className="text-xs" data-locum-problemas={lista.length}>
          <summary className="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer items-center gap-1.5">
            <StatusDot estado={bloqueado ? "erro" : "aviso"} />
            {t("automations.editor.problems", { count: lista.length })}
            {bloqueado ? ` · ${t("automations.editor.blocked")}` : ""}
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 pl-3">
            {lista.map((p, i) => (
              <li key={i}>
                <button
                  className="text-muted-foreground hover:text-foreground cursor-pointer text-left hover:underline"
                  onClick={() => p.no !== undefined && setSelecionado(p.no)}
                  type="button"
                >
                  {t(p.chave, p.valores)}
                </button>
                {p.atalho === undefined ? null : (
                  <button className="text-primary ml-2 cursor-pointer hover:underline" onClick={() => navegar(p.atalho!.rota, p.atalho!.detalhe)} type="button">
                    {t("automations.problems.openConnection")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-3">
        <Paleta
          agents={agentsDaBiblioteca}
          aoAgent={acrescentarAgent}
          aoGatilho={acrescentarGatilho}
          aoLogica={acrescentarLogica}
          aoPasso={acrescentarPasso}
          aoApp={acrescentarApp}
          aoOperacao={acrescentarOperacao}
          conexoes={ferramentas}
          appsLigados={appsLigados}
          viaDoTeams={viaDoTeams}
          criarAgent={() =>
            abrirAgent("novo", (id, lista) => {
              const criado = lista.find((a) => a.id === id);
              if (criado !== undefined && !agentsDaBiblioteca.some((a) => a.id === id)) acrescentarAgent(criado);
            })
          }
        />
        <div className="border-border min-w-0 flex-1 overflow-hidden rounded-lg border" data-locum-probe="automacao-canvas">
          <CanvasDaAutomacao
            agents={agentsDaBiblioteca}
            problemasPorNo={problemasPorNo}
            rascunho={rascunho}
            selecionado={selecionado}
            setRascunho={setRascunho}
            setSelecionado={setSelecionado}
          />
        </div>
        {selecionado === null ? null : (
          <PainelDoNo
            agents={agentsDaBiblioteca}
            conexoes={ferramentas}
            saidas={saidasDoUltimoRun}
            abrirAgent={abrirAgent}
            chave={selecionado}
            navegar={navegar}
            relerBiblioteca={() => Promise.resolve(invalidateReads("library.profiles"))}
            fechar={() => setSelecionado(null)}
            problemas={problemasPorNo.get(selecionado) ?? []}
            rascunho={rascunho}
            remover={() => remover(selecionado)}
            setRascunho={setRascunho}
            trackers={listaDeTrackers}
          />
        )}
      </div>

      {modalDeAgent === null ? null : <ModalDeAgent detalhe={modalDeAgent.detalhe} fechar={fecharAgent} navegar={navegar} />}

      <Dialog onOpenChange={(aberto) => !aberto && setTrocando(false)} open={trocando}>
        <DialogContent data-locum-rascunho-trocar="">
          <DialogHeader>
            <DialogTitle>{t("automations.editor.draft.swap.title")}</DialogTitle>
            <DialogDescription>{t("automations.editor.draft.swap.body")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button className="cursor-pointer" onClick={() => setTrocando(false)} size="sm" variant="ghost">
              {t("automations.editor.exit.cancel")}
            </Button>
            <Button className="cursor-pointer" data-locum-rascunho-trocar-confirmar="" onClick={aplicarOferta} size="sm">
              {t("automations.editor.draft.swap.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={(aberto) => !aberto && setConflito(null)} open={conflito !== null}>
        <DialogContent data-locum-conflito="">
          <DialogHeader>
            <DialogTitle>{t("automations.editor.conflict.title")}</DialogTitle>
            <DialogDescription>
              {t("automations.editor.conflict.body", { de: versao, para: conflito?.atual.version.version ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <p className="text-muted-foreground text-xs">{t("automations.editor.conflict.reloadHint")}</p>
          {conflito?.confirmando && porCima !== null ? (
            <div className="text-muted-foreground flex max-h-56 flex-col gap-1 overflow-y-auto text-xs" data-locum-conflito-desfeito="">
              <EscolhaDosConflitos conflitos={porCima.conflitos} escolhas={escolhas} setEscolhas={setEscolhas} />
              <ListaDeDiferencas
                diferencas={porCima.desfeito}
                prefixo="desfeito"
                titulo={t("automations.editor.conflict.undoTitle", { para: conflito.atual.version.version })}
                vazio={t("automations.editor.conflict.undoNone", { para: conflito.atual.version.version })}
              />
            </div>
          ) : null}
          <DialogFooter>
            <Button className="cursor-pointer" onClick={() => setConflito(null)} size="sm" variant="ghost">
              {t("automations.editor.conflict.cancel")}
            </Button>
            <Button className="cursor-pointer" data-locum-conflito-recarregar="" onClick={() => conflito !== null && recarregar(conflito.atual)} size="sm" variant="outline">
              {t("automations.editor.conflict.reload")}
            </Button>
            {conflito?.confirmando ? (
              <Button
                className="cursor-pointer"
                data-locum-conflito-confirmar=""
                disabled={ocupado !== null || bloqueado}
                onClick={() => {
                  if (conflito === null) return;
                  // Com a pergunta de saída aberta antes do conflito, salvar por cima também a conclui.
                  void salvar(conflito.atual).then((ok) => seguirSeSalvou(saida, ok, () => setSaida(null)));
                }}
                size="sm"
                variant="destructive"
              >
                {t("automations.editor.conflict.confirmOverwrite", { para: conflito.atual.version.version })}
              </Button>
            ) : (
              <Button className="cursor-pointer" data-locum-conflito-por-cima="" onClick={() => setConflito((c) => (c === null ? c : { ...c, confirmando: true }))} size="sm">
                {t("automations.editor.conflict.overwrite")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={(aberto) => !aberto && setSaida(null)} open={saida !== null && conflito === null}>
        <DialogContent data-locum-saida="">
          <DialogHeader>
            <DialogTitle>{t("automations.editor.exit.title")}</DialogTitle>
            <DialogDescription>{t("automations.editor.exit.body")}</DialogDescription>
          </DialogHeader>
          {bloqueado ? <p className="text-muted-foreground text-xs">{t("automations.editor.exit.blocked")}</p> : null}
          <DialogFooter>
            <Button className="cursor-pointer" data-locum-saida-cancelar="" onClick={() => setSaida(null)} size="sm" variant="ghost">
              {t("automations.editor.exit.cancel")}
            </Button>
            <Button
              className="cursor-pointer"
              data-locum-saida-descartar=""
              onClick={() => {
                const seguir = saida?.prosseguir;
                // Só o rascunho ativo: a reserva é de uma decisão que a pessoa ainda não tomou, e continua achável.
                descartarRascunho(globalThis.localStorage, agentId);
                if (nova) apagarProvisoria(globalThis.localStorage, agentId);
                setSaida(null);
                seguir?.();
              }}
              size="sm"
              variant="outline"
            >
              {t("automations.editor.exit.discard")}
            </Button>
            <Button
              className="cursor-pointer"
              data-locum-saida-salvar=""
              disabled={bloqueado || ocupado !== null}
              onClick={() => {
                void salvar().then((ok) => seguirSeSalvou(saida, ok, () => setSaida(null)));
              }}
              size="sm"
            >
              {t("automations.editor.exit.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------- diferenças */

function ListaDeDiferencas({
  diferencas: d,
  titulo,
  prefixo,
  vazio,
}: {
  diferencas: { passos: Diferenca[]; gatilhos: Diferenca[] };
  titulo: string;
  prefixo: string;
  vazio?: string;
}) {
  const { t } = useTranslation();
  const linha = (grupo: string, x: Diferenca): ReactNode => (
    <span key={`${prefixo}-${grupo}-${x.tipo}-${x.chave}-${x.id ?? ""}`}>{`${t(`automations.editor.draft.kind.${x.tipo}`)}: ${x.rotulo}`}</span>
  );
  const vazia = d.passos.length + d.gatilhos.length === 0;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-foreground">{titulo}</span>
      {vazia && vazio !== undefined ? <span>{vazio}</span> : null}
      {d.passos.length > 0 ? <span className="text-foreground">{t("automations.editor.draft.diffSteps")}</span> : null}
      {d.passos.map((x) => linha("passo", x))}
      {d.gatilhos.length > 0 ? <span className="text-foreground">{t("automations.editor.draft.diffTriggers")}</span> : null}
      {d.gatilhos.map((x) => linha("gatilho", x))}
    </div>
  );
}

/** Passo ou gatilho mexido dos dois lados: a pessoa escolhe qual fica. */
function EscolhaDosConflitos({
  conflitos,
  escolhas,
  setEscolhas,
}: {
  conflitos: readonly Conflito[];
  escolhas: Escolhas;
  setEscolhas: (e: Escolhas) => void;
}) {
  const { t } = useTranslation();
  if (conflitos.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5" data-locum-rascunho-conflitos="">
      <span className="text-foreground">{t("automations.editor.draft.conflicts")}</span>
      {conflitos.map((c) => (
        <span className="flex items-center gap-2" key={`${c.tipo}-${c.chave}`}>
          <Badge variant="outline">{c.rotulo}</Badge>
          {(["meu", "de-fora"] as const).map((lado) => (
            <Button
              className="cursor-pointer"
              key={lado}
              onClick={() => setEscolhas({ ...escolhas, [c.chave]: lado })}
              size="sm"
              variant={(escolhas[c.chave] ?? "meu") === lado ? "secondary" : "ghost"}
            >
              {t(lado === "meu" ? "automations.editor.draft.keepMine" : "automations.editor.draft.keepOutside")}
            </Button>
          ))}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ paleta */

function Paleta({
  appsLigados,
  viaDoTeams,
  agents,
  aoGatilho,
  aoPasso,
  aoAgent,
  aoLogica,
  aoApp,
  aoOperacao,
  conexoes,
  criarAgent,
}: {
  appsLigados: Record<AppDoComponente, boolean>;
  /** O servidor MCP por onde o Teams vem, quando não há login nativo. */
  viaDoTeams: string | undefined;
  agents: readonly AgentDaBiblioteca[];
  aoGatilho: (id: string) => void;
  aoPasso: (id: string) => void;
  aoAgent: (agent: AgentDaBiblioteca) => void;
  aoLogica: (op: string) => void;
  aoApp: (app: AppDaPaleta) => void;
  aoOperacao: (operacao: OperacaoDoApp) => void;
  conexoes: FerramentasDasConexoes;
  criarAgent: () => void;
}) {
  const { t, i18n } = useTranslation();
  const Item = ({ app, id, titulo, onClick }: { app: AppDoComponente; id: string; titulo: string; onClick: () => void }) => (
    <li>
      <button
        className="hover:bg-accent flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] transition-colors"
        title={titulo}
        data-locum-paleta={id}
        onClick={onClick}
        type="button"
      >
        <Selo app={app} id={id} tamanho="sm" />
        <span className="flex min-w-0 flex-col">
          <span className="line-clamp-2 leading-4">{titulo}</span>
          {appsLigados[app] ? (
            app === "teams" && viaDoTeams !== undefined ? (
              <span className="text-muted-foreground text-[11px]">{t("automations.palette.viaServer", { server: viaDoTeams })}</span>
            ) : null
          ) : (
            <span className="text-muted-foreground text-[11px]">{t("automations.palette.needsApp")}</span>
          )}
        </span>
      </button>
    </li>
  );

  const [busca, setBusca] = useState("");
  const buscando = busca.trim() !== "";
  const descricaoDe = (id: string): string | undefined => (i18n.exists(`automations.steps.${id}.description`) ? t(`automations.steps.${id}.description`) : undefined);
  const gatilhos = GATILHOS.filter((g) => casaBusca(busca, t(`automations.triggers.${g.id}.title`), g.id));
  const passos = PASSOS.filter((p) => p.id === "ai" && casaBusca(busca, tituloDoPasso(t, p.id), p.id, descricaoDe(p.id)));
  const logica = LOGICA.filter((l) => casaBusca(busca, tituloDoPasso(t, `logic.${l.id}`), l.id));
  const listaDeAgents = agents.filter((a) => casaBusca(busca, a.name));
  const traduzir = tradutorDe(i18n);
  const paleta = conexoes.servidores.map((servidor) => ({ servidor, ferramentas: conexoes.porServidor[servidor]?.tools ?? null }));
  const { apps, operacoes } = buscarNaPaleta(paleta, busca, traduzir);
  const todosOsApps = appsDaPaleta(paleta);
  const Titulo = ({ chave }: { chave: string }) => <h3 className="text-muted-foreground px-1.5 pb-0.5 text-[11px] font-medium">{t(chave)}</h3>;

  return (
    <aside className="border-border bg-card flex w-60 shrink-0 flex-col gap-2 overflow-y-auto rounded-lg border p-1.5" data-locum-probe="automacao-paleta">
      <p className="text-muted-foreground px-2 pt-1 text-[11px]">{t("automations.palette.hint")}</p>
      <input
        aria-label={t("automations.palette.search")}
        className="border-input focus-visible:border-ring focus-visible:ring-ring/40 mx-1 rounded-md border bg-transparent px-2 py-1 text-[13px] outline-none focus-visible:ring-2"
        data-locum-paleta-busca=""
        onChange={(e) => setBusca(e.target.value)}
        placeholder={t("automations.palette.search")}
        value={busca}
      />
      {gatilhos.length === 0 ? null : (
        <section>
          <Titulo chave="automations.palette.triggers" />
          <ul>
            {gatilhos.map((g) => (
              <Item app={g.app} id={g.id} key={g.id} onClick={() => aoGatilho(g.id)} titulo={t(`automations.triggers.${g.id}.title`)} />
            ))}
          </ul>
        </section>
      )}
      {buscando && listaDeAgents.length === 0 ? null : (
        <section>
          <Titulo chave="automations.palette.agents" />
          <ul>
            {listaDeAgents.map((a) => (
              <Item app="locum" id="agent" key={a.id} onClick={() => aoAgent(a)} titulo={a.name} />
            ))}
          </ul>
          {agents.length === 0 ? <p className="text-muted-foreground px-2 text-[11px]">{t("automations.palette.agentsEmpty")}</p> : null}
          {buscando ? null : (
            <button className="text-primary cursor-pointer px-2 pt-1 text-[11px] hover:underline" onClick={criarAgent} type="button">
              {t("automations.palette.newAgent")}
            </button>
          )}
        </section>
      )}
      {passos.length === 0 ? null : (
        <section>
          <Titulo chave="automations.palette.steps" />
          <ul>
            {passos.map((p) => (
              <Item app={p.app} id={p.id} key={p.id} onClick={() => aoPasso(p.id)} titulo={tituloDoPasso(t, p.id)} />
            ))}
          </ul>
        </section>
      )}
      {logica.length === 0 ? null : (
        <section>
          <Titulo chave="automations.palette.logic" />
          <ul>
            {logica.map((l) => (
              <Item
                app={appDoPasso(`logic.${l.id}`)}
                id={`logic.${l.id}`}
                key={l.id}
                onClick={() => aoLogica(l.id)}
                titulo={tituloDoPasso(t, `logic.${l.id}`)}
              />
            ))}
          </ul>
        </section>
      )}
      {apps.length === 0 ? null : (
        <section data-locum-paleta-apps="">
          <Titulo chave="automations.palette.apps" />
          <ul>
            {apps.map((app) => (
              <li key={app.id}>
                <button
                  className="hover:bg-accent flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] transition-colors"
                  data-locum-paleta-app={app.id}
                  onClick={() => aoApp(app)}
                  type="button"
                >
                  <MarcaLogo fonte={{ name: fonteDaMarca(app) }} tamanho="sm" />
                  <span className="line-clamp-2 min-w-0 leading-4">{nomeDoApp(app.id, traduzir)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {operacoes.length === 0 ? null : (
        <section data-locum-paleta-operacoes="">
          <Titulo chave="automations.palette.operations" />
          <ul>
            {operacoes.map((o) => (
              <li key={o.chave}>
                <button
                  className="hover:bg-accent flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] transition-colors"
                  data-locum-paleta-operacao={o.chave}
                  data-locum-paleta-classe={o.leitura ? "leitura" : "escrita"}
                  onClick={() => aoOperacao(o)}
                  title={o.descricao === "" ? o.titulo : o.descricao}
                  type="button"
                >
                  <MarcaLogo fonte={{ name: fonteDaMarca(todosOsApps.find((a) => a.id === o.app)!) }} tamanho="sm" />
                  <span className="line-clamp-2 min-w-0 leading-4">
                    {nomeDoApp(o.app, traduzir)} · {o.titulo}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {buscando && gatilhos.length + passos.length + logica.length + listaDeAgents.length + apps.length + operacoes.length === 0 ? (
        <p className="text-muted-foreground px-2 text-[11px]">{t("automations.palette.noMatch")}</p>
      ) : null}
    </aside>
  );
}

/* ------------------------------------------------------------------ canvas */

type DadosDoNo = {
  chave: string;
  app: AppDoComponente;
  componente: string;
  tipo: string;
  titulo: string;
  subtitulo: string;
  gatilho: boolean;
  aprovacao: boolean;
  /** Ação que sai sozinha, sem passar pela fila. */
  automatico: boolean;
  problema: "bloqueia" | "aviso" | null;
  desligado: boolean;
  /** Saídas de uma decisão, uma alça por caminho. Vazio: uma saída só. */
  caminhos: { id: string; rotulo: string }[];
};

type NoDoCanvas = Node<DadosDoNo, "componente">;

function CanvasDaAutomacao({
  agents,
  rascunho,
  setRascunho,
  selecionado,
  setSelecionado,
  problemasPorNo,
}: {
  rascunho: Rascunho;
  setRascunho: (f: (r: Rascunho) => Rascunho) => void;
  selecionado: string | null;
  setSelecionado: (chave: string | null) => void;
  problemasPorNo: Map<string, Problema[]>;
  agents: readonly AgentDaBiblioteca[];
}) {
  const { t, i18n } = useTranslation();
  const [erro, setErro] = useState<string | null>(null);

  const base = useMemo<NoDoCanvas[]>(() => {
    const onde = posicoes(rascunho);
    const nivel = (chave: string): DadosDoNo["problema"] => {
      const doNo = problemasPorNo.get(chave) ?? [];
      return doNo.some((p) => p.bloqueia) ? "bloqueia" : doNo.length > 0 ? "aviso" : null;
    };
    const gatilhos: NoDoCanvas[] = rascunho.gatilhos.map((g: GatilhoNoCanvas) => ({
      id: g.chave,
      type: "componente",
      position: onde.get(g.chave) ?? { x: 0, y: 0 },
      selected: g.chave === selecionado,
      data: {
        chave: g.chave,
        app: appDoGatilho(g.config.kind),
        componente: g.config.kind,
        tipo: t("automations.palette.triggers"),
        titulo: tituloDoGatilho(t, g.config),
        subtitulo: resumoDoGatilho(t, g.config, i18n.language),
        gatilho: true,
        aprovacao: false,
        automatico: false,
        problema: nivel(g.chave),
        desligado: !g.enabled,
        caminhos: [],
      },
    }));
    const passos: NoDoCanvas[] = rascunho.spec.steps.map((p) => {
      const componente = componenteDoPasso(p);
      return {
        id: p.key,
        type: "componente",
        position: onde.get(p.key) ?? { x: 0, y: 0 },
        selected: p.key === selecionado,
        data: {
          chave: p.key,
          app: appDoPasso(componente),
          componente,
          tipo: tituloDoPasso(t, componente),
          titulo: p.name,
          subtitulo:
            p.type === "logic"
              ? resumoDaLogica(p)
              : p.type !== "model"
                ? resumoDaAcao(p)
              : p.profile !== undefined
                ? (agents.find((a) => a.id === p.profile)?.name ?? p.profile)
                : (p.model.split("/").at(-1) ?? p.model),
          gatilho: false,
          aprovacao: p.type === "action" && p.mode === "approve",
          automatico: p.type === "action" && p.mode === "auto",
          problema: nivel(p.key),
          desligado: false,
          caminhos: caminhosDe(p).map((c) => ({ id: c, rotulo: rotuloDoCaminho(t, c) })),
        },
      };
    });
    return [...gatilhos, ...passos];
  }, [rascunho, selecionado, problemasPorNo, agents, t]);

  const [nos, setNos] = useState<NoDoCanvas[]>(base);
  useEffect(() => setNos(base), [base]);

  const ligacoes = useMemo<Edge[]>(
    () =>
      arestas(rascunho).map((a) => ({
        id: a.id,
        source: a.source,
        target: a.target,
        ...(a.sourceHandle === undefined
          ? {}
          : { sourceHandle: a.sourceHandle, label: rotuloDoCaminho(t, a.sourceHandle), labelStyle: { fontSize: 11 } }),
        deletable: !a.fixa,
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed },
        style: a.fixa ? { strokeDasharray: "5 5", opacity: 0.6 } : undefined,
      })),
    [rascunho, t],
  );

  const conectar = (c: Connection): void => {
    const resultado = ligar(rascunho.spec, c.source, c.target, c.sourceHandle);
    if ("erro" in resultado) {
      setErro(t(resultado.erro));
      return;
    }
    setErro(null);
    setRascunho((r) => ({ ...r, spec: resultado.spec }));
  };

  return (
    <div className="relative size-full" aria-label={t("automations.canvas.label")}>
      <Canvas
        edges={ligacoes}
        fitViewOptions={{ padding: 0.2, minZoom: 0.25, maxZoom: 1 }}
        minZoom={0.25}
        nodeTypes={TIPOS}
        nodes={nos}
        onConnect={conectar}
        onEdgesDelete={(removidas) =>
          setRascunho((r) => ({
            ...r,
            spec: removidas.reduce((spec, e) => desligar(spec, e.source, e.target), r.spec),
          }))
        }
        onNodeClick={(_, no) => setSelecionado(no.id)}
        onNodeDragStop={(_, no) => setRascunho((r) => ({ ...r, spec: mover(r.spec, no.id, no.position) }))}
        onNodesChange={(mudancas: NodeChange[]) =>
          // Só posição e medida: seleção, inclusão e remoção passam pelo rascunho.
          setNos(
            (atuais) =>
              applyNodeChanges(
                mudancas.filter((m) => m.type === "position" || m.type === "dimensions"),
                atuais as Node[],
              ) as NoDoCanvas[],
          )
        }
        onNodesDelete={(removidos) => {
          const chaves = new Set(removidos.map((n) => n.id));
          setRascunho((r) => ({
            ...r,
            gatilhos: r.gatilhos.filter((g) => !chaves.has(g.chave)),
            spec: [...chaves].filter((c) => !ehGatilho(c)).reduce((spec, c) => removerPasso(spec, c), r.spec),
          }));
          setSelecionado(null);
        }}
        onPaneClick={() => setSelecionado(null)}
        panOnDrag
        selectionOnDrag={false}
        proOptions={{ hideAttribution: true }}
      >
        <Controls showInteractive={false} />
        <Enquadrar quantos={nos.length} />
      </Canvas>
      {erro === null ? null : (
        <p className="bg-card text-sev-critical absolute top-2 left-2 rounded-md border px-2 py-1 text-xs">{erro}</p>
      )}
      {rascunho.gatilhos.length === 0 && rascunho.spec.steps.length === 0 ? (
        <p className="text-muted-foreground pointer-events-none absolute inset-0 flex items-center justify-center text-sm">
          {t("automations.canvas.empty")}
        </p>
      ) : null}
    </div>
  );
}

/** A linha de baixo do nó de lógica: o que ele olha. */
function resumoDaLogica(p: Extract<Rascunho["spec"]["steps"][number], { type: "logic" }>): string {
  if (p.op === "if") return `${p.value} ${p.compare} ${p.against}`.trim();
  if (p.op === "switch") return p.cases.join(" · ");
  return p.value;
}

/** A linha de baixo do nó de ação: para onde ela vai. */
function resumoDaAcao(p: Extract<Rascunho["spec"]["steps"][number], { type: "action" }>): string {
  const prm = (p.params ?? {}) as Record<string, unknown>;
  if (p.action === "mcp.call") return [prm.server, prm.tool].filter((x) => typeof x === "string" && x !== "").join(" · ");
  if (p.action === "http.request") return typeof prm.url === "string" && prm.url !== "" ? `${String(prm.method ?? "POST")} ${prm.url}` : "";
  if (p.action === "teams.react" || p.action === "slack.react") {
    const op = prm.operacao === "unset" ? "unset" : "set";
    const por = prm.porValor as { mapa?: Record<string, string>; padrao?: string } | undefined;
    if (por !== undefined) return `${op} ${[...Object.values(por.mapa ?? {}), por.padrao ?? ""].filter((e) => e !== "").join(" ")}`;
    return `${op} ${typeof prm.emoji === "string" ? prm.emoji : ""}`.trim();
  }
  return p.target ?? "";
}

function NoDoComponente({ data, selected }: NodeProps<NoDoCanvas>) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "bg-card w-[232px] rounded-lg border px-3 py-2 transition-colors",
        selected ? "border-primary" : "border-border",
      )}
      data-locum-no-automacao={data.chave}
    >
      {data.gatilho ? null : <Handle position={Position.Left} type="target" />}
      <div className="flex items-center gap-2">
        <Selo app={data.app} id={data.componente} tamanho="sm" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-muted-foreground truncate text-[11px]">{data.tipo}</span>
          <span className="truncate text-[13px] font-medium">{data.titulo}</span>
        </div>
        {data.problema === null ? null : <StatusDot data-locum-no-problema={data.problema} estado={data.problema === "bloqueia" ? "erro" : "aviso"} />}
      </div>
      {data.subtitulo === "" ? null : <p className="text-muted-foreground mt-1 truncate text-xs">{data.subtitulo}</p>}
      {data.aprovacao || data.automatico || data.gatilho ? (
        <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 text-[11px]">
          {data.aprovacao ? (
            <span className="flex items-center gap-1.5">
              <StatusDot estado="aviso" />
              {t("automations.canvas.approval")}
            </span>
          ) : null}
          {data.automatico ? (
            <span className="flex items-center gap-1.5" data-locum-no-auto="">
              <StatusDot estado="erro" />
              {t("automations.panel.modes.auto")}
            </span>
          ) : null}
          {data.gatilho ? (
            <span className="flex items-center gap-1.5">
              <StatusDot estado={data.desligado ? "ocioso" : "ok"} />
              {t(data.desligado ? "automations.list.off" : "automations.list.on")}
            </span>
          ) : null}
        </div>
      ) : null}
      {data.caminhos.length === 0 ? (
        <Handle position={Position.Right} type="source" />
      ) : (
        <div className="mt-2 flex flex-col items-end gap-1.5">
          {data.caminhos.map((c) => (
            <div className="relative flex items-center pr-1 text-[11px]" key={c.id}>
              <span className="text-muted-foreground">{c.rotulo}</span>
              <Handle className="!-right-3.5" id={c.id} position={Position.Right} type="source" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** "true" e "false" do if viram sim e não; caso do switch aparece como foi escrito. */
function rotuloDoCaminho(t: (k: string) => string, caminho: string): string {
  if (caminho === "true") return t("automations.canvas.branchTrue");
  if (caminho === "false") return t("automations.canvas.branchFalse");
  if (caminho === "default") return t("automations.canvas.branchDefault");
  return caminho;
}

// Const de módulo: o React Flow remonta todo nó quando o mapa muda de identidade.
const TIPOS = { componente: NoDoComponente };

/**
 * Nó acrescentado pela paleta nasce à direita do selecionado, quase sempre
 * fora do quadro: enquadrar de novo quando a contagem muda mostra onde ele foi.
 * Espera o nó novo ser medido, senão o enquadramento o ignora.
 */
function Enquadrar({ quantos }: { quantos: number }) {
  const { fitView } = useReactFlow();
  const medidos = useNodesInitialized();
  const pendente = useRef(false);
  const anterior = useRef(quantos);
  if (anterior.current !== quantos) {
    anterior.current = quantos;
    pendente.current = true;
  }
  useEffect(() => {
    if (!medidos || !pendente.current) return;
    pendente.current = false;
    void fitView({ padding: 0.2, minZoom: 0.25, maxZoom: 1, duration: 250 });
  }, [medidos, quantos, fitView]);
  return null;
}
