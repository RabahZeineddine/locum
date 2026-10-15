import * as React from "react"
import { cn } from "cn"

/**
 * Linha de lista densa, de 36 a 44px, no lugar do cartão grande. Com `onClick`
 * a linha inteira é clicável por um botão posicionado por baixo (`rotulo` dá o
 * nome dele ao leitor de tela); botões e links dentro da linha continuam
 * independentes, e o botão da linha mostra o anel de foco.
 */
function ListRow({
  className,
  onClick,
  rotulo,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "onClick"> & { onClick?: () => void; rotulo?: string }) {
  const clicavel = onClick !== undefined
  return (
    <div
      data-slot="list-row"
      className={cn(
        "relative border-b border-border text-[13px] last:border-b-0",
        clicavel && "transition-colors hover:bg-accent"
      )}
      onClick={onClick}
      {...props}
    >
      {clicavel ? (
        <button
          aria-label={rotulo}
          className="absolute inset-0 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          tabIndex={0}
          type="button"
        />
      ) : null}
      <div
        className={cn(
          "flex min-h-10 items-center gap-3 px-3 py-1.5",
          clicavel && "pointer-events-none relative [&_a]:pointer-events-auto [&_button]:pointer-events-auto",
          className
        )}
      >
        {children}
      </div>
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
