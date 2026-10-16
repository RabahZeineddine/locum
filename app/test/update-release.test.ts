import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANIFEST_NAME,
  baixarConferindo,
  bundleDoExecutavel,
  compararVersoes,
  extrairBundle,
  motivoParaNaoTrocar,
  procurarVersaoNova,
  scriptDeTroca,
} from "../src/update/release.js";

/**
 * A atualização inteira contra um GitHub de mentira servido daqui.
 *
 * O bundle é de verdade no que importa para a troca: pasta `.app` com
 * `Info.plist`, zipada pelo `ditto` como o `electron-builder` faz. O script de
 * troca roda no `sh`, esperando um processo filho de verdade morrer.
 */

function pastaTemporaria(): string {
  return mkdtempSync(join(tmpdir(), "locum-update-"));
}

function bundleDeMentira(pai: string, versao: string, marca: string): string {
  const app = join(pai, "Locum.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${versao}</string></dict></plist>`,
  );
  writeFileSync(join(app, "Contents", "MacOS", "marca"), marca);
  return app;
}

function zipar(bundle: string, destino: string): { sha512: string; size: number } {
  execFileSync("ditto", ["-c", "-k", "--keepParent", bundle, destino]);
  const bytes = readFileSync(destino);
  return { sha512: createHash("sha512").update(bytes).digest("base64"), size: bytes.length };
}

/** Sobe um "GitHub" com um release, um manifesto e um zip. */
async function githubDeMentira(opcoes: {
  tag: string;
  manifesto: object;
  zipNome: string;
  zip: Buffer;
  semRelease?: boolean;
}): Promise<{ api: string; fechar: () => Promise<void> }> {
  let base = "";
  const server: Server = createServer((req, res) => {
    if (req.url === "/repos/dono/repo/releases/latest") {
      if (opcoes.semRelease) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          tag_name: opcoes.tag,
          body: "o que mudou",
          published_at: "2026-09-22T00:00:00Z",
          assets: [
            { name: MANIFEST_NAME, browser_download_url: `${base}/asset/manifesto` },
            { name: opcoes.zipNome, browser_download_url: `${base}/asset/zip` },
          ],
        }),
      );
      return;
    }
    if (req.url === "/asset/manifesto") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(opcoes.manifesto));
      return;
    }
    if (req.url === "/asset/zip") {
      res.writeHead(200, { "content-type": "application/zip" }).end(opcoes.zip);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const endereco = server.address();
  if (endereco === null || typeof endereco === "string") throw new Error("sem porta");
  base = `http://127.0.0.1:${endereco.port}`;
  return { api: base, fechar: () => new Promise((r) => server.close(() => r())) };
}

test("versões se comparam número a número, não como texto", () => {
  assert.ok(compararVersoes("0.1.10", "0.1.9") > 0);
  assert.ok(compararVersoes("v0.2.0", "0.1.99") > 0);
  assert.equal(compararVersoes("v0.1.0", "0.1.0"), 0);
  assert.ok(compararVersoes("0.1.0", "0.1.1") < 0);
});

