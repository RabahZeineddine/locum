import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { call, invalidateReads, useRead, type ReadResult } from "@/lib/bridge";
import { haQuantoTempo, horaDoDia, percentual, piorEstado, quandoReseta } from "@/lib/limites";
import { rotuloDoProvedor } from "@/lib/rotulos";

type Visao = ReadResult<"limites.overview">;
export type ProvedorComLimites = Visao["provedores"][number];
type Limite = ProvedorComLimites["limites"][number];

/** Barra fina de uso. O estado mora no ponto ao lado, não na cor da barra. */
function Barra({ uso }: { uso: number }) {
  return (
    <span aria-hidden className="bg-muted inline-block h-1 w-20 shrink-0 overflow-hidden rounded-full">
      <span className="bg-foreground/50 block h-full" style={{ width: `${Math.min(100, Math.round(uso * 100))}%` }} />
    </span>
  );
}

/** Um limite numa linha: ponto, chave, uso, barra e quando reseta. */
export function LinhaDoLimite({ limite, comOrigem = true }: { limite: Limite; comOrigem?: boolean }) {
  const { t, i18n } = useTranslation();
  const valores =
    limite.tipo !== "janela" && limite.usado !== undefined && limite.teto !== undefined
      ? limite.unidade === "usd"
        ? ` (${limite.usado.toFixed(2)} / ${limite.teto.toFixed(2)} USD)`
        : ` (${Math.round(limite.usado)} / ${Math.round(limite.teto)})`
      : "";
  return (
    <div
      className="flex min-h-6 flex-wrap items-center gap-x-2 text-xs"
      data-locum-limite={`${limite.provedor}:${limite.chave}`}
      data-locum-limite-estado={limite.estado}
      data-locum-limite-uso={percentual(limite.uso)}
    >
      <StatusDot estado={limite.estado} />
      <span className="min-w-14">{t(`limits.key.${limite.chave}`, { defaultValue: limite.chave })}</span>
      <span className="num tabular-nums">
        {percentual(limite.uso)}
        {valores}
      </span>
      <Barra uso={limite.uso} />
      {limite.resetaEm === undefined ? null : (
        <span className="text-muted-foreground">{t("limits.resets", { when: quandoReseta(limite.resetaEm, i18n.language) })}</span>
      )}
      {comOrigem ? <span className="text-muted-foreground">· {t(`limits.origin.${limite.origem}`)}</span> : null}
    </div>
  );
}

/** O botão Atualizar, com o aviso do que ele custa. */
export function AtualizarLimites({ provedor }: { provedor: ProvedorComLimites }) {
  const { t } = useTranslation();
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  if (!provedor.assinatura && !provedor.gateway) return null;
  const custo = provedor.assinatura ? t("limits.refreshCostClaude") : t("limits.refreshGateway");
  const atualizar = (): void => {
    setOcupado(true);
    setAviso(null);
    call("limites.refresh", provedor.provedor).then(
      (r) => {
        if (!r.chamou && !provedor.assinatura) setAviso(t("limits.refreshSkipped"));
        invalidateReads("limites.overview");
      },
      (e: unknown) => setAviso(t("limits.refreshFailed", { error: e instanceof Error ? e.message : String(e) })),
    ).finally(() => setOcupado(false));
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button disabled={ocupado} onClick={atualizar} size="sm" title={custo} variant="ghost" data-locum-limites-atualizar={provedor.provedor}>
        {ocupado ? t("limits.refreshing") : t("limits.refresh")}
      </Button>
      {aviso === null ? null : <span className="text-muted-foreground text-xs">{aviso}</span>}
    </span>
  );
}

function maisRecente(p: ProvedorComLimites): number | null {
  return p.limites.length === 0 ? null : Math.max(...p.limites.map((l) => l.quando));
}

/**
 * Os limites de um provedor dentro da linha dele, em Modelos: uma linha por
 * chave, o Atualizar quando a fonte aceita, e o orçamento por dia e mês nos
 * provedores de API.
 */
