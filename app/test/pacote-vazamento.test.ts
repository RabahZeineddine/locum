import { before, test } from "node:test";
import assert from "node:assert/strict";
import { AgentSpec, type TriggerConfigInput } from "../src/config/types.js";
import { migrateDb } from "../src/db/migrate.js";
import { AgentService } from "../src/services/agent-service.js";
import { AutomationService } from "../src/services/automation-service.js";
import { LibraryService } from "../src/services/library-service.js";
import { PacoteService, type AmbienteDoPacote } from "../src/services/pacote-service.js";
import { TriggerService } from "../src/services/trigger-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/** Nada que seja segredo, e-mail, caminho de home ou id de chat/canal sai literal no texto do pacote, em lugar nenhum. */

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

const HOME = "/Users/ana.souza";
// Formatos de teste, montados por concatenação para não parecer credencial de verdade.
const TOKEN_GITHUB = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const TOKEN_SLACK = "xoxb-" + "123456789012-abcdefABCDEF1234";
const CHAVE_AWS = "AKIA" + "IOSFODNN7EXAMPLE";
const EMAIL = "ana.souza@empresa-exemplo.com.br";
const CAMINHO = `${HOME}/projetos/cofre`;
const CHAT = "19:abcdef0123456789abcdef0123456789@thread.v2";
const CANAL = "C0123ABCD45";
const PESSOA = "ana-souza-da-empresa";
const DONO = "empresa-exemplo-da-ana";
const SEGREDOS = [TOKEN_GITHUB, TOKEN_SLACK, CHAVE_AWS, EMAIL, HOME, CHAT, CANAL, PESSOA, DONO];

/** O texto livre com todos os tipos de segredo juntos. */
const SUJO = `use ${TOKEN_GITHUB} e ${TOKEN_SLACK} e ${CHAVE_AWS}; fale com ${EMAIL}; veja ${CAMINHO}`;
const base = { needs: [] as string[], optional: false };

const ambiente: AmbienteDoPacote = {
  conexoes: async () => [],
  servidores: async () => [],
  guardadas: async () => null,
  skills: async () => ["estilo"],
  conteudoDaSkill: async () => ({ descricao: `Estilo de ${EMAIL}`, corpo: SUJO }),
  provedores: async () => [{ provedor: "claude-code", disponivel: true, modelos: ["claude-sonnet-5"] }],
};

test("o texto do pacote inteiro não traz segredo, e-mail, caminho de home nem id de chat ou canal", async () => {
  const bd = bancoDeTeste();
  const agents = new AgentService(bd);
  const automations = new AutomationService(agents, new TriggerService(bd), {} as never);
  const library = new LibraryService(bd, { servidoresDe: async () => [], ferramentasDe: async () => [] });
  const pacotes = new PacoteService(agents, library, automations, ambiente, HOME);

  await library.saveProfile({
    create: true,
    note: "",
    spec: { id: "revisor", name: `Revisor ${EMAIL}`, description: SUJO, context: SUJO, instructions: SUJO, model: "claude-code/claude-sonnet-5", skills: [{ skill: "estilo", when: { always: true } }] } as never,
  });
  const spec = AgentSpec.parse({
    id: "tudo-sujo",
    name: `Tudo ${EMAIL}`,
    skills: [{ skill: "estilo", when: { always: true } }],
    steps: [
      { ...base, type: "model", key: "ler", name: `Ler ${CAMINHO}`, prompt: SUJO, model: "claude-code/claude-sonnet-5", profile: "revisor" },
      { ...base, type: "action", key: "avisar", name: "Avisar", needs: ["ler"], action: "teams.post", mode: "approve", params: { destino: { tipo: "fixo", conversa: { app: "teams", ref: `chat/${CHAT}`, rotulo: EMAIL } }, texto: SUJO } },
      { ...base, type: "action", key: "hook", name: "Hook", needs: ["ler"], action: "http.request", mode: "approve", params: { method: "POST", url: `https://api.exemplo.com/x?token=${TOKEN_GITHUB}`, headers: { Authorization: `Bearer ${TOKEN_GITHUB}`, "X-Dono": EMAIL }, body: SUJO } },
      { ...base, type: "action", key: "chamar", name: "Chamar", needs: ["ler"], action: "mcp.call", mode: "approve", params: { server: "ms365", tool: "enviar", args: { texto: SUJO, chat: CHAT, canal: CANAL }, headers: { Authorization: TOKEN_SLACK } } },
    ],
  });
  const gatilhos: TriggerConfigInput[] = [
    { kind: "webhook", path: `/hook/${TOKEN_GITHUB}` },
    { kind: "poll", source: "github", owner: DONO, repoMatch: "servico-.*", authorship: "others", filters: { authors: { include: [PESSOA] }, labels: { include: [EMAIL], exclude: [] } } },
    { kind: "slack-channel", channels: [CANAL], everyMinutes: 5 },
    { kind: "teams-inbox", mentions: true, dms: true, prLinks: false, agruparPrs: false, maxPrs: 5, channels: [], chats: [{ chatId: CHAT, label: `Chat de ${EMAIL}` }], chatsPendentes: 0, everyMinutes: 5 },
    { kind: "mcp-poll", server: "ms365", tool: "listar", args: { chat: CHAT, token: TOKEN_SLACK, nota: SUJO }, everyMinutes: 5 },
  ] as never;
  await automations.save({ spec, triggers: gatilhos.map((config) => ({ config })), note: "", create: true });

  const { texto } = await pacotes.exportar("tudo-sujo");
  for (const segredo of SEGREDOS) assert.ok(!texto.includes(segredo), `vazou ${segredo.slice(0, 8)}... em: ${texto.slice(Math.max(0, texto.indexOf(segredo) - 80), texto.indexOf(segredo) + 40).replace(/\s+/g, " ")}`);
  assert.ok(!/ghp_|xoxb-|AKIA/.test(texto), "sobrou prefixo de credencial");
});
