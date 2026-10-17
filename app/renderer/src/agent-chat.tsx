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
import { useConversa, type Conversa } from "@/lib/use-conversa";
import { cn } from "@/lib/utils";
import { ArrowUp, Bot, Check, RotateCcw, Square, Wrench, X } from "lucide-react";
import { Fragment, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";
import type { Cartao } from "../../src/agent-chat/tipos";

/** Os textos que mudam de uma conversa para outra; já no idioma do app. */
export interface TextosDoPainel {
  titulo: string;
  recomecar: string;
  vazio: { titulo: string; corpo: string };
  placeholder: string;
  /** O campo de uma conversa com cartão à espera. */
  placeholderPendente?: string;
  nota: string;
}

/**
 * O painel de uma conversa: as falas, o aviso de outro processo, o erro e o campo de envio.
 * É o mesmo para o agent e para o run; quem muda é o cabeçalho, os avisos, o cartão e os textos.
 */
export function PainelDeConversa({
  conversa,
  id,
  cabecalho,
  avisos,
  cartao,
  textos,
  semEnvio = false,
  classe,
}: {
  conversa: Conversa;
  id: string;
  cabecalho: ReactNode;
  avisos?: ReactNode;
  /** Como mostrar um cartão de escrita; só o chat do agent tem. */
  cartao?: (cartao: Cartao, decidir: (d: "executar" | "recusar") => void, deOutroProcesso: boolean) => ReactNode;
  textos: TextosDoPainel;
  /** Não há com quem conversar: o campo fica desligado. */
  semEnvio?: boolean;
  classe?: string;
}) {
  const { t } = useTranslation();
  const { falas, respondendo, outro, resumido, carregado, falha, aguardando } = conversa;
  const [rascunho, setRascunho] = useState("");
  const campo = useRef<HTMLTextAreaElement>(null);

  async function enviar(): Promise<void> {
    const texto = rascunho.trim();
    if (texto === "" || respondendo || aguardando || semEnvio) return;
    setRascunho("");
    if (!(await conversa.enviar(texto))) setRascunho(texto);
  }

  return (
    <div className={cn("flex h-[calc(100dvh-16rem)] min-h-[420px] flex-col rounded-lg border border-border bg-card", classe)} data-locum-agent-chat="" data-locum-conversa={id}>
      <div className="flex min-h-10 items-center gap-2 border-b border-border px-3 py-1.5">
        {cabecalho}
        {falas.length > 0 && !respondendo ? (
          <Button className="ml-auto cursor-pointer" data-locum-agent-chat-limpar="" onClick={() => void conversa.recomecar()} size="xs" variant="ghost">
            <RotateCcw aria-hidden />
            {textos.recomecar}
          </Button>
        ) : null}
      </div>

      {avisos}

      <Conversation className="min-h-0 flex-1">
        <ConversationContent className={cn("flex min-h-full flex-col gap-3 p-3", falas.length === 0 && "justify-center")}>
          {falas.length === 0 && carregado ? (
            <ConversationEmptyState>
              <EmptyState className="border-0" descricao={textos.vazio.corpo} icone={<Bot aria-hidden />} titulo={textos.vazio.titulo} />
            </ConversationEmptyState>
          ) : null}
          {resumido ? (
            <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">{t("assistant.summarized")}</p>
          ) : null}
          {falas.map((fala, i) => (
            <Message from={fala.de} key={i}>
              <MessageContent className="gap-1.5 text-[13px] group-[.is-user]:rounded-md group-[.is-user]:px-3 group-[.is-user]:py-2">
                {fala.ferramentas.length > 0 ? (
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" data-locum-agent-chat-ferramentas="">
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
                {cartao === undefined ? null : fala.cartoes.map((c) => <Fragment key={c.id}>{cartao(c, (d) => void conversa.decidir(c, d), outro)}</Fragment>)}
              </MessageContent>
            </Message>
          ))}
        </ConversationContent>
      </Conversation>

      {outro ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground" data-locum-agent-chat-outro="">
          <StatusDot estado="aviso" />
          <span>{t("agentChat.otherProcessNotice")}</span>
          <Button className="ml-auto cursor-pointer" data-locum-agent-chat-tomar="" onClick={() => void conversa.tomar()} size="xs" variant="outline">
            {t("agentChat.take")}
          </Button>
        </div>
      ) : null}
      {falha === null ? null : (
        <p className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-xs text-muted-foreground" data-locum-agent-chat-erro="">
          <StatusDot estado="erro" />
          {falha}
        </p>
      )}
      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2 rounded-lg border border-input bg-background px-3 py-2 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40">
          <textarea
            aria-label={textos.titulo}
            className="max-h-32 min-h-[20px] flex-1 resize-none bg-transparent text-[13px] outline-none placeholder:text-muted-foreground disabled:opacity-50"
            disabled={!carregado || aguardando || semEnvio}
            onChange={(e) => setRascunho(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void enviar();
              }
            }}
            placeholder={aguardando && textos.placeholderPendente !== undefined ? textos.placeholderPendente : textos.placeholder}
            ref={campo}
            rows={1}
            value={rascunho}
          />
          {respondendo ? (
            <Button className="cursor-pointer" data-locum-agent-chat-parar="" onClick={conversa.cancelar} size="icon-sm" variant="ghost">
              <Square aria-hidden />
              <span className="sr-only">{t("assistant.stop")}</span>
            </Button>
          ) : (
            <Button
              className="cursor-pointer"
              data-locum-agent-chat-enviar=""
              disabled={!carregado || aguardando || semEnvio || rascunho.trim() === ""}
              onClick={() => void enviar()}
              size="icon-sm"
              variant={rascunho.trim() === "" ? "ghost" : "default"}
            >
              <ArrowUp aria-hidden />
              <span className="sr-only">{t("assistant.send")}</span>
            </Button>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">{textos.nota}</p>
      </div>
    </div>
  );
}

/** A conversa com um agent da biblioteca, na aba Conversar do editor. */
export function ChatDoAgent({ id, modelo, versao, naoSalvo }: { id: string; modelo: string; versao: number; naoSalvo: boolean }) {
  const { t } = useTranslation();
  const conversa = useConversa(chatDoAgent, id);
  const { semServidor, semSkill, contaIgnorada } = conversa;
  const conexoes = useRead("connections.list");
  // Nome da conexão pelo id dela, e pelo nome de cada servidor que ela tem: o cartão traz o servidor.
  const nomes = new Map((conexoes.data ?? []).map((c) => [c.id, c.name]));
  const nomesPorServidor = new Map((conexoes.data ?? []).flatMap((c) => c.servers.map((s) => [s, c.name] as const)));
  // A marca é a da conexão que tem o servidor, e não a do nome com que ele foi cadastrado.
  const marcasPorServidor = new Map((conexoes.data ?? []).flatMap((c) => c.servers.map((s) => [s, { name: c.id, url: c.url }] as const)));

  return (
    <PainelDeConversa
      avisos={
        semServidor.length === 0 && semSkill.length === 0 && !naoSalvo && contaIgnorada === 0 ? null : (
          <div className="flex flex-col gap-1 border-b border-border px-3 py-2 text-xs text-muted-foreground" data-locum-agent-chat-avisos="">
            {semServidor.map((c) => (
              <p className="flex items-start gap-1.5" key={c.connectionId}>
                <StatusDot className="mt-[5px]" estado="aviso" />
                {t("agentChat.noServer", { connection: nomes.get(c.connectionId) ?? c.connectionId, reason: c.motivo })}
              </p>
            ))}
            {semSkill.map((nome) => (
              <p className="flex items-start gap-1.5" data-locum-agent-chat-sem-skill={nome} key={nome}>
                <StatusDot className="mt-[5px]" estado="aviso" />
                {t("agentChat.noSkill", { name: nome })}
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
        )
      }
      cabecalho={
        <>
          <Bot aria-hidden className="size-4 text-muted-foreground" />
          <span className="text-[13px] font-medium">{t("agentChat.title")}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{modelo}</span>
          <Badge variant="secondary">{t("agentChat.version", { version: versao })}</Badge>
        </>
      }
      cartao={(c, decidir, deOutroProcesso) => (
        <CartaoDeEscrita
          cartao={c}
          decidir={decidir}
          deOutroProcesso={deOutroProcesso}
          marca={marcasPorServidor.get(c.servidor) ?? { name: c.servidor }}
          nomeDaConexao={nomesPorServidor.get(c.servidor)}
        />
      )}
      conversa={conversa}
      id={id}
      textos={{
        titulo: t("agentChat.title"),
        recomecar: t("agentChat.reset"),
        vazio: { titulo: t("agentChat.empty.title"), corpo: t("agentChat.empty.body") },
        placeholder: t("agentChat.placeholder"),
        placeholderPendente: t("agentChat.placeholderPending"),
        nota: t("agentChat.note"),
      }}
    />
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
function CartaoDeEscrita({ cartao, decidir, deOutroProcesso, marca, nomeDaConexao }: { cartao: Cartao; decidir: (d: "executar" | "recusar") => void; deOutroProcesso: boolean; marca: { name: string; url?: string | undefined }; nomeDaConexao: string | undefined }) {
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
      {pendente && deOutroProcesso ? <p className="text-xs text-muted-foreground" data-locum-agent-cartao-outro="">{t("agentChat.card.otherProcessHint")}</p> : null}
      {pendente && !deOutroProcesso ? (
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
