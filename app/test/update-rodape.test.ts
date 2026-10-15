import { test } from "node:test";
import assert from "node:assert/strict";
import { baixarConferindo } from "../src/update/release.js";
import { progressoDoDownload, rodapeDaAtualizacao, versaoParaOModal } from "../src/update/rodape.js";
import type { UpdaterState } from "../src/update/state.js";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function estado(parcial: Partial<UpdaterState>): UpdaterState {
  return {
    current: "0.1.0",
    preference: null,
    enabled: true,
    armed: true,
    reason: null,
    detail: null,
    phase: "idle",
    progress: null,
    lastCheckAt: null,
    available: null,
    dismissedVersion: null,
    error: null,
    errorKind: null,
    ...parcial,
  };
}

const nova = { version: "0.2.0", notes: "- corrige" };

test("o rodapé mostra só a versão quando não há o que dizer", () => {
  assert.deepEqual(rodapeDaAtualizacao(estado({ phase: "idle" })), { tipo: "versao" });
  assert.deepEqual(rodapeDaAtualizacao(estado({ phase: "uptodate" })), { tipo: "versao" });
  assert.deepEqual(rodapeDaAtualizacao(estado({ phase: "failed", error: "x", errorKind: "offline" })), {
    tipo: "versao",
  });
  for (const reason of ["disabled", "dev", "not-replaceable"] as const) {
    assert.deepEqual(rodapeDaAtualizacao(estado({ reason, phase: "checking" })), { tipo: "versao" });
  }
});

test("o rodapé procura, baixa e avisa que está pronta", () => {
  assert.deepEqual(rodapeDaAtualizacao(estado({ phase: "checking" })), { tipo: "procurando" });
  assert.deepEqual(rodapeDaAtualizacao(estado({ phase: "downloading", available: nova, progress: 42 })), {
    tipo: "baixando",
    version: "0.2.0",
    percent: 42,
  });
  assert.deepEqual(rodapeDaAtualizacao(estado({ phase: "downloading", available: nova })), {
    tipo: "baixando",
    version: "0.2.0",
    percent: null,
  });
  assert.deepEqual(rodapeDaAtualizacao(estado({ phase: "ready", available: nova })), {
    tipo: "pronta",
    version: "0.2.0",
  });
});

test("pronta sem versão conhecida não inventa link", () => {
  assert.deepEqual(rodapeDaAtualizacao(estado({ phase: "ready" })), { tipo: "versao" });
});

test("o modal abre para a versão pronta, exceto a dispensada nesta sessão", () => {
  const pronta = estado({ phase: "ready", available: nova });
  assert.equal(versaoParaOModal(pronta), "0.2.0");
  assert.equal(versaoParaOModal({ ...pronta, dismissedVersion: "0.2.0" }), null);
  assert.equal(versaoParaOModal({ ...pronta, dismissedVersion: "0.1.9" }), "0.2.0");
  assert.equal(versaoParaOModal(estado({ phase: "downloading", available: nova })), null);
});

test("versão baixada continua à mostra com a atualização desligada depois", () => {
  assert.deepEqual(rodapeDaAtualizacao(estado({ reason: "disabled", enabled: false, phase: "ready", available: nova })), {
    tipo: "pronta",
    version: "0.2.0",
  });
  assert.equal(versaoParaOModal(estado({ reason: "disabled", phase: "ready", available: nova })), "0.2.0");
  // Desligada sem nada baixado, nem fase em curso aparece.
  assert.deepEqual(rodapeDaAtualizacao(estado({ reason: "disabled", phase: "downloading", available: nova })), {
    tipo: "versao",
  });
});

test("o progresso é porcentagem inteira, presa entre 0 e 100", () => {
  assert.equal(progressoDoDownload(0, 200), 0);
  assert.equal(progressoDoDownload(84, 200), 42);
  assert.equal(progressoDoDownload(199, 200), 99);
  assert.equal(progressoDoDownload(250, 200), 100);
  assert.equal(progressoDoDownload(10, null), null);
  assert.equal(progressoDoDownload(10, 0), null);
  // Sem total do servidor, vale o tamanho do manifesto.
  assert.equal(progressoDoDownload(50, null, 200), 25);
  assert.equal(progressoDoDownload(50, 100, 200), 50);
  assert.equal(progressoDoDownload(50, null, null), null);
});

test("o download conta os bytes que chegam", async () => {
  const pasta = mkdtempSync(join(tmpdir(), "locum-progresso-"));
  try {
    const partes = [Buffer.from("aaaa"), Buffer.from("bbbbbb")];
    const sha = createHash("sha512").update(Buffer.concat(partes)).digest("base64");
    const buscar = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (const p of partes) c.enqueue(p);
            c.close();
          },
        }),
        { status: 200, headers: { "content-length": "10" } },
      )) as unknown as typeof fetch;
    const vistos: [number, number | null][] = [];
    await baixarConferindo("http://x/pacote.zip", join(pasta, "p.zip"), sha, buscar, (r, t) => vistos.push([r, t]));
    assert.deepEqual(vistos.at(-1), [10, 10]);
    assert.ok(vistos.every(([r]) => r <= 10));
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
});

function buscaDe(partes: Buffer[], cabecalhos: Record<string, string>): typeof fetch {
  return (async () =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const p of partes) c.enqueue(p);
          c.close();
        },
      }),
      { status: 200, headers: cabecalhos },
    )) as unknown as typeof fetch;
}

test("sem content-length o total vem como null, e o progresso cai no tamanho do manifesto", async () => {
  const pasta = mkdtempSync(join(tmpdir(), "locum-progresso-"));
  try {
    const partes = [Buffer.from("aaaa"), Buffer.from("bbbbbb")];
    const sha = createHash("sha512").update(Buffer.concat(partes)).digest("base64");
    const vistos: [number, number | null][] = [];
    await baixarConferindo("http://x/p.zip", join(pasta, "p.zip"), sha, buscaDe(partes, {}), (r, t) => vistos.push([r, t]));
    assert.ok(vistos.length > 0 && vistos.every(([, t]) => t === null));
    // O que o updater faz com isso, com o tamanho do manifesto como reserva.
    assert.equal(progressoDoDownload(vistos[0]![0], vistos[0]![1], 10), 40);
    assert.equal(progressoDoDownload(vistos.at(-1)![0], null, 10), 100);
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
});

test("hash errado, com progresso acompanhando, ainda apaga o arquivo e lança", async () => {
  const pasta = mkdtempSync(join(tmpdir(), "locum-progresso-"));
  try {
    const destino = join(pasta, "p.zip");
    let chamadas = 0;
    await assert.rejects(
      () => baixarConferindo("http://x/p.zip", destino, "outro-hash", buscaDe([Buffer.from("abc")], { "content-length": "3" }), () => chamadas++),
      /não confere/,
    );
    assert.ok(chamadas > 0);
    assert.equal(existsSync(destino), false);
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
});
