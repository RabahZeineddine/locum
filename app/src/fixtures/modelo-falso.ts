import type { LanguageModelV2, LanguageModelV2Prompt, LanguageModelV2StreamPart } from "@ai-sdk/provider";

/**
 * Modelo de brinquedo para o teste e a fumaça conversarem sem rede nem chave.
 *
 * Não é parte do produto: serve de alvo para o laço de ferramentas do chat do
 * agent, no mesmo espírito do servidor MCP de brinquedo. O roteiro padrão
 * obedece ao que a pessoa escreve: `[[chama nome {"json":"da entrada"}]]` vira
 * uma chamada dessa ferramenta, e depois que o resultado volta ele o repete em
 * texto, para o teste ver o que o modelo recebeu.
 */
export interface PassoDoModelo {
  texto?: string;
  chamadas?: { nome: string; entrada: unknown }[];
}

export type Roteiro = (prompt: LanguageModelV2Prompt) => PassoDoModelo;

/** O texto da última mensagem da pessoa. */
export function ultimaDaPessoa(prompt: LanguageModelV2Prompt): string {
  const mensagem = [...prompt].reverse().find((m) => m.role === "user");
  if (mensagem?.role !== "user") return "";
  return mensagem.content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** O que voltou das ferramentas na última mensagem do prompt, quando ela é de ferramenta. */
export function voltaDasFerramentas(prompt: LanguageModelV2Prompt): string[] | null {
  const ultima = prompt.at(-1);
  if (ultima?.role !== "tool") return null;
  return ultima.content.flatMap((p) => {
    if (p.type !== "tool-result") return [];
    // O AI SDK entrega a recusa como `execution-denied`, que o tipo da especificação não conhece.
    const saida = p.output as { type: string; value?: unknown; reason?: string };
    if (saida.type === "execution-denied") return [`recusado: ${saida.reason ?? ""}`.trim()];
    return [typeof saida.value === "string" ? saida.value : JSON.stringify(saida.value)];
  });
}

export const roteiroPadrao: Roteiro = (prompt) => {
  const volta = voltaDasFerramentas(prompt);
  if (volta !== null) return { texto: `Voltou: ${volta.join(" | ")}` };
  const pedido = ultimaDaPessoa(prompt);
  const chamadas = [...pedido.matchAll(/\[\[chama (\S+)(?: (\{.*?\}))?\]\]/g)].map((m) => ({
    nome: m[1]!,
    entrada: m[2] === undefined ? {} : (JSON.parse(m[2]) as unknown),
  }));
  if (chamadas.length > 0) return { texto: "Vou chamar.", chamadas };
  return { texto: `Resposta do modelo falso a: ${pedido}` };
};

export interface ModeloFalso extends LanguageModelV2 {
  /** Os prompts que chegaram, na ordem, para o teste olhar o que o modelo viu. */
  readonly recebidos: LanguageModelV2Prompt[];
}

export function modeloFalso(roteiro: Roteiro = roteiroPadrao): ModeloFalso {
  const recebidos: LanguageModelV2Prompt[] = [];
  let contador = 0;
  return {
    specificationVersion: "v2",
    provider: "falso",
    modelId: "roteiro",
    supportedUrls: {},
    recebidos,
    doGenerate: () => Promise.reject(new Error("o modelo falso só responde por fluxo")),
    doStream: async ({ prompt }) => {
      recebidos.push(prompt);
      const passo = roteiro(prompt);
      const partes: LanguageModelV2StreamPart[] = [{ type: "stream-start", warnings: [] }];
      if (passo.texto !== undefined) {
        const id = `t${++contador}`;
        partes.push({ type: "text-start", id });
        // Em dois pedaços: o fluxo de verdade chega aos poucos.
        const meio = Math.ceil(passo.texto.length / 2);
        partes.push({ type: "text-delta", id, delta: passo.texto.slice(0, meio) });
        partes.push({ type: "text-delta", id, delta: passo.texto.slice(meio) });
        partes.push({ type: "text-end", id });
      }
      for (const chamada of passo.chamadas ?? []) {
        partes.push({
          type: "tool-call",
          toolCallId: `chamada-${++contador}`,
          toolName: chamada.nome,
          input: JSON.stringify(chamada.entrada),
        });
      }
      partes.push({
        type: "finish",
        finishReason: (passo.chamadas?.length ?? 0) > 0 ? "tool-calls" : "stop",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const parte of partes) controller.enqueue(parte);
            controller.close();
          },
        }),
      };
    },
  };
}
