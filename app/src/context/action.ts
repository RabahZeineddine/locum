import { eq } from "drizzle-orm";
import { PublishConflict, type ActionHandler } from "../approval/gate.js";
import { db as defaultDb, schema } from "../db/index.js";
import { LocalFolderContextStore, type ContextStore } from "../services/context-store.js";
import { ContextUpdateProposal } from "./proposal.js";

type Db = typeof defaultDb;

export interface ContextUpdateHandlerOptions {
  db?: Db;
  /** Como abrir a pasta de contexto de uma iniciativa. Trocavel para o exame. */
  storeFor?: (contextPath: string) => ContextStore;
}

/**
 * O handler da ação `context.update`.
 *
 * Ele nasce e permanece em `approve`: o `context.md` é lido por qualquer
 * agent que a iniciativa rodar, e uma mudança nele sem ninguém ter visto
 * mudaria o comportamento de todos eles em silêncio. Sem `draft` pela mesma
 * razão do digest: rascunho de arquivo de texto não existe, e emular um
 * escrevendo e desfazendo deixaria o arquivo instável para quem estiver lendo
 * no meio do caminho.
 *
 * `propose` só valida: o conteúdo já vem pronto do que pediu a mudança, e o
 * que a fila mostra é exatamente o que seria escrito.
 *
 * `publish` trata os dois modos de forma diferente. `replace` é conflito
 * quando o arquivo mudou por fora desde a proposta, e não-operação quando o
 * conteúdo já é exatamente o que se pediu, o que cobre a repetição depois de
 * uma queda no meio do caminho. `append` é sempre idempotente: o marcador que
 * o `ContextStore.append` procura é o `externalId` da própria pendência.
 */
export function contextUpdateHandler(options: ContextUpdateHandlerOptions = {}): ActionHandler {
  const db = options.db ?? defaultDb;
  const storeFor = options.storeFor ?? ((contextPath: string) => new LocalFolderContextStore(contextPath));

  return {
    modes: ["approve"],

    async propose(payload) {
      return ContextUpdateProposal.parse(payload);
    },

    async publish(payload, externalId) {
      const proposta = ContextUpdateProposal.parse(payload);
      const [iniciativa] = await db
        .select()
        .from(schema.initiatives)
        .where(eq(schema.initiatives.id, proposta.initiativeId));
      if (!iniciativa) throw new Error(`iniciativa "${proposta.initiativeId}" nao encontrada`);

      const contexto = storeFor(iniciativa.contextPath);
      const hash = await escrever(contexto, proposta, externalId);

      await db
        .update(schema.initiatives)
        .set({ contextHash: hash, contextUpdatedAt: Math.floor(Date.now() / 1000) })
        .where(eq(schema.initiatives.id, iniciativa.id));
    },
  };
}

async function escrever(
  contexto: ContextStore,
  proposta: ContextUpdateProposal,
  externalId: string,
): Promise<string> {
  if (proposta.mode === "append") {
    const marcador = `<!-- locum:${externalId} -->`;
    const resultado = await contexto.append(proposta.file, proposta.content, marcador);
    return resultado.hash;
  }

  const hashAtual = await contexto.hash(proposta.file);
  if (hashAtual !== null) {
    const conteudoAtual = await contexto.read(proposta.file);
    // Retry depois de crash: a escrita ja aconteceu, e repetir nao pode
    // acusar conflito do proprio resultado que ela mesma produziu.
    if (conteudoAtual === proposta.content) return hashAtual;
  }
  if (hashAtual !== (proposta.baseHash ?? null)) {
    throw new PublishConflict(`"${proposta.file}" mudou desde a proposta`);
  }

  const resultado = await contexto.write(proposta.file, proposta.content, { expectHash: proposta.baseHash });
  return resultado.hash;
}
