import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Archive, ArchiveRestore, Download, MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DialogoDeArquivar } from "./arquivar-automacao";
import { DialogoDeDeletar } from "./deletar-automacao";

/**
 * O "⋯" do cabeçalho do editor: as ações da automação que não são o caminho
 * principal da tela. Arquivar e deletar abrem o diálogo com a prévia; deletar só
 * vale para a arquivada, e o item diz isso em vez de sumir.
 */
export function MenuDaAutomacao({
  agentId,
  nome,
  arquivada,
  podeArquivar,
  ocupado,
  edicaoNaoSalva,
  exportar,
  exportarDesabilitado,
  exportarDica,
  desarquivar,
  aoArquivar,
  aoDeletar,
}: {
  agentId: string;
  nome: string;
  arquivada: boolean;
  /** Falso na automação ainda não gravada e na do sistema: não há o que arquivar ou deletar. */
  podeArquivar: boolean;
  ocupado: boolean;
  edicaoNaoSalva: boolean;
  exportar: () => void;
  exportarDesabilitado: boolean;
  exportarDica: string;
  desarquivar: () => void;
  aoArquivar: () => void;
  aoDeletar: () => void;
}) {
  const { t } = useTranslation();
  const [dialogo, setDialogo] = useState<"arquivar" | "deletar" | null>(null);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button aria-label={t("automations.editor.menu.label")} className="cursor-pointer" data-locum-automacao-menu="" size="icon-sm" variant="ghost">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent data-locum-automacao-menu-conteudo="">
          <DropdownMenuItem data-locum-automacao-exportar="" disabled={exportarDesabilitado} onSelect={exportar} title={exportarDica}>
            <Download />
            {t("pacote.export.button")}
          </DropdownMenuItem>
          {podeArquivar ? (
            <>
              <DropdownMenuSeparator />
              {arquivada ? (
                <DropdownMenuItem data-locum-automacao-desarquivar-menu="" disabled={ocupado} onSelect={desarquivar}>
                  <ArchiveRestore />
                  {t("automations.list.unarchive")}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem data-locum-automacao-arquivar="" disabled={ocupado} onSelect={() => setDialogo("arquivar")}>
                  <Archive />
                  {t("automations.editor.archive.button")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem data-locum-automacao-deletar="" disabled={ocupado || !arquivada} onSelect={() => setDialogo("deletar")} variant="destructive">
                <Trash2 />
                <span className="flex flex-col">
                  {t("automations.editor.menu.delete")}
                  {arquivada ? null : <span className="text-muted-foreground text-[11px] font-normal">{t("automations.editor.menu.deleteNeedsArchive")}</span>}
                </span>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {dialogo === "arquivar" ? <DialogoDeArquivar agentId={agentId} aoArquivar={aoArquivar} aoFechar={() => setDialogo(null)} edicaoNaoSalva={edicaoNaoSalva} nome={nome} /> : null}
      {dialogo === "deletar" ? <DialogoDeDeletar agentId={agentId} aoDeletar={aoDeletar} aoFechar={() => setDialogo(null)} nome={nome} /> : null}
    </>
  );
}
