import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AgentProfile } from "../config/types.js";
import { libraryService } from "../services/library-service.js";
import { SkillsService } from "../services/skills-service.js";
import { def } from "./tool-def.js";

/**
 * A área de Skills da tela: o que a máquina tem (minhas, plugins, projeto),
 * lido ao vivo, e as skills do Locum, que se criam, editam e removem. Importar
 * é cópia explícita para o Locum; a skill da máquina nunca é copiada nem editada.
 */
export function registerSkillsTools(server: McpServer): void {
  // O MCP roda no processo de quem o abriu, que pode estar dentro de um repo: só aqui o grupo Projeto aparece.
  const skillsService = new SkillsService({ comProjeto: true });
  def(server, "list_skills", "read",
    "The skills of this machine (your own, plugins with their version, project) and the ones created in Locum, by name, description, origin ({tipo: minhas|plugin|projeto|locum, plugin, versao}), file, whether it is editable, and the library agents that use it. Read live with a short cache; refresh forces a new read of the disk.",
    { refresh: z.boolean().optional() },
    async ({ refresh }) => skillsService.listar({ atualizar: refresh }));

  def(server, "get_skill", "read",
    "One skill with its whole SKILL.md (`conteudo`), the body without the header (`corpo`), origin, file and the agents that use it. Machine skills are read-only and come from the origin.",
    { name: z.string().min(1) },
    async ({ name }) => skillsService.obter(name));

  def(server, "create_skill", "write",
    "Creates a Locum skill, kept in the Locum home. Name: lowercase, digits and dashes (up to 64), not used by another skill of this machine. Description: one line saying when to use it. Body: the markdown of the SKILL.md after the header.",
    { name: z.string().min(1), description: z.string().min(1), body: z.string() },
    async (input) => skillsService.criar(input));

  def(server, "update_skill", "danger",
    "Replaces the description and the body of a Locum skill. Only Locum skills change; a machine skill is edited at its origin. The agents that use it get the new text from the next run.",
    { name: z.string().min(1), description: z.string().min(1), body: z.string() },
    async ({ name, ...resto }) => skillsService.atualizar(name, resto));

  def(server, "remove_skill", "danger",
    "Deletes a Locum skill and its folder. Irreversible. The agents that still use it keep the name, show the warning, and their runs fail until the skill is back or they drop it; the answer lists them.",
    { name: z.string().min(1) },
    async ({ name }) => skillsService.remover(name));

  def(server, "import_skill", "write",
    "Imports a .md file or a folder with SKILL.md from a path on this machine as a Locum skill. It is a copy: the original is left as it is and the skill stops following it. A .md without header takes the name from the file.",
    { path: z.string().min(1) },
    async ({ path }) => skillsService.importar(path));

  def(server, "add_skill_to_agent", "write",
    "Adds a skill (from any origin) to a library agent, recording a new version of the agent. Nothing else in the agent changes. Does nothing when the agent already has it.",
    { agentId: z.string().min(1), skill: z.string().min(1) },
    async ({ agentId, skill }) => {
      const achada = await skillsService.obter(skill);
      if (achada.fonte.tipo === "projeto") {
        throw new Error(`a skill "${skill}" vem da pasta do projeto onde este MCP roda; o app não a vê. Importe para o Locum (import_skill) e use a cópia`);
      }
      const atual = await libraryService.getProfile(agentId);
      if (atual === null) throw new Error(`agent "${agentId}" não existe na biblioteca`);
      const spec = AgentProfile.parse(atual.spec);
      if (spec.skills.some((k) => k.skill === skill)) return { id: agentId, version: atual.version, added: false };
      const versao = await libraryService.saveProfile({
        spec: { ...spec, skills: [...spec.skills, { skill, when: { always: true } }] } as Parameters<typeof libraryService.saveProfile>[0]["spec"],
        note: `skill ${skill}`,
      });
      return { id: versao.profileId, version: versao.version, added: true };
    });
}
