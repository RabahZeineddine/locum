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
import { call, read, useRead, type ReadResult } from "@/lib/bridge";
import { semPrefixoDoIpc } from "@/lib/erro-da-ponte";
import { descartarRascunho, guardarRascunho, lerRascunho, temMudanca, type RascunhoGuardado } from "@/lib/rascunho-automacao";
import { registrarGuarda } from "@/lib/saida-do-editor";
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
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RotaId } from "../rotas";
import { ModalDeAgent } from "./modal-de-agent";
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

  if (lida.status === "loading") {
    return <p className="text-muted-foreground pt-6 text-sm">{t("automations.editor.loading")}</p>;
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
  return <EditorCarregado abrirGatilho={abrirGatilho} automacao={lida.data} navegar={navegar} voltar={voltar} />;
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

function paraRascunho(a: Automacao): Rascunho {
  return { spec: a.version.spec, gatilhos: gatilhosDoCadastro(a.triggers) };
}

function EditorCarregado({
  automacao,
  abrirGatilho,
  voltar,
  navegar,
}: {
  automacao: Automacao;
  abrirGatilho?: string;
  voltar: () => void;
  navegar: (id: RotaId, detalhe?: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const agentId = automacao.version.agentId;
  const [salvo, setSalvo] = useState<Rascunho>(() => paraRascunho(automacao));
  const [rascunho, setRascunho] = useState<Rascunho>(salvo);
  const [versao, setVersao] = useState(automacao.version.version);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [nota, setNota] = useState("");
  const [ocupado, setOcupado] = useState<"salvar" | "rodar" | "ligar" | null>(null);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  // O rascunho de uma edição que não chegou ao Salvar: espera a decisão da pessoa antes de a edição passar a ser guardada por cima.
  const [achado, setAchado] = useState<RascunhoGuardado | null>(() => {
    const guardado = lerRascunho(globalThis.localStorage, automacao.version.agentId);
    return guardado !== null && temMudanca(guardado.rascunho, paraRascunho(automacao)) ? guardado : null;
  });
  // A saída que espera a resposta de "salvar, descartar ou cancelar".
  const [saida, setSaida] = useState<{ prosseguir: () => void } | null>(null);
  // O agent da biblioteca aberto sobre o editor.
  const [modalDeAgent, setModalDeAgent] = useState<{ detalhe: string; aoFechar?: (id: string | null, lista: ReadResult<"library.profiles">) => void } | null>(null);

  const conexoes = useRead("connections.list");
  const trackers = useRead("trackers.list");
  const biblioteca = useRead("library.profiles");
  // Relida depois de o painel transformar um passo em agent da biblioteca:
  // sem isso o agent recém-criado contaria como inexistente e travaria o Salvar.
  const [bibliotecaRelida, setBibliotecaRelida] = useState<ReadResult<"library.profiles"> | null>(null);
  const agentsDaBiblioteca = bibliotecaRelida ?? biblioteca.data ?? [];
  const conectado = (id: string): boolean => (conexoes.data ?? []).some((c) => c.id === id && c.state === "connected");
  const listaDeTrackers = (trackers.data ?? []).filter((tr) => tr.enabled);
  const ctx = {
    slackConectado: conectado("slack"),
    teamsConectado: conectado("teams"),
    trackers: listaDeTrackers.map((tr) => tr.id),
    ...(conexoes.data === undefined ? {} : { githubComToken: (conexoes.data.find((c) => c.id === "github")?.partes?.token ?? "missing") === "ok" }),
    ...(bibliotecaRelida === null && biblioteca.data === undefined ? {} : { agents: agentsDaBiblioteca.map((a) => a.id) }),
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
  const lista = problemas(rascunho, ctx);
  const bloqueado = lista.some((p) => p.bloqueia);
  const ligada = salvo.gatilhos.some((g) => g.enabled);

  const exportar = (): void => {
    setAviso(null);
    call("pacote.exportFile", agentId).then(
      (r) => {
        if (r !== null) setAviso({ tipo: "ok", texto: t("pacote.export.done", { arquivo: r.nomeDoArquivo }) });
      },
      (e: unknown) => setAviso({ tipo: "erro", texto: semPrefixoDoIpc(e instanceof Error ? e.message : String(e)) }),
    );
  };

  const salvar = (): Promise<boolean> => {
    setOcupado("salvar");
    setAviso(null);
    return call("automations.save", {
      spec: rascunho.spec,
      triggers: rascunho.gatilhos.map((g) => ({
        ...(g.id === undefined ? {} : { id: g.id }),
        config: g.config,
        enabled: g.enabled,
        ...(valeParaTodosOsChats(g, salvo.gatilhos) ? { valerParaTodosOsChats: true } : {}),
      })),
      note: nota.trim() || t("automations.editor.noteDefault"),
    }).then(
      (gravada) => {
        const novo = paraRascunho(gravada);
        setSalvo(novo);
        setRascunho(novo);
        setVersao(gravada.version.version);
        setNota("");
        setOcupado(null);
        setAviso({ tipo: "ok", texto: t("automations.editor.saved", { version: gravada.version.version }) });
        return true;
      },
      (e: unknown) => {
        setOcupado(null);
        setAviso({ tipo: "erro", texto: e instanceof Error ? e.message : String(e) });
        return false;
      },
    );
  };

  // Cada mudança vai para o rascunho local. Enquanto há rascunho esperando decisão, não se grava por cima dele.
  useEffect(() => {
    if (achado === null) guardarRascunho(globalThis.localStorage, agentId, rascunho, salvo, versao);
  }, [achado, agentId, rascunho, salvo, versao]);

  // Sair com mudança não salva pede confirmação, por qualquer caminho de navegação.
  const mudouAgora = useRef(mudou);
  mudouAgora.current = mudou;
  useEffect(
    () =>
      registrarGuarda((prosseguir) => {
        if (!mudouAgora.current) return false;
        setSaida({ prosseguir });
        return true;
      }),
    [],
  );

  const abrirAgent = (detalhe: string, aoFechar?: (id: string | null, lista: ReadResult<"library.profiles">) => void): void =>
    setModalDeAgent(aoFechar === undefined ? { detalhe } : { detalhe, aoFechar });
  const fecharAgent = (id: string | null): void => {
    const aoFechar = modalDeAgent?.aoFechar;
    setModalDeAgent(null);
    read("library.profiles").then((lista) => {
      setBibliotecaRelida(lista);
      if (id !== null) aoFechar?.(id, lista);
    }, () => undefined);
  };

  const executar = (): void => {
    if (mudou) {
      setAviso({ tipo: "erro", texto: t("automations.editor.runUnsaved") });
      return;
    }
    setOcupado("rodar");
    // Abre a execução na hora: é lá que se acompanha o que o agent vai fazendo.
    call("automations.runNow", agentId).then(
      ({ runId }) => {
        setOcupado(null);
        navegar("runs", runId);
      },
      (e: unknown) => {
        setOcupado(null);
        setAviso({ tipo: "erro", texto: e instanceof Error ? e.message : String(e) });
      },
    );
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
    setRascunho((r) => {
      const passo = componente.novo(r.spec);
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
        <span className="text-muted-foreground num mr-auto text-xs">{t("automations.editor.version", { version: versao })}</span>
        {mudou ? <Badge variant="outline">{t("automations.editor.unsaved")}</Badge> : null}
        <Button className="cursor-pointer" onClick={() => navegar("automations", `legacy/${agentId}`)} size="sm" variant="ghost">
          <List />
          {t("automations.editor.asList")}
        </Button>
        <Button
          className="cursor-pointer"
          data-locum-automacao-exportar=""
          disabled={ocupado !== null || mudou}
          onClick={exportar}
          size="sm"
          title={mudou ? t("pacote.export.saveFirst") : t("pacote.export.hint")}
          variant="ghost"
        >
          <Download />
          {t("pacote.export.button")}
        </Button>
        <Button className="cursor-pointer" disabled={ocupado !== null} onClick={executar} size="sm" variant="outline">
          {ocupado === "rodar" ? <Loader2 className="animate-spin" /> : <Play />}
          {t("automations.editor.runNow")}
        </Button>
        <Button
          className="cursor-pointer"
          data-locum-automacao-ligar=""
          disabled={ocupado !== null || salvo.gatilhos.length === 0}
          onClick={alternar}
          size="sm"
          title={t("automations.editor.enabledHint")}
          variant="outline"
        >
          <StatusDot estado={ligada ? "ok" : "ocioso"} />
          {t(ligada ? "automations.editor.disable" : "automations.editor.enable")}
        </Button>
      </header>

      {mudou ? (
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
          <Button className="cursor-pointer" data-locum-automacao-salvar="" disabled={bloqueado || ocupado !== null} onClick={salvar} size="sm">
            {t(ocupado === "salvar" ? "automations.editor.saving" : "automations.editor.save")}
          </Button>
        </div>
      ) : null}

      {achado === null ? null : (
        <div className="bg-card border-border flex flex-wrap items-center gap-2 rounded-md border px-3 py-1.5 text-xs" data-locum-rascunho="">
          <StatusDot estado="aviso" />
          <span className="mr-auto">
            {t("automations.editor.draft.found", {
              quando: new Date(achado.salvoEm).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" }),
            })}
          </span>
          <Button
            className="cursor-pointer"
            data-locum-rascunho-descartar=""
            onClick={() => {
              descartarRascunho(globalThis.localStorage, agentId);
              setAchado(null);
            }}
            size="sm"
            variant="ghost"
          >
            {t("automations.editor.draft.discard")}
          </Button>
          <Button
            className="cursor-pointer"
            data-locum-rascunho-continuar=""
            onClick={() => {
              setRascunho(achado.rascunho);
              setAchado(null);
            }}
            size="sm"
          >
            {t("automations.editor.draft.continue")}
          </Button>
        </div>
      )}

      {aviso === null ? null : (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <StatusDot estado={aviso.tipo === "erro" ? "erro" : "ok"} />
          {aviso.texto}
        </p>
      )}

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
                  {t(p.chave)}
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
            abrirAgent={abrirAgent}
            chave={selecionado}
            navegar={navegar}
            relerBiblioteca={() => read("library.profiles").then(setBibliotecaRelida, () => undefined)}
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

      <Dialog onOpenChange={(aberto) => !aberto && setSaida(null)} open={saida !== null}>
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
                descartarRascunho(globalThis.localStorage, agentId);
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
                const seguir = saida?.prosseguir;
                void salvar().then((ok) => {
                  if (!ok) return;
                  setSaida(null);
                  seguir?.();
                });
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

/* ------------------------------------------------------------------ paleta */

function Paleta({
  appsLigados,
  viaDoTeams,
  agents,
  aoGatilho,
  aoPasso,
  aoAgent,
  aoLogica,
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
  criarAgent: () => void;
}) {
  const { t } = useTranslation();
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

  return (
    <aside className="border-border bg-card flex w-60 shrink-0 flex-col gap-2 overflow-y-auto rounded-lg border p-1.5" data-locum-probe="automacao-paleta">
      <p className="text-muted-foreground px-2 pt-1 text-[11px]">{t("automations.palette.hint")}</p>
      <section>
        <h3 className="text-muted-foreground px-1.5 pb-0.5 text-[11px] font-medium">
          {t("automations.palette.triggers")}
        </h3>
        <ul>
          {GATILHOS.map((g) => (
            <Item app={g.app} id={g.id} key={g.id} onClick={() => aoGatilho(g.id)} titulo={t(`automations.triggers.${g.id}.title`)} />
          ))}
        </ul>
      </section>
      <section>
        <h3 className="text-muted-foreground px-1.5 pb-0.5 text-[11px] font-medium">
          {t("automations.palette.agents")}
        </h3>
        <ul>
          {agents.map((a) => (
            <Item app="locum" id="agent" key={a.id} onClick={() => aoAgent(a)} titulo={a.name} />
          ))}
        </ul>
        {agents.length === 0 ? <p className="text-muted-foreground px-2 text-[11px]">{t("automations.palette.agentsEmpty")}</p> : null}
        <button className="text-primary cursor-pointer px-2 pt-1 text-[11px] hover:underline" onClick={criarAgent} type="button">
          {t("automations.palette.newAgent")}
        </button>
      </section>
      <section>
        <h3 className="text-muted-foreground px-1.5 pb-0.5 text-[11px] font-medium">
          {t("automations.palette.steps")}
        </h3>
        <ul>
          {PASSOS.map((p) => (
            <Item app={p.app} id={p.id} key={p.id} onClick={() => aoPasso(p.id)} titulo={tituloDoPasso(t, p.id)} />
          ))}
        </ul>
      </section>
      <section>
        <h3 className="text-muted-foreground px-1.5 pb-0.5 text-[11px] font-medium">
          {t("automations.palette.logic")}
        </h3>
        <ul>
          {LOGICA.map((l) => (
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
