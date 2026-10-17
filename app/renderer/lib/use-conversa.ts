import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { aplicarEvento, type Cartao, type ConexaoSemServidor, type DoRunNaConversa, type EstadoDaConversa, type EventoDaConversa, type MarcaDaConversa, type FalaDoAgent } from "../../src/agent-chat/tipos";
import type { ChatPorChave } from "./agent-chat";
import { precisaRelerEstado } from "./releitura-da-conversa";
import { traduzirErroDoServico } from "./erro-do-servico";

/** De quanto em quanto tempo a tela relê a conversa que o outro processo grava. */
const RELEITURA_MS = 3_000;

/**
 * A conversa de um agent ou de um run na tela, pela chave dela.
 *
 * O estado mora no processo principal: a tela pede o retrato ao montar e depois
 * só escuta o fluxo, descartando o que o retrato já contém. Trocar de tela no
 * meio de uma resposta, ou com um cartão à espera, volta onde estava. As duas
 * conversas usam este hook; o que é só de uma (cartão, alvo) vem no retrato.
 */
export function useConversa(api: ChatPorChave & { decidir?: (id: string, cartao: string, decisao: "executar" | "recusar") => Promise<void> }, id: string) {
  const { t } = useTranslation();
  const [falas, setFalas] = useState<FalaDoAgent[]>([]);
  const [respondendo, setRespondendo] = useState(false);
  // Outro processo do Locum (o Claude Code, pelo --mcp) está com a conversa.
  const [outro, setOutro] = useState(false);
  const [resumido, setResumido] = useState(false);
  const [semServidor, setSemServidor] = useState<ConexaoSemServidor[]>([]);
  const [semSkill, setSemSkill] = useState<string[]>([]);
  const [contaIgnorada, setContaIgnorada] = useState(0);
  const [run, setRun] = useState<DoRunNaConversa | undefined>(undefined);
  const [carregado, setCarregado] = useState(false);
  const [falha, setFalha] = useState<string | null>(null);

  const chave = api.chave(id);
  const mostrarFalha = (erro: unknown): void => setFalha(traduzirErroDoServico(t, erro instanceof Error ? erro.message : String(erro)));

  /** O que muda de uma releitura para outra; o resto só vale no primeiro retrato. */
  const aplicarRetrato = (estado: EstadoDaConversa): void => {
    setFalas(estado.falas);
    setRespondendo(estado.respondendo);
    setOutro(estado.outroProcesso);
    setRun(estado.run);
  };

  useEffect(() => {
    let vivo = true;
    let seq: number | null = null;
    const guardados: EventoDaConversa[] = [];
    const aplicar = (evento: EventoDaConversa): void => {
      if (evento.tipo === "resumido") setResumido(true);
      if (evento.tipo === "fim") setRespondendo(false);
      setFalas((atual) => {
        const ultima = atual.at(-1);
        if (ultima?.de !== "assistant") return atual;
        return [...atual.slice(0, -1), aplicarEvento(ultima, evento)];
      });
    };
    setCarregado(false);
    setFalas([]);
    setRun(undefined);
    setFalha(null);
    const parar = api.assinar((evento) => {
      if (evento.chave !== chave) return;
      // Antes do retrato chegar, guarda; depois, só vale o que veio depois dele.
      if (seq === null) guardados.push(evento);
      else if (evento.seq > seq) aplicar(evento);
    });
    api.estado(id).then(
      (estado) => {
        if (!vivo) return;
        seq = estado.seq;
        aplicarRetrato(estado);
        setResumido(estado.resumido);
        setSemServidor(estado.semServidor);
        setSemSkill(estado.semSkill);
        setContaIgnorada(estado.contaIgnorada);
        setCarregado(true);
        for (const evento of guardados) if (evento.seq > estado.seq) aplicar(evento);
      },
      (erro: unknown) => {
        if (vivo) mostrarFalha(erro);
      },
    );
    return () => {
      vivo = false;
      parar();
    };
  }, [id, chave]);

  const aguardando = falas.some((f) => f.cartoes.some((c) => c.estado === "pendente"));

  // O servidor MCP (outro processo) grava na mesma conversa: relê ao voltar para a janela e, com
  // o chat aberto, a cada poucos segundos. Com o outro processo na vez ele continua lendo, para
  // a tela voltar ao normal sozinha quando ele decide ou morre; só a volta daqui a dispensa.
  useEffect(() => {
    let vivo = true;
    let anterior: MarcaDaConversa | null = null;
    const ler = (): void => {
      api.estado(id).then(
        (estado) => {
          if (vivo) aplicarRetrato(estado);
        },
        () => undefined,
      );
    };
    // O tique consulta só a marca leve e pede o estado inteiro quando ela anda.
    const tique = (): void => {
      if (!outro && (respondendo || aguardando)) return;
      api.marca(id).then(
        (marca) => {
          if (!vivo) return;
          const pede = precisaRelerEstado({ marca, anterior, outroProcesso: outro });
          anterior = marca;
          if (pede) ler();
        },
        () => undefined,
      );
    };
    // Voltar para a janela sempre relê: a marca não cobre tudo o que pode ter mudado fora.
    const aoFocar = (): void => {
      if (!outro && (respondendo || aguardando)) return;
      anterior = null;
      ler();
    };
    window.addEventListener("focus", aoFocar);
    const timer = setInterval(tique, RELEITURA_MS);
    return () => {
      vivo = false;
      window.removeEventListener("focus", aoFocar);
      clearInterval(timer);
    };
  }, [id, respondendo, aguardando, outro]);

  /** Relê o retrato agora (depois de trocar o alvo, por exemplo). */
  async function recarregar(): Promise<void> {
    aplicarRetrato(await api.estado(id));
  }

  /** Verdadeiro quando a fala saiu; falso quando o serviço a recusou antes de a volta começar (a tela devolve o texto ao campo). */
  async function enviar(texto: string): Promise<boolean> {
    setRespondendo(true);
    setFalha(null);
    setFalas((a) => [...a, { de: "user", texto, ferramentas: [], cartoes: [] }, { de: "assistant", texto: "", ferramentas: [], cartoes: [] }]);
    try {
      await api.enviar(id, texto);
      return true;
    } catch (erro) {
      // Recusada antes de a volta começar (o outro processo está com a conversa): a fala não existiu.
      setFalas((a) => a.slice(0, -2));
      setRespondendo(false);
      mostrarFalha(erro);
      return false;
    }
  }

  async function tomar(): Promise<void> {
    setFalha(null);
    try {
      await api.tomar(id);
      await recarregar();
    } catch (erro) {
      mostrarFalha(erro);
    }
  }

  async function decidir(cartao: Cartao, decisao: "executar" | "recusar"): Promise<void> {
    setFalha(null);
    try {
      await api.decidir?.(id, cartao.id, decisao);
    } catch (erro) {
      mostrarFalha(erro);
    }
  }

  async function recomecar(): Promise<void> {
    setFalha(null);
    try {
      await api.limpar(id);
      setFalas([]);
      setResumido(false);
      setRespondendo(false);
      await recarregar();
    } catch (erro) {
      mostrarFalha(erro);
    }
  }

  function cancelar(): void {
    api.cancelar(id).catch(mostrarFalha);
  }

  return { chave: id, falas, respondendo, outro, resumido, semServidor, semSkill, contaIgnorada, run, carregado, falha, aguardando, enviar, tomar, decidir, recomecar, cancelar, recarregar, mostrarFalha, limparFalha: () => setFalha(null) };
}

export type Conversa = ReturnType<typeof useConversa>;
