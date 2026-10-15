export type GrupoDaPaleta = "actions" | "go" | "connections" | "agents" | "automations" | "initiatives" | "prompts";

export const ORDEM_DOS_GRUPOS: readonly GrupoDaPaleta[] = ["actions", "go", "connections", "agents", "automations", "initiatives", "prompts"];

/** Minúsculas e sem acento: "automacao" acha "Automações". */
export function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

interface ParaFiltrar {
  grupo: GrupoDaPaleta;
  rotulo: string;
  palavras?: string;
}

/** Filtra pelo termo e agrupa na ordem dos grupos; dentro de cada grupo, a ordem da lista. */
export function filtrarComandos<T extends ParaFiltrar>(comandos: readonly T[], consulta: string): T[] {
  const termo = normalizar(consulta.trim());
  const achados = termo === "" ? [...comandos] : comandos.filter((c) => normalizar(`${c.rotulo} ${c.palavras ?? ""}`).includes(termo));
  return achados.sort((a, b) => ORDEM_DOS_GRUPOS.indexOf(a.grupo) - ORDEM_DOS_GRUPOS.indexOf(b.grupo));
}
