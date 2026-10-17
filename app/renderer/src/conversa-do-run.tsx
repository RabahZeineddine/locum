import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { StatusDot } from "@/components/ui/status-dot";
import { chatDoRun } from "@/lib/agent-chat";
import { call, useRead } from "@/lib/bridge";
import { alvoDoValor, situacaoDaConversa, valorDoAlvo, valorDoSeletor } from "@/lib/conversa-do-run";
import { useConversa, type Conversa } from "@/lib/use-conversa";
import { Loader2, MessageSquareText } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DoRunNaConversa } from "../../src/agent-chat/tipos";
import { PainelDeConversa } from "./agent-chat";

interface Catalogo {
  provedor: string;
  modelos: string[];
  erro?: string;
}

/**
 * A aba Conversa do detalhe de um run (ADR 0009): o mesmo painel do chat do agent, com o retrato
 * do que a conversa é (com quem fala, o que o modelo viu, o que gastou) acima das falas.
 */
export function ConversaDoRun({ runId }: { runId: string }) {
  const { t } = useTranslation();
  const conversa = useConversa(chatDoRun, runId);
  const { run } = conversa;
  const situacao = situacaoDaConversa({ respondendo: conversa.respondendo, outroProcesso: conversa.outro, run });

  return (
    <div className="flex flex-col gap-3" data-locum-run-conversa={runId}>
      {run === undefined || situacao === null ? null : <RetratoDaConversa conversa={conversa} run={run} trocar={situacao.podeTrocarAlvo} />}
      <PainelDeConversa
        cabecalho={
          <>
            <MessageSquareText aria-hidden className="size-4 text-muted-foreground" />
            <span className="text-[13px] font-medium">{t("runChat.title")}</span>
          </>
        }
        conversa={conversa}
        id={runId}
        semEnvio={situacao === null || !situacao.podeEnviar}
        textos={{
          titulo: t("runChat.title"),
          recomecar: t("runChat.reset"),
          vazio: { titulo: t("runChat.empty.title"), corpo: t("runChat.empty.body") },
          placeholder: t(situacao?.situacao === "sem-alvo" ? "runChat.placeholderNoTarget" : "runChat.placeholder"),
          nota: t("runChat.note"),
        }}
      />
    </div>
  );
}

