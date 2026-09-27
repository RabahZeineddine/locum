import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Carregado antes de qualquer teste, e por isso antes de `src/db/index.ts`,
// que abre o banco na importação. Sem isto um teste que importasse um serviço
// sem passar banco próprio escreveria no banco de verdade do dono da máquina.
const pasta = mkdtempSync(join(tmpdir(), "locum-teste-"));
process.env.LOCUM_HOME = pasta;
process.env.LOCUM_INITIATIVES_DIR = join(pasta, "initiatives");
process.on("exit", () => rmSync(pasta, { recursive: true, force: true }));
