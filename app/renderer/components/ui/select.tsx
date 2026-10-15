import * as React from "react"
import { cn } from "cn"

/** O `<select>` nativo com a mesma cara do `Input`: o menu do sistema continua cuidando de teclado e acessibilidade. */
function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "h-8 min-w-0 cursor-pointer rounded-md border border-input bg-transparent px-2 text-[13px] text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 [&>option]:bg-popover [&>optgroup]:bg-popover",
        className
      )}
      {...props}
    />
  )
}

export { Select }
