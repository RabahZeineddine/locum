import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/** Os campos que o painel do nó e os editores de gatilho dividem. */

export const CAMPO =
  "border-border bg-background focus-visible:ring-ring w-full min-w-0 rounded-md border px-2.5 py-1.5 text-sm outline-none focus-visible:ring-1";

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
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input checked={ligado} className="accent-primary size-4 cursor-pointer" onChange={(e) => trocar(e.target.checked)} type="checkbox" />
      {rotulo}
    </label>
  );
}
