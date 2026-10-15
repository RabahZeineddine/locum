import * as React from "react"
import { cn } from "cn"

type Estado = "ok" | "aviso" | "erro" | "ocioso"

const COR: Record<Estado, string> = {
  ok: "bg-estado-ok",
  aviso: "bg-estado-aviso",
  erro: "bg-estado-erro",
  ocioso: "bg-estado-ocioso",
}

/** O ponto de estado: a cor mora aqui, e o texto ao lado fica neutro. */
function StatusDot({
  estado,
  className,
  ...props
}: React.ComponentProps<"span"> & { estado: Estado }) {
  return (
    <span
      aria-hidden
      data-slot="status-dot"
      data-estado={estado}
      className={cn("inline-block size-1.5 shrink-0 rounded-full", COR[estado], className)}
      {...props}
    />
  )
}

export { StatusDot }
export type { Estado }
