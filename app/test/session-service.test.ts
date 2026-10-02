import { before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { LANGUAGE_KEY } from "../src/services/i18n-service.js";
import { InitiativeService } from "../src/services/initiative-service.js";
import { SessionService, type Exec } from "../src/services/session-service.js";
import { settingsService } from "../src/services/settings-service.js";
import { translate } from "../src/services/text-service.js";
import en from "../locales/en.json" with { type: "json" };
import ptBR from "../locales/pt-BR.json" with { type: "json" };

before(() => {
  migrateDb();
});

const initiatives = new InitiativeService();

interface Chamada {
  command: string;
  args: string[];
}

/** Servico com espiao no lugar do terminal: nenhum teste abre janela. */
function servico(opcoes: { claude?: string | undefined } = {}): { service: SessionService; chamadas: Chamada[] } {
  const chamadas: Chamada[] = [];
  const exec: Exec = async (command, args) => {
    chamadas.push({ command, args });
  };
  const claude = "claude" in opcoes ? opcoes.claude : "/bin/echo";
  return { service: new SessionService({ exec, resolveClaude: async () => claude }), chamadas };
}

async function iniciativa(input: { title?: string; worktree?: string } = {}): Promise<string> {
  const slug = `sessao-${randomUUID()}`;
  await initiatives.upsert({
    slug,
    title: input.title ?? "Frente de teste",
    objective: "Objetivo da frente",
    doneCriteria: "Criterio de pronto",
  });
  if (input.worktree) await initiatives.setWorkspaces(slug, [{ repoPath: input.worktree, branch: "feat/x" }]);
  await initiatives.addLink(slug, { kind: "doc", url: "https://exemplo.test/doc", label: "Doc" });
  return slug;
}

function pastaVazia(prefixo: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefixo)));
}

function pastaDe(slug: string): string {
  return realpathSync(join(process.env.LOCUM_INITIATIVES_DIR!, slug));
}

