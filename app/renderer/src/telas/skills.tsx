import { CabecalhoDaTela } from "@/components/cabecalho-da-tela";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ListGroup, ListRow } from "@/components/ui/list-row";
import { StatusDot } from "@/components/ui/status-dot";
import { Textarea } from "@/components/ui/textarea";
import { call, invalidateReads, read, useRead, type ReadResult } from "@/lib/bridge";
import { agruparPorFonte, rotuloDaFonte } from "@/lib/skills";
import { ArrowLeft, FolderOpen, Loader2, Plus, RefreshCw, Search, Sparkles, Upload } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";
import { Dica } from "../ferramentas-agrupadas";
import type { TelaProps } from "../rotas";

type Skill = ReadResult<"skills.list">[number];

/** O detalhe que abre o formulário da skill nova. */
const NOVA = "nova";
const PASTA_DAS_MINHAS = "~/.claude/skills";
const EXEMPLO_DE_NOME = "revisao-de-pr";

const mensagem = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const recarregar = (): void => {
  invalidateReads("skills.list");
  invalidateReads("skills.get");
};

export function Skills({ detalhe, navegar }: TelaProps) {
  if (detalhe === NOVA) return <NovaSkill navegar={navegar} />;
  if (detalhe !== null) return <DetalheDaSkill key={detalhe} navegar={navegar} nome={detalhe} />;
  return <ListaDeSkills navegar={navegar} />;
}

/* ------------------------------------------------------------------ lista */

function ListaDeSkills({ navegar }: { navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  const lista = useRead("skills.list");
  const [busca, setBusca] = useState("");
  const [lendo, setLendo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [importada, setImportada] = useState<string | null>(null);

  const atualizar = (): void => {
    setLendo(true);
    setErro(null);
    read("skills.list", true).then(
      () => {
        invalidateReads("skills.list");
        setLendo(false);
      },
      (e: unknown) => {
        setErro(mensagem(e));
        setLendo(false);
      },
    );
  };

  const importar = (): void => {
    setErro(null);
    setImportada(null);
    (async () => {
      const caminho = await call("skills.chooseImport");
      if (caminho === null) return;
      const nova = await call("skills.import", caminho);
      recarregar();
      setImportada(nova.name);
    })().catch((e: unknown) => setErro(mensagem(e)));
  };

  const termo = busca.trim().toLowerCase();
  const todas = lista.data ?? [];
  const achadas = termo === "" ? todas : todas.filter((s) => correspondeA(s, termo));
  const grupos = agruparPorFonte(achadas);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5" data-locum-probe="skills-v1">
      <CabecalhoDaTela
        acoes={
          <>
            <Button className="cursor-pointer" data-locum-skills-atualizar="" disabled={lendo} onClick={atualizar} size="sm" variant="ghost">
              {lendo ? <Loader2 aria-hidden className="animate-spin" /> : <RefreshCw aria-hidden />}
              {t("skills.refresh")}
            </Button>
            <Button className="cursor-pointer" data-locum-skills-importar="" onClick={importar} variant="outline">
              <Upload className="size-4" />
              {t("skills.import")}
            </Button>
            <Dica texto={t("skills.importHint")} />
            <Button className="cursor-pointer" data-locum-skills-nova="" onClick={() => navegar("skills", NOVA)}>
              <Plus className="size-4" />
              {t("skills.new")}
            </Button>
          </>
        }
        descricao={t("skills.lead")}
        titulo={t("skills.title")}
      />
      <div className="relative max-w-sm">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label={t("skills.search")}
          className="pl-8"
          data-locum-skills-busca=""
          onChange={(e) => setBusca(e.target.value)}
          placeholder={t("skills.search")}
          value={busca}
        />
      </div>
      {erro === null ? null : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot estado="erro" />
          {erro}
        </p>
      )}
      {importada === null ? null : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-locum-skills-importada={importada}>
          <StatusDot estado="aviso" />
          {t("skills.imported", { name: importada })}
        </p>
      )}
      {lista.status === "loading" ? (
        <p className="text-[13px] text-muted-foreground">{t("skills.loading")}</p>
      ) : todas.length === 0 ? (
        <EmptyState
          acao={
            <Button className="cursor-pointer" onClick={() => navegar("skills", NOVA)} size="sm" variant="outline">
              <Plus aria-hidden />
              {t("skills.new")}
            </Button>
          }
          descricao={t("skills.emptyBody")}
          icone={<Sparkles aria-hidden />}
          titulo={t("skills.emptyTitle")}
        />
      ) : achadas.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t("skills.noMatch", { termo: busca.trim() })}</p>
      ) : (
        grupos.map((g) => (
          <section className="flex flex-col gap-1.5" data-locum-skills-grupo={g.chave} key={g.chave}>
            <h2 className="flex items-center gap-2 text-[13px] font-medium">
              {rotuloDaFonte(g.fonte, t)}
              <span className="num text-xs font-normal text-muted-foreground">{g.itens.length}</span>
              {g.fonte.tipo === "minhas" ? <span className="font-mono text-[11px] font-normal text-muted-foreground">{PASTA_DAS_MINHAS}</span> : null}
            </h2>
            <ListGroup>
              {g.itens.map((s) => (
                <LinhaDaSkill abrir={() => navegar("skills", s.name)} key={`${g.chave}/${s.name}`} skill={s} />
              ))}
            </ListGroup>
          </section>
        ))
      )}
    </div>
  );
}

