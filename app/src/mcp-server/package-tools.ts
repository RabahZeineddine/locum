import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pacoteService } from "../services/pacote-service.js";
import { respond } from "./respond.js";

/**
 * O pacote (`.locum.json`): a automação e os agents dela, sem segredo.
 *
 * Exportar e olhar a prévia só leem. Importar grava, com as mesmas decisões que
 * a tela pede, e dois limites que a tela não precisa: gatilho nunca entra
 * ligado (ligar é `set_trigger_enabled`), e pacote que liga ferramenta de
 * escrita na conexão de um agent não entra por aqui, porque a tela pede
 * confirmação dessa classe a uma pessoa.
 */
export function registerPackageTools(server: McpServer): void {
  server.registerTool(
    "preview_package",
    {
      description:
        "Reads the text of a package (.locum.json) and says what importing it would do on this machine: automation id, each agent as new, same id (with the differences), same name or equal, dependencies that are ok, missing or need connecting, every tool the package turns on with its class, models and what is left to choose. Reads only, writes nothing.",
      inputSchema: { text: z.string().min(1).describe("the content of the package file") },
    },
    async ({ text }) => respond(() => pacoteService.previa(text)),
  );

  server.registerTool(
    "export_package",
    {
      description:
        "The package of an automation and its library agents as text, ready to save as .locum.json. It carries no secret: credentials, cursors and history stay out, and free text is cleaned of tokens, e-mails and home paths. What was left out comes in the package as omitted.",
      inputSchema: { agentId: z.string().describe("automation id") },
    },
    async ({ agentId }) =>
      respond(async () => {
        const { texto, nomeDoArquivo } = await pacoteService.exportar(agentId);
        return { fileName: nomeDoArquivo, text: texto };
      }),
  );

  server.registerTool(
    "import_package",
    {
      description:
        "Imports a package as a new automation. Run preview_package first and pass the decisions it asks for. An agent with the same id and different content is created beside under a free id by default, and rewritten only with agents.<id>.acao = \"atualizar\"; an agent with the same name and another id requires a choice (usar-existente or criar-novo). Triggers always enter disabled, and the ones that need a channel or chats come out as pending. A package whose connection turns on a write tool is refused: a person imports it in the app. Action steps in auto enter in approval mode. Returns the new ids and the pending items.",
      inputSchema: {
        text: z.string().min(1).describe("the content of the package file"),
        automationId: z.string().optional().describe("id of the new automation; defaults to the suggested one"),
        agents: z
          .record(z.string(), z.object({ acao: z.enum(["atualizar", "criar-novo", "usar-existente"]) }))
          .optional()
          .describe("per agent id in the package: what to do when it already exists here"),
        servers: z.record(z.string(), z.string()).optional().describe("server name in the package to the registered server here"),
        connections: z.record(z.string(), z.string()).optional().describe("connection id in the package to the connection id here"),
        models: z
          .record(z.string(), z.string())
          .optional()
          .describe("agent:<id> or passo:<key> to provider/model, when the suggested model is not available"),
      },
    },
    async ({ text, automationId, agents, servers, connections, models }) =>
      respond(async () => {
        const previa = await pacoteService.previa(text);
        const escritaNaConexao = previa.ferramentas.filter((f) => f.classe === "escrita" && !f.removida);
        if (escritaNaConexao.length > 0) {
          throw new Error(
            `o pacote liga ferramenta de escrita (${escritaNaConexao.map((f) => `${f.dono}: ${f.ferramenta}`).join(", ")}); uma pessoa confirma isso importando pela tela do Locum`,
          );
        }
        return pacoteService.importar(text, {
          ...(automationId === undefined ? {} : { automacaoId: automationId }),
          ...(agents === undefined ? {} : { agents }),
          ...(servers === undefined ? {} : { servidores: servers }),
          ...(connections === undefined ? {} : { conexoes: connections }),
          ...(models === undefined ? {} : { modelos: models }),
        });
      }),
  );
}
