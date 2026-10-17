import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { call, useRead } from "@/lib/bridge";
import { semPrefixoDoIpc } from "@/lib/erro-da-ponte";
import { rotuloDaAcao } from "@/lib/rotulos";
import { cn } from "@/lib/utils";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Campo } from "../automacoes/campos";

/** O mesmo limite técnico do serviço (`LIMITE_DA_INSTRUCAO`); a tela não importa código do processo principal. */
const LIMITE_DA_INSTRUCAO = 2000;

/**
 * O botao de reexecutar.
 *
 * Ele manda `wait: false` porque o pipeline leva minutos: esperar o desfecho
 * deixaria a promessa do IPC pendurada e a tela travada com um botao que nao
 * volta. O servico zera o passo e os que dependem dele antes de soltar o
 * executor, entao o que a tela le depois ja e o estado novo.
 *
 * Passo de modelo abre o dialogo (instrucao opcional e a previa do que vai
 * rodar); os outros reexecutam direto, porque nao ha prompt onde a instrucao entre.
 */
export function Reexecutar({ runId, stepKey, modelo }: { runId: string; stepKey: string; modelo: boolean }) {
  const { t } = useTranslation();
  const [estado, setEstado] = useState<"parado" | "pedindo" | "erro">("parado");
  const [aberto, setAberto] = useState(false);

  return (
    <>
      <Button
        data-locum-rerun={stepKey}
        disabled={estado === "pedindo"}
        onClick={() => {
          if (modelo) {
            setAberto(true);
            return;
          }
          setEstado("pedindo");
          call("runs.rerunStep", runId, stepKey, { wait: false }).then(
            () => globalThis.location.reload(),
            () => setEstado("erro"),
          );
        }}
        size="sm"
        title={estado === "erro" ? t("runs.rerun.refused") : t("runs.rerun.title", { step: stepKey })}
        variant="ghost"
      >
        <RotateCcw className={cn("size-3.5", estado === "erro" && "text-destructive")} />
      </Button>
      {aberto ? <Dialogo aoFechar={() => setAberto(false)} runId={runId} stepKey={stepKey} /> : null}
    </>
  );
}

function Dialogo({ aoFechar, runId, stepKey }: { aoFechar: () => void; runId: string; stepKey: string }) {
  const { t } = useTranslation();
  const [instrucao, setInstrucao] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [recusa, setRecusa] = useState<string | null>(null);
  const comInstrucao = instrucao.trim().length > 0;
  const previa = useRead("runs.rerunPreview", runId, stepKey, { comInstrucao });
  const bloqueios = previa.data?.bloqueios ?? [];

  const reexecutar = (): void => {
    setEnviando(true);
    setRecusa(null);
    call("runs.rerunStep", runId, stepKey, { wait: false, ...(comInstrucao ? { instrucao: instrucao.trim() } : {}) }).then(
      () => globalThis.location.reload(),
      (e: unknown) => {
        setEnviando(false);
        setRecusa(semPrefixoDoIpc(e instanceof Error ? e.message : String(e)));
      },
    );
  };

  return (
    <Dialog onOpenChange={(a) => !a && !enviando && aoFechar()} open>
      <DialogContent data-locum-rerun-dialogo="">
        <DialogHeader>
          <DialogTitle>{t("runs.rerun.dialog.title", { step: stepKey })}</DialogTitle>
          <DialogDescription>{t("runs.rerun.dialog.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
          <Campo rotulo={t("runs.rerun.dialog.instruction")}>
            <Textarea
              data-locum-rerun-instrucao=""
              onChange={(e) => setInstrucao(e.target.value)}
              maxLength={LIMITE_DA_INSTRUCAO}
              placeholder={t("runs.rerun.dialog.placeholder")}
              rows={4}
              value={instrucao}
            />
            <span className="text-muted-foreground text-xs">{t("runs.rerun.dialog.limit", { max: LIMITE_DA_INSTRUCAO })}</span>
          </Campo>

          {previa.data === undefined ? null : (
            <div className="border-border bg-card flex flex-col gap-2 rounded-md border px-3 py-2 text-xs" data-locum-rerun-previa="">
              <span className="text-muted-foreground">{t("runs.rerun.dialog.willRun")}</span>
              <ul className="flex flex-col gap-0.5">
                {previa.data.passos.map((p) => (
                  <li data-locum-rerun-previa-passo={p.stepKey} key={p.stepKey}>
                    {p.name}
                  </li>
                ))}
              </ul>
              {previa.data.cobradosDeNovo.length === 0 ? null : (
                <span className="text-muted-foreground" data-locum-rerun-previa-custo="">
                  {t("runs.rerun.dialog.billed", { cost: previa.data.cobradosDeNovo.reduce((soma, p) => soma + p.custoUsd, 0).toFixed(3) })}
                </span>
              )}
              {previa.data.avulsosQueExpiram.length === 0 ? null : (
                <div className="flex flex-col gap-0.5" data-locum-rerun-previa-expira="">
                  <span className="font-medium">{t("runs.rerun.dialog.expire")}</span>
                  <ul className="flex flex-col gap-0.5">
                    {previa.data.avulsosQueExpiram.map((p) => (
                      <li key={p.stepKey}>{rotuloDaAcao(t, p.name)}</li>
                    ))}
                  </ul>
                </div>
              )}
              {previa.data.rebaixados.length === 0 ? null : (
                <div className="flex flex-col gap-0.5" data-locum-rerun-previa-fila="">
                  <span className="font-medium">{t("runs.rerun.dialog.toQueue")}</span>
                  <ul className="flex flex-col gap-0.5">
                    {previa.data.rebaixados.map((p) => (
                      <li data-locum-rerun-previa-rebaixado={p.stepKey} key={p.stepKey}>
                        {p.name} <span className="text-muted-foreground">({rotuloDaAcao(t, p.action)})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {bloqueios.map((b) => (
            <p className="text-destructive text-xs" data-locum-rerun-bloqueio={b.codigo} key={b.codigo}>
              {t(`runs.rerun.dialog.blocked.${b.codigo}`)}
            </p>
          ))}
          {recusa === null ? null : <p className="text-destructive text-xs" data-locum-rerun-recusa="">{recusa}</p>}
        </div>

        <DialogFooter>
          <Button disabled={enviando} onClick={aoFechar} variant="ghost">{t("runs.rerun.dialog.cancel")}</Button>
          <Button data-locum-rerun-confirmar="" disabled={enviando || bloqueios.length > 0} onClick={reexecutar}>
            {t("runs.rerun.dialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