function correspondeA(s: Skill, termo: string): boolean {
  const fonte = s.fonte.tipo === "plugin" ? s.fonte.plugin : s.fonte.tipo;
  return [s.name, s.description, fonte, ...s.agents.map((a) => a.name)].some((campo) => campo.toLowerCase().includes(termo));
}

function LinhaDaSkill({ skill, abrir }: { skill: Skill; abrir: () => void }) {
  const { t } = useTranslation();
  const quem = skill.agents.map((a) => a.name).join(", ");
  return (
    <ListRow className="min-h-11" data-locum-skill={skill.name} onClick={abrir} rotulo={`${skill.name}. ${skill.description}`}>
      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
        <Sparkles className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{skill.name}</span>
        {skill.description === "" ? null : <span className="truncate text-xs text-muted-foreground">{skill.description}</span>}
      </span>
      <Badge className="hidden shrink-0 md:inline-flex" variant="secondary">
        {rotuloDaFonte(skill.fonte, t)}
      </Badge>
      <span className="num w-28 shrink-0 truncate text-right text-xs text-muted-foreground" title={quem}>
        {t("skills.usedBy", { count: skill.agents.length })}
      </span>
    </ListRow>
  );
}

/* ---------------------------------------------------------------- detalhe */

function DetalheDaSkill({ nome, navegar }: { nome: string; navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  const dados = useRead("skills.get", nome);
  const [editando, setEditando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const voltar = (
    <Button className="w-fit cursor-pointer" data-locum-skill-voltar="" onClick={() => navegar("skills")} size="sm" variant="ghost">
      <ArrowLeft aria-hidden />
      {t("skills.back")}
    </Button>
  );
  if (dados.status === "loading") return <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">{voltar}<p className="text-[13px] text-muted-foreground">{t("skills.loading")}</p></div>;
  if (dados.status === "error") {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        {voltar}
        <EmptyState icone={<Sparkles aria-hidden />} titulo={t("skills.gone", { name: nome })} descricao={dados.error.message} />
      </div>
    );
  }
  const skill = dados.data;

  const remover = (): void => {
    setErro(null);
    call("skills.remove", skill.name).then(
      () => {
        recarregar();
        navegar("skills");
      },
      (e: unknown) => setErro(mensagem(e)),
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4" data-locum-skill-detalhe={skill.name}>
      {voltar}
      <CabecalhoDaTela
        acoes={
          skill.editavel ? (
            <>
              <Button className="cursor-pointer" data-locum-skill-editar="" disabled={editando} onClick={() => setEditando(true)} size="sm" variant="outline">
                {t("skills.edit")}
              </Button>
              <Button className="cursor-pointer" data-locum-skill-remover="" onClick={() => setConfirmando(true)} size="sm" variant="ghost">
                {t("skills.remove")}
              </Button>
            </>
          ) : (
            <Button className="cursor-pointer" data-locum-skill-mostrar="" onClick={() => void call("skills.reveal", skill.name)} size="sm" variant="outline">
              <FolderOpen aria-hidden />
              {t("skills.reveal")}
            </Button>
          )
        }
        descricao={skill.description === "" ? undefined : skill.description}
        titulo={<span className="font-mono text-[20px]">{skill.name}</span>}
      />
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="secondary">{rotuloDaFonte(skill.fonte, t)}</Badge>
        {skill.editavel ? null : (
          <span className="inline-flex items-center gap-1">
            {t("skills.readOnly")}
            <Dica texto={t("skills.readOnlyHint")} />
          </span>
        )}
        <span className="truncate font-mono text-[11px]" title={skill.arquivo}>
          {skill.arquivo}
        </span>
      </div>

      {confirmando ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-[13px]" data-locum-skill-confirmar="">
          <span>{skill.agents.length === 0 ? t("skills.removeConfirm", { name: skill.name }) : t("skills.removeConfirmAgents", { name: skill.name, count: skill.agents.length })}</span>
          <Button className="cursor-pointer" data-locum-skill-remover-sim="" onClick={remover} size="sm" variant="outline">
            {t("skills.removeYes")}
          </Button>
          <Button className="cursor-pointer" onClick={() => setConfirmando(false)} size="sm" variant="ghost">
            {t("skills.cancel")}
          </Button>
        </div>
      ) : null}
      {erro === null ? null : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot estado="erro" />
          {erro}
        </p>
      )}

      {editando ? (
        <FormularioDaSkill
          cancelar={() => setEditando(false)}
          inicial={{ name: skill.name, description: skill.description, body: skill.corpo }}
          salvar={async (v) => {
            await call("skills.update", skill.name, { description: v.description, body: v.body });
            recarregar();
            setEditando(false);
          }}
        />
      ) : (
        <article className="rounded-lg border border-border bg-card p-5 text-[13px] leading-relaxed" data-locum-skill-corpo="">
          {skill.corpo.trim() === "" ? <p className="text-muted-foreground">{t("skills.emptyBodyText")}</p> : <Streamdown>{skill.corpo}</Streamdown>}
        </article>
      )}

      <section className="flex flex-col gap-1.5">
        <h2 className="text-[13px] font-medium">{t("skills.agents")}</h2>
        {skill.agents.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("skills.noAgents")}</p>
        ) : (
          <ListGroup>
            {skill.agents.map((a) => (
              <ListRow className="min-h-9 py-1" data-locum-skill-agent={a.id} key={a.id} onClick={() => navegar("agents", a.id)} rotulo={a.name}>
                <span className="text-[13px]">{a.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{a.id}</span>
              </ListRow>
            ))}
          </ListGroup>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------- formulário */

function NovaSkill({ navegar }: { navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <Button className="w-fit cursor-pointer" onClick={() => navegar("skills")} size="sm" variant="ghost">
        <ArrowLeft aria-hidden />
        {t("skills.back")}
      </Button>
      <CabecalhoDaTela descricao={t("skills.newLead")} titulo={t("skills.new")} />
      <FormularioDaSkill
        cancelar={() => navegar("skills")}
        inicial={{ name: "", description: "", body: "" }}
        novo
        salvar={async (v) => {
          const criada = await call("skills.create", v);
          recarregar();
          navegar("skills", criada.name);
        }}
      />
    </div>
  );
}

function FormularioDaSkill({
  inicial,
  novo = false,
  salvar,
  cancelar,
}: {
  inicial: { name: string; description: string; body: string };
  novo?: boolean;
  salvar: (v: { name: string; description: string; body: string }) => Promise<void>;
  cancelar: () => void;
}) {
  const { t } = useTranslation();
  const [valor, setValor] = useState(inicial);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const pronto = valor.name.trim() !== "" && valor.description.trim() !== "";

  return (
    <form
      className="flex flex-col gap-3"
      data-locum-skill-formulario=""
      onSubmit={(e) => {
        e.preventDefault();
        setOcupado(true);
        setErro(null);
        salvar({ ...valor, name: valor.name.trim() }).catch((falha: unknown) => {
          setErro(mensagem(falha));
          setOcupado(false);
        });
      }}
    >
      {novo ? (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            {t("skills.form.name")}
            <Dica texto={t("skills.form.nameHint")} />
          </span>
          <Input
            className="max-w-sm font-mono"
            data-locum-skill-nome=""
            onChange={(e) => setValor({ ...valor, name: e.target.value })}
            placeholder={EXEMPLO_DE_NOME}
            value={valor.name}
          />
        </label>
      ) : null}
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          {t("skills.form.description")}
          <Dica texto={t("skills.form.descriptionHint")} />
        </span>
        <Input data-locum-skill-descricao="" onChange={(e) => setValor({ ...valor, description: e.target.value })} value={valor.description} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {t("skills.form.body")}
        <Textarea
          className="min-h-64 font-mono text-xs"
          data-locum-skill-corpo-campo=""
          onChange={(e) => setValor({ ...valor, body: e.target.value })}
          value={valor.body}
        />
      </label>
      {erro === null ? null : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot estado="erro" />
          {erro}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button className="cursor-pointer" data-locum-skill-salvar="" disabled={!pronto || ocupado} type="submit">
          {ocupado ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {novo ? t("skills.form.create") : t("skills.save")}
        </Button>
        <Button className="cursor-pointer" onClick={cancelar} type="button" variant="ghost">
          {t("skills.cancel")}
        </Button>
      </div>
    </form>
  );
}
