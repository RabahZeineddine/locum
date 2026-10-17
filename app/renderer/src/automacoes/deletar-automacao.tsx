import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusDot } from "@/components/ui/status-dot";
import { call, read, type ReadResult } from "@/lib/bridge";
import { semPrefixoDoIpc } from "@/lib/erro-da-ponte";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

type Previa = ReadResult<"automations.deletePreview">;

/**
 * O diálogo de deletar, aberto pelo menu do editor: mostra tudo o que sai para
 * sempre e o que impede, e só o confirmar apaga. Só a automação arquivada chega
 * aqui; o serviço confere de novo dentro da transação.
 */
export function DialogoDeDeletar({ agentId, nome, aoDeletar, aoFechar }: { agentId: string; nome: string; aoDeletar: () => void; aoFechar: () => void }) {
  const { t } = useTranslation();
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [deletando, setDeletando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const mensagem = (e: unknown): string => semPrefixoDoIpc(e instanceof Error ? e.message : String(e));
  const fechar = (): void => {
    if (!deletando) aoFechar();
  };

  useEffect(() => {
    let vivo = true;
    read("automations.deletePreview", agentId).then(
      (p) => vivo && setPrevia(p),
      (e: unknown) => vivo && setErro(t("automations.editor.delete.previewFailed", { erro: mensagem(e) })),
    );
    return () => {
      vivo = false;
    };
  }, [agentId, t]);

  const deletar = (): void => {
    setDeletando(true);
    setErro(null);
    call("automations.delete", agentId).then(
      () => aoDeletar(),
      (e: unknown) => {
        setDeletando(false);
        setErro(mensagem(e));
      },
    );
  };

  return (
    <Dialog onOpenChange={(aberto) => !aberto && fechar()} open>
      <DialogContent data-locum-automacao-deletar-dialogo="">
        <DialogHeader>
          <DialogTitle>{t("automations.editor.delete.title", { name: nome })}</DialogTitle>
          <DialogDescription>{t("automations.editor.delete.irreversible")}</DialogDescription>
        </DialogHeader>
        {previa === null ? null : (
          <div className="text-muted-foreground flex flex-col gap-1.5 text-xs" data-locum-automacao-deletar-resumo="">
            <p>
              {t("automations.editor.delete.leaves", {
                itens: [
                  t("automations.editor.archive.versions", { count: previa.versions }),
                  t("automations.editor.archive.triggers", { count: previa.triggers }),
                  t("automations.editor.archive.runs", { count: previa.runs }),
                  t("automations.editor.archive.approvals", { count: previa.approvals }),
                  t("automations.editor.archive.findings", { count: previa.findings }),
                ].join(", "),
              })}
            </p>
            <p>{t("automations.editor.delete.stays")}</p>
            <p>{t("automations.editor.delete.dedupe")}</p>
            {previa.initiative === null ? null : <p data-locum-automacao-deletar-iniciativa="">{t("automations.editor.delete.initiative", { title: previa.initiative.title })}</p>}
          </div>
        )}
        {previa !== null && previa.blockers.length > 0 ? (
          <div className="flex flex-col gap-1 text-xs" data-locum-automacao-deletar-bloqueios="">
            <span className="font-medium">{t("automations.editor.delete.blocked")}</span>
            <ul className="text-muted-foreground list-disc pl-5">
              {previa.blockers.map((b) => (
                <li key={b.kind}>{t(b.kind === "active" ? "automations.editor.delete.blocker_active" : `automations.editor.archive.blocker_${b.kind}`, { count: b.count })}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {erro === null ? null : (
          <p className="flex items-center gap-1.5 text-xs" data-locum-automacao-deletar-erro="">
            <StatusDot estado="erro" />
            {erro}
          </p>
        )}
        <DialogFooter>
          <Button className="cursor-pointer" data-locum-automacao-deletar-cancelar="" disabled={deletando} onClick={fechar} size="sm" variant="ghost">
            {t("automations.editor.delete.cancel")}
          </Button>
          <Button
            className="cursor-pointer"
            data-locum-automacao-deletar-confirmar=""
            disabled={deletando || previa === null || previa.blockers.length > 0}
            onClick={deletar}
            size="sm"
            variant="destructive"
          >
            {deletando ? <Loader2 className="animate-spin" /> : null}
            {t("automations.editor.delete.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
