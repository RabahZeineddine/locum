import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
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
 * que pede confirmação se o editor tem mudança. Ao fechar, devolve o id do
 * agent que foi criado ou aberto por último, para o passo poder escolhê-lo.
 */
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

  const dentro: TelaProps["navegar"] = (id, resto) => {
    if (id !== "agents") {
      fechar(ultimo.current);
      navegar(id, resto);
      return;
    }
    if (resto === undefined) {
      fechar(ultimo.current);
      return;
    }
    if (resto !== "novo" && resto !== "toolsets") ultimo.current = resto;
    setAtual(resto);
  };

  return (
    <Dialog onOpenChange={(aberto) => !aberto && fechar(ultimo.current)} open>
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
          onClick={() => fechar(ultimo.current)}
          type="button"
        >
          <X className="size-4" />
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <Agents detalhe={atual} navegar={dentro} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
