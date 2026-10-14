import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { call, useRead, type ReadResult } from "@/lib/bridge";
import {
  listaDoTexto,
  podarFiltros,
  revisaoComoTexto,
  revisaoDoTexto,
  textoDaLista,
} from "@/lib/filtros-do-gatilho";
import { nomeDoPadrao, padraoDoRepo } from "@/lib/padrao-do-repo";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { PollFilters, TriggerConfig } from "../../../src/config/types";
import { Alternador, Campo, CAMPO, Minutos } from "./campos";

type Poll = Extract<TriggerConfig, { kind: "poll" }>;
type Previa = ReadResult<"triggers.previewGithub">;

/**
 * O editor do gatilho do GitHub: tudo o que decide qual pull request acorda o
 * agent, num lugar só. Cada seção diz em uma frase o que faz, e os filtros
 * vazios não vão para o cadastro, então um gatilho sem filtro continua
 * gravado como antes.
 *
 * Mexe só na configuração do rascunho. A prévia pergunta ao GitHub o que
 * entraria com ela, ainda sem salvar, e não grava nada.
 */
export function GatilhoDoGithub({
  config,
  trocar,
  triggerId,
}: {
  config: Poll;
  trocar: (c: TriggerConfig) => void;
  triggerId?: string;
}) {
  const { t } = useTranslation();
  const filtros: PollFilters = config.filters ?? {};

  const mudarFiltros = (f: PollFilters): void => {
    const { filters: _antigo, ...resto } = config;
    const podado = podarFiltros(f);
    trocar(podado === undefined ? resto : { ...resto, filters: podado });
  };

  return (
    <div className="flex min-w-0 flex-col gap-4" data-locum-gatilho-github="">
      <Secao ajuda={t("automations.github.repos.help")} titulo={t("automations.github.repos.title")}>
        <Campo rotulo={t("automations.triggers.poll.owner")}>
          <input
            className={CAMPO}
            data-locum-gh-dono=""
            onChange={(e) => {
              const owner = e.target.value.trim();
              const { owner: _antigo, ...resto } = config;
              trocar(owner === "" ? resto : { ...resto, owner });
            }}
            value={config.owner ?? ""}
          />
        </Campo>
        <CampoDeTexto
          dica={t("automations.github.repos.hint")}
          marca="gh-repo"
          rotulo={t("automations.github.repos.names")}
          trocar={(texto) => trocar({ ...config, repoMatch: texto.trim() === "" ? ".*" : padraoDoRepo(texto) })}
          valor={config.repoMatch === ".*" ? "" : nomeDoPadrao(config.repoMatch)}
        />
        <details className="text-muted-foreground text-xs">
          <summary className="cursor-pointer">{t("automations.github.repos.advanced")}</summary>
          <p className="mt-1">{t("automations.github.repos.advancedHow")}</p>
        </details>
      </Secao>

      <Secao ajuda={t("automations.github.people.help")} titulo={t("automations.github.people.title")}>
        <Campo rotulo={t("automations.triggers.poll.authorship")}>
          <select
            className={cn(CAMPO, "truncate")}
            data-locum-gh-autoria=""
            onChange={(e) => trocar({ ...config, authorship: e.target.value as Poll["authorship"] })}
            value={config.authorship}
          >
            {(["others", "mine", "any"] as const).map((a) => (
              <option key={a} value={a}>
                {t(`automations.triggers.poll.${a}`)}
              </option>
            ))}
          </select>
        </Campo>
        <CampoDeTexto
          dica={t("automations.github.people.authorsHint")}
          marca="gh-autores"
          rotulo={t("automations.github.people.authorsInclude")}
          trocar={(texto) => mudarFiltros({ ...filtros, authors: { ...filtros.authors, include: listaDoTexto(texto) } })}
          valor={textoDaLista(filtros.authors?.include)}
        />
        <CampoDeTexto
          marca="gh-autores-fora"
          rotulo={t("automations.github.people.authorsExclude")}
          trocar={(texto) => mudarFiltros({ ...filtros, authors: { ...filtros.authors, exclude: listaDoTexto(texto) } })}
          valor={textoDaLista(filtros.authors?.exclude)}
        />
        <CampoDeTexto
          dica={t("automations.github.people.reviewHint")}
          marca="gh-review"
          rotulo={t("automations.github.people.review")}
          trocar={(texto) => mudarFiltros({ ...filtros, reviewRequested: revisaoDoTexto(texto) })}
          valor={revisaoComoTexto(filtros.reviewRequested)}
        />
        <CampoDeTexto
          dica={t("automations.github.people.teamsHint")}
          marca="gh-times"
          rotulo={t("automations.github.people.teamMembers")}
          trocar={(texto) => mudarFiltros({ ...filtros, teamMembers: listaDoTexto(texto) })}
          valor={textoDaLista(filtros.teamMembers)}
        />
      </Secao>

      <Secao ajuda={t("automations.github.labels.help")} titulo={t("automations.github.labels.title")}>
        <CampoDeTexto
          dica={t("automations.github.labels.hint")}
          marca="gh-labels"
          rotulo={t("automations.github.labels.include")}
          trocar={(texto) => mudarFiltros({ ...filtros, labels: { ...filtros.labels, include: listaDoTexto(texto) } })}
          valor={textoDaLista(filtros.labels?.include)}
        />
        <CampoDeTexto
          marca="gh-labels-fora"
          rotulo={t("automations.github.labels.exclude")}
          trocar={(texto) => mudarFiltros({ ...filtros, labels: { ...filtros.labels, exclude: listaDoTexto(texto) } })}
          valor={textoDaLista(filtros.labels?.exclude)}
        />
      </Secao>

      <Secao ajuda={t("automations.github.base.help")} titulo={t("automations.github.base.title")}>
        <CampoDeTexto
          dica={t("automations.github.base.hint")}
          marca="gh-base"
          rotulo={t("automations.github.base.branches")}
          trocar={(texto) => mudarFiltros({ ...filtros, baseBranches: listaDoTexto(texto) })}
          valor={textoDaLista(filtros.baseBranches)}
        />
      </Secao>

      <Secao ajuda={t("automations.github.files.help")} titulo={t("automations.github.files.title")}>
        <CampoDeTexto
          dica={t("automations.github.files.includeHint")}
          marca="gh-arquivos"
          rotulo={t("automations.github.files.include")}
          trocar={(texto) => mudarFiltros({ ...filtros, paths: { ...filtros.paths, include: listaDoTexto(texto) } })}
          valor={textoDaLista(filtros.paths?.include)}
        />
        <CampoDeTexto
          dica={t("automations.github.files.excludeHint")}
          marca="gh-arquivos-fora"
          rotulo={t("automations.github.files.exclude")}
          trocar={(texto) => mudarFiltros({ ...filtros, paths: { ...filtros.paths, exclude: listaDoTexto(texto) } })}
          valor={textoDaLista(filtros.paths?.exclude)}
        />
        <Campo rotulo={t("automations.github.files.maxLines")}>
          <input
            className={cn(CAMPO, "w-28")}
            data-locum-gh-linhas=""
            min={1}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              mudarFiltros({ ...filtros, maxChangedLines: Number.isFinite(n) && n >= 1 ? n : undefined });
            }}
            placeholder={t("automations.github.files.noLimit")}
            type="number"
            value={filtros.maxChangedLines ?? ""}
          />
        </Campo>
      </Secao>

      <Secao ajuda={t("automations.github.drafts.help")} titulo={t("automations.github.drafts.title")}>
        <Alternador
          ligado={config.includeDrafts}
          rotulo={t("automations.github.drafts.include")}
          trocar={(includeDrafts) => trocar({ ...config, includeDrafts })}
        />
      </Secao>

      <Secao ajuda={t("automations.github.frequency.help")} titulo={t("automations.github.frequency.title")}>
        <Minutos
          rotulo={t("automations.panel.everyMinutes")}
          trocar={(everyMinutes) => trocar({ ...config, everyMinutes })}
          valor={config.everyMinutes}
        />
      </Secao>

      <PreviaDoGatilho config={config} />
      <DescartesReais triggerId={triggerId} />
    </div>
  );
}

