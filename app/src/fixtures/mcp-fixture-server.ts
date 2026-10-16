#!/usr/bin/env node
/**
 * Servidor MCP de brinquedo, por transporte stdio.
 *
 * Existe para que `McpService.testConnection` e `listTools` tenham como ser
 * verificados sem depender de nada instalado na máquina. Loop de execução que
 * depende de servidor externo trava na primeira máquina que não tem o servidor.
 *
 * O `feed` entrou depois, para a varredura por consulta a servidor MCP ter um
 * alvo que devolve lista carimbada no tempo em vez de valor solto. O
 * `slack_history` veio junto da fonte de menções, e responde no formato do
 * Slack: sem ele a normalização de autor, canal e thread não teria contra o
 * que ser verificada sem um workspace de verdade.
 *
 * Não é parte do produto. Serve de alvo de teste e de exemplo mínimo de como
 * um servidor stdio se parece.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "locum-fixture", version: "0.1.0" });

server.registerTool(
  "echo",
  {
    description: "Devolve o texto recebido, para conferir ida e volta.",
    inputSchema: { text: z.string().describe("texto a devolver") },
  },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);

server.registerTool(
  "sum",
  {
    description: "Soma dois números, para conferir entrada tipada.",
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
);

// Quem pergunta é o teste do pool: o mesmo pid em duas execuções é a prova de
// que o processo foi reaproveitado, e não subido de novo.
// Nomes que servidores reais usam, sem anotação: a tela do agent tem de
// separar leitura de escrita só pelo nome, e `request` e `run` não mudam isso.
for (const nome of ["get_pull_request", "pull_request_read", "get_workflow_run", "list_pull_requests", "create_pull_request"]) {
  server.registerTool(
    nome,
    { description: `Ferramenta de exemplo com o nome de ${nome}, para a classificação por nome.`, inputSchema: {} },
    async () => ({ content: [{ type: "text", text: nome }] }),
  );
}

server.registerTool(
  "pid",
  {
    description: "Devolve o pid do processo do servidor.",
    inputSchema: {},
    // Anotada como leitura de propósito: o nome não diz, e a classificação do Locum tem que seguir o servidor.
    annotations: { readOnlyHint: true },
  },
  async () => ({ content: [{ type: "text", text: String(process.pid) }] }),
);

// Resposta estruturada com outputSchema (MCP 2025-06): o teste confere que o catálogo guarda o esquema de saída.
server.registerTool(
  "totais",
  {
    description: "Devolve totais de exemplo, com esquema de saída declarado.",
    inputSchema: {},
    outputSchema: { total: z.number(), itens: z.array(z.string()) },
    annotations: { readOnlyHint: true },
  },
  async () => ({ structuredContent: { total: 2, itens: ["a", "b"] }, content: [{ type: "text", text: '{"total":2,"itens":["a","b"]}' }] }),
);

server.registerTool(
  "slow",
  {
    description: "Espera alguns milissegundos, para exercitar timeout.",
    inputSchema: { ms: z.number().int().min(0).max(10_000) },
  },
  async ({ ms }) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { content: [{ type: "text", text: `esperou ${ms}ms` }] };
  },
);

server.registerTool(
  "fail",
  {
    description: "Falha de propósito, para exercitar tratamento de erro.",
    inputSchema: { reason: z.string().default("falha proposital") },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ reason }) => ({ content: [{ type: "text", text: reason }], isError: true }),
);

/**
 * Âncora do feed de brinquedo.
 *
 * Data fixa, e não `Date.now()`, porque a varredura por cursor só pode ser
 * verificada se as duas passadas virem os mesmos itens: carimbo relativo ao
 * relógio geraria identificador novo a cada subida do processo e a
 * deduplicação passaria sem nunca ter sido exercitada.
 */
const FEED_INICIO = Date.parse("2026-01-01T00:00:00.000Z");

server.registerTool(
  "feed",
  {
    description: "Devolve itens carimbados no tempo, para exercitar varredura por cursor.",
    inputSchema: {
      since: z
        .string()
        .default(new Date(0).toISOString())
        .describe("carimbo ISO; devolve item a partir dele, inclusive"),
      count: z.number().int().min(0).max(50).default(3).describe("quantos itens o feed tem"),
    },
  },
  async ({ since, count }) => {
    const corte = Date.parse(since);
    const items = Array.from({ length: count }, (_, i) => ({
      id: `item-${i}`,
      at: new Date(FEED_INICIO + i * 60_000).toISOString(),
      text: `item ${i} do feed de brinquedo`,
    }));

    // O corte é inclusive de propósito: o último item da passada anterior volta
    // na seguinte. É assim que a maioria dos feeds reais responde a um `since`,
    // e é o que obriga a deduplicação por chave externa a fazer o trabalho em
    // vez de o servidor esconder o problema filtrando com folga.
    const janela = Number.isNaN(corte)
      ? items
      : items.filter((item) => Date.parse(item.at) >= corte);

    return { content: [{ type: "text", text: JSON.stringify({ items: janela }) }] };
  },
);

/**
 * Âncora do canal de brinquedo, em epoch de segundos.
 *
 * Fixa pelo mesmo motivo da do `feed`, e no formato do Slack: o `ts` de uma
 * mensagem é o carimbo e a identidade ao mesmo tempo, então um relógio de
 * verdade geraria chave nova a cada subida e a deduplicação passaria sem nunca
 * ter sido exercitada.
 */
const SLACK_INICIO = Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000);

server.registerTool(
  "slack_history",
  {
    description: "Devolve mensagem de canal no formato do Slack, para exercitar a fonte de menções.",
    inputSchema: {
      channel_id: z.string().describe("canal observado"),
      oldest: z
        .string()
        .default("0")
        .describe("epoch em segundos; devolve mensagem a partir dele, inclusive"),
      limit: z.number().int().min(1).max(200).default(50).describe("teto de mensagens"),
      count: z.number().int().min(0).max(50).default(3).describe("quantas o canal tem"),
    },
  },
  async ({ channel_id, oldest, limit, count }) => {
    const messages = Array.from({ length: count }, (_, i) => {
      const ts = `${SLACK_INICIO + i * 60}.000100`;
      return {
        type: "message",
        channel: channel_id,
        user: `U${i}`,
        user_name: `pessoa-${i}`,
        text: `mensagem ${i} em ${channel_id}`,
        ts,
        // A do meio responde à primeira, para que o vínculo da thread tenha o
        // que provar: sem uma resposta, `thread_ts` seria sempre o próprio `ts`
        // e a distinção entre abrir e responder passaria despercebida.
        ...(i === 1 ? { thread_ts: `${SLACK_INICIO}.000100` } : {}),
        permalink: `https://exemplo.invalid/archives/${channel_id}/p${ts.replace(".", "")}`,
      };
    });

    // Inclusive, como no `feed` e como o `oldest` do Slack: a última mensagem
    // da passada anterior volta na seguinte, e é a chave externa que precisa
    // recusá-la.
    const corte = Number(oldest);
    const janela = messages
      .filter((m) => !Number.isFinite(corte) || Number(m.ts) >= corte)
      .slice(0, limit);

    return { content: [{ type: "text", text: JSON.stringify({ messages: janela }) }] };
  },
);

await server.connect(new StdioServerTransport());