/** Com quem a conversa fala, o que o modelo viu do run, os limites da volta e o gasto. */
function RetratoDaConversa({ conversa, run, trocar }: { conversa: Conversa; run: DoRunNaConversa; trocar: boolean }) {
  const { t } = useTranslation();
  const agents = useRead("library.profiles");
  const [catalogos, setCatalogos] = useState<Catalogo[] | null>(null);
  const [carregando, setCarregando] = useState(false);
  const situacao = situacaoDaConversa({ respondendo: conversa.respondendo, outroProcesso: conversa.outro, run: { ...run } });
  const nomeDoAgent = (id: string): string => agents.data?.find((a) => a.id === id)?.name ?? id;
  const valor = valorDoSeletor(run);

  async function escolher(novo: string): Promise<void> {
    conversa.limparFalha();
    try {
      await chatDoRun.definirAlvo(conversa.chave, alvoDoValor(novo));
      await conversa.recarregar();
    } catch (erro) {
      conversa.mostrarFalha(erro);
    }
  }

  // O catálogo bate na rede de cada provedor: só atrás de um clique.
  async function carregarModelos(): Promise<void> {
    setCarregando(true);
    conversa.limparFalha();
    try {
      setCatalogos((await call("providers.allModels", { assinatura: true })).filter((c) => c.provedor !== "codex"));
    } catch (erro) {
      conversa.mostrarFalha(erro);
    } finally {
      setCarregando(false);
    }
  }

  const doCatalogo = new Set((catalogos ?? []).flatMap((c) => c.modelos.map((m) => `modelo:${c.provedor}/${m}`)));
  // O modelo escolhido que o catálogo ainda não listou (ou não foi carregado) segue na lista, para o seletor não mentir.
  const atualForaDoCatalogo = run.alvo?.tipo === "modelo" && !run.padrao && !doCatalogo.has(valor) ? valor : null;

  const alvo = run.alvo === null ? null : run.alvo.tipo === "agent" ? t("runChat.target.agent", { name: nomeDoAgent(run.alvo.id) }) : t("runChat.target.model", { name: run.alvo.id });

  return (
    <div className="border-border bg-card flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-[13px]" data-locum-run-conversa-retrato="">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs font-medium">{t("runChat.target.title")}</span>
        {alvo === null ? (
          <span data-locum-run-conversa-sem-alvo="">{t("runChat.target.none")}</span>
        ) : (
          <>
            <span className="font-medium" data-locum-run-conversa-alvo={valor === "" ? `padrao:${run.alvo?.tipo}:${run.alvo?.id}` : valor}>
              {alvo}
            </span>
            <span className="text-muted-foreground text-xs" data-locum-run-conversa-origem={run.padrao ? "padrao" : "escolhido"}>
              {t(run.padrao ? "runChat.target.isDefault" : "runChat.target.isChosen")}
            </span>
          </>
        )}
        <Select
          aria-label={t("runChat.target.select")}
          className="ml-auto w-auto min-w-56"
          data-locum-run-conversa-trocar=""
          disabled={!trocar}
          onChange={(e) => void escolher(e.target.value)}
          value={valor}
        >
          <option value="">{t("runChat.target.useDefault")}</option>
          {(agents.data ?? []).length === 0 ? null : (
            <optgroup label={t("runChat.target.agents")}>
              {(agents.data ?? []).map((a) => (
                <option key={a.id} value={valorDoAlvo({ agent: a.id })}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          )}
          {atualForaDoCatalogo === null ? null : (
            <optgroup label={t("runChat.target.models")}>
              <option value={atualForaDoCatalogo}>{atualForaDoCatalogo.slice("modelo:".length)}</option>
            </optgroup>
          )}
          {(catalogos ?? []).map((c) => (
            <optgroup key={c.provedor} label={c.provedor}>
              {c.modelos.map((m) => (
                <option key={m} value={valorDoAlvo({ modelo: `${c.provedor}/${m}` })}>
                  {m}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        {catalogos === null ? (
          <Button className="cursor-pointer" disabled={carregando || !trocar} onClick={() => void carregarModelos()} size="sm" variant="outline">
            {carregando ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null}
            {t("runChat.target.loadModels")}
          </Button>
        ) : null}
      </div>

      {run.motivoSemAlvo === null ? null : (
        <p className="text-muted-foreground flex items-start gap-1.5 text-xs" data-locum-run-conversa-motivo="">
          <StatusDot className="mt-[5px]" estado="aviso" />
          {run.motivoSemAlvo}
        </p>
      )}
      {situacao?.situacao !== "somente-leitura" ? null : (
        <p className="text-muted-foreground flex items-start gap-1.5 text-xs" data-locum-run-conversa-leitura="">
          <StatusDot className="mt-[5px]" estado="aviso" />
          {t("runChat.readOnly")}
        </p>
      )}

      <ul className="text-muted-foreground flex flex-col gap-0.5 text-xs" data-locum-run-conversa-limites="">
        <li>{t(run.limites.passosDoAgent ? "runChat.limits.stepsAgent" : "runChat.limits.steps", { count: run.limites.passosDaVolta })}</li>
        <li>{t("runChat.limits.read", { count: run.limites.tetoDaLeitura })}</li>
        <li data-locum-run-conversa-teto={run.contexto.teto}>{t("runChat.context.cap", { count: run.contexto.teto })}</li>
        {run.contexto.cortado.length === 0 ? null : (
          <li className="flex items-start gap-1.5" data-locum-run-conversa-cortado={run.contexto.cortado.join(",")}>
            <StatusDot className="mt-[5px]" estado="aviso" />
            {t("runChat.context.cut", { items: run.contexto.cortado.join(", ") })}
          </li>
        )}
        <li data-locum-run-conversa-gasto="">{t("runChat.spent", { usd: run.gasto.usd.toFixed(4), tokens: run.gasto.tokens })}</li>
      </ul>
    </div>
  );
}
