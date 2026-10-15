import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRead, type ReadResult } from "@/lib/bridge";
import { nomeDoPadrao } from "@/lib/padrao-do-repo";
import { useTranslation } from "react-i18next";
import type { TelaProps } from "../rotas";

type Gatilho = ReadResult<"triggers.schedule">[number];

const ROTULO_DA_AUTORIA = {
  any: "settings.watched.authorshipAny",
  mine: "settings.watched.authorshipMine",
  others: "settings.watched.authorshipOthers",
} as const;

/**
 * O que este agent observa no GitHub, só para ler.
 *
 * O gatilho é desenhado num lugar só, o editor da automação, onde estão os
 * filtros, a prévia e os descartes. Aqui fica o resumo de cada gatilho de
 * varredura do agent e o caminho para editá-lo; quem ainda não tem nenhum vê
 * como criar o primeiro, que abre o editor já com um gatilho do GitHub novo.
 */
export function GatilhosDoAgent({ agentId, navegar }: { agentId: string; navegar: TelaProps["navegar"] }) {
  const { i18n, t } = useTranslation();
  const agenda = useRead("triggers.schedule");

  const gatilhos = (agenda.data ?? []).filter((g) => g.kind === "poll" && g.agentId === agentId);
  const quando = (ms: number | null): string =>
    ms === null ? t("settings.watched.never") : new Date(ms).toLocaleString(i18n.language);

  return (
    <div
      className="flex min-w-0 flex-col gap-3 px-4 py-3"
      data-locum-observados={gatilhos.map((g) => g.triggerId).join(",")}
      data-locum-probe="observados"
    >
      {agenda.status === "error" ? (
        <p className="text-destructive text-xs" data-locum-observados-erro={agenda.error.message}>
          {t("settings.watched.refused", { message: agenda.error.message })}
        </p>
      ) : null}

      {agenda.status === "ready" && gatilhos.length === 0 ? (
        <div className="flex flex-col items-start gap-2" data-locum-observados-vazio="">
          <p className="text-muted-foreground text-sm">{t("settings.watched.empty")}</p>
          <Button
            className="cursor-pointer"
            data-locum-observados-criar=""
            onClick={() => navegar("automations", `${agentId}/gatilho/novo`)}
            size="sm"
            variant="secondary"
          >
            {t("settings.watched.create")}
          </Button>
        </div>
      ) : (
        <ul className="flex min-w-0 flex-col gap-2">
          {gatilhos.map((gatilho) => (
            <LinhaDoGatilho
              aoEditar={() => navegar("automations", `${agentId}/gatilho/${gatilho.triggerId}`)}
              gatilho={gatilho}
              key={gatilho.triggerId}
              quando={quando}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function LinhaDoGatilho({
  gatilho,
  aoEditar,
  quando,
}: {
  gatilho: Gatilho;
  aoEditar: () => void;
  quando: (ms: number | null) => string;
}) {
  const { i18n, t } = useTranslation();
  const config = gatilho.config;
  if (config.kind !== "poll") return null;

  const alvo = t("settings.watched.target", {
    owner: config.owner ?? t("settings.watched.fromEnv"),
    repo: nomeDoPadrao(config.repoMatch),
  });
  const filtros = Object.keys(config.filters ?? {}).length;

  return (
    <li
      className="border-border flex min-w-0 flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm"
      data-locum-gatilho={gatilho.triggerId}
      data-locum-gatilho-alvo={`${config.owner ?? ""}/${config.repoMatch}`}
      data-locum-gatilho-autoria={config.authorship}
      data-locum-gatilho-filtros={filtros}
      data-locum-gatilho-habilitado={gatilho.enabled ? "sim" : "nao"}
      data-locum-gatilho-proxima={gatilho.nextDueAt ?? ""}
      data-locum-gatilho-ultima={gatilho.lastFireAt ?? ""}
    >
      <span className="min-w-0 max-w-full truncate font-mono text-xs" title={alvo}>
        {alvo}
      </span>
      {config.authorship === "any" ? null : (
        <span className="text-muted-foreground text-xs">
          {t("settings.watched.by", { authorship: t(ROTULO_DA_AUTORIA[config.authorship]) })}
        </span>
      )}
      {filtros === 0 ? null : (
        <span className="text-muted-foreground text-xs">{t("settings.watched.filters", { count: filtros })}</span>
      )}
      <Badge variant={gatilho.enabled ? "secondary" : "outline"}>
        {t(gatilho.enabled ? "settings.watched.on" : "settings.watched.off")}
      </Badge>
      <span className="text-muted-foreground text-xs">{t("settings.watched.every", { count: gatilho.everyMinutes ?? 0 })}</span>

      <Button
        className="ml-auto cursor-pointer"
        data-locum-gatilho-editar={gatilho.triggerId}
        onClick={aoEditar}
        size="sm"
        variant="ghost"
      >
        {t("settings.watched.edit")}
      </Button>

      {gatilho.lastError === null ? null : (
        <p className="text-destructive w-full min-w-0 break-words text-xs" data-locum-gatilho-erro={gatilho.lastError.tipo}>
          {t(`automations.github.error.${gatilho.lastError.tipo}`, { when: new Date(gatilho.lastError.em).toLocaleString(i18n.language) })}
          {` ${gatilho.lastError.texto}`}
        </p>
      )}

      <p className="text-muted-foreground w-full text-xs">
        {t("settings.watched.beats", {
          last: quando(gatilho.lastFireAt),
          next: gatilho.enabled ? quando(gatilho.nextDueAt) : t("settings.watched.parked"),
        })}
      </p>
    </li>
  );
}
