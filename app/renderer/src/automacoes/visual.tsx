import { cn } from "@/lib/utils";
import type { TFunction } from "i18next";
import {
  AtSign,
  Bot,
  CalendarClock,
  ClipboardList,
  GitPullRequest,
  Hash,
  type LucideIcon,
  Play,
  Plug,
  Send,
  Sparkles,
  Timer,
  Users,
  Webhook,
  Zap,
} from "lucide-react";
import type { AppDoComponente } from "@/lib/automacao";
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
  "tracker.create_issue": ClipboardList,
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
  if (id === "slack.post") return "slack";
  if (id === "teams.post") return "teams";
  if (id === "tracker.create_issue") return "atlassian";
  if (id.startsWith("github.")) return "github";
  return "locum";
}

const CORES: Record<AppDoComponente, string> = {
  locum: "ia-gradiente text-primary-foreground",
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

/** A frase curta de um gatilho: "a cada 15 min", "2 canais", "cron 0 9 * * 1-5". */
export function resumoDoGatilho(t: TFunction, config: TriggerConfig): string {
  switch (config.kind) {
    case "manual":
      return t("automations.triggers.manual.summary");
    case "cron":
      return t("automations.triggers.cron.summary", { expression: config.expression });
    case "schedule":
      return t("automations.triggers.schedule.summary", { minutes: config.everyMinutes });
    case "slack-channel":
      return t("automations.triggers.slack-channel.summary", { count: config.channels.length });
    case "slack-inbox":
      return t("automations.triggers.slack-inbox.summary");
    case "teams-inbox":
      return t("automations.triggers.teams-inbox.summary");
    case "poll":
      return t("automations.triggers.poll.summary", { owner: config.owner ?? "", repo: config.repoMatch });
    case "webhook":
      return t("automations.triggers.webhook.summary");
    case "mcp-poll":
      return t("automations.triggers.mcp-poll.summary", { server: config.server, tool: config.tool });
  }
}

export function tituloDoGatilho(t: TFunction, config: TriggerConfig): string {
  return t(`automations.triggers.${config.kind}.title`);
}

/** Título do componente de passo, com a ação crua para o que a paleta não conhece. */
export function tituloDoPasso(t: TFunction, id: string): string {
  return ["ai", "agent", "slack.post", "teams.post", "tracker.create_issue"].includes(id)
    ? t(`automations.steps.${id}.title`)
    : t("automations.steps.other.title", { action: id });
}
