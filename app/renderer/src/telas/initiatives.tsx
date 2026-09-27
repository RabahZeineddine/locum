import { ArrowLeft, Copy } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { call, useRead, type ReadResult } from "@/lib/bridge";
import type { TelaProps } from "../rotas";

type LinhaDeIniciativa = ReadResult<"initiatives.list">[number];
type IniciativaDetalhada = NonNullable<ReadResult<"initiatives.detail">>;
type Prompt = ReadResult<"prompts.list">[number];

const classeDoCampo = "border-border bg-background w-full rounded border px-2 py-1 text-sm";

/** As cinco abas do detalhe. So `context` le e escreve de verdade nesta fatia:
 * as outras quatro so mostram o que o detalhe composto ja trouxe. */
const ABAS = ["context", "agents", "integrations", "runs", "actions"] as const;
type Aba = (typeof ABAS)[number];

function ehAba(valor: string): valor is Aba {
  return (ABAS as readonly string[]).includes(valor);
}

/**
 * A tela de iniciativas, lista e detalhe.
 *
 * O detalhe carrega o slug e a aba juntos, separados pela primeira barra: o
 * roteador do layout so separa o destino do resto, e quem sabe que o resto e
 * `slug/aba` e esta tela. Sem aba no hash, `context` e o padrao: e a unica que
 * funciona de verdade nesta fatia, entao e o que faz sentido ver primeiro.
 */
export function Initiatives({ detalhe, navegar }: TelaProps) {
  if (detalhe === null) return <Lista navegar={navegar} />;

  const barra = detalhe.indexOf("/");
  const slug = barra === -1 ? detalhe : detalhe.slice(0, barra);
  const abaBruta = barra === -1 ? "" : detalhe.slice(barra + 1);
  const aba: Aba = ehAba(abaBruta) ? abaBruta : "context";

  return <DetalheDaIniciativa aba={aba} navegar={navegar} slug={slug} />;
}

/* ------------------------------------------------------------------ lista */

function Lista({ navegar }: { navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  const iniciativas = useRead("initiatives.list");
  const linhas = iniciativas.data ?? [];
  const [criando, setCriando] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div
          className="text-muted-foreground text-xs"
          data-estado={iniciativas.status}
          data-locum-probe="initiatives"
          data-total={linhas.length}
        >
          {iniciativas.status === "error"
            ? t("initiatives.list.refused", { message: iniciativas.error.message })
            : iniciativas.status === "loading"
              ? t("initiatives.list.loading")
              : t("initiatives.list.count", { count: linhas.length })}
        </div>
        <Button
          className="ml-auto cursor-pointer"
          data-locum-probe="initiative-new"
          onClick={() => setCriando((v) => !v)}
          size="sm"
          variant="secondary"
        >
          {t("initiatives.form.new")}
        </Button>
      </div>

      {criando && (
        <FormularioDeIniciativa
          aoSalvar={(slug) => {
            setCriando(false);
            navegar("initiatives", `${slug}/context`);
          }}
        />
      )}

      {iniciativas.status === "ready" && linhas.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("initiatives.list.empty")}</p>
      ) : (
        <ul className="divide-border border-border bg-card divide-y overflow-hidden rounded-lg border">
          {linhas.map((iniciativa) => (
            <LinhaDaLista iniciativa={iniciativa} key={iniciativa.slug} navegar={navegar} />
          ))}
        </ul>
      )}
    </div>
  );
}

function LinhaDaLista({
  iniciativa,
  navegar,
}: {
  iniciativa: LinhaDeIniciativa;
  navegar: TelaProps["navegar"];
}) {
  const { t } = useTranslation();
  return (
    <li>
      <button
        className="hover:bg-accent/40 focus-visible:ring-ring w-full cursor-pointer px-4 py-3 text-left transition-colors duration-200 focus-visible:ring-2 focus-visible:-outline-offset-2"
        data-locum-initiative={iniciativa.slug}
        onClick={() => navegar("initiatives", `${iniciativa.slug}/context`)}
        type="button"
      >
        <div className="flex items-baseline gap-2.5">
          <span className="font-medium text-[15px] tracking-tight">{iniciativa.title}</span>
          <span className="text-muted-foreground font-mono text-xs">{iniciativa.slug}</span>
          <span className="ml-auto shrink-0">
            <Badge variant="outline">{t(`initiatives.status.${iniciativa.status}`)}</Badge>
          </span>
        </div>
        <p className="text-muted-foreground mt-1.5 truncate text-xs">{iniciativa.objective}</p>
      </button>
    </li>
  );
}

