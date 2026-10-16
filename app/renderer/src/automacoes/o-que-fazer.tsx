import { appDoServidor, operacoesDoApp, type OperacaoDoApp } from "@/lib/apps-da-paleta";
import { tituloDoGrupo, tradutorDe } from "@/lib/operacao-da-ferramenta";
import { casaBusca } from "@/lib/paleta-conexoes";
import { cn } from "@/lib/utils";
import { useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { FerramentasDasConexoes } from "./ferramentas-das-conexoes";

/**
 * "O que fazer?": as operações de um app, as do Locum primeiro e as
 * ferramentas dos servidores por recurso, com busca. Seta para cima e para
 * baixo andam pela lista; Enter escolhe.
 */
export function OQueFazer({
  app,
  conexoes,
  aoEscolher,
}: {
  app: string;
  conexoes: FerramentasDasConexoes;
  aoEscolher: (operacao: OperacaoDoApp) => void;
}) {
  const { t, i18n } = useTranslation();
  const [busca, setBusca] = useState("");
  const traduzir = useMemo(() => tradutorDe(i18n), [i18n, i18n.language]);
  const paleta = conexoes.servidores.map((servidor) => ({ servidor, ferramentas: conexoes.porServidor[servidor]?.tools ?? null }));
  const { nativas, grupos, servidores } = operacoesDoApp(app, paleta, traduzir);
  // Servidor sem lista lida: o do próprio app, e o ms365 também no Teams, que herda as ferramentas de chat dele.
  const sem = paleta.filter(
    (c) => c.ferramentas === null && (appDoServidor(c.servidor) === app || (app === "teams" && appDoServidor(c.servidor) === "microsoft365")),
  );
  const casa = (o: OperacaoDoApp): boolean => casaBusca(busca, o.titulo, o.ferramenta, o.acao, o.descricao);
  const nativasVisiveis = nativas.filter(casa);
  const gruposVisiveis = grupos.map((g) => ({ ...g, itens: g.itens.filter(casa) })).filter((g) => g.itens.length > 0);
  const vazio = nativasVisiveis.length === 0 && gruposVisiveis.length === 0;

  const andar = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const botoes = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-locum-operacao]")];
    const campo = e.currentTarget.querySelector<HTMLElement>("[data-locum-operacao-busca]");
    const atual = botoes.indexOf(document.activeElement as HTMLElement);
    const proximo = e.key === "ArrowDown" ? atual + 1 : atual - 1;
    e.preventDefault();
    (proximo < 0 ? campo : botoes[Math.min(proximo, botoes.length - 1)])?.focus();
  };

  const Linha = ({ o }: { o: OperacaoDoApp }) => (
    <li>
      <button
        className="hover:bg-accent focus-visible:ring-ring/40 flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] outline-none transition-colors focus-visible:ring-2"
        data-locum-operacao={o.chave}
        data-locum-operacao-classe={o.leitura ? "leitura" : "escrita"}
        onClick={() => aoEscolher(o)}
        title={o.descricao === "" ? o.titulo : o.descricao}
        type="button"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="line-clamp-2 leading-4">{o.titulo}</span>
          {servidores.length > 1 && o.servidor !== undefined ? <span className="text-muted-foreground text-[11px]">{o.servidor}</span> : null}
          {o.tipo === "nativa" ? <span className="text-muted-foreground text-[11px]">{t("automations.palette.fromLocum")}</span> : null}
        </span>
        <span className={cn("shrink-0 rounded px-1 py-0.5 text-[10px]", o.leitura ? "bg-muted" : "bg-amber-500/15")}>
          {t(o.leitura ? "automations.palette.read" : "automations.palette.write")}
        </span>
      </button>
    </li>
  );

  return (
    <div className="flex flex-col gap-2" data-locum-o-que-fazer={app} onKeyDown={andar}>
      <h3 className="text-sm font-medium">{t("automations.palette.whatToDo")}</h3>
      <input
        aria-label={t("automations.palette.searchOperation")}
        className="border-input focus-visible:border-ring focus-visible:ring-ring/40 rounded-md border bg-transparent px-2 py-1 text-[13px] outline-none focus-visible:ring-2"
        data-locum-operacao-busca=""
        onChange={(e) => setBusca(e.target.value)}
        placeholder={t("automations.palette.searchOperation")}
        value={busca}
      />
      {nativasVisiveis.length === 0 ? null : (
        <ul>
          {nativasVisiveis.map((o) => (
            <Linha key={o.chave} o={o} />
          ))}
        </ul>
      )}
      {gruposVisiveis.map((g) => (
        <section key={g.recurso ?? "outras"}>
          <h4 className="text-muted-foreground px-1.5 pb-0.5 text-[11px] font-medium">{tituloDoGrupo(g.recurso, traduzir)}</h4>
          <ul>
            {g.itens.map((o) => (
              <Linha key={o.chave} o={o} />
            ))}
          </ul>
        </section>
      ))}
      {sem.map((c) => {
        const estado = conexoes.porServidor[c.servidor];
        return (
          <div className="px-1.5 text-[11px]" key={c.servidor}>
            {estado?.erro == null ? null : <p className="text-destructive">{estado.erro}</p>}
            <button
              className="text-primary cursor-pointer hover:underline disabled:opacity-50"
              data-locum-operacao-carregar={c.servidor}
              disabled={estado?.carregando === true}
              onClick={() => void conexoes.carregar(c.servidor)}
              type="button"
            >
              {t(estado?.carregando === true ? "automations.palette.loadingTools" : "automations.palette.loadTools")} ({c.servidor})
            </button>
          </div>
        );
      })}
      {vazio && sem.length === 0 ? <p className="text-muted-foreground px-1.5 text-[11px]">{t("automations.palette.noOperations")}</p> : null}
    </div>
  );
}
