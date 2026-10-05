import { eq } from "drizzle-orm";
import type { ActionHandler } from "../approval/gate.js";
import { db as defaultDb, schema } from "../db/index.js";
import { LocalFolderContextStore, type ContextStore } from "../services/context-store.js";
import { buildDigestProposal, DigestProposal, type DigestItem } from "./proposal.js";

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
 * O digest como documento para conferir e copiar, não para auditar: por canal,
 * uma tabela de linha e valor, o que pede atenção logo abaixo, e as fontes no
 * fim. O resultado é a primeira linha do resumo, como na tela
 * (`renderer/lib/digest.ts`), e o valor é o trecho dele antes do primeiro " · ".
 *
 * Quando todo assunto do canal que é linha de planilha vem numerado
 * ("6 · Incidentes"), sai também um bloco com um valor por linha, da primeira à
 * última, com linha vazia onde não há assunto: copiado, cola direto na coluna.
 */
export function markdownDaEntrega(proposta: DigestProposal): string {
  const celula = (texto: string) => texto.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
  const partes = (item: DigestItem) => {
    const texto = item.summary.trim();
    const quebra = texto.indexOf("\n");
    const resultado = (quebra >= 0 ? texto.slice(0, quebra) : texto).trim();
    const corte = resultado.indexOf(" · ");
    return {
      resultado,
      valor: corte >= 0 ? resultado.slice(0, corte) : resultado,
      detalhe: quebra >= 0 ? texto.slice(quebra + 1).trim() : "",
    };
  };
  const numerada = /^(\d+)\s*·\s*(.+)$/;

  const linhas = [`# ${proposta.headline.trim()}`, ""];
  const fontes: string[] = [];
  for (const canal of proposta.channels) {
    // A ordem é a do digest, que segue a planilha; a da proposta põe o que
    // pede atenção primeiro, e aqui a atenção tem lista própria.
    const itens = [...canal.items].sort((a, b) => {
      const na = numerada.exec(a.subject)?.[1];
      const nb = numerada.exec(b.subject)?.[1];
      return na !== undefined && nb !== undefined ? Number(na) - Number(nb) : 0;
    });
    linhas.push(`## ${canal.channel}`, "", "| Linha | Valor |", "|---|---|");
    const atencao: string[] = [];
    const porLinha = new Map<number, string>();
    for (const item of itens) {
      const { resultado, valor, detalhe } = partes(item);
      const m = numerada.exec(item.subject);
      const nome = m ? m[2]! : item.subject;
      if (m) porLinha.set(Number(m[1]), valor);
      linhas.push(`| ${celula(nome)} | ${celula(valor)} |`);
      if (item.kind === "needs_reply") atencao.push(`- **${nome}**: ${resultado}`);
      if (detalhe !== "") fontes.push(`- ${canal.channel} · ${nome}: ${celula(detalhe)}`);
    }
    linhas.push("");
    if (atencao.length > 0) linhas.push("Pede atenção:", "", ...atencao, "");
    if (porLinha.size > 1) {
      const numeros = [...porLinha.keys()];
      const de = Math.min(...numeros);
      const ate = Math.max(...numeros);
      const coluna = Array.from({ length: ate - de + 1 }, (_, i) => porLinha.get(de + i) ?? "");
      linhas.push(`Para colar na coluna, linhas ${de} a ${ate}:`, "", "```text", ...coluna, "```", "");
    }
  }
  if (fontes.length > 0) linhas.push("## De onde veio cada número", "", ...fontes, "");
  return linhas.join("\n").trimEnd() + "\n";
}
