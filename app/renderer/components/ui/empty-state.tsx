import * as React from "react"
import { cn } from "cn"

/** Estado vazio: ícone discreto, uma frase e, se houver, a ação. */
function EmptyState({
  icone,
  titulo,
  descricao,
  acao,
  className,
}: {
  icone?: React.ReactNode
  titulo: React.ReactNode
  descricao?: React.ReactNode
  acao?: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn("flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-8 text-center", className)}
    >
      {icone === undefined ? null : <div className="text-muted-foreground [&_svg]:size-5">{icone}</div>}
      <p className="text-[13px] font-medium">{titulo}</p>
      {descricao === undefined ? null : <p className="max-w-sm text-xs text-muted-foreground">{descricao}</p>}
      {acao === undefined ? null : <div className="mt-1">{acao}</div>}
    </div>
  )
}

export { EmptyState }
