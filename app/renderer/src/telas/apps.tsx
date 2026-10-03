import { CabecalhoDaTela } from "@/components/cabecalho-da-tela";
import { useTranslation } from "react-i18next";
import type { TelaProps } from "../rotas";
import { ConexoesDoLocum } from "./configuracao";

/**
 * Apps: o que o Locum sabe usar, cada um com um botão de ligar.
 *
 * Saiu de dentro da Configuração porque conectar é o primeiro passo de
 * qualquer automação, e ficava três cliques escondido. Canal, filtro e destino
 * não moram aqui: moram na automação que usa o app.
 */
export function Apps(_props: TelaProps) {
  const { t } = useTranslation();
  return (
    <div className="flex max-w-5xl flex-col gap-8" data-locum-probe="apps">
      <CabecalhoDaTela descricao={t("apps.lead")} titulo={t("apps.title")} />
      <ConexoesDoLocum />
    </div>
  );
}
