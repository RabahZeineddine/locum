import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CabecalhoDaTela } from "@/components/cabecalho-da-tela";
import { call, invalidateReads, useRead, type ReadResult, type ReadState } from "@/lib/bridge";
import { acaoDeLigar, destinoDeConexaoAntiga } from "@/lib/conexao-acao";
import { MarcaLogo } from "@/components/marca-logo";
import { buscarConexoes, type ItemDeBusca } from "@/lib/busca-conexoes";
import { liberaDaConexao } from "@/lib/conexao-libera";
import { cn } from "@/lib/utils";
import { ArrowLeft, Download, Plus, Search, Server, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TelaProps } from "../rotas";
import { Github, Grafana, Slack, SlackOficial, TeamsPeloGraph, Trackers } from "./paineis-de-conexao";
import {
  AvisoDaOrigem,
  DetalhesTecnicos,
  SeloVinculado,
  type Vinculo,
  EstadoDoServidor,
  FerramentasDoServidor,
  ResultadoDoTeste,
  chaveDaOrigem,
  tituloDaOrigem,
  type EstadoDoTeste,
} from "./servidor-mcp";

type Conexao = ReadResult<"connections.list">[number];
type Categoria = Conexao["category"];

const CATEGORIAS: readonly Categoria[] = ["dev", "work", "communication", "observability", "data"];

/** O formulário específico de cada conexão que não liga só com um clique. */
const PAINEIS: Record<string, () => ReactNode> = {
  grafana: () => <Grafana />,
  // O GitHub guarda o token de pull request; o tracker de issues é outra
  // credencial, e mora junto porque também é GitHub.
  github: () => (
    <>
      <Github />
      <Trackers kinds={["github-issues"]} />
    </>
  ),
  slack: () => (
    <>
      <SlackOficial />
      <Slack />
    </>
  ),
  teams: () => <TeamsPeloGraph />,
  atlassian: () => <Trackers kinds={["jira-atlassian", "jira"]} />,
  shortcut: () => <Trackers kinds={["shortcut"]} />,
};

/**
 * Conexões: tudo que é externo ao Locum, num lugar só.
 *
 * Sem destino, a lista do que já está ligado, com o estado de cada uma e o
 * que ela libera. Com o id de uma conexão no destino, o detalhe dela. O
 * catálogo fica atrás de "Adicionar conexão", e não numa parede de cartões.
 */
export function Conexoes({ detalhe, navegar }: TelaProps) {
  return detalhe === null ? <SuasConexoes navegar={navegar} /> : <DetalheDaConexao id={detalhe} key={detalhe} navegar={navegar} />;
}

/**
 * O último dado lido, mesmo enquanto uma releitura está em curso. `useRead`
 * volta para "carregando" a cada invalidação, e a tela que trocasse de
 * conteúdo nessa hora perderia o estado de quem está no meio de um teste ou
 * de uma autorização.
 */
function useDadosEstaveis<T>(leitura: ReadState<T>): { data: T | undefined; status: ReadState<T>["status"] } {
  const ultimo = useRef<T | undefined>(undefined);
  if (leitura.status === "ready") ultimo.current = leitura.data;
  return { data: ultimo.current, status: ultimo.current === undefined ? leitura.status : "ready" };
}

/** Já está ligada ou cadastrada, e portanto aparece na lista principal. */
function ligada(c: Conexao): boolean {
  return c.state !== "available" && c.state !== "soon";
}

type PassoDoAdicionar = "escolher" | "propria" | "importar";

/**
 * Onde a busca procura em cada conexão: nome, descrição curta, categoria,
 * origem dos servidores e as ferramentas que a última lista guardou. As
 * disponíveis entram também, para a busca achar o item do catálogo.
 */
