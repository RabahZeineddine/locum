import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { call } from "@/lib/bridge";
import { useAtualizacao } from "@/lib/atualizacao";
import type { UpdaterState } from "../../src/update/state.js";
import { cliqueNaVersao, rodapeDaAtualizacao, versaoParaOModal, type RodapeDaAtualizacao } from "../../src/update/rodape.js";

/** A barra de procurando fica visível ao menos isto, para não piscar quando a conferência é rápida. */
const PROCURANDO_MINIMO_MS = 1_200;
/** Quanto tempo o "atualizado" fica ao lado da versão. */
const ATUALIZADO_MS = 4_000;

/**
 * O que o rodapé mostra de fato: o `rodape` do estado, com a barra de
 * procurando segurada pelo mínimo e o "atualizado" tirado depois de uns
 * segundos. A espera mora aqui e não no estado: o processo principal segue
 * dizendo a verdade, e baixando e pronta passam direto.
 *
 * `pedir` cobre o clique: mostra a barra já, antes de o empurrão do main chegar,
 * e solta quando a chamada volta.
 */
function useRodapeSegurado(
  rodape: RodapeDaAtualizacao | null,
  conferidaEm: number | null,
): [RodapeDaAtualizacao | null, (chamada: Promise<unknown>) => void] {
  const [mostrado, setMostrado] = useState<RodapeDaAtualizacao | null>(null);
  const [rodada, setRodada] = useState(0);
  const procurandoDesde = useRef<number | null>(null);
  const chave = JSON.stringify([rodape, conferidaEm, rodada]);

  useEffect(() => {
    if (rodape === null) return;
    const agora = Date.now();
    if (rodape.tipo === "procurando") {
      procurandoDesde.current ??= agora;
      setMostrado(rodape);
      return;
    }
    const segura = rodape.tipo === "versao" || rodape.tipo === "atualizado" || rodape.tipo === "falhou";
    const espera =
      segura && procurandoDesde.current !== null
        ? Math.max(0, PROCURANDO_MINIMO_MS - (agora - procurandoDesde.current))
        : 0;
    procurandoDesde.current = null;

    const relogios: ReturnType<typeof setTimeout>[] = [];
    const mostrar = (): void => {
      setMostrado(rodape);
      if (rodape.tipo === "atualizado") relogios.push(setTimeout(() => setMostrado({ tipo: "versao" }), ATUALIZADO_MS));
    };
    if (espera > 0) relogios.push(setTimeout(mostrar, espera));
    else mostrar();
    return () => relogios.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `chave` é o conteúdo de `rodape`
  }, [chave]);

  const pedir = (chamada: Promise<unknown>): void => {
    procurandoDesde.current ??= Date.now();
    setMostrado({ tipo: "procurando" });
    const soltar = (): void => setRodada((r) => r + 1);
    chamada.then(soltar, soltar);
  };

  return [mostrado ?? rodape, pedir];
}

/**
 * A atualização no rodapé da barra lateral, a versão e a atualização debaixo dela, e o modal que
 * abre quando a versão fica baixada.
 *
 * A regra de o que mostrar mora em `src/update/rodape.ts`; aqui só se desenha.
 * "Depois" grava a versão dispensada no processo principal: nesta sessão do app
 * o modal não reabre para ela, nem com a janela fechada e reaberta, e o link do
 * rodapé limpa a dispensa e reabre.
 */
export function AtualizacaoNoRodape({ versao, aoConfigurar }: { versao: string; aoConfigurar: () => void }) {
  const { t } = useTranslation();
  const [estado, gravar] = useAtualizacao();
  const [aplicando, setAplicando] = useState(false);
  const [rodapeDoEstado, pedir] = useRodapeSegurado(
    estado === undefined ? null : rodapeDaAtualizacao(estado),
    estado?.lastCheckAt ?? null,
  );

  const versaoDesenhada = (
    <button
      className="num px-3 text-left text-[11px] text-muted-foreground hover:text-muted-foreground"
      data-locum-probe="versao"
      onClick={() => clicarNaVersao(estado)}
      title={tituloDaVersao(estado)}
      type="button"
    >
      {t("nav.version", { version: versao })}
      {rodapeDoEstado?.tipo === "atualizado" || rodapeDoEstado?.tipo === "falhou" ? (
        <span data-locum-rodape-estado={rodapeDoEstado.tipo}>
          {" · "}
          {rodapeDoEstado.tipo === "atualizado" ? t("update.footer.upToDate") : t("update.footer.failed")}
        </span>
      ) : null}
    </button>
  );

  if (estado === undefined || rodapeDoEstado === null) return versaoDesenhada;
  const rodape = rodapeDoEstado;
  const doModal = versaoParaOModal(estado);

  // O estado volta empurrado pelo main, então a janela não guarda a dispensa.
  const dispensar = (versao: string | null): void => void call("updates.dismiss", versao).catch(() => undefined);

  function clicarNaVersao(atual: UpdaterState | undefined): void {
    if (atual === undefined) return;
    const clique = cliqueNaVersao(atual);
    if (clique.acao === "configuracao") return aoConfigurar();
    // A falha fica no estado do main, e a tela mostra de lá.
    pedir(call("updates.check").then(gravar));
  }

  function tituloDaVersao(atual: UpdaterState | undefined): string {
    if (atual === undefined) return t("nav.versionHint");
    const clique = cliqueNaVersao(atual);
    if (clique.acao === "conferir") {
      return atual.phase === "failed" && atual.error !== null ? t("update.footer.failedHint", { error: atual.error }) : t("update.footer.checkNow");
    }
    if (clique.motivo === "disabled") return t("update.footer.hintDisabled");
    return clique.motivo === "dev" ? t("update.footer.hintDev") : t("update.footer.hintNotReplaceable");
  }

  const reiniciar = (): void => {
    setAplicando(true);
    call("updates.apply").then(
      (ok) => (ok ? undefined : setAplicando(false)),
      () => setAplicando(false),
    );
  };

  return (
    <div className="flex flex-col gap-1" data-locum-probe="atualizacao-rodape" data-locum-rodape={rodape.tipo}>
      {versaoDesenhada}
      {rodape.tipo === "procurando" || rodape.tipo === "baixando" ? (
        <div className="flex flex-col gap-1 px-3 text-[11px] text-muted-foreground">
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
