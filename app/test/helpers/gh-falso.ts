import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Um `gh` de mentira num diretório só dele. Os valores que ele "emite como
 * token" são óbvios e sem formato de token real.
 */
export interface GhFalso {
  dir: string;
  /** Cada chamada de `auth token`, uma linha: `host user configDir`. */
  chamadas(): string[];
}

const SCRIPT = `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ "$FAKE_GH_MODE" = "json" ]; then
    cat "$FAKE_GH_DIR/status.json"
    exit 0
  fi
  if [ "$3" = "--json" ]; then
    echo "unknown flag: --json" >&2
    exit 1
  fi
  cat "$FAKE_GH_DIR/status.txt"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then
  shift 2
  host=""; user=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --hostname) host="$2"; shift 2 ;;
      --user) user="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [ -n "$user" ] && [ "$FAKE_GH_ANTIGO" = "1" ]; then
    echo "unknown flag: --user" >&2
    exit 1
  fi
  if [ -z "$user" ]; then user="$FAKE_GH_ATIVO"; fi
  echo "$host $user $GH_CONFIG_DIR" >> "$FAKE_GH_DIR/chamadas.log"
  if [ "$user" = "deslogado" ]; then
    echo "no oauth token found for $user: valor-secreto-que-nao-pode-vazar" >&2
    exit 1
  fi
  echo "valor-falso-de-$user"
  exit 0
fi
exit 2
`;

export function criarGhFalso(opcoes: { json?: string; texto?: string; modo?: "json" | "texto" } = {}): GhFalso {
  const dir = mkdtempSync(join(tmpdir(), "locum-gh-falso-"));
  writeFileSync(join(dir, "gh"), SCRIPT);
  chmodSync(join(dir, "gh"), 0o755);
  writeFileSync(join(dir, "status.json"), opcoes.json ?? "{}");
  writeFileSync(join(dir, "status.txt"), opcoes.texto ?? "");
  process.env["FAKE_GH_DIR"] = dir;
  process.env["FAKE_GH_MODE"] = opcoes.modo ?? "json";
  return {
    dir,
    chamadas: () => {
      const arq = join(dir, "chamadas.log");
      return existsSync(arq) ? readFileSync(arq, "utf8").split("\n").filter(Boolean) : [];
    },
  };
}
