import { eq } from "drizzle-orm";
import type { ActionHandler } from "../approval/gate.js";
import { db as defaultDb, schema } from "../db/index.js";
import { LocalFolderContextStore, type ContextStore } from "../services/context-store.js";
import { buildDigestProposal, DigestProposal } from "./proposal.js";

type Db = typeof defaultDb;

export interface DigestDeliverHandlerOptions {
  db?: Db;
  /** Como abrir a pasta de contexto de uma iniciativa. Trocável para o exame. */
  storeFor?: (contextPath: string) => ContextStore;
}

/**
 * O handler da ação `digest.deliver`.
 *
 * Ele é o primeiro que passa pela fila sem ter lado de fora. Um digest não
 * publica nada: o que ele propõe é leitura, e o clique na fila quer dizer "li",
 * não "manda". Por isso `publish` não chama ninguém, e não é esquecimento.
 *
 * Mesmo sem saída, o caminho continua sendo a gate. É ela que grava a proposta
 * antes de qualquer decisão, que mostra a pendência na inbox e que registra
 * quando ela foi resolvida, e um digest que aparecesse por fora disso seria uma
 * segunda inbox com regra própria.
 *
 * `modes` recusa `auto` e `draft`, e a trava é de código: um digest entregue
 * sozinho sairia da fila sem ninguém ter lido, que é o contrário do que ele
 * existe para fazer, e rascunho de leitura não quer dizer nada.
 *
 * Entregar não acontece aqui. O cursor da entrega anda quando o evento do
 * digest é gravado, em `ingest.ts`, porque uma pendência parada dias na fila
 * seguraria toda a conversa seguinte fora do próximo digest.
 *
 * A única escrita é local: run de uma iniciativa grava o digest lido em
 * `entregas/` na pasta dela, que é de onde a iniciativa lista o que o trabalho
 * já produziu. Sem isso, o resultado aprovado ficava só no banco, e a próxima
 * sessão ou execução da iniciativa não sabia que ele existia. O nome sai do
 * run, então repetir depois de uma queda reescreve o mesmo arquivo.
 */
export function digestDeliverHandler(options: DigestDeliverHandlerOptions = {}): ActionHandler {
  const db = options.db ?? defaultDb;
  const storeFor = options.storeFor ?? ((contextPath: string) => new LocalFolderContextStore(contextPath));

  return {
    modes: ["approve"],

    async propose(payload) {
      return buildDigestProposal(payload);
    },

    async publish(payload, externalId) {
      // Uma pendência editada na inbox continua tendo que ser um digest
      // inteiro para poder ser dada por lida.
      const proposta = DigestProposal.parse(payload);

      // O externalId da gate é `<runId>:<stepId>`.
      const runId = externalId.split(":")[0]!;
      const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
      if (!run?.initiativeId) return;
      const [iniciativa] = await db
        .select()
        .from(schema.initiatives)
        .where(eq(schema.initiatives.id, run.initiativeId));
      if (!iniciativa) return;

      // sv-SE escreve a data local como AAAA-MM-DD, que ordena pelo nome.
      const dia = new Date(run.createdAt * 1000).toLocaleDateString("sv-SE");
      await storeFor(iniciativa.contextPath).write(`entregas/${dia}-${runId.slice(0, 8)}.md`, markdownDaEntrega(proposta));
    },
  };
}

/**
 * O digest como documento: uma tabela por canal, com o resultado na frente e a
 * fonte na última coluna. A primeira linha do resumo é o resultado, como na
 * tela (`renderer/lib/digest.ts`).
 */
export function markdownDaEntrega(proposta: DigestProposal): string {
  const situacao = { needs_reply: "pede atenção", info: "ok", ignore: "ignorar" } as const;
  const celula = (texto: string) => texto.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
  const linhas = [`# ${proposta.headline.trim()}`, ""];
  for (const canal of proposta.channels) {
    linhas.push(`## ${canal.channel}`, "", "| Linha | Resultado | Situação | Fonte e detalhe |", "|---|---|---|---|");
    for (const item of canal.items) {
      const texto = item.summary.trim();
      const quebra = texto.indexOf("\n");
      const valor = quebra >= 0 ? texto.slice(0, quebra) : texto;
      const detalhe = quebra >= 0 ? texto.slice(quebra + 1) : "";
      linhas.push(`| ${celula(item.subject)} | ${celula(valor)} | ${situacao[item.kind]} | ${celula(detalhe)} |`);
    }
    linhas.push("");
  }
  return linhas.join("\n").trimEnd() + "\n";
}
