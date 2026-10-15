import * as React from "react"
import { cn } from "cn"

/**
 * Linha de lista densa, de 36 a 44px, no lugar do cartão grande. A linha vira
 * botão quando recebe `onClick`; o fio de baixo separa uma da outra.
 */
function ListRow({
  className,
  onClick,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "onClick"> & { onClick?: () => void }) {
  const clicavel = onClick !== undefined
  return (
    <div
      data-slot="list-row"
      className={cn(
        "flex min-h-10 items-center gap-3 border-b border-border px-3 py-1.5 text-[13px] last:border-b-0",
        clicavel && "cursor-pointer outline-none transition-colors hover:bg-accent focus-visible:bg-accent",
        className
      )}
      onClick={onClick}
      onKeyDown={
        clicavel
          ? (evento) => {
              if (evento.target === evento.currentTarget && (evento.key === "Enter" || evento.key === " ")) {
                evento.preventDefault()
                onClick()
              }
            }
          : undefined
      }
      role={clicavel ? "button" : undefined}
      tabIndex={clicavel ? 0 : undefined}
      {...props}
    >
      {children}
    </div>
  )
}

/** Moldura das linhas: borda de 1px e cantos pequenos. */
function ListGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="list-group"
      className={cn("overflow-hidden rounded-lg border border-border bg-card", className)}
      {...props}
    />
  )
}

export { ListRow, ListGroup }
