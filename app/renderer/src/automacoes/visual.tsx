import { cn } from "@/lib/utils";
import type { TFunction } from "i18next";
import {
  AtSign,
  Braces,
  Bot,
  CalendarClock,
  ClipboardList,
  GitPullRequest,
  Globe,
  Hash,
  LayoutTemplate,
  MessageSquareText,
  type LucideIcon,
  Play,
  Plug,
  Send,
  SmilePlus,
  Split,
  Signpost,
  Sparkles,
  Timer,
  Type,
  Users,
  Webhook,
  Zap,
} from "lucide-react";
import type { AppDoComponente } from "@/lib/automacao";
import { descreverCron } from "@/lib/descricao-do-cron";
import { escopoDoTeams, tituloDoGatilho } from "@/lib/titulo-do-gatilho";
import type { TriggerConfig } from "../../../src/config/types";

/**
 * Como cada componente da automação aparece: ícone, cor do app e a frase
 * curta que resume a configuração. Um lugar só, para a paleta, o nó do canvas
 * e a lista falarem do mesmo jeito.
 */

const ICONES: Record<string, LucideIcon> = {
  manual: Play,
  cron: CalendarClock,
  schedule: Timer,
  "slack-channel": Hash,
  "slack-inbox": AtSign,
  "teams-inbox": Users,
  poll: GitPullRequest,
  webhook: Webhook,
  "mcp-poll": Plug,
  ai: Sparkles,
  agent: Bot,
  "slack.post": Send,
  "teams.post": Send,
  "slack.react": SmilePlus,
  "teams.react": SmilePlus,
  "tracker.create_issue": ClipboardList,
  "mcp.call": Plug,
  "http.request": Globe,
  "logic.if": Split,
  "logic.switch": Signpost,
  "logic.json.parse": Braces,
  "logic.json.stringify": Braces,
  "logic.text": Type,
  "logic.slack.mrkdwn": MessageSquareText,
  "logic.slack.blocks": LayoutTemplate,
  "logic.teams.card": LayoutTemplate,
};

export function iconeDe(id: string): LucideIcon {
  return ICONES[id] ?? Zap;
}

/** O app de cada gatilho que não está na paleta, para a cor bater. */
export function appDoGatilho(kind: TriggerConfig["kind"]): AppDoComponente {
  if (kind === "slack-channel" || kind === "slack-inbox") return "slack";
  if (kind === "teams-inbox") return "teams";
  if (kind === "poll") return "github";
  return "locum";
}

export function appDoPasso(id: string): AppDoComponente {
  if (id === "slack.post" || id === "slack.react" || id.startsWith("logic.slack.")) return "slack";
  if (id === "teams.post" || id === "teams.react" || id === "logic.teams.card") return "teams";
  if (id === "tracker.create_issue") return "atlassian";
  if (id.startsWith("github.")) return "github";
  return "locum";
}

const CORES: Record<AppDoComponente, string> = {
  locum: "bg-muted text-foreground",
  slack: "bg-[#4A154B] text-white",
  teams: "bg-[#5059C9] text-white",
  github: "bg-[#24292f] text-white ring-1 ring-white/15",
  atlassian: "bg-[#0052CC] text-white",
};

/** O ícone do componente num quadrado com a cor do app. */
export function Selo({ app, id, tamanho = "md" }: { app: AppDoComponente; id: string; tamanho?: "sm" | "md" }) {
  const Icone = iconeDe(id);
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md",
        tamanho === "sm" ? "size-6" : "size-8",
        CORES[app],
      )}
    >
      <Icone className={tamanho === "sm" ? "size-3.5" : "size-4"} />
    </span>
  );
}

/**
 * A frase curta de um gatilho: "a cada 15 min", "2 canais", "Dias úteis às
 * 09:00 · cron 0 9 * * 1-5". Vazia quando o título já diz tudo. O cron leva a frase junto quando dá para dizer.
 */
export function resumoDoGatilho(t: TFunction, config: TriggerConfig, idioma: string): string {
  switch (config.kind) {
    case "manual":
      return t("automations.triggers.manual.summary");
    case "cron": {
      const frase = descreverCron(config.expression, t, idioma);
      return frase === null
        ? t("automations.triggers.cron.summary", { expression: config.expression })
        : t("automations.triggers.cron.summaryHuman", { human: frase, expression: config.expression });
    }
    case "schedule":
      return t("automations.triggers.schedule.summary", { minutes: config.everyMinutes });
    case "slack-channel":
      return t("automations.triggers.slack-channel.summary", { count: config.channels.length });
    case "slack-inbox":
      return "";
    case "teams-inbox":
      return escopoDoTeams(t, config);
    case "poll":
      return t("automations.triggers.poll.summary", { owner: config.owner ?? "", repo: config.repoMatch });
    case "webhook":
      return t("automations.triggers.webhook.summary");
    case "mcp-poll":
      return t("automations.triggers.mcp-poll.summary", { server: config.server, tool: config.tool });
  }
}

export { tituloDoGatilho };

/** Título do componente de passo, com a ação crua para o que a paleta não conhece. */
export function tituloDoPasso(t: TFunction, id: string): string {
  if (id.startsWith("logic.")) return t(`automations.steps.logic.${id.slice("logic.".length)}.title`);
  return ["ai", "agent", "slack.post", "teams.post", "slack.react", "teams.react", "tracker.create_issue", "mcp.call", "http.request"].includes(id)
    ? t(`automations.steps.${id}.title`)
    : t("automations.steps.other.title", { action: id });
}

/** O número do passo no fluxo, o mesmo no card, no topo do painel e nos grupos do autocomplete. */
export function NumeroDoPasso({ numero, t }: { numero: number; t: TFunction }) {
  return (
    <span
      aria-label={t("automations.canvas.stepNumber", { numero })}
      className="bg-muted text-muted-foreground inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium tabular-nums"
      data-locum-passo-numero={numero}
    >
      {numero}
    </span>
  );
}
