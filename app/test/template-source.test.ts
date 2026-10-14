import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TemplateSource, type FetchLike } from "../src/services/template-source.js";

/** A fonte dos templates do marketplace: remoto primeiro, cópia empacotada de reserva. */

const spec = (id: string, extra: object = {}) => JSON.stringify({ id, name: id.toUpperCase(), steps: [], ...extra });
const RAW = "https://raw.githubusercontent.com/RabahZeineddine/locum/main/examples/agents/";

async function pastaLocal(arquivos: Record<string, string>): Promise<string> {
  const pasta = await mkdtemp(join(tmpdir(), "locum-templates-"));
  for (const [nome, conteudo] of Object.entries(arquivos)) await writeFile(join(pasta, nome), conteudo);
  return pasta;
}

/** Um remoto que pode ser derrubado no meio do teste; `corpos` troca o conteúdo servido. */
function remoto(arquivos: Record<string, string>, hostDoArquivo = RAW) {
  const estado = { fora: false, corpos: { ...arquivos }, chamadas: [] as string[] };
  const fetch: FetchLike = async (url) => {
    estado.chamadas.push(url);
    if (estado.fora) throw new Error("offline");
    if (url.includes("api.github.com")) {
      return Response.json(
        Object.keys(estado.corpos).map((nome) => ({ name: nome, type: "file", download_url: `${hostDoArquivo}${nome}` })),
      );
    }
    const corpo = estado.corpos[url.split("/").pop() as string];
    return corpo === undefined ? new Response("", { status: 404 }) : new Response(corpo);
  };
  return { fetch, estado };
}

test("lista os templates do remoto, ignorando o que não é JSON válido", async () => {
  const { fetch } = remoto({ "aa.json": spec("aa"), "quebrado.json": "{nao", "leia.md": "x" });
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({ "loc.json": spec("loc") }) });
  const lista = await fonte.listar();
  assert.deepEqual(lista.map((t) => [t.id, t.origem]), [["aa", "remoto"]]);
});

test("remoto fora do ar cai para a cópia empacotada", async () => {
  const { fetch, estado } = remoto({});
  estado.fora = true;
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({ "loc.json": spec("loc") }) });
  assert.deepEqual((await fonte.listar()).map((t) => [t.id, t.origem]), [["loc", "local"]]);
});

test("remoto com erro HTTP cai para a cópia empacotada", async () => {
  const fetch: FetchLike = async () => new Response("limite", { status: 403 });
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({ "loc.json": spec("loc") }) });
  assert.deepEqual((await fonte.listar()).map((t) => t.id), ["loc"]);
});

test("instalar usa o conteúdo que a listagem mostrou, mesmo com o remoto fora do ar", async () => {
  const { fetch, estado } = remoto({ "aa.json": spec("aa", { instructions: "remoto" }) });
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({ "aa.json": spec("aa", { instructions: "local" }) }) });
  await fonte.listar();
  estado.fora = true;
  assert.equal((await fonte.ler("aa")).instructions, "remoto");
});

test("instalar usa o conteúdo listado mesmo que o remoto mude depois", async () => {
  const { fetch, estado } = remoto({ "aa.json": spec("aa", { instructions: "v1" }) });
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({}) });
  await fonte.listar();
  estado.corpos["aa.json"] = spec("aa", { instructions: "v2" });
  assert.equal((await fonte.ler("aa")).instructions, "v1");
});

test("id que a listagem não mostrou não é instalado, nem da cópia empacotada", async () => {
  const { fetch } = remoto({ "aa.json": spec("aa") });
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({ "bb.json": spec("bb") }) });
  await fonte.listar();
  await assert.rejects(() => fonte.ler("bb"), /não encontrado/);
});

test("sem listagem prévia, ler lista pelo mesmo caminho e lê dali", async () => {
  const { fetch } = remoto({ "aa.json": spec("aa") });
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({}) });
  assert.equal((await fonte.ler("aa")).id, "aa");
});

