import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** Os campos que o painel do nó e os editores de gatilho dividem. */

export const CAMPO =
  "border-input focus-visible:border-ring focus-visible:ring-ring/40 w-full min-w-0 rounded-md border bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus-visible:ring-2";

/** O ⓘ que guarda a explicação longa: o painel mostra rótulo curto e controle, e o texto vem no passar do mouse ou no foco. */
export function Ajuda({ texto }: { texto: string }) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={t("automations.panel.help")}
          className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer rounded-full align-middle"
          data-locum-ajuda=""
          type="button"
        >
          <Info aria-hidden className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 text-left font-normal" side="left">
        {texto}
      </TooltipContent>
    </Tooltip>
  );
}

/** Rótulo curto com o controle embaixo; a explicação, se houver, fica no ⓘ ao lado do rótulo. */
export function Campo({ rotulo, ajuda, children }: { rotulo: string; ajuda?: string | undefined; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground flex items-center gap-1 text-xs">
        {rotulo}
        {ajuda === undefined ? null : <Ajuda texto={ajuda} />}
      </span>
      {children}
    </div>
  );
}

export function Minutos({ rotulo, valor, trocar }: { rotulo: string; valor: number; trocar: (n: number) => void }) {
  return (
    <Campo rotulo={rotulo}>
      <input
        className={cn(CAMPO, "w-28")}
        data-locum-minutos=""
        min={1}
        onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10);
          if (Number.isFinite(n) && n >= 1) trocar(n);
        }}
        type="number"
        value={valor}
      />
    </Campo>
  );
}

export function Alternador({ ligado, rotulo, trocar }: { ligado: boolean; rotulo: string; trocar: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px]">
      <input checked={ligado} className="accent-primary size-4 cursor-pointer" onChange={(e) => trocar(e.target.checked)} type="checkbox" />
      {rotulo}
    </label>
  );
}
