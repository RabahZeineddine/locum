import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeRuntime, LeitorDoStream } from "../src/runtimes/claude-code.js";
import type { Atividade } from "../src/runtimes/types.js";

test("o runtime chama o claude pelo caminho absoluto achado, e não pelo nome", async () => {
  // Um `claude` fora do PATH, como o de `~/.claude/local`, que só existe como
  // alias do `.zshrc`. Pelo nome, o processo não acharia.
  const pasta = mkdtempSync(join(tmpdir(), "locum-claude-"));
  const falso = join(pasta, "claude");
  writeFileSync(
    falso,
    `#!/bin/sh\necho '{"type":"result","result":"oi","usage":{"input_tokens":3,"output_tokens":2}}'\n`,
  );
  chmodSync(falso, 0o755);

  const runtime = new ClaudeCodeRuntime(new Map(), async () => falso);
  const resposta = await runtime.run({ prompt: "olá", model: "sonnet", tools: {} } as never);
  assert.equal(resposta.text, "oi");
  assert.equal(resposta.promptTokens, 3);
  assert.equal(resposta.billable, false);
});

test("o stream vira atividade: chamada, resultado com o tempo, e texto do modelo", () => {
  const vistas: Atividade[] = [];
  let agora = 1_000;
  const leitor = new LeitorDoStream((a) => vistas.push(a), () => agora);
  const linha = (o: unknown) => leitor.linha(JSON.stringify(o));

  linha({ type: "system", subtype: "init" });
  linha({ type: "assistant", message: { content: [{ type: "text", text: "Vou ler a planilha." }] } });
  linha({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "mcp__ms365__get-excel-range", input: { address: "A1:B2" } }] },
  });
  agora = 1_850;
  linha({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "[[1,2]]" }] }] } });
  linha({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "StructuredOutput", input: {} }] } });
  leitor.linha("isto não é json");
  linha({ type: "result", result: "ok", structured_output: { r: 1 } });

  assert.deepEqual(
    vistas.map((a) => [a.tipo, a.ferramenta ?? null, a.detalhe, a.ms ?? null]),
    [
      ["texto", null, "Vou ler a planilha.", null],
      ["ferramenta", "ms365 · get-excel-range", '{"address":"A1:B2"}', null],
      ["resultado", null, "[[1,2]]", 850],
    ],
  );
  assert.deepEqual([...leitor.ferramentas], ["mcp__ms365__get-excel-range"]);
  assert.deepEqual(leitor.final?.structured_output, { r: 1 });
});

test("sem a linha de resultado, o passo falha com o que saiu no stderr", async () => {
  const pasta = mkdtempSync(join(tmpdir(), "locum-claude-"));
  const falso = join(pasta, "claude");
  writeFileSync(falso, `#!/bin/sh\necho 'quebrou feio' >&2\nexit 3\n`);
  chmodSync(falso, 0o755);
  const runtime = new ClaudeCodeRuntime(new Map(), async () => falso);
  await assert.rejects(runtime.run({ prompt: "olá", model: "sonnet", tools: {} } as never), /saiu com 3: quebrou feio/);
});
