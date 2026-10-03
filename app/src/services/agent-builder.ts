import { z } from "zod";
import { AgentSpec, topoSort, type Step } from "../config/types.js";
import { parseJson } from "../runtimes/native.js";
import { ID_DE_AGENT, isReserved } from "./agent-service.js";
import { SUBSCRIPTION_RUNTIMES } from "../runtimes/types.js";

/**
 * Rascunho de agent a partir de uma descrição em texto.
 *
 * O modelo vê só o catálogo desta máquina: provedores com credencial, os
 * modelos de cada um, os servidores MCP com as ferramentas, os destinos de
 * tarefa e os agents de exemplo. Nada de diff, mensagem ou log, que é conteúdo
 * de terceiro. É isso que deixa este caminho fora da regra que proíbe o
 * assistente de escrever configuração (ADR 0003, emenda 5): a única entrada que
 * não é catálogo é o texto de quem clicou.
 *
 * O resultado não é gravado aqui. Ele volta para a tela, a pessoa olha, e só o
 * clique dela salva. E salva como agent, não como pessoa, para que o
 * rebaixamento de modo valha: passo de ação nasce em `approve` por mais que o
 * modelo tenha escrito outra coisa.
 */

/** Quem escreve o rascunho. Recebe sistema e pedido, devolve o texto cru. */
export interface Gerador {
  /** `provedor/modelo`, para a tela dizer quem escreveu. */
  readonly modelo: string;
  gerar(sistema: string, pedido: string): Promise<string>;
}

export interface CatalogoDoCriador {
  modelos: { provedor: string; modelos: string[] }[];
  servidores: { nome: string; ferramentas: { nome: string; descricao: string }[] }[];
  trackers: { id: string; rotulo: string }[];
  exemplos: AgentSpec[];
}

export interface RascunhoDeAgent {
  spec: AgentSpec;
  modelo: string;
  tentativas: number;
}

/**
 * Ações que o criador pode usar. `context.update` fica de fora: é a ação
 * interna da curadoria de contexto, e agent comum que a usasse escreveria na
 * pasta de uma iniciativa.
 */
export const ACOES_DO_CRIADOR = [
  "github.review_comment",
  "tracker.create_issue",
  "digest.deliver",
  "slack.post",
  "teams.post",
] as const;

const TENTATIVAS = 3;

/**
 * Confere o que o modelo devolveu contra o catálogo.
 *
 * O zod garante a forma; isto garante que o agent roda aqui. Modelo inventado,
 * servidor que não existe e passo que depende de chave errada passam no schema
 * e só quebrariam na primeira execução, longe de quem pediu. Os problemas
 * voltam em texto, porque viram a próxima instrução para o modelo.
 *
 * O que dá para consertar sem perguntar, conserta: modo da ação vai para
 * `approve` e identificador repetido ganha sufixo.
 */
