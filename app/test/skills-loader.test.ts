import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  descobrirComSombra,
  discoverSkills,
  globToRegExp,
  parseFrontmatter,
  selectSkills,
  skillsAusentes,
  skillsPreamble,
  type LoadedSkill,
} from "../src/skills/loader.js";

function skill(name: string, body = `corpo de ${name}`): LoadedSkill {
  return { name, description: `sobre ${name}`, body, origin: `/x/${name}/SKILL.md`, hash: "abc", fonte: { tipo: "minhas" } };
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
  assert.equal(skillsPreamble([skill("a", "faça X")], true), "## Skill: a\n\nArquivos desta skill em: /x/a\n\nfaça X");
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

test("a descoberta diz de onde veio cada skill: minhas, plugin com versão, Locum e projeto", () => {
  const home = mkdtempSync(join(tmpdir(), "locum-skills-"));
  const plugins = join(home, ".claude", "plugins");
  const atual = join(plugins, "cache", "mkt", "plug", "2.0.0");
  escreveSkill(join(atual, "skills", "de-plugin"), "de-plugin");
  writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "plug@mkt": [{ installPath: atual, version: "2.0.0" }] } }));
  escreveSkill(join(home, ".claude", "skills", "minha"), "minha");
  escreveSkill(join(home, "projeto", ".claude", "skills", "do-projeto"), "do-projeto");
  const locum = join(home, "locum-skills");
  escreveSkill(join(locum, "criada"), "criada");

  const achadas = discoverSkills(home, join(home, "projeto"), locum);
  assert.deepEqual(achadas.get("minha")?.fonte, { tipo: "minhas" });
  assert.deepEqual(achadas.get("de-plugin")?.fonte, { tipo: "plugin", plugin: "plug", versao: "2.0.0" });
  assert.deepEqual(achadas.get("do-projeto")?.fonte, { tipo: "projeto" });
  assert.deepEqual(achadas.get("criada")?.fonte, { tipo: "locum" });
});

test("skill da máquina vence a do Locum de mesmo nome", () => {
  const home = mkdtempSync(join(tmpdir(), "locum-skills-"));
  escreveSkill(join(home, ".claude", "skills", "igual"), "igual");
  const locum = join(home, "locum-skills");
  escreveSkill(join(locum, "igual"), "igual");
  assert.deepEqual(discoverSkills(home, join(home, "projeto"), locum).get("igual")?.fonte, { tipo: "minhas" });
});

test("LOCUM_CLAUDE_DIR troca a pasta das minhas skills quando ninguém passa o home", () => {
  const pasta = mkdtempSync(join(tmpdir(), "locum-claude-"));
  escreveSkill(join(pasta, "skills", "da-pasta"), "da-pasta");
  const antes = process.env.LOCUM_CLAUDE_DIR;
  process.env.LOCUM_CLAUDE_DIR = pasta;
  try {
    assert.ok(discoverSkills(undefined, pasta, join(pasta, "nada")).has("da-pasta"));
  } finally {
    if (antes === undefined) delete process.env.LOCUM_CLAUDE_DIR;
    else process.env.LOCUM_CLAUDE_DIR = antes;
  }
});

test("skills ausentes: as que o agent cita e o catálogo não tem", () => {
  const catalogo = new Map([skill("presente")].map((s) => [s.name, s]));
  assert.deepEqual(
    skillsAusentes([{ skill: "presente", when: { always: true } }, { skill: "sumiu", when: { always: true } }], catalogo),
    ["sumiu"],
  );
});

test("inline recusa skill acima de 64 KB e o total acima de 256 KB, com o nome e o tamanho", () => {
  assert.throws(() => skillsPreamble([skill("pesada", "x".repeat(65 * 1024))], true), /pesada.*65 KB/);
  const quatro = ["a", "b", "c", "d", "e"].map((n) => skill(n, "x".repeat(60 * 1024)));
  assert.throws(() => skillsPreamble(quatro, true), /256 KB/);
  assert.doesNotThrow(() => skillsPreamble(quatro.slice(0, 4), true));
});

test("o teto de 64 KB por skill vale só no claude-code; nos outros runtimes fica o teto total", () => {
  const pesada = skill("pesada", "x".repeat(100 * 1024));
  assert.throws(() => skillsPreamble([pesada], true, "claude-code"), /pesada.*100 KB/);
  assert.doesNotThrow(() => skillsPreamble([pesada], true, "native"));
  assert.throws(() => skillsPreamble([skill("enorme", "x".repeat(257 * 1024))], true, "native"), /enorme.*257 KB/);
  assert.throws(() => skillsPreamble([pesada, pesada, skill("c", "x".repeat(70 * 1024))], true, "native"), /256 KB/);
});

test("skills ausentes olha só as regras que casam com o evento", () => {
  const catalogo = new Map([skill("presente")].map((s) => [s.name, s]));
  const regras = [
    { skill: "presente", when: { always: true } },
    { skill: "so-cs", when: { filesMatch: ["**/*.cs"] } },
    { skill: "so-acme", when: { repoMatch: ["acme/*"] } },
  ];
  assert.deepEqual(skillsAusentes(regras, catalogo, { repo: "outro/x", changedFiles: ["a.ts"] }), []);
  assert.deepEqual(skillsAusentes(regras, catalogo, { repo: "acme/x", changedFiles: ["a.cs"] }), ["so-cs", "so-acme"]);
});

test("sem projeto, a raiz do cwd não entra na descoberta", () => {
  const home = mkdtempSync(join(tmpdir(), "locum-skills-"));
  escreveSkill(join(home, "projeto", ".claude", "skills", "do-projeto"), "do-projeto");
  const locum = join(home, "locum-skills");
  assert.ok(discoverSkills(home, join(home, "projeto"), locum).has("do-projeto"));
  assert.equal(descobrirComSombra(home, join(home, "projeto"), locum, { projeto: false }).achadas.has("do-projeto"), false);
});

test("nome do Locum igual ao de uma skill da máquina: a da máquina vence e a do Locum volta como sombreada", () => {
  const home = mkdtempSync(join(tmpdir(), "locum-skills-"));
  escreveSkill(join(home, ".claude", "skills", "igual"), "igual");
  const locum = join(home, "locum-skills");
  escreveSkill(join(locum, "igual"), "igual");
  const { achadas, sombreadas } = descobrirComSombra(home, join(home, "projeto"), locum);
  assert.deepEqual(achadas.get("igual")?.fonte, { tipo: "minhas" });
  assert.deepEqual(sombreadas.map((s) => [s.name, s.fonte.tipo]), [["igual", "locum"]]);
});
