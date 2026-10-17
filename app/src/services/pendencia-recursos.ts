import type { Pendencia } from "../config/pendencia.js";
import { discoverSkills } from "../skills/loader.js";

/**
 * Se o recurso que uma pendência de resolução `existe` nomeia existe nesta máquina.
 * O tipo do recurso é o primeiro trecho do campo (`skills.<nome>`); tipo que não se
 * conhece não resolve sozinho, e a pessoa dispensa.
 */
export function recursoExiste(p: Pendencia): boolean {
  const [tipo, ...resto] = p.campo.split(".");
  if (tipo === "skills") return discoverSkills(undefined, undefined, undefined, { projeto: false }).has(resto.join("."));
  return false;
}
