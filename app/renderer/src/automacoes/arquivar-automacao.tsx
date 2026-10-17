import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusDot } from "@/components/ui/status-dot";
import { call, read, type ReadResult } from "@/lib/bridge";
import { semPrefixoDoIpc } from "@/lib/erro-da-ponte";
import { Loader2, Archive } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

type Previa = ReadResult<"automations.archivePreview">;

/**
 * A zona de perigo no fim do editor: arquivar a automação. O clique pergunta ao
 * serviço o que sai, o que fica e o que impede, e só o confirmar arquiva.
 * `aoArquivar` deixa o editor limpar o que guardou no navegador antes de sair da tela.
 */
export function ArquivarAutomacao({
  agentId,
  nome,
  aoArquivar,
  desabilitado,
  edicaoNaoSalva,
}: {
  agentId: string;
  nome: string;
  aoArquivar: () => void;
  desabilitado: boolean;
  edicaoNaoSalva: boolean;
}) {
  const { t } = useTranslation();
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [consultando, setConsultando] = useState(false);
  const [arquivando, setArquivando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const mensagem = (e: unknown): string => semPrefixoDoIpc(e instanceof Error ? e.message : String(e));
  const fechar = (): void => {
    if (arquivando) return;
    setPrevia(null);
    setErro(null);
  };

  const abrir = (): void => {
    setConsultando(true);
    setErro(null);
    read("automations.archivePreview", agentId).then(
      (p) => {
        setConsultando(false);
        setPrevia(p);
      },
      (e: unknown) => {
        setConsultando(false);
        setErro(t("automations.editor.archive.previewFailed", { erro: mensagem(e) }));
      },
    );
  };

  const arquivar = (): void => {
    setArquivando(true);
    setErro(null);
    call("automations.archive", agentId).then(
      () => aoArquivar(),
      (e: unknown) => {
        setArquivando(false);
        setErro(mensagem(e));
      },
    );
  };

  return (
    <>
      <div className="border-destructive/40 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2" data-locum-automacao-zona-de-perigo="">
        <span className="text-destructive text-xs font-medium">{t("automations.editor.archive.zone")}</span>
        <span className="text-muted-foreground mr-auto text-xs">{t("automations.editor.archive.hint")}</span>
        {previa === null && erro !== null ? (
          <span className="text-xs" data-locum-automacao-arquivar-erro="">
            <StatusDot estado="erro" /> {erro}
          </span>
        ) : null}
        <Button
          className="cursor-pointer"
          data-locum-automacao-arquivar=""
          disabled={desabilitado || consultando}
          onClick={abrir}
          size="sm"
          variant="ghost"
        >
          {consultando ? <Loader2 className="animate-spin" /> : <Archive aria-hidden />}
          {t("automations.editor.archive.button")}
        </Button>
      </div>

      <Dialog onOpenChange={(aberto) => !aberto && fechar()} open={previa !== null}>
        <DialogContent data-locum-automacao-arquivar-dialogo="">
          <DialogHeader>
            <DialogTitle>{t("automations.editor.archive.title", { name: nome })}</DialogTitle>
            <DialogDescription>{t("automations.editor.archive.restore")}</DialogDescription>
          </DialogHeader>
          {previa === null ? null : (
            <div className="text-muted-foreground flex flex-col gap-1.5 text-xs" data-locum-automacao-arquivar-resumo="">
              <p>{t("automations.editor.archive.leaves", { triggers: t("automations.editor.archive.triggers", { count: previa.triggers }) })}</p>
              <p>
                {t("automations.editor.archive.stays", {
                  itens: [
                    t("automations.editor.archive.runs", { count: previa.runs }),
                    t("automations.editor.archive.approvals", { count: previa.approvals }),
                    t("automations.editor.archive.findings", { count: previa.findings }),
                    t("automations.editor.archive.versions", { count: previa.versions }),
                  ].join(", "),
                })}
              </p>
              <p>{t("automations.editor.archive.dedupe")}</p>
              {previa.initiative === null ? null : <p data-locum-automacao-arquivar-iniciativa="">{t("automations.editor.archive.initiative", { title: previa.initiative.title })}</p>}
              {edicaoNaoSalva ? <p className="text-foreground" data-locum-automacao-arquivar-nao-salva="">{t("automations.editor.archive.unsaved")}</p> : null}
            </div>
          )}
          {previa !== null && previa.blockers.length > 0 ? (
            <div className="flex flex-col gap-1 text-xs" data-locum-automacao-arquivar-bloqueios="">
              <span className="font-medium">{t("automations.editor.archive.blocked")}</span>
              <ul className="text-muted-foreground list-disc pl-5">
                {previa.blockers.map((b) => (
                  <li key={b.kind}>{t(`automations.editor.archive.blocker_${b.kind}`, { count: b.count })}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {erro === null ? null : (
            <p className="flex items-center gap-1.5 text-xs" data-locum-automacao-arquivar-erro="">
              <StatusDot estado="erro" />
              {erro}
            </p>
          )}
          <DialogFooter>
            <Button className="cursor-pointer" data-locum-automacao-arquivar-cancelar="" disabled={arquivando} onClick={fechar} size="sm" variant="ghost">
              {t("automations.editor.archive.cancel")}
            </Button>
            <Button
              className="cursor-pointer"
              data-locum-automacao-arquivar-confirmar=""
              disabled={arquivando || previa === null || previa.blockers.length > 0}
              onClick={arquivar}
              size="sm"
              variant="destructive"
            >
              {arquivando ? <Loader2 className="animate-spin" /> : null}
              {t("automations.editor.archive.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
