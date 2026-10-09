import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { respond } from "../mcp-server/respond.js";
import { consultarAgent, SERVIDOR_NATIVO, type ConsultaDeps } from "./ask.js";
import { businessHours, HolidaysSchema, ItemsSchema, ThresholdsSchema, WindowSchema } from "./business-hours.js";
import { httpGet, jsonQuery } from "./tools.js";

export interface NativeToolsDeps {
  fetch?: typeof fetch;
  consulta: ConsultaDeps;
}

/**
 * O servidor `locum-ferramentas`: as ferramentas que o Locum dá aos agents
 * por conta própria. É um servidor MCP como qualquer outro, servido pelo
 * próprio binário com `--ferramentas`, para o runtime nativo e o do Claude
 * Code enxergarem igual e toolset não precisar de caso especial.
 *
 * Tudo aqui é leitura. Escrever fora é nó de ação no fluxo.
 */
export function buildNativeToolsServer(deps: NativeToolsDeps): McpServer {
  const server = new McpServer({ name: SERVIDOR_NATIVO, version: "0.1.0" });

  server.registerTool(
    "http_get",
    {
      description:
        'GET request to any http or https address. Returns status, content type and the body, already parsed when it is JSON. Bodies over 60k characters are cut: for large JSON, pass path (like "periods[3]" or "indicators.deployFrequency") to get only that part.',
      inputSchema: {
        url: z.string(),
        headers: z.record(z.string(), z.string()).optional(),
        path: z.string().optional().describe("JSON path applied to the body before it is returned, same syntax as json_query"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, headers, path }) => respond(() => httpGet(url, headers ?? {}, deps.fetch, path)),
  );

  server.registerTool(
    "json_query",
    {
      description:
        'Reads a value from JSON by path, like "items[0].name" or "a.b". The JSON can come as text, with or without a ```json fence. An empty path returns the whole JSON; a missing path returns null.',
      inputSchema: {
        json: z.unknown(),
        path: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ json, path }) => respond(async () => jsonQuery(json, path ?? "")),
  );

  server.registerTool(
    "ask_agent",
    {
      description:
        "Asks a library agent a question and returns its answer. The agent runs with its own instructions, model and tools, but cannot ask another agent in turn.",
      inputSchema: {
        agent: z.string().describe("id of the library agent"),
        question: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ agent, question }) => respond(() => consultarAgent(agent, question, deps.consulta)),
  );

  server.registerTool(
    "business_hours",
    {
      description:
        'Counts business hours elapsed since a moment, per item, and says which band that falls in. Never count hours yourself: pass the moments here. Each item is {id, since} (id text or number), where since is ISO 8601 with a zone ("2026-10-08T15:00:00Z") or a Slack ts in epoch seconds ("1696771234.123456", text or number). A since more than 366 days before now is an error for that item. Returns {id, hours, band} per item, hours with one decimal, rounded down, and band "ok", "p1" or "p0"; an item that is malformed or has an unreadable since comes back as {id, error} and does not fail the others. now defaults to the current time. window defaults to 09:00-18:00, Monday to Friday (days 0=Sunday to 6=Saturday), America/Sao_Paulo; start must be before end, a window that crosses midnight is not supported, the window must not fall in the hour a zone skips at a daylight saving change, and the offset is computed per day so daylight saving is respected. thresholds default to {p1: 4, p0: 8} hours (band p1 from p1 on, p0 from p0 on). holidays are YYYY-MM-DD dates in the window time zone, counted as zero hours. A since at or after now gives 0.',
      inputSchema: {
        items: ItemsSchema,
        now: z.union([z.string(), z.number()]).optional().describe("ISO 8601 with a zone, or a Slack ts in epoch seconds, as text or number"),
        window: WindowSchema.optional(),
        thresholds: ThresholdsSchema.optional(),
        holidays: HolidaysSchema.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (entrada) => respond(async () => businessHours(entrada)),
  );

  return server;
}
