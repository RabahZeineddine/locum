import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  buildTracker,
  ShortcutAdapter,
  TRACKER_DEFAULT_BASE_URL,
  TRACKER_KINDS,
} from "../src/trackers/registry.js";

let server: Server;
let baseUrl: string;

interface ChamadaRecebida {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

const chamadas: ChamadaRecebida[] = [];

before(async () => {
  server = createServer(async (req, res) => {
    const buffers: Buffer[] = [];
    for await (const chunk of req) {
      buffers.push(Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(buffers).toString("utf-8");
    let parsedBody: unknown = undefined;
    if (rawBody.length > 0) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = rawBody;
      }
    }

    chamadas.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers,
      body: parsedBody,
    });

    const url = new URL(req.url ?? "/", baseUrl);
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };

    if (url.pathname === "/groups") {
      return json(200, [
        { id: "grp-1", name: "Backend Team" },
        { id: "grp-2", name: "Frontend Team" },
      ]);
    }

    if (url.pathname === "/projects") {
      return json(200, [
        { id: 101, name: "Core Project" },
        { id: 102, name: "Web Project" },
      ]);
    }

    if (url.pathname === "/search/stories") {
      const query = url.searchParams.get("query") ?? "";
      if (query.includes("pull/42")) {
        return json(200, {
          data: [
            {
              id: 4200,
              app_url: "https://app.shortcut.com/workspace/story/4200",
              name: "Existing PR Story",
            },
          ],
        });
      }
      return json(200, { data: [] });
    }

    if (url.pathname === "/stories" && req.method === "POST") {
      const body = parsedBody as Record<string, unknown>;
      return json(201, {
        id: 9999,
        app_url: "https://app.shortcut.com/workspace/story/9999",
        name: body.name,
      });
    }

    res.writeHead(404).end("Not found");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

after(() => {
  server.close();
});

test("TRACKER_KINDS inclui shortcut e default base url está configurada", () => {
  assert.ok((TRACKER_KINDS as readonly string[]).includes("shortcut"));
  assert.equal(
    TRACKER_DEFAULT_BASE_URL.shortcut,
    "https://api.app.shortcut.com/api/v3",
  );
});

test("buildTracker monta ShortcutAdapter para kind shortcut", () => {
  const adapter = buildTracker({
    kind: "shortcut",
    baseUrl: "https://api.app.shortcut.com/api/v3",
    secret: "sc-token-123",
  });
  assert.ok(adapter instanceof ShortcutAdapter);
  assert.equal(adapter.kind, "shortcut");
});

test("ShortcutAdapter: listProjects busca grupos e retorna id/name", async () => {
  chamadas.length = 0;
  const adapter = new ShortcutAdapter({
    kind: "shortcut",
    baseUrl,
    secret: "sc-token-secret",
  });

  const projects = await adapter.listProjects();
  assert.deepEqual(projects, [
    { key: "grp-1", name: "Backend Team" },
    { key: "grp-2", name: "Frontend Team" },
  ]);

  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0]?.url, "/groups");
  assert.equal(chamadas[0]?.headers["shortcut-token"], "sc-token-secret");
});

test("ShortcutAdapter: findByPullRequest acha história existente e devolve null se não achar", async () => {
  chamadas.length = 0;
  const adapter = new ShortcutAdapter({
    kind: "shortcut",
    baseUrl,
    secret: "sc-token-secret",
  });

  const achada = await adapter.findByPullRequest(
    "grp-1",
    "https://github.com/dono/repo/pull/42",
  );
  assert.deepEqual(achada, {
    key: "4200",
    url: "https://app.shortcut.com/workspace/story/4200",
    title: "Existing PR Story",
  });

  const naoAchada = await adapter.findByPullRequest(
    "grp-1",
    "https://github.com/dono/repo/pull/99",
  );
  assert.equal(naoAchada, null);
});

test("ShortcutAdapter: createIssue faz POST em /stories com formato esperado", async () => {
  chamadas.length = 0;
  const adapter = new ShortcutAdapter({
    kind: "shortcut",
    baseUrl,
    secret: "sc-token-secret",
  });

  const criada = await adapter.createIssue({
    project: "grp-1",
    title: "Implementar suporte ao Shortcut",
    body: "Objetivo do card",
    pullRequestUrl: "https://github.com/dono/repo/pull/50",
  });

  assert.deepEqual(criada, {
    key: "9999",
    url: "https://app.shortcut.com/workspace/story/9999",
    title: "Implementar suporte ao Shortcut",
  });

  const postStory = chamadas.find(
    (c) => c.url === "/stories" && c.method === "POST",
  );
  assert.ok(postStory);
  assert.equal(postStory.headers["shortcut-token"], "sc-token-secret");
  assert.deepEqual(postStory.body, {
    name: "Implementar suporte ao Shortcut",
    description:
      "Objetivo do card\n\nhttps://github.com/dono/repo/pull/50",
    group_id: "grp-1",
  });
});

test("ShortcutAdapter: createIssue com project_id numérico", async () => {
  chamadas.length = 0;
  const adapter = new ShortcutAdapter({
    kind: "shortcut",
    baseUrl,
    secret: "sc-token-secret",
  });

  await adapter.createIssue({
    project: "101",
    title: "Card em projeto numérico",
    body: "Corpo",
    pullRequestUrl: "https://github.com/dono/repo/pull/51",
  });

  const postStory = chamadas.find(
    (c) => c.url === "/stories" && c.method === "POST",
  );
  assert.ok(postStory);
  assert.deepEqual(postStory.body, {
    name: "Card em projeto numérico",
    description: "Corpo\n\nhttps://github.com/dono/repo/pull/51",
    project_id: 101,
    group_id: "101",
  });
});
