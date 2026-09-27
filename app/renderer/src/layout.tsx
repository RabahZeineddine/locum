import { useTranslation } from "react-i18next";
import { useRead } from "@/lib/bridge";
import { useRota } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Assistente } from "./assistente";
import { CurrentInitiativeProvider } from "./current-initiative";
import { Paleta } from "./paleta";
import { ROTA_IDS, ROTA_PADRAO, ROTAS } from "./rotas";

/**
 * Estado da ponte, no rodape da barra lateral.
 *
 * Ele e so desenho: as leituras ficam no layout, porque a contagem da fila
 * tambem aparece ao lado da inbox e ler o mesmo canal nos dois lugares seriam
 * duas viagens pelo IPC para a mesma pergunta.
 *
 * O marcador existe para o smoke, que roda sem ninguem olhando e precisa
 * comparar o que a janela enxergou com o que os servicos devolvem do outro
 * lado. Ele carrega os identificadores dos agents, e nao so a contagem, porque
 * contagem igual por acaso passaria sem a ponte ter trazido nada.
 *
 * O texto sai do dicionário, com plural de verdade: em português a contagem
 * troca a palavra, e um "execucao(oes)" entre parênteses é o que se escreve
 * quando não há de onde tirar a forma certa.
 */
function Ponte({
  agents,
  erro,
  estado,
  execucoes,
  naFila,
}: {
  agents: string[];
  erro: { channel: string; message: string } | undefined;
  estado: "carregando" | "erro" | "pronto";
  execucoes: number;
  naFila: number;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="border-border border-t px-3 py-3 text-muted-foreground text-xs"
      data-agents={agents.join(",")}
      data-erro={erro?.message ?? ""}
      data-estado={estado}
      data-locum-probe="ponte"
      data-pendencias={naFila}
      data-runs={execucoes}
    >
      {erro !== undefined ? (
        <span>{t("bridge.refused", { channel: erro.channel, message: erro.message })}</span>
      ) : estado === "carregando" ? (
        <span>{t("bridge.loading")}</span>
      ) : (
        <span>
          {t("bridge.agents", { count: agents.length })},{" "}
          {t("bridge.runs", { count: execucoes })}
        </span>
      )}
    </div>
  );
}

/**
 * A casca da janela: barra lateral com os quatro destinos, cabecalho com o
 * titulo do destino ativo, e a tela dele no corpo.
 */
export function Layout() {
  const { t } = useTranslation();
  const { ativa, detalhe, navegar } = useRota(ROTA_IDS, ROTA_PADRAO);
  const rota = ROTAS.find((r) => r.id === ativa) ?? ROTAS[0];
  const { Tela } = rota;

  const agents = useRead("agents.list");
  const runs = useRead("runs.list");
  const pendencias = useRead("approvals.listPending");
  const versao = useRead("app.version");

  const erro = agents.error ?? runs.error ?? pendencias.error;
  const carregando =
    agents.status === "loading" || runs.status === "loading" || pendencias.status === "loading";
  const estado = erro !== undefined ? "erro" : carregando ? "carregando" : "pronto";
  const naFila = pendencias.data?.length ?? -1;

  return (
    <CurrentInitiativeProvider ativa={ativa} detalhe={detalhe}>
    <div className="flex h-screen text-foreground">
      <nav className="regiao-de-arrasto bg-sidebar border-sidebar-border flex w-56 shrink-0 flex-col border-r">
        <div
          className="text-sidebar-foreground px-4 pt-8 pb-5 font-semibold text-[13px] tracking-[0.01em]"
          data-locum-probe="marca"
        >
          Locum
        </div>

        <ul className="flex-1 space-y-1 px-2">
          {ROTAS.map(({ id, rotulo, icone: Icone }) => (
            <li key={id}>
              <button
                aria-current={id === ativa ? "page" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                  id === ativa
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
                )}
                data-locum-rota={id}
                onClick={() => navegar(id)}
                type="button"
              >
                <Icone className="size-4" />
                <span className="flex-1">{t(rotulo)}</span>
                {id === "inbox" && naFila > 0 ? (
                  <span className="rounded-full bg-primary px-1.5 text-primary-foreground text-xs">
                    {naFila}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>

        <Ponte
          agents={(agents.data ?? []).map((a) => a.id)}
          erro={erro}
          estado={estado}
          execucoes={runs.data?.length ?? -1}
          naFila={naFila}
        />
        {versao.data === undefined ? null : (
          <button
            className="px-3 pb-3 text-left text-[11px] text-muted-foreground/70 hover:text-muted-foreground"
            data-locum-probe="versao"
            onClick={() => navegar("configuracao")}
            title={t("nav.versionHint")}
            type="button"
          >
            {t("nav.version", { version: versao.data })}
          </button>
        )}
      </nav>

      <div className="bg-background flex min-w-0 flex-1 flex-col">
        {/*
          A faixa de arrasto é um elemento próprio, acima do que rola, e não uma
          classe no `main`. No Electron a área de arrasto engole os eventos do
          mouse: com o `main` inteiro arrastável, a roda não rolava a tela, o
          `textarea` não recebia clique e texto nenhum se selecionava.
        */}
        <div aria-hidden className="regiao-de-arrasto h-9 shrink-0" data-locum-probe="arrasto" />
        <main
          className="min-h-0 flex-1 overflow-auto px-8 pb-10"
          data-ativo={ativa}
          data-detalhe={detalhe ?? ""}
          data-locum-probe="rota"
        >
          <Tela detalhe={detalhe} navegar={navegar} />
        </main>
      </div>

      <Paleta navegar={navegar} />
      <Assistente />

      {/*
        Marcador do smoke. Ele confere que este elemento esta com display none,
        o que so acontece se a folha construida pelo Tailwind chegou na pagina:
        raiz montada prova o React, nao prova o CSS.

        Sem texto dentro, e de propósito: o que está sendo medido é o estilo
        calculado, e frase nenhuma precisa existir aqui para isso. Uma que
        existisse seria texto fora do dicionário sem ninguém para ler.
      */}
      <span className="hidden" data-locum-probe="tailwind" />
    </div>
    </CurrentInitiativeProvider>
  );
}
