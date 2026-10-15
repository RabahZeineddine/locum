import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "./layout";

/**
 * A janela inteira e o layout: barra lateral, cabecalho e a tela do destino
 * ativo. O roteamento mora no layout porque a barra e o corpo precisam
 * concordar sobre qual destino esta ativo, e separar os dois so criaria duas
 * fontes para a mesma pergunta.
 */
export function App() {
  return (
    <TooltipProvider delayDuration={300}>
      <Layout />
    </TooltipProvider>
  );
}
