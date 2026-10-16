import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusDot } from "@/components/ui/status-dot";
import { call, read, type ReadResult } from "@/lib/bridge";
import { semPrefixoDoIpc } from "@/lib/erro-da-ponte";
import { Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

type Previa = ReadResult<"automations.removePreview">;

/**
 * A zona de perigo no fim do editor: excluir a automação com gatilhos e
 * histórico. O clique pergunta ao serviço o que sairia e o que impede, e só o
 * confirmar apaga. `aoExcluir` recebe o retorno do serviço, para o editor
 * limpar o que guardou no navegador antes de sair da tela.
 */
export function ExcluirAutomacao({
  agentId,
  nome,
  aoExcluir,
  desabilitado,
}: {
  agentId: string;
  nome: string;
  aoExcluir: (r: { triggers: number; runs: number }) => void;
  desabilitado: boolean;
}) {
  const { t } = useTranslation();
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [consultando, setConsultando] = useState(false);
  const [excluindo, setExcluindo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const mensagem = (e: unknown): string => semPrefixoDoIpc(e instanceof Error ? e.message : String(e));
  const fechar = (): void => {
    if (excluindo) return;
    setPrevia(null);
    setErro(null);
  };

  const abrir = (): void => {
    setConsultando(true);
    setErro(null);
    read("automations.removePreview", agentId).then(
      (p) => {
        setConsultando(false);
        setPrevia(p);
      },
      (e: unknown) => {
        setConsultando(false);
        setErro(t("automations.editor.remove.previewFailed", { erro: mensagem(e) }));
      },
    );
  };

  const excluir = (): void => {
    setExcluindo(true);
    setErro(null);
    call("automations.remove", agentId).then(
      (r) => aoExcluir({ triggers: r.triggers, runs: r.runs }),
      (e: unknown) => {
        setExcluindo(false);
        setErro(mensagem(e));
      },
    );
  };

  return (
    <>
      <div className="border-destructive/40 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2" data-locum-automacao-zona-de-perigo="">
        <span className="text-destructive text-xs font-medium">{t("automations.editor.remove.zone")}</span>
        <span className="text-muted-foreground mr-auto text-xs">{t("automations.editor.remove.hint")}</span>
        {previa === null && erro !== null ? (
          <span className="text-xs" data-locum-automacao-excluir-erro="">
            <StatusDot estado="erro" /> {erro}
          </span>
        ) : null}
        <Button
          className="cursor-pointer"
          data-locum-automacao-excluir=""
          disabled={desabilitado || consultando}
          onClick={abrir}
          size="sm"
          variant="ghost"
        >
          {consultando ? <Loader2 className="animate-spin" /> : <Trash2 aria-hidden />}
          {t("automations.editor.remove.button")}
        </Button>
      </div>

      <Dialog onOpenChange={(aberto) => !aberto && fechar()} open={previa !== null}>
        <DialogContent data-locum-automacao-excluir-dialogo="">
          <DialogHeader>
            <DialogTitle>{t("automations.editor.remove.title", { name: nome })}</DialogTitle>
            <DialogDescription>
              {previa === null
                ? ""
                : t("automations.editor.remove.counts", {
                    triggers: t("automations.editor.remove.triggers", { count: previa.triggers }),
                    runs: t("automations.editor.remove.runs", { count: previa.runs }),
                  })}{" "}
              {t("automations.editor.remove.irreversible")}
            </DialogDescription>
          </DialogHeader>
          <p className="text-muted-foreground text-xs">{t("automations.editor.remove.dedupe")}</p>
          {previa !== null && previa.blockers.length > 0 ? (
            <div className="flex flex-col gap-1 text-xs" data-locum-automacao-excluir-bloqueios="">
              <span className="font-medium">{t("automations.editor.remove.blocked")}</span>
              <ul className="text-muted-foreground list-disc pl-5">
                {previa.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {erro === null ? null : (
            <p className="flex items-center gap-1.5 text-xs" data-locum-automacao-excluir-erro="">
              <StatusDot estado="erro" />
              {erro}
            </p>
          )}
          <DialogFooter>
            <Button className="cursor-pointer" data-locum-automacao-excluir-cancelar="" disabled={excluindo} onClick={fechar} size="sm" variant="ghost">
              {t("automations.editor.remove.cancel")}
            </Button>
            <Button
              className="cursor-pointer"
              data-locum-automacao-excluir-confirmar=""
              disabled={excluindo || previa === null || previa.blockers.length > 0}
              onClick={excluir}
              size="sm"
              variant="destructive"
            >
              {excluindo ? <Loader2 className="animate-spin" /> : null}
              {t("automations.editor.remove.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
