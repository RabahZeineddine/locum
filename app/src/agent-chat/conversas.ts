import { SERVIDOR_CONTA } from "../config/types.js";
import { selectSkills, skillsAusentes, skillsPreamble, type LoadedSkill } from "../skills/loader.js";
import type { assertWithinBudget, recordSpend } from "../executor/budget.js";
import type { LibraryService, ResolvedProfile } from "../services/library-service.js";
import { skillsService } from "../services/skills-service.js";
import type { SettingsService } from "../services/settings-service.js";
import {
  NucleoDeConversa,
  type Armazem,
  type DepsDoNucleo,
  type ProvedorDeConversa,
} from "./nucleo.js";
import { chaveDoAgent } from "./tipos.js";

export { legivel } from "./nucleo.js";
export type {
  DecisaoDaAssinatura,
  Gasto,
  ModeloEscolhido,
  PedidoDaAssinatura,
} from "./nucleo.js";

export interface DepsDoChat extends DepsDoNucleo {
  library: Pick<LibraryService, "resolveProfile">;
  settings: Pick<SettingsService, "get" | "set">;
  orcamento: { checar: typeof assertWithinBudget; gastar: typeof recordSpend };
  /** Skills disponíveis. Ausente varre o disco. */
  skills?: Map<string, LoadedSkill>;
}

/** O que o agent guarda em `settings`, com as chaves de sempre: o app aberto e o `--mcp` gravam as mesmas. */
function armazemDoAgent(settings: Pick<SettingsService, "get" | "set">): Armazem {
  const chave = (id: string, campo: string): string => `chat.${campo}.${chaveDoAgent(id)}`;
  return {
    ler: (id, campo) => settings.get(chave(id, campo)),
    gravar: (id, campo, valor) => settings.set(chave(id, campo), valor),
  };
}

/** O contexto do agent da biblioteca: o que `resolveProfile` entrega, o teto dele e o gasto em `biblioteca:<id>`. */
function provedorDoAgent(deps: DepsDoChat): ProvedorDeConversa {
  const semSkill = (perfil: ResolvedProfile): string[] => {
    const skills = perfil.version.spec.skills;
    if (skills.length === 0) return [];
    return skillsAusentes(skills, deps.skills ?? skillsService.catalogo(), { repo: "", changedFiles: [] });
  };
  return {
    chave: chaveDoAgent,
    armazem: armazemDoAgent(deps.settings),
    estado: async (id) => {
      const perfil = await deps.library.resolveProfile(id);
      return {
        semServidor: perfil.semServidor,
        semSkill: semSkill(perfil),
        contaIgnorada: perfil.tools.filter((t) => t.server === SERVIDOR_CONTA).length,
      };
    },
    contexto: async (id) => {
      const perfil = await deps.library.resolveProfile(id);
      const spec = perfil.version.spec;
      const chaveDoGasto = `biblioteca:${spec.id}`;
      return {
        modelo: spec.model,
        // Sem evento por trás, só valem as skills de regra "sempre", como na consulta entre agents.
        system: (runtimeId) => {
          const skills = selectSkills(spec.skills, { repo: "", changedFiles: [] }, deps.skills ?? skillsService.catalogo());
          return [perfil.system, skillsPreamble(skills, true, runtimeId)].filter((p) => p.length > 0).join("\n\n");
        },
        maxSteps: spec.maxSteps,
        ...(spec.temperature === undefined ? {} : { temperature: spec.temperature }),
        // As da conta Claude só existem no runtime do Claude Code.
        leitura: perfil.tools.filter((t) => t.server !== SERVIDOR_CONTA),
        confirmar: perfil.confirmar,
        locais: [],
        checar: (gasto) => deps.orcamento.checar(chaveDoGasto, gasto, spec.budget, spec.name),
        gastar: (gasto, novaMensagem) => deps.orcamento.gastar(chaveDoGasto, gasto, novaMensagem),
      };
    },
  };
}

/**
 * As conversas com os agents da biblioteca: o núcleo de turno com o contexto do agent.
 *
 * Cada agent conversa com o que `resolveProfile` entrega: system, modelo, leitura
 * liberada e skills. A escrita que a pessoa ligou na conexão (`confirmar`) para num
 * cartão e só roda no clique.
 */
export class ConversasDeAgent extends NucleoDeConversa {
  constructor(deps: DepsDoChat) {
    super(deps, provedorDoAgent(deps));
  }
}
