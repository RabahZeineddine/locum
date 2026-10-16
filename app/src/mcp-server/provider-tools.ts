import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { priceService } from "../services/price-service.js";
import { providerService } from "../services/provider-service.js";
import { def } from "./tool-def.js";

/**
 * Provedores de modelo, o que a tela de Configuração faz com eles: gateway
 * cadastrado, chave no cofre, endereço do Ollama, catálogo de modelos e preço.
 *
 * A chave entra e não sai, como a do GitHub: `save_provider_secret` aceita o
 * valor e devolve só o estado, e toda saída ainda passa pela redação. A tabela
 * de substituição (`list_providers`, `set_model_fallback`) mora em outro arquivo.
 */
export function registerProviderTools(server: McpServer): void {
  def(server, "list_registered_providers", "read",
    "The OpenAI-compatible gateways registered on this machine (id, label, base URL, enabled). Never the key.",
    {}, () => providerService.listRegistered());

  def(server, "register_provider", "publish",
    "Registers or updates an OpenAI-compatible gateway (id, label, baseUrl). Changing the baseUrl of an existing gateway sends the stored key, and the prompts of every step that names the id, to the new host: a dangerous, outward-facing write.",
    { id: z.string().min(1), label: z.string().min(1), baseUrl: z.string().min(1) },
    async (cadastro) => {
      await providerService.register(cadastro);
      return (await providerService.listRegistered()).find((p) => p.id === cadastro.id) ?? null;
    });

  def(server, "set_provider_enabled", "write",
    "Turns a provider on or off for model steps and the model list.",
    { name: z.string().min(1), enabled: z.boolean() },
    async ({ name, enabled }) => {
      await providerService.setEnabled(name, enabled);
      return { name, enabled };
    });

  def(server, "remove_provider", "danger",
    "Removes a registered gateway and its key. Without force nothing is removed when something still uses it: the answer lists where (agents, library agents, fallbacks). With force it is removed anyway, and those steps fail until they get another model.",
    { id: z.string().min(1), force: z.boolean().optional() },
    ({ id, force }) => providerService.remove(id, force ?? false));

  def(server, "get_provider_credentials", "read",
    "Where the key of each provider lives, whether a value is stored and what the last check found. Never the value.",
    {}, () => providerService.credentials());

  def(server, "save_provider_secret", "danger",
    "Stores the API key of a provider in the keychain, OVERWRITING the one stored. The value is accepted and never returned; the previous check is discarded.",
    { name: z.string().min(1), secret: z.string().min(1) },
    async ({ name, secret }) => {
      await providerService.setSecret(name, secret);
      return (await providerService.credentials()).find((c) => c.provider === name) ?? { provider: name };
    });

  def(server, "forget_provider_secret", "danger",
    "Forgets the stored API key of a provider. Steps on that provider fail until a new key is saved.",
    { name: z.string().min(1) }, async ({ name }) => ({ removed: await providerService.clearSecret(name) }));

  def(server, "check_provider", "read-external",
    "Asks the provider for its model catalog with the stored key and counts the models. Publishes nothing; without a key it answers from this machine.",
    { name: z.string().min(1) }, ({ name }) => providerService.check(name));

  def(server, "list_provider_models", "read-external",
    "The models one provider declares, asked to the provider itself.",
    { name: z.string().min(1) }, ({ name }) => providerService.listModels(name));

  def(server, "list_all_models", "read-external",
    "The models of every available provider, as provider/model. subscription true includes the subscription runtimes (Claude Code, Codex).",
    { subscription: z.boolean().optional() },
    ({ subscription }) => providerService.listAllModels({ assinatura: subscription === true }));

  def(server, "get_ollama_url", "read",
    "The Ollama address: the one saved in the app and the one from the environment. The saved one wins.",
    {}, () => providerService.ollamaUrl());

  def(server, "set_ollama_url", "write",
    "Saves the Ollama address, applied at once. null clears the saved one and goes back to the environment.",
    { url: z.string().min(1).nullable() },
    async ({ url }) => {
      await providerService.setOllamaUrl(url);
      return providerService.ollamaUrl();
    });

  def(server, "list_model_prices", "read",
    "The price per million tokens of each model (input and output), which the native runtime multiplies by the tokens to reach the dollar cap.",
    {}, () => priceService.list());

  def(server, "set_model_price", "write",
    "Sets the price of a model, in dollars per million tokens. Zero is a valid price (local model, free gateway).",
    { provider: z.string().min(1), model: z.string().min(1), inputUsdPerMtok: z.number().nonnegative(), outputUsdPerMtok: z.number().nonnegative() },
    (preco) => priceService.set(preco));

  def(server, "remove_model_price", "write",
    "Removes the price of a model. Without it the dollar cost of that model stays at zero and only the token cap protects it.",
    { provider: z.string().min(1), model: z.string().min(1) },
    async ({ provider, model }) => ({ removed: await priceService.remove(provider, model) }));
}
