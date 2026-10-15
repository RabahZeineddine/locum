import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { call } from "@/lib/bridge";
import { useAtualizacao } from "@/lib/atualizacao";
import { rodapeDaAtualizacao, versaoParaOModal } from "../../src/update/rodape.js";

/**
 * A atualização no rodapé da barra lateral, debaixo da versão, e o modal que
 * abre quando a versão fica baixada.
 *
 * A regra de o que mostrar mora em `src/update/rodape.ts`; aqui só se desenha.
 * "Depois" grava a versão dispensada no processo principal: nesta sessão do app
 * o modal não reabre para ela, nem com a janela fechada e reaberta, e o link do
 * rodapé limpa a dispensa e reabre.
 */
export function AtualizacaoNoRodape() {
  const { t } = useTranslation();
  const [estado] = useAtualizacao();
  const [aplicando, setAplicando] = useState(false);

  if (estado === undefined) return null;
  const rodape = rodapeDaAtualizacao(estado);
  const doModal = versaoParaOModal(estado);

  // O estado volta empurrado pelo main, então a janela não guarda a dispensa.
  const dispensar = (versao: string | null): void => void call("updates.dismiss", versao).catch(() => undefined);

  const reiniciar = (): void => {
    setAplicando(true);
    call("updates.apply").then(
      (ok) => (ok ? undefined : setAplicando(false)),
      () => setAplicando(false),
    );
  };

  return (
    <div data-locum-probe="atualizacao-rodape" data-locum-rodape={rodape.tipo}>
      {rodape.tipo === "procurando" || rodape.tipo === "baixando" ? (
        <div className="flex flex-col gap-1 px-3 text-[11px] text-muted-foreground/70">
          <div
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={rodape.tipo === "baixando" ? (rodape.percent ?? undefined) : undefined}
            className="bg-muted relative h-[3px] w-full overflow-hidden rounded-full"
            data-locum-barra={rodape.tipo === "baixando" && rodape.percent !== null ? "determinada" : "indeterminada"}
            data-locum-percent={rodape.tipo === "baixando" ? (rodape.percent ?? "") : ""}
            role="progressbar"
          >
            {rodape.tipo === "baixando" && rodape.percent !== null ? (
              <div className="bg-primary h-full rounded-full transition-[width]" style={{ width: `${rodape.percent}%` }} />
            ) : (
              <div className="bg-primary absolute inset-y-0 w-1/3 animate-pulse rounded-full" />
            )}
          </div>
          <span data-locum-rodape-texto>
            {rodape.tipo === "procurando"
              ? t("update.footer.checking")
              : rodape.percent === null
                ? t("update.footer.downloadingUnknown", { version: rodape.version })
                : t("update.footer.downloading", { version: rodape.version, percent: rodape.percent })}
          </span>
        </div>
      ) : null}
      {rodape.tipo === "pronta" ? (
        <button
          className="text-primary px-3 text-left text-[11px] hover:underline"
          data-locum-rodape-pronta={rodape.version}
          onClick={() => dispensar(null)}
          type="button"
        >
          {t("update.footer.ready", { version: rodape.version })}
        </button>
      ) : null}

      <Dialog onOpenChange={(aberto) => (aberto || aplicando ? undefined : dispensar(doModal))} open={doModal !== null}>
        <DialogContent aria-describedby={undefined} data-locum-probe="atualizacao-modal" data-locum-modal-versao={doModal ?? ""}>
          <DialogHeader>
            <DialogTitle>{t("update.modal.title", { version: doModal ?? "" })}</DialogTitle>
          </DialogHeader>
          <div
            className="border-border min-h-0 max-h-72 overflow-y-auto rounded-md border px-3 py-2 text-sm"
            data-locum-modal-notas
          >
            {(estado.available?.notes ?? "").trim() === "" ? (
              <p className="text-muted-foreground">{t("update.modal.noNotes")}</p>
            ) : (
              <Streamdown>{estado.available?.notes ?? ""}</Streamdown>
            )}
          </div>
          <DialogFooter>
            <Button data-locum-modal-depois disabled={aplicando} onClick={() => dispensar(doModal)} variant="ghost">
              {t("update.modal.later")}
            </Button>
            <Button data-locum-modal-reiniciar disabled={aplicando} onClick={reiniciar}>
              {t("update.modal.restart")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
