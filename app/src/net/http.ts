/**
 * O cliente HTTP de todo o processo principal.
 *
 * Tem a cara do `fetch` para entrar onde um `fetch` já era injetado, e por
 * cima dele faz três coisas que cada chamador fazia do seu jeito, ou não fazia:
 *
 * - prazo até a resposta chegar, para uma rede parada não segurar a chamada;
 * - nova tentativa quando a rede cai no meio (Wi-Fi que troca, VPN que sobe,
 *   DNS que pisca) e quando o servidor pede para esperar (429, 502, 503, 504);
 * - erro com tipo, para quem mostra a falha separar "sem conexão" de "o
 *   servidor recusou" sem ler a mensagem crua do Chromium ou do undici.
 *
 * Só repete o que pode ser repetido. GET e HEAD sempre; POST só quando quem
 * cria o cliente diz que aquele POST é uma leitura. Mandar a mesma mensagem
 * duas vezes num chat é pior do que uma falha.
 */

export type TipoDeFalha = "offline" | "timeout" | "rede";

/** Falha antes de qualquer resposta do servidor. */
export class ErroDeRede extends Error {
  readonly tipo: TipoDeFalha;
  /** O código cru, como `net::ERR_NETWORK_CHANGED` ou `ECONNRESET`. */
  readonly codigo: string | null;

  constructor(tipo: TipoDeFalha, destino: string, codigo: string | null, options?: { cause?: unknown }) {
    const sufixo = codigo === null ? "" : ` (${codigo})`;
    const frase =
      tipo === "offline"
        ? `sem conexao com ${destino}${sufixo}`
        : tipo === "timeout"
          ? `${destino} nao respondeu a tempo${sufixo}`
          : `a conexao com ${destino} caiu${sufixo}`;
    super(frase, options);
    this.name = "ErroDeRede";
    this.tipo = tipo;
    this.codigo = codigo;
  }
}

/** O tipo da falha de rede, para quem recebeu um erro qualquer. */
export function tipoDaFalha(erro: unknown): TipoDeFalha | null {
  return erro instanceof ErroDeRede ? erro.tipo : null;
}

export interface OpcoesDoCliente {
  /** O `fetch` de baixo. Procurado na hora da chamada, para a espia do smoke e os testes enxergarem. */
  base?: () => typeof fetch;
  /** Prazo até os cabeçalhos da resposta chegarem. O corpo não conta: um download grande passaria dele. */
  prazoMs?: number;
  /** Quantas vezes ao todo, contando a primeira. */
  tentativas?: number;
  /** POST que só lê, como a busca do Slack, pode ser repetido. */
  repetirPost?: boolean;
  /** Trocável nos testes, para não dormir de verdade. */
  esperar?: (ms: number) => Promise<void>;
}

const PRAZO_MS = 30_000;
const TENTATIVAS = 3;
/** Espera da segunda tentativa; cada uma seguinte triplica. */
const ESPERA_BASE_MS = 500;
/** Um `Retry-After` maior que isso vira falha: segurar a chamada por minutos é pior. */
const ESPERA_MAXIMA_MS = 30_000;
const STATUS_PARA_REPETIR = new Set([408, 429, 502, 503, 504]);

/** Sem rede nenhuma, ou a rede trocou no meio. */
const OFFLINE = new Set([
  "ERR_INTERNET_DISCONNECTED",
  "ERR_NETWORK_CHANGED",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_NAME_RESOLUTION_FAILED",
  "ERR_ADDRESS_UNREACHABLE",
  "ERR_NETWORK_IO_SUSPENDED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
]);

