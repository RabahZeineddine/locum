import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { call, read, useRead, type ReadResult } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import { MessageSquare, Plug, Plus, Search, Users, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { MARCAS } from "../marcas";

type Conexao = ReadResult<"connections.list">[number];
type Categoria = Conexao["category"];

const CATEGORIAS: readonly Categoria[] = ["dev", "work", "communication", "observability", "data"];

/** Ícone genérico para marca que não está em `MARCAS`. */
const GENERICOS: Record<string, typeof Plug> = {
  slack: MessageSquare,
  teams: Users,
};

/**
 * A vitrine de conexões: um cartão por serviço, com o estado e o botão que liga.
 *
 * Servidor que aceita OAuth com registro automático liga no próprio cartão, e
 * o navegador abre na tela de autorização do serviço. O que pede formulário
 * (GitHub, Jira, Slack) abre o painel lateral com o formulário de sempre, que
 * chega por `paineis` para esta tela não depender da de configuração.
 */
export function Vitrine({ paineis }: { paineis: Record<string, ReactNode> }) {
  const { t } = useTranslation();
  const inicial = useRead("connections.list");
  const [recarregada, setRecarregada] = useState<Conexao[] | null>(null);
  const [busca, setBusca] = useState("");
  const [categoria, setCategoria] = useState<Categoria | null>(null);
  const [aberta, setAberta] = useState<string | null>(null);
  const [ligando, setLigando] = useState<string | null>(null);
  const [erros, setErros] = useState<Record<string, string>>({});

  const lista = recarregada ?? inicial.data ?? [];
  const recarregar = (): Promise<void> =>
    read("connections.list").then(setRecarregada, () => undefined);

  const termo = busca.trim().toLowerCase();
  const visiveis = lista.filter(
    (c) =>
      (categoria === null || c.category === categoria) &&
      (termo === "" || c.name.toLowerCase().includes(termo)),
  );

  const ligar = (id: string): void => {
    setLigando(id);
    setErros(({ [id]: _, ...resto }) => resto);
    call("connections.connect", id).then(
      () => {
        setLigando(null);
        void recarregar();
      },
      (e: unknown) => {
        setLigando(null);
        setErros((atual) => ({ ...atual, [id]: e instanceof Error ? e.message : String(e) }));
      },
    );
  };

  const desligar = (id: string): void => {
    setLigando(id);
    call("connections.disconnect", id).then(
      () => {
        setLigando(null);
        void recarregar();
      },
      (e: unknown) => {
        setLigando(null);
        setErros((atual) => ({ ...atual, [id]: e instanceof Error ? e.message : String(e) }));
      },
    );
  };

  const selecionada = aberta === null ? null : (lista.find((c) => c.id === aberta) ?? null);

  return (
    <section className="flex flex-col gap-4" data-locum-probe="vitrine">
      <header className="flex flex-col gap-1">
        <h2 className="font-medium text-[15px] tracking-tight">{t("connections.title")}</h2>
        <p className="text-muted-foreground max-w-[68ch] text-xs">
          {t("connections.description")}
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <label className="border-border bg-card focus-within:ring-ring flex h-8 min-w-[220px] flex-1 items-center gap-2 rounded-md border px-2 focus-within:ring-2">
          <Search aria-hidden className="text-muted-foreground size-3.5" />
          <input
            aria-label={t("connections.search")}
            className="placeholder:text-muted-foreground w-full bg-transparent text-sm outline-none"
            data-locum-vitrine-busca=""
            onChange={(e) => setBusca(e.target.value)}
            placeholder={t("connections.search")}
            value={busca}
          />
        </label>
        <div className="flex flex-wrap gap-1" role="group">
          <Filtro ativo={categoria === null} onClick={() => setCategoria(null)}>
            {t("connections.categories.all")}
          </Filtro>
          {CATEGORIAS.map((c) => (
            <Filtro ativo={categoria === c} key={c} onClick={() => setCategoria(c)}>
              {t(`connections.categories.${c}`)}
            </Filtro>
          ))}
        </div>
      </div>

      {inicial.status === "loading" && recarregada === null ? (
        <p className="text-muted-foreground text-sm">{t("connections.loading")}</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
          {visiveis.map((c) => (
            <Cartao
              conexao={c}
              erro={erros[c.id] ?? null}
              key={c.id}
              ligando={ligando === c.id}
              onAbrir={() => setAberta(c.id)}
              onLigar={() => ligar(c.id)}
            />
          ))}
          {categoria === null && termo === "" ? (
            <button
              className="border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground flex min-h-[132px] cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm transition-colors"
              data-locum-vitrine-propria=""
              onClick={() => setAberta("__custom")}
              type="button"
            >
              <Plus aria-hidden className="size-4" />
              {t("connections.custom.open")}
            </button>
          ) : null}
        </div>
      )}
      {visiveis.length === 0 && lista.length > 0 ? (
        <p className="text-muted-foreground text-sm">{t("connections.none")}</p>
      ) : null}

      {aberta === "__custom" ? (
        <Painel id="__custom" onFechar={() => setAberta(null)} titulo={t("connections.custom.title")}>
          <Propria
            onPronta={(id) => {
              void recarregar();
              setAberta(id);
            }}
          />
        </Painel>
      ) : selecionada !== null ? (
        <Painel
          cabeca={<Logo conexao={selecionada} tamanho="lg" />}
          id={selecionada.id}
          onFechar={() => {
            setAberta(null);
            void recarregar();
          }}
          titulo={selecionada.name}
        >
          <Detalhe
            conexao={selecionada}
            erro={erros[selecionada.id] ?? null}
            ligando={ligando === selecionada.id}
            onDesligar={() => desligar(selecionada.id)}
            onLigar={() => ligar(selecionada.id)}
            painel={paineis[selecionada.id]}
          />
        </Painel>
      ) : null}
    </section>
  );
}

function Filtro({ ativo, children, onClick }: { ativo: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button
      aria-pressed={ativo}
      className={cn(
        "h-8 cursor-pointer rounded-md px-3 text-xs transition-colors",
        ativo ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function Logo({ conexao, tamanho = "md" }: { conexao: Conexao; tamanho?: "md" | "lg" }) {
  const marca = conexao.logo === null ? undefined : MARCAS[conexao.logo];
  const Generico = GENERICOS[conexao.id] ?? Plug;
  const caixa = tamanho === "lg" ? "size-10 rounded-lg" : "size-9 rounded-md";
  const icone = tamanho === "lg" ? "size-5" : "size-[18px]";
  return (
    <span
      aria-hidden
      className={cn("flex shrink-0 items-center justify-center ring-1 ring-white/10", caixa)}
      style={{ backgroundColor: `#${marca?.hex ?? conexao.color}` }}
    >
      {marca === undefined ? (
        <Generico className={cn("text-white", icone)} />
      ) : (
        <svg className={cn("fill-white", icone)} viewBox="0 0 24 24">
          <path d={marca.path} />
        </svg>
      )}
    </span>
  );
}

function Estado({ conexao }: { conexao: Conexao }) {
  const { t } = useTranslation();
  if (conexao.state === "available") return null;
  return (
    <Badge
      className={cn(
        conexao.state === "connected" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
        conexao.state === "attention" && "border-amber-500/30 bg-amber-500/10 text-amber-400",
      )}
      variant="outline"
    >
      {t(`connections.state.${conexao.state}`)}
    </Badge>
  );
}

/** Ligar no próprio cartão vale só para quem liga sem formulário. */
function ligaNoCartao(c: Conexao): boolean {
  return (c.kind === "oauth" || c.kind === "claude-code") && c.state !== "connected";
}

function Cartao({
  conexao,
  erro,
  ligando,
  onAbrir,
  onLigar,
}: {
  conexao: Conexao;
  erro: string | null;
  ligando: boolean;
  onAbrir: () => void;
  onLigar: () => void;
}) {
  const { t } = useTranslation();
  return (
    <article
      className="border-border bg-card hover:border-foreground/25 group flex min-h-[132px] flex-col gap-3 rounded-lg border p-4 transition-colors"
      data-locum-conexao={conexao.id}
      data-locum-conexao-estado={conexao.state}
    >
      <button className="flex cursor-pointer items-start gap-3 text-left" onClick={onAbrir} type="button">
        <Logo conexao={conexao} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-medium text-sm">{conexao.name}</span>
          <span className="text-muted-foreground line-clamp-2 text-xs">
            {conexao.custom ? (conexao.url ?? "") : t(`connections.catalog.${conexao.id}.tagline`)}
          </span>
        </span>
      </button>
      <div className="mt-auto flex items-center gap-2">
        <Estado conexao={conexao} />
        {conexao.account === null ? null : (
          <span className="text-muted-foreground truncate text-xs">{conexao.account}</span>
        )}
        <div className="ml-auto">
          {conexao.state === "soon" ? (
            <Button disabled size="sm" variant="ghost">
              {t("connections.soon")}
            </Button>
          ) : ligaNoCartao(conexao) ? (
            <Button className="cursor-pointer" disabled={ligando} onClick={onLigar} size="sm">
              {t(ligando ? "connections.connecting" : "connections.connect")}
            </Button>
          ) : (
            <Button className="cursor-pointer" onClick={onAbrir} size="sm" variant="outline">
              {t(conexao.state === "connected" ? "connections.manage" : "connections.setup")}
            </Button>
          )}
        </div>
      </div>
      {erro === null ? null : <p className="text-sev-critical line-clamp-3 text-xs">{erro}</p>}
    </article>
  );
}

/**
 * Painel lateral sobre a tela. Esc e clique fora fecham, e o foco entra no
 * botão de fechar para o teclado não ficar preso na grade por trás.
 */
function Painel({
  cabeca,
  children,
  id,
  onFechar,
  titulo,
}: {
  cabeca?: ReactNode;
  children: ReactNode;
  id: string;
  onFechar: () => void;
  titulo: string;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const tecla = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onFechar();
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [onFechar]);

  return (
    <div className="sem-arrasto fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onFechar}>
      <aside
        aria-label={titulo}
        aria-modal
        className="border-border bg-background flex h-full w-full max-w-[520px] flex-col border-l shadow-2xl"
        data-locum-painel-conexao={id}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <header className="border-border flex items-center gap-3 border-b px-5 py-4">
          {cabeca}
          <h2 className="flex-1 truncate font-medium text-base">{titulo}</h2>
          <Button
            aria-label={t("connections.close")}
            autoFocus
            className="cursor-pointer"
            onClick={onFechar}
            size="icon"
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}

function Detalhe({
  conexao,
  erro,
  ligando,
  onDesligar,
  onLigar,
  painel,
}: {
  conexao: Conexao;
  erro: string | null;
  ligando: boolean;
  onDesligar: () => void;
  onLigar: () => void;
  painel: ReactNode | undefined;
}) {
  const { t } = useTranslation();
  const chave = `connections.catalog.${conexao.id}`;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <Estado conexao={conexao} />
        <span className="text-muted-foreground text-xs">{t(`connections.categories.${conexao.category}`)}</span>
      </div>

      {conexao.custom ? null : <p className="text-sm leading-relaxed">{t(`${chave}.description`)}</p>}

      {conexao.kind === "oauth" ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {conexao.state === "connected" ? (
              <Button className="cursor-pointer" disabled={ligando} onClick={onDesligar} variant="outline">
                {t("connections.disconnect")}
              </Button>
            ) : (
              <Button className="cursor-pointer" disabled={ligando} onClick={onLigar}>
                {t(
                  ligando
                    ? "connections.connecting"
                    : conexao.state === "attention"
                      ? "connections.reconnect"
                      : "connections.connect",
                )}
              </Button>
            )}
          </div>
          <p className="text-muted-foreground text-xs">
            {t(ligando ? "connections.oauth.waiting" : "connections.oauth.how")}
          </p>
          {conexao.url === undefined ? null : (
            <code className="bg-muted text-muted-foreground block overflow-x-auto rounded-md px-2 py-1 font-mono text-[11px] whitespace-nowrap">
              {conexao.url}
            </code>
          )}
        </div>
      ) : null}

      {conexao.kind === "soon" ? (
        <p className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs">
          {t(`${chave}.soon`)}
        </p>
      ) : null}

      {painel === undefined ? null : (
        <div className="divide-border border-border bg-card divide-y overflow-hidden rounded-lg border">{painel}</div>
      )}

      {erro === null ? null : <p className="text-sev-critical text-xs">{erro}</p>}
    </div>
  );
}

/** Servidor MCP remoto qualquer, pelo endereço. */
function Propria({ onPronta }: { onPronta: (id: string) => void }) {
  const { t } = useTranslation();
  const [nome, setNome] = useState("");
  const [url, setUrl] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const enviar = (e: React.FormEvent): void => {
    e.preventDefault();
    setEnviando(true);
    setErro(null);
    call("connections.addCustom", { name: nome, url }).then(
      (c) => {
        setEnviando(false);
        onPronta(c.id);
      },
      (falha: unknown) => {
        setEnviando(false);
        setErro(falha instanceof Error ? falha.message : String(falha));
      },
    );
  };

  const campo =
    "border-border bg-card focus:ring-ring h-9 w-full rounded-md border px-3 text-sm outline-none focus:ring-2";

  return (
    <form className="flex flex-col gap-4" data-locum-vitrine-form="" onSubmit={enviar}>
      <p className="text-muted-foreground text-sm">{t("connections.custom.description")}</p>
      <label className="flex flex-col gap-1.5 text-xs font-medium">
        {t("connections.custom.name")}
        <input
          autoComplete="off"
          className={campo}
          onChange={(e) => setNome(e.target.value)}
          placeholder={t("connections.custom.namePlaceholder")}
          required
          value={nome}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-xs font-medium">
        {t("connections.custom.url")}
        <input
          autoComplete="off"
          className={campo}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t("connections.custom.urlPlaceholder")}
          required
          type="url"
          value={url}
        />
        <span className="text-muted-foreground font-normal">{t("connections.custom.urlHint")}</span>
      </label>
      <div>
        <Button className="cursor-pointer" disabled={enviando} type="submit">
          {t(enviando ? "connections.connecting" : "connections.custom.submit")}
        </Button>
      </div>
      {erro === null ? null : <p className="text-sev-critical text-xs">{erro}</p>}
    </form>
  );
}
