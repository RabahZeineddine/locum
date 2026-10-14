import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TemplateSource, type FetchLike } from "../src/services/template-source.js";

/** A fonte dos templates do marketplace: remoto primeiro, cópia empacotada de reserva. */

const spec = (id: string, extra: object = {}) => JSON.stringify({ id, name: id.toUpperCase(), steps: [], ...extra });

async function pastaLocal(arquivos: Record<string, string>): Promise<string> {
  const pasta = await mkdtemp(join(tmpdir(), "locum-templates-"));
  for (const [nome, conteudo] of Object.entries(arquivos)) await writeFile(join(pasta, nome), conteudo);
  return pasta;
}

function remoto(arquivos: Record<string, string>): { fetch: FetchLike; chamadas: string[] } {
  const chamadas: string[] = [];
  const fetch: FetchLike = async (url) => {
    chamadas.push(url);
    if (url.includes("api.github.com")) {
      return Response.json(
        Object.keys(arquivos).map((nome) => ({ name: nome, type: "file", download_url: `https://raw.test/${nome}` })),
      );
    }
    const nome = url.split("/").pop() as string;
    const corpo = arquivos[nome];
    return corpo === undefined ? new Response("", { status: 404 }) : new Response(corpo);
  };
  return { fetch, chamadas };
}

test("lista os templates do remoto, ignorando o que não é JSON válido", async () => {
  const { fetch } = remoto({ "a.json": spec("aa"), "quebrado.json": "{nao", "leia.md": "x" });
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({ "local.json": spec("loc") }) });
  const lista = await fonte.listar();
  assert.deepEqual(lista.map((t) => t.id), ["aa"]);
});

test("remoto fora do ar cai para a cópia empacotada", async () => {
  const fetch: FetchLike = async () => {
    throw new Error("offline");
  };
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({ "local.json": spec("loc") }) });
  assert.deepEqual((await fonte.listar()).map((t) => t.id), ["loc"]);
});

test("remoto com erro HTTP cai para a cópia empacotada", async () => {
  const fetch: FetchLike = async () => new Response("limite", { status: 403 });
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({ "local.json": spec("loc") }) });
  assert.deepEqual((await fonte.listar()).map((t) => t.id), ["loc"]);
});

test("instalar devolve o mesmo conteúdo que a listagem mostrou", async () => {
  const { fetch } = remoto({ "aa.json": spec("aa", { instructions: "remoto" }) });
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({ "aa.json": spec("aa", { instructions: "local" }) }) });
  const [item] = await fonte.listar();
  assert.equal(item?.id, "aa");
  const bruto = await fonte.ler("aa");
  assert.equal(bruto.instructions, "remoto");
});

test("instalar com remoto fora do ar lê da mesma cópia empacotada da listagem", async () => {
  const fetch: FetchLike = async () => {
    throw new Error("offline");
  };
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({ "loc.json": spec("loc") }) });
  const [item] = await fonte.listar();
  assert.equal(item?.id, "loc");
  assert.equal((await fonte.ler("loc")).id, "loc");
});

test("instalar id que a listagem remota não tem cai na cópia empacotada", async () => {
  const { fetch } = remoto({ "aa.json": spec("aa") });
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({ "bb.json": spec("bb") }) });
  assert.equal((await fonte.ler("bb")).id, "bb");
});

test("id inválido é recusado antes de qualquer leitura", async () => {
  const { fetch, chamadas } = remoto({});
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({}) });
  await assert.rejects(() => fonte.ler("../etc/passwd"), /id de template inválido/);
  assert.equal(chamadas.length, 0);
});

test("template que não existe em lugar nenhum dá erro claro", async () => {
  const { fetch } = remoto({});
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({}) });
  await assert.rejects(() => fonte.ler("nada-aqui"), /não encontrado/);
});

test("a listagem traz o nome de cada passo de modelo, com a chave de reserva", async () => {
  const steps = [
    { type: "action", key: "a", name: "Agir" },
    { type: "model", key: "triagem", name: "Triagem", model: "claude-code/claude-sonnet-5" },
    { type: "model", key: "sem-nome", model: "claude-code/claude-opus-5" },
  ];
  const { fetch } = remoto({ "aa.json": spec("aa", { steps }) });
  const fonte = new TemplateSource({ fetch, pastaLocal: await pastaLocal({}) });
  const [item] = await fonte.listar();
  assert.deepEqual(item?.passosDeModelo, [
    { indice: 1, nome: "Triagem", modelo: "claude-code/claude-sonnet-5" },
    { indice: 2, nome: "sem-nome", modelo: "claude-code/claude-opus-5" },
  ]);
});