function Secao({ titulo, ajuda, children }: { titulo: string; ajuda: string; children: ReactNode }) {
  return (
    <section className="border-border flex min-w-0 flex-col gap-2 border-t pt-3">
      <h4 className="font-medium text-sm">{titulo}</h4>
      <p className="text-muted-foreground text-xs">{ajuda}</p>
      {children}
    </section>
  );
}

/**
 * Campo de lista em texto livre. Guarda o que foi digitado, e não a lista de
 * volta: reescrever o texto a partir da lista comeria a vírgula e o espaço no
 * meio da digitação.
 */
function CampoDeTexto({
  rotulo,
  dica,
  marca,
  valor,
  trocar,
}: {
  rotulo: string;
  dica?: string;
  marca: string;
  valor: string;
  trocar: (texto: string) => void;
}) {
  const [texto, setTexto] = useState(valor);
  return (
    <Campo rotulo={rotulo}>
      <input
        autoComplete="off"
        className={cn(CAMPO, "font-mono text-xs")}
        data-locum-campo={marca}
        onChange={(e) => {
          setTexto(e.target.value);
          trocar(e.target.value);
        }}
        placeholder={dica}
        spellCheck={false}
        value={texto}
      />
    </Campo>
  );
}

/* ------------------------------------------------------------------- prévia */

