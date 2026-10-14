import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { rotuloDoModelo, rotuloDoProvedor } from "@/lib/rotulos";
import { Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { modeloInicial, partirModelo, provedoresDisponiveis } from "../../src/config/escolha-de-modelo";
import { useCatalogo } from "./editor-agent";

interface PassoDeModelo {
  indice: number;
  nome: string;
  modelo: string;
}

const SELECT =
  "border-border bg-background focus-visible:ring-ring w-full min-w-0 cursor-pointer truncate rounded-md border px-2 py-1.5 text-sm outline-none focus-visible:ring-1";

const mensagem = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * O botão de instalar de um template do marketplace, igual nas duas telas. O
 * card não muda de altura: template sem passo de modelo instala direto, e com
 * passo o clique abre um diálogo com a escolha de provedor e modelo, só com o
 * que esta máquina tem configurado. `instalar` rejeita quando falha; no
 * diálogo o erro aparece dentro dele, e sem diálogo vai para `aoFalhar`.
 */
export function InstalacaoDeTemplate({
  aoFalhar,
  instalar,
  nome,
  passosDeModelo,
}: {
  aoFalhar: (mensagem: string) => void;
  instalar: (substituicoes: Record<number, string>) => Promise<void>;
  nome: string;
  passosDeModelo: PassoDeModelo[];
}) {
  const { t } = useTranslation();
  const [aberto, setAberto] = useState(false);
  const [instalando, setInstalando] = useState(false);

  const direto = (): void => {
    setInstalando(true);
    instalar({})
      .catch((e: unknown) => aoFalhar(mensagem(e)))
      .finally(() => setInstalando(false));
  };

  return (
    <div className="mt-auto flex items-center gap-2 pt-1">
      <Button
        className="cursor-pointer"
        disabled={instalando}
        onClick={() => (passosDeModelo.length === 0 ? direto() : setAberto(true))}
        size="sm"
      >
        {instalando ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
        {t("agents.marketplace.install")}
      </Button>
      {aberto ? (
        <EscolhaDeInstalacao
          fechar={() => setAberto(false)}
          instalar={instalar}
          nome={nome}
          passosDeModelo={passosDeModelo}
        />
      ) : null}
    </div>
  );
}

function EscolhaDeInstalacao({
  fechar,
  instalar,
  nome,
  passosDeModelo,
}: {
  fechar: () => void;
  instalar: (substituicoes: Record<number, string>) => Promise<void>;
  nome: string;
  passosDeModelo: PassoDeModelo[];
}) {
  const { t } = useTranslation();
  const catalogo = useCatalogo();
  // Só o que a pessoa mexeu; o resto cai no modelo inicial calculado abaixo.
  const [trocas, setTrocas] = useState<Record<number, string>>({});
  const [instalando, setInstalando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const provedores = provedoresDisponiveis(catalogo ?? []);
  const semProvedor = catalogo !== null && provedores.length === 0;
  const escolhaDe = (passo: PassoDeModelo): string =>
    trocas[passo.indice] ?? modeloInicial(passo.modelo, catalogo ?? []) ?? "";

  const confirmar = (): void => {
    setInstalando(true);
    setErro(null);
    instalar(Object.fromEntries(passosDeModelo.map((p) => [p.indice, escolhaDe(p)])))
      .then(fechar)
      .catch((e: unknown) => setErro(mensagem(e)))
      .finally(() => setInstalando(false));
  };

  return (
    <Dialog onOpenChange={(aberto) => (!aberto && !instalando ? fechar() : undefined)} open>
      <DialogContent aria-describedby={undefined} data-locum-probe="agents-marketplace-instalar">
        <DialogHeader>
          <DialogTitle title={nome}>{nome}</DialogTitle>
          <DialogDescription>{t("agents.marketplace.modelHint")}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          {catalogo === null ? (
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Loader2 aria-hidden className="size-3 animate-spin" />
              {t("agents.editor.step.loadingCatalog")}
            </p>
          ) : semProvedor ? (
            <p className="text-sev-medium text-sm">{t("agents.marketplace.noProvider")}</p>
          ) : (
            passosDeModelo.map((passo) => {
              const atual = partirModelo(escolhaDe(passo));
              const modelosDoProvedor = provedores.find((c) => c.provedor === atual.provedor)?.modelos ?? [];
              return (
                <div className="flex min-w-0 flex-col gap-1.5" key={passo.indice}>
                  <span className="truncate font-medium text-sm" title={passo.nome}>
                    {passo.nome}
                  </span>
                  <div className="grid min-w-0 grid-cols-2 gap-2">
                    <select
                      aria-label={`${passo.nome}: ${t("agents.marketplace.provider")}`}
                      className={SELECT}
                      onChange={(e) => {
                        const novo = provedores.find((c) => c.provedor === e.target.value);
                        const primeiro = novo?.modelos[0];
                        if (novo !== undefined && primeiro !== undefined) {
                          setTrocas((a) => ({ ...a, [passo.indice]: `${novo.provedor}/${primeiro}` }));
                        }
                      }}
                      value={atual.provedor}
                    >
                      {provedores.map((c) => (
                        <option key={c.provedor} value={c.provedor}>
                          {rotuloDoProvedor(c.provedor)}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={`${passo.nome}: ${t("agents.marketplace.model")}`}
                      className={SELECT}
                      onChange={(e) =>
                        setTrocas((a) => ({ ...a, [passo.indice]: `${atual.provedor}/${e.target.value}` }))
                      }
                      title={atual.modelo}
                      value={atual.modelo}
                    >
                      {modelosDoProvedor.map((m) => (
                        <option key={m} value={m}>
                          {rotuloDoModelo(m)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })
          )}
        </div>
        {erro === null ? null : <p className="text-destructive break-words text-xs">{erro}</p>}
        <DialogFooter>
          <Button className="cursor-pointer" disabled={instalando} onClick={fechar} size="sm" variant="ghost">
            {t("agents.marketplace.cancel")}
          </Button>
          <Button
            className="cursor-pointer"
            disabled={instalando || catalogo === null || semProvedor}
            onClick={confirmar}
            size="sm"
          >
            {instalando ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            {t("agents.marketplace.installWith")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
