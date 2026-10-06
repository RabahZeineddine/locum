import { mcpService, type McpService } from "./mcp-service.js";
import { CREDENTIAL_PLACEHOLDER } from "./secret-service.js";

/**
 * Instâncias do Grafana, cada uma um servidor MCP próprio.
 *
 * O Grafana não tem servidor MCP remoto com OAuth: o oficial (`mcp/grafana`)
 * roda local, recebe o endereço da instância e um token de service account.
 * Por isso cada instância (dev, prod, a de outro time) vira um cadastro com
 * nome próprio, `grafana-<nome>`, e o agent escolhe por qual pergunta. O token
 * vai para o cofre em `mcp/<nome>`, como todo token colado.
 *
 * Roda pelo Docker, que é como o Grafana distribui o servidor para Mac sem
 * pedir toolchain de Go.
 */

export const IMAGEM_DO_GRAFANA = "mcp/grafana";

export interface InstanciaDoGrafana {
  name: string;
  url: string;
  enabled: boolean;
  /** Há token no cofre para ela. */
  hasToken: boolean;
}

export class GrafanaService {
  constructor(private readonly mcp: Pick<McpService, "list" | "register" | "setCredential" | "remove"> = mcpService) {}

  async list(): Promise<InstanciaDoGrafana[]> {
    return (await this.mcp.list())
      .filter((s) => s.config.transport === "stdio" && (s.config.command ?? []).includes(IMAGEM_DO_GRAFANA))
      .map((s) => ({
        name: s.config.name,
        url: s.config.env?.GRAFANA_URL ?? "",
        enabled: s.enabled,
        hasToken: s.credentialRef !== null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Cadastra ou atualiza a instância. Sem token, mantém o que já está no cofre. */
  async save(entrada: { nome: string; url: string; token: string }): Promise<InstanciaDoGrafana[]> {
    const nome = nomeDaInstancia(entrada.nome);
    const url = entrada.url.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s/]+/.test(url)) throw new Error(`"${entrada.url}" não é endereço de Grafana (https://...)`);
    const existente = (await this.list()).find((i) => i.name === nome);
    if (existente === undefined && entrada.token.trim() === "") {
      throw new Error("informe o token de service account da instância");
    }

    await this.mcp.register({
      name: nome,
      transport: "stdio",
      command: ["docker", "run", "--rm", "-i", "-e", "GRAFANA_URL", "-e", "GRAFANA_SERVICE_ACCOUNT_TOKEN", IMAGEM_DO_GRAFANA, "-t", "stdio"],
      env: { GRAFANA_URL: url, ...(existente?.hasToken ? { GRAFANA_SERVICE_ACCOUNT_TOKEN: CREDENTIAL_PLACEHOLDER } : {}) },
      scope: "write",
    });
    if (entrada.token.trim() !== "") {
      await this.mcp.setCredential(nome, { campo: "GRAFANA_SERVICE_ACCOUNT_TOKEN", valor: entrada.token });
    }
    return this.list();
  }

  async remove(nome: string): Promise<InstanciaDoGrafana[]> {
    if (!(await this.list()).some((i) => i.name === nome)) throw new Error(`"${nome}" não é instância do Grafana`);
    await this.mcp.remove(nome);
    return this.list();
  }
}

/** `dev` vira `grafana-dev`; `grafana` e `grafana-prod` ficam como estão. */
export function nomeDaInstancia(bruto: string): string {
  const limpo = bruto
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (limpo === "") throw new Error("dê um nome à instância, como dev ou prod");
  return limpo === "grafana" || limpo.startsWith("grafana-") ? limpo : `grafana-${limpo}`;
}

export const grafanaService = new GrafanaService();
