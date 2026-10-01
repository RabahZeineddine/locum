import { test } from "node:test";
import assert from "node:assert/strict";
import { schema } from "../src/db/index.js";
import { carimbo, pollTeamsInbox, semHtml } from "../src/sources/teams-inbox.js";
import { bancoDeTeste } from "./helpers/db.js";

type Mensagem = {
  id: string;
  createdDateTime: string;
  lastModifiedDateTime?: string;
  messageType?: string;
  deletedDateTime?: string | null;
  from?: { user: { id: string; displayName?: string } | null } | null;
  body?: { contentType: string; content: string };
  mentions?: { mentioned: { user?: { id: string } } }[];
  webUrl?: string;
};

type Conversa = { id: string; chatType: string; mensagens: Mensagem[] };

/**
 * Um Graph de mentira.
 *
 * Responde `/me` com a pessoa `EU`, a lista de conversas da mais recente para
 * a mais antiga, e as mensagens de cada uma com o filtro de última alteração
 * aplicado. Cada pedido fica anotado, para o teste conferir token e filtro.
 */
function graphFalso(conversas: Conversa[], opcoes: { recusa?: number } = {}) {
  const pedidos: { url: URL; auth: string | null; metodo: string; corpo: unknown }[] = [];
  const fetchFn = (async (entrada: string | URL, init?: RequestInit) => {
    const url = new URL(String(entrada));
    pedidos.push({
      url,
      auth: new Headers(init?.headers).get("authorization"),
      metodo: init?.method ?? "GET",
      corpo: init?.body === undefined ? null : JSON.parse(String(init.body)),
    });
    const json = (valor: unknown, status = 200) => new Response(JSON.stringify(valor), { status });
    const caminho = url.pathname.replace(/^\/v1\.0/, "");

    if (caminho === "/me") return json({ id: "EU" });
    if (opcoes.recusa !== undefined) return json({ error: { code: "Forbidden" } }, opcoes.recusa);

    if (caminho === "/me/chats") {
      const ultima = (c: Conversa) => c.mensagens.map((m) => m.createdDateTime).sort().at(-1) ?? null;
      const ordenadas = [...conversas].sort((a, b) => (ultima(b) ?? "").localeCompare(ultima(a) ?? ""));
      return json({
        value: ordenadas.map((c) => ({
          id: c.id,
          chatType: c.chatType,
          lastMessagePreview: ultima(c) === null ? null : { createdDateTime: ultima(c) },
        })),
      });
    }

    const m = /^\/chats\/([^/]+)\/messages$/.exec(caminho);
    if (m !== null) {
      const conversa = conversas.find((c) => c.id === decodeURIComponent(m[1]!));
      if (init?.method === "POST") return json({ id: "nova" }, 201);
      const desde = (url.searchParams.get("$filter") ?? "").replace("lastModifiedDateTime gt ", "");
      const lista = (conversa?.mensagens ?? [])
        .map((msg) => ({
          messageType: "message",
          deletedDateTime: null,
          lastModifiedDateTime: msg.createdDateTime,
          body: { contentType: "text", content: "" },
          from: { user: { id: "OUTRA", displayName: "Outra Pessoa" } },
          mentions: [],
          ...msg,
          chatId: conversa!.id,
        }))
        .filter((msg) => new Date(msg.lastModifiedDateTime) > new Date(desde));
      return json({ value: lista });
    }
    return json({}, 404);
  }) as typeof fetch;
  return { fetchFn, pedidos };
}

const token = async () => "token-graph";

function agoraMenos(minutos: number): string {
  return new Date(Date.now() - minutos * 60_000).toISOString();
}

test("mensagem direta vira evento normalizado, com o texto sem HTML", async () => {
  const db = bancoDeTeste();
  const { fetchFn, pedidos } = graphFalso([
    {
      id: "19:um@unq.gbl.spaces",
      chatType: "oneOnOne",
      mensagens: [
        {
          id: "1001",
          createdDateTime: agoraMenos(10),
          body: { contentType: "html", content: "<p>pode olhar o PR?</p><p>valeu &amp; abraço</p>" },
          webUrl: "https://teams.microsoft.com/l/message/1001",
        },
      ],
    },
  ]);

  const resultado = await pollTeamsInbox({ mentions: true, dms: true }, { db, token, fetchFn });

  assert.deepEqual(resultado.errors, []);
  assert.equal(resultado.eventIds.length, 1);
  assert.equal(pedidos[0]!.auth, "Bearer token-graph");
  const conversas = pedidos.find((p) => p.url.pathname.endsWith("/me/chats"))!;
  assert.equal(conversas.url.searchParams.get("$expand"), "lastMessagePreview");

  const [evento] = await db.select().from(schema.events);
  const corpo = evento!.payload as Record<string, unknown>;
  assert.equal(evento!.source, "teams");
  assert.equal(evento!.externalId, "teams:19:um@unq.gbl.spaces:1001");
  assert.equal(corpo.repo, "teams/19:um@unq.gbl.spaces");
  assert.equal(corpo.kind, "dm");
  assert.equal(corpo.chatType, "oneOnOne");
  assert.equal(corpo.author, "Outra Pessoa");
  assert.equal(corpo.text, "pode olhar o PR?\nvaleu & abraço");
  assert.equal(corpo.webUrl, "https://teams.microsoft.com/l/message/1001");
});

