import { Conversation, ConversationContent, ConversationEmptyState } from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { MarcaLogo } from "@/components/marca-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot, type Estado } from "@/components/ui/status-dot";
import { useRead } from "@/lib/bridge";
import { chatDoAgent } from "@/lib/agent-chat";
import { argumentosLegiveis } from "@/lib/argumentos-legiveis";
import { cn } from "@/lib/utils";
import { ArrowUp, Bot, Check, RotateCcw, Square, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";
import {
  aplicarEvento,
  chaveDoAgent,
  type Cartao,
  type ConexaoSemServidor,
  type EventoDaConversa,
  type FalaDoAgent,
} from "../../src/agent-chat/tipos";

/**
 * A conversa com um agent da biblioteca, na aba Conversar do editor.
 *
 * O estado mora no processo principal: a tela pede o retrato ao montar e depois
 * só escuta o fluxo, descartando o que o retrato já contém. Trocar de tela no
 * meio de uma resposta, ou com um cartão à espera, volta onde estava.
 */
export function ChatDoAgent({ id, modelo, versao, naoSalvo }: { id: string; modelo: string; versao: number; naoSalvo: boolean }) {
  const { t } = useTranslation();
  const [falas, setFalas] = useState<FalaDoAgent[]>([]);
  const [respondendo, setRespondendo] = useState(false);
  const [resumido, setResumido] = useState(false);
  const [semServidor, setSemServidor] = useState<ConexaoSemServidor[]>([]);
  const [contaIgnorada, setContaIgnorada] = useState(0);
  const [carregado, setCarregado] = useState(false);
  const [rascunho, setRascunho] = useState("");
  const [falha, setFalha] = useState<string | null>(null);
  const conexoes = useRead("connections.list");
  const campo = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let vivo = true;
    let seq: number | null = null;
    const guardados: EventoDaConversa[] = [];
    const aplicar = (evento: EventoDaConversa): void => {
      if (evento.tipo === "resumido") setResumido(true);
      if (evento.tipo === "fim") setRespondendo(false);
      setFalas((atual) => {
        const ultima = atual.at(-1);
        if (ultima?.de !== "assistant") return atual;
        return [...atual.slice(0, -1), aplicarEvento(ultima, evento)];
      });
    };
    setCarregado(false);
    setFalas([]);
    setFalha(null);
    const parar = chatDoAgent.assinar((evento) => {
      if (evento.chave !== chaveDoAgent(id)) return;
      // Antes do retrato chegar, guarda; depois, só vale o que veio depois dele.
      if (seq === null) guardados.push(evento);
      else if (evento.seq > seq) aplicar(evento);
    });
    chatDoAgent.estado(id).then(
      (estado) => {
        if (!vivo) return;
        seq = estado.seq;
        setFalas(estado.falas);
        setRespondendo(estado.respondendo);
        setResumido(estado.resumido);
        setSemServidor(estado.semServidor);
        setContaIgnorada(estado.contaIgnorada);
        setCarregado(true);
        for (const evento of guardados) if (evento.seq > estado.seq) aplicar(evento);
      },
      (erro: unknown) => {
        if (vivo) setFalha(erro instanceof Error ? erro.message : String(erro));
      },
    );
    return () => {
      vivo = false;
      parar();
    };
  }, [id]);

  const aguardando = falas.some((f) => f.cartoes.some((c) => c.estado === "pendente"));

  // O servidor MCP (outro processo) grava na mesma conversa: ao voltar para a janela, relê o que ele deixou.
  useEffect(() => {
    const recarregar = (): void => {
      if (respondendo || aguardando) return;
      chatDoAgent.estado(id).then(
        (estado) => {
          setFalas(estado.falas);
          setRespondendo(estado.respondendo);
        },
        () => undefined,
      );
    };
    window.addEventListener("focus", recarregar);
    return () => window.removeEventListener("focus", recarregar);
  }, [id, respondendo, aguardando]);
  // Nome da conexão pelo id dela, e pelo nome de cada servidor que ela tem: o cartão traz o servidor.
  const nomes = new Map((conexoes.data ?? []).map((c) => [c.id, c.name]));
  const nomesPorServidor = new Map((conexoes.data ?? []).flatMap((c) => c.servers.map((s) => [s, c.name] as const)));
  // A marca é a da conexão que tem o servidor, e não a do nome com que ele foi cadastrado.
  const marcasPorServidor = new Map((conexoes.data ?? []).flatMap((c) => c.servers.map((s) => [s, { name: c.id, url: c.url }] as const)));

  async function enviar(): Promise<void> {
    const texto = rascunho.trim();
    if (texto === "" || respondendo || aguardando) return;
    setRascunho("");
    setRespondendo(true);
    setFalha(null);
    setFalas((a) => [...a, { de: "user", texto, ferramentas: [], cartoes: [] }, { de: "assistant", texto: "", ferramentas: [], cartoes: [] }]);
    try {
      await chatDoAgent.enviar(id, texto);
    } catch (erro) {
      setRespondendo(false);
      setFalha(erro instanceof Error ? erro.message : String(erro));
    }
  }

  async function decidir(cartao: Cartao, decisao: "executar" | "recusar"): Promise<void> {
    setFalha(null);
    try {
      await chatDoAgent.decidir(id, cartao.id, decisao);
    } catch (erro) {
      setFalha(erro instanceof Error ? erro.message : String(erro));
    }
  }

  async function recomecar(): Promise<void> {
    await chatDoAgent.limpar(id);
    setFalas([]);
    setResumido(false);
    setRespondendo(false);
  }

  return (
    <div className="flex h-[calc(100dvh-16rem)] min-h-[420px] flex-col rounded-lg border border-border bg-card" data-locum-agent-chat="">
      <div className="flex min-h-10 items-center gap-2 border-b border-border px-3 py-1.5">
        <Bot aria-hidden className="size-4 text-muted-foreground" />
        <span className="text-[13px] font-medium">{t("agentChat.title")}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">{modelo}</span>
        <Badge variant="secondary">{t("agentChat.version", { version: versao })}</Badge>
        {falas.length > 0 && !respondendo ? (
          <Button className="ml-auto cursor-pointer" data-locum-agent-chat-limpar="" onClick={() => void recomecar()} size="xs" variant="ghost">
            <RotateCcw aria-hidden />
            {t("agentChat.reset")}
          </Button>
        ) : null}
      </div>

      {semServidor.length === 0 && !naoSalvo && contaIgnorada === 0 ? null : (
        <div className="flex flex-col gap-1 border-b border-border px-3 py-2 text-xs text-muted-foreground" data-locum-agent-chat-avisos="">
          {semServidor.map((c) => (
            <p className="flex items-start gap-1.5" key={c.connectionId}>
              <StatusDot className="mt-[5px]" estado="aviso" />
              {t("agentChat.noServer", { connection: nomes.get(c.connectionId) ?? c.connectionId, reason: c.motivo })}
            </p>
          ))}
          {contaIgnorada === 0 ? null : (
            <p className="flex items-start gap-1.5" data-locum-agent-chat-conta="">
              <StatusDot className="mt-[5px]" estado="aviso" />
              {t("agentChat.accountIgnored", { count: contaIgnorada })}
            </p>
          )}
          {naoSalvo ? <p>{t("agentChat.unsaved")}</p> : null}
        </div>
      )}

      <Conversation className="min-h-0 flex-1">
        <ConversationContent className={cn("flex min-h-full flex-col gap-3 p-3", falas.length === 0 && "justify-center")}>
          {falas.length === 0 && carregado ? (
            <ConversationEmptyState>
              <EmptyState className="border-0" descricao={t("agentChat.empty.body")} icone={<Bot aria-hidden />} titulo={t("agentChat.empty.title")} />
            </ConversationEmptyState>
          ) : null}
          {resumido ? (
            <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">{t("assistant.summarized")}</p>
          ) : null}
          {falas.map((fala, i) => (
            <Message from={fala.de} key={i}>
              <MessageContent className="gap-1.5 text-[13px] group-[.is-user]:rounded-md group-[.is-user]:px-3 group-[.is-user]:py-2">
                {fala.ferramentas.length > 0 ? (
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <Wrench aria-hidden className="size-3" />
                    <span className="font-mono">{fala.ferramentas.map(nomeCurto).join(", ")}</span>
                  </p>
                ) : null}
                {fala.de === "assistant" ? (
                  <div className="text-[13px] [&_pre]:text-xs" data-locum-agent-chat-resposta="">
                    <Streamdown>{fala.texto}</Streamdown>
                    {respondendo && i === falas.length - 1 && fala.cartoes.every((c) => c.estado !== "pendente") ? (
                      <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-foreground/70 align-middle" />
                    ) : null}
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap text-[13px]">{fala.texto}</p>
                )}
                {fala.cartoes.map((cartao) => (
                  <CartaoDeEscrita
                    cartao={cartao}
                    decidir={(d) => void decidir(cartao, d)}
                    key={cartao.id}
                    marca={marcasPorServidor.get(cartao.servidor) ?? { name: cartao.servidor }}
                    nomeDaConexao={nomesPorServidor.get(cartao.servidor)}
                  />
                ))}
              </MessageContent>
            </Message>
          ))}
        </ConversationContent>
      </Conversation>

      {falha === null ? null : (
        <p className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-xs text-muted-foreground" data-locum-agent-chat-erro="">
          <StatusDot estado="erro" />
          {falha}
        </p>
      )}
      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2 rounded-lg border border-input bg-background px-3 py-2 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40">
          <textarea
            aria-label={t("agentChat.title")}
            className="max-h-32 min-h-[20px] flex-1 resize-none bg-transparent text-[13px] outline-none placeholder:text-muted-foreground disabled:opacity-50"
            disabled={!carregado || aguardando}
            onChange={(e) => setRascunho(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void enviar();
              }
            }}
            placeholder={t(aguardando ? "agentChat.placeholderPending" : "agentChat.placeholder")}
            ref={campo}
            rows={1}
            value={rascunho}
          />
          {respondendo ? (
            <Button className="cursor-pointer" data-locum-agent-chat-parar="" onClick={() => void chatDoAgent.cancelar(id)} size="icon-sm" variant="ghost">
              <Square aria-hidden />
              <span className="sr-only">{t("assistant.stop")}</span>
            </Button>
          ) : (
            <Button
              className="cursor-pointer"
              data-locum-agent-chat-enviar=""
              disabled={!carregado || aguardando || rascunho.trim() === ""}
              onClick={() => void enviar()}
              size="icon-sm"
              variant={rascunho.trim() === "" ? "ghost" : "default"}
            >
              <ArrowUp aria-hidden />
              <span className="sr-only">{t("assistant.send")}</span>
            </Button>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">{t("agentChat.note")}</p>
      </div>
    </div>
  );
}

