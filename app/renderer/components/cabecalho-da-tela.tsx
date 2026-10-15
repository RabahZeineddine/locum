import type { ReactNode } from "react";

/**
 * O topo de toda tela: título contido, uma frase dizendo para que ela serve e,
 * à direita, o que dá para fazer ali. Uma peça só, compacta (título de 22px), para as telas não
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
    <header className="flex items-end justify-between gap-6 pt-2 pb-1">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h1 className="font-semibold text-[22px] leading-7 tracking-[-0.015em]">{titulo}</h1>
        {descricao === undefined ? null : <div className="text-muted-foreground max-w-2xl text-[13px]">{descricao}</div>}
      </div>
      {acoes === undefined ? null : <div className="flex shrink-0 items-center gap-2">{acoes}</div>}
    </header>
  );
}