test("acha a versão nova, baixa conferindo o hash e extrai o bundle certo", async () => {
  const pasta = pastaTemporaria();
  try {
    const origem = join(pasta, "origem");
    mkdirSync(origem);
    const zipCaminho = join(pasta, "Locum-0.2.0-arm64-mac.zip");
    const { sha512, size } = zipar(bundleDeMentira(origem, "0.2.0", "nova"), zipCaminho);
    const gh = await githubDeMentira({
      tag: "v0.2.0",
      zipNome: "Locum-0.2.0-arm64-mac.zip",
      zip: readFileSync(zipCaminho),
      manifesto: {
        version: "0.2.0",
        publishedAt: "2026-09-22T00:00:00Z",
        files: [{ arch: "arm64", name: "Locum-0.2.0-arm64-mac.zip", sha512, size }],
      },
    });
    try {
      const nova = await procurarVersaoNova({ atual: "0.1.0", arch: "arm64", api: gh.api, repo: "dono/repo" });
      assert.ok(nova);
      assert.equal(nova.version, "0.2.0");

      const baixado = join(pasta, "baixado.zip");
      await baixarConferindo(nova.zipUrl, baixado, nova.sha512);
      const bundle = await extrairBundle(baixado, join(pasta, "extraido"), nova.version);
      assert.equal(readFileSync(join(bundle, "Contents", "MacOS", "marca"), "utf8"), "nova");

      // Mesma versão instalada: nada a fazer. Outra arquitetura: sem pacote.
      assert.equal(await procurarVersaoNova({ atual: "0.2.0", arch: "arm64", api: gh.api, repo: "dono/repo" }), null);
      assert.equal(await procurarVersaoNova({ atual: "0.1.0", arch: "x64", api: gh.api, repo: "dono/repo" }), null);
    } finally {
      await gh.fechar();
    }
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
});

test("hash que não confere apaga o download e recusa", async () => {
  const pasta = pastaTemporaria();
  const gh = await githubDeMentira({
    tag: "v0.2.0",
    zipNome: "x.zip",
    zip: Buffer.from("conteúdo adulterado"),
    manifesto: { version: "0.2.0", publishedAt: "", files: [] },
  });
  try {
    const destino = join(pasta, "x.zip");
    await assert.rejects(() => baixarConferindo(`${gh.api}/asset/zip`, destino, "outro-hash"), /não confere/);
    assert.equal(existsSync(destino), false, "o arquivo com hash errado não pode sobrar");
  } finally {
    await gh.fechar();
    rmSync(pasta, { recursive: true, force: true });
  }
});

test("manifesto de outra versão e bundle de outra versão são recusados", async () => {
  const pasta = pastaTemporaria();
  try {
    const gh = await githubDeMentira({
      tag: "v0.3.0",
      zipNome: "z.zip",
      zip: Buffer.alloc(0),
      manifesto: { version: "0.2.0", publishedAt: "", files: [] },
    });
    try {
      await assert.rejects(
        () => procurarVersaoNova({ atual: "0.1.0", arch: "arm64", api: gh.api, repo: "dono/repo" }),
        /manifesto da versão 0.2.0/,
      );
    } finally {
      await gh.fechar();
    }

    const origem = join(pasta, "origem");
    mkdirSync(origem);
    const zip = join(pasta, "a.zip");
    zipar(bundleDeMentira(origem, "0.2.0", "x"), zip);
    await assert.rejects(() => extrairBundle(zip, join(pasta, "ext"), "0.3.0"), /bundle dentro dele é 0.2.0/);
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
});

test("repositório sem release nenhum não é falha", async () => {
  const gh = await githubDeMentira({
    tag: "",
    zipNome: "",
    zip: Buffer.alloc(0),
    manifesto: {},
    semRelease: true,
  });
  try {
    assert.equal(await procurarVersaoNova({ atual: "0.1.0", arch: "arm64", api: gh.api, repo: "dono/repo" }), null);
  } finally {
    await gh.fechar();
  }
});

test("a troca espera o processo sair e só então põe o bundle novo no lugar", async () => {
  const pasta = pastaTemporaria();
  try {
    mkdirSync(join(pasta, "instalado"));
    mkdirSync(join(pasta, "novo"));
    const atual = bundleDeMentira(join(pasta, "instalado"), "0.1.0", "velha");
    const novo = bundleDeMentira(join(pasta, "novo"), "0.2.0", "nova");

    // O "aplicativo" é um processo que ainda está de pé quando o script começa.
    const app = spawn("sleep", ["30"]);
    const script = spawn("sh", ["-c", scriptDeTroca({ pid: app.pid!, atual, novo, reabrir: false })]);
    const terminou = new Promise<number | null>((r) => script.on("exit", r));

    // Enquanto o aplicativo vive, nada mudou.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(readFileSync(join(atual, "Contents", "MacOS", "marca"), "utf8"), "velha");

    app.kill();
    assert.equal(await terminou, 0);
    assert.equal(readFileSync(join(atual, "Contents", "MacOS", "marca"), "utf8"), "nova");
    assert.equal(existsSync(`${atual}.anterior`), false, "a cópia de segurança sai quando o novo entra");
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
});

test("se o bundle novo sumiu, a troca devolve o antigo ao lugar", () => {
  const pasta = pastaTemporaria();
  try {
    mkdirSync(join(pasta, "instalado"));
    const atual = bundleDeMentira(join(pasta, "instalado"), "0.1.0", "velha");
    // PID que não existe: o script segue direto para a troca.
    const r = spawnSync("sh", ["-c", scriptDeTroca({ pid: 999_999, atual, novo: join(pasta, "nao-existe.app"), reabrir: false })]);
    assert.notEqual(r.status, 0);
    assert.equal(readFileSync(join(atual, "Contents", "MacOS", "marca"), "utf8"), "velha");
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
});

test("só troca bundle instalado, não o aberto do .dmg nem o translocado", () => {
  assert.equal(bundleDoExecutavel("/Applications/Locum.app/Contents/MacOS/Locum"), "/Applications/Locum.app");
  assert.equal(bundleDoExecutavel("/usr/local/bin/node"), null);
  assert.equal(motivoParaNaoTrocar("/Applications/Locum.app"), null);
  assert.match(motivoParaNaoTrocar("/Volumes/Locum 0.1.0/Locum.app") ?? "", /\.dmg/);
  assert.match(motivoParaNaoTrocar("/private/var/folders/x/AppTranslocation/y/d/Locum.app") ?? "", /isolada/);
});

test("reabrir depois da troca sobe instância nova, mesmo com o --mcp do mesmo pacote no ar", () => {
  const script = scriptDeTroca({ pid: 1, atual: "/Applications/Locum.app", novo: "/tmp/novo/Locum.app", reabrir: true });
  assert.match(script, /^open -n '?\/Applications\/Locum\.app'?$/m);
});

test("a pergunta ao GitHub não usa o cache HTTP, que segurava a versão de um minuto atrás", async () => {
  const pedidos: Array<RequestInit | undefined> = [];
  const buscar = (async (_url: string, init?: RequestInit) => {
    pedidos.push(init);
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  assert.equal(await procurarVersaoNova({ atual: "0.1.0", arch: "arm64", buscar }), null);
  assert.equal(pedidos[0]?.cache, "no-store");
});
