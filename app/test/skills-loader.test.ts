import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSkills,
  globToRegExp,
  parseFrontmatter,
  selectSkills,
  skillsPreamble,
  type LoadedSkill,
} from "../src/skills/loader.js";

function skill(name: string, body = `corpo de ${name}`): LoadedSkill {
  return { name, description: `sobre ${name}`, body, origin: `/x/${name}/SKILL.md`, hash: "abc" };
}

function escreveSkill(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\ncorpo`);
}

test("frontmatter com fim de linha do Windows é lido igual", () => {
  const lido = parseFrontmatter('---\r\nname: "front"\r\ndescription: telas\r\n---\r\ncorpo\r\n');
  assert.equal(lido.name, "front");
  assert.equal(lido.description, "telas");
  assert.match(lido.body, /^corpo/);
  assert.equal(parseFrontmatter("sem cabeçalho").name, undefined);
});

test("glob casa pasta em qualquer profundidade e não atravessa barra com um asterisco", () => {
  assert.ok(globToRegExp("**/*.tsx").test("App.tsx"));
  assert.ok(globToRegExp("**/*.tsx").test("web/src/App.tsx"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
  assert.ok(globToRegExp("akad/*").test("akad/locum"));
  assert.ok(!globToRegExp("*.ts").test("a.tsx"));
});

test("seleção pelos arquivos alterados, pelo repo e por always, sem repetir", () => {
  const catalogo = new Map([skill("front"), skill("back"), skill("geral"), skill("repo")].map((s) => [s.name, s]));
  const escolhidas = selectSkills(
    [
      { skill: "front", when: { filesMatch: ["**/*.tsx"] } },
      { skill: "back", when: { filesMatch: ["**/*.cs"] } },
      { skill: "geral", when: { always: true } },
      { skill: "repo", when: { repoMatch: ["acme/*"] } },
      { skill: "front", when: { always: true } },
      { skill: "inexistente", when: { always: true } },
    ],
    { repo: "acme/web", changedFiles: ["web/src/App.tsx", "README.md"] },
    catalogo,
  );
  assert.deepEqual(
    escolhidas.map((s) => s.name),
    ["front", "geral", "repo"],
  );
});

test("preâmbulo traz só nome e descrição, ou o corpo quando inline", () => {
  assert.equal(skillsPreamble([], false), "");
  assert.equal(skillsPreamble([skill("a")], false), "Skills disponiveis para esta tarefa:\n- a: sobre a");
  assert.equal(skillsPreamble([skill("a", "faça X")], true), "## Skill: a\n\nfaça X");
});

test("descoberta usa o installPath dos plugins instalados e ignora versão velha e fonte de marketplace", () => {
  const home = mkdtempSync(join(tmpdir(), "locum-skills-"));
  const plugins = join(home, ".claude", "plugins");
  const atual = join(plugins, "cache", "mkt", "plug", "2.0.0");
  escreveSkill(join(atual, "skills", "nova"), "nova");
  escreveSkill(join(plugins, "cache", "mkt", "plug", "1.0.0", "skills", "velha"), "velha");
  escreveSkill(join(plugins, "marketplaces", "mkt", "skills", "solta"), "solta");
  escreveSkill(join(atual, "node_modules", "dep", "skills", "dep"), "dep");
  writeFileSync(
    join(plugins, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "plug@mkt": [{ installPath: atual }] } }),
  );
  escreveSkill(join(home, ".claude", "skills", "minha"), "minha");
  symlinkSync(join(home, "nao-existe"), join(home, ".claude", "skills", "quebrado"));

  const achadas = discoverSkills(home, join(home, "projeto"));
  assert.deepEqual([...achadas.keys()].sort(), ["minha", "nova"]);
});

test("sem installed_plugins.json a pasta de plugins é varrida inteira", () => {
  const home = mkdtempSync(join(tmpdir(), "locum-skills-"));
  escreveSkill(join(home, ".claude", "plugins", "cache", "mkt", "plug", "1.0.0", "skills", "funda"), "funda");
  assert.deepEqual([...discoverSkills(home, home).keys()], ["funda"]);
});
