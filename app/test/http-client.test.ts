import { test } from "node:test";
import assert from "node:assert/strict";
import { criarClienteHttp, ErroDeRede, tipoDaFalha } from "../src/net/http.js";

/**
 * O cliente HTTP do processo principal.
 *
 * O `fetch` de baixo é de mentira e responde uma lista de passos, um por
 * tentativa. A espera entre tentativas é anotada e não dorme.
 */

type Passo = Response | Error | "pendurar";

function baseDeMentira(passos: Passo[]) {
  const chamadas: { url: string; metodo: string }[] = [];
  const base = (async (entrada: string, init?: RequestInit) => {
    chamadas.push({ url: entrada, metodo: init?.method ?? "GET" });
    const passo = passos.shift();
    if (passo === undefined) throw new Error("tentativa a mais");
    if (passo === "pendurar") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    if (passo instanceof Error) throw passo;
    return passo;
  }) as unknown as typeof fetch;
  return { chamadas, base: () => base };
}

function quedaDoElectron(codigo: string): Error {
  return new Error(`net::${codigo}`);
}

function quedaDoNode(codigo: string): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(codigo), { code: codigo }) });
}

test("rede que troca no meio repete e a segunda tentativa responde", async () => {
  const { chamadas, base } = baseDeMentira([quedaDoElectron("ERR_NETWORK_CHANGED"), new Response("ok")]);
  const esperas: number[] = [];
  const cliente = criarClienteHttp({ base, esperar: async (ms) => void esperas.push(ms) });

  const resposta = await cliente("https://api.github.com/repos/x/y/releases/latest");
  assert.equal(await resposta.text(), "ok");
  assert.equal(chamadas.length, 2);
  assert.deepEqual(esperas, [500]);
});

test("sem rede até o fim vira ErroDeRede offline com o host e o código", async () => {
  const { chamadas, base } = baseDeMentira([
    quedaDoNode("ENOTFOUND"),
    quedaDoNode("ENOTFOUND"),
    quedaDoNode("ENOTFOUND"),
  ]);
  const cliente = criarClienteHttp({ base, esperar: async () => {} });

  const erro = await cliente("https://slack.com/api/x").catch((e: unknown) => e);
  assert.ok(erro instanceof ErroDeRede);
  assert.equal(tipoDaFalha(erro), "offline");
  assert.equal(erro.codigo, "ENOTFOUND");
  assert.match(erro.message, /slack\.com/);
  assert.equal(chamadas.length, 3);
});

test("POST não repete por padrão, para não mandar a mesma mensagem duas vezes", async () => {
  const { chamadas, base } = baseDeMentira([quedaDoNode("ECONNRESET")]);
  const cliente = criarClienteHttp({ base, esperar: async () => {} });

  const erro = await cliente("https://graph.microsoft.com/v1.0/chats/x/messages", { method: "POST", body: "{}" }).catch(
    (e: unknown) => e,
  );
  assert.equal(tipoDaFalha(erro), "rede");
  assert.equal(chamadas.length, 1);
});

test("POST de leitura repete quando o cliente foi criado para isso", async () => {
  const { chamadas, base } = baseDeMentira([quedaDoNode("ECONNRESET"), new Response("{}")]);
  const cliente = criarClienteHttp({ base, repetirPost: true, esperar: async () => {} });

  await cliente("https://slack.com/api/search", { method: "POST", body: new URLSearchParams({ q: "x" }) });
  assert.equal(chamadas.length, 2);
});

test("429 espera o Retry-After e 404 volta direto para quem chamou", async () => {
  const { chamadas, base } = baseDeMentira([
    new Response("", { status: 429, headers: { "retry-after": "2" } }),
    new Response("", { status: 404 }),
  ]);
  const esperas: number[] = [];
  const cliente = criarClienteHttp({ base, esperar: async (ms) => void esperas.push(ms) });

  const resposta = await cliente("https://api.github.com/x");
  assert.equal(resposta.status, 404);
  assert.equal(chamadas.length, 2);
  assert.deepEqual(esperas, [2000]);
});

test("Retry-After longo demais devolve o 429 em vez de segurar a chamada", async () => {
  const { chamadas, base } = baseDeMentira([new Response("", { status: 429, headers: { "retry-after": "600" } })]);
  const cliente = criarClienteHttp({ base, esperar: async () => assert.fail("não devia esperar") });

  assert.equal((await cliente("https://api.github.com/x")).status, 429);
  assert.equal(chamadas.length, 1);
});

test("servidor que não responde estoura o prazo como timeout", async () => {
  const { base } = baseDeMentira(["pendurar"]);
  const cliente = criarClienteHttp({ base, prazoMs: 10, tentativas: 1 });

  const erro = await cliente("https://api.github.com/x").catch((e: unknown) => e);
  assert.equal(tipoDaFalha(erro), "timeout");
});

test("quem chamou desistiu: o abort sobe como veio, sem nova tentativa", async () => {
  const { chamadas, base } = baseDeMentira(["pendurar", new Response("não devia")]);
  const cliente = criarClienteHttp({ base, esperar: async () => {} });
  const controle = new AbortController();

  const pedido = cliente("https://api.github.com/x", { signal: controle.signal }).catch((e: unknown) => e);
  controle.abort(new Error("cancelado"));
  const erro = await pedido;
  assert.ok(!(erro instanceof ErroDeRede));
  assert.equal(chamadas.length, 1);
});

test("erro que não é de rede sobe sem tradução nem nova tentativa", async () => {
  const { chamadas, base } = baseDeMentira([new TypeError("Invalid URL")]);
  const cliente = criarClienteHttp({ base, esperar: async () => {} });

  const erro = await cliente("nada").catch((e: unknown) => e);
  assert.ok(erro instanceof TypeError);
  assert.equal(chamadas.length, 1);
});

test("nenhum código do processo principal chama fetch cru: tudo passa pelo cliente", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const raiz = join(import.meta.dirname, "..");
  const achados: string[] = [];
  for (const pasta of ["src", "electron"]) {
    for (const arquivo of await readdir(join(raiz, pasta), { recursive: true })) {
      if (!arquivo.endsWith(".ts") || arquivo === join("net", "http.ts")) continue;
      const texto = await readFile(join(raiz, pasta, arquivo), "utf8");
      // `await fetch(` e `?? fetch` são os dois jeitos de cair no global sem querer.
      texto.split("\n").forEach((linha, i) => {
        if (/(await fetch\(|\?\? fetch\b|fetchFn: fetch\b|= fetch,)/.test(linha)) achados.push(`${pasta}/${arquivo}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(achados, []);
});
