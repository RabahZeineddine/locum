import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useRead } from "@/lib/bridge";
import { useRota } from "@/lib/router";
import { cn } from "@/lib/utils";
import { assinarEventosDoTerminal } from "@/lib/terminal";
import { Assistente } from "./assistente";
import { CurrentInitiativeProvider } from "./current-initiative";
import { Paleta } from "./paleta";
import { ROTA_IDS, ROTA_PADRAO, ROTAS, ROTAS_ANTIGAS, ROTAS_DA_BARRA, type TelaProps } from "./rotas";

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
 * A marca: o mesmo desenho do ícone do app. Atrás, em tracejado, a pessoa
 * ausente; na frente, sólido, o Locum ocupando o lugar dela; o selo vermelho
 * é o que espera aprovação. As coordenadas são as do ícone de 1024, reduzidas
 * pelo viewBox, e as cores vêm do tema.
 */
function Marca() {
  return (
    <svg aria-hidden className="size-6 shrink-0" viewBox="0 0 1024 1024">
      <defs>
        <clipPath id="locum-marca">
          <rect height="1024" rx="230" width="1024" />
        </clipPath>
      </defs>
      <g clipPath="url(#locum-marca)">
        <rect fill="var(--secondary)" height="1024" width="1024" />
        <g fill="none" stroke="var(--muted-foreground)" strokeWidth="44">
          <circle cx="640" cy="285" r="125" strokeDasharray="78 53" transform="rotate(-80 640 285)" />
          <path d="M 370 1040 L 370 730 A 270 270 0 0 1 910 730 L 910 1040" strokeDasharray="78 60" />
        </g>
        <circle cx="405" cy="465" r="181" fill="var(--secondary)" />
        <path d="M 69 1040 L 69 940 A 336 336 0 0 1 741 940 L 741 1040 Z" fill="var(--secondary)" />
        <circle cx="405" cy="465" r="135" fill="var(--foreground)" />
        <path d="M 115 1040 L 115 940 A 290 290 0 0 1 695 940 L 695 1040 Z" fill="var(--foreground)" />
        <circle cx="760" cy="190" r="108" fill="var(--secondary)" />
        <circle cx="760" cy="190" r="80" fill="var(--destructive)" />
      </g>
    </svg>
  );
}

/**
 * A casca da janela: barra lateral com os quatro destinos, cabecalho com o
 * titulo do destino ativo, e a tela dele no corpo.
 */