/** A conexão existia e caiu, ou nem chegou a fechar o aperto de mão. */
const QUEDA = new Set([
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_ABORTED",
  "ERR_CONNECTION_REFUSED",
  "ERR_EMPTY_RESPONSE",
  "ERR_SSL_PROTOCOL_ERROR",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

const ESTOURO = new Set(["ERR_TIMED_OUT", "ERR_CONNECTION_TIMED_OUT", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);

/**
 * O código de rede dentro do erro, onde quer que ele esteja: o `net.fetch` do
 * Electron põe `net::ERR_...` na mensagem, o `fetch` do Node põe `code` na
 * `cause` de um `TypeError("fetch failed")`.
 */
function codigoDe(erro: unknown): string | null {
  let atual: unknown = erro;
  for (let nivel = 0; nivel < 4 && atual !== null && typeof atual === "object"; nivel++) {
    const { code, message, cause } = atual as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof code === "string" && code !== "") return code;
    if (typeof message === "string") {
      const achado = /net::(ERR_[A-Z_]+)/.exec(message);
      if (achado?.[1]) return achado[1];
    }
    atual = cause;
  }
  return null;
}

function classificar(codigo: string | null): TipoDeFalha | null {
  if (codigo === null) return null;
  const nome = codigo.replace(/^net::/, "");
  if (OFFLINE.has(nome)) return "offline";
  if (QUEDA.has(nome)) return "rede";
  if (ESTOURO.has(nome)) return "timeout";
  return null;
}

function destinoDe(entrada: Parameters<typeof fetch>[0]): string {
  const url = typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Segundos ou data HTTP; o que não der para ler fica com a espera padrão. */
function retryAfterMs(resposta: Response): number | null {
  const valor = resposta.headers.get("retry-after");
  if (valor === null) return null;
  const segundos = Number(valor);
  if (Number.isFinite(segundos)) return Math.max(0, segundos * 1000);
  const data = Date.parse(valor);
  return Number.isNaN(data) ? null : Math.max(0, data - Date.now());
}

const dormir = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Monta um `fetch` com prazo, nova tentativa e erro classificado. */
export function criarClienteHttp(opcoes: OpcoesDoCliente = {}): typeof fetch {
  const base = opcoes.base ?? (() => globalThis.fetch);
  const prazoMs = opcoes.prazoMs ?? PRAZO_MS;
  const tentativas = Math.max(1, opcoes.tentativas ?? TENTATIVAS);
  const esperar = opcoes.esperar ?? dormir;

  const cliente = async (entrada: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const metodo = (init?.method ?? (entrada instanceof Request ? entrada.method : "GET")).toUpperCase();
    const repetivel = metodo === "GET" || metodo === "HEAD" || (metodo === "POST" && opcoes.repetirPost === true);
    // Um corpo de stream só pode ser lido uma vez, e a segunda tentativa
    // mandaria vazio. String, URLSearchParams e afins se leem de novo.
    const corpoRelido = !(init?.body instanceof ReadableStream);
    const destino = destinoDe(entrada);
    const doChamador = init?.signal ?? undefined;

    for (let tentativa = 1; ; tentativa++) {
      const ultima = tentativa >= tentativas || !repetivel || !corpoRelido;
      const controle = new AbortController();
      const estouro = setTimeout(() => controle.abort(new ErroDeRede("timeout", destino, null)), prazoMs);
      const repassar = () => controle.abort(doChamador?.reason);
      doChamador?.addEventListener("abort", repassar, { once: true });
      if (doChamador?.aborted) repassar();

      try {
        const resposta = await base()(entrada, { ...init, signal: controle.signal });
        if (ultima || !STATUS_PARA_REPETIR.has(resposta.status)) return resposta;

        const pedida = retryAfterMs(resposta);
        if (pedida !== null && pedida > ESPERA_MAXIMA_MS) return resposta;
        doChamador?.removeEventListener("abort", repassar);
        await resposta.body?.cancel().catch(() => undefined);
        await esperar(pedida ?? ESPERA_BASE_MS * 3 ** (tentativa - 1));
      } catch (erro) {
        doChamador?.removeEventListener("abort", repassar);
        // Quem chamou desistiu: nada a repetir nem a traduzir.
        if (doChamador?.aborted) throw erro;
        const falha =
          controle.signal.aborted && controle.signal.reason instanceof ErroDeRede
            ? controle.signal.reason
            : (() => {
                const codigo = codigoDe(erro);
                const tipo = classificar(codigo);
                return tipo === null ? null : new ErroDeRede(tipo, destino, codigo, { cause: erro });
              })();
        // Erro que não é de rede (endereço inválido, corpo recusado) sobe como veio.
        if (falha === null) throw erro;
        if (ultima) throw falha;
        await esperar(ESPERA_BASE_MS * 3 ** (tentativa - 1));
      } finally {
        // O sinal do chamador continua ligado depois da resposta: o prazo dele
        // pode cobrir também a leitura do corpo, e o nosso não cobre.
        clearTimeout(estouro);
      }
    }
  };
  return cliente as typeof fetch;
}

/** O cliente padrão: GET e HEAD repetem, POST não. */
export const clienteHttp = criarClienteHttp();

/** Para POST que só lê, como as buscas na API do Slack. */
export const clienteHttpDeLeitura = criarClienteHttp({ repetirPost: true });
