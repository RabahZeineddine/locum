import type { ReactNode } from "react";

/**
 * O topo de toda tela: título grande, uma frase dizendo para que ela serve e,
 * à direita, o que dá para fazer ali. Uma peça só, para as telas não
 * divergirem de tamanho e espaçamento cada uma do seu jeito.
 */
export function CabecalhoDaTela({
  titulo,
  descricao,
  acoes,
}: {
  titulo: ReactNode;
  descricao?: ReactNode;
  acoes?: ReactNode;
}) {
  return (
    <header className="flex items-end justify-between gap-6 pt-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="font-semibold text-[32px] leading-tight tracking-[-0.02em]">{titulo}</h1>
        {descricao === undefined ? null : <div className="text-muted-foreground max-w-2xl text-[15px]">{descricao}</div>}
      </div>
      {acoes === undefined ? null : <div className="flex shrink-0 items-center gap-2">{acoes}</div>}
    </header>
  );
}