type EstadoDaPrevia =
  | { fase: "parada" }
  | { fase: "carregando" }
  | { fase: "pronta"; previa: Previa }
  | { fase: "erro"; mensagem: string };

function PreviaDoGatilho({ config }: { config: Poll }) {
  const { t } = useTranslation();
  const [estado, setEstado] = useState<EstadoDaPrevia>({ fase: "parada" });

  // A lista é do que estava na tela quando se clicou: mexer num filtro a deixaria
  // contando uma história que o formulário já não conta.
  // Resposta que chega depois de o formulário mudar é ignorada: cada pedido
  // tem um número, e mexer no formulário invalida o que está em voo.
  const pedido = useRef(0);
  const chave = JSON.stringify(config);
  useEffect(() => {
    pedido.current += 1;
    setEstado({ fase: "parada" });
  }, [chave]);

  const ver = (): void => {
    const meu = ++pedido.current;
    setEstado({ fase: "carregando" });
    call("triggers.previewGithub", config).then(
      (previa) => {
        if (meu === pedido.current) setEstado({ fase: "pronta", previa });
      },
      (e: unknown) => {
        if (meu === pedido.current) setEstado({ fase: "erro", mensagem: e instanceof Error ? e.message : String(e) });
      },
    );
  };

  return (
    <section className="border-border flex min-w-0 flex-col gap-2 border-t pt-3" data-locum-previa={estado.fase}>
      <h4 className="font-medium text-sm">{t("automations.github.preview.title")}</h4>
      <p className="text-muted-foreground text-xs">{t("automations.github.preview.help")}</p>
      <Button
        className="cursor-pointer self-start"
        data-locum-previa-ver=""
        disabled={estado.fase === "carregando"}
        onClick={ver}
        size="sm"
        variant="secondary"
      >
        {t(estado.fase === "carregando" ? "automations.github.preview.loading" : "automations.github.preview.button")}
      </Button>

      {estado.fase === "erro" ? (
        <p className="text-destructive text-xs" data-locum-previa-erro={estado.mensagem}>
          {t("automations.github.preview.failed", { message: estado.mensagem })}
        </p>
      ) : null}

      {estado.fase === "pronta" ? (
        estado.previa.itens.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("automations.github.preview.empty")}</p>
        ) : (
          <>
            <p className="text-muted-foreground text-xs">
              {t("automations.github.preview.summary", {
                enter: estado.previa.itens.filter((i) => i.entra).length,
                total: estado.previa.itens.length,
              })}
              {estado.previa.cortada ? ` ${t("automations.github.preview.cut")}` : ""}
            </p>
            {estado.previa.avisos.map((aviso) => (
              <p className="text-amber-500 text-xs" data-locum-previa-aviso="" key={aviso}>
                {t("automations.github.preview.warning", { message: aviso })}
              </p>
            ))}
            <ul className="flex min-w-0 flex-col gap-1.5">
              {estado.previa.itens.map((item) => (
                <LinhaDePr
                  autor={item.autor}
                  entra={item.entra}
                  key={item.pr}
                  motivo={item.motivo}
                  pr={item.pr}
                  titulo={item.titulo}
                />
              ))}
            </ul>
          </>
        )
      ) : null}
    </section>
  );
}

