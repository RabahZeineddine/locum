import en from "../../locales/en.json";
import ptBR from "../../locales/pt-BR.json";
import { FALLBACK_LANGUAGE, type Language } from "./i18n-service.js";

type Dictionary = Record<string, unknown>;

const DICTIONARIES: Record<Language, Dictionary> = {
  en: en as Dictionary,
  "pt-BR": ptBR as Dictionary,
};

function lookup(dictionary: Dictionary, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>((node, parte) => {
      if (node && typeof node === "object" && parte in (node as Dictionary)) {
        return (node as Dictionary)[parte];
      }
      return undefined;
    }, dictionary);
}

function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, nome: string) => {
    const valor = vars[nome];
    return valor === undefined ? match : String(valor);
  });
}

/**
 * Texto de uma chave do dicionario, fora da casca Electron.
 *
 * `src/` nao importa `electron/`, entao o texto gerado ali (context.md,
 * corpo de prompt) nao passa pelo i18next da casca: e so o par de JSON
 * importado direto, com interpolacao manual de `{{variavel}}`. Cai para
 * `FALLBACK_LANGUAGE` quando o idioma pedido nao tem a chave, e estoura
 * quando nem o idioma base tem: devolver a propria chave esconderia o
 * dicionario incompleto em vez de acusar na hora.
 */
export function translate(
  language: Language,
  key: string,
  vars: Record<string, unknown> = {},
): string {
  const direto = lookup(DICTIONARIES[language], key);
  const valor = typeof direto === "string" ? direto : lookup(DICTIONARIES[FALLBACK_LANGUAGE], key);
  if (typeof valor !== "string") {
    throw new Error(`chave de traducao ausente: "${key}"`);
  }
  return interpolate(valor, vars);
}