test("menção em chat de reunião conta, conversa de reunião sem menção não", async () => {
  const db = bancoDeTeste();
  const { fetchFn } = graphFalso([
    {
      id: "reuniao",
      chatType: "meeting",
      mensagens: [
        { id: "1", createdDateTime: agoraMenos(9), body: { contentType: "text", content: "bom dia" } },
        {
          id: "2",
          createdDateTime: agoraMenos(8),
          body: { contentType: "text", content: "@Eu pode ver?" },
          mentions: [{ mentioned: { user: { id: "EU" } } }],
        },
      ],
    },
  ]);

  const resultado = await pollTeamsInbox({ mentions: true, dms: true }, { db, token, fetchFn });

  assert.equal(resultado.eventIds.length, 1);
  const [evento] = await db.select().from(schema.events);
  assert.equal((evento!.payload as { kind: string }).kind, "mention");
});

test("só menções deixa a mensagem direta sem menção de fora", async () => {
  const db = bancoDeTeste();
  const { fetchFn } = graphFalso([
    { id: "dm", chatType: "oneOnOne", mensagens: [{ id: "1", createdDateTime: agoraMenos(5) }] },
  ]);
  const resultado = await pollTeamsInbox({ mentions: true, dms: false }, { db, token, fetchFn });
  assert.equal(resultado.eventIds.length, 0);
});

test("o que a pessoa escreveu, aviso do sistema, apagada e mensagem de app ficam de fora", async () => {
  const db = bancoDeTeste();
  const { fetchFn } = graphFalso([
    {
      id: "grupo",
      chatType: "group",
      mensagens: [
        { id: "1", createdDateTime: agoraMenos(6), from: { user: { id: "EU" } } },
        { id: "2", createdDateTime: agoraMenos(5), messageType: "systemEventMessage", from: null },
        { id: "3", createdDateTime: agoraMenos(4), deletedDateTime: agoraMenos(1) },
        { id: "4", createdDateTime: agoraMenos(3), from: { user: null } },
        { id: "5", createdDateTime: agoraMenos(2), body: { contentType: "text", content: "dela" } },
      ],
    },
  ]);

  const resultado = await pollTeamsInbox({ mentions: true, dms: true }, { db, token, fetchFn });

  assert.equal(resultado.eventIds.length, 1);
  const [evento] = await db.select().from(schema.events);
  assert.equal((evento!.payload as { text: string }).text, "dela");
});

test("a batida seguinte filtra pelo cursor e não repete o que já viu", async () => {
  const db = bancoDeTeste();
  const criada = agoraMenos(3);
  const { fetchFn, pedidos } = graphFalso([
    { id: "dm", chatType: "oneOnOne", mensagens: [{ id: "1", createdDateTime: criada }] },
  ]);

  await pollTeamsInbox({ mentions: true, dms: true }, { db, token, fetchFn });
  const segunda = await pollTeamsInbox({ mentions: true, dms: true }, { db, token, fetchFn });

  assert.equal(segunda.eventIds.length, 0);
  const [cursor] = await db.select().from(schema.cursors);
  // Batida sem nada novo avança o cursor para a hora da batida.
  assert.ok(cursor!.value > criada);
  // A conversa não se mexeu desde o cursor, então nem as mensagens dela são pedidas de novo.
  const mensagens = pedidos.filter((p) => p.url.pathname.endsWith("/messages"));
  assert.equal(mensagens.length, 1);
});

test("mensagem antiga editada volta pelo filtro do Graph e fica de fora", async () => {
  const db = bancoDeTeste();
  const { fetchFn } = graphFalso([
    {
      id: "dm",
      chatType: "oneOnOne",
      mensagens: [
        { id: "velha", createdDateTime: agoraMenos(60 * 48), lastModifiedDateTime: agoraMenos(2) },
        { id: "nova", createdDateTime: agoraMenos(1) },
      ],
    },
  ]);

  const resultado = await pollTeamsInbox({ mentions: true, dms: true }, { db, token, fetchFn });

  assert.equal(resultado.eventIds.length, 1);
  const [evento] = await db.select().from(schema.events);
  assert.equal(evento!.externalId, "teams:dm:nova");
});

test("recusa do Graph vira erro da batida, sem mover o cursor", async () => {
  const db = bancoDeTeste();
  const { fetchFn } = graphFalso([], { recusa: 403 });

  const resultado = await pollTeamsInbox({ mentions: true, dms: true }, { db, token, fetchFn });

  assert.deepEqual(resultado.errors, [{ kind: "inbox", error: "Graph respondeu 403: Forbidden" }]);
  assert.equal((await db.select().from(schema.cursors)).length, 0);
});

test("sem conexão, a varredura recusa antes de chamar o Graph", async () => {
  const { fetchFn, pedidos } = graphFalso([]);
  await assert.rejects(
    pollTeamsInbox({ mentions: true, dms: true }, { db: bancoDeTeste(), token: async () => null, fetchFn }),
    /não está conectado/,
  );
  assert.equal(pedidos.length, 0);
});

test("carimbo normaliza a fração, para a comparação de texto ordenar certo", () => {
  assert.equal(carimbo("2026-10-01T10:00:00Z"), "2026-10-01T10:00:00.000Z");
  assert.equal(carimbo("2026-10-01T10:00:00.5Z"), "2026-10-01T10:00:00.500Z");
  assert.ok(carimbo("2026-10-01T10:00:00Z")! < carimbo("2026-10-01T10:00:00.5Z")!);
  assert.equal(carimbo("não é data"), null);
});

test("HTML do Teams vira texto", () => {
  assert.equal(semHtml("<div>oi<br>tudo&nbsp;bem?</div>"), "oi\ntudo bem?");
});
