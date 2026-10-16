import { ListGroup } from "@/components/ui/list-row";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Info } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";

/**
 * Peças das Preferências: um bloco com título pequeno e, dentro, uma linha por
 * ajuste, rótulo à esquerda e controle à direita, como no macOS e no Linear.
 * Texto que não cabe em uma linha vira dica (tooltip), não parágrafo.
 */
export function BlocoDeAjustes({
  children,
  descricao,
  titulo,
}: {
  children: React.ReactNode;
  descricao?: string;
  titulo?: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      {titulo === undefined ? null : (
        <h3 className="text-muted-foreground px-1 text-[11px] font-medium tracking-wide uppercase">{titulo}</h3>
      )}
      {descricao === undefined ? null : <p className="text-muted-foreground -mt-1 px-1 text-xs">{descricao}</p>}
      <ListGroup>{children}</ListGroup>
    </section>
  );
}

export function LinhaDeAjuste({
  abaixo,
  children,
  descricao,
  dica,
  titulo,
  ...resto
}: {
  /** O que ocupa a largura toda sob a linha: um comando para colar, um aviso. */
  abaixo?: React.ReactNode;
  children?: React.ReactNode;
  /** Uma linha curta e muted embaixo do rótulo. */
  descricao?: React.ReactNode;
  /** O texto longo, no tooltip do ícone ao lado do rótulo. */
  dica?: string;
  titulo: string;
} & Omit<React.ComponentProps<"div">, "title" | "children">) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div
      aria-labelledby={id}
      className="border-border border-b text-[13px] last:border-b-0"
      role="group"
      {...resto}
    >
      <div className="flex min-h-11 items-center gap-x-6 px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 font-medium">
            <span id={id}>{titulo}</span>
            {dica === undefined ? null : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label={t("settings.hint")}
                    className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm focus-visible:ring-2 focus-visible:outline-none"
                    type="button"
                  >
                    <Info aria-hidden className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-72" side="right">
                  {dica}
                </TooltipContent>
              </Tooltip>
            )}
          </span>
          {descricao === undefined || descricao === null || descricao === false ? null : (
            <span
              className="text-muted-foreground truncate text-xs"
              title={typeof descricao === "string" ? descricao : undefined}
            >
              {descricao}
            </span>
          )}
        </div>
        {children === undefined ? null : (
          <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">{children}</div>
        )}
      </div>
      {abaixo === undefined ? null : <div className="px-3 pb-2.5">{abaixo}</div>}
    </div>
  );
}

/** O interruptor liga/desliga. Um botão com `role=switch`, para o teclado e o leitor de tela. */
export function Interruptor({
  ativo,
  desabilitado,
  mudar,
  rotulo,
  ...resto
}: {
  ativo: boolean;
  desabilitado?: boolean;
  mudar: (ativo: boolean) => void;
  rotulo: string;
} & Omit<React.ComponentProps<"button">, "onChange" | "role" | "aria-checked" | "aria-label" | "disabled">) {
  return (
    <button
      aria-checked={ativo}
      aria-label={rotulo}
      className={cn(
        "focus-visible:ring-ring relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
        ativo ? "bg-primary" : "bg-muted border-border",
      )}
      disabled={desabilitado}
      onClick={() => mudar(!ativo)}
      role="switch"
      type="button"
      {...resto}
    >
      <span
        className={cn(
          "bg-foreground block size-3.5 rounded-full transition-transform",
          ativo ? "translate-x-[18px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}
