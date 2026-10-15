import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { ListGroup, ListRow } from "@/components/ui/list-row";
import { StatusDot, type Estado as EstadoDoPonto } from "@/components/ui/status-dot";
import { CabecalhoDaTela } from "@/components/cabecalho-da-tela";
import { call, invalidateReads, useRead, type ReadResult, type ReadState } from "@/lib/bridge";
import { useAcaoDaTela } from "@/lib/acao-da-tela";
import { acaoDeLigar, destinoDeConexaoAntiga } from "@/lib/conexao-acao";
import { MarcaLogo } from "@/components/marca-logo";
import { buscarConexoes, type ItemDeBusca } from "@/lib/busca-conexoes";
import { liberaDaConexao } from "@/lib/conexao-libera";
import { agruparPorOrigem, origemLegivel, pareceProducao } from "@/lib/importacao-origem";
import { cn } from "@/lib/utils";
import { ArrowLeft, Blocks, Download, Plus, Search, Server, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TelaProps } from "../rotas";
import { Github, Grafana, Slack, SlackOficial, TeamsPeloGraph, Trackers } from "./paineis-de-conexao";
import {
  AvisoDaOrigem,
  DetalhesTecnicos,
  SeloVinculado,
  textoDaOrigem,
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
  // O token mora na parte "Token do GitHub", dentro do detalhe; aqui só o que não tem outro lugar.
  github: () => <Trackers kinds={["github-issues"]} />,
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

  // "Adicionar conexão" pedido pela paleta, com a tela já aberta ou ainda por abrir.
  useAcaoDaTela("adicionar-conexao", () => setAdicionando({ passo: "escolher", busca: "" }));

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
      className="mx-auto flex w-full max-w-5xl flex-col gap-5"
      data-locum-carregada={lista.status === "ready" ? "sim" : "nao"}
      data-locum-ligadas={suas.map((c) => c.id).join(",")}
      data-locum-servidores={suas.flatMap((c) => c.servers).join(",")}
      data-locum-probe="connections"
    >
      <CabecalhoDaTela
        acoes={
          <Button className="cursor-pointer" data-locum-adicionar-conexao="" onClick={() => setAdicionando({ passo: "escolher", busca: "" })}>
            <Plus aria-hidden />
            {t("connections.add.open")}
          </Button>
        }
        descricao={t("connections.lead")}
        titulo={t("connections.title")}
      />

      {claudeCode.status === "ready" && claudeCode.data.desatualizado !== null ? (
        <div className="border-border bg-card flex items-center gap-3 rounded-lg border px-3 py-2 text-xs" data-locum-claude-code-desatualizado="">
          <StatusDot estado="aviso" />
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="font-medium">{t("connections.claudeCodeStale.title")}</p>
            <p className="text-muted-foreground">{t("connections.claudeCodeStale.body", { motivo: t(`connections.claudeCodeStale.motivo.${claudeCode.data.desatualizado}`) })}</p>
            {erroAoCorrigir === null ? null : <p className="text-destructive">{erroAoCorrigir}</p>}
          </div>
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
            variant="outline"
          >
            {t(corrigindo ? "connections.claudeCodeStale.fixing" : "connections.claudeCodeStale.fix")}
          </Button>
        </div>
      ) : null}

      <section className="flex flex-col gap-3" data-locum-probe="suas-conexoes">
        <header className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="text-[13px] font-medium">{t("connections.yours.title")}</h2>
            <span className="text-muted-foreground num truncate text-xs">
              {precisam > 0 ? t("connections.yours.needAttention", { count: precisam }) : suas.length}
            </span>
          </div>
          <label className="relative flex w-64 items-center">
            <Search aria-hidden className="text-muted-foreground pointer-events-none absolute left-2.5 size-3.5" />
            <Input
              aria-label={t("connections.yours.search")}
              className="pr-8 pl-8"
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
              <Kbd className="absolute right-2">/</Kbd>
            ) : (
              <button
                aria-label={t("connections.yours.clearSearch")}
                className="text-muted-foreground hover:text-foreground absolute right-2 cursor-pointer"
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
        </header>

        {lista.status === "loading" ? (
          <p className="text-muted-foreground text-xs">{t("connections.loading")}</p>
        ) : suas.length === 0 && termo === "" ? (
          <EmptyState
            acao={
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  className="cursor-pointer"
                  data-locum-importar-vazio=""
                  onClick={() => setAdicionando({ passo: "importar", busca: "" })}
                  size="sm"
                >
                  <Download aria-hidden />
                  {t("connections.yours.importFromClaude")}
                </Button>
                <Button className="cursor-pointer" onClick={() => setAdicionando({ passo: "escolher", busca: "" })} size="sm" variant="outline">
                  <Plus aria-hidden />
                  {t("connections.add.open")}
                </Button>
              </div>
            }
            icone={<Blocks aria-hidden />}
            titulo={t("connections.yours.empty")}
          />
        ) : (
          <>
            {suasVisiveis.length === 0 ? null : (
              <ListGroup data-locum-busca-suas={termo === "" ? "" : suasVisiveis.map((c) => c.id).join(",")}>
                {suasVisiveis.map((c) => (
                  <ConexaoNaLista conexao={c} key={c.id} onAbrir={() => navegar("connections", c.id)} vinculos={vinculos.data ?? {}} />
                ))}
              </ListGroup>
            )}
            {termo !== "" && doCatalogo.length > 0 ? (
              <div className="flex flex-col gap-1.5" data-locum-busca-catalogo={doCatalogo.map((c) => c.id).join(",")}>
                <h3 className="text-muted-foreground text-[11px] font-medium">{t("connections.yours.fromCatalog")}</h3>
                <ListGroup>
                  {doCatalogo.map((c) => (
                    <ListRow data-locum-catalogo={c.id} key={c.id} rotulo={c.name} onClick={c.state === "soon" ? undefined : () => navegar("connections", c.id)}>
                      <Logo conexao={c} />
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="font-medium">{c.name}</span>
                        <span className="text-muted-foreground truncate text-xs">{t(`connections.catalog.${c.id}.tagline`)}</span>
                      </span>
                      <span className="text-muted-foreground text-xs">{t(c.state === "soon" ? "connections.soon" : "connections.yours.addFromCatalog")}</span>
                    </ListRow>
                  ))}
                </ListGroup>
              </div>
            ) : null}
            {termo !== "" && suasVisiveis.length === 0 && doCatalogo.length === 0 ? (
              <div data-locum-busca-vazia="">
                <EmptyState
                  acao={
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button className="cursor-pointer" onClick={() => setAdicionando({ passo: "propria", busca: termo })} size="sm" variant="outline">
                        <Server aria-hidden />
                        {t("connections.custom.title")}
                      </Button>
                      <Button className="cursor-pointer" onClick={() => setAdicionando({ passo: "importar", busca: termo })} size="sm" variant="outline">
                        <Download aria-hidden />
                        {t("connections.import.title")}
                      </Button>
                    </div>
                  }
                  descricao={t("connections.yours.noResultsHint")}
                  icone={<Search aria-hidden />}
                  titulo={t("connections.yours.noResults", { termo })}
                />
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

function Logo({ conexao, tamanho = "md" }: { conexao: Conexao; tamanho?: "sm" | "md" | "lg" }) {
  return <MarcaLogo fonte={{ name: conexao.id, url: conexao.url }} tamanho={tamanho} />;
}

/** Ligada e autorizada, mas nunca testada: nem verde nem aviso. */
function naoTestada(c: Conexao): boolean {
  return c.state === "connected" && c.reason === "untested";
}

/** Cadastrada e ainda não ligada (o servidor importado entra assim): neutra, com Ligar, sem pedir atenção. */
function desligada(c: Conexao): boolean {
  return c.state === "off";
}

/** O ponto do estado: a cor mora nele, e o texto ao lado é neutro. */
function pontoDoEstado(c: Conexao): EstadoDoPonto {
  if (naoTestada(c) || desligada(c)) return "ocioso";
  if (c.state === "connected") return "ok";
  if (c.state === "attention") return "aviso";
  return "erro";
}

function Estado({ conexao }: { conexao: Conexao }) {
  const { t } = useTranslation();
  if (conexao.state === "available") return null;
  const neutro = naoTestada(conexao) || desligada(conexao);
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs whitespace-nowrap" data-locum-estado-neutro={neutro ? "" : undefined}>
      <StatusDot estado={pontoDoEstado(conexao)} />
      {t(neutro ? (desligada(conexao) ? "connections.state.off" : "connections.state.untested") : `connections.state.${conexao.state}`)}
    </span>
  );
}

/** O porquê do estado, em uma frase curta: o código traduzido, ou o que o servidor respondeu. */
function textoDoEstado(c: Conexao, t: (chave: string, opcoes?: Record<string, unknown>) => string): string | null {
  if (c.reason === null) return null;
  if (c.reason === "failing") return c.detail ?? t("connections.reason.failing");
  return t(`connections.reason.${c.reason}`);
}

/** A linha da conexão: ícone, nome e origem, estado com ponto, ferramentas e a ação. */
function ConexaoNaLista({ conexao, onAbrir, vinculos }: { conexao: Conexao; onAbrir: () => void; vinculos: Record<string, Vinculo> }) {
  const { t } = useTranslation();
  const vinculado = conexao.servers.map((nome) => vinculos[nome]).find((v) => v !== undefined);
  const mudou = conexao.servers.some((nome) => vinculos[nome]?.estado === "mudou" && vinculos[nome]?.mantida === false);
  const sumiu = conexao.servers.some((nome) => vinculos[nome]?.estado === "sumiu" || vinculos[nome]?.estado === "indisponivel");
  const porque = naoTestada(conexao) || desligada(conexao) ? null : textoDoEstado(conexao, t);
  const [erroAoLigar, setErroAoLigar] = useState<string | null>(null);
  const subtitulo = mudou || sumiu ? t(mudou ? "settings.servers.link.changed.title" : "settings.servers.link.gone.title") : (porque ?? conexao.account);
  return (
    <ListRow
      className="min-h-11"
      data-locum-conexao={conexao.id}
      data-locum-conexao-estado={conexao.state}
      onClick={onAbrir}
      rotulo={conexao.name}
    >
      <Logo conexao={conexao} tamanho="sm" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{conexao.name}</span>
          {conexao.custom && vinculado === undefined ? (
            <Badge variant="secondary">{t("connections.custom.badge")}</Badge>
          ) : null}
          {vinculado === undefined ? null : <SeloVinculado vinculo={vinculado} />}
        </span>
        {subtitulo === null || subtitulo === undefined ? null : (
          <span
            className="text-muted-foreground truncate text-xs"
            data-locum-origem-aviso={mudou ? "mudou" : sumiu ? "sumiu" : undefined}
            title={subtitulo}
          >
            {subtitulo}
          </span>
        )}
        {erroAoLigar === null ? null : (
          <span className="text-destructive truncate text-xs" data-locum-ligar-na-lista-erro="">
            {t("settings.servers.turnOnFailed", { message: erroAoLigar })}
          </span>
        )}
      </span>
      <span className="w-28 shrink-0">
        <Estado conexao={conexao} />
      </span>
      <span className="text-muted-foreground num w-28 shrink-0 truncate text-right text-xs">
        {conexao.toolCount !== null
          ? t("connections.offers.tools", { count: conexao.toolCount })
          : conexao.servers.length > 0
            ? t("connections.offers.testToList")
            : ""}
      </span>
      <span className="flex w-28 shrink-0 justify-end" onClick={(e) => e.stopPropagation()}>
        {naoTestada(conexao) && conexao.servers.length > 0 ? <TestarNaLista servidores={conexao.servers} /> : null}
        {desligada(conexao) && conexao.servers.length > 0 ? <LigarNaLista aoFalhar={setErroAoLigar} servidores={conexao.servers} /> : null}
      </span>
    </ListRow>
  );
}

/** "Ligar" direto na linha da conexão desligada: o servidor passa a valer, e o teste vem em seguida. */
function LigarNaLista({ aoFalhar, servidores }: { aoFalhar: (mensagem: string | null) => void; servidores: string[] }) {
  const { t } = useTranslation();
  const [ligando, setLigando] = useState(false);
  return (
    <Button
      className="cursor-pointer"
      data-locum-ligar-na-lista={servidores[0]}
      disabled={ligando}
      onClick={() => {
        setLigando(true);
        aoFalhar(null);
        void Promise.allSettled(servidores.map((s) => call("mcp.setEnabled", s, true)))
          .then((resultados) => {
            const falha = resultados.find((r): r is PromiseRejectedResult => r.status === "rejected");
            if (falha !== undefined) aoFalhar(falha.reason instanceof Error ? falha.reason.message : String(falha.reason));
          })
          .finally(() => {
            setLigando(false);
            invalidateReads("connections.list");
            invalidateReads("mcp.list");
          });
      }}
      size="xs"
      variant="outline"
    >
      {t("settings.servers.turnOn")}
    </Button>
  );
}

/** "Testar" direto na linha: sobe o servidor, e o ponto verde só vem se ele responder. */
function TestarNaLista({ servidores }: { servidores: string[] }) {
  const { t } = useTranslation();
  const [testando, setTestando] = useState(false);
  return (
    <Button
      className="cursor-pointer"
      data-locum-testar-na-lista={servidores[0]}
      disabled={testando}
      onClick={() => {
        setTestando(true);
        void Promise.all(servidores.map((s) => call("mcp.test", s).catch(() => undefined))).finally(() => {
          setTestando(false);
          invalidateReads("connections.list");
          invalidateReads("mcp.list");
        });
      }}
      size="xs"
      variant="outline"
    >
      {t(testando ? "connections.testing" : "connections.test")}
    </Button>
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
        <div className="flex flex-col gap-3" data-locum-probe="adicionar-conexao">
          <p className="text-muted-foreground text-xs">{t("connections.add.description")}</p>

          <label className="relative flex items-center">
            <Search aria-hidden className="text-muted-foreground pointer-events-none absolute left-2.5 size-3.5" />
            <Input
              aria-label={t("connections.search")}
              autoFocus
              className="pl-8"
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

          {visiveis.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t("connections.none")}</p>
          ) : (
            <ListGroup>
              {visiveis.map((c) => (
                <ListRow data-locum-catalogo={c.id} key={c.id} rotulo={c.name} onClick={c.state === "soon" ? undefined : () => onAbrir(c.id)}>
                  <Logo conexao={c} tamanho="sm" />
                  <span className="flex min-w-0 flex-1 items-baseline gap-2">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-muted-foreground truncate text-xs">{t(`connections.catalog.${c.id}.tagline`)}</span>
                  </span>
                  {c.state === "soon" ? <Badge variant="secondary">{t("connections.soon")}</Badge> : null}
                </ListRow>
              ))}
            </ListGroup>
          )}

          <div className="flex flex-col gap-1.5 pt-2">
            <h3 className="text-muted-foreground text-[11px] font-medium">{t("connections.add.others")}</h3>
            <ListGroup>
              <ListRow data-locum-vitrine-propria="" rotulo={t("connections.custom.title")} onClick={() => setPasso("propria")}>
                <span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded">
                  <Server aria-hidden className="size-3.5" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{t("connections.custom.title")}</span>
                  <span className="text-muted-foreground truncate text-xs">{t("connections.add.customHint")}</span>
                </span>
              </ListRow>
              <ListRow data-locum-vitrine-importar="" rotulo={t("connections.import.title")} onClick={() => setPasso("importar")}>
                <span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded">
                  <Download aria-hidden className="size-3.5" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{t("connections.import.title")}</span>
                  <span className="text-muted-foreground truncate text-xs">{t("connections.add.importHint")}</span>
                </span>
              </ListRow>
            </ListGroup>
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
        "h-6 cursor-pointer rounded-md px-2 text-xs transition-colors",
        ativo ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
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
    <div className="sem-arrasto fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onFechar}>
      <aside
        aria-label={titulo}
        aria-modal
        className="border-border bg-background flex h-full w-full max-w-[480px] flex-col border-l"
        data-locum-painel-conexao={id}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <header className="border-border flex items-center gap-3 border-b px-4 py-2.5">
          <h2 className="flex-1 truncate font-medium text-[13px]">{titulo}</h2>
          <Button aria-label={t("connections.close")} className="cursor-pointer" onClick={onFechar} size="icon-sm" variant="ghost">
            <X />
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-3">{children}</div>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ detalhe */

const TITULO_DO_BLOCO = "text-muted-foreground text-[11px] font-medium";

function Bloco({ children, dica, titulo }: { children: ReactNode; dica?: string; titulo: string }) {
  return (
    <section className="flex flex-col gap-1.5">
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
  const [confirmandoDesligar, setConfirmandoDesligar] = useState(false);

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
  const vinculoDaVia = conexao.via === undefined ? undefined : doVinculo[conexao.via];
  const vinculoDoDetalhe = doServidor.map((sv) => doVinculo[sv.config.name]).find((v) => v !== undefined);
  const credencial = (credenciais.data?.refs ?? []).find((r) =>
    r.users.some((u) => u.kind === "mcp" && conexao.servers.includes(u.name)),
  );
  const acaoBruta = acaoDeLigar(conexao);
  // Só vinculado ou com credencial escrita na configuração: não há o que desconectar daqui.
  const semDesligar =
    acaoBruta === "disconnect" && conexao.desligar !== null && conexao.desligar.remove.length === 0 && conexao.desligar.forget.length === 0;
  const acao = semDesligar ? null : acaoBruta;
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
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 pt-2" data-locum-conexao-id={conexao.id} data-locum-probe="conexao">
      <BotaoVoltar onClick={voltar} />

      <header className="flex items-center gap-3">
        <Logo conexao={conexao} tamanho="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h1 className="truncate text-[20px] leading-7 font-semibold tracking-[-0.015em]">{conexao.name}</h1>
          <div className="flex flex-wrap items-center gap-2">
            {conexao.custom ? (
              doServidor.some((s) => doVinculo[s.config.name] !== undefined) ? null : (
                <Badge variant="secondary">{t("connections.custom.badge")}</Badge>
              )
            ) : (
              <span className="text-muted-foreground text-xs">{t(`connections.categories.${conexao.category}`)}</span>
            )}
            {doServidor.map((servidor) => {
              const v = doVinculo[servidor.config.name];
              return v === undefined ? null : <SeloVinculado key={servidor.config.name} vinculo={v} />;
            })}
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="flex min-w-0 flex-col gap-5" data-locum-detalhe-conteudo="">
      <p className="max-w-[68ch] text-[13px] leading-relaxed">
        {conexao.custom
          ? vinculoDoDetalhe === undefined
            ? t("connections.detail.customDescription")
            : t("connections.detail.linkedDescription", { origem: textoDaOrigem(vinculoDoDetalhe, t) })
          : conexao.via !== undefined
            ? t("connections.detail.teamsViaServer", { servidor: conexao.via, origem: vinculoDaVia === undefined ? "" : ` ${textoDaOrigem(vinculoDaVia, t)}` })
            : t(`${chave}.description`)}
      </p>

      {porque === null || (conexao.reason === "disabled" && doServidor.length > 0) ? null : (
        <p
          className="border-border bg-card text-muted-foreground flex items-start gap-2 rounded-lg border px-3 py-2 text-xs break-words"
          data-locum-conexao-motivo={conexao.reason ?? ""}
        >
          <StatusDot className="mt-1" estado={conexao.state === "error" ? "erro" : conexao.reason === "untested" ? "ocioso" : "aviso"} />
          <span>{porque}</span>
        </p>
      )}

      {conexao.partes === null ? null : (
        <PartesDoGithub
          agir={agir}
          emUso={quemUsa.length > 0 || iniciativas.length > 0}
          ocupado={ligando}
          partes={conexao.partes}
          servidores={doServidor}
        />
      )}

      {conexao.state === "soon" ? (
        <p className="border-border text-muted-foreground rounded-lg border border-dashed px-3 py-2 text-xs">{t(`${chave}.soon`)}</p>
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

      {(conexao.partes !== null ? [] : doServidor).map((servidor) => (
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
          <ListGroup data-locum-quem-usa="">
            {quemUsa.map((u) => (
              <ListRow key={`${u.tipo}:${u.id}`} rotulo={u.nome} onClick={() => navegar(u.tipo === "automation" ? "automations" : "agents", u.id)}>
                <Badge variant="secondary">{t(`connections.detail.kind.${u.tipo}`)}</Badge>
                <span className="flex-1 truncate">{u.nome}</span>
                <span className="text-muted-foreground text-xs">{u.como.map((c) => t(`connections.detail.how.${c}`)).join(", ")}</span>
              </ListRow>
            ))}
            {iniciativas.map((titulo) => (
              <ListRow key={`iniciativa:${titulo}`}>
                <Badge variant="secondary">{t("connections.detail.kind.initiative")}</Badge>
                <span className="truncate">{titulo}</span>
              </ListRow>
            ))}
          </ListGroup>
        )}
      </Bloco>

      {painel === undefined ? null : (
        <div data-locum-conexao-config="">
          <Bloco titulo={t("connections.detail.settings")}>
            <div className="divide-border border-border superficie divide-y overflow-hidden rounded-lg border">{painel()}</div>
          </Bloco>
        </div>
      )}

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

        <aside className="flex min-w-0 flex-col gap-5" data-locum-detalhe-lateral="">
          <Bloco titulo={t("connections.detail.status")}>
            <div className="flex flex-col gap-1.5">
              <Estado conexao={conexao} />
              {conexao.account === null ? null : (
                <span className="text-muted-foreground truncate text-xs">{t("connections.detail.account", { account: conexao.account })}</span>
              )}
            </div>
          </Bloco>
      {acao === null ? null : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {acao === "disconnect" ? (
              <Button
                className="cursor-pointer"
                data-locum-desconectar=""
                disabled={ligando}
                onClick={() => (confirmandoDesligar ? agir(() => call("connections.disconnect", conexao.id), () => setConfirmandoDesligar(false)) : setConfirmandoDesligar(true))}
                variant="outline"
              >
                {t(confirmandoDesligar ? "connections.disconnectConfirm" : "connections.disconnect")}
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
          {acao === "disconnect" && confirmandoDesligar && conexao.desligar !== null ? (
            <ul className="text-muted-foreground flex flex-col gap-1 text-xs" data-locum-desligar-plano="">
              {conexao.desligar.remove.length === 0 ? null : <li>{t("connections.disconnectPlan.remove", { names: conexao.desligar.remove.join(", ") })}</li>}
              {conexao.desligar.forget.length === 0 ? null : <li>{t("connections.disconnectPlan.forget", { names: conexao.desligar.forget.join(", ") })}</li>}
              {conexao.desligar.literal.length === 0 ? null : <li>{t("connections.disconnectPlan.literal", { names: conexao.desligar.literal.join(", ") })}</li>}
              {conexao.desligar.keep.length === 0 ? null : <li>{t("connections.disconnectPlan.keep", { names: conexao.desligar.keep.join(", ") })}</li>}
            </ul>
          ) : null}
          {acao === "connect" && conexao.state === "connected" ? (
            <p className="text-muted-foreground text-xs">{t("connections.noServerHint")}</p>
          ) : null}
          <p className="text-muted-foreground text-xs">{t(ligando ? "connections.oauth.waiting" : "connections.oauth.how")}</p>
        </div>
      )}

      {semDesligar && conexao.desligar !== null ? (
        <p className="text-muted-foreground text-xs" data-locum-sem-desligar="">
          {t(conexao.desligar.keep.length > 0 ? "connections.disconnectPlan.onlyLinked" : "connections.disconnectPlan.onlyLiteral", {
            names: [...conexao.desligar.keep, ...conexao.desligar.literal].join(", "),
          })}
        </p>
      ) : null}

      {conexao.partes !== null
        ? null
        : doServidor.map((servidor) => <TesteDaConexao key={servidor.config.name} servidor={servidor.config.name} />)}

      <Bloco dica={t("connections.detail.offersHint")} titulo={t("connections.offers.title")}>
        <Libera conexao={conexao} libera={libera} />
      </Bloco>

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

        </aside>
      </div>
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
  emUso,
  ocupado,
  partes,
  servidores,
}: {
  agir: (fazer: () => Promise<unknown>, depois?: () => void) => void;
  emUso: boolean;
  ocupado: boolean;
  partes: NonNullable<Conexao["partes"]>;
  servidores: ReadResult<"mcp.list">;
}) {
  const { t } = useTranslation();
  const linha = "border-border superficie flex flex-col gap-2 rounded-lg border p-3";
  const doPrincipal = servidores.find((sv) => sv.config.name === partes.nome);
  return (
    <Bloco dica={t("connections.parts.hint")} titulo={t("connections.parts.title")}>
      <div className="flex flex-col gap-2" data-locum-github-partes="">
        <div className={linha} data-locum-parte="token" data-locum-parte-estado={partes.token}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium">{t("connections.parts.token.title")}</span>
            <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
              <StatusDot estado={partes.token === "ok" ? "ok" : "aviso"} />
              {t(`connections.parts.token.${partes.token}`)}
            </span>
          </div>
          <p className="text-muted-foreground text-xs">{t("connections.parts.token.offers")}</p>
          <Github embutido />
        </div>

        <ParteDoServidor
          agir={agir}
          emUso={emUso}
          estado={partes.servidor}
          nome={partes.nome}
          ocupado={ocupado}
          oferece
          servidor={doPrincipal}
          titulo={t("connections.parts.server.title")}
        />
        {partes.outros.map((o) => (
          <ParteDoServidor
            agir={agir}
            emUso={emUso}
            estado={o.estado}
            key={o.nome}
            nome={o.nome}
            ocupado={ocupado}
            oferece={false}
            servidor={servidores.find((sv) => sv.config.name === o.nome)}
            titulo={o.nome}
          />
        ))}
      </div>
    </Bloco>
  );
}

/** Um servidor MCP do GitHub: estado, ligar ou desligar, a falha e o teste. */
function ParteDoServidor({
  agir,
  emUso,
  estado,
  nome,
  ocupado,
  oferece,
  servidor,
  titulo,
}: {
  agir: (fazer: () => Promise<unknown>, depois?: () => void) => void;
  emUso: boolean;
  estado: NonNullable<Conexao["partes"]>["servidor"];
  nome: string | null;
  ocupado: boolean;
  oferece: boolean;
  servidor: ReadResult<"mcp.list">[number] | undefined;
  titulo: string;
}) {
  const { t } = useTranslation();
  const [confirmando, setConfirmando] = useState(false);
  const ruim = estado === "disabled" || estado === "no-credential" || estado === "needs-auth" || estado === "failing";
  const falha = servidor !== undefined && estado === "failing" ? servidor.health.lastError : null;
  return (
    <div
      className="border-border superficie flex flex-col gap-2 rounded-lg border p-3"
      data-locum-parte="servidor"
      data-locum-parte-estado={estado ?? "none"}
      data-locum-parte-servidor={nome ?? ""}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium">{titulo}</span>
        {estado === null ? null : (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            <StatusDot estado={estado === "failing" ? "erro" : estado === "disabled" || estado === "untested" ? "ocioso" : ruim ? "aviso" : "ok"} />
            {t(`connections.parts.server.state.${estado}`)}
          </span>
        )}
        {servidor === undefined || nome === null ? null : (
          <Button
            className="ml-auto cursor-pointer"
            data-locum-ligar-parte={nome}
            disabled={ocupado}
            onClick={() => {
              if (servidor.enabled && emUso && !confirmando) {
                setConfirmando(true);
                return;
              }
              setConfirmando(false);
              agir(() => call("mcp.setEnabled", nome, !servidor.enabled));
            }}
            size="sm"
            variant={servidor.enabled ? "outline" : "default"}
          >
            {t(servidor.enabled ? (confirmando ? "settings.servers.turnOffConfirm" : "connections.parts.server.turnOff") : "connections.parts.server.turnOn")}
          </Button>
        )}
      </div>
      <p className="text-muted-foreground text-xs">{t(estado === null ? "connections.parts.server.none" : oferece ? "connections.parts.server.offers" : "connections.parts.server.other")}</p>
      {confirmando ? <p className="text-muted-foreground text-xs">{t("settings.servers.turnOffInUse")}</p> : null}
      {falha === null || falha === undefined ? null : (
        <pre className="border-destructive/30 bg-destructive/5 text-destructive max-h-48 overflow-auto rounded-md border p-2 font-mono text-[11px] whitespace-pre-wrap">
          {falha}
        </pre>
      )}
      {nome === null && oferece ? (
        <div>
          <Button
            className="cursor-pointer"
            data-locum-ligar-servidor-github=""
            disabled={ocupado}
            onClick={() => agir(() => call("connections.ligarServidorDoGithub"))}
            size="sm"
          >
            {t("connections.parts.server.enable")}
          </Button>
        </div>
      ) : null}
      {nome === null ? null : <TesteDaConexao servidor={nome} />}
    </div>
  );
}

function BotaoVoltar({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      className="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer items-center gap-1.5 text-xs"
      data-locum-voltar-conexoes=""
      onClick={onClick}
      type="button"
    >
      <ArrowLeft aria-hidden className="size-3.5" />
      {t("connections.title")}
    </button>
  );
}

/** Gatilhos e ações de app que a conexão libera, e quantas ferramentas ela tem. */
function Libera({ conexao, libera }: { conexao: Conexao; libera: ReturnType<typeof liberaDaConexao> }) {
  const { t } = useTranslation();
  // Chamar ferramenta é o que as ferramentas listadas abaixo já dizem: sem ação de app própria, a seção não inventa uma.
  const acoes = libera.acoes.filter((a) => a !== "mcp.call");
  const vazio = libera.gatilhos.length === 0 && acoes.length === 0 && conexao.toolCount === null;
  const semLista = conexao.servers.length > 0 && conexao.toolCount === null;
  if (vazio) return <p className="text-muted-foreground text-xs">{t("connections.offers.none")}</p>;
  return (
    <ul className="flex flex-col gap-1.5" data-locum-app-oferece={conexao.id}>
      {conexao.via === undefined ? null : (
        <li className="text-muted-foreground text-xs" data-locum-teams-via={conexao.via}>
          {t(conexao.reason === "disabled" ? "connections.offers.viaServerOff" : "connections.offers.viaServer", {
            server: conexao.via,
          })}
        </li>
      )}
      {libera.gatilhos.map((g) => (
        <li className="flex items-center gap-2 text-[13px]" key={g}>
          <Badge variant="secondary">{t("connections.offers.trigger")}</Badge>
          {t(`automations.triggers.${g}.title`)}
        </li>
      ))}
      {acoes.map((a) => (
        <li className="flex items-center gap-2 text-[13px]" key={a}>
          <Badge variant="secondary">{t("connections.offers.action")}</Badge>
          {t(`automations.steps.${a}.title`)}
        </li>
      ))}
      {semLista ? <li className="text-muted-foreground text-xs">{t("connections.offers.none")}</li> : null}
      {conexao.toolCount === null ? null : (
        <li className="flex items-center gap-2 text-[13px]">
          <Badge variant="secondary">{t("connections.offers.tool")}</Badge>
          {t("connections.offers.tools", { count: conexao.toolCount })}
          {conexao.toolCount > 0 ? (
            <span className="text-muted-foreground text-xs" data-locum-ferramentas-classe="">
              {t("connections.offers.toolsSplit", { reads: Math.max(conexao.toolCount - conexao.toolWrites, 0), writes: conexao.toolWrites })}
            </span>
          ) : null}
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
 * cadastrados e os de produção também vêm desmarcados, como todos: importar vincula
 * o servidor à origem, e quem escolhe é a pessoa.
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
  // Nada vem marcado: importar liga uma origem a este app, e quem escolhe é a pessoa.
  const escolhidos = marcados ?? new Set<string>();
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
      {agruparPorOrigem(lista).map((grupo) => {
        const origem = origemLegivel(grupo.origem);
        return (
          <section className="flex flex-col gap-1.5" data-locum-importar-origem={grupo.origem} key={grupo.origem}>
            <h3 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
              {t(`connections.import.origin.${origem.tipo}`, { name: origem.nome })}
            </h3>
            <ul className="flex flex-col gap-1.5">
              {grupo.itens.map((c) => (
                <li key={c.name}>
                  <label className="border-border hover:bg-muted/40 flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-sm">
                    <input
                      checked={escolhidos.has(c.name)}
                      className="accent-primary mt-1 cursor-pointer"
                      onChange={() => alternar(c.name)}
                      type="checkbox"
                    />
                    <MarcaLogo fonte={{ name: c.name, ...(c.transport === "stdio" ? {} : { url: c.destino }) }} tamanho="sm" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-medium">{c.name}</span>
                        {c.jaCadastrado ? <span className="text-sev-medium text-xs">{t("connections.import.exists")}</span> : null}
                        {c.oauth ? <span className="text-muted-foreground text-xs">{t("connections.import.oauth")}</span> : null}
                      </span>
                      <span className="text-muted-foreground truncate font-mono text-[11px]">{c.destino}</span>
                      {pareceProducao(c) ? (
                        <span className="text-sev-medium text-xs" data-locum-importar-producao={c.name}>
                          {t("connections.import.production")}
                        </span>
                      ) : null}
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
          </section>
        );
      })}
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