export function validarRascunho(
  bruto: unknown,
  catalogo: CatalogoDoCriador,
  existentes: ReadonlySet<string>,
): { spec?: AgentSpec; problemas: string[] } {
  const lido = AgentSpec.safeParse(bruto);
  if (!lido.success) {
    return {
      problemas: lido.error.issues.map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`),
    };
  }

  const problemas: string[] = [];
  const spec = lido.data;

  if (!ID_DE_AGENT.test(spec.id)) {
    problemas.push(`id "${spec.id}": use minúsculas, números e hífen, de 2 a 63 caracteres`);
  }
  if (spec.name.trim().length === 0) problemas.push("name: o agent precisa de nome");

  const chaves = new Set(spec.steps.map((s) => s.key));
  if (chaves.size !== spec.steps.length) problemas.push("steps: há chaves de passo repetidas");

  const modelos = new Map(catalogo.modelos.map((m) => [m.provedor, new Set(m.modelos)]));
  const servidores = new Map(catalogo.servidores.map((s) => [s.nome, new Set(s.ferramentas.map((f) => f.nome))]));
  const trackers = new Set(catalogo.trackers.map((t) => t.id));

  for (const passo of spec.steps) {
    const onde = `passo "${passo.key}"`;
    for (const dep of passo.needs) {
      if (!chaves.has(dep)) problemas.push(`${onde}: needs aponta para "${dep}", que não existe`);
    }

    if (passo.type === "model") {
      const corte = passo.model.indexOf("/");
      const provedor = corte > 0 ? passo.model.slice(0, corte) : "";
      const nome = passo.model.slice(corte + 1);
      const doProvedor = modelos.get(provedor);
      if (doProvedor === undefined) {
        problemas.push(`${onde}: o provedor de "${passo.model}" não está disponível nesta máquina`);
      } else if (!SUBSCRIPTION_RUNTIMES.has(provedor) && doProvedor.size > 0 && !doProvedor.has(nome)) {
        problemas.push(`${onde}: "${nome}" não está no catálogo de ${provedor}`);
      }
      for (const ref of passo.tools ?? spec.defaultTools) {
        const ferramentas = servidores.get(ref.server);
        if (ferramentas === undefined) problemas.push(`${onde}: servidor "${ref.server}" não está cadastrado`);
        else if (!ferramentas.has(ref.tool)) problemas.push(`${onde}: "${ref.server}" não tem a ferramenta "${ref.tool}"`);
      }
      for (const nomeDoServidor of passo.requiresServers) {
        if (!servidores.has(nomeDoServidor)) problemas.push(`${onde}: servidor "${nomeDoServidor}" não está cadastrado`);
      }
      continue;
    }
    if (passo.type === "logic") continue;

    if (!(ACOES_DO_CRIADOR as readonly string[]).includes(passo.action)) {
      problemas.push(`${onde}: a ação "${passo.action}" não existe; use uma de ${ACOES_DO_CRIADOR.join(", ")}`);
    }
    if (passo.input !== undefined && !chaves.has(passo.input)) {
      problemas.push(`${onde}: input aponta para "${passo.input}", que não existe`);
    }
    if (passo.action === "tracker.create_issue" && (passo.target === undefined || !trackers.has(passo.target))) {
      problemas.push(
        trackers.size === 0
          ? `${onde}: não há destino de tarefa cadastrado; tire este passo`
          : `${onde}: target precisa ser um destes trackers: ${[...trackers].join(", ")}`,
      );
    }
  }

  try {
    topoSort(spec.steps);
  } catch (err) {
    problemas.push(err instanceof Error ? err.message : String(err));
  }

  if (problemas.length > 0) return { problemas };

  const steps = spec.steps.map((passo): Step =>
    passo.type === "action" ? { ...passo, mode: "approve" } : passo,
  );
  return { spec: { ...spec, id: idLivre(spec.id, existentes), steps }, problemas: [] };
}

function idLivre(base: string, existentes: ReadonlySet<string>): string {
  if (!existentes.has(base) && !isReserved(base)) return base;
  for (let n = 2; ; n++) {
    const candidato = `${base.slice(0, 60)}-${n}`;
    if (!existentes.has(candidato)) return candidato;
  }
}

/**
 * As instruções do modelo. Os exemplos vão inteiros porque são o contrato de
 * verdade: o formato que cada ação espera na saída do passo anterior está neles,
 * e descrever isso em prosa seria uma segunda fonte que envelhece separada.
 */
export function sistemaDoCriador(catalogo: CatalogoDoCriador, idioma: string): string {
  const modelos = catalogo.modelos
    .map((m) => `- ${m.provedor}: ${m.modelos.length > 0 ? m.modelos.map((x) => `${m.provedor}/${x}`).join(", ") : "(sem catálogo)"}`)
    .join("\n");
  const servidores =
    catalogo.servidores.length === 0
      ? "(nenhum)"
      : catalogo.servidores
          .map((s) => `- ${s.nome}:\n${s.ferramentas.map((f) => `  - ${f.nome}: ${f.descricao.slice(0, 160)}`).join("\n")}`)
          .join("\n");
  const trackers =
    catalogo.trackers.length === 0 ? "(nenhum)" : catalogo.trackers.map((t) => `- ${t.id}: ${t.rotulo}`).join("\n");
  const exemplos = catalogo.exemplos.map((e) => JSON.stringify(e)).join("\n\n");

  return `Você monta agents do Locum, um app que roda agents de IA localmente. Recebe a descrição de um agent e devolve o AgentSpec dele.

Responda apenas com um objeto JSON, sem cerca de código e sem texto em volta.

Forma do AgentSpec:
- id: minúsculas, números e hífen.
- name: nome curto.
- defaultTools: ferramentas herdadas pelos passos de modelo, [{ "server", "tool", "class" }]. class é read, internal_write ou external_write.
- skills: [] salvo pedido explícito.
- budget: { "perRunUsd", "perDayUsd" } com valores modestos.
- steps: passos em grafo, ligados por needs. Dois tipos:
  - model: { "type": "model", "key", "name", "needs", "model": "provedor/modelo", "prompt", "maxSteps", "requiresServers", "tools"?, "outputSchema"? }
  - action: { "type": "action", "key", "name", "needs", "action", "mode": "approve", "input": chave do passo cuja saída a ação publica, "target"? }

No prompt, use {{event.campo}} para o evento que acordou o agent e {{steps.chave}} ou {{steps.chave.campo}} para a saída de um passo anterior. Os campos de evento que existem são os que aparecem nos exemplos: pull request do GitHub (repo, title, description, diff, omittedSummary, ci.summary), mensagem do Slack (author, channel, text, threadTs), mensagem do Teams (author, text, e channel quando a menção veio de canal de equipe) e digest do Slack (channels).

Passo de modelo cuja saída alimenta uma ação precisa de outputSchema no formato que a ação espera, igual ao do exemplo que usa a mesma ação. Toda ação usa mode "approve": nada sai sem a pessoa aprovar na fila.

Use só o que existe nesta máquina.

Modelos disponíveis:
${modelos}

Servidores MCP e ferramentas:
${servidores}

Destinos de tarefa (target de tracker.create_issue):
${trackers}

Ações: ${ACOES_DO_CRIADOR.join(", ")}

Prefira modelo menor para triagem e redação curta, e o maior só para o passo que exige julgamento. Não invente ferramenta, servidor, modelo ou campo de evento.

${idioma}

Exemplos de agents que funcionam:

${exemplos}`;
}

export class AgentBuilder {
  constructor(
    private readonly deps: {
      gerador: () => Promise<Gerador | null>;
      catalogo: () => Promise<CatalogoDoCriador>;
      existentes: () => Promise<string[]>;
      idioma: () => string;
    },
  ) {}

  async criar(descricao: string): Promise<RascunhoDeAgent> {
    const pedido = z.string().trim().min(10, "descreva o agent em pelo menos uma frase").parse(descricao);
    const gerador = await this.deps.gerador();
    if (gerador === null) throw new Error("nenhum modelo disponível para montar o agent");

    const [catalogo, existentes] = await Promise.all([this.deps.catalogo(), this.deps.existentes()]);
    const sistema = sistemaDoCriador(catalogo, this.deps.idioma());
    const ocupados = new Set(existentes);

    let conversa = `Descrição do agent:\n${pedido}`;
    let ultimos: string[] = [];
    for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
      const texto = await gerador.gerar(sistema, conversa);
      let bruto: unknown;
      try {
        bruto = parseJson(texto);
      } catch (err) {
        ultimos = [err instanceof Error ? err.message : String(err)];
      }
      if (bruto !== undefined) {
        const { spec, problemas } = validarRascunho(bruto, catalogo, ocupados);
        if (spec !== undefined) return { spec, modelo: gerador.modelo, tentativas: tentativa };
        ultimos = problemas;
      }
      // A volta seguinte leva o que saiu e o que estava errado, porque o
      // gerador da assinatura não guarda conversa entre chamadas.
      conversa = `Descrição do agent:\n${pedido}\n\nSua resposta anterior:\n${texto.slice(0, 12_000)}\n\nEla não passou na validação:\n${ultimos.map((p) => `- ${p}`).join("\n")}\n\nDevolva o AgentSpec inteiro, corrigido.`;
    }
    throw new Error(`o rascunho não passou na validação: ${ultimos.slice(0, 5).join("; ")}`);
  }
}