export function Layout() {
  const { t } = useTranslation();
  const { ativa, detalhe, navegar } = useRota(ROTA_IDS, ROTA_PADRAO, ROTAS_ANTIGAS);
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
        <div className="flex items-center gap-2.5 px-4 pt-9 pb-6">
          <Marca />
          <span
            className="text-sidebar-accent-foreground font-semibold text-[15px] tracking-[-0.01em]"
            data-locum-probe="marca"
          >
            Locum
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-2.5 space-y-4">
          {/* Seção Cockpit */}
          <div className="space-y-0.5">
            <span className="px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              Cockpit
            </span>
            {ROTAS_DA_BARRA.filter((r) => r.secao === "cockpit" || !r.secao).slice(0, 2).map(({ id, rotulo, icone: Icone }) => (
              <button
                aria-current={id === ativa ? "page" : undefined}
                className={cn(
                  "group relative flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors duration-200",
                  id === ativa
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium shadow-[inset_0_1px_0_0_oklch(1_0_0/5%)]"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
                data-locum-rota={id}
                key={id}
                onClick={() => navegar(id)}
                type="button"
              >
                {id === ativa && (
                  <i aria-hidden className="ia-gradiente absolute top-1/2 left-0 h-4 w-[3px] -translate-y-1/2 rounded-full" />
                )}
                <Icone className={cn("size-4 transition-colors", id === ativa && "text-primary")} />
                <span className="flex-1">{t(rotulo)}</span>
                {id === "inbox" && naFila > 0 ? (
                  <span className="ia-gradiente text-primary-foreground min-w-5 rounded-full px-1.5 text-center font-semibold text-[11px] leading-5 tabular-nums">
                    {naFila}
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          {/* Seção Operações */}
          <div className="space-y-0.5">
            <span className="px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              Operações
            </span>
            {ROTAS_DA_BARRA.filter((r) => r.secao === "operacoes").map(({ id, rotulo, icone: Icone }) => (
              <button
                aria-current={id === ativa ? "page" : undefined}
                className={cn(
                  "group relative flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors duration-200",
                  id === ativa
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium shadow-[inset_0_1px_0_0_oklch(1_0_0/5%)]"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
                data-locum-rota={id}
                key={id}
                onClick={() => navegar(id)}
                type="button"
              >
                {id === ativa && (
                  <i aria-hidden className="ia-gradiente absolute top-1/2 left-0 h-4 w-[3px] -translate-y-1/2 rounded-full" />
                )}
                <Icone className={cn("size-4 transition-colors", id === ativa && "text-primary")} />
                <span className="flex-1">{t(rotulo)}</span>
              </button>
            ))}
          </div>

          {/* Seção Recursos & Configurações */}
          <div className="space-y-0.5">
            <span className="px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              Recursos
            </span>
            {ROTAS_DA_BARRA.filter((r) => r.secao === "recursos").map(({ id, rotulo, icone: Icone }) => (
              <button
                aria-current={id === ativa ? "page" : undefined}
                className={cn(
                  "group relative flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors duration-200",
                  id === ativa
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium shadow-[inset_0_1px_0_0_oklch(1_0_0/5%)]"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
                data-locum-rota={id}
                key={id}
                onClick={() => navegar(id)}
                type="button"
              >
                {id === ativa && (
                  <i aria-hidden className="ia-gradiente absolute top-1/2 left-0 h-4 w-[3px] -translate-y-1/2 rounded-full" />
                )}
                <Icone className={cn("size-4 transition-colors", id === ativa && "text-primary")} />
                <span className="flex-1">{t(rotulo)}</span>
              </button>
            ))}
          </div>
        </div>

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
            onClick={() => navegar("settings")}
            title={t("nav.versionHint")}
            type="button"
          >
            {t("nav.version", { version: versao.data })}
          </button>
        )}
      </nav>

      <div className="bg-background ia-aurora flex min-w-0 flex-1 flex-col">
        {/*
          A faixa de arrasto é um elemento próprio, acima do que rola, e não uma
          classe no `main`. No Electron a área de arrasto engole os eventos do
          mouse: com o `main` inteiro arrastável, a roda não rolava a tela, o
          `textarea` não recebia clique e texto nenhum se selecionava.
        */}
        <div aria-hidden className="regiao-de-arrasto h-9 shrink-0" data-locum-probe="arrasto" />
        <main
          className="min-h-0 flex-1 overflow-auto px-10 pb-12"
          data-ativo={ativa}
          data-detalhe={detalhe ?? ""}
          data-locum-probe="rota"
        >
          <Tela detalhe={detalhe} navegar={navegar} />
        </main>
      </div>

      <Paleta navegar={navegar} />
      <Assistente navegar={navegar} />
      <SeguirTerminal navegar={navegar} />

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

/**
 * Terminal embutido aberto por outra tela (abrir sessão, retomar conversa)
 * leva a pessoa até ele: a aba Terminal da iniciativa, ou Sessões quando ele
 * não é de iniciativa nenhuma.
 */
function SeguirTerminal({ navegar }: Pick<TelaProps, "navegar">) {
  useEffect(
    () =>
      assinarEventosDoTerminal((evento) => {
        if (evento.tipo !== "aberto") return;
        if (evento.iniciativa === null) navegar("sessions");
        else navegar("initiatives", `${evento.iniciativa}/terminal`);
      }),
    [navegar],
  );
  return null;
}
