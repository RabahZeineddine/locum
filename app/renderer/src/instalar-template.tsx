import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { rotuloDoModelo, rotuloDoProvedor } from "@/lib/rotulos";
import { call } from "@/lib/bridge";
import { Download, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ESCOLHA_VAZIA,
  montarSubstituicoes,
  provedoresDisponiveis,
  trocarProvedor,
  type CatalogoDeModelos,
  type Escolha,
} from "../../src/config/escolha-de-modelo";

interface PassoDeModelo {
  indice: number;
  nome: string;
}

const SELECT =
  "border-border bg-background focus-visible:ring-ring w-full min-w-0 cursor-pointer truncate rounded-md border px-2 py-1.5 text-sm outline-none focus-visible:ring-1";

const mensagem = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * O botão de instalar de um template do marketplace, igual nas duas telas. O
 * card não muda de altura: template sem passo de modelo instala direto, e com
 * passo o clique abre um diálogo com a escolha de provedor e modelo, só com o
 * que esta máquina tem configurado. Nada vem pré-selecionado, nem o modelo do
 * template. `instalar` rejeita quando falha; no
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

/** O catálogo desta máquina; `falhou` distingue "não consegui ler" de "nenhum provedor". */
function useCatalogoDaMaquina(): { catalogo: CatalogoDeModelos | null; falhou: string | null } {
  const [estado, setEstado] = useState<{ catalogo: CatalogoDeModelos | null; falhou: string | null }>({
    catalogo: null,
    falhou: null,
  });
  useEffect(() => {
    let vivo = true;
    call("providers.allModels", { assinatura: true })
      .then((catalogo) => vivo && setEstado({ catalogo, falhou: null }))
      .catch((e: unknown) => vivo && setEstado({ catalogo: [], falhou: mensagem(e) }));
    return () => {
      vivo = false;
    };
  }, []);
  return estado;
}

function SelecaoDeModelo({
  catalogo,
  escolha,
  escolher,
  rotulo,
}: {
  catalogo: CatalogoDeModelos;
  escolha: Escolha;
  escolher: (escolha: Escolha) => void;
  rotulo?: string;
}) {
  const { t } = useTranslation();
  const provedores = provedoresDisponiveis(catalogo);
  const modelos = provedores.find((c) => c.provedor === escolha.provedor)?.modelos ?? [];
  const prefixo = rotulo === undefined ? "" : `${rotulo}: `;
  return (
    <div className="grid min-w-0 grid-cols-2 gap-2">
      <select
        aria-label={`${prefixo}${t("agents.marketplace.provider")}`}
        className={SELECT}
        onChange={(e) => escolher(trocarProvedor(escolha, e.target.value))}
        value={escolha.provedor}
      >
        <option disabled value="">
          {t("agents.marketplace.chooseProvider")}
        </option>
        {provedores.map((c) => (
          <option key={c.provedor} value={c.provedor}>
            {rotuloDoProvedor(c.provedor)}
          </option>
        ))}
      </select>
      <select
        aria-label={`${prefixo}${t("agents.marketplace.model")}`}
        className={SELECT}
        disabled={escolha.provedor === ""}
        onChange={(e) => escolher({ ...escolha, modelo: e.target.value })}
        title={escolha.modelo}
        value={escolha.modelo}
      >
        <option disabled value="">
          {t("agents.marketplace.chooseModel")}
        </option>
        {modelos.map((m) => (
          <option key={m} value={m}>
            {rotuloDoModelo(m)}
          </option>
        ))}
      </select>
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
  const { catalogo, falhou } = useCatalogoDaMaquina();
  const [geral, setGeral] = useState<Escolha>(ESCOLHA_VAZIA);
  // `null` é a escolha única; ao abrir "por passo", cada passo nasce com a geral.
  const [porPasso, setPorPasso] = useState<Record<number, Escolha> | null>(null);
  const [instalando, setInstalando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const provedores = provedoresDisponiveis(catalogo ?? []);
  const comErro = (catalogo ?? []).filter((c) => c.erro !== undefined);
  const semProvedor = catalogo !== null && provedores.length === 0;
  const substituicoes =
    catalogo === null
      ? null
      : montarSubstituicoes(
          passosDeModelo.map((p) => p.indice),
          geral,
          porPasso,
          catalogo,
        );

  const confirmar = (): void => {
    if (substituicoes === null) return;
    setInstalando(true);
    setErro(null);
    instalar(substituicoes)
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
          ) : null}
          {falhou !== null ? (
            <p className="text-sev-medium break-words text-sm">{t("agents.marketplace.catalogFailed", { message: falhou })}</p>
          ) : null}
          {comErro.map((c) => (
            <p className="text-sev-medium break-words text-xs" key={c.provedor}>
              {t("agents.marketplace.providerFailed", { provider: rotuloDoProvedor(c.provedor), message: c.erro })}
            </p>
          ))}
          {semProvedor && falhou === null && comErro.length === 0 ? (
            <p className="text-sev-medium text-sm">{t("agents.marketplace.noProvider")}</p>
          ) : null}
          {catalogo !== null && !semProvedor ? (
            porPasso === null ? (
              <>
                <SelecaoDeModelo catalogo={catalogo} escolha={geral} escolher={setGeral} />
                {passosDeModelo.length > 1 ? (
                  <button
                    className="text-primary w-fit cursor-pointer text-xs hover:underline"
                    onClick={() => setPorPasso(Object.fromEntries(passosDeModelo.map((p) => [p.indice, geral])))}
                    type="button"
                  >
                    {t("agents.marketplace.perStep")}
                  </button>
                ) : null}
              </>
            ) : (
              <>
                {passosDeModelo.map((passo) => (
                  <div className="flex min-w-0 flex-col gap-1.5" key={passo.indice}>
                    <span className="truncate font-medium text-sm" title={passo.nome}>
                      {passo.nome}
                    </span>
                    <SelecaoDeModelo
                      catalogo={catalogo}
                      escolha={porPasso[passo.indice] ?? ESCOLHA_VAZIA}
                      escolher={(nova) => setPorPasso((atual) => ({ ...atual, [passo.indice]: nova }))}
                      rotulo={passo.nome}
                    />
                  </div>
                ))}
                <button
                  className="text-primary w-fit cursor-pointer text-xs hover:underline"
                  onClick={() => setPorPasso(null)}
                  type="button"
                >
                  {t("agents.marketplace.sameForAll")}
                </button>
              </>
            )
          ) : null}
        </div>
        {erro === null ? null : <p className="text-destructive break-words text-xs">{erro}</p>}
        <DialogFooter>
          <Button className="cursor-pointer" disabled={instalando} onClick={fechar} size="sm" variant="ghost">
            {t("agents.marketplace.cancel")}
          </Button>
          <Button className="cursor-pointer" disabled={instalando || substituicoes === null} onClick={confirmar} size="sm">
            {instalando ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            {t("agents.marketplace.installWith")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
