import { Button } from "@/components/ui/button";
import { gravarRevisao, gravarTexto, decidir } from "@/lib/aprovar";
import { BridgeError, read, useRead, type ReadResult, type ReadState } from "@/lib/bridge";
import { comContexto, diffLinhas, type LinhaDoDiff } from "@/lib/diff";
import {
  CONFIANCAS,
  rotuloDeSeveridade,
  rotuloDoMotivo,
  SEVERIDADES,
  VEREDITOS,
  type Confianca,
  type Severidade,
  type Veredito,
} from "@/lib/rotulos";
import { cn } from "@/lib/utils";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LeituraDoDigest, lerDigest } from "../leitura-do-digest";
import type { TelaProps } from "../rotas";
import { cargaDaMensagem, cargaDoDocumento, ehDocumento, ehMensagem } from "./inbox";

type Pendencia = NonNullable<ReadResult<"approvals.get">>;

/** O que `context.update` guarda na pendencia. Ver `src/context/proposal.ts`. */
interface CargaDeContexto {
  slug: string;
  file: string;
  mode: "replace" | "append";
  content: string;
  baseHash?: string;
}

interface AchadoEditavel {
  file?: string;
  line?: number;
  severity: Severidade;
  confidence?: Confianca;
  category?: string;
  problem: string;
  fix?: string;
  /** Desmarcado sai do que vai ser publicado, sem sumir da tela. */
  incluido: boolean;
}

const REGUA: Record<Severidade, string> = {
  critical: "bg-sev-critical",
  high: "bg-sev-high",
  medium: "bg-sev-medium",
  low: "bg-sev-low",
};

/**
 * O que vai sair, antes de sair.
 *
 * Review de modelo quase nunca é oito ou oitenta: de quatro achados, três
 * prestam. Sem poder tirar um, a fila empurra a pessoa a aprovar ruído junto
 * com sinal, e aí a medição de precisão mede a paciência de quem aprovou, não a
 * qualidade do agent.
 *
 * Editar aqui não publica nada: grava na pendência, que continua esperando.
 *
 * A leitura é `approvals.get`, e não `approvals.listPending`: uma pendência de
 * `context.update` que fechou como `conflict` sai da fila pendente, mas
 * continua precisando de tela para explicar o que aconteceu. Buscando só nas
 * pendentes, ela sumiria assim que fechasse.
 */