test("listagem vencida é refeita ao instalar", async () => {
  const { fetch, estado } = remoto({ "aa.json": spec("aa", { instructions: "v1" }) });
  let agora = 0;
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({}), agora: () => agora });
  await fonte.listar();
  estado.corpos["aa.json"] = spec("aa", { instructions: "v2" });
  agora = 11 * 60 * 1000;
  assert.equal((await fonte.ler("aa")).instructions, "v2");
});

test("trocar o modelo do que ler não vaza para a leitura seguinte", async () => {
  const { fetch } = remoto({ "aa.json": spec("aa", { steps: [{ model: "x/y" }] }) });
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({}) });
  const primeiro = await fonte.ler("aa");
  (primeiro.steps![0] as { model: string }).model = "outro/modelo";
  assert.equal(((await fonte.ler("aa")).steps![0] as { model: string }).model, "x/y");
});

test("id inválido é recusado antes de qualquer leitura", async () => {
  const { fetch, estado } = remoto({});
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({}) });
  await assert.rejects(() => fonte.ler("../etc/passwd"), /id de template inválido/);
  assert.equal(estado.chamadas.length, 0);
});

test("template que não existe em lugar nenhum dá erro claro", async () => {
  const { fetch } = remoto({});
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({}) });
  await assert.rejects(() => fonte.ler("nada-aqui"), /não encontrado/);
});

test("a listagem traz o nome de cada passo de modelo e não o modelo do template", async () => {
  const steps = [
    { type: "action", key: "a", name: "Agir" },
    { type: "model", key: "triagem", name: "Triagem", model: "claude-code/claude-sonnet-5" },
    { type: "model", key: "sem-nome", model: "claude-code/opus" },
  ];
  const { fetch } = remoto({ "aa.json": spec("aa", { steps }) });
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({}) });
  const [item] = await fonte.listar();
  assert.deepEqual(item?.passosDeModelo, [
    { indice: 1, nome: "Triagem" },
    { indice: 2, nome: "sem-nome" },
  ]);
});

test("download remoto que falha usa o arquivo local de mesmo nome, marcado como local", async () => {
  const { fetch, estado } = remoto({ "aa.json": spec("aa"), "bb.json": spec("bb") });
  delete estado.corpos["bb.json"];
  const base = fetch;
  // A listagem ainda anuncia bb.json, mas o arquivo dá 404.
  const comBb: FetchLike = async (url, init) =>
    url.includes("api.github.com")
      ? Response.json(["aa.json", "bb.json"].map((nome) => ({ name: nome, type: "file", download_url: `${RAW}${nome}` })))
      : base(url, init);
  const fonte = new TemplateSource({ fetch: comBb, pastaLocal: await pastaLocal({ "bb.json": spec("bb", { instructions: "local" }) }) });
  assert.deepEqual((await fonte.listar()).map((t) => [t.id, t.origem]), [["aa", "remoto"], ["bb", "local"]]);
  assert.equal((await fonte.ler("bb")).instructions, "local");
});

test("download_url de outro host não é baixado", async () => {
  const { fetch, estado } = remoto({ "aa.json": spec("aa") }, "https://evil.test/");
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({}) });
  assert.deepEqual(await fonte.listar(), []);
  assert.equal(estado.chamadas.some((u) => u.startsWith("https://evil.test")), false);
});

test("corpo acima do limite é recusado", async () => {
  const grande = spec("aa", { instructions: "x".repeat(300 * 1024) });
  const { fetch } = remoto({ "aa.json": grande });
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({ "aa.json": spec("aa", { instructions: "local" }) }) });
  const [item] = await fonte.listar();
  assert.equal(item?.origem, "local");
});

test("id fora do padrão é descartado e duplicado fica com o primeiro", async () => {
  const { fetch } = remoto({ "a.json": spec("Maiusculo"), "b.json": spec("dup", { instructions: "primeiro" }), "c.json": spec("dup", { instructions: "segundo" }) });
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({}) });
  assert.deepEqual((await fonte.listar()).map((t) => t.id), ["dup"]);
  assert.equal((await fonte.ler("dup")).instructions, "primeiro");
});
