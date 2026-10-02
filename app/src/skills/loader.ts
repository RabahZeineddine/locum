import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillRule } from "../config/types.js";

export type LoadedSkill = {
  name: string;
  description: string;
  body: string;
  origin: string;
  /** Sem o hash a metrica mente quando o plugin externo atualiza a skill. */
  hash: string;
};

const MAX_DEPTH = 6;
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

/**
 * Pastas de plugin que o Claude Code de fato carrega.
 *
 * O cache guarda uma pasta por versao, e `marketplaces` guarda o fonte de
 * plugin que nem foi instalado; varrer `~/.claude/plugins` inteiro mistura os
 * dois e decide a versao pela ordem do disco. O `installed_plugins.json` diz o
 * `installPath` de cada plugin instalado. Sem ele, ou ilegivel, volta a varrer
 * a pasta toda.
 */
export function pluginRoots(pluginsDir: string): string[] {
  const manifest = join(pluginsDir, "installed_plugins.json");
  if (!existsSync(manifest)) return [pluginsDir];
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
      plugins?: Record<string, Array<{ installPath?: unknown }>>;
    };
    const paths = Object.values(parsed.plugins ?? {})
      .flat()
      .map((entry) => entry?.installPath)
      .filter((p): p is string => typeof p === "string" && existsSync(p));
    return [...new Set(paths)];
  } catch {
    return [pluginsDir];
  }
}

function roots(home = homedir(), cwd = process.cwd()): string[] {
  const plugins = join(home, ".claude", "plugins");
  return [
    join(home, ".claude", "skills"),
    ...(existsSync(plugins) ? pluginRoots(plugins) : []),
    join(cwd, ".claude", "skills"),
  ].filter((p) => existsSync(p));
}

function findSkillFiles(dir: string, depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      // Link quebrado nao derruba a descoberta inteira.
      continue;
    }
    if (!isDir) {
      if (entry === "SKILL.md") out.push(full);
      continue;
    }
    if (!SKIPPED_DIRS.has(entry)) out.push(...findSkillFiles(full, depth + 1));
  }
  return out;
}

export function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
  const match = raw.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { body: raw };
  const [, head, body = ""] = match;
  const field = (key: string) =>
    head!.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "");
  return { name: field("name"), description: field("description"), body };
}

/** Acervo do usuario e dos plugins, sem formato novo. */
export function discoverSkills(home?: string, cwd?: string): Map<string, LoadedSkill> {
  const found = new Map<string, LoadedSkill>();
  for (const root of roots(home, cwd)) {
    for (const file of findSkillFiles(root)) {
      const raw = readFileSync(file, "utf8");
      const { name, description, body } = parseFrontmatter(raw);
      if (!name) continue;
      found.set(name, {
        name,
        description: description ?? "",
        body,
        origin: file,
        hash: createHash("sha256").update(raw).digest("hex").slice(0, 12),
      });
    }
  }
  return found;
}

/**
 * `**` atravessa pastas, `*` fica dentro de uma. Trocados num passo so: em
 * passos separados, o `*` reescrevia o `.*` que o `**` acabara de gerar, e
 * `**\/*.tsx` deixava de casar arquivo dois niveis abaixo.
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
  const body = escaped.replace(/\*\*\/|\*\*|\*/g, (token) =>
    token === "**/" ? "(?:.*/)?" : token === "**" ? ".*" : "[^/]*",
  );
  return new RegExp(`^${body}$`);
}

export type SkillContext = { repo: string; changedFiles: string[] };

/**
 * Selecao deterministica pelos arquivos alterados no evento, nao pela
 * linguagem do repositorio: PR que so mexe no frontend de um repo poliglota
 * carrega a skill de front, nao a de backend.
 */
export function selectSkills(
  rules: SkillRule[],
  ctx: SkillContext,
  catalog?: Map<string, LoadedSkill>,
): LoadedSkill[] {
  const picked: LoadedSkill[] = [];
  // Varrer o disco custa um decimo de segundo no processo principal; passo sem
  // regra de skill, que e a maioria, nao paga isso.
  if (rules.length === 0) return picked;
  const found = catalog ?? discoverSkills();

  for (const rule of rules) {
    const { always, filesMatch, repoMatch } = rule.when;
    let hit = Boolean(always);

    if (!hit && repoMatch?.length) {
      hit = repoMatch.some((g) => globToRegExp(g).test(ctx.repo));
    }
    if (!hit && filesMatch?.length) {
      const patterns = filesMatch.map(globToRegExp);
      hit = ctx.changedFiles.some((f) => patterns.some((p) => p.test(f)));
    }
    if (!hit) continue;

    const skill = found.get(rule.skill);
    if (skill && !picked.some((s) => s.name === skill.name)) picked.push(skill);
  }

  return picked;
}

/**
 * O texto das skills para o prompt de sistema.
 *
 * Sem `inline`, so nome e descricao, e o corpo fica para quem souber abrir a
 * skill sozinho: dez candidatas custam ~400 tokens em vez de 20 mil. Nenhum
 * runtime de hoje sabe, porque o passo roda isolado das configuracoes da
 * maquina, e o executor sempre pede `inline`.
 */
export function skillsPreamble(skills: LoadedSkill[], inline: boolean): string {
  if (skills.length === 0) return "";
  if (inline) {
    return skills.map((s) => `## Skill: ${s.name}\n\n${s.body}`).join("\n\n");
  }
  return [
    "Skills disponiveis para esta tarefa:",
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join("\n");
}
