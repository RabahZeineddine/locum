import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { sairDaTela } from "@/lib/saida-do-editor";
import { X } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RotaId, TelaProps } from "../rotas";
import { Agents } from "../telas/agents";

/**
 * O agent da biblioteca aberto sobre o editor, sem sair dele.
 *
 * Mostra a própria tela de Agents (editar, conversar e testar, ferramentas)
 * num modal. A navegação de dentro dela fica dentro: ir para o agent ou voltar
 * à lista fecha o modal, e qualquer outro destino sai pelo `navegar` de fora,
 * que pede confirmação se o editor tem mudança. Fechar o modal (Esc, clique
 * fora, X ou voltar) pergunta antes se o formulário do agent tem mudança não
 * salva, e o atalho do menu com o modal aberto passa pela mesma pergunta antes
 * da do editor (a guarda do formulário é de nível 1, a do editor de nível 0).
 * Ao fechar, devolve o id do
 * agent que foi criado ou aberto por último, para o passo poder escolhê-lo.
 */
/** O formulário do agent no modal guarda a saída um nível acima do editor (nível 0). */
const NIVEL_DO_MODAL = 1;

export function ModalDeAgent({
  detalhe,
  navegar,
  fechar,
}: {
  /** `novo` cria; outro valor abre o agent de mesmo id. */
  detalhe: string;
  navegar: (id: RotaId, detalhe?: string) => void;
  fechar: (idDoAgent: string | null) => void;
}) {
  const { t } = useTranslation();
  const [atual, setAtual] = useState(detalhe);
  const ultimo = useRef<string | null>(detalhe === "novo" ? null : detalhe);

  // Fechar só o modal pergunta só a guarda do formulário (nível 1).
  const pedirParaFechar = (): void => sairDaTela(() => fechar(ultimo.current), NIVEL_DO_MODAL);

  const dentro: TelaProps["navegar"] = (id, resto) => {
    // Outro destino sai pelo `navegar` de fora, que consulta a guarda do formulário e depois a do editor.
    if (id !== "agents") {
      navegar(id, resto);
      return;
    }
    if (resto === undefined) {
      pedirParaFechar();
      return;
    }
    sairDaTela(() => {
      if (resto !== "novo" && resto !== "toolsets") ultimo.current = resto;
      setAtual(resto);
    }, NIVEL_DO_MODAL);
  };

  return (
    <Dialog onOpenChange={(aberto) => !aberto && pedirParaFechar()} open>
      <DialogContent
        aria-describedby={undefined}
        className="h-[85vh] max-w-5xl gap-0 p-0"
        data-locum-probe="agent-modal"
      >
        <DialogTitle className="sr-only">{t("automations.agentModal.title")}</DialogTitle>
        <DialogDescription className="sr-only">{t("automations.agentModal.title")}</DialogDescription>
        <button
          aria-label={t("automations.agentModal.close")}
          className="text-muted-foreground hover:text-foreground absolute top-3 right-3 z-20 cursor-pointer rounded p-1"
          data-locum-agent-modal-fechar=""
          onClick={pedirParaFechar}
          type="button"
        >
          <X className="size-4" />
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <Agents detalhe={atual} navegar={dentro} nivelDaGuarda={NIVEL_DO_MODAL} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
