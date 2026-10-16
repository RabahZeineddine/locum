import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkingHoursConfig } from "../config/types.js";
import { i18nService, SUPPORTED_LANGUAGES } from "../services/i18n-service.js";
import { settingsService } from "../services/settings-service.js";
import { startupService } from "../services/startup-service.js";
import { updateService } from "../services/update-service.js";
import type { Ambiente } from "./ambiente.js";
import { def } from "./tool-def.js";

/** O app aberto lê estas preferências na subida; o `--mcp` é outro processo e não o reinicia. */
const NA_PROXIMA_SUBIDA = "vale para o app na próxima vez que ele abrir";

/**
 * A seção geral da Configuração: horário de trabalho, abrir com o login,
 * idioma, atualização automática, e o que o rodapé e o editor mostram
 * (a versão).
 */
export function registerSettingsTools(server: McpServer, amb: Ambiente): void {
  def(server, "get_working_hours", "read",
    "The working hours of the scheduler: whether they are on, start and end (HH:mm), days (0 is Sunday) and what triggers do outside them (pause or slow, with the slow cadence). null when never set.",
    {}, async () => (await settingsService.getWorkingHours()) ?? null);

  def(server, "set_working_hours", "write",
    "Sets the working hours of the scheduler. Fields left out take the defaults (off, 08:00 to 20:00, Monday to Friday, pause).",
    { config: z.record(z.string(), z.unknown()).describe('like {"enabled":true,"start":"09:00","end":"18:00","days":[1,2,3,4,5],"offHoursBehavior":"slow","slowCadenceMinutes":60}') },
    async ({ config }) => {
      await settingsService.setWorkingHours(WorkingHoursConfig.parse(config));
      return settingsService.getWorkingHours();
    });

  def(server, "get_startup", "read",
    "Whether the app opens at login: true, false, or null when nobody decided.",
    {}, async () => ({ openAtLogin: await startupService.getPreference() }));

  def(server, "set_startup", "write",
    `Sets whether the app opens at login (${NA_PROXIMA_SUBIDA}).`,
    { enabled: z.boolean() },
    async ({ enabled }) => {
      await startupService.setPreference(enabled);
      return { openAtLogin: enabled, aviso: NA_PROXIMA_SUBIDA };
    });

  def(server, "get_language", "read",
    "The language of the app: the one in use, the saved preference (null follows the system), the system locale and the available ones.",
    {}, () => i18nService.resolve(amb.systemLocale()));

  def(server, "set_language", "write",
    `Sets the language of the app; null follows the system (${NA_PROXIMA_SUBIDA}).`,
    { language: z.enum(SUPPORTED_LANGUAGES).nullable() },
    async ({ language }) => {
      await i18nService.setPreference(language);
      return { ...(await i18nService.resolve(amb.systemLocale())), aviso: NA_PROXIMA_SUBIDA };
    });

  def(server, "get_update_settings", "read",
    "Whether the app updates itself: the saved preference (null means nobody decided, which counts as on) and the installed version. Checking for a new version and applying it are buttons of the app.",
    {}, async () => ({ ...(await updateService.state()), version: amb.appVersion() }));

  def(server, "set_updates_enabled", "write",
    `Turns the automatic update of the app on or off (${NA_PROXIMA_SUBIDA}).`,
    { enabled: z.boolean() },
    async ({ enabled }) => {
      await updateService.setEnabled(enabled);
      return { ...(await updateService.state()), aviso: NA_PROXIMA_SUBIDA };
    });

  def(server, "get_app_version", "read", "The installed version of Locum.", {}, async () => ({ version: amb.appVersion() }));
}