function LinhaDePr({
  pr,
  titulo,
  autor,
  entra,
  motivo,
  quando,
}: {
  pr: string;
  titulo?: string;
  autor?: string;
  entra?: boolean;
  motivo: string;
  quando?: string;
}) {
  const { t } = useTranslation();
  return (
    <li
      className="border-border flex min-w-0 flex-col gap-0.5 rounded-md border px-2.5 py-1.5 text-xs"
      data-locum-pr={pr}
      data-locum-pr-entra={entra === undefined ? "" : entra ? "sim" : "nao"}
    >
      <div className="flex min-w-0 items-center gap-2">
        {entra === undefined ? null : (
          <Badge className="shrink-0" variant={entra ? "secondary" : "outline"}>
            {t(entra ? "automations.github.preview.enters" : "automations.github.preview.skipped")}
          </Badge>
        )}
        <span className="min-w-0 flex-1 truncate font-medium" title={titulo}>
          {titulo === undefined || titulo === "" ? pr : titulo}
        </span>
      </div>
      <span className="text-muted-foreground min-w-0 truncate" title={`${pr}${autor === undefined ? "" : ` · ${autor}`}`}>
        {pr}
        {autor === undefined ? "" : ` · ${autor}`}
        {quando === undefined ? "" : ` · ${quando}`}
      </span>
      <span className={cn("min-w-0 break-words", entra === true ? "text-muted-foreground" : "text-foreground")}>{motivo}</span>
    </li>
  );
}

/* ---------------------------------------------------------------- descartes */

function DescartesReais({ triggerId }: { triggerId?: string }) {
  const { t } = useTranslation();
  return (
    <section className="border-border flex min-w-0 flex-col gap-2 border-t pt-3" data-locum-descartes="">
      <h4 className="font-medium text-sm">{t("automations.github.discards.title")}</h4>
      <p className="text-muted-foreground text-xs">{t("automations.github.discards.help")}</p>
      {triggerId === undefined ? (
        <p className="text-muted-foreground text-xs">{t("automations.github.discards.unsaved")}</p>
      ) : (
        <ListaDeDescartes triggerId={triggerId} />
      )}
    </section>
  );
}

function ListaDeDescartes({ triggerId }: { triggerId: string }) {
  const { t, i18n } = useTranslation();
  const lida = useRead("triggers.discards", triggerId);
  if (lida.status === "loading") return null;
  if (lida.status === "error") {
    return <p className="text-destructive text-xs">{t("automations.github.preview.failed", { message: lida.error.message })}</p>;
  }
  if (lida.data.length === 0) return <p className="text-muted-foreground text-xs">{t("automations.github.discards.empty")}</p>;
  return (
    <ul className="flex min-w-0 flex-col gap-1.5">
      {lida.data.map((d) => (
        <LinhaDePr
          autor={d.autor}
          key={`${d.pr}:${d.motivo}`}
          motivo={d.motivo}
          pr={d.pr}
          quando={new Date(d.em).toLocaleString(i18n.language)}
          titulo={d.titulo}
        />
      ))}
    </ul>
  );
}
