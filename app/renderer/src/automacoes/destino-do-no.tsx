import { call, useRead } from "@/lib/bridge";
import { chaveDaListaDoSlack, chaveDaListaDoTeams } from "@/lib/cache-de-lista";
import { destinoDoNo, gatilhoTrazMensagem, opcoesDeConversa, paramsComDestino, type OpcaoDeConversa } from "@/lib/destino-da-conversa";
import { useTranslation } from "react-i18next";
import { ACOES_DE_CONVERSA_REGISTRO, destinosDaAcao, type DestinoDaAcao } from "../../../src/acao/destino";
import { Campo, CAMPO } from "./campos";
import { useListaEmCache } from "./combobox";

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
              {t(`automations.steps.destination.option.${registro.efeito}.${tipo}`, { app: t(`inbox.message.${registro.app}`) })}
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
            aoMudar(paramsComDestino(params, { tipo: "fixo", conversa: { app: registro.app, ref: o?.ref ?? "", rotulo: o?.rotulo ?? "" } } as DestinoDaAcao))
          }
        />
      ) : null}
      {destino.tipo === "evento" && !gatilhoTrazMensagem(acao, gatilhos) ? (
        <p className="text-xs text-amber-600 dark:text-amber-400" data-locum-destino-sem-mensagem="">
          {t(`automations.steps.destination.noMessage.${registro.efeito}`, { app: t(`inbox.message.${registro.app}`) })}
        </p>
      ) : null}
    </>
  );
}

/** A lista do app vira o mesmo select para todos: cada app só lê a sua lista. */
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
  if (app === "teams") return <ConversasDoTeams agentId={agentId} chave={chave} escolhida={escolhida} escolher={escolher} />;
  if (app === "slack") return <ConversasDoSlack escolhida={escolhida} escolher={escolher} />;
  return null;
}

function ConversasDoTeams(p: { agentId: string; chave: string; escolhida: { ref: string; rotulo?: string }; escolher: (o: OpcaoDeConversa | null) => void }) {
  const conexao = useRead("connections.list").data?.find((c) => c.id === "teams");
  const chats = useListaEmCache(chaveDaListaDoTeams("chats", conexao, { agentId: p.agentId, chave: `destino-${p.chave}` }), () => call("connections.teamsChats"));
  const canais = useListaEmCache(chaveDaListaDoTeams("canais", conexao), () => call("connections.teamsChannels"));
  const opcoes = opcoesDeConversa("teams", { teamsChats: chats.dados ?? [], teamsCanais: canais.dados ?? [] });
  return (
    <ListaDeConversas
      {...p}
      aoAbrir={() => {
        chats.pedir();
        canais.pedir();
      }}
      carregando={chats.lendo || canais.lendo}
      erro={chats.erro ?? canais.erro}
      opcoes={opcoes}
    />
  );
}

function ConversasDoSlack(p: { escolhida: { ref: string; rotulo?: string }; escolher: (o: OpcaoDeConversa | null) => void }) {
  const app = useRead("connections.slackApp").data;
  const lista = useListaEmCache(chaveDaListaDoSlack(app), async () => [await call("connections.slackChannels", [])]);
  const opcoes = opcoesDeConversa("slack", { slackCanais: lista.dados?.[0]?.canais ?? [] });
  return <ListaDeConversas {...p} aoAbrir={() => lista.pedir()} carregando={lista.lendo} erro={lista.erro} opcoes={opcoes} />;
}

function ListaDeConversas({
  opcoes,
  escolhida,
  escolher,
  aoAbrir,
  carregando,
  erro,
}: {
  opcoes: OpcaoDeConversa[];
  escolhida: { ref: string; rotulo?: string };
  escolher: (o: OpcaoDeConversa | null) => void;
  aoAbrir: () => void;
  carregando: boolean;
  erro: string | null;
}) {
  const { t } = useTranslation();
  // A conversa já gravada continua à vista mesmo antes de a lista carregar.
  const gravada = escolhida.ref !== "" && !opcoes.some((o) => o.ref === escolhida.ref);
  const grupos = [...new Set(opcoes.map((o) => o.grupo ?? ""))];
  const linha = (o: OpcaoDeConversa) => (
    <option key={o.ref} value={o.ref}>
      {o.rotulo}
    </option>
  );
  return (
    <Campo ajuda={carregando ? t("automations.steps.destination.loading") : undefined} rotulo={t("automations.steps.destination.conversation")}>
      <select
        className={CAMPO}
        data-locum-destino-conversa=""
        onChange={(e) => escolher(opcoes.find((o) => o.ref === e.target.value) ?? null)}
        onFocus={aoAbrir}
        onMouseDown={aoAbrir}
        value={escolhida.ref}
      >
        <option value="">{t("automations.steps.destination.choose")}</option>
        {gravada ? <option value={escolhida.ref}>{escolhida.rotulo || escolhida.ref}</option> : null}
        {grupos.map((g) =>
          g === "" ? (
            opcoes.filter((o) => o.grupo === undefined).map(linha)
          ) : (
            <optgroup key={g} label={g}>
              {opcoes.filter((o) => o.grupo === g).map(linha)}
            </optgroup>
          ),
        )}
      </select>
      {erro === null ? null : <p className="text-destructive text-xs">{erro}</p>}
    </Campo>
  );
}
