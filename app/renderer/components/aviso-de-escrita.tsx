import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

/**
 * O aviso de escrita ligada: um ponto de aviso e texto neutro. É segurança,
 * então fica sempre visível, mas sem cor no texto nem selo gritando. Com
 * `texto`, a frase é a do chamador (a nota longa da lista de ferramentas).
 */
export function AvisoDeEscrita({ count, texto, className }: { count?: number; texto?: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={cn("inline-flex items-start gap-1.5 text-xs text-muted-foreground", className)} data-locum-aviso-de-escrita="">
      <StatusDot className="mt-[5px]" estado="aviso" />
      {texto ?? t("library.card.writes", { count: count ?? 0 })}
    </span>
  );
}
