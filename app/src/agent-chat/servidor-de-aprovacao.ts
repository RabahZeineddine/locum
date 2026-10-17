import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { DecisaoDaAssinatura } from "./nucleo.js";

export const SERVIDOR_DE_APROVACAO = "locum-aprovacao";
export const FERRAMENTA_DE_APROVACAO = "aprovar";

/** O nome com que o Claude Code enxerga a ferramenta, para `--permission-prompt-tool`. */
export const APROVACAO_NO_CLAUDE = `mcp__${SERVIDOR_DE_APROVACAO}__${FERRAMENTA_DE_APROVACAO}`;

export interface ServidorDeAprovacao {
  url: string;
  /** Cabeçalho `Authorization: Bearer <token>` que o Claude Code leva na configuração. */
  token: string;
  fechar: () => Promise<void>;
}

/** De quanto em quanto tempo uma conexão parada à espera do clique diz que continua viva. */
const BATIDA_MS = 30_000;

/**
 * A ferramenta de permissão do chat pela assinatura do Claude Code.
 *
 * O CLI chama `--permission-prompt-tool` sempre que uma ferramenta não está
 * liberada, com o nome e a entrada dela, e espera `allow` ou `deny`. Quem sabe
 * decidir é o processo principal, onde mora o cartão, e o CLI é filho de outro
 * processo: por isso um servidor MCP por HTTP em 127.0.0.1, de uma volta só, que
 * só atende com o token sorteado para ela.
 *
 * A resposta demora o que a pessoa demorar. A conexão fica aberta como fluxo de
 * eventos, e a batida mantém o cliente de HTTP do CLI de desistir por silêncio.
 */
export async function abrirServidorDeAprovacao(
  decidir: (nome: string, entrada: unknown, usoId?: string) => Promise<DecisaoDaAssinatura>,
): Promise<ServidorDeAprovacao> {
  return abrirServidorMcpLocal(SERVIDOR_DE_APROVACAO, (mcp) => {
    mcp.registerTool(
      FERRAMENTA_DE_APROVACAO,
      {
        description: "Decide se o Claude Code pode usar uma ferramenta que não estava liberada.",
        inputSchema: {
          tool_name: z.string(),
          input: z.record(z.string(), z.unknown()),
          tool_use_id: z.string().optional(),
        },
      },
      async ({ tool_name, input, tool_use_id }) => {
        const decisao = await decidir(tool_name, input, tool_use_id);
        const resposta = decisao.permitir
          ? { behavior: "allow", updatedInput: decisao.entrada }
          : { behavior: "deny", message: decisao.mensagem };
        return { content: [{ type: "text", text: JSON.stringify(resposta) }] };
      },
    );
  });
}

/**
 * Um servidor MCP por HTTP em 127.0.0.1, de uma volta só, que só atende com o token
 * sorteado para ela. Serve ao Claude Code as ferramentas que moram neste processo: a
 * de permissão e, na conversa do run, as do Locum.
 */
export async function abrirServidorMcpLocal(nome: string, registrar: (mcp: McpServer) => void): Promise<ServidorDeAprovacao> {
  const token = randomBytes(24).toString("hex");
  const esperado = Buffer.from(`Bearer ${token}`);

  const servidorMcp = (): McpServer => {
    const mcp = new McpServer({ name: nome, version: "0.1.0" });
    registrar(mcp);
    return mcp;
  };

  const http = createServer((req, res) => void atender(req, res));
  const atender = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const trouxe = Buffer.from(req.headers.authorization ?? "");
    if (trouxe.length !== esperado.length || !timingSafeEqual(trouxe, esperado)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const corpo = await lerCorpo(req);
    // Sem sessão: cada chamada é independente, e o servidor não guarda estado entre elas.
    const transporte = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = servidorMcp();
    const batida = setInterval(() => {
      if (res.headersSent && !res.writableEnded) res.write(": batida\n\n");
    }, BATIDA_MS);
    res.on("close", () => {
      clearInterval(batida);
      void transporte.close();
      void mcp.close();
    });
    await mcp.connect(transporte);
    await transporte.handleRequest(req, res, corpo);
  };

  await new Promise<void>((resolver) => http.listen(0, "127.0.0.1", resolver));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    fechar: () =>
      new Promise<void>((resolver) => {
        http.closeAllConnections();
        http.close(() => resolver());
      }),
  };
}

async function lerCorpo(req: IncomingMessage): Promise<unknown> {
  const partes: Buffer[] = [];
  for await (const parte of req) partes.push(parte as Buffer);
  try {
    return JSON.parse(Buffer.concat(partes).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}