/** Cada linha de cada `session.prompt.*`, com `{{var}}` virando curinga. */
function linhasDoDicionario(dicionario: { session: { prompt: Record<string, string> } }): RegExp[] {
  return Object.values(dicionario.session.prompt)
    .flatMap((valor) => valor.split("\n"))
    .filter((linha) => linha.length > 0)
    .map((linha) => {
      const partes = linha.split(/\{\{\s*[\w.]+\s*\}\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      return new RegExp(`^${partes.join(".+")}$`);
    });
}

function conferirIdioma(conteudo: string, daqui: RegExp[], dali: RegExp[]): void {
  const soDali = dali.filter((outra) => !daqui.some((minha) => minha.source === outra.source));
  for (const linha of conteudo.split("\n").filter((l) => l.length > 0)) {
    assert.ok(
      daqui.some((regra) => regra.test(linha)),
      `linha fora do dicionario: "${linha}"`,
    );
    assert.ok(!soDali.some((regra) => regra.test(linha)), `linha do outro idioma: "${linha}"`);
  }
}

test("session.md em ingles sem preferencia, so com linhas do dicionario", async () => {
  await settingsService.remove(LANGUAGE_KEY);
  const worktree = pastaVazia("locum-wt-");
  const slug = await iniciativa({ worktree });
  const { service } = servico();

  await service.open(slug);

  const conteudo = readFileSync(join(pastaDe(slug), ".locum", "session.md"), "utf8");
  conferirIdioma(conteudo, linhasDoDicionario(en), linhasDoDicionario(ptBR));
  assert.ok(conteudo.includes(translate("en", "session.prompt.objective", { objective: "Objetivo da frente" })));
  assert.ok(conteudo.includes(join(pastaDe(slug), "context.md")));
});

test("session.md em pt-BR quando a preferencia esta gravada", async () => {
  await settingsService.set(LANGUAGE_KEY, "pt-BR");
  try {
    const worktree = pastaVazia("locum-wt-");
    const slug = await iniciativa({ worktree });
    const { service } = servico();

    await service.open(slug);

    const conteudo = readFileSync(join(pastaDe(slug), ".locum", "session.md"), "utf8");
    conferirIdioma(conteudo, linhasDoDicionario(ptBR), linhasDoDicionario(en));
    assert.ok(conteudo.includes(translate("pt-BR", "session.prompt.doneCriteria", { doneCriteria: "Criterio de pronto" })));
  } finally {
    await settingsService.remove(LANGUAGE_KEY);
  }
});

test("deny barra context.md e .locum com caminho absoluto no formato //", async () => {
  const slug = await iniciativa();
  const { service } = servico();

  await service.open(slug);

  const pasta = pastaDe(slug);
  const settings = JSON.parse(readFileSync(join(pasta, ".locum", "session-settings.json"), "utf8"));
  assert.deepEqual(settings, {
    permissions: {
      deny: [
        `Edit(/${pasta}/context.md)`,
        `Edit(/${pasta}/.locum/**)`,
      ],
    },
  });
  for (const regra of settings.permissions.deny as string[]) assert.match(regra, /^Edit\(\/\/[^/]/);
});

test("script entra no worktree e nada nasce fora da pasta de contexto", async () => {
  const worktree = pastaVazia("locum-wt-");
  const slug = await iniciativa({ worktree });
  const { service, chamadas } = servico();

  const aberta = await service.open(slug);

  assert.equal(aberta.cwd, worktree);
  assert.equal(aberta.claudeFound, true);
  const script = readFileSync(aberta.scriptPath, "utf8");
  assert.equal(script.split("\n")[1], `cd '${worktree}' || exit 1`);
  assert.deepEqual(readdirSync(worktree), []);
  assert.deepEqual(readdirSync(join(pastaDe(slug), ".locum")).sort(), [
    "open-session.command",
    "session-settings.json",
    "session.md",
  ]);
  assert.ok(existsSync(join(pastaDe(slug), "handoffs")));
  assert.deepEqual(chamadas.map((c) => c.args[0]), ["-Ra", "-a"]);
});

test("sem worktree a sessao comeca na pasta de contexto, e sem claude achado usa o do PATH", async () => {
  const slug = await iniciativa();
  const { service } = servico({ claude: undefined });

  const aberta = await service.open(slug);

  assert.equal(aberta.cwd, pastaDe(slug));
  assert.equal(aberta.claudeFound, false);
  assert.match(readFileSync(aberta.scriptPath, "utf8").split("\n")[2]!, /^'claude' --add-dir /);
});

test("cada terminal abre com o open -a certo, e o padrao vem de settings", async () => {
  const slug = await iniciativa();

  const iterm = servico();
  const abertaIterm = await iterm.service.open(slug, { terminal: "iterm" });
  assert.deepEqual(iterm.chamadas, [
    { command: "open", args: ["-Ra", "iTerm"] },
    { command: "open", args: ["-a", "iTerm", abertaIterm.scriptPath] },
  ]);

  const warp = servico();
  const abertaWarp = await warp.service.open(slug, { terminal: "warp" });
  assert.deepEqual(warp.chamadas.at(-1), { command: "open", args: ["-a", "Warp", abertaWarp.scriptPath] });

  const padrao = servico();
  await padrao.service.setTerminal("terminal");
  const abertaPadrao = await padrao.service.open(slug);
  assert.equal(abertaPadrao.terminal, "terminal");
  assert.deepEqual(padrao.chamadas.at(-1), { command: "open", args: ["-a", "Terminal", abertaPadrao.scriptPath] });

  await assert.rejects(padrao.service.setTerminal("xterm" as never));
});

test("terminal que nao esta instalado recusa com aviso e nao deixa sessao aberta", async () => {
  const slug = await iniciativa();
  const abertos: string[][] = [];
  const exec: Exec = async (_command, args) => {
    if (args[0] === "-Ra" && args[1] === "iTerm") throw new Error("Unable to find application named 'iTerm'");
    abertos.push(args);
  };
  const service = new SessionService({ exec, resolveClaude: async () => "/bin/echo" });
  const antes = (await db.select().from(schema.sessions)).length;

  await assert.rejects(service.open(slug, { terminal: "iterm" }), /iTerm nao esta instalado/);

  assert.equal((await db.select().from(schema.sessions)).length, antes);
  assert.ok(abertos.every((args) => args[0] === "-Ra"));
  assert.deepEqual(await service.installedTerminals(), ["terminal", "warp"]);
});

const HOSTIS = [`x"; touch PWNED; "`, "$(touch PWNED)", "`touch PWNED`", "it's"];

test("nome de pasta hostil nao executa nada no cd do script", async () => {
  for (const nome of HOSTIS) {
    const raiz = pastaVazia("locum-hostil-");
    const worktree = join(raiz, nome);
    mkdirSync(worktree);
    const slug = await iniciativa({ worktree });
    const { service } = servico();

    const aberta = await service.open(slug);
    execFileSync("/bin/sh", ["-n", aberta.scriptPath]);

    const linhaDoCd = readFileSync(aberta.scriptPath, "utf8").split("\n")[1]!;
    const vazia = pastaVazia("locum-vazia-");
    const onde = execFileSync("/bin/sh", ["-c", `${linhaDoCd}\npwd -P`], { cwd: vazia, encoding: "utf8" }).trim();

    assert.equal(onde, realpathSync(worktree), `pasta "${nome}"`);
    for (const pasta of [vazia, worktree, raiz]) {
      assert.ok(!existsSync(join(pasta, "PWNED")), `PWNED em ${pasta} com a pasta "${nome}"`);
    }
  }
});

test("titulo hostil fica so no session.md e chega ao claude como texto", async () => {
  const worktree = pastaVazia("locum-wt-");
  const slug = await iniciativa({ worktree, title: "$(touch PWNED) `touch PWNED` it's \"x\"" });
  const { service } = servico({ claude: "/bin/echo" });

  const aberta = await service.open(slug);
  const script = readFileSync(aberta.scriptPath, "utf8");
  assert.ok(!script.includes("PWNED"));

  // Ate a linha do claude, nunca a do `open`: o deep link nao pode sair do teste.
  const ateOClaude = script.split("\n").slice(0, 3).join("\n");
  assert.ok(!ateOClaude.includes("open "));
  const saida = execFileSync("/bin/sh", ["-c", ateOClaude], { encoding: "utf8" });

  assert.ok(saida.includes("$(touch PWNED) `touch PWNED` it's \"x\""));
  assert.ok(!existsSync(join(worktree, "PWNED")));
  assert.ok(!existsSync(join(pastaDe(slug), "PWNED")));
});

test("nonce vale uma vez so, e nonce errado e recusado", async () => {
  const slug = await iniciativa();
  const { service } = servico();
  const aberta = await service.open(slug);
  const [linha] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, aberta.sessionId));

  assert.equal(await service.finish(aberta.sessionId, "errado-errado-errado"), false);
  assert.equal(await service.finish(randomUUID(), linha!.nonce), false);
  assert.equal(await service.finish(aberta.sessionId, linha!.nonce), true);
  assert.equal(await service.finish(aberta.sessionId, linha!.nonce), false);

  const [fechada] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, aberta.sessionId));
  assert.equal(fechada!.status, "ended");
  assert.ok(fechada!.endedAt !== null);
});

