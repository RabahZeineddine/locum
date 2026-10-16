import { Info } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TipoDeFerramenta } from "@/lib/ferramentas-do-agent";

/** O ⓘ: o texto longo mora na dica, e a linha fica curta. */
export function Dica({ texto }: { texto: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={texto}
          className="inline-flex size-4 shrink-0 cursor-help items-center justify-center text-muted-foreground hover:text-foreground"
          data-locum-dica=""
          role="img"
        >
          <Info aria-hidden className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{texto}</TooltipContent>
    </Tooltip>
  );
}

/** Um bloco de leitura ou de escrita: título, quantas ligadas, e marcar ou desmarcar o grupo todo. */
export function GrupoPorTipo({
  tipo,
  ligadas,
  total,
  marcar,
  desmarcar,
  children,
  ...dados
}: {
  tipo: TipoDeFerramenta;
  ligadas: number;
  total: number;
  marcar: () => void;
  desmarcar: () => void;
  children: ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  const { t } = useTranslation();
  // Ligar a escrita toda de uma vez pede um sim, com a conta do que vai ligar.
  const [confirmando, setConfirmando] = useState(false);
  return (
    <div className="flex flex-col gap-1.5" data-locum-grupo-tipo={tipo} {...dados}>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t(`tools.group.${tipo}`)}</span>
        <span className="num text-[11px] text-muted-foreground">{t("tools.group.count", { on: ligadas, total })}</span>
        <Button className="ml-auto cursor-pointer" data-locum-marcar-todas={tipo} disabled={ligadas === total} onClick={tipo === "escrita" ? () => setConfirmando(true) : marcar} size="xs" variant="ghost">
          {t("tools.group.markAll")}
        </Button>
        <Button className="cursor-pointer" data-locum-desmarcar-todas={tipo} disabled={ligadas === 0} onClick={desmarcar} size="xs" variant="ghost">
          {t("tools.group.unmarkAll")}
        </Button>
      </div>
      {confirmando ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-[13px]" data-locum-marcar-escrita-confirmar="">
          <span>{t("tools.group.confirmWrite", { count: total - ligadas })}</span>
          <Button
            className="cursor-pointer"
            data-locum-marcar-escrita-sim=""
            onClick={() => {
              setConfirmando(false);
              marcar();
            }}
            size="xs"
            variant="outline"
          >
            {t("tools.group.confirmYes")}
          </Button>
          <Button className="cursor-pointer" onClick={() => setConfirmando(false)} size="xs" variant="ghost">
            {t("tools.group.confirmNo")}
          </Button>
        </div>
      ) : null}
      {children}
    </div>
  );
}
