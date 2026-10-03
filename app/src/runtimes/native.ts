import { generateText, stepCountIs, type LanguageModel, type ModelMessage, type TextPart } from "ai";
import { buildProviders, type ProviderEntry } from "../providers/registry.js";
import { costOf, priceService, type PriceService } from "../services/price-service.js";
import type { Runtime, RuntimeRequest, RuntimeResult } from "./types.js";

/**
 * Runtime padrao: qualquer provedor por chave de API, via AI SDK.
 *
 * A saida estruturada e pedida no prompt e validada aqui, em vez de usar
 * `generateObject`, porque o passo pode ter ferramentas e precisa do laco.
 */
/** Quanto um passo pode levar, contando todas as voltas do laço de ferramentas. */
const NATIVE_TIMEOUT_MS = 15 * 60 * 1000;

export class NativeRuntime implements Runtime {
  readonly id = "native";

  // Recebe os provedores prontos porque quem monta o executor ja os remontou
  // com o que veio do keychain. Construir aqui de novo leria so o ambiente.
  constructor(
    private readonly providers: Record<string, ProviderEntry> = buildProviders(),
    private readonly prices: Pick<PriceService, "priceFor"> = priceService,
  ) {}

  private modelFor(provider: string, model: string): LanguageModel {
    const entry = this.providers[provider];
    if (!entry?.model) throw new Error(`provider "${provider}" nao expoe modelo de API`);
    return entry.model(model);
  }

  async run(req: RuntimeRequest): Promise<RuntimeResult> {
    const system = [
      req.system,
      req.outputSchema
        ? `Responda apenas com JSON valido conforme este schema, sem cerca de codigo e sem texto em volta:\n${JSON.stringify(req.outputSchema)}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await generateText({
      model: this.modelFor(req.provider, req.model),
      messages: cacheableMessages(system, req.prompt, req.stablePrefix),
      tools: req.tools,
      stopWhen: stepCountIs(req.maxSteps),
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      // O mesmo teto do `claude -p`. Sem ele, um provedor que para de
      // responder deixava o run em `running` para sempre, e run em andamento
      // não aceita reexecução.
      abortSignal: AbortSignal.timeout(NATIVE_TIMEOUT_MS),
    });

    const toolsUsed = new Set<string>();
    for (const step of result.steps ?? []) {
      for (const call of step.toolCalls ?? []) toolsUsed.add(call.toolName);
    }

    // `totalUsage` soma todas as voltas do laço de ferramentas; `usage` seria
    // só a última, e o passo que chamou cinco ferramentas pareceria barato.
    const promptTokens = result.totalUsage?.inputTokens ?? 0;
    const completionTokens = result.totalUsage?.outputTokens ?? 0;
    const cacheReadTokens = result.totalUsage?.inputTokenDetails?.cacheReadTokens;
    const price = await this.prices.priceFor(req.provider, req.model);

    return {
      text: result.text,
      structured: req.outputSchema ? parseJson(result.text) : undefined,
      promptTokens,
      completionTokens,
      cacheReadTokens,
      costUsd: price ? costOf(price, promptTokens, completionTokens) : 0,
      billable: true,
      priced: price !== undefined,
      toolsUsed: [...toolsUsed],
    };
  }
}

/**
 * Marca de cache pela opção de provedor do AI SDK. Só a Anthropic precisa de
 * marca explícita; OpenAI e Gemini guardam o prefixo repetido sozinhos, e para
 * eles basta a ordem. Provedor que não reconhece a chave a ignora.
 */
const CACHE_MARK = { anthropic: { cacheControl: { type: "ephemeral" as const } } };

/**
 * Sistema, trecho estável do prompt e o resto, nessa ordem, com a marca no fim
 * do que não muda entre eventos.
 *
 * O cache do provedor vale para prefixo idêntico: qualquer byte variável antes
 * da marca, como o diff, faz cada chamada escrever cache novo e nunca ler.
 */
export function cacheableMessages(system: string, prompt: string, prefix?: string): ModelMessage[] {
  const stable = prefix && prompt.startsWith(prefix) ? prefix : "";
  const rest = prompt.slice(stable.length);
  const messages: ModelMessage[] = [];

  if (system.length > 0) {
    messages.push({ role: "system", content: system, providerOptions: stable ? undefined : CACHE_MARK });
  }
  const parts: TextPart[] = [];
  if (stable) parts.push({ type: "text", text: stable, providerOptions: CACHE_MARK });
  if (rest.length > 0 || parts.length === 0) parts.push({ type: "text", text: rest });
  messages.push({ role: "user", content: parts });
  return messages;
}

/** Modelo as vezes devolve cerca de codigo mesmo mandado nao devolver. */
export function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const first = body.indexOf("{");
    const last = body.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(body.slice(first, last + 1));
    throw new Error(`saida nao e JSON valido: ${body.slice(0, 200)}`);
  }
}
