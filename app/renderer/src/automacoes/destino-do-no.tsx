import { call, useRead } from "@/lib/bridge";
import { conversaEscolhida, destinoDoNo, gatilhoTrazMensagem, paramsComDestino } from "@/lib/destino-da-conversa";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ACOES_DE_CONVERSA_REGISTRO,
  REGISTRO_DE_CONVERSA,
  destinosDaAcao,
  type DestinoDaAcao,
  type ListaDeConversas,
  type OpcaoDeConversa,
} from "../../../src/acao/destino";
import { Campo, CAMPO } from "./campos";
import { useListaEmCache } from "./combobox";

/** O valor do select para a conversa já gravada, que não é nenhum `ref`. */
const GRAVADA = "__gravada";

/**
 * O campo "Responder a" (ou "Reage em") dos nós de conversa. As opções vêm do
 * registro da ação (`ACOES_DE_CONVERSA_REGISTRO`), e a lista de conversas do
 * destino fixo vem do mesmo lugar que a do gatilho, uma por app.
 */
export function DestinoDoNo({
  acao,
  params,
  agentId,
  chave,
  gatilhos,
  aoMudar,
}: {
  acao: string;
  params: Record<string, unknown> | undefined;
  agentId: string;
  chave: string;
  /** Os `kind` dos gatilhos do fluxo, para avisar quando nenhum traz a mensagem do evento. */
  gatilhos: readonly string[];
  aoMudar: (params: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const registro = ACOES_DE_CONVERSA_REGISTRO[acao];
  if (registro === undefined) return null;
  const destino = destinoDoNo(acao, params);
  const reage = registro.efeito === "reagir";
  const opcoes = destinosDaAcao(acao);

  const trocar = (tipo: string): void => {
    if (tipo === "fixo") aoMudar(paramsComDestino(params, { tipo: "fixo", conversa: { app: registro.app, ref: "", rotulo: "" } } as DestinoDaAcao));
    else aoMudar(paramsComDestino(params, { tipo } as DestinoDaAcao));
  };

  return (
    <>
      <Campo
        ajuda={t(`automations.steps.destination.hint.${registro.efeito}.${destino.tipo}`)}
        rotulo={t(`automations.steps.destination.label.${registro.efeito}`)}
      >
        <select
          className={CAMPO}
          data-locum-destino=""
          disabled={opcoes.length < 2}
          onChange={(e) => trocar(e.target.value)}
          value={destino.tipo}
        >
          {opcoes.map((tipo) => (
            <option key={tipo} value={tipo}>
              {t(`automations.steps.destination.option.${registro.efeito}.${tipo}`, { app: REGISTRO_DE_CONVERSA.apps[registro.app]?.nome ?? registro.app })}
            </option>
          ))}
        </select>
      </Campo>
      {destino.tipo === "fixo" ? (
        <SeletorDeConversa
          agentId={agentId}
          app={registro.app}
          chave={chave}
          escolhida={destino.conversa}
          escolher={(o) =>
            aoMudar(paramsComDestino(params, { tipo: "fixo", conversa: conversaEscolhida(registro.app, o) } as DestinoDaAcao))
          }
        />
      ) : null}
      {destino.tipo === "evento" && !gatilhoTrazMensagem(acao, gatilhos) ? (
        <p className="text-xs text-amber-600 dark:text-amber-400" data-locum-destino-sem-mensagem="">
          {t(`automations.steps.destination.noMessage.${registro.efeito}`, { app: REGISTRO_DE_CONVERSA.apps[registro.app]?.nome ?? registro.app })}
        </p>
      ) : null}
    </>
  );
}

/**
 * O select de conversas, igual para todo app: cada lista que o registro declara
 * para o app vira um grupo de opções, pelo canal da ponte que ela nomeia.
 */
function SeletorDeConversa({
  app,
  agentId,
  chave,
  escolhida,
  escolher,
}: {
  app: string;
  agentId: string;
  chave: string;
  escolhida: { ref: string; rotulo?: string };
  escolher: (o: OpcaoDeConversa | null) => void;
}) {
  const { t } = useTranslation();
  const listas = REGISTRO_DE_CONVERSA.apps[app]?.listas ?? [];
  const conexao = useRead("connections.list").data?.find((c) => c.id === app);
  // Cada vez que a pessoa abre o campo, as listas ainda não lidas carregam.
  const [aberturas, setAberturas] = useState(0);
  const [estado, setEstado] = useState<Record<string, { lendo: boolean; erro: string | null }>>({});
  const lendo = Object.values(estado).some((e) => e.lendo);
  const erro = Object.values(estado).find((e) => e.erro !== null)?.erro ?? null;
  // A conversa já gravada fica à vista antes de a lista carregar. Ela tem valor próprio, para a mesma conversa da lista poder ser escolhida de novo (e gravar a conta).
  const gravada = escolhida.ref !== "";

  return (
    <Campo ajuda={lendo ? t("automations.steps.destination.loading") : undefined} rotulo={t("automations.steps.destination.conversation")}>
      <select
        className={CAMPO}
        data-locum-destino-conversa=""
        onChange={(e) => {
          const o = e.target.selectedOptions[0];
          if (o?.value === GRAVADA) return;
          escolher(o === undefined || o.value === "" ? null : { ref: o.value, rotulo: o.dataset.rotulo ?? o.text, ...(o.dataset.conta ? { conta: o.dataset.conta } : {}) });
        }}
        onFocus={() => setAberturas((n) => n + 1)}
        onMouseDown={() => setAberturas((n) => n + 1)}
        value={gravada ? GRAVADA : ""}
      >
        <option value="">{t("automations.steps.destination.choose")}</option>
        {gravada ? <option value={GRAVADA}>{escolhida.rotulo || escolhida.ref}</option> : null}
        {listas.map((l) => (
          <OpcoesDaLista
            key={l.id}
            agentId={agentId}
            aberturas={aberturas}
            app={app}
            chave={chave}
            conexao={`${conexao?.via ?? ""}:${conexao?.account ?? ""}`}
            lista={l}
            relatar={(e) => setEstado((antes) => (antes[l.id]?.lendo === e.lendo && antes[l.id]?.erro === e.erro ? antes : { ...antes, [l.id]: e }))}
          />
        ))}
      </select>
      {erro === null ? null : <p className="text-destructive text-xs">{erro}</p>}
    </Campo>
  );
}

/** Uma lista do registro: lê pelo canal da ponte, guarda em cache e devolve as opções agrupadas. */
function OpcoesDaLista({
  app,
  agentId,
  chave,
  conexao,
  lista,
  aberturas,
  relatar,
}: {
  app: string;
  agentId: string;
  chave: string;
  conexao: string;
  lista: ListaDeConversas;
  aberturas: number;
  relatar: (e: { lendo: boolean; erro: string | null }) => void;
}) {
  const carregada = useListaEmCache<unknown>(`destino:${app}:${lista.id}:${conexao}:${agentId}:${chave}`, async () => {
    const dados = await (call as (c: string, ...a: unknown[]) => Promise<unknown>)(lista.canal, ...(lista.args ?? []));
    return Array.isArray(dados) ? dados : [dados];
  });
  useEffect(() => {
    if (aberturas > 0) carregada.pedir();
  }, [aberturas]);
  useEffect(() => {
    relatar({ lendo: carregada.lendo, erro: carregada.erro });
  }, [carregada.lendo, carregada.erro]);
  const opcoes = lista.opcoes(carregada.dados ?? []);
  const grupos = [...new Set(opcoes.map((o) => o.grupo ?? ""))];
  const linha = (o: OpcaoDeConversa) => (
    <option key={o.ref} data-conta={o.conta} data-rotulo={o.rotulo} value={o.ref}>
      {o.rotulo}
    </option>
  );
  return (
    <>
      {grupos.map((g) =>
        g === "" ? (
          opcoes.filter((o) => o.grupo === undefined).map(linha)
        ) : (
          <optgroup key={g} label={g}>
            {opcoes.filter((o) => o.grupo === g).map(linha)}
          </optgroup>
        ),
      )}
    </>
  );
}