/* ----------------------------------------------------------------- detalhe */

function DetalheDaIniciativa({
  aba,
  navegar,
  slug,
}: {
  aba: Aba;
  navegar: TelaProps["navegar"];
  slug: string;
}) {
  const { t } = useTranslation();
  const detalhe = useRead("initiatives.detail", slug);
  const [editando, setEditando] = useState(false);

  if (detalhe.status === "error") {
    return <Aviso>{t("initiatives.detail.refused", { message: detalhe.error.message })}</Aviso>;
  }
  if (detalhe.status === "loading") {
    return <Aviso>{t("initiatives.detail.loading")}</Aviso>;
  }
  if (!detalhe.data) {
    return <Aviso>{t("initiatives.detail.missing", { slug })}</Aviso>;
  }

  const iniciativa = detalhe.data;

  return (
    <div
      className="flex flex-col gap-4"
      data-locum-probe="initiative"
      data-slug={slug}
      data-tab={aba}
      data-titulo={iniciativa.title}
    >
      <div className="flex items-center gap-3">
        <Button onClick={() => navegar("initiatives")} size="sm" variant="ghost">
          <ArrowLeft className="size-4" />
          {t("initiatives.detail.back")}
        </Button>
        <span className="font-medium text-sm">{iniciativa.title}</span>
        <span className="text-muted-foreground text-xs">{slug}</span>
        <span className="ml-auto flex items-center gap-2">
          <Badge variant="outline">{t(`initiatives.status.${iniciativa.status}`)}</Badge>
          <Button
            className="cursor-pointer"
            data-locum-probe="initiative-edit"
            onClick={() => setEditando((v) => !v)}
            size="sm"
            variant="ghost"
          >
            {t("initiatives.form.edit")}
          </Button>
        </span>
      </div>

      {editando && (
        <FormularioDeIniciativa aoSalvar={() => setEditando(false)} iniciativa={iniciativa} />
      )}

      <TirasDeAba aba={aba} navegar={navegar} slug={slug} />

      {aba === "context" && <AbaContexto slug={slug} />}
      {aba === "agents" && <AbaAgents iniciativa={iniciativa} />}
      {aba === "integrations" && <AbaIntegrations iniciativa={iniciativa} />}
      {aba === "runs" && <AbaRuns initiativeId={iniciativa.id} />}
      {aba === "actions" && <AbaActions initiativeId={iniciativa.id} />}
    </div>
  );
}

function TirasDeAba({
  aba,
  navegar,
  slug,
}: {
  aba: Aba;
  navegar: TelaProps["navegar"];
  slug: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="border-border flex gap-1 border-b" data-locum-probe="initiative-tabs">
      {ABAS.map((candidata) => (
        <button
          className={
            candidata === aba
              ? "border-foreground text-foreground -mb-px cursor-pointer border-b-2 px-3 py-2 text-sm font-medium"
              : "text-muted-foreground hover:text-foreground -mb-px cursor-pointer border-b-2 border-transparent px-3 py-2 text-sm"
          }
          data-locum-tab={candidata}
          key={candidata}
          onClick={() => navegar("initiatives", `${slug}/${candidata}`)}
          type="button"
        >
          {t(`initiatives.detail.tabs.${candidata}`)}
        </button>
      ))}
    </div>
  );
}

/** A unica aba que le de verdade nesta fatia: o `context.md`, so leitura.
 * Qualquer mudanca passa por `proposeContextUpdate`, que e trabalho da 5b. */
