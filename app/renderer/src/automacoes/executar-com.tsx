import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { call, read, type ReadResult } from "@/lib/bridge";
import { semPrefixoDoIpc } from "@/lib/erro-da-ponte";
import { quandoSolta } from "@/lib/limites";
import { rotuloDaFonte, rotuloDoProvedor } from "@/lib/rotulos";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useToasts } from "../toasts";

type Contexto = ReadResult<"automations.eventsForRun">;
type Evento = Contexto["recentes"][number];

interface Opcoes {
  /** O run existe: quem pediu pode abri-lo ou reler a lista. */
  aoIniciar?: (runId: string) => void;
  /** O run chegou ao fim, bem ou mal. */
  aoTerminar?: () => void;
}

interface Pedido extends Opcoes {
  agentId: string;
  nome: string;
  precisaDeEvento: string;
  recentes: Evento[];
}

/**
 * "Executar agora" de uma automação.
 *
 * Quem não depende de evento roda na hora. Quem depende (`{{event.*}}` no
 * prompt, ou resposta numa conversa) abre o diálogo "Executar com", porque
 * sem evento o modelo recebe tudo `null` e a chamada é gasta à toa. O desfecho
 * vai para um aviso que leva ao run, e uma recusa também.
 */
export function useExecutarAgora(): {
  pedir: (agentId: string, nome: string, opcoes?: Opcoes) => Promise<void>;
  pedindo: boolean;
  dialogo: ReactNode;
} {
  const { t, i18n } = useTranslation();
  const toasts = useToasts();
  const [pedindo, setPedindo] = useState(false);
  const [pedido, setPedido] = useState<Pedido | null>(null);

  const iniciar = useCallback(
    async (agentId: string, nome: string, evento: { eventId?: string; prUrl?: string }, opcoes: Opcoes): Promise<void> => {
      const r = await call("automations.runNow", agentId, evento);
      const aviso =
        r.aviso === undefined
          ? undefined
          : t("limits.manualWarning", { provider: rotuloDoProvedor(r.aviso.provedor), time: quandoSolta(r.aviso.ate, i18n.language) });
      toasts.acompanhar({ runId: r.runId, nome, ...(aviso === undefined ? {} : { aviso }), ...(opcoes.aoTerminar === undefined ? {} : { aoTerminar: opcoes.aoTerminar }) });
      opcoes.aoIniciar?.(r.runId);
    },
    [i18n.language, t, toasts],
  );

  const pedir = useCallback(
    async (agentId: string, nome: string, opcoes: Opcoes = {}): Promise<void> => {
      setPedindo(true);
      try {
        const contexto = await read("automations.eventsForRun", agentId);
        if (contexto.precisaDeEvento === null) {
          await iniciar(agentId, nome, {}, opcoes);
          return;
        }
        setPedido({ agentId, nome, precisaDeEvento: contexto.precisaDeEvento, recentes: contexto.recentes, ...opcoes });
      } catch (e) {
        toasts.recusar(semPrefixoDoIpc(e instanceof Error ? e.message : String(e)));
      } finally {
        setPedindo(false);
      }
    },
    [iniciar, toasts],
  );

  const dialogo =
    pedido === null ? null : (
      <ExecutarCom
        aoFechar={() => setPedido(null)}
        aoExecutar={(evento) => iniciar(pedido.agentId, pedido.nome, evento, pedido)}
        pedido={pedido}
      />
    );

  return { pedir, pedindo, dialogo };
}

function ExecutarCom({
  pedido,
  aoExecutar,
  aoFechar,
}: {
  pedido: Pedido;
  aoExecutar: (evento: { eventId?: string; prUrl?: string }) => Promise<void>;
  aoFechar: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [escolhido, setEscolhido] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [iniciando, setIniciando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const evento = link.trim() !== "" ? { prUrl: link.trim() } : escolhido !== null ? { eventId: escolhido } : null;

  const executar = (): void => {
    if (evento === null) return;
    setIniciando(true);
    setErro(null);
    aoExecutar(evento).then(aoFechar, (e: unknown) => {
      setIniciando(false);
      setErro(semPrefixoDoIpc(e instanceof Error ? e.message : String(e)));
    });
  };

  return (
    <Dialog onOpenChange={(aberto) => (aberto ? undefined : aoFechar())} open>
      <DialogContent data-locum-executar-com={pedido.agentId}>
        <DialogHeader>
          <DialogTitle>{t("automations.runWith.title")}</DialogTitle>
          <DialogDescription>{t("automations.runWith.lead", { reason: pedido.precisaDeEvento })}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          <section className="flex flex-col gap-1.5">
            <h3 className="text-muted-foreground text-xs font-medium">{t("automations.runWith.recent")}</h3>
            {pedido.recentes.length === 0 ? (
              <p className="text-muted-foreground text-[13px]" data-locum-sem-eventos="">
                {t("automations.runWith.empty")}
              </p>
            ) : (
              <ul className="border-border flex max-h-64 flex-col overflow-y-auto rounded-md border" role="radiogroup">
                {pedido.recentes.map((e) => (
                  <li key={e.id}>
                    <button
                      aria-checked={escolhido === e.id && link.trim() === ""}
                      className={cn(
                        "hover:bg-accent border-border flex w-full cursor-pointer flex-col gap-0.5 border-b px-3 py-2 text-left text-[13px] last:border-b-0",
                        escolhido === e.id && link.trim() === "" && "bg-accent",
                      )}
                      data-locum-evento={e.id}
                      onClick={() => {
                        setEscolhido(e.id);
                        setLink("");
                      }}
                      role="radio"
                      type="button"
                    >
                      <span className="text-muted-foreground flex items-center gap-2 text-xs">
                        <span className="font-medium">{rotuloDaFonte(t, e.source)}</span>
                        <span>{e.author ?? t("automations.runWith.noAuthor")}</span>
                        <span className="num ml-auto">{new Date(e.at * 1000).toLocaleString(i18n.language, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                      </span>
                      <span className="line-clamp-2 break-words">{e.trecho}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-1.5">
            <h3 className="text-muted-foreground text-xs font-medium">{t("automations.runWith.link")}</h3>
            <Input
              data-locum-executar-link=""
              onChange={(e) => setLink(e.target.value)}
              placeholder={t("automations.runWith.linkPlaceholder")}
              value={link}
            />
            <p className="text-muted-foreground text-xs">{t("automations.runWith.linkHelp")}</p>
          </section>

          {erro === null ? null : (
            <p className="text-destructive text-xs" data-locum-executar-erro="">
              {erro}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button className="cursor-pointer" disabled={iniciando} onClick={aoFechar} size="sm" variant="ghost">
            {t("automations.runWith.cancel")}
          </Button>
          <Button className="cursor-pointer" data-locum-executar-ir="" disabled={evento === null || iniciando} onClick={executar} size="sm">
            {iniciando ? <Loader2 className="animate-spin" /> : null}
            {iniciando ? t("automations.runWith.starting") : t("automations.runWith.run")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
