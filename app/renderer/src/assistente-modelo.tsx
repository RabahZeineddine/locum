import { Button } from "@/components/ui/button";
import { call, useRead } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface Catalogo {
  provedor: string;
  modelos: string[];
  erro?: string;
}

/**
 * Escolha do modelo do assistente, a partir do catalogo que cada provedor
 * publica.
 *
 * Nao ha lista de modelo no codigo. Um gateway expoe o que a organizacao dele
 * decidiu, entao id escrito aqui envelhece e, pior, quebra tarde: o erro volta
 * falando de credencial quando o problema era o nome do modelo.
 */
export function EscolhaDoModelo({ aoEscolher }: { aoEscolher?: (modelo: string) => void } = {}) {
  const { t } = useTranslation();
  const status = useRead("chat.status");
  const [catalogos, setCatalogos] = useState<Catalogo[] | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [atual, setAtual] = useState<string | null>(null);

  useEffect(() => {
    if (status.status === "ready") setAtual(status.data.modelo);
  }, [status.status, status.status === "ready" ? status.data.modelo : null]);

  const buscar = useCallback(async () => {
    setCarregando(true);
    try {
      // A assinatura do Claude Code conversa também; o Codex não, porque não
      // entrega o texto aos pedaços (ver `escolherModelo` em `electron/chat.ts`).
      const todos = await call("providers.allModels", { assinatura: true });
      setCatalogos(todos.filter((c) => c.provedor !== "codex"));
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void buscar();
  }, [buscar]);

  async function escolher(modelo: string) {
    await call("chat.setModel", modelo);
    setAtual(modelo);
    aoEscolher?.(modelo);
  }

  const semProvedor = catalogos !== null && catalogos.length === 0;

  return (
    <div className="divide-border divide-y">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            {atual ? (
              <span className="font-mono text-xs">{atual}</span>
            ) : (
              <span className="text-muted-foreground">{t("assistant.model.none")}</span>
            )}
          </p>
          {status.status === "ready" && status.data.motivo && (
            <p className="text-muted-foreground mt-0.5 text-xs">{status.data.motivo}</p>
          )}
        </div>
        <Button
          className="h-8 cursor-pointer"
          disabled={carregando}
          onClick={() => void buscar()}
          size="sm"
          variant="ghost"
        >
          {carregando ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="size-3.5" aria-hidden />
          )}
          {t("assistant.model.refresh")}
        </Button>
      </div>

      {semProvedor && (
        <p className="text-muted-foreground px-3 py-3 text-sm">
          {t("assistant.model.noProvider")}
        </p>
      )}

      {(catalogos ?? []).map((catalogo) => (
        <div className="px-3 py-2.5" key={catalogo.provedor}>
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium">{catalogo.provedor}</span>
            <span className="text-muted-foreground text-xs">
              {catalogo.erro ?? t("assistant.model.count", { count: catalogo.modelos.length })}
            </span>
          </div>

          {catalogo.modelos.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {catalogo.modelos.map((modelo) => {
                const id = `${catalogo.provedor}/${modelo}`;
                const escolhido = id === atual;
                return (
                  <button
                    className={cn(
                      "focus-visible:ring-ring cursor-pointer rounded-md border px-2 py-1 font-mono text-xs transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none",
                      escolhido
                        ? "border-primary bg-primary/15 text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30",
                    )}
                    key={id}
                    onClick={() => void escolher(id)}
                    type="button"
                  >
                    {escolhido && <Check className="mr-1 inline size-3" aria-hidden />}
                    {modelo}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