export function LimitesDoProvedor({ nome, disponivel }: { nome: string; disponivel: boolean }) {
  const { t } = useTranslation();
  const lido = useRead("limites.overview");
  const provedor = lido.data?.provedores.find((p) => p.provedor === nome);
  if (provedor === undefined) return null;
  if (!disponivel && provedor.limites.length === 0) return null;
  const recente = maisRecente(provedor);
  const semOrcamento = !provedor.aceitaOrcamento;
  if (provedor.limites.length === 0 && provedor.assinatura === false && semOrcamento) return null;
  return (
    <div className="flex flex-col gap-1" data-locum-limites-provedor={nome}>
      {provedor.limites.length === 0 ? (
        provedor.assinatura ? (
          <p className="text-muted-foreground text-xs">{t("limits.noReading")}</p>
        ) : null
      ) : (
        provedor.limites.map((l) => <LinhaDoLimite key={`${l.chave}:${l.origem}`} limite={l} />)
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <AtualizarLimites provedor={provedor} />
        {recente === null ? null : <span className="text-muted-foreground">{t("limits.updated", { when: haQuantoTempo(t, recente) })}</span>}
      </div>
      {provedor.aceitaOrcamento ? <OrcamentoDoProvedor provedor={provedor} /> : null}
    </div>
  );
}

function OrcamentoDoProvedor({ provedor }: { provedor: ProvedorComLimites }) {
  const { t } = useTranslation();
  const [dia, setDia] = useState<string | null>(null);
  const [mes, setMes] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const diaAtual = dia ?? (provedor.orcamento.diaUsd === undefined ? "" : String(provedor.orcamento.diaUsd));
  const mesAtual = mes ?? (provedor.orcamento.mesUsd === undefined ? "" : String(provedor.orcamento.mesUsd));
  const gravar = (): void => {
    setOcupado(true);
    call("limites.setBudget", provedor.provedor, {
      ...(Number(diaAtual) > 0 ? { diaUsd: Number(diaAtual) } : {}),
      ...(Number(mesAtual) > 0 ? { mesUsd: Number(mesAtual) } : {}),
    })
      .then(() => {
        setDia(null);
        setMes(null);
        invalidateReads("limites.overview");
      })
      .finally(() => setOcupado(false));
  };
  const campo = (id: string, rotulo: string, valor: string, mudar: (v: string) => void) => (
    <span className="flex items-center gap-1.5">
      <label className="text-muted-foreground text-xs" htmlFor={id}>
        {rotulo}
      </label>
      <Input className="h-7 w-20 text-right tabular-nums" id={id} min={0} onChange={(e) => mudar(e.target.value)} step="any" type="number" value={valor} />
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-3" data-locum-orcamento={provedor.provedor}>
      {campo(`orc-dia-${provedor.provedor}`, t("limits.budget.day"), diaAtual, setDia)}
      {campo(`orc-mes-${provedor.provedor}`, t("limits.budget.month"), mesAtual, setMes)}
      <Button disabled={ocupado || (dia === null && mes === null)} onClick={gravar} size="sm" variant="secondary">
        {t("limits.budget.save")}
      </Button>
      <span className="text-muted-foreground max-w-[60ch] text-[11px]">{t("limits.budget.hint")}</span>
    </div>
  );
}

/**
 * Hoje: só os provedores em uso (com leitura ou orçamento), o pior estado
 * primeiro, e a frase da pausa quando alguma automação está esperando.
 */
export function LimitesNaHoje() {
  const { t, i18n } = useTranslation();
  const lido = useRead("limites.overview");
  if (lido.data === undefined) return null;
  const emUso = lido.data.provedores.filter((p) => p.limites.length > 0 || p.assinatura);
  if (emUso.length === 0) return null;
  const ordem = { ok: 0, aviso: 1, erro: 2 } as const;
  const ordenados = [...emUso].sort((a, b) => ordem[piorEstado(b.limites)] - ordem[piorEstado(a.limites)]);
  const pausados = lido.data.provedores.filter((p) => p.pausaAte !== null);
  return (
    <section className="flex flex-col gap-1.5" data-locum-limites-hoje>
      <h2 className="text-[13px] font-medium">{t("limits.title")}</h2>
      {pausados.map((p) => (
        <p className="flex items-center gap-2 text-[13px]" data-locum-pausa={p.provedor} key={p.provedor}>
          <StatusDot estado="erro" />
          {t("limits.pause", { time: horaDoDia(p.pausaAte!, i18n.language), provider: rotuloDoProvedor(p.provedor) })}
        </p>
      ))}
      <div className="border-border bg-card flex flex-col divide-y divide-border rounded-lg border">
        {ordenados.map((p) => (
          <div className="flex flex-col gap-0.5 px-3 py-2 text-[13px]" data-locum-limites-linha={p.provedor} key={p.provedor}>
            <div className="flex flex-wrap items-center gap-x-3">
              <span className="font-medium">{rotuloDoProvedor(p.provedor)}</span>
              <AtualizarLimites provedor={p} />
            </div>
            {p.limites.length === 0 ? (
              <span className="text-muted-foreground text-xs">{t("limits.noReading")}</span>
            ) : (
              p.limites.map((l) => <LinhaDoLimite comOrigem={false} key={`${l.chave}:${l.origem}`} limite={l} />)
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Configuração > Geral: liga a pausa e ajusta os dois limiares globais. */
export function ProtecaoDeLimites() {
  const { t } = useTranslation();
  const lido = useRead("limites.overview");
  const [janela, setJanela] = useState<string | null>(null);
  const [orcamento, setOrcamento] = useState<string | null>(null);
  if (lido.data === undefined) return null;
  const v = lido.data;
  const gravar = (parcial: { protecao?: boolean; limiarJanela?: number; limiarOrcamento?: number }): void => {
    void call("limites.setConfig", parcial).then(() => {
      setJanela(null);
      setOrcamento(null);
      invalidateReads("limites.overview");
    });
  };
  const janelaAtual = janela ?? String(Math.round(v.limiarJanela * 100));
  const orcamentoAtual = orcamento ?? String(Math.round(v.limiarOrcamento * 100));
  return (
    <div className="flex flex-wrap items-center gap-3" data-locum-probe="limites-protecao">
      <label className="flex items-center gap-2 text-xs">
        <input checked={v.protecao} onChange={(e) => gravar({ protecao: e.target.checked })} type="checkbox" />
        {t("limits.settings.enable")}
      </label>
      <span className="flex items-center gap-1.5">
        <label className="text-muted-foreground text-xs" htmlFor="limiar-janela">{t("limits.settings.window")}</label>
        <Input className="h-7 w-16 text-right tabular-nums" id="limiar-janela" max={100} min={1} onChange={(e) => setJanela(e.target.value)} type="number" value={janelaAtual} />
      </span>
      <span className="flex items-center gap-1.5">
        <label className="text-muted-foreground text-xs" htmlFor="limiar-orcamento">{t("limits.settings.budget")}</label>
        <Input className="h-7 w-16 text-right tabular-nums" id="limiar-orcamento" max={150} min={1} onChange={(e) => setOrcamento(e.target.value)} type="number" value={orcamentoAtual} />
      </span>
      <Button
        disabled={janela === null && orcamento === null}
        onClick={() => gravar({ limiarJanela: Number(janelaAtual) / 100, limiarOrcamento: Number(orcamentoAtual) / 100 })}
        size="sm"
        variant="secondary"
      >
        {t("limits.settings.save")}
      </Button>
    </div>
  );
}
