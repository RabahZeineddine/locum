import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ListGroup, ListRow } from "@/components/ui/list-row";
import { StatusDot, type Estado } from "@/components/ui/status-dot";
import { call, invalidateReads } from "@/lib/bridge";
import { semPrefixoDoIpc } from "@/lib/erro-da-ponte";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { EscolhasDaImportacao, PreviaDoPacote } from "../../../src/services/pacote-service";
import type { RotaId } from "../rotas";

type Dependencia = PreviaDoPacote["dependencias"][number];

const ESTADO_DA_DEPENDENCIA: Record<Dependencia["estado"], Estado> = { ok: "ok", "falta-conectar": "aviso", ausente: "erro" };

/** Aviso em texto neutro com o ponto de cor, como pede o design. */
function Aviso({ children }: { children: ReactNode }) {
  return (
    <span className="text-muted-foreground flex items-center gap-2 text-xs">
      <StatusDot estado="aviso" />
      {children}
    </span>
  );
}

/** O que a pessoa vê enquanto decide: prévia do pacote, dependência por dependência. */
export function ImportarPacote({
  arquivo,
  fechar,
  navegar,
}: {
  arquivo: { nome: string; texto: string };
  fechar: () => void;
  navegar: (id: RotaId, detalhe?: string) => void;
}) {
  const { t } = useTranslation();
  const [previa, setPrevia] = useState<PreviaDoPacote | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [feito, setFeito] = useState<{ id: string; pendencias: number } | null>(null);
  const [modelos, setModelos] = useState<Record<string, string>>({});
  const [servidores, setServidores] = useState<Record<string, string>>({});
  const [conexoes, setConexoes] = useState<Record<string, string>>({});
  const [agents, setAgents] = useState<Record<string, "atualizar" | "criar-novo" | "usar-existente">>({});
  // Agent de mesmo id nunca é reescrito por omissão: o padrão é criar um novo ao lado.
  const escolhaDo = (a: PreviaDoPacote["agents"][number]): "atualizar" | "criar-novo" | "usar-existente" | undefined =>
    agents[a.id] ?? (a.situacao === "mesmo-id" ? "criar-novo" : undefined);

  const ler = (): void => {
    setPrevia(null);
    call("pacote.preview", arquivo.texto).then(
      (p) => {
        setPrevia(p);
        setErro(null);
      },
      (e: unknown) => setErro(semPrefixoDoIpc(e instanceof Error ? e.message : String(e))),
    );
  };
  useEffect(ler, [arquivo.texto]);

  const todosModelos = previa === null ? [] : [...previa.agents.map((a) => a.modelo), ...previa.passosDeIA];
  const modeloDe = (m: (typeof todosModelos)[number]): string => modelos[m.chave] ?? m.padrao ?? m.sugerido;
  const nomeIgualSemResposta = previa?.agents.some((a) => a.situacao === "nome-igual" && agents[a.id] === undefined) ?? false;
  const escritas = previa?.ferramentas.filter((f) => f.classe === "escrita") ?? [];
  const semModelo = todosModelos.some((m) => !m.disponivel && modelos[m.chave] === undefined && m.padrao === null);

  const importar = (): void => {
    if (previa === null) return;
    setOcupado(true);
    setErro(null);
    const escolhas: EscolhasDaImportacao = {
      automacaoId: previa.automacao.idSugerido,
      modelos: Object.fromEntries(todosModelos.map((m) => [m.chave, modeloDe(m)])),
      servidores,
      conexoes,
      agents: Object.fromEntries(
        previa.agents.flatMap((a) => {
          const acao = escolhaDo(a);
          return acao === undefined ? [] : [[a.id, { acao }] as const];
        }),
      ),
    };
    call("pacote.import", arquivo.texto, escolhas).then(
      (r) => {
        setOcupado(false);
        invalidateReads();
        setFeito({ id: r.automacaoId, pendencias: r.pendencias.length });
      },
      (e: unknown) => {
        setOcupado(false);
        setErro(semPrefixoDoIpc(e instanceof Error ? e.message : String(e)));
      },
    );
  };

  const atalho = (d: Dependencia): void => {
    if (d.atalho === "modelos") navegar("models");
    else navegar("connections", d.tipo === "conexao" ? d.chave : undefined);
  };

  return (
    <section className="border-border bg-card flex flex-col gap-4 rounded-lg border p-4 text-[13px]" data-locum-probe="pacote-previa">
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate font-medium text-[13px]">{t("pacote.import.title", { arquivo: arquivo.nome })}</span>
        <Button className="cursor-pointer" data-locum-pacote-fechar="" onClick={() => { invalidateReads(); fechar(); }} size="sm" variant="ghost">
          {t(feito === null ? "pacote.import.cancel" : "pacote.import.close")}
        </Button>
      </div>

      {erro === null ? null : (
        <p className="text-muted-foreground flex items-center gap-2 text-xs" data-locum-pacote-erro="">
          <StatusDot estado="erro" />
          {erro}
        </p>
      )}

      {feito !== null ? (
        <div className="flex flex-col gap-2 text-[13px]" data-locum-pacote-feito={feito.id}>
          <p>{t("pacote.import.done")}</p>
          {feito.pendencias > 0 ? <p className="text-muted-foreground text-xs">{t("pacote.import.donePending")}</p> : null}
          <Button className="w-fit cursor-pointer" onClick={() => navegar("automations", feito.id)} size="sm">
            {t("pacote.import.open")}
          </Button>
        </div>
      ) : previa === null ? (
        erro === null ? (
          <p className="text-muted-foreground flex items-center gap-2 text-[13px]">
            <Loader2 className="size-4 animate-spin" />
            {t("pacote.import.reading")}
          </p>
        ) : null
      ) : (
        <>
          <div className="flex flex-col gap-1 text-[13px]">
            <span className="text-muted-foreground text-xs">{t("pacote.import.willCreate")}</span>
            <span>
              {t("pacote.import.automation", { nome: previa.automacao.nome })}
              {previa.automacao.existe ? ` · ${t("pacote.import.idTaken", { id: previa.automacao.idSugerido })}` : ""}
            </span>
            <span className="text-muted-foreground text-xs">{t("pacote.import.triggersOff", { count: previa.gatilhos.length })}</span>
            {previa.gatilhos.some((g) => g.precisaCanal) || previa.omitidos.some((o) => o.codigo === "canais") ? (
              <Aviso>{t("pacote.import.chooseChannels")}</Aviso>
            ) : null}
            {previa.acoesRebaixadas.length > 0 ? (
              <Aviso>{t("pacote.import.downgraded")}</Aviso>
            ) : null}
          </div>

          {previa.agents.length > 0 ? (
            <ListGroup data-locum-pacote-agents="">
              {previa.agents.map((a) => (
                <ListRow className="flex-col items-stretch" data-locum-pacote-agent={a.id} key={a.id}>
                  <div className="flex items-center gap-2">
                    <span className="flex-1 truncate">{a.nome}</span>
                    <Badge variant="outline">{t(`pacote.import.agentState.${a.situacao}`, { version: a.versaoAtual })}</Badge>
                  </div>
                  {a.situacao === "nome-igual" || a.situacao === "mesmo-id" ? (
                    <div className="flex flex-col gap-1 text-xs">
                      <Aviso>
                        {a.situacao === "nome-igual" ? t("pacote.import.sameName", { nome: a.existente?.nome }) : t("pacote.import.sameId", { version: a.versaoAtual })}
                      </Aviso>
                      {(a.situacao === "mesmo-id" ? (["criar-novo", "atualizar", "usar-existente"] as const) : (["usar-existente", "criar-novo"] as const)).map((acao) => (
                        <label className="flex items-center gap-1.5" key={acao}>
                          <input checked={escolhaDo(a) === acao} data-locum-pacote-escolha={`${a.id}:${acao}`} name={`agent-${a.id}`} onChange={() => setAgents((x) => ({ ...x, [a.id]: acao }))} type="radio" />
                          {t(`pacote.import.choice.${a.situacao}.${acao}`)}
                        </label>
                      ))}
                      {a.situacao === "mesmo-id" ? (
                        <details className="text-muted-foreground" data-locum-pacote-diferencas={a.id}>
                          <summary className="cursor-pointer">{t("pacote.import.diffSummary", { count: a.diferencas.length })}</summary>
                          <ul className="mt-1 flex flex-col gap-2">
                            {a.diferencas.map((d) => (
                              <li className="flex flex-col gap-0.5" key={d.campo}>
                                <span className="text-foreground">{t(`pacote.import.field.${d.campo}`)}</span>
                                <span className="whitespace-pre-wrap break-words font-mono">{t("pacote.import.diffHere")}: {d.daqui === "" ? "—" : d.daqui}</span>
                                <span className="whitespace-pre-wrap break-words font-mono">{t("pacote.import.diffPackage")}: {d.pacote === "" ? "—" : d.pacote}</span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                      {a.situacao === "mesmo-id" && escolhaDo(a) === "atualizar" ? (
                        <span className="text-foreground flex items-center gap-2" data-locum-pacote-afetadas={a.id}>
                          <StatusDot estado="aviso" />
                          {a.usadoPor.length === 0 ? t("pacote.import.updateNoOne") : t("pacote.import.updateAffects", { lista: a.usadoPor.join(", ") })}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </ListRow>
              ))}
            </ListGroup>
          ) : null}

          {todosModelos.length > 0 ? (
            <div className="flex flex-col gap-2">
              <span className="text-muted-foreground text-xs">{t("pacote.import.models")}</span>
              {todosModelos.map((m) => (
                <label className="flex flex-wrap items-center gap-2 text-[13px]" key={m.chave}>
                  <span className="min-w-40">{m.rotulo}</span>
                  <ModeloSelect
                    aoMudar={(v) => setModelos((x) => ({ ...x, [m.chave]: v }))}
                    candidatos={previa.modelosAqui}
                    sugerido={m.sugerido}
                    valor={modelos[m.chave] ?? m.padrao ?? ""}
                  />
                  {m.disponivel ? null : <Aviso>{t("pacote.import.modelMissing")}</Aviso>}
                </label>
              ))}
            </div>
          ) : null}

          {previa.ferramentas.length > 0 ? (
            <div className="flex flex-col gap-1" data-locum-pacote-ferramentas="">
              <span className="text-muted-foreground text-xs">{t("pacote.import.tools")}</span>
              {escritas.length > 0 ? <Aviso>{t("pacote.import.toolsWrite", { count: escritas.length })}</Aviso> : null}
              <ul className="flex flex-col gap-0.5 text-xs">
                {previa.ferramentas.map((f, i) => (
                  <li className="flex items-center gap-2" data-classe={f.classe} key={i}>
                    <StatusDot estado={f.classe === "escrita" ? "aviso" : "ok"} />
                    <span className="min-w-32 truncate">{f.dono}</span>
                    <span className="font-mono">{f.servidor === null ? f.ferramenta : `${f.servidor}/${f.ferramenta}`}</span>
                    <Badge variant="outline">{t(`pacote.import.toolClass.${f.classe}`)}</Badge>
                    {f.removida ? <span className="text-muted-foreground">{t("pacote.import.toolRemoved")}</span> : null}
                    {f.declarada === undefined ? null : <span className="text-muted-foreground">{t("pacote.import.declaredRead")}</span>}
                    {f.classe === "escrita" && !f.removida && f.declarada === undefined ? <span className="text-muted-foreground">{t("pacote.import.toolAsks")}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {previa.urlsAPreencher.length > 0 ? (
            <ul className="flex flex-col gap-0.5 text-xs" data-locum-pacote-urls="">
              {previa.urlsAPreencher.map((u) => (
                <li className="flex items-center gap-2" key={u.passo}>
                  <StatusDot estado="aviso" />
                  {u.origem === undefined ? t("pacote.import.urlFill", { passo: u.passo }) : t("pacote.import.urlFillHost", { passo: u.passo, host: u.origem })}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-col gap-2" data-locum-pacote-dependencias="">
            <span className="text-muted-foreground text-xs">{t("pacote.import.needs")}</span>
            <ListGroup>
              {previa.dependencias.map((d) => (
                <ListRow className="flex-wrap" data-locum-pacote-dependencia={`${d.tipo}:${d.chave}`} data-estado={d.estado} key={`${d.tipo}:${d.chave}`}>
                  <span className="flex-1 truncate">
                    <span className="text-muted-foreground text-xs">{t(`pacote.import.kind.${d.tipo}`)} </span>
                    {d.nome}
                    {d.detalhe === undefined ? "" : <span className="text-muted-foreground font-mono text-xs"> · {d.detalhe}</span>}
                  </span>
                  <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <StatusDot estado={ESTADO_DA_DEPENDENCIA[d.estado]} />
                    {t(`pacote.import.state.${d.estado}`)}
                  </span>
                  {d.estado !== "ok" && (d.tipo === "servidor" || d.tipo === "conexao") && d.candidatos.length > 0 ? (
                    <select
                      aria-label={t("pacote.import.link", { nome: d.nome })}
                      className="border-border bg-background rounded-md border px-2 py-1 text-xs"
                      onChange={(e) => (d.tipo === "servidor" ? setServidores : setConexoes)((x) => ({ ...x, [d.chave]: e.target.value }))}
                      value={(d.tipo === "servidor" ? servidores : conexoes)[d.chave] ?? ""}
                    >
                      <option value="">{t("pacote.import.linkNone")}</option>
                      {d.candidatos.map((c) => (
                        <option key={c.valor} value={c.valor}>
                          {c.rotulo}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {d.atalho === null ? null : (
                    <Button className="cursor-pointer" onClick={() => atalho(d)} size="sm" variant="outline">
                      {t(`pacote.import.shortcut.${d.atalho}`)}
                    </Button>
                  )}
                </ListRow>
              ))}
            </ListGroup>
            <Button className="w-fit cursor-pointer" onClick={ler} size="sm" variant="ghost">
              {t("pacote.import.recheck")}
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button className="cursor-pointer" data-locum-pacote-importar="" disabled={ocupado || nomeIgualSemResposta || semModelo} onClick={importar} size="sm">
              {ocupado ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("pacote.import.confirm")}
            </Button>
            {nomeIgualSemResposta ? <span className="text-muted-foreground text-xs">{t("pacote.import.answerFirst")}</span> : null}
          </div>
        </>
      )}
    </section>
  );
}

function ModeloSelect({
  valor,
  sugerido,
  candidatos,
  aoMudar,
}: {
  valor: string;
  sugerido: string;
  candidatos: string[];
  aoMudar: (v: string) => void;
}) {
  const { t } = useTranslation();
  const opcoes = [...new Set([...(valor === "" ? [] : [valor]), ...candidatos])];
  return (
    <select aria-label={t("pacote.import.modelFor", { sugerido })} className="border-border bg-background rounded-md border px-2 py-1 text-xs" onChange={(e) => aoMudar(e.target.value)} value={valor}>
      {valor === "" ? <option value="">{t("pacote.import.modelChoose")}</option> : null}
      {opcoes.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