test("ler passagem vira proposta append e marca a sessao como lida", async () => {
  await settingsService.remove(LANGUAGE_KEY);
  const slug = await iniciativa();
  const { service } = servico();

  assert.equal(await service.readHandoff(slug), null);

  const aberta = await service.open(slug);
  assert.equal(await service.readHandoff(slug), null, "passagem ainda nao escrita");

  const [linha] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, aberta.sessionId));
  writeFileSync(join(pastaDe(slug), linha!.handoffPath!), "Feito: X.\nFalta: Y.\n");

  const lida = await service.readHandoff(slug);
  assert.ok(lida);
  assert.equal(lida.file, linha!.handoffPath);

  const [aprovacao] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, lida.approvalId));
  const payload = aprovacao!.payload as { mode: string; content: string; origin: string };
  assert.equal(aprovacao!.kind, "context.update");
  assert.equal(payload.mode, "append");
  assert.equal(payload.origin, "session.handoff");
  assert.equal(
    payload.content,
    translate("en", "session.handoff.block", { file: linha!.handoffPath, content: "Feito: X.\nFalta: Y." }),
  );

  const [depois] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, aberta.sessionId));
  assert.equal(depois!.status, "read");
  assert.equal(await service.readHandoff(slug), null, "passagem lida nao volta");
});

test("aba de sessoes lista as da iniciativa, encerra a largada e le a passagem de uma so", async () => {
  const slug = await iniciativa();
  const { service } = servico();

  const velha = await service.open(slug);
  const nova = await service.open(slug);
  assert.match(readFileSync(nova.scriptPath, "utf8"), new RegExp(`--session-id '${nova.sessionId}'`));

  const [linhaVelha] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, velha.sessionId));
  writeFileSync(join(pastaDe(slug), linhaVelha!.handoffPath!), "Feito: velha.\n");

  const lista = await service.list(slug);
  assert.deepEqual(
    lista.map((s) => [s.id, s.status, s.hasHandoff]),
    [
      [nova.sessionId, "open", false],
      [velha.sessionId, "open", true],
    ],
  );

  assert.equal(await service.close(velha.sessionId), true);
  assert.equal(await service.close(velha.sessionId), false, "so fecha sessao aberta");

  assert.equal(await service.readHandoff(slug, nova.sessionId), null, "a nova ainda nao tem passagem");
  const lida = await service.readHandoff(slug, velha.sessionId);
  assert.equal(lida?.file, linhaVelha!.handoffPath);
  const depois = await service.list(slug);
  assert.deepEqual(
    depois.map((s) => s.status),
    ["open", "read"],
  );
});

test("editar workspaces depois de abrir sessao nao trava na chave estrangeira", async () => {
  const worktree = pastaVazia("locum-wt-");
  const slug = await iniciativa({ worktree });
  const { service } = servico();
  await service.open(slug);

  await initiatives.setWorkspaces(slug, [{ repoPath: pastaVazia("locum-wt-") }]);
});
