import type { TFunction } from "i18next";

/**
 * Os rótulos de severidade e de estado, que a inbox e as execuções mostram nos
 * mesmos crachás.
 *
 * O valor chega do banco como texto solto, e por isso passa antes pela lista
 * conhecida: com a guarda de chave ausente ligada, uma severidade ou um estado
 * novo gravado lá atrás derrubaria a tela inteira em vez de aparecer cru. Sem
 * tradução é ruim; tela em branco é pior.
 */

export const SEVERIDADES = ["critical", "high", "medium", "low"] as const;
export type Severidade = (typeof SEVERIDADES)[number];

/** Quanto a auditoria confia no próprio achado; pendência antiga vem sem. */
export const CONFIANCAS = ["high", "medium", "low"] as const;
export type Confianca = (typeof CONFIANCAS)[number];

/**
 * O evento da review no GitHub. Pendência gravada antes do veredito existir
 * vem sem, e sai como comentário, que era o que sempre saía.
 */
export const VEREDITOS = ["APPROVE", "COMMENT", "REQUEST_CHANGES"] as const;
export type Veredito = (typeof VEREDITOS)[number];

export const ESTADOS = [
  "done",
  "running",
  "queued",
  "pending",
  "paused",
  "awaiting_approval",
  "skipped",
  "failed",
  "cancelled",
] as const;
export type Estado = (typeof ESTADOS)[number];

export function rotuloDeSeveridade(t: TFunction, severidade: string): string {
  return (SEVERIDADES as readonly string[]).includes(severidade)
    ? t(`severity.${severidade}`)
    : severidade;
}

export function rotuloDeEstado(t: TFunction, estado: string): string {
  return (ESTADOS as readonly string[]).includes(estado) ? t(`status.${estado}`) : estado;
}

/** Codigo de passo pulado ou rejeitado, gravado em ingles por `gate.ts` e `executor.ts`. */
export const MOTIVOS_DE_PASSO = ["outside_initiative", "rejected", "publish_conflict"] as const;
export type MotivoDePasso = (typeof MOTIVOS_DE_PASSO)[number];

export function rotuloDoMotivo(t: TFunction, motivo: string): string {
  return (MOTIVOS_DE_PASSO as readonly string[]).includes(motivo)
    ? t(`runs.stepReason.${motivo}`)
    : motivo;
}

const PROVEDORES_CONHECIDOS: Record<string, string> = {
  "claude-code": "Claude Code",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  glm: "GLM",
  ollama: "Ollama",
};

/**
 * O modelo como gente lê: `claude-code/claude-sonnet-5` vira
 * "Claude Sonnet 5 · Claude Code".
 *
 * Só os modelos Claude ganham nome por extenso, porque o padrão deles é
 * conhecido (família e versão separadas por hífen). Modelo de outro provedor
 * sai como está, já que adivinhar a grafia erraria mais do que acertaria. O
 * identificador cru continua no editor, que é onde ele é escrito.
 */
export function rotuloDoModelo(id: string): string {
  const barra = id.indexOf("/");
  const provedor = barra === -1 ? null : id.slice(0, barra);
  const modelo = barra === -1 ? id : id.slice(barra + 1);

  const partes = /^claude-([a-z]+)-(\d+(?:-\d+)?)$/.exec(modelo);
  const nome = partes
    ? `Claude ${partes[1]![0]!.toUpperCase()}${partes[1]!.slice(1)} ${partes[2]!.replace("-", ".")}`
    : modelo;
  if (provedor === null) return nome;
  return `${nome} · ${rotuloDoProvedor(provedor)}`;
}

/** O nome do provedor com a grafia da marca, quando conhecida. */
export function rotuloDoProvedor(nome: string): string {
  return PROVEDORES_CONHECIDOS[nome] ?? nome;
}