function AbaContexto({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const contexto = useRead("initiatives.context", slug);

  if (contexto.status === "error") {
    return <Aviso>{t("initiatives.detail.refused", { message: contexto.error.message })}</Aviso>;
  }
  if (contexto.status === "loading") {
    return <Aviso>{t("initiatives.detail.loading")}</Aviso>;
  }

  const { content, hash } = contexto.data;
  return (
    <div data-hash={hash ?? ""} data-locum-probe="initiative-context">
      {content === null ? (
        <p className="text-muted-foreground text-sm">{t("initiatives.detail.context.empty")}</p>
      ) : (
        <pre className="border-border bg-card overflow-auto rounded-lg border p-4 text-sm whitespace-pre-wrap">
          {content}
        </pre>
      )}
    </div>
  );
}

/**
 * Criar ou editar uma iniciativa. `upsert` e o mesmo canal para os dois casos:
 * uma segunda gravacao com o mesmo slug so atualiza os campos, e o `context.md`
 * fica intocado depois da primeira vez, entao editar nunca pisa no contexto.
 */
function FormularioDeIniciativa({
  aoSalvar,
  iniciativa,
}: {
  aoSalvar: (slug: string) => void;
  iniciativa?: IniciativaDetalhada;
}) {
  const { t } = useTranslation();
  const [slug, setSlug] = useState(iniciativa?.slug ?? "");
  const [title, setTitle] = useState(iniciativa?.title ?? "");
  const [objective, setObjective] = useState(iniciativa?.objective ?? "");
  const [doneCriteria, setDoneCriteria] = useState(iniciativa?.doneCriteria ?? "");
  const [goalRef, setGoalRef] = useState(iniciativa?.goalRef ?? "");
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const salvar = (): void => {
    setOcupado(true);
    setErro(null);
    call("initiatives.upsert", {
      slug: slug.trim(),
      title: title.trim(),
      objective: objective.trim(),
      doneCriteria: doneCriteria.trim(),
      goalRef: goalRef.trim().length > 0 ? goalRef.trim() : null,
    })
      .then((linha) => aoSalvar(linha.slug))
      .catch((err: unknown) => setErro(err instanceof Error ? err.message : String(err)))
      .finally(() => setOcupado(false));
  };

  return (
    <div
      className="border-border bg-card flex flex-col gap-2 rounded-lg border p-4"
      data-locum-probe="initiative-form"
    >
      <label className="text-xs" htmlFor="initiative-slug">
        {t("initiatives.form.slug")}
      </label>
      <input
        className={classeDoCampo}
        disabled={iniciativa !== undefined}
        id="initiative-slug"
        onChange={(e) => setSlug(e.target.value)}
        value={slug}
      />

      <label className="text-xs" htmlFor="initiative-title">
        {t("initiatives.form.titleLabel")}
      </label>
      <input className={classeDoCampo} id="initiative-title" onChange={(e) => setTitle(e.target.value)} value={title} />

      <label className="text-xs" htmlFor="initiative-objective">
        {t("initiatives.form.objective")}
      </label>
      <textarea
        className={classeDoCampo}
        id="initiative-objective"
        onChange={(e) => setObjective(e.target.value)}
        rows={2}
        value={objective}
      />

      <label className="text-xs" htmlFor="initiative-done-criteria">
        {t("initiatives.form.doneCriteria")}
      </label>
      <textarea
        className={classeDoCampo}
        id="initiative-done-criteria"
        onChange={(e) => setDoneCriteria(e.target.value)}
        rows={2}
        value={doneCriteria}
      />

      <label className="text-xs" htmlFor="initiative-goal-ref">
        {t("initiatives.form.goalRef")}
      </label>
      <input
        className={classeDoCampo}
        id="initiative-goal-ref"
        onChange={(e) => setGoalRef(e.target.value)}
        value={goalRef}
      />

      {erro && <span className="text-sev-critical text-xs">{erro}</span>}

      <Button
        className="w-fit cursor-pointer"
        data-locum-probe="initiative-form-save"
        disabled={ocupado || slug.trim().length === 0 || title.trim().length === 0}
        onClick={salvar}
        size="sm"
        variant="secondary"
      >
        {t("common.save")}
      </Button>
    </div>
  );
}

function AbaAgents({ iniciativa }: { iniciativa: IniciativaDetalhada }) {
  const { t } = useTranslation();
  const agentes = iniciativa.agents;
  const todos = useRead("agents.overview");
  const [selecionado, setSelecionado] = useState("");
  const [ocupado, setOcupado] = useState(false);

  const disponiveis = (todos.data ?? []).filter(
    (agent) => !agentes.some((ligado) => ligado.id === agent.id),
  );

  const vincular = (): void => {
    if (selecionado.length === 0) return;
    setOcupado(true);
    call("initiatives.linkAgent", selecionado, iniciativa.slug)
      .then(() => setSelecionado(""))
      .finally(() => setOcupado(false));
  };

  return (
    <div className="flex flex-col gap-3" data-locum-probe="initiative-agents">
      {agentes.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("initiatives.detail.agents.empty")}</p>
      ) : (
        <ul className="divide-border border-border bg-card divide-y overflow-hidden rounded-lg border">
          {agentes.map((agent) => (
            <li className="px-4 py-2 text-sm" data-locum-agent={agent.id} key={agent.id}>
              {agent.name}
            </li>
          ))}
        </ul>
      )}

      {disponiveis.length > 0 && (
        <div className="flex items-center gap-2" data-locum-probe="initiative-agents-form">
          <select
            className={classeDoCampo}
            onChange={(e) => setSelecionado(e.target.value)}
            value={selecionado}
          >
            <option value="">{t("initiatives.form.selectAgent")}</option>
            {disponiveis.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <Button
            className="cursor-pointer"
            disabled={ocupado || selecionado.length === 0}
            onClick={vincular}
            size="sm"
            variant="secondary"
          >
            {t("initiatives.form.link")}
          </Button>
        </div>
      )}
    </div>
  );
}

