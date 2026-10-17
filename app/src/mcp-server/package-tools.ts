import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pacoteService } from "../services/pacote-service.js";
import { def } from "./tool-def.js";

/**
 * O pacote (`.locum.json`): a automação e os agents dela, sem segredo. Pela
 * tela o arquivo vem do seletor do sistema; aqui o conteúdo vai e volta como
 * texto. Importar grava como a tela, com as mesmas decisões, e gatilho nenhum
 * entra ligado.
 */
export function registerPackageTools(server: McpServer): void {
  def(server, "preview_package", "read",
    "Reads the text of a package (.locum.json) and says what importing it would do on this machine: automation id, each agent as new, same id (with the differences), same name or equal, dependencies that are ok, missing or need connecting, every tool the package turns on with its class (write tools of a connection are highlighted), models and what is left to choose. Each omitted param is listed by name in omitidos (argumentos, destino-a-escolher, url-a-preencher, with params), and aPreencher lists per step and per trigger (by position) the fields left to fill, the same ones the import writes as pending; skills lists each cited skill as nova (created on import), igual, conflito (the local one stays, the difference comes along), existente or ausente (not in the package and not here: it becomes a pending item on the steps that use it); gatilhos[].criado is false for a trigger that is not created until a channel is chosen. Writes nothing.",
    { text: z.string().min(1).describe("the content of the package file") },
    ({ text }) => pacoteService.previa(text));

  def(server, "export_package", "read",
    "The package of an automation and its library agents as text, ready to save as .locum.json (the screen opens a save dialog; here the text comes back). It carries no secret: credentials, cursors and history stay out, and the cited skills travel with their text (format version 2), and free text, skills included, is cleaned of tokens, e-mails and home paths. What was left out comes in the package as omitted. warnings lists the literals that did travel in the arguments of mcp.call steps and mcp-poll triggers (where, field, value: a login or an organization, for instance), so you decide before sending the file.",
    { agentId: z.string().describe("automation id") },
    async ({ agentId }) => {
      const { texto, nomeDoArquivo, avisos } = await pacoteService.exportar(agentId);
      return { fileName: nomeDoArquivo, text: texto, warnings: avisos };
    });

  def(server, "import_package", "danger",
    "Imports a package as a new automation, as the screen does. Run preview_package first and pass the decisions it asks for. An agent with the same id and different content is created beside under a free id by default, and rewritten only with agents.<id>.acao = \"atualizar\"; an agent with the same name and another id requires a choice (usar-existente or criar-novo). Triggers always enter disabled, and the ones that need a channel or chats come out as pending. Write tools of a connection that the package turns on are imported, so read them in the preview. Action steps in auto enter in approval mode. Returns the new ids and the pending items.",
    {
      text: z.string().min(1).describe("the content of the package file"),
      automationId: z.string().optional().describe("id of the new automation; defaults to the suggested one"),
      agents: z
        .record(z.string(), z.object({ acao: z.enum(["atualizar", "criar-novo", "usar-existente"]) }))
        .optional()
        .describe("per agent id in the package: what to do when it already exists here"),
      servers: z.record(z.string(), z.string()).optional().describe("server name in the package to the registered server here"),
      connections: z.record(z.string(), z.string()).optional().describe("connection id in the package to the connection id here"),
      models: z.record(z.string(), z.string()).optional().describe("agent:<id> or passo:<key> to provider/model, when the suggested model is not available"),
    },
    ({ text, automationId, agents, servers, connections, models }) =>
      pacoteService.importar(text, {
        ...(automationId === undefined ? {} : { automacaoId: automationId }),
        ...(agents === undefined ? {} : { agents }),
        ...(servers === undefined ? {} : { servidores: servers }),
        ...(connections === undefined ? {} : { conexoes: connections }),
        ...(models === undefined ? {} : { modelos: models }),
      }));
}
