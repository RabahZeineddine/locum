import { saidasDosRuns } from "@/lib/automacao";
import { call, read, useRead } from "@/lib/bridge";
import type { FerramentaDaConexao } from "@/lib/paleta-conexoes";
import { useCallback, useEffect, useState } from "react";

export interface EstadoDaConexao {
  /** Nula enquanto a lista nunca foi lida deste servidor. */
  tools: FerramentaDaConexao[] | null;
  carregando: boolean;
  erro: string | null;
}

export interface FerramentasDasConexoes {
  /** Servidores MCP habilitados, na ordem do cadastro. */
  servidores: string[];
  porServidor: Readonly<Record<string, EstadoDaConexao>>;
  /** Lê de novo do servidor (sobe o processo) e guarda no cache. */
  carregar: (servidor: string) => Promise<void>;
}

const VAZIO: EstadoDaConexao = { tools: null, carregando: false, erro: null };

/**
 * As ferramentas de cada conexão ligada: a lista guardada na primeira leitura,
 * sem subir servidor, e a leitura nova só quando a pessoa pede.
 */
export function useFerramentasDasConexoes(): FerramentasDasConexoes {
  const lista = useRead("mcp.list");
  const servidores = (lista.data ?? []).filter((s) => s.enabled).map((s) => s.config.name);
  const chave = servidores.join("\n");
  const [porServidor, setPorServidor] = useState<Record<string, EstadoDaConexao>>({});

  const guardar = useCallback((servidor: string, estado: EstadoDaConexao): void => {
    setPorServidor((atual) => ({ ...atual, [servidor]: estado }));
  }, []);

  useEffect(() => {
    let vivo = true;
    for (const servidor of chave === "" ? [] : chave.split("\n")) {
      read("mcp.toolsCached", servidor).then(
        (guardada) => vivo && setPorServidor((atual) => (atual[servidor]?.carregando === true ? atual : { ...atual, [servidor]: { ...VAZIO, tools: guardada?.tools ?? null } })),
        () => vivo && guardar(servidor, VAZIO),
      );
    }
    return () => {
      vivo = false;
    };
  }, [chave, guardar]);

  const carregar = useCallback(
    async (servidor: string): Promise<void> => {
      setPorServidor((atual) => ({ ...atual, [servidor]: { ...(atual[servidor] ?? VAZIO), carregando: true, erro: null } }));
      try {
        const tools = await call("mcp.tools", servidor);
        guardar(servidor, { tools, carregando: false, erro: null });
      } catch (e) {
        setPorServidor((atual) => ({ ...atual, [servidor]: { ...(atual[servidor] ?? VAZIO), carregando: false, erro: e instanceof Error ? e.message : String(e) } }));
      }
    },
    [guardar],
  );

  return { servidores, porServidor, carregar };
}

/** `servidor/ferramenta` para o `inputSchema` guardado, o que `problemas()` pede. */
export function esquemasDasConexoes(porServidor: Readonly<Record<string, EstadoDaConexao>>): Record<string, unknown> {
  const esquemas: Record<string, unknown> = {};
  for (const [servidor, estado] of Object.entries(porServidor)) {
    for (const f of estado.tools ?? []) if (f.inputSchema !== undefined) esquemas[`${servidor}/${f.name}`] = f.inputSchema;
  }
  return esquemas;
}

/** `servidor/ferramenta` para o `outputSchema` guardado, que o seletor de referências usa. */
export function esquemasDeSaidaDasConexoes(porServidor: Readonly<Record<string, EstadoDaConexao>>): Record<string, unknown> {
  const esquemas: Record<string, unknown> = {};
  for (const [servidor, estado] of Object.entries(porServidor)) {
    for (const f of estado.tools ?? []) if (f.outputSchema !== undefined) esquemas[`${servidor}/${f.name}`] = f.outputSchema;
  }
  return esquemas;
}

/**
 * A saída de cada passo nos últimos runs da automação, para o seletor de
 * referências mostrar os campos que a pessoa pode clicar. Sem run, vazio.
 */
export function useSaidasDoUltimoRun(agentId: string): Record<string, unknown> {
  const [saidas, setSaidas] = useState<Record<string, unknown>>({});
  useEffect(() => {
    let vivo = true;
    (async () => {
      const runs = await read("runs.list", { agentId, limit: 3 });
      const detalhes = await Promise.all(runs.map((r) => read("runs.get", r.id)));
      if (vivo) setSaidas(saidasDosRuns(detalhes.filter((d) => d !== undefined)));
    })().catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [agentId]);
  return saidas;
}
