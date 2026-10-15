import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/** Os campos que o painel do nó e os editores de gatilho dividem. */

export const CAMPO =
  "border-input focus-visible:border-ring focus-visible:ring-ring/40 w-full min-w-0 rounded-md border bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus-visible:ring-2";

export function Campo({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs">{rotulo}</span>
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