export function Revisao({ detalhe, navegar }: TelaProps) {
  const { t } = useTranslation();
  const aprovacao = useRead("approvals.get", detalhe ?? "");
  const pendencia = aprovacao.status === "ready" ? aprovacao.data : undefined;
  const contexto =
    pendencia?.kind === "context.update" ? (pendencia.payload as CargaDeContexto) : null;
  const mensagem = pendencia !== undefined && ehMensagem(pendencia);
  const documento = pendencia !== undefined && ehDocumento(pendencia);
  const [arquivo, setArquivo] = useState<ReadState<ReadResult<"initiatives.context">>>({
    status: "loading",
    data: undefined,
    error: undefined,
  });

  useEffect(() => {
    if (!contexto) return;
    let vivo = true;
    setArquivo({ status: "loading", data: undefined, error: undefined });
    read("initiatives.context", contexto.slug, contexto.file as "context.md").then(
      (data) => {
        if (vivo) setArquivo({ status: "ready", data, error: undefined });
      },
      (erro: unknown) => {
        if (!vivo) return;
        setArquivo({
          status: "error",
          data: undefined,
          error: erro instanceof BridgeError ? erro : new BridgeError("initiatives.context", String(erro)),
        });
      },
    );
    return () => {
      vivo = false;
    };
  }, [contexto?.slug, contexto?.file]);

  const [achados, setAchados] = useState<AchadoEditavel[] | null>(null);
  const [veredito, setVeredito] = useState<Veredito>("COMMENT");
  const [gravando, setGravando] = useState(false);
  const [resolvendo, setResolvendo] = useState(false);
  const [conflito, setConflito] = useState(false);
  const primeiroRender = useRef(true);

  useEffect(() => {
    if (!pendencia || contexto || mensagem || documento || achados !== null) return;
    const carga = pendencia.payload as { findings?: unknown[]; verdict?: unknown } | null;
    if ((VEREDITOS as readonly unknown[]).includes(carga?.verdict)) {
      setVeredito(carga!.verdict as Veredito);
    }
    setAchados(
      (carga?.findings ?? []).map((bruto) => {
        const f = bruto as Record<string, unknown>;
        return {
          file: typeof f.file === "string" ? f.file : undefined,
          line: typeof f.line === "number" ? f.line : undefined,
          severity: (SEVERIDADES as readonly string[]).includes(String(f.severity))
            ? (f.severity as Severidade)
            : "low",
          confidence: (CONFIANCAS as readonly string[]).includes(String(f.confidence))
            ? (f.confidence as Confianca)
            : undefined,
          category: typeof f.category === "string" ? f.category : undefined,
          problem: typeof f.problem === "string" ? f.problem : "",
          fix: typeof f.fix === "string" ? f.fix : undefined,
          incluido: true,
        };
      }),
    );
  }, [pendencia, achados]);

  // Grava sozinho depois que a digitação para. Botão de salvar num editor de
  // um item só é cerimônia: o risco real é fechar a tela e perder a edição.
  useEffect(() => {
    if (achados === null || !pendencia || contexto || mensagem || documento) return;
    if (primeiroRender.current) {
      primeiroRender.current = false;
      return;
    }
    const id = setTimeout(() => {
      setGravando(true);
      void gravarRevisao(
        pendencia.id,
        achados.filter((a) => a.incluido).map(({ incluido: _, ...resto }) => resto),
        veredito,
      ).finally(() => setGravando(false));
    }, 700);
    return () => clearTimeout(id);
  }, [achados, veredito, pendencia, contexto]);

  if (aprovacao.status === "ready" && !pendencia) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <Voltar navegar={navegar} />
        <p className="text-muted-foreground mt-4 text-sm">{t("review.not_found")}</p>
      </div>
    );
  }
  if (!pendencia) return null;

  // Pendencia ja fechada, seja por outra tela ou por este mesmo clique: sem
  // isto, `decidir` rejeitaria de novo, porque a gate so decide pendencia
  // pendente. Ver `ApprovalGate.decide`.
  const jaResolvida = pendencia.status !== "pending" || conflito;

  async function resolver(decisao: "approved" | "rejected") {
    if (!pendencia) return;
    setResolvendo(true);
    try {
      const resultado = await decidir(pendencia.id, decisao);
      if (resultado.status === "conflict") {
        setConflito(true);
        return;
      }
      navegar("inbox");
    } finally {
      setResolvendo(false);
    }
  }

  if (contexto) {
    return (
      <RevisaoDeContexto
        arquivo={arquivo}
        conflito={conflito}
        contexto={contexto}
        jaResolvida={jaResolvida}
        navegar={navegar}
        onResolver={resolver}
        pendencia={pendencia}
        resolvendo={resolvendo}
      />
    );
  }

  if (mensagem) {
    return (
      <RevisaoDeMensagem
        jaResolvida={jaResolvida}
        navegar={navegar}
        onResolver={resolver}
        pendencia={pendencia}
        resolvendo={resolvendo}
      />
    );
  }

  if (documento) {
    return (
      <RevisaoDeDocumento
        jaResolvida={jaResolvida}
        navegar={navegar}
        onResolver={resolver}
        pendencia={pendencia}
        resolvendo={resolvendo}
      />
    );
  }

  if (achados === null) return null;

  const carga = pendencia.payload as {
    pull?: number;
    repo?: string;
    owner?: string;
    title?: string;
    author?: string;
    url?: string;
    summary?: string;
  } | null;
  const marcados = achados.filter((a) => a.incluido).length;
  // Aprovar sem achado é uma review que diz alguma coisa; comentar sem achado
  // não diz nada.
  const vazia = marcados === 0 && veredito === "COMMENT";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex items-baseline gap-3">
        <Voltar navegar={navegar} />
        {carga?.pull && (
          <span className="font-mono text-[13px] font-medium">{t("common.pull", { number: carga.pull })}</span>
        )}
        <span className="text-muted-foreground truncate font-mono text-xs">
          {carga?.owner ? `${carga.owner}/` : ""}
          {carga?.repo ?? ""}
        </span>
        {carga?.url && (
          <a
            className="text-muted-foreground hover:text-foreground ml-auto shrink-0 text-xs"
            href={carga.url}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink className="inline size-3" aria-hidden /> {t("common.open_github")}
          </a>
        )}
      </div>

      {carga?.title && <h1 className="text-lg font-semibold tracking-tight">{carga.title}</h1>}

      {carga?.summary && (
        <div className="bg-card/70 border-border rounded-lg border p-4 text-sm leading-relaxed">
          <span className="text-muted-foreground font-medium text-xs uppercase tracking-wider block mb-1">
            {t("review.summary_label", { defaultValue: "Parecer da Auditoria" })}
          </span>
          <p className="text-foreground/90 whitespace-pre-wrap">{carga.summary}</p>
        </div>
      )}

      <label className="text-muted-foreground flex items-center gap-2 text-xs">
        {t("review.verdict.label")}
        <select
          className="border-border bg-background text-foreground cursor-pointer rounded border px-1.5 py-0.5 text-xs"
          data-locum-veredito=""
          onChange={(e) => setVeredito(e.target.value as Veredito)}
          value={veredito}
        >
          {VEREDITOS.map((v) => (
            <option key={v} value={v}>
              {t(`review.verdict.${v}`)}
            </option>
          ))}
        </select>
      </label>

      {achados.length === 0 ? (
        <div className="border-border/60 bg-muted/20 flex flex-col gap-1 rounded-lg border p-4 text-sm">
          <p className="font-medium text-foreground">
            {t("review.no_findings_title", { defaultValue: "Nenhum defeito impeditivo encontrado." })}
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t("review.no_findings_hint", {
              defaultValue:
                "A auditoria não encontrou regressões funcionais, concorrência, quebra de contratos ou falhas de segurança no diff. Você pode aprovar o PR com o parecer positivo acima ou descartar esta revisão sem comentar.",
            })}
          </p>
        </div>
      ) : (
        <ul className="divide-border border-border superficie divide-y overflow-hidden rounded-lg border">
          {achados.map((achado, i) => (
            <li className={cn("relative", !achado.incluido && "opacity-45")} key={i}>
              <span
                aria-hidden
                className={cn("absolute top-0 bottom-0 left-0 w-[3px]", REGUA[achado.severity])}
              />
              <div className="py-3 pr-4 pl-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground font-mono text-xs">
                    {achado.file ?? ""}
                    {achado.line ? `:${achado.line}` : ""}
                  </span>

                  <select
                    aria-label={t("review.severity")}
                    className="border-border bg-background cursor-pointer rounded border px-1.5 py-0.5 text-xs"
                    onChange={(e) =>
                      setAchados((atual) =>
                        (atual ?? []).map((a, j) =>
                          j === i ? { ...a, severity: e.target.value as Severidade } : a,
                        ),
                      )
                    }
                    value={achado.severity}
                  >
                    {SEVERIDADES.map((s) => (
                      <option key={s} value={s}>
                        {rotuloDeSeveridade(t, s)}
                      </option>
                    ))}
                  </select>

                  {achado.confidence && (
                    <span className="text-muted-foreground text-xs">
                      {t(`review.confidence.${achado.confidence}`)}
                    </span>
                  )}

                  <label className="text-muted-foreground ml-auto flex cursor-pointer items-center gap-1.5 text-xs">
                    <input
                      checked={achado.incluido}
                      className="accent-primary cursor-pointer"
                      onChange={(e) =>
                        setAchados((atual) =>
                          (atual ?? []).map((a, j) =>
                            j === i ? { ...a, incluido: e.target.checked } : a,
                          ),
                        )
                      }
                      type="checkbox"
                    />
                    {t(achado.incluido ? "review.include" : "review.excluded")}
                  </label>
                </div>

                <textarea
                  aria-label={t("review.body_label")}
                  className="focus:border-ring border-border bg-background mt-2 w-full resize-y rounded border px-2.5 py-2 text-sm leading-relaxed outline-none transition-colors duration-200"
                  onChange={(e) =>
                    setAchados((atual) =>
                      (atual ?? []).map((a, j) => (j === i ? { ...a, problem: e.target.value } : a)),
                    )
                  }
                  rows={Math.min(8, Math.max(2, Math.ceil(achado.problem.length / 90)))}
                  value={achado.problem}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <Button
          className="cursor-pointer"
          disabled={resolvendo || vazia || jaResolvida}
          onClick={() => void resolver("approved")}
        >
          {t("review.approve")}
        </Button>
        <Button
          className="text-muted-foreground hover:text-foreground cursor-pointer"
          disabled={resolvendo || jaResolvida}
          onClick={() => void resolver("rejected")}
          variant="ghost"
        >
          {t("review.discard")}
        </Button>

        <span className="text-muted-foreground ml-auto text-xs">
          {gravando
            ? t("review.saving")
            : vazia
              ? t("review.none_selected")
              : marcados === 0
                ? t("review.verdict_only")
                : t("review.will_post", { count: marcados })}
        </span>

        <button
          className="text-muted-foreground hover:text-foreground cursor-pointer text-xs"
          onClick={() => navegar("runs", pendencia.runId)}
          type="button"
        >
          {t("review.see_run")}
        </button>
      </div>
    </div>
  );
}

/**
 * A revisão de um `context.update`: o que vai substituir ou entrar em
 * `context.md`, lado a lado com o que está lá agora.
 *
 * `append` não tem lado antigo para comparar: o bloco novo entra inteiro
 * marcado como acréscimo, sobre o arquivo atual como contexto de leitura.
 */
function RevisaoDeContexto({
  arquivo,
  conflito,
  contexto,
  jaResolvida,
  navegar,
  onResolver,
  pendencia,
  resolvendo,
}: {
  arquivo: ReadState<ReadResult<"initiatives.context">>;
  conflito: boolean;
  contexto: CargaDeContexto;
  jaResolvida: boolean;
  navegar: TelaProps["navegar"];
  onResolver: (decisao: "approved" | "rejected") => void;
  pendencia: Pendencia;
  resolvendo: boolean;
}) {
  const { t } = useTranslation();

  const linhas = useMemo(() => {
    if (arquivo.status !== "ready") return [];
    const atual = (arquivo.data.content ?? "").split("\n");
    const novo =
      contexto.mode === "replace" ? contexto.content.split("\n") : [...atual, ...contexto.content.split("\n")];
    return comContexto(diffLinhas(atual, novo));
  }, [arquivo, contexto]);

  const mudouPorFora =
    contexto.mode === "replace" &&
    contexto.baseHash !== undefined &&
    arquivo.status === "ready" &&
    arquivo.data.hash !== contexto.baseHash;

  const emConflito = pendencia.status === "conflict" || conflito;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex items-baseline gap-3">
        <Voltar navegar={navegar} />
        <h1 className="text-lg font-semibold tracking-tight">
          {t("inbox.context_update.target", { slug: contexto.slug })}
        </h1>
        <span className="text-muted-foreground font-mono text-xs">
          {t(`review.contextUpdate.mode.${contexto.mode}`)}
        </span>
      </div>

      <p className="text-muted-foreground text-xs">
        {t("review.contextUpdate.target", { slug: contexto.slug, file: contexto.file })}
      </p>

      {emConflito ? (
        <div className="border-destructive/40 bg-destructive/10 rounded-md border px-3 py-2 text-sm">
          <p className="font-medium">{t("review.contextUpdate.conflict.title")}</p>
          <p className="text-muted-foreground mt-1">
            {t("review.contextUpdate.conflict.body", {
              reason: rotuloDoMotivo(t, "publish_conflict"),
            })}
          </p>
        </div>
      ) : (
        mudouPorFora && (
          <p className="border-sev-medium/40 bg-sev-medium/10 text-sev-medium rounded-md border px-3 py-2 text-sm">
            {t("review.contextUpdate.changed")}
          </p>
        )
      )}

      {arquivo.status === "ready" && (
        <div
          className="overflow-auto rounded-lg border border-border font-mono text-xs"
          data-locum-probe="context-diff"
        >
          {linhas.length === 0 ? (
            <p className="text-muted-foreground p-3">{t("agents.diff.identical")}</p>
          ) : (
            linhas.map((linha, i) => (
              <LinhaDoDiffDeContexto key={`${linha.antes ?? "-"}:${linha.depois ?? "-"}:${i}`} linha={linha} />
            ))
          )}
        </div>
      )}

      {!emConflito && (
        <div className="flex items-center gap-3">
          <Button
            className="cursor-pointer"
            disabled={resolvendo || jaResolvida || mudouPorFora}
            onClick={() => onResolver("approved")}
          >
            {t("review.approve")}
          </Button>
          <Button
            className="text-muted-foreground hover:text-foreground cursor-pointer"
            disabled={resolvendo || jaResolvida}
            onClick={() => onResolver("rejected")}
            variant="ghost"
          >
            {t("review.discard")}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * A revisão de uma resposta de Slack ou Teams: a mensagem a que se responde,
 * para onde vai, e o texto, que a pessoa pode reescrever antes de aprovar.
 *
 * A edição grava sozinha, como a dos achados. Só o texto muda: o destino é o
 * que o handler conferiu contra o que o Locum leu.
 */
function RevisaoDeMensagem({
  jaResolvida,
  navegar,
  onResolver,
  pendencia,
  resolvendo,
}: {
  jaResolvida: boolean;
  navegar: TelaProps["navegar"];
  onResolver: (decisao: "approved" | "rejected") => void;
  pendencia: Pendencia;
  resolvendo: boolean;
}) {
  const { t } = useTranslation();
  const carga = cargaDaMensagem(pendencia);
  const [texto, setTexto] = useState(carga.texto);
  const [gravando, setGravando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const gravado = useRef(carga.texto);

  useEffect(() => {
    if (texto === gravado.current || texto.trim() === "") return;
    const id = setTimeout(() => {
      setGravando(true);
      setErro(null);
      gravarTexto(pendencia.id, texto)
        .then(() => {
          gravado.current = texto;
        })
        .catch((e: unknown) => setErro(e instanceof Error ? e.message : String(e)))
        .finally(() => setGravando(false));
    }, 700);
    return () => clearTimeout(id);
  }, [texto, pendencia.id]);

  const vazia = texto.trim() === "";
  // Aprovar com edição ainda no relógio publicaria o texto antigo.
  const pendente = texto !== gravado.current;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4" data-locum-probe="revisao-mensagem">
      <div className="flex items-baseline gap-3">
        <Voltar navegar={navegar} />
        <span className="text-[13px] font-medium">{t(`inbox.message.${carga.servico}`)}</span>
        <span className="text-muted-foreground truncate font-mono text-xs">
          {carga.destino ?? t("inbox.message.chat")}
        </span>
        {carga.link && (
          <a
            className="text-muted-foreground hover:text-foreground ml-auto shrink-0 text-xs"
            href={carga.link}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink className="inline size-3" aria-hidden />{" "}
            {t(`review.message.open.${carga.servico}`)}
          </a>
        )}
      </div>

      {carga.assunto && (
        <figure className="superficie border-border rounded-lg border px-4 py-3">
          <figcaption className="text-muted-foreground mb-1 text-xs">
            {carga.autor ? t("review.message.replyingToAuthor", { author: carga.autor }) : t("review.message.replyingTo")}
          </figcaption>
          <blockquote className="text-sm leading-relaxed whitespace-pre-wrap">{carga.assunto}</blockquote>
        </figure>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs">{t("review.message.text")}</span>
        <textarea
          className="focus:border-ring border-border bg-background ia-borda w-full resize-y rounded-lg border px-3 py-2.5 text-sm leading-relaxed outline-none transition-colors duration-200"
          data-locum-mensagem-texto=""
          disabled={jaResolvida}
          maxLength={3000}
          onChange={(e) => setTexto(e.target.value)}
          rows={Math.min(14, Math.max(4, Math.ceil(texto.length / 80)))}
          value={texto}
        />
      </label>

      {erro && <p className="text-destructive text-xs">{erro}</p>}

      <div className="flex items-center gap-3">
        <Button
          className="cursor-pointer"
          disabled={resolvendo || jaResolvida || vazia || pendente || gravando}
          onClick={() => onResolver("approved")}
        >
          {t("review.message.send")}
        </Button>
        <Button
          className="text-muted-foreground hover:text-foreground cursor-pointer"
          disabled={resolvendo || jaResolvida}
          onClick={() => onResolver("rejected")}
          variant="ghost"
        >
          {t("inbox.discard")}
        </Button>

        <span className="text-muted-foreground ml-auto text-xs">
          {vazia
            ? t("review.message.empty")
            : gravando || pendente
              ? t("review.saving")
              : texto !== carga.texto
                ? t("review.saved")
                : t("review.message.hint")}
        </span>

        <button
          className="text-muted-foreground hover:text-foreground cursor-pointer text-xs"
          onClick={() => navegar("runs", pendencia.runId)}
          type="button"
        >
          {t("review.see_run")}
        </button>
      </div>
    </div>
  );
}

/**
 * A revisão de uma tarefa para abrir num tracker ou de um resumo de canais:
 * o texto inteiro, como vai sair, para ler antes de aprovar.
 *
 * Sem edição aqui: o corpo da tarefa carrega seções e links que o handler
 * montou, e o resumo é só dado por lido.
 */
function RevisaoDeDocumento({
  jaResolvida,
  navegar,
  onResolver,
  pendencia,
  resolvendo,
}: {
  jaResolvida: boolean;
  navegar: TelaProps["navegar"];
  onResolver: (decisao: "approved" | "rejected") => void;
  pendencia: Pendencia;
  resolvendo: boolean;
}) {
  const { t } = useTranslation();
  const carga = cargaDoDocumento(pendencia, t);
  const digest = carga.tipo === "digest" ? lerDigest(pendencia.payload) : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4" data-locum-probe="revisao-documento">
      <div className="flex items-baseline gap-3">
        <Voltar navegar={navegar} />
        <span className="text-[13px] font-medium">{t(`inbox.document.${carga.tipo}`)}</span>
        {carga.detalhe && (
          <span className="text-muted-foreground truncate font-mono text-xs">{carga.detalhe}</span>
        )}
        {carga.link && (
          <a
            className="text-muted-foreground hover:text-foreground ml-auto shrink-0 text-xs"
            href={carga.link}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink className="inline size-3" aria-hidden /> {t("common.open_github")}
          </a>
        )}
      </div>

      {digest === null && carga.titulo && <h1 className="text-lg font-semibold tracking-tight">{carga.titulo}</h1>}

      {digest !== null ? (
        <div className="max-h-[65vh] overflow-auto" data-locum-documento-corpo="">
          <LeituraDoDigest digest={digest} />
        </div>
      ) : (
        <div
          className="superficie border-border max-h-[60vh] overflow-auto rounded-lg border px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap"
          data-locum-documento-corpo=""
        >
          {carga.corpo}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button
          className="cursor-pointer"
          disabled={resolvendo || jaResolvida}
          onClick={() => onResolver("approved")}
        >
          {t(`review.document.approve.${carga.tipo}`)}
        </Button>
        <Button
          className="text-muted-foreground hover:text-foreground cursor-pointer"
          disabled={resolvendo || jaResolvida}
          onClick={() => onResolver("rejected")}
          variant="ghost"
        >
          {t("inbox.discard")}
        </Button>

        <button
          className="text-muted-foreground hover:text-foreground ml-auto cursor-pointer text-xs"
          onClick={() => navegar("runs", pendencia.runId)}
          type="button"
        >
          {t("review.see_run")}
        </button>
      </div>
    </div>
  );
}

const SINAL_DO_DIFF: Record<LinhaDoDiff["tipo"], string> = { igual: " ", saiu: "-", entrou: "+" };

function LinhaDoDiffDeContexto({ linha }: { linha: LinhaDoDiff }) {
  return (
    <div
      className={cn(
        "flex gap-3 whitespace-pre px-3 py-0.5",
        linha.tipo === "saiu" && "bg-destructive/15 text-destructive-foreground",
        linha.tipo === "entrou" && "bg-primary/15",
        linha.tipo === "igual" && "text-muted-foreground",
      )}
      data-locum-linha={linha.tipo}
    >
      <span className="w-10 shrink-0 text-right tabular-nums opacity-60">{linha.antes ?? ""}</span>
      <span className="w-10 shrink-0 text-right tabular-nums opacity-60">{linha.depois ?? ""}</span>
      <span className="w-3 shrink-0">{SINAL_DO_DIFF[linha.tipo]}</span>
      <span className="min-w-0">{linha.texto}</span>
    </div>
  );
}

function Voltar({ navegar }: { navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  return (
    <button
      className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 text-sm"
      onClick={() => navegar("inbox")}
      type="button"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {t("review.back")}
    </button>
  );
}
