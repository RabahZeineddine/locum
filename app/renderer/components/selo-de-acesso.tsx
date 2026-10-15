import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/status-dot";
import { useTranslation } from "react-i18next";

/** Leitura é um selo neutro; escrita ganha só o ponto de aviso, porque é ela que precisa de atenção. */
export function SeloDeAcesso({ leitura }: { leitura: boolean }) {
  const { t } = useTranslation();
  return (
    <Badge data-locum-acesso={leitura ? "leitura" : "escrita"} variant={leitura ? "secondary" : "outline"}>
      {leitura ? null : <StatusDot estado="aviso" />}
      {t(leitura ? "library.editor.read" : "library.editor.write")}
    </Badge>
  );
}
