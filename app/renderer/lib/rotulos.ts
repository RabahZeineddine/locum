import type { TFunction } from "i18next";
import { motivoDaMensagem, type MotivoDeEvento } from "../../src/executor/dependencia-de-evento.js";

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

/** De onde veio um evento. Fonte nova gravada no banco sai crua, pelo mesmo motivo dos estados. */
export const FONTES_DE_EVENTO = ["teams", "slack", "github", "manual"] as const;

export function rotuloDaFonte(t: TFunction, fonte: string): string {
  return (FONTES_DE_EVENTO as readonly string[]).includes(fonte) ? t(`automations.runWith.source.${fonte}`) : fonte;
}

export function rotuloDeSeveridade(t: TFunction, severidade: string): string {
  return (SEVERIDADES as readonly string[]).includes(severidade)
    ? t(`severity.${severidade}`)
    : severidade;
}

/** O nome de uma ação pelo dicionário; ação sem texto sai com o código dela. */
export function rotuloDaAcao(t: TFunction, kind: string): string {
  return t(`agents.step.actionKind.${kind}`, { defaultValue: kind });
}

export function rotuloDeEstado(t: TFunction, estado: string): string {
  return (ESTADOS as readonly string[]).includes(estado) ? t(`status.${estado}`) : estado;
}

/** Codigo de passo pulado ou rejeitado, gravado em ingles por `gate.ts` e `executor.ts`. */
export const MOTIVOS_DE_PASSO = ["outside_initiative", "rejected", "publish_conflict", "not_run", "expired"] as const;
export type MotivoDePasso = (typeof MOTIVOS_DE_PASSO)[number];

export function rotuloDoMotivo(t: TFunction, motivo: string): string {
  const cabeca = /^publish_conflict:head_mudou:([^:]+):([^:]+)$/.exec(motivo);
  if (cabeca) return t("runs.stepReason.publish_conflict_head", { avaliado: cabeca[1]!.slice(0, 7), atual: cabeca[2]!.slice(0, 7) });
  if (motivo === "publish_conflict:pr_fechado") return t("runs.stepReason.publish_conflict_closed");
  if (motivo.startsWith("dependency_rejected:")) return t("runs.stepReason.dependency_rejected", { step: motivo.slice("dependency_rejected:".length) });
  return (MOTIVOS_DE_PASSO as readonly string[]).includes(motivo)
    ? t(`runs.stepReason.${motivo}`)
    : motivo;
}

/**
 * O erro de um run como a pessoa lê. A recusa de rodar sem evento chega com o
 * código e os parâmetros do motivo, e o texto sai na língua da janela; o resto
 * é do passo ou da API e passa como veio.
 */
export function rotuloDoErroDeRun(t: TFunction, mensagem: string): string {
  const motivo = motivoDaMensagem(mensagem);
  return motivo === null ? mensagem : t("automations.runWith.refused", { reason: rotuloDoMotivoDeEvento(t, motivo) });
}

/** Os textos livres que o executor gravava antes dos códigos, e o código de cada um. */
const MOTIVOS_ANTIGOS: Record<string, "sem-conversa" | "evento-colado"> = {
  "ensaio, sem conversa para responder": "sem-conversa",
  "ensaio, evento de link colado: nada é publicado": "evento-colado",
};

/** Por que o passo virou ensaio. O texto de run antigo vira o código; outro texto livre passa como veio. */
export function rotuloDoMotivoDoEnsaio(t: TFunction, motivo: string): string {
  const codigo = MOTIVOS_ANTIGOS[motivo] ?? motivo;
  return codigo === "sem-conversa" || codigo === "evento-colado" ? t(`runs.dryRun.reason.${codigo}`) : motivo;
}

/** "usa {{event.repo}}" ou "tem a ação teams.post", na língua da janela. */
export function rotuloDoMotivoDeEvento(t: TFunction, motivo: MotivoDeEvento): string {
  return motivo.codigo === "marcador"
    ? t("automations.runWith.reason.marker", { marcador: motivo.marcador })
    : t("automations.runWith.reason.action", { acao: motivo.acao });
}

const PROVEDORES_CONHECIDOS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
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
  // O apelido de família, que o Claude Code resolve para a versão mais nova.
  const apelido = /^(opus|sonnet|haiku)$/.exec(modelo);
  const nome = partes
    ? `Claude ${maiuscula(partes[1]!)} ${partes[2]!.replace("-", ".")}`
    : apelido
      ? `Claude ${maiuscula(apelido[1]!)}`
      : modelo;
  if (provedor === null) return nome;
  return `${nome} · ${rotuloDoProvedor(provedor)}`;
}

function maiuscula(texto: string): string {
  return `${texto[0]!.toUpperCase()}${texto.slice(1)}`;
}

/** O nome do provedor com a grafia da marca, quando conhecida. */
export function rotuloDoProvedor(nome: string): string {
  return PROVEDORES_CONHECIDOS[nome] ?? nome;
}
