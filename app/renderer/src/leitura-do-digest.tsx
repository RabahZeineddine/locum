import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { ORDEM, partirResumo, type Classe, type Digest } from "../lib/digest";

/**
 * O digest desenhado para ler de relance: uma linha por assunto, com o valor
 * na frente e o porquê recolhido. A mesma leitura serve para a saída do passo
 * em Execuções e para a pendência na Fila, que guardam formatos diferentes do
 * mesmo conteúdo (ver `DigestReading` e `DigestProposal` em
 * `src/digest/proposal.ts`).
 */

export { lerDigest } from "../lib/digest";

const COR: Record<Classe, string> = {
  needs_reply: "bg-amber-500",
  info: "bg-emerald-500",
  ignore: "bg-muted-foreground/40",
};

export function LeituraDoDigest({ digest }: { digest: Digest }) {
  const { t } = useTranslation();
  const canais = [...new Set(digest.items.map((i) => i.channel))];
  const contagem = (k: Classe) => digest.items.filter((i) => i.kind === k).length;

  return (
    <div className="flex flex-col gap-4" data-locum-digest="">
      <div className="flex flex-col gap-2">
        <p className="text-sm leading-relaxed">{digest.headline}</p>
        <div className="text-muted-foreground flex flex-wrap gap-3 text-xs">
          {ORDEM.filter((k) => contagem(k) > 0).map((k) => (
            <span className="flex items-center gap-1.5" key={k}>
              <span aria-hidden className={cn("size-2 rounded-full", COR[k])} />
              {t(`digest.kind.${k}`)}: {contagem(k)}
            </span>
          ))}
        </div>
      </div>

      {canais.map((canal) => (
        <section className="flex flex-col" key={canal}>
          <h3 className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">{canal}</h3>
          <ul className="divide-border border-border divide-y rounded-md border">
            {digest.items
              .filter((i) => i.channel === canal)
              .sort((a, b) => ORDEM.indexOf(a.kind) - ORDEM.indexOf(b.kind))
              .map((i, n) => {
                const { valor, detalhe } = partirResumo(i.summary);
                return (
                  // A posição é a identidade: o digest não muda depois de gravado.
                  <li className="px-3 py-2" key={n}>
                    <div className="flex items-start gap-2">
                      <span
                        aria-label={t(`digest.kind.${i.kind}`)}
                        className={cn("mt-1.5 size-2 shrink-0 rounded-full", COR[i.kind])}
                        role="img"
                      />
                      <span className="w-44 shrink-0 text-sm font-medium">{i.subject}</span>
                      <span className="min-w-0 flex-1 text-sm">{valor}</span>
                    </div>
                    {detalhe !== "" && (
                      <details className="mt-1 pl-[12.5rem]">
                        <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
                          {t("digest.detail")}
                        </summary>
                        <p className="text-muted-foreground mt-1 text-xs leading-relaxed whitespace-pre-wrap">
                          {detalhe}
                        </p>
                      </details>
                    )}
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </div>
  );
}
