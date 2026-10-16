import { MarcaLogo } from "@/components/marca-logo";
import { appsDaPaleta, fonteDaMarca, nomeDoApp, passoDaOperacao, reconhecerPasso, tituloDaOperacaoDoPasso, type OperacaoDoApp } from "@/lib/apps-da-paleta";
import { tradutorDe } from "@/lib/operacao-da-ferramenta";
import type { AgentSpec, Step } from "../../../src/config/types";
import { ChevronsUpDown } from "lucide-react";
import { Popover } from "radix-ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { FerramentasDasConexoes } from "./ferramentas-das-conexoes";
import { OQueFazer } from "./o-que-fazer";

/**
 * O topo do painel de um passo de app: "App · Operação" num botão que abre a
 * lista de operações do app, com busca e teclado. Escolher outra troca o passo
 * por `passoDaOperacao`, que guarda os campos de mesmo nome.
 */
export function TrocaDeOperacao({
  passo,
  spec,
  conexoes,
  trocar,
}: {
  passo: Extract<Step, { type: "action" }>;
  spec: AgentSpec;
  conexoes: FerramentasDasConexoes;
  trocar: (novo: Extract<Step, { type: "action" }>) => void;
}) {
  const { t, i18n } = useTranslation();
  const [aberto, setAberto] = useState(false);
  const traduzir = tradutorDe(i18n);
  const { app } = reconhecerPasso(passo);
  const paleta = conexoes.servidores.map((servidor) => ({ servidor, ferramentas: conexoes.porServidor[servidor]?.tools ?? null }));
  const doApp = appsDaPaleta(paleta).find((a) => a.id === app) ?? { id: app, nativas: [], servidores: [], semLista: false };
  const operacao = tituloDaOperacaoDoPasso(passo, traduzir) ?? t("automations.canvas.chooseWhat");

  const escolher = (nova: OperacaoDoApp): void => {
    trocar(passoDaOperacao(spec, nova, passo) as Extract<Step, { type: "action" }>);
    setAberto(false);
  };

  return (
    <Popover.Root onOpenChange={setAberto} open={aberto}>
      <Popover.Trigger asChild>
        <button
          aria-label={t("automations.panel.changeOperation")}
          className="hover:bg-accent focus-visible:ring-ring/40 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md p-1 text-left outline-none focus-visible:ring-2"
          data-locum-troca-operacao=""
          type="button"
        >
          <MarcaLogo fonte={{ name: fonteDaMarca(doApp) }} tamanho="sm" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={`${nomeDoApp(app, traduzir)} · ${operacao}`}>
            {nomeDoApp(app, traduzir)} · {operacao}
          </span>
          <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          className="bg-popover border-border z-50 max-h-96 w-72 overflow-y-auto rounded-md border p-2 shadow-md"
          data-locum-troca-lista=""
          sideOffset={4}
        >
          <OQueFazer aoEscolher={escolher} app={app} conexoes={conexoes} semTitulo />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
