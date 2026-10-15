import { marcaDoServidor, type FonteDaMarca } from "@/lib/marca";
import { cn } from "@/lib/utils";
import { MessageSquare, Users } from "lucide-react";
import { MARCAS } from "../src/marcas";

const GLIFOS = { slack: MessageSquare, teams: Users } as const;

const TAMANHOS = {
  sm: { caixa: "size-6 rounded", icone: "size-3.5", letra: "text-[11px]" },
  md: { caixa: "size-9 rounded-md", icone: "size-[18px]", letra: "text-sm" },
  lg: { caixa: "size-10 rounded-lg", icone: "size-5", letra: "text-base" },
} as const;

/**
 * O ícone de uma conexão ou servidor: a logo da marca quando o pacote tem, o
 * glifo com a cor da marca quando não tem, e a inicial com cor estável quando
 * a marca é desconhecida. O mesmo em Conexões, Agents e no cartão de aprovação.
 */
export function MarcaLogo({ fonte, tamanho = "md", className }: { fonte: FonteDaMarca; tamanho?: keyof typeof TAMANHOS; className?: string }) {
  const marca = marcaDoServidor(fonte);
  const logo = marca.chave === null ? undefined : MARCAS[marca.chave];
  const t = TAMANHOS[tamanho];
  const Glifo = marca.glifo === null ? undefined : GLIFOS[marca.glifo];
  return (
    <span
      aria-hidden
      className={cn("flex shrink-0 items-center justify-center font-semibold text-white ring-1 ring-white/10", t.caixa, className)}
      data-locum-marca={marca.chave ?? marca.glifo ?? "inicial"}
      style={{ backgroundColor: `#${marca.cor}` }}
    >
      {logo !== undefined ? (
        <svg className={cn("fill-white", t.icone)} viewBox="0 0 24 24">
          <path d={logo.path} />
        </svg>
      ) : Glifo !== undefined ? (
        <Glifo className={t.icone} />
      ) : (
        <span className={t.letra}>{marca.inicial}</span>
      )}
    </span>
  );
}
