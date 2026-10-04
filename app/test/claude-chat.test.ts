import assert from "node:assert/strict";
import { test } from "node:test";
import { argsDoChat, conversarPeloClaude, lerLinha, type EventoDoChat, type PedidoDoChat } from "../src/chat/claude-chat.js";

const base: PedidoDoChat = {
  texto: "como está?",
  modelo: "sonnet",
  cwd: "/repo",
  pastas: ["/iniciativa"],
  system: "sistema",
  permitidas: ["mcp__locum-chat"],
  conta: false,
};

function valor(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test("chat sem conta: isolado, só leitura de arquivo e sem retomar", () => {
  const args = argsDoChat(base);
  assert.equal(valor(args, "--setting-sources"), "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(valor(args, "--tools"), "Read,Grep,Glob");
  assert.equal(valor(args, "--permission-mode"), "dontAsk");
  assert.equal(valor(args, "--allowedTools"), "Read,Grep,Glob,mcp__locum-chat");
  assert.equal(valor(args, "--add-dir"), "/iniciativa");
  assert.ok(args.includes("--include-partial-messages"));
  assert.ok(!args.includes("--resume"));
  assert.ok(!args.includes("--no-session-persistence"));
});

test("chat com conta e sessão: retoma, junta as regras de negar aos ajustes isolados", () => {
  const args = argsDoChat({ ...base, conta: true, sessao: "abc", negar: ["Edit(/iniciativa/**)"] });
  assert.equal(valor(args, "--resume"), "abc");
  assert.equal(valor(args, "--setting-sources"), "user");
  assert.equal(valor(args, "--tools"), "ToolSearch,Read,Grep,Glob");
  const ajustes = JSON.parse(valor(args, "--settings")!) as { disableAllHooks: boolean; permissions: { deny: string[] } };
  assert.equal(ajustes.disableAllHooks, true);
  assert.deepEqual(ajustes.permissions.deny, ["Edit(/iniciativa/**)"]);
});

test("linhas do fluxo viram texto, ferramenta, fim e id da conversa", () => {
  assert.deepEqual(lerLinha(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" })), { sessao: "s1" });
  assert.deepEqual(lerLinha(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Oi" } } })), {
    evento: { tipo: "texto", delta: "Oi" },
  });
  assert.deepEqual(lerLinha(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta" } } })), {});
  assert.deepEqual(
    lerLinha(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__x__get", input: { a: 1 } }] } })),
    { evento: { tipo: "ferramenta", nome: "mcp__x__get", entrada: { a: 1 } } },
  );
  assert.deepEqual(lerLinha(JSON.stringify({ type: "result", subtype: "success", session_id: "s1" })), { sessao: "s1", evento: { tipo: "fim", motivo: "success" } });
  assert.equal(lerLinha(JSON.stringify({ type: "result", is_error: true, result: "limite" })).evento?.tipo, "erro");
  assert.deepEqual(lerLinha("não é json"), {});
});

test("conversa devolve o id e avisa quando o processo sai sem responder", async () => {
  const eventos: EventoDoChat[] = [];
  const abrir = (linhas: string[], codigo: number) => () => ({
    linhas: (async function* () {
      yield* linhas;
    })(),
    encerrar: () => undefined,
    saida: Promise.resolve(codigo),
  });

  const ok = await conversarPeloClaude(
    "/bin/claude",
    base,
    (e) => eventos.push(e),
    undefined,
    abrir(
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "nova" }),
        JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Tudo certo" } } }),
        JSON.stringify({ type: "result", subtype: "success", session_id: "nova" }),
      ],
      0,
    ),
  );
  assert.equal(ok.sessao, "nova");
  assert.deepEqual(eventos.map((e) => e.tipo), ["texto", "fim"]);

  eventos.length = 0;
  const texto = (t: string) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } });
  await conversarPeloClaude(
    "/bin/claude",
    base,
    (e) => eventos.push(e),
    undefined,
    abrir([texto("Vou buscar."), JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "x" }] } }), texto("Achei.")], 0),
  );
  assert.deepEqual(
    eventos.filter((e) => e.tipo === "texto").map((e) => (e as { delta: string }).delta),
    ["Vou buscar.", "\n\n", "Achei."],
  );

  eventos.length = 0;
  const caiu = await conversarPeloClaude("/bin/claude", { ...base, sessao: "velha" }, (e) => eventos.push(e), undefined, abrir([], 1));
  assert.equal(caiu.sessao, "velha");
  assert.equal(eventos[0]?.tipo, "erro");
});
