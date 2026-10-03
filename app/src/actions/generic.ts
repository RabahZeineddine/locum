import { z } from "zod";
import type { ActionHandler } from "../approval/gate.js";
import { clienteHttp } from "../net/http.js";

/**
 * As duas ações que deixam o fluxo fazer o que o Locum não tem nó próprio:
 * chamar qualquer ferramenta de um app conectado, e chamar qualquer API.
 *
 * Passam pela mesma porta das outras. Nascem em "aprovar", e quem monta o
 * fluxo pode trocar para "automático" no passo; a gate é que publica, e a
 * pendência guarda exatamente o que vai sair, com os marcadores já trocados
 * pelos valores do evento.
 */

/** Chamada a uma ferramenta MCP, com os argumentos já montados. */
export const McpCallProposal = z.object({
  server: z.string({ error: "escolha o app (servidor MCP)" }).trim().min(1, "escolha o app (servidor MCP)"),
  tool: z.string({ error: "escolha a ferramenta" }).trim().min(1, "escolha a ferramenta"),
  args: z.record(z.string(), z.unknown()).default({}),
});
export type McpCallProposal = z.infer<typeof McpCallProposal>;

export interface McpCallOptions {
  /** Chama a ferramenta. Recebe a configuração atual do servidor por nome. */
  call: (server: string, tool: string, args: Record<string, unknown>) => Promise<unknown>;
}

export function mcpCallHandler(options: McpCallOptions): ActionHandler {
  return {
    async propose(payload) {
      // Só os três campos: o resto do evento que o executor junta não é
      // argumento da ferramenta, e não entra na pendência.
      const p = (payload ?? {}) as Record<string, unknown>;
      return McpCallProposal.parse({ server: p.server, tool: p.tool, args: p.args ?? {} });
    },
    async publish(payload) {
      const proposta = McpCallProposal.parse(payload);
      const resultado = (await options.call(proposta.server, proposta.tool, proposta.args)) as
        | { isError?: boolean; content?: { type?: string; text?: string }[] }
        | undefined;
      // Ferramenta MCP que falha costuma responder normalmente com `isError`.
      // Tratar isso como sucesso fecharia a pendência como publicada sem nada
      // ter saído.
      if (resultado?.isError === true) {
        const texto = (resultado.content ?? []).map((c) => c.text ?? "").join(" ").trim();
        throw new Error(`${proposta.server}.${proposta.tool} recusou: ${texto || "sem detalhe"}`);
      }
    },
  };
}

export const HttpRequestProposal = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  url: z
    .string({ error: "informe o endereço" })
    .trim()
    .url("endereço inválido")
    .refine((u) => /^https?:\/\//i.test(u), "só http e https"),
  headers: z.record(z.string(), z.string()).default({}),
  /** Texto vai como está; objeto vai como JSON. */
  body: z.unknown().optional(),
});
export type HttpRequestProposal = z.infer<typeof HttpRequestProposal>;

export interface HttpRequestOptions {
  fetch?: typeof fetch;
}

/** Chamada a qualquer API. Resposta fora de 2xx falha a publicação, com o começo do corpo. */
export function httpRequestHandler(options: HttpRequestOptions = {}): ActionHandler {
  const fetchFn = options.fetch ?? clienteHttp;
  return {
    async propose(payload) {
      const p = (payload ?? {}) as Record<string, unknown>;
      return HttpRequestProposal.parse({
        method: p.method,
        url: p.url,
        headers: p.headers ?? {},
        ...(p.body === undefined || p.body === "" ? {} : { body: p.body }),
      });
    },
    async publish(payload) {
      const r = HttpRequestProposal.parse(payload);
      const temCorpo = r.body !== undefined && r.method !== "GET";
      const ehTexto = typeof r.body === "string";
      const headers: Record<string, string> = { ...r.headers };
      const pareceJson = !ehTexto || /^\s*[[{]/.test(r.body as string);
      if (temCorpo && pareceJson && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
        headers["content-type"] = "application/json";
      }
      const resposta = await fetchFn(r.url, {
        method: r.method,
        headers,
        ...(temCorpo ? { body: ehTexto ? (r.body as string) : JSON.stringify(r.body) } : {}),
      });
      if (!resposta.ok) {
        const corpo = (await resposta.text().catch(() => "")).slice(0, 300);
        throw new Error(`${r.method} ${r.url} respondeu ${resposta.status}${corpo ? `: ${corpo}` : ""}`);
      }
    },
  };
}
