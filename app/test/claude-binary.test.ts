import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeBinary, forgetClaudeBinary, resolveClaudeBinary, type ClaudeBinaryDeps } from "../src/runtimes/claude-binary.js";

const HOME = "/Users/teste";

function deps(opcoes: {
  env?: NodeJS.ProcessEnv;
  zsh?: string | Error;
  executaveis?: string[];
  chamadas?: { command: string; args: string[] }[];
}): Partial<ClaudeBinaryDeps> {
  const executaveis = new Set(opcoes.executaveis ?? []);
  return {
    env: opcoes.env ?? {},
    home: HOME,
    shell: async (command, args) => {
      opcoes.chamadas?.push({ command, args });
      const zsh = opcoes.zsh ?? new Error("claude not found");
      if (zsh instanceof Error) throw zsh;
      return zsh;
    },
    executable: (path) => executaveis.has(path),
  };
}

test("LOCUM_CLAUDE_BIN vem antes de tudo", async () => {
  const chamadas: { command: string; args: string[] }[] = [];
  const achado = await resolveClaudeBinary(
    deps({
      env: { LOCUM_CLAUDE_BIN: "/opt/meu/claude" },
      zsh: "/usr/local/bin/claude\n",
      executaveis: ["/opt/meu/claude", "/usr/local/bin/claude"],
      chamadas,
    }),
  );
  assert.equal(achado, "/opt/meu/claude");
  assert.equal(chamadas.length, 0);
});

test("zsh e chamado com -ilc e a ultima linha nao vazia vale", async () => {
  const chamadas: { command: string; args: string[] }[] = [];
  const achado = await resolveClaudeBinary(
    deps({
      zsh: "bem-vindo ao shell\n/Users/teste/.volta/bin/claude\n\n",
      executaveis: ["/Users/teste/.volta/bin/claude", "/usr/local/bin/claude"],
      chamadas,
    }),
  );
  assert.equal(achado, "/Users/teste/.volta/bin/claude");
  assert.deepEqual(chamadas, [{ command: "/bin/zsh", args: ["-ilc", "command -v claude"] }]);
});

test("alias, nome de funcao e caminho relativo do zsh sao descartados", async () => {
  for (const saida of ["claude: aliased to npx claude", "claude", "bin/claude"]) {
    const achado = await resolveClaudeBinary(
      deps({ zsh: `${saida}\n`, executaveis: ["/opt/homebrew/bin/claude", "bin/claude"] }),
    );
    assert.equal(achado, "/opt/homebrew/bin/claude", `saida "${saida}"`);
  }
});

test("caminho absoluto sem permissao de execucao e descartado", async () => {
  const achado = await resolveClaudeBinary(
    deps({
      env: { LOCUM_CLAUDE_BIN: "/opt/sem-x/claude" },
      zsh: "/usr/bin/claude-sem-x\n",
      executaveis: ["/usr/local/bin/claude"],
    }),
  );
  assert.equal(achado, "/usr/local/bin/claude");
});

test("~/.local/bin/claude e achado quando so ele existe", async () => {
  const achado = await resolveClaudeBinary(deps({ executaveis: [`${HOME}/.local/bin/claude`] }));
  assert.equal(achado, `${HOME}/.local/bin/claude`);
});

test("lista fixa na ordem do instalador nativo primeiro", async () => {
  const achado = await resolveClaudeBinary(
    deps({
      executaveis: [`${HOME}/.claude/local/claude`, "/opt/homebrew/bin/claude", `${HOME}/.local/bin/claude`],
    }),
  );
  assert.equal(achado, `${HOME}/.local/bin/claude`);
});

test("nada achado devolve undefined", async () => {
  assert.equal(await resolveClaudeBinary(deps({})), undefined);
});

test("o caminho achado é lembrado, e some quando deixa de ser executável", async () => {
  forgetClaudeBinary();
  const chamadas: { command: string; args: string[] }[] = [];
  const executaveis = ["/usr/local/bin/claude"];
  const base = deps({ zsh: "/usr/local/bin/claude\n", executaveis, chamadas });
  const vivos = new Set(executaveis);
  const comVivos = { ...base, executable: (p: string) => vivos.has(p) };

  assert.equal(await claudeBinary(comVivos), "/usr/local/bin/claude");
  assert.equal(await claudeBinary(comVivos), "/usr/local/bin/claude");
  assert.equal(chamadas.length, 1, "o shell de login abre uma vez só");

  vivos.delete("/usr/local/bin/claude");
  assert.equal(await claudeBinary(comVivos), undefined);
  assert.equal(chamadas.length, 2, "binário que sumiu faz perguntar de novo");
});

test("não achar não fica lembrado, para quem instala com o Locum aberto", async () => {
  forgetClaudeBinary();
  const chamadas: { command: string; args: string[] }[] = [];
  assert.equal(await claudeBinary(deps({ chamadas })), undefined);
  assert.equal(await claudeBinary(deps({ chamadas, zsh: "/opt/homebrew/bin/claude", executaveis: ["/opt/homebrew/bin/claude"] })), "/opt/homebrew/bin/claude");
  assert.equal(chamadas.length, 2);
  forgetClaudeBinary();
});