function textosDeBusca(
  conexoes: Conexao[],
  origens: Record<string, string>,
  t: (chave: string, opcoes?: Record<string, unknown>) => string,
): ItemDeBusca[] {
  const doCatalogo = new Set(conexoes.filter((c) => !c.custom).map((c) => c.id));
  return conexoes.map((c) => ({
    id: c.id,
    ligada: ligada(c),
    textos: [
      c.name,
      c.id,
      c.custom ? t("connections.custom.badge") : t(`connections.catalog.${c.id}.tagline`),
      t(`connections.categories.${c.category}`),
      ...c.servers,
      ...c.servers.map((nome) => tituloDaOrigem(chaveDaOrigem(nome, origens, doCatalogo), t)),
      ...c.toolNames,
      ...(c.url === undefined ? [] : [c.url.replace(/^https?:\/\//, "")]),
    ],
  }));
}

function SuasConexoes({ navegar }: { navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  const lista = useDadosEstaveis(useRead("connections.list"));
  const vinculos = useDadosEstaveis(useRead("mcp.vinculos"));
  const claudeCode = useRead("claudeCode.status");
  const [corrigindo, setCorrigindo] = useState(false);
  const [erroAoCorrigir, setErroAoCorrigir] = useState<string | null>(null);
  const origens = useRead("claudeImport.origins");
  const [adicionando, setAdicionando] = useState<{ passo: PassoDoAdicionar; busca: string } | null>(null);
  const [busca, setBusca] = useState("");
  const campoDeBusca = useRef<HTMLInputElement>(null);

  // `/` e ⌘F levam para a busca da tela, a não ser que a pessoa já esteja
  // digitando em outro campo ou com um painel aberto por cima.
  useEffect(() => {
    const tecla = (e: KeyboardEvent): void => {
      const alvo = e.target instanceof HTMLElement ? e.target : null;
      const digitando = alvo !== null && (alvo.tagName === "INPUT" || alvo.tagName === "TEXTAREA" || alvo.isContentEditable);
      const barra = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !digitando;
      const procurar = e.key.toLowerCase() === "f" && (e.metaKey || e.ctrlKey) && !e.shiftKey;
      if (!barra && !procurar) return;
      if (adicionando !== null) return;
      e.preventDefault();
      campoDeBusca.current?.focus();
      campoDeBusca.current?.select();
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [adicionando]);

  const todas = lista.data ?? [];
  const suas = todas.filter(ligada);
  const precisam = suas.filter((c) => c.state === "attention" || c.state === "error").length;
  const termo = busca.trim();
  const achadas = buscarConexoes(textosDeBusca(todas, origens.status === "ready" ? origens.data : {}, t), termo);
  const suasVisiveis = termo === "" ? suas : suas.filter((c) => achadas.suas.includes(c.id));
  const doCatalogo = todas.filter((c) => !c.custom && achadas.catalogo.includes(c.id));

  return (
    <div
      className="mx-auto flex w-full max-w-6xl flex-col gap-8"
      data-locum-carregada={lista.status === "ready" ? "sim" : "nao"}
      data-locum-ligadas={suas.map((c) => c.id).join(",")}
      data-locum-servidores={suas.flatMap((c) => c.servers).join(",")}
      data-locum-probe="connections"
    >
      <CabecalhoDaTela
        acoes={
          <Button className="cursor-pointer" data-locum-adicionar-conexao="" onClick={() => setAdicionando({ passo: "escolher", busca: "" })}>
            <Plus aria-hidden className="size-4" />
            {t("connections.add.open")}
          </Button>
        }
        descricao={t("connections.lead")}
        titulo={t("connections.title")}
      />

      {claudeCode.status === "ready" && claudeCode.data.desatualizado !== null ? (
        <div className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs" data-locum-claude-code-desatualizado="">
          <p className="font-medium text-amber-400">{t("connections.claudeCodeStale.title")}</p>
          <p className="text-muted-foreground">{t("connections.claudeCodeStale.body", { motivo: t(`connections.claudeCodeStale.motivo.${claudeCode.data.desatualizado}`) })}</p>
          <div>
            <Button
              className="cursor-pointer"
              disabled={corrigindo}
              onClick={() => {
                setCorrigindo(true);
                setErroAoCorrigir(null);
                call("claudeCode.connect")
                  .then(
                    () => setCorrigindo(false),
                    (falha: unknown) => {
                      setCorrigindo(false);
                      setErroAoCorrigir(falha instanceof Error ? falha.message : String(falha));
                    },
                  )
                  .finally(() => invalidateReads("claudeCode.status"));
              }}
              size="sm"
            >
              {t(corrigindo ? "connections.claudeCodeStale.fixing" : "connections.claudeCodeStale.fix")}
            </Button>
          </div>
          {erroAoCorrigir === null ? null : <p className="text-destructive">{erroAoCorrigir}</p>}
        </div>
      ) : null}

      <section className="flex flex-col gap-4" data-locum-probe="suas-conexoes">
        <header className="flex flex-col gap-1">
          <h2 className="font-medium text-[15px] tracking-tight">{t("connections.yours.title")}</h2>
          <p className="text-muted-foreground max-w-[68ch] text-xs">
            {precisam > 0
              ? t("connections.yours.needAttention", { count: precisam })
              : t("connections.yours.description")}
          </p>
        </header>

        <label className="border-border bg-card focus-within:ring-ring flex h-9 max-w-md items-center gap-2 rounded-md border px-2.5 focus-within:ring-2">
          <Search aria-hidden className="text-muted-foreground size-3.5" />
          <input
            aria-label={t("connections.yours.search")}
            className="placeholder:text-muted-foreground w-full bg-transparent text-sm outline-none"
            data-locum-conexoes-busca=""
            onChange={(e) => setBusca(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setBusca("");
                e.currentTarget.blur();
              }
            }}
            placeholder={t("connections.yours.search")}
            ref={campoDeBusca}
            value={busca}
          />
          {busca === "" ? (
            <kbd className="text-muted-foreground border-border rounded border px-1.5 text-[10px] leading-4">/</kbd>
          ) : (
            <button
              aria-label={t("connections.yours.clearSearch")}
              className="text-muted-foreground hover:text-foreground cursor-pointer"
              onClick={() => {
                setBusca("");
                campoDeBusca.current?.focus();
              }}
              type="button"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          )}
        </label>

        {lista.status === "loading" ? (
          <p className="text-muted-foreground text-sm">{t("connections.loading")}</p>
        ) : suas.length === 0 && termo === "" ? (
          <div className="border-border text-muted-foreground flex flex-col items-start gap-3 rounded-xl border border-dashed p-6 text-sm">
            <p className="max-w-[60ch]">{t("connections.yours.empty")}</p>
            <Button className="cursor-pointer" onClick={() => setAdicionando({ passo: "escolher", busca: "" })} size="sm" variant="outline">
              <Plus aria-hidden className="size-3.5" />
              {t("connections.add.open")}
            </Button>
          </div>
        ) : (
          <>
            {suasVisiveis.length === 0 ? null : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3" data-locum-busca-suas={termo === "" ? "" : suasVisiveis.map((c) => c.id).join(",")}>
                {suasVisiveis.map((c) => (
                  <ConexaoNaLista conexao={c} key={c.id} onAbrir={() => navegar("connections", c.id)} vinculos={vinculos.data ?? {}} />
                ))}
              </div>
            )}
            {termo !== "" && doCatalogo.length > 0 ? (
              <div className="flex flex-col gap-2" data-locum-busca-catalogo={doCatalogo.map((c) => c.id).join(",")}>
                <h3 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">{t("connections.yours.fromCatalog")}</h3>
                <ul className="flex flex-col gap-1.5">
                  {doCatalogo.map((c) => (
                    <li key={c.id}>
                      <button
                        className="border-border hover:bg-muted/40 flex w-full max-w-xl cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors"
                        data-locum-catalogo={c.id}
                        disabled={c.state === "soon"}
                        onClick={() => navegar("connections", c.id)}
                        type="button"
                      >
                        <Logo conexao={c} />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="text-sm font-medium">{c.name}</span>
                          <span className="text-muted-foreground line-clamp-1 text-xs">{t(`connections.catalog.${c.id}.tagline`)}</span>
                        </span>
                        <span className="text-muted-foreground text-xs">{t(c.state === "soon" ? "connections.soon" : "connections.yours.addFromCatalog")}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {termo !== "" && suasVisiveis.length === 0 && doCatalogo.length === 0 ? (
              <div className="border-border text-muted-foreground flex flex-col items-start gap-3 rounded-xl border border-dashed p-6 text-sm" data-locum-busca-vazia="">
                <p className="max-w-[60ch]">{t("connections.yours.noResults", { termo })}</p>
                <p className="max-w-[60ch] text-xs">{t("connections.yours.noResultsHint")}</p>
                <div className="flex flex-wrap gap-2">
                  <Button className="cursor-pointer" onClick={() => setAdicionando({ passo: "propria", busca: termo })} size="sm" variant="outline">
                    <Server aria-hidden className="size-3.5" />
                    {t("connections.custom.title")}
                  </Button>
                  <Button className="cursor-pointer" onClick={() => setAdicionando({ passo: "importar", busca: termo })} size="sm" variant="outline">
                    <Download aria-hidden className="size-3.5" />
                    {t("connections.import.title")}
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>

      {adicionando !== null ? (
        <AdicionarConexao
          buscaInicial={adicionando.busca}
          conexoes={lista.data ?? []}
          onAbrir={(id) => {
            setAdicionando(null);
            navegar("connections", id);
          }}
          onFechar={() => setAdicionando(null)}
          passoInicial={adicionando.passo}
        />
      ) : null}
    </div>
  );
}

function Logo({ conexao, tamanho = "md" }: { conexao: Conexao; tamanho?: "md" | "lg" }) {
  return <MarcaLogo fonte={{ name: conexao.id, url: conexao.url }} tamanho={tamanho} />;
}

function Estado({ conexao }: { conexao: Conexao }) {
  const { t } = useTranslation();
  if (conexao.state === "available") return null;
  return (
    <Badge
      className={cn(
        "px-2 py-0.5 text-[11px] font-medium",
        conexao.state === "connected" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
        conexao.state === "attention" && "border-amber-500/30 bg-amber-500/10 text-amber-400",
        conexao.state === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
      )}
      variant="outline"
    >
      <span
        aria-hidden
        className={cn(
          "mr-1.5 inline-block size-1.5 rounded-full",
          conexao.state === "connected" && "bg-emerald-400",
          conexao.state === "attention" && "bg-amber-400",
          conexao.state === "error" && "bg-destructive",
        )}
      />
      {t(`connections.state.${conexao.state}`)}
    </Badge>
  );
}

/** O porquê do estado, em uma frase curta: o código traduzido, ou o que o servidor respondeu. */
function textoDoEstado(c: Conexao, t: (chave: string, opcoes?: Record<string, unknown>) => string): string | null {
  if (c.reason === null) return null;
  if (c.reason === "failing") return c.detail ?? t("connections.reason.failing");
  return t(`connections.reason.${c.reason}`);
}

/** "2 gatilhos, 1 ação, 12 ferramentas": o que a conexão libera, na língua da automação. */
function Resumo({ conexao }: { conexao: Conexao }) {
  const { t } = useTranslation();
  const libera = liberaDaConexao(conexao.id, { servidor: conexao.servers.length > 0 });
  const partes = [
    libera.gatilhos.length > 0 ? t("connections.offers.triggers", { count: libera.gatilhos.length }) : null,
    libera.acoes.length > 0 ? t("connections.offers.actions", { count: libera.acoes.length }) : null,
    conexao.toolCount !== null ? t("connections.offers.tools", { count: conexao.toolCount }) : null,
  ].filter((p): p is string => p !== null);
  return (
    <span className="text-muted-foreground text-xs leading-relaxed">
      {partes.length > 0 ? partes.join(" · ") : t("connections.offers.none")}
    </span>
  );
}

function ConexaoNaLista({ conexao, onAbrir, vinculos }: { conexao: Conexao; onAbrir: () => void; vinculos: Record<string, Vinculo> }) {
  const { t } = useTranslation();
  const vinculado = conexao.servers.map((nome) => vinculos[nome]).find((v) => v !== undefined);
  const mudou = conexao.servers.some((nome) => vinculos[nome]?.estado === "mudou" && vinculos[nome]?.mantida === false);
  const sumiu = conexao.servers.some((nome) => vinculos[nome]?.estado === "sumiu" || vinculos[nome]?.estado === "indisponivel");
  const porque = textoDoEstado(conexao, t);
  return (
    <button
      className={cn(
        "border-border superficie hover:border-foreground/30 flex min-h-[132px] cursor-pointer flex-col gap-3 rounded-xl border p-4 text-left transition-all duration-150",
        conexao.state === "attention" && "border-amber-500/30",
        conexao.state === "error" && "border-destructive/40",
      )}
      data-locum-conexao={conexao.id}
      data-locum-conexao-estado={conexao.state}
      onClick={onAbrir}
      type="button"
    >
      <span className="flex items-start gap-3.5">
        <Logo conexao={conexao} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-semibold text-sm tracking-tight text-foreground">{conexao.name}</span>
            {conexao.custom && vinculado === undefined ? (
              <span className="border-border text-muted-foreground rounded border px-1.5 py-px text-[10px] leading-4">
                {t("connections.custom.badge")}
              </span>
            ) : null}
          </span>
          {vinculado === undefined ? null : (
            <span>
              <SeloVinculado vinculo={vinculado} />
            </span>
          )}
          <Resumo conexao={conexao} />
        </span>
      </span>
      <span className="border-border/40 mt-auto flex flex-col gap-1.5 border-t pt-2.5">
        <span className="flex flex-wrap items-center gap-2">
          <Estado conexao={conexao} />
          {conexao.account === null ? null : (
            <span className="text-muted-foreground min-w-0 truncate text-[11px]">{conexao.account}</span>
          )}
        </span>
        {porque === null || mudou || sumiu ? null : (
          <span className={cn("line-clamp-2 text-xs", conexao.state === "error" ? "text-destructive" : "text-amber-400")} title={porque}>
            {porque}
          </span>
        )}
        {mudou || sumiu ? (
          <span className="line-clamp-2 text-xs text-amber-400" data-locum-origem-aviso={mudou ? "mudou" : "sumiu"}>
            {t(mudou ? "settings.servers.link.changed.title" : "settings.servers.link.gone.title")}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/* ---------------------------------------------------------------- adicionar */

/**
 * "Adicionar conexão": o catálogo com busca, e os dois caminhos que não estão
 * nele, o servidor MCP próprio e a importação de outras ferramentas.
 * Escolher um serviço leva ao detalhe dele, onde mora o botão de conectar.
 */
function AdicionarConexao({
  buscaInicial = "",
  conexoes,
  onAbrir,
  onFechar,
  passoInicial = "escolher",
}: {
  buscaInicial?: string;
  conexoes: Conexao[];
  onAbrir: (id: string) => void;
  onFechar: () => void;
  passoInicial?: PassoDoAdicionar;
}) {
  const { t } = useTranslation();
  const [passo, setPasso] = useState<PassoDoAdicionar>(passoInicial);
  const [busca, setBusca] = useState(buscaInicial);
  const [categoria, setCategoria] = useState<Categoria | null>(null);

  const termo = busca.trim().toLowerCase();
  // O que já está ligado fica na lista principal; aqui só o que falta ligar.
  const disponiveis = conexoes.filter((c) => !c.custom && !ligada(c));
  const visiveis = disponiveis.filter(
    (c) =>
      (categoria === null || c.category === categoria) &&
      (termo === "" || c.name.toLowerCase().includes(termo) || t(`connections.catalog.${c.id}.tagline`).toLowerCase().includes(termo)),
  );

  const titulo =
    passo === "propria"
      ? t("connections.custom.title")
      : passo === "importar"
        ? t("connections.import.title")
        : t("connections.add.title");

  return (
    <Painel id="__adicionar" onFechar={onFechar} titulo={titulo}>
      {passo === "propria" ? (
        <div className="flex flex-col gap-4">
          <VoltarAoSeletor onClick={() => setPasso("escolher")} />
          <Propria onPronta={onAbrir} />
        </div>
      ) : passo === "importar" ? (
        <div className="flex flex-col gap-4">
          <VoltarAoSeletor onClick={() => setPasso("escolher")} />
          <ImportarDoClaude
            onPronto={() => {
              invalidateReads("connections.list");
              invalidateReads("mcp.list");
              invalidateReads("mcp.vinculos");
              onFechar();
            }}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4" data-locum-probe="adicionar-conexao">
          <p className="text-muted-foreground text-xs">{t("connections.add.description")}</p>

          <label className="border-border bg-card focus-within:ring-ring flex h-9 items-center gap-2 rounded-md border px-2.5 focus-within:ring-2">
            <Search aria-hidden className="text-muted-foreground size-3.5" />
            <input
              aria-label={t("connections.search")}
              autoFocus
              className="placeholder:text-muted-foreground w-full bg-transparent text-sm outline-none"
              data-locum-adicionar-busca=""
              onChange={(e) => setBusca(e.target.value)}
              placeholder={t("connections.search")}
              value={busca}
            />
          </label>

          <div className="flex flex-wrap gap-1" role="group">
            <Filtro ativo={categoria === null} onClick={() => setCategoria(null)}>
              {t("connections.categories.all")}
            </Filtro>
            {CATEGORIAS.filter((c) => disponiveis.some((x) => x.category === c)).map((c) => (
              <Filtro ativo={categoria === c} key={c} onClick={() => setCategoria(c)}>
                {t(`connections.categories.${c}`)}
              </Filtro>
            ))}
          </div>

          <ul className="flex flex-col gap-1.5">
            {visiveis.map((c) => (
              <li key={c.id}>
                <button
                  className="border-border hover:bg-muted/40 flex w-full cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors"
                  data-locum-catalogo={c.id}
                  disabled={c.state === "soon"}
                  onClick={() => onAbrir(c.id)}
                  type="button"
                >
                  <Logo conexao={c} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium">{c.name}</span>
                    <span className="text-muted-foreground line-clamp-1 text-xs">{t(`connections.catalog.${c.id}.tagline`)}</span>
                  </span>
                  {c.state === "soon" ? <span className="text-muted-foreground text-xs">{t("connections.soon")}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          {visiveis.length === 0 ? <p className="text-muted-foreground text-sm">{t("connections.none")}</p> : null}

          <div className="border-border flex flex-col gap-2 border-t pt-4">
            <h3 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">{t("connections.add.others")}</h3>
            <button
              className="border-border hover:bg-muted/40 flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors"
              data-locum-vitrine-propria=""
              onClick={() => setPasso("propria")}
              type="button"
            >
              <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
                <Server aria-hidden className="size-[18px]" />
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{t("connections.custom.title")}</span>
                <span className="text-muted-foreground text-xs">{t("connections.add.customHint")}</span>
              </span>
            </button>
            <button
              className="border-border hover:bg-muted/40 flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors"
              data-locum-vitrine-importar=""
              onClick={() => setPasso("importar")}
              type="button"
            >
              <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
                <Download aria-hidden className="size-[18px]" />
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{t("connections.import.title")}</span>
                <span className="text-muted-foreground text-xs">{t("connections.add.importHint")}</span>
              </span>
            </button>
          </div>
        </div>
      )}
    </Painel>
  );
}

function VoltarAoSeletor({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button className="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer items-center gap-1.5 text-xs" onClick={onClick} type="button">
      <ArrowLeft aria-hidden className="size-3.5" />
      {t("connections.add.back")}
    </button>
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

/**
 * Painel lateral sobre a tela. Esc e clique fora fecham, e o foco entra no
 * botão de fechar para o teclado não ficar preso na grade por trás.
 */
export function Painel({
  children,
  id,
  onFechar,
  titulo,
}: {
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
          <h2 className="flex-1 truncate font-medium text-base">{titulo}</h2>
          <Button aria-label={t("connections.close")} className="cursor-pointer" onClick={onFechar} size="icon" variant="ghost">
            <X className="size-4" />
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ detalhe */

const TITULO_DO_BLOCO = "text-muted-foreground text-xs font-medium uppercase tracking-wide";

function Bloco({ children, dica, titulo }: { children: ReactNode; dica?: string; titulo: string }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className={TITULO_DO_BLOCO}>{titulo}</h3>
        {dica === undefined ? null : <p className="text-muted-foreground max-w-[68ch] text-xs">{dica}</p>}
      </div>
      {children}
    </section>
  );
}

/**
 * O detalhe de uma conexão, o mesmo para qualquer tipo: estado e conta,
 * testar, o que libera, ferramentas, quem usa, o formulário do tipo e, atrás
 * de "detalhes técnicos", o endereço ou o comando.
 */
function DetalheDaConexao({ id, navegar }: { id: string; navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  const lista = useDadosEstaveis(useRead("connections.list"));
  const servidores = useDadosEstaveis(useRead("mcp.list"));
  const vinculos = useDadosEstaveis(useRead("mcp.vinculos"));
  const credenciais = useDadosEstaveis(useRead("credentials.overview"));
  const origens = useRead("claudeImport.origins");
  const trackers = useRead("trackers.list");
  const usoDeIniciativas = useRead("mcp.usage");
  const usadoPor = useDadosEstaveis(useRead("connections.usage", id));
  const [ligando, setLigando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);

  const voltar = (): void => navegar("connections");
  const conexao = (lista.data ?? []).find((c) => c.id === id);
  const naoExiste = lista.status !== "loading" && conexao === undefined;

  // Endereço antigo (id de tracker, Claude Code, opencode): leva ao lugar de hoje.
  useEffect(() => {
    if (!naoExiste || trackers.status === "loading") return;
    const destino = destinoDeConexaoAntiga(id, trackers.data ?? []);
    navegar(destino.rota, destino.detalhe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [naoExiste, trackers.status, id]);

  if (lista.status === "loading") {
    return <p className="text-muted-foreground mx-auto w-full max-w-3xl pt-4 text-sm">{t("connections.loading")}</p>;
  }
  if (conexao === undefined) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pt-4" data-locum-probe="conexao">
        <BotaoVoltar onClick={voltar} />
        <p className="text-muted-foreground text-sm">{t("connections.detail.missing", { id })}</p>
      </div>
    );
  }

  const doServidor = (servidores.data ?? []).filter((s) => conexao.servers.includes(s.config.name));
  const doVinculo = vinculos.data ?? {};
  const credencial = (credenciais.data?.refs ?? []).find((r) =>
    r.users.some((u) => u.kind === "mcp" && conexao.servers.includes(u.name)),
  );
  const acao = acaoDeLigar(conexao);
  const libera = liberaDaConexao(conexao.id, { servidor: conexao.servers.length > 0 });
  const porque = textoDoEstado(conexao, t);
  const painel = PAINEIS[conexao.id];
  const chave = `connections.catalog.${conexao.id}`;
  const iniciativas = conexao.servers.flatMap((nome) => usoDeIniciativas.data?.[nome] ?? []);
  const quemUsa = usadoPor.data ?? [];

  const agir = (fazer: () => Promise<unknown>, depois?: () => void): void => {
    setLigando(true);
    setErro(null);
    fazer().then(
      () => {
        setLigando(false);
        invalidateReads("connections.list");
        invalidateReads("mcp.list");
        invalidateReads("mcp.vinculos");
        depois?.();
      },
      (e: unknown) => {
        setLigando(false);
        setErro(e instanceof Error ? e.message : String(e));
      },
    );
  };

  const origem = tituloDaOrigem(
    chaveDaOrigem(id, origens.data ?? {}, new Set(lista.data?.filter((c) => !c.custom).map((c) => c.id))),
    t,
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 pt-4" data-locum-conexao-id={conexao.id} data-locum-probe="conexao">
      <BotaoVoltar onClick={voltar} />

      <header className="flex items-center gap-4">
        <Logo conexao={conexao} tamanho="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h1 className="truncate text-2xl font-semibold tracking-[-0.01em]">{conexao.name}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <Estado conexao={conexao} />
            {conexao.custom ? (
              doServidor.some((s) => doVinculo[s.config.name] !== undefined) ? null : (
                <span className="border-border text-muted-foreground rounded border px-1.5 py-px text-[10px] leading-4">
                  {t("connections.custom.badge")}
                </span>
              )
            ) : (
              <span className="text-muted-foreground text-xs">{t(`connections.categories.${conexao.category}`)}</span>
            )}
            {conexao.account === null ? null : (
              <span className="text-muted-foreground text-xs">{t("connections.detail.account", { account: conexao.account })}</span>
            )}
            {doServidor.map((servidor) => {
              const v = doVinculo[servidor.config.name];
              return v === undefined ? null : <SeloVinculado key={servidor.config.name} vinculo={v} />;
            })}
          </div>
        </div>
      </header>

      <p className="max-w-[68ch] text-sm leading-relaxed">
        {conexao.custom ? t("connections.detail.customDescription") : t(`${chave}.description`)}
      </p>

      {porque === null || (conexao.reason === "disabled" && doServidor.length > 0) ? null : (
        <p
          className={cn(
            "rounded-md border px-3 py-2 text-xs break-words",
            conexao.state === "error"
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : conexao.reason === "untested"
                ? "border-border text-muted-foreground"
                : "border-amber-500/30 bg-amber-500/5 text-amber-400",
          )}
          data-locum-conexao-motivo={conexao.reason ?? ""}
        >
          {porque}
        </p>
      )}

      {conexao.partes === null ? null : (
        <PartesDoGithub
          agir={agir}
          conexao={conexao}
          ocupado={ligando}
          partes={conexao.partes}
        />
      )}

      {acao === null ? null : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {acao === "disconnect" ? (
              <Button
                className="cursor-pointer"
                disabled={ligando}
                onClick={() => agir(() => call("connections.disconnect", conexao.id))}
                variant="outline"
              >
                {t("connections.disconnect")}
              </Button>
            ) : (
              <Button
                className="cursor-pointer"
                data-locum-conectar-mcp={conexao.id}
                disabled={ligando}
                onClick={() => agir(() => call("connections.connect", conexao.id))}
              >
                {t(
                  ligando
                    ? "connections.connecting"
                    : acao === "reconnect"
                      ? "connections.reconnect"
                      : conexao.state === "connected"
                        ? "connections.connectServer"
                        : "connections.connect",
                )}
              </Button>
            )}
          </div>
          {acao === "connect" && conexao.state === "connected" ? (
            <p className="text-muted-foreground text-xs">{t("connections.noServerHint")}</p>
          ) : null}
          <p className="text-muted-foreground text-xs">{t(ligando ? "connections.oauth.waiting" : "connections.oauth.how")}</p>
        </div>
      )}

      {conexao.state === "soon" ? (
        <p className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs">{t(`${chave}.soon`)}</p>
      ) : null}

      {doServidor.map((servidor) => {
        const v = doVinculo[servidor.config.name];
        return v === undefined ? null : (
          <AvisoDaOrigem
            key={servidor.config.name}
            nome={servidor.config.name}
            onMudou={() => {
              invalidateReads("connections.list");
              invalidateReads("mcp.list");
              invalidateReads("mcp.vinculos");
            }}
            vinculo={v}
          />
        );
      })}

      {doServidor.map((servidor) => (
        <EstadoDoServidor
          autorizavel={conexao.custom && servidor.config.transport === "http"}
          emUso={quemUsa.length > 0 || iniciativas.length > 0}
          key={servidor.config.name}
          onMudou={() => {
            invalidateReads("connections.list");
            invalidateReads("mcp.list");
            invalidateReads("mcp.vinculos");
          }}
          servidor={servidor}
        />
      ))}

      {conexao.partes !== null
        ? null
        : doServidor.map((servidor) => <TesteDaConexao key={servidor.config.name} servidor={servidor.config.name} />)}

      <Bloco dica={t("connections.detail.offersHint")} titulo={t("connections.offers.title")}>
        <Libera conexao={conexao} libera={libera} />
      </Bloco>

      {doServidor.length === 0 ? null : (
        <Bloco dica={t("connections.detail.toolsHint")} titulo={t("connections.detail.tools")}>
          {doServidor.map((servidor) => (
            <FerramentasDoServidor key={servidor.config.name} servidor={servidor} />
          ))}
        </Bloco>
      )}

      <Bloco dica={t("connections.detail.usedByHint")} titulo={t("connections.detail.usedBy")}>
        {quemUsa.length === 0 && iniciativas.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("connections.detail.unused")}</p>
        ) : (
          <ul className="flex flex-col gap-1.5" data-locum-quem-usa="">
            {quemUsa.map((u) => (
              <li key={`${u.tipo}:${u.id}`}>
                <button
                  className="border-border hover:bg-muted/40 flex w-full cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-left text-sm"
                  onClick={() => navegar(u.tipo === "automation" ? "automations" : "agents", u.id)}
                  type="button"
                >
                  <Badge variant="outline">{t(`connections.detail.kind.${u.tipo}`)}</Badge>
                  <span className="flex-1 truncate">{u.nome}</span>
                  <span className="text-muted-foreground text-xs">{u.como.map((c) => t(`connections.detail.how.${c}`)).join(", ")}</span>
                </button>
              </li>
            ))}
            {iniciativas.map((titulo) => (
              <li className="border-border flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm" key={`iniciativa:${titulo}`}>
                <Badge variant="outline">{t("connections.detail.kind.initiative")}</Badge>
                <span className="truncate">{titulo}</span>
              </li>
            ))}
          </ul>
        )}
      </Bloco>

      {painel === undefined ? null : (
        <div data-locum-conexao-config="">
          <Bloco titulo={t("connections.detail.settings")}>
            <div className="divide-border border-border superficie divide-y overflow-hidden rounded-lg border">{painel()}</div>
          </Bloco>
        </div>
      )}

      {conexao.custom ? (
        <Bloco titulo={t("connections.detail.remove")}>
          <p className="text-muted-foreground text-xs">{t("connections.detail.removeHint")}</p>
          <div>
            <Button
              className="cursor-pointer"
              disabled={ligando}
              onClick={() => (confirmando ? agir(() => call("connections.disconnect", conexao.id), voltar) : setConfirmando(true))}
              variant="destructive"
            >
              {t(confirmando ? "connections.detail.removeConfirm" : "connections.detail.removeAction")}
            </Button>
          </div>
        </Bloco>
      ) : null}

      {erro === null ? null : <p className="text-sev-critical text-xs break-words">{erro}</p>}

      {doServidor.length === 0 ? null : (
        <details className="border-border rounded-lg border" data-locum-tecnico="">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer px-4 py-2.5 text-xs font-medium select-none">
            {t("connections.detail.technical")}
          </summary>
          <div className="border-border border-t px-4 py-4">
            {doServidor.map((servidor) => (
              <DetalhesTecnicos
                credencial={credencial}
                key={servidor.config.name}
                onMudou={() => {
                  invalidateReads("connections.list");
                  invalidateReads("mcp.list");
                  invalidateReads("mcp.vinculos");
                  invalidateReads("credentials.overview");
                }}
                origem={origem}
                servidor={servidor}
                vinculo={doVinculo[servidor.config.name]}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * As duas partes do GitHub, cada uma com o estado e o que libera: o token
 * (gatilhos e prévia de pull request) e o servidor MCP (ferramentas dos
 * agents). É o que impede "conectado" de esconder uma parte quebrada.
 */
function PartesDoGithub({
  agir,
  conexao,
  ocupado,
  partes,
}: {
  agir: (fazer: () => Promise<unknown>, depois?: () => void) => void;
  conexao: Conexao;
  ocupado: boolean;
  partes: NonNullable<Conexao["partes"]>;
}) {
  const { t } = useTranslation();
  const servidor = conexao.servers[0];
  const ruim = partes.servidor === "disabled" || partes.servidor === "no-credential" || partes.servidor === "needs-auth" || partes.servidor === "failing";
  const linha = "border-border superficie flex flex-col gap-2 rounded-lg border p-3";
  return (
    <Bloco dica={t("connections.parts.hint")} titulo={t("connections.parts.title")}>
      <div className="flex flex-col gap-2" data-locum-github-partes="">
        <div className={linha} data-locum-parte="token" data-locum-parte-estado={partes.token}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{t("connections.parts.token.title")}</span>
            <Badge className={cn(partes.token === "ok" ? "text-emerald-400" : "text-amber-400")} variant="outline">
              {t(`connections.parts.token.${partes.token}`)}
            </Badge>
            <Button
              className="ml-auto cursor-pointer"
              data-locum-guardar-token=""
              onClick={() => document.querySelector("[data-locum-conexao-config]")?.scrollIntoView({ behavior: "smooth", block: "start" })}
              size="sm"
              variant={partes.token === "ok" ? "outline" : "default"}
            >
              {t("connections.parts.token.save")}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">{t("connections.parts.token.offers")}</p>
        </div>

        <div className={linha} data-locum-parte="servidor" data-locum-parte-estado={partes.servidor ?? "none"}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{t("connections.parts.server.title")}</span>
            {partes.servidor === null ? null : (
              <Badge className={cn(ruim ? "text-amber-400" : "text-emerald-400")} variant="outline">
                {t(`connections.parts.server.state.${partes.servidor}`)}
              </Badge>
            )}
            {partes.servidor === "disabled" && servidor !== undefined ? (
              <Button
                className="ml-auto cursor-pointer"
                data-locum-ligar-parte={servidor}
                disabled={ocupado}
                onClick={() => agir(() => call("mcp.setEnabled", servidor, true))}
                size="sm"
              >
                {t("connections.parts.server.turnOn")}
              </Button>
            ) : null}
          </div>
          <p className="text-muted-foreground text-xs">
            {t(partes.servidor === null ? "connections.parts.server.none" : "connections.parts.server.offers")}
          </p>
          {servidor === undefined ? null : <TesteDaConexao servidor={servidor} />}
        </div>
      </div>
    </Bloco>
  );
}

function BotaoVoltar({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      className="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer items-center gap-1.5 text-sm"
      data-locum-voltar-conexoes=""
      onClick={onClick}
      type="button"
    >
      <ArrowLeft aria-hidden className="size-4" />
      {t("connections.title")}
    </button>
  );
}

/** Gatilhos e ações de app que a conexão libera, e quantas ferramentas ela tem. */
function Libera({ conexao, libera }: { conexao: Conexao; libera: ReturnType<typeof liberaDaConexao> }) {
  const { t } = useTranslation();
  const vazio = libera.gatilhos.length === 0 && libera.acoes.length === 0 && conexao.toolCount === null;
  if (vazio) return <p className="text-muted-foreground text-xs">{t("connections.offers.none")}</p>;
  return (
    <ul className="flex flex-col gap-1.5" data-locum-app-oferece={conexao.id}>
      {libera.gatilhos.map((g) => (
        <li className="flex items-center gap-2 text-sm" key={g}>
          <Badge variant="outline">{t("connections.offers.trigger")}</Badge>
          {t(`automations.triggers.${g}.title`)}
        </li>
      ))}
      {libera.acoes.map((a) => (
        <li className="flex items-center gap-2 text-sm" key={a}>
          <Badge variant="outline">{t("connections.offers.action")}</Badge>
          {t(`automations.steps.${a}.title`)}
        </li>
      ))}
      {conexao.toolCount === null ? null : (
        <li className="flex items-center gap-2 text-sm">
          <Badge variant="outline">{t("connections.offers.tool")}</Badge>
          {t("connections.offers.tools", { count: conexao.toolCount })}
        </li>
      )}
    </ul>
  );
}

/**
 * "Testar conexão": sobe o servidor, pede a lista de ferramentas e diz o que
 * voltou. É a pergunta "isso está funcionando?" respondida sem montar uma
 * automação para descobrir.
 */
function TesteDaConexao({ servidor }: { servidor: string }) {
  const { t } = useTranslation();
  const [estado, setEstado] = useState<EstadoDoTeste>({ fase: "parado" });

  const testar = (): void => {
    setEstado({ fase: "testando" });
    call("mcp.test", servidor).then(
      (teste) => {
        setEstado({ fase: "respondeu", teste });
        // O teste grava o desfecho no cadastro: o estado da conexão acompanha.
        invalidateReads("connections.list");
        invalidateReads("mcp.list");
        invalidateReads("mcp.vinculos");
      },
      // `testConnection` devolve a falha como dado, então chegar aqui quer
      // dizer que a ponte recusou, e não que o servidor está fora do ar.
      (e: unknown) => setEstado({ fase: "recusado", erro: e instanceof Error ? e.message : String(e) }),
    );
  };

  return (
    <div className="flex flex-col gap-2" data-locum-app-teste={servidor}>
      <div>
        <Button
          className="cursor-pointer"
          data-locum-testar={servidor}
          disabled={estado.fase === "testando"}
          onClick={testar}
          size="sm"
          variant="outline"
        >
          {t(estado.fase === "testando" ? "connections.testing" : "connections.test")}
        </Button>
      </div>
      <ResultadoDoTeste estado={estado} nome={servidor} />
    </div>
  );
}

/**
 * Os servidores MCP que as ferramentas da máquina já usam (Claude Code,
 * opencode, Cursor, VS Code, Claude Desktop), para trazer ao Locum. Os já
 * cadastrados vêm desmarcados: reimportar troca o cadastro, e um servidor com
 * o mesmo nome pode ter sido ligado aqui por outro caminho.
 */
type Candidato = Awaited<ReturnType<typeof call<"claudeImport.list">>>[number];

export function ImportarDoClaude({ onPronto }: { onPronto: () => void }) {
  const { t } = useTranslation();
  // Lê arquivos e o shell de login, então vai por chamada e não por leitura.
  const [candidatos, setCandidatos] = useState<{ status: "loading" | "ready"; data: Candidato[] }>({ status: "loading", data: [] });
  useEffect(() => {
    let vivo = true;
    call("claudeImport.list").then(
      (data) => vivo && setCandidatos({ status: "ready", data }),
      (falha: unknown) => {
        if (!vivo) return;
        setCandidatos({ status: "ready", data: [] });
        setErro(falha instanceof Error ? falha.message : String(falha));
      },
    );
    return () => {
      vivo = false;
    };
  }, []);
  const [marcados, setMarcados] = useState<Set<string> | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const lista = candidatos.data;
  const escolhidos = marcados ?? new Set(lista.filter((c) => !c.jaCadastrado).map((c) => c.name));
  const alternar = (nome: string): void => {
    const novo = new Set(escolhidos);
    if (novo.has(nome)) novo.delete(nome);
    else novo.add(nome);
    setMarcados(novo);
  };

  const importar = (): void => {
    setEnviando(true);
    setErro(null);
    call("claudeImport.apply", [...escolhidos]).then(
      () => {
        setEnviando(false);
        onPronto();
      },
      (falha: unknown) => {
        setEnviando(false);
        setErro(falha instanceof Error ? falha.message : String(falha));
      },
    );
  };

  if (candidatos.status === "loading") return <p className="text-muted-foreground text-sm">{t("connections.loading")}</p>;
  if (lista.length === 0) return <p className="text-muted-foreground text-sm">{t("connections.import.empty")}</p>;

  return (
    <div className="flex flex-col gap-4" data-locum-importar="">
      <p className="text-muted-foreground text-sm">{t("connections.import.description")}</p>
      <ul className="flex flex-col gap-1.5">
        {lista.map((c) => (
          <li key={c.name}>
            <label className="border-border hover:bg-muted/40 flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-sm">
              <input
                checked={escolhidos.has(c.name)}
                className="accent-primary mt-1 cursor-pointer"
                onChange={() => alternar(c.name)}
                type="checkbox"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-medium">{c.name}</span>
                  <span className="text-muted-foreground text-xs">{c.origem}</span>
                  {c.jaCadastrado ? <span className="text-sev-medium text-xs">{t("connections.import.exists")}</span> : null}
                  {c.oauth ? <span className="text-muted-foreground text-xs">{t("connections.import.oauth")}</span> : null}
                </span>
                <span className="text-muted-foreground truncate font-mono text-[11px]">{c.destino}</span>
                {c.faltando.length > 0 ? (
                  <span className="text-sev-critical text-xs">
                    {t("connections.import.missing", { names: c.faltando.join(", ") })}
                  </span>
                ) : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div>
        <Button className="cursor-pointer" disabled={enviando || escolhidos.size === 0} onClick={importar} type="button">
          {t(enviando ? "connections.connecting" : "connections.import.submit", { count: escolhidos.size })}
        </Button>
      </div>
      {erro === null ? null : <p className="text-sev-critical text-xs">{erro}</p>}
    </div>
  );
}

export function Propria({ onPronta }: { onPronta: (id: string) => void }) {
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
