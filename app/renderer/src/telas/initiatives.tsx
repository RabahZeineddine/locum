import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRead, type ReadResult } from "@/lib/bridge";
import type { TelaProps } from "../rotas";

type LinhaDeIniciativa = ReadResult<"initiatives.list">[number];
type IniciativaDetalhada = NonNullable<ReadResult<"initiatives.detail">>;

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

  return (
    <div className="flex flex-col gap-3">
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
        <span className="ml-auto">
          <Badge variant="outline">{t(`initiatives.status.${iniciativa.status}`)}</Badge>
        </span>
      </div>

      <TirasDeAba aba={aba} navegar={navegar} slug={slug} />

      {aba === "context" && <AbaContexto slug={slug} />}
      {aba === "agents" && <AbaAgents iniciativa={iniciativa} />}
      {aba === "integrations" && <AbaIntegrations iniciativa={iniciativa} />}
      {aba === "runs" && <AbaRuns initiativeId={iniciativa.id} />}
      {aba === "actions" && <AbaActions />}
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

function AbaAgents({ iniciativa }: { iniciativa: IniciativaDetalhada }) {
  const { t } = useTranslation();
  const agentes = iniciativa.agents;
  return (
    <div data-locum-probe="initiative-agents">
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
    </div>
  );
}

function AbaIntegrations({ iniciativa }: { iniciativa: IniciativaDetalhada }) {
  const { t } = useTranslation();
  const servidores = iniciativa.servers;
  return (
    <div data-locum-probe="initiative-integrations">
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

/** Prompts e copia (Fatia 5b): aqui so um lugar reservado, sem canal proprio. */
function AbaActions() {
  const { t } = useTranslation();
  return (
    <p className="text-muted-foreground text-sm" data-locum-probe="initiative-actions">
      {t("initiatives.detail.actions.empty")}
    </p>
  );
}

function Aviso({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground text-sm" data-locum-probe="initiative">
      {children}
    </p>
  );
}
