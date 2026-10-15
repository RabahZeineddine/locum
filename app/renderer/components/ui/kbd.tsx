import * as React from "react"
import { cn } from "cn"

/** Atalho de teclado, pequeno e neutro. Uma tecla por peça. */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "num inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border bg-muted px-1 font-sans text-[11px] font-medium text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Kbd }
