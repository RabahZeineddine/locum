import type { LogicCompare, LogicStep } from "../config/types.js";
import { renderParams, renderPrompt, type EventPayload } from "./executor.js";

/**
 * Os passos de lógica: decidir caminho e transformar dado, sem modelo.
 *
 * Funções puras sobre o evento e as saídas anteriores. O executor grava o que
 * sai daqui como saída do passo, e o `branch` dela é o que os passos com
 * `when` comparam para rodar ou pular.
 */

export type LogicOutput = unknown;

export function runLogic(step: LogicStep, payload: EventPayload, outputs: Map<string, unknown>): LogicOutput {
  const valor = renderParams(step.value, payload, outputs);
  switch (step.op) {
    case "if": {
      const contra = renderPrompt(step.against, payload, outputs);
      return { branch: comparar(valor, step.compare, contra) ? "true" : "false", value: valor };
    }
    case "switch": {
      const texto = comoTexto(valor).trim();
      const caso = step.cases.find((c) => c.trim() === texto);
      return { branch: caso ?? "default", value: valor };
    }
    case "json.parse": {
      if (typeof valor !== "string") return valor;
      try {
        return JSON.parse(semCerca(valor));
      } catch {
        throw new Error(`o texto de "${step.name}" não é JSON: ${valor.slice(0, 120)}`);
      }
    }
    case "json.stringify":
      return typeof valor === "string" ? valor : JSON.stringify(valor ?? null);
    case "text":
      return comoTexto(valor);
    case "slack.mrkdwn":
      return { text: markdownParaSlack(comoTexto(valor)) };
    case "slack.blocks": {
      const texto = markdownParaSlack(comoTexto(valor));
      const titulo = renderPrompt(step.title, payload, outputs).trim();
      return { text: titulo === "" ? texto : `${titulo}\n${texto}`, blocks: blocosDoSlack(titulo, texto) };
    }
    case "teams.card": {
      const texto = comoTexto(valor);
      const titulo = renderPrompt(step.title, payload, outputs).trim();
      return { text: titulo === "" ? texto : `${titulo}\n\n${texto}`, card: cartaoDoTeams(titulo, texto) };
    }
  }
}

function comoTexto(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

/** Modelo costuma cercar JSON com ```json; a cerca não é parte do dado. */
function semCerca(texto: string): string {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(texto);
  return m === null ? texto : m[1]!;
}

function vazio(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

export function comparar(valor: unknown, como: LogicCompare, contra: string): boolean {
  const texto = comoTexto(valor);
  switch (como) {
    case "exists":
      return !vazio(valor);
    case "empty":
      return vazio(valor);
    case "equals":
      return texto.trim() === contra.trim();
    case "not_equals":
      return texto.trim() !== contra.trim();
    case "contains":
      return Array.isArray(valor) ? valor.some((x) => comoTexto(x) === contra) : texto.toLowerCase().includes(contra.toLowerCase());
    case "not_contains":
      return !comparar(valor, "contains", contra);
    case "greater":
    case "less": {
      const a = Number(texto);
      const b = Number(contra);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return como === "greater" ? a > b : a < b;
    }
    case "matches":
      try {
        return new RegExp(contra, "i").test(texto);
      } catch {
        throw new Error(`expressão inválida: ${contra}`);
      }
  }
}

/**
 * Markdown comum para o mrkdwn do Slack, que tem sintaxe própria: negrito com
 * um asterisco, link com `<url|texto>`, e nada de título.
 */
export function markdownParaSlack(md: string): string {
  const guardados: string[] = [];
  // Código fica como está: nada dentro de crase é formatação.
  const semCodigo = md.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => {
    guardados.push(m);
    return `\u0000${guardados.length - 1}\u0000`;
  });
  const convertido = semCodigo
    .split("\n")
    .map((linha) => {
      const titulo = /^\s{0,3}#{1,6}\s+(.*)$/.exec(linha);
      // Marcador em vez de asterisco: a troca de itálico logo abaixo leria o
      // asterisco do título como itálico.
      if (titulo) return `\u0001${titulo[1]!.replace(/\*\*/g, "")}\u0001`;
      return linha.replace(/^(\s*)[-*+]\s+/, "$1• ");
    })
    .join("\n")
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_m, a: string | undefined, b: string | undefined) => `\u0001${a ?? b}\u0001`)
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1_$2_")
    .replace(/\u0001/g, "*")
    .replace(/~~(.+?)~~/g, "~$1~")
    .replace(/!?\[([^\]]+)\]\((\S+?)\)/g, "<$2|$1>");
  return convertido.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => guardados[Number(i)]!);
}

/** Block Kit mínimo: título como cabeçalho e o texto em seções de até 3000 caracteres. */
export function blocosDoSlack(titulo: string, mrkdwn: string): unknown[] {
  const blocos: unknown[] = [];
  if (titulo !== "") blocos.push({ type: "header", text: { type: "plain_text", text: titulo.slice(0, 150), emoji: true } });
  for (let i = 0; i < mrkdwn.length; i += 3000) {
    blocos.push({ type: "section", text: { type: "mrkdwn", text: mrkdwn.slice(i, i + 3000) } });
  }
  return blocos;
}

/** Adaptive Card 1.4, que o Teams desenha: título em destaque e o texto em markdown. */
export function cartaoDoTeams(titulo: string, texto: string): Record<string, unknown> {
  const corpo: unknown[] = [];
  if (titulo !== "") corpo.push({ type: "TextBlock", text: titulo, weight: "Bolder", size: "Medium", wrap: true });
  corpo.push({ type: "TextBlock", text: texto, wrap: true });
  return { type: "AdaptiveCard", $schema: "http://adaptivecards.io/schemas/adaptive-card.json", version: "1.4", body: corpo };
}
