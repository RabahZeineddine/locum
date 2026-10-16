import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SkillsService } from "../src/services/skills-service.js";

/** A área de Skills: o que a máquina tem, o que o Locum guarda, e o vínculo com a origem. */

function ambiente(agentes: { id: string; name: string; skills: string[] }[] = []) {
  const raiz = mkdtempSync(join(tmpdir(), "locum-skills-svc-"));
  const home = join(raiz, "home");
  const locumDir = join(raiz, "locum", "skills");
  let agora = 1_000;
  const servico = new SkillsService({
    home,
    cwd: join(raiz, "projeto"),
    locumDir,
    agentes: async () => agentes,
    agora: () => agora,
  });
  const daMaquina = (nome: string, descricao = "d", corpo = "corpo"): string => {
    const dir = join(home, ".claude", "skills", nome);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${nome}\ndescription: ${descricao}\n---\n${corpo}`);
    return join(dir, "SKILL.md");
  };
  return { raiz, home, locumDir, servico, daMaquina, passar: (ms: number) => (agora += ms) };
}

test("criar guarda a skill no home do Locum e ela entra na lista como editável", async () => {
  const { servico, locumDir } = ambiente();
  const criada = await servico.criar({ name: "revisao-curta", description: "Revisa em cinco linhas", body: "# Revisão\n\nSeja breve." });
  assert.equal(criada.fonte.tipo, "locum");
  assert.equal(criada.editavel, true);
  assert.equal(criada.arquivo, join(locumDir, "revisao-curta", "SKILL.md"));
  assert.match(readFileSync(criada.arquivo, "utf8"), /^---\nname: revisao-curta\ndescription: Revisa em cinco linhas\n---\n# Revisão/);
  assert.deepEqual((await servico.listar()).map((s) => s.name), ["revisao-curta"]);
});

test("nome fora do padrão e nome já usado são recusados, inclusive o de skill da máquina", async () => {
  const { servico, daMaquina } = ambiente();
  daMaquina("da-maquina");
  await assert.rejects(servico.criar({ name: "Com Espaço", description: "d", body: "x" }), /minúsculas, dígitos e hífens/);
  await servico.criar({ name: "unica", description: "d", body: "x" });
  await assert.rejects(servico.criar({ name: "unica", description: "d", body: "x" }), /já existe/);
  await assert.rejects(servico.criar({ name: "da-maquina", description: "d", body: "x" }), /já existe uma skill da máquina/);
});

test("atualizar troca descrição e corpo e muda o hash; skill da máquina não se edita nem se remove", async () => {
  const { servico, daMaquina } = ambiente();
  daMaquina("minha");
  const antes = await servico.criar({ name: "editavel", description: "velha", body: "velho" });
  const depois = await servico.atualizar("editavel", { description: "nova", body: "novo" });
  assert.equal(depois.description, "nova");
  assert.notEqual(depois.hash, antes.hash);
  assert.equal((await servico.obter("editavel")).corpo.trim(), "novo");
  await assert.rejects(servico.atualizar("minha", { description: "x", body: "y" }), /só as skills do Locum/);
  await assert.rejects(servico.remover("minha"), /só as skills do Locum/);
});

test("remover apaga a pasta da skill do Locum", async () => {
  const { servico, locumDir } = ambiente();
  await servico.criar({ name: "descartavel", description: "d", body: "x" });
  await servico.remover("descartavel");
  assert.equal(existsSync(join(locumDir, "descartavel")), false);
  assert.deepEqual(await servico.listar(), []);
});

test("importar um .md com cabeçalho cria cópia do Locum e deixa o original como está", async () => {
  const { servico, raiz } = ambiente();
  const origem = join(raiz, "solta.md");
  const conteudo = "---\nname: solta\ndescription: Veio de fora\n---\nCorpo da solta";
  writeFileSync(origem, conteudo);
  const importada = await servico.importar(origem);
  assert.equal(importada.fonte.tipo, "locum");
  assert.equal(importada.description, "Veio de fora");
  assert.equal(readFileSync(origem, "utf8"), conteudo);
  writeFileSync(origem, "---\nname: solta\ndescription: Mudou lá\n---\nOutro");
  assert.equal((await servico.obter("solta")).description, "Veio de fora");
});

test("importar um .md sem cabeçalho usa o nome do arquivo", async () => {
  const { servico, raiz } = ambiente();
  const origem = join(raiz, "Guia Rápido.md");
  writeFileSync(origem, "# Guia\n\nPassos.");
  const importada = await servico.importar(origem);
  assert.equal(importada.name, "guia-rapido");
  assert.match((await servico.obter("guia-rapido")).corpo, /# Guia/);
});

test("importar uma pasta com SKILL.md copia a pasta inteira, com os arquivos de apoio", async () => {
  const { servico, raiz, locumDir } = ambiente();
  const pasta = join(raiz, "pacote-skill");
  mkdirSync(join(pasta, "refs"), { recursive: true });
  writeFileSync(join(pasta, "SKILL.md"), "---\nname: com-apoio\ndescription: Tem anexo\n---\nVeja refs/guia.md");
  writeFileSync(join(pasta, "refs", "guia.md"), "guia");
  const importada = await servico.importar(pasta);
  assert.equal(importada.name, "com-apoio");
  assert.equal(readFileSync(join(locumDir, "com-apoio", "refs", "guia.md"), "utf8"), "guia");
  await assert.rejects(servico.importar(join(raiz, "nada")), /não encontrei/);
  mkdirSync(join(raiz, "vazia"));
  await assert.rejects(servico.importar(join(raiz, "vazia")), /SKILL\.md/);
});

test("a lista mostra origem, plugin com versão e os agents que usam cada skill", async () => {
  const { servico, home, daMaquina } = ambiente([
    { id: "triagem", name: "Triagem", skills: ["minha", "de-plugin"] },
    { id: "resumo", name: "Resumo", skills: ["minha"] },
  ]);
  daMaquina("minha");
  const instalado = join(home, ".claude", "plugins", "cache", "mkt", "plug", "2.0.0");
  mkdirSync(join(instalado, "skills", "de-plugin"), { recursive: true });
  writeFileSync(join(instalado, "skills", "de-plugin", "SKILL.md"), "---\nname: de-plugin\ndescription: do plugin\n---\ncorpo");
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "plug@mkt": [{ installPath: instalado, version: "2.0.0" }] } }));
  const lista = await servico.listar();
  const por = Object.fromEntries(lista.map((s) => [s.name, s]));
  assert.deepEqual(por["minha"]?.fonte, { tipo: "minhas" });
  assert.equal(por["minha"]?.editavel, false);
  assert.deepEqual(por["de-plugin"]?.fonte, { tipo: "plugin", plugin: "plug", versao: "2.0.0" });
  assert.deepEqual(por["minha"]?.agents.map((a) => a.id), ["triagem", "resumo"]);
});

test("skill da máquina vem ao vivo com cache curto, e atualizar força a leitura", async () => {
  const { servico, daMaquina, passar } = ambiente();
  daMaquina("primeira");
  assert.deepEqual((await servico.listar()).map((s) => s.name), ["primeira"]);
  daMaquina("segunda");
  assert.deepEqual((await servico.listar()).map((s) => s.name), ["primeira"], "dentro do cache");
  assert.deepEqual((await servico.listar({ atualizar: true })).map((s) => s.name), ["primeira", "segunda"]);
  daMaquina("terceira");
  passar(60_000);
  assert.equal((await servico.listar()).length, 3, "o cache vence sozinho");
});

test("nome com caminho é recusado em criar, atualizar e remover, e nada fora do Locum muda", async () => {
  const { servico, raiz, home } = ambiente();
  const alheia = join(home, ".claude", "skills", "x");
  mkdirSync(alheia, { recursive: true });
  writeFileSync(join(alheia, "SKILL.md"), "---\nname: x\ndescription: d\n---\nintacta");
  const fuga = relative(join(raiz, "locum", "skills"), alheia);
  await assert.rejects(servico.atualizar(fuga, { description: "d", body: "invadida" }), /minúsculas, dígitos e hífens/);
  await assert.rejects(servico.remover(fuga), /minúsculas, dígitos e hífens/);
  await assert.rejects(servico.criar({ name: fuga, description: "d", body: "x" }), /minúsculas, dígitos e hífens/);
  assert.match(readFileSync(join(alheia, "SKILL.md"), "utf8"), /intacta/);
});

test("pasta do Locum que é link para fora não se edita nem se remove", async () => {
  const { servico, raiz, locumDir } = ambiente();
  const fora = join(raiz, "fora");
  mkdirSync(fora, { recursive: true });
  writeFileSync(join(fora, "SKILL.md"), "---\nname: espelho\ndescription: d\n---\nintacta");
  mkdirSync(locumDir, { recursive: true });
  symlinkSync(fora, join(locumDir, "espelho"));
  await assert.rejects(servico.atualizar("espelho", { description: "d", body: "invadida" }), /fora da pasta de skills do Locum/);
  await assert.rejects(servico.remover("espelho"), /fora da pasta de skills do Locum/);
  assert.match(readFileSync(join(fora, "SKILL.md"), "utf8"), /intacta/);
});

test("importar recusa SKILL.md e .md avulso que sejam link, e arquivo avulso acima do teto", async () => {
  const { servico, raiz } = ambiente();
  const segredo = join(raiz, "segredo.txt");
  writeFileSync(segredo, "conteudo-privado");
  const pasta = join(raiz, "com-link");
  mkdirSync(pasta);
  symlinkSync(segredo, join(pasta, "SKILL.md"));
  await assert.rejects(servico.importar(pasta), /link/);
  const avulso = join(raiz, "avulso.md");
  symlinkSync(segredo, avulso);
  await assert.rejects(servico.importar(avulso), /link/);
  const grande = join(raiz, "grande.md");
  writeFileSync(grande, "x".repeat(257 * 1024));
  await assert.rejects(servico.importar(grande), /256 KB/);
  assert.deepEqual(await servico.listar({ atualizar: true }), []);
});

test("importar pasta com barra no fim copia os nomes inteiros", async () => {
  const { servico, raiz, locumDir } = ambiente();
  const pasta = join(raiz, "com-barra");
  mkdirSync(join(pasta, "refs"), { recursive: true });
  writeFileSync(join(pasta, "SKILL.md"), "---\nname: com-barra\ndescription: d\n---\ncorpo");
  writeFileSync(join(pasta, "refs", "guia.md"), "guia");
  await servico.importar(`${pasta}/`);
  assert.equal(existsSync(join(locumDir, "com-barra", "SKILL.md")), true);
  assert.equal(readFileSync(join(locumDir, "com-barra", "refs", "guia.md"), "utf8"), "guia");
});

test("o grupo Projeto só existe quando o serviço é criado com projeto", async () => {
  const { raiz, home, locumDir } = ambiente();
  const dir = join(raiz, "projeto", ".claude", "skills", "do-repo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: do-repo\ndescription: d\n---\ncorpo");
  const opcoes = { home, cwd: join(raiz, "projeto"), locumDir, agentes: async () => [] };
  assert.deepEqual((await new SkillsService(opcoes).listar()).map((s) => s.name), []);
  const comProjeto = await new SkillsService({ ...opcoes, comProjeto: true }).listar();
  assert.deepEqual(comProjeto.map((s) => [s.name, s.fonte.tipo]), [["do-repo", "projeto"]]);
});

test("nome repetido entre o Locum e a máquina aparece nas duas, cada uma com o aviso do conflito", async () => {
  const { servico, daMaquina, locumDir } = ambiente();
  daMaquina("repetida");
  mkdirSync(join(locumDir, "repetida"), { recursive: true });
  writeFileSync(join(locumDir, "repetida", "SKILL.md"), "---\nname: repetida\ndescription: do Locum\n---\ncorpo");
  const lista = (await servico.listar()).filter((s) => s.name === "repetida");
  assert.deepEqual(lista.map((s) => [s.fonte.tipo, s.conflito?.tipo]).sort(), [["locum", "minhas"], ["minhas", "locum"]]);
});

test("o catálogo para o chat usa o mesmo cache curto da lista", async () => {
  const { servico, daMaquina, passar } = ambiente();
  daMaquina("primeira");
  assert.deepEqual([...servico.catalogo().keys()], ["primeira"]);
  daMaquina("segunda");
  assert.deepEqual([...servico.catalogo().keys()], ["primeira"], "dentro do cache");
  passar(60_000);
  assert.deepEqual([...servico.catalogo().keys()].sort(), ["primeira", "segunda"]);
});