function AbaIntegrations({ iniciativa }: { iniciativa: IniciativaDetalhada }) {
  const { t } = useTranslation();
  const servidores = iniciativa.servers;
  const todos = useRead("mcp.list");
  const [servidorNovo, setServidorNovo] = useState("");
  const [repoPathNovo, setRepoPathNovo] = useState("");
  const [linkUrlNova, setLinkUrlNova] = useState("");
  const [linkLabelNova, setLinkLabelNova] = useState("");
  const [ocupado, setOcupado] = useState(false);

  const disponiveis = (todos.data ?? [])
    .map((servidor) => servidor.config.name)
    .filter((nome) => !servidores.includes(nome));

  const adicionarServidor = (): void => {
    if (servidorNovo.length === 0) return;
    setOcupado(true);
    call("initiatives.setServers", iniciativa.slug, [...servidores, servidorNovo])
      .then(() => setServidorNovo(""))
      .finally(() => setOcupado(false));
  };

  const adicionarWorkspace = (): void => {
    const repoPath = repoPathNovo.trim();
    if (repoPath.length === 0) return;
    setOcupado(true);
    const atuais = iniciativa.workspaces.map((w) => ({
      repoPath: w.repoPath,
      worktreePath: w.worktreePath,
      branch: w.branch,
      label: w.label,
    }));
    call("initiatives.setWorkspaces", iniciativa.slug, [...atuais, { repoPath }])
      .then(() => setRepoPathNovo(""))
      .finally(() => setOcupado(false));
  };

  const adicionarLink = (): void => {
    const url = linkUrlNova.trim();
    if (url.length === 0) return;
    setOcupado(true);
    call("initiatives.addLink", iniciativa.slug, {
      kind: "other",
      url,
      label: linkLabelNova.trim().length > 0 ? linkLabelNova.trim() : null,
    })
      .then(() => {
        setLinkUrlNova("");
        setLinkLabelNova("");
      })
      .finally(() => setOcupado(false));
  };

  const removerLink = (linkId: string): void => {
    setOcupado(true);
    call("initiatives.removeLink", iniciativa.slug, linkId).finally(() => setOcupado(false));
  };

  return (
    <div className="flex flex-col gap-4" data-locum-probe="initiative-integrations">
      <div>
        {servidores.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("initiatives.detail.integrations.empty")}</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {servidores.map((servidor) => (
              <Badge data-locum-server={servidor} key={servidor} variant="outline">
                {servidor}
              </Badge>
            ))}
          </div>
        )}
        {disponiveis.length > 0 && (
          <div className="mt-2 flex items-center gap-2" data-locum-probe="initiative-servers-form">
            <select
              className={classeDoCampo}
              onChange={(e) => setServidorNovo(e.target.value)}
              value={servidorNovo}
            >
              <option value="">{t("initiatives.form.selectServer")}</option>
              {disponiveis.map((nome) => (
                <option key={nome} value={nome}>
                  {nome}
                </option>
              ))}
            </select>
            <Button
              className="cursor-pointer"
              disabled={ocupado || servidorNovo.length === 0}
              onClick={adicionarServidor}
              size="sm"
              variant="secondary"
            >
              {t("initiatives.form.link")}
            </Button>
          </div>
        )}
      </div>

      <div>
        <p className="text-muted-foreground mb-1.5 text-xs">{t("initiatives.form.workspaces")}</p>
        {iniciativa.workspaces.length > 0 && (
          <ul className="divide-border border-border bg-card mb-2 divide-y overflow-hidden rounded-lg border">
            {iniciativa.workspaces.map((workspace) => (
              <li className="px-4 py-2 font-mono text-xs" key={workspace.id}>
                {workspace.repoPath}
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2" data-locum-probe="initiative-workspaces-form">
          <input
            className={classeDoCampo}
            onChange={(e) => setRepoPathNovo(e.target.value)}
            placeholder={t("initiatives.form.repoPath")}
            value={repoPathNovo}
          />
          <Button
            className="cursor-pointer"
            disabled={ocupado || repoPathNovo.trim().length === 0}
            onClick={adicionarWorkspace}
            size="sm"
            variant="secondary"
          >
            {t("initiatives.form.add")}
          </Button>
        </div>
      </div>

      <div>
        <p className="text-muted-foreground mb-1.5 text-xs">{t("initiatives.form.links")}</p>
        {iniciativa.links.length > 0 && (
          <ul className="divide-border border-border bg-card mb-2 divide-y overflow-hidden rounded-lg border">
            {iniciativa.links.map((link) => (
              <li className="flex items-center gap-2 px-4 py-2 text-xs" key={link.id}>
                <a className="truncate underline" href={link.url} rel="noreferrer" target="_blank">
                  {link.label ?? link.url}
                </a>
                <Button
                  className="ml-auto cursor-pointer"
                  disabled={ocupado}
                  onClick={() => removerLink(link.id)}
                  size="sm"
                  variant="ghost"
                >
                  {t("initiatives.form.remove")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2" data-locum-probe="initiative-links-form">
          <input
            className={classeDoCampo}
            onChange={(e) => setLinkUrlNova(e.target.value)}
            placeholder={t("initiatives.form.linkUrl")}
            value={linkUrlNova}
          />
          <input
            className={classeDoCampo}
            onChange={(e) => setLinkLabelNova(e.target.value)}
            placeholder={t("initiatives.form.linkLabel")}
            value={linkLabelNova}
          />
          <Button
            className="cursor-pointer"
            disabled={ocupado || linkUrlNova.trim().length === 0}
            onClick={adicionarLink}
            size="sm"
            variant="secondary"
          >
            {t("initiatives.form.add")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AbaRuns({ initiativeId }: { initiativeId: string }) {
  const { t } = useTranslation();
  const runs = useRead("runs.list", { initiativeId });
  const linhas = runs.data ?? [];

  return (
    <div data-locum-probe="initiative-runs" data-total={linhas.length}>
      {runs.status === "error" ? (
        <p className="text-muted-foreground text-sm">
          {t("initiatives.detail.runs.refused", { message: runs.error.message })}
        </p>
      ) : runs.status === "loading" ? (
        <p className="text-muted-foreground text-sm">{t("initiatives.detail.runs.loading")}</p>
      ) : linhas.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("initiatives.detail.runs.empty")}</p>
      ) : (
        <ul className="divide-border border-border bg-card divide-y overflow-hidden rounded-lg border">
          {linhas.map((run) => (
            <li className="px-4 py-2 text-sm" data-locum-run={run.id} key={run.id}>
              <span className="font-medium">{run.agentName}</span>{" "}
              <span className="text-muted-foreground text-xs">{run.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Prompts salvos desta iniciativa, para copiar o corpo direto. */
function AbaActions({ initiativeId }: { initiativeId: string }) {
  const { t } = useTranslation();
  const prompts = useRead("prompts.list", initiativeId);
  const linhas = prompts.data ?? [];

  if (prompts.status === "loading") {
    return <p className="text-muted-foreground text-sm">{t("initiatives.detail.loading")}</p>;
  }
  if (prompts.status === "error") {
    return (
      <p className="text-muted-foreground text-sm">
        {t("initiatives.detail.refused", { message: prompts.error.message })}
      </p>
    );
  }

  return (
    <div data-locum-probe="initiative-actions" data-total={linhas.length}>
      {linhas.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("initiatives.detail.actions.empty")}</p>
      ) : (
        <ul className="divide-border border-border bg-card divide-y overflow-hidden rounded-lg border">
          {linhas.map((prompt) => (
            <LinhaDePrompt key={prompt.id} prompt={prompt} />
          ))}
        </ul>
      )}
    </div>
  );
}

function LinhaDePrompt({ prompt }: { prompt: Prompt }) {
  const { t } = useTranslation();
  const [copiado, setCopiado] = useState(false);

  const copiar = (): void => {
    navigator.clipboard.writeText(prompt.body).then(() => {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1500);
    });
  };

  return (
    <li className="flex items-start gap-2 px-4 py-2 text-sm" data-locum-prompt={prompt.name}>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{prompt.name}</p>
        <p className="text-muted-foreground truncate text-xs">{prompt.body}</p>
      </div>
      <Button className="shrink-0 cursor-pointer" onClick={copiar} size="sm" variant="ghost">
        <Copy className="size-3.5" />
        {t(copiado ? "initiatives.form.copied" : "initiatives.form.copy")}
      </Button>
    </li>
  );
}

function Aviso({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground text-sm" data-locum-probe="initiative">
      {children}
    </p>
  );
}