const PONTO_DO_CARTAO: Record<Cartao["estado"], Estado> = {
  pendente: "aviso",
  executando: "aviso",
  executado: "ok",
  falhou: "erro",
  recusado: "ocioso",
  expirado: "ocioso",
  incerto: "aviso",
};

/** A chamada de escrita que o agent quer fazer, à espera do clique de quem conversa. */
function CartaoDeEscrita({ cartao, decidir, marca, nomeDaConexao }: { cartao: Cartao; decidir: (d: "executar" | "recusar") => void; marca: { name: string; url?: string | undefined }; nomeDaConexao: string | undefined }) {
  const { t } = useTranslation();
  const pendente = cartao.estado === "pendente";
  // O vazio também é efeito da ação (apagar o responsável, mandar corpo em branco): aparece escrito.
  const argumentos = argumentosLegiveis(cartao.argumentos, { rotulos: { nulo: t("agentChat.card.argNull"), vazio: t("agentChat.card.argEmpty") } });
  return (
    <div
      className={cn("flex w-full min-w-72 flex-col gap-2.5 rounded-lg border bg-background p-3", pendente ? "border-primary/50" : "border-border")}
      data-estado={cartao.estado}
      data-locum-agent-cartao={cartao.ferramenta}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusDot estado={PONTO_DO_CARTAO[cartao.estado]} />
        <span className="text-[13px] font-medium" data-locum-agent-cartao-titulo="">
          {t(`agentChat.card.title.${cartao.estado}`)}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <MarcaLogo fonte={marca} tamanho="sm" />
          <span className="font-mono text-xs">{cartao.ferramenta}</span>
          <span className="text-[11px] text-muted-foreground">{nomeDaConexao ?? cartao.servidor}</span>
        </span>
      </div>
      {argumentos.length === 0 ? null : (
        <dl
          className="grid max-h-48 grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 gap-y-1 overflow-auto rounded-md bg-card px-2.5 py-2 text-xs"
          data-locum-agent-cartao-argumentos=""
        >
          {argumentos.map((a, i) => (
            <div className="contents" key={`${a.chave}-${i}`}>
              <dt className="text-muted-foreground">{a.chave}</dt>
              <dd className="break-words whitespace-pre-wrap">{a.valor}</dd>
            </div>
          ))}
        </dl>
      )}
      {cartao.estado === "expirado" ? <p className="text-xs text-muted-foreground">{t("agentChat.card.expiredHint")}</p> : null}
      {cartao.estado === "incerto" ? <p className="text-xs text-muted-foreground">{t("agentChat.card.uncertainHint")}</p> : null}
      {cartao.resultado === undefined ? null : <ResultadoDaFerramenta texto={cartao.resultado} />}
      {pendente ? (
        <div className="flex gap-2">
          <Button className="cursor-pointer" data-locum-agent-cartao-executar="" onClick={() => decidir("executar")} size="sm">
            <Check aria-hidden />
            {t("agentChat.card.run")}
          </Button>
          <Button className="cursor-pointer" data-locum-agent-cartao-recusar="" onClick={() => decidir("recusar")} size="sm" variant="outline">
            <X aria-hidden />
            {t("agentChat.card.refuse")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** O que a ferramenta devolveu: texto corrido quando é JSON (sem chaves nem aspas), texto puro no resto, e recolhido quando é longo. */
function ResultadoDaFerramenta({ texto }: { texto: string }) {
  const { t } = useTranslation();
  let linhas: ReturnType<typeof argumentosLegiveis> | null = null;
  try {
    const lido: unknown = JSON.parse(texto);
    // Resultado que fica vazio depois de tirar o ruído ({}, [], {"ok":null}) volta ao texto cru.
    if (lido !== null && typeof lido === "object") linhas = argumentosLegiveis(lido, { omitirVazios: true });
    if (linhas?.length === 0) linhas = null;
  } catch {
    linhas = null;
  }
  return (
    <details className="text-xs" data-locum-agent-cartao-resultado="" open={texto.length <= 240}>
      <summary className="cursor-pointer text-muted-foreground select-none">{t("agentChat.card.result")}</summary>
      {linhas === null ? (
        <p className="mt-1 max-h-48 overflow-auto break-words whitespace-pre-wrap">{texto}</p>
      ) : (
        <dl className="mt-1 grid max-h-48 grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 gap-y-1 overflow-auto rounded-md bg-card px-2.5 py-2">
          {linhas.map((a, i) => (
            <div className="contents" key={`${a.chave}-${i}`}>
              <dt className="text-muted-foreground">{a.chave}</dt>
              <dd className="break-words whitespace-pre-wrap">{a.valor}</dd>
            </div>
          ))}
        </dl>
      )}
    </details>
  );
}

/** `mcp__claude_ai_Microsoft_365__teams_list_chats` e `servidor__teams_list_chats` viram `teams_list_chats`. */
function nomeCurto(nome: string): string {
  // `servidor__ferramenta` e `mcp__servidor__ferramenta` viram só a ferramenta.
  return nome.replace(/^mcp__.+?__/, "").replace(/^.+?__/, "");
}
