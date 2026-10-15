import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { call, invalidateReads, read, type ReadResult } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ehLeituraDa } from "../../../src/config/leitura.js";
import { saudeDoServidor } from "../../../src/services/conexao-estado.js";
import { Credenciais } from "./blocos";
import { quando } from "./sessoes";

type Credencial = ReadResult<"credentials.overview">["refs"][number];
type Servidor = ReadResult<"mcp.list">[number];
type Ferramenta = ReadResult<"mcp.tools">[number];
type Teste = ReadResult<"mcp.test">;
export type Vinculo = ReadResult<"mcp.vinculos">[string];

/* ---------------------------------------------------------------- servidores */

export type EstadoDoTeste =
  | { fase: "parado" }
  | { fase: "testando" }
  | { fase: "respondeu"; teste: Teste }
  | { fase: "recusado"; erro: string };

/** O que conecta: a configuração da origem quando o servidor é vinculado, e a cadastrada nos outros. */
export function destinoDe(servidor: Servidor, vinculo?: Vinculo): string {
  const config = vinculo?.efetivo ?? servidor.config;
  return config.transport === "stdio" ? (config.command ?? []).join(" ") : (config.url ?? "");
}

/** Selo de origem: "do plugin akad (Claude Code)", "do Claude Code", "do Cursor". A configuração não é cópia, vem de lá. */
export function textoDaOrigem(vinculo: Vinculo, t: (chave: string, opcoes?: Record<string, unknown>) => string): string {
  return vinculo.source.kind === "claude-plugin"
    ? t("settings.servers.link.badgePlugin", { plugin: vinculo.source.plugin })
    : vinculo.source.kind === "claude-user"
      ? t("settings.servers.link.badgeUser")
      : t("settings.servers.link.badgeTool", { origem: vinculo.rotulo });
}

export function SeloVinculado({ vinculo }: { vinculo: Vinculo }) {
  const { t } = useTranslation();
  const texto = textoDaOrigem(vinculo, t);
  return (
    <span
      className="border-border text-muted-foreground rounded border px-1.5 py-px text-[10px] leading-4"
      data-locum-vinculado={vinculo.rotulo}
      title={t("settings.servers.link.badgeHint", { origem: vinculo.rotulo })}
    >
      {texto}
    </span>
  );
}

/** Rótulo do campo que mudou, na língua da tela. */
function campoDaMudanca(m: Vinculo["mudancas"][number], t: (chave: string, opcoes?: Record<string, unknown>) => string): string {
  return t(`settings.servers.link.changed.field.${m.campo}`, { chave: m.chave });
}

/**
 * O aviso do vínculo: a origem mudou (com o que mudou e a escolha de aceitar ou
 * manter a anterior) ou sumiu. Sem aviso quando a origem bate com o aceito.
 */
export function AvisoDaOrigem({ nome, onMudou, vinculo }: { nome: string; onMudou: () => void; vinculo: Vinculo }) {
  const { t } = useTranslation();
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  if (vinculo.estado === "ok") return null;

  const agir = (fazer: () => Promise<unknown>): void => {
    setOcupado(true);
    setErro(null);
    fazer().then(
      () => {
        setOcupado(false);
        onMudou();
      },
      (falha: unknown) => {
        setOcupado(false);
        setErro(falha instanceof Error ? falha.message : String(falha));
        // A origem pode ter mudado de novo: relê, e o diff novo aparece.
        onMudou();
      },
    );
  };

  if (vinculo.estado === "indisponivel") {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-400" data-locum-origem-estado="indisponivel" data-locum-origem-de={nome}>
        <p className="font-medium">{t("settings.servers.link.unavailable.title")}</p>
        <p>{t("settings.servers.link.unavailable.body", { origem: vinculo.rotulo, names: vinculo.faltando.join(", ") })}</p>
      </div>
    );
  }

  if (vinculo.estado === "sumiu") {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-400" data-locum-origem-estado="sumiu" data-locum-origem-de={nome}>
        <p className="font-medium">{t("settings.servers.link.gone.title")}</p>
        <p>
          {vinculo.motivo === "plugin-desligado"
            ? t("settings.servers.link.goneDisabled", { origem: vinculo.rotulo })
            : vinculo.motivo === "plugin-removido"
              ? t("settings.servers.link.goneRemoved", { origem: vinculo.rotulo })
              : t("settings.servers.link.gone.body", { origem: vinculo.rotulo, nome })}
        </p>
      </div>
    );
  }

  const vazio = t("settings.servers.link.changed.none");
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs"
      data-locum-origem-estado={vinculo.mantida ? "mantida" : "mudou"}
      data-locum-origem-de={nome}
    >
      <p className="font-medium text-amber-400">{t("settings.servers.link.changed.title")}</p>
      <p className="text-muted-foreground">
        {vinculo.mantida
          ? t("settings.servers.link.changed.kept")
          : t("settings.servers.link.changed.body", { origem: vinculo.rotulo, nome })}
      </p>
      <ul className="flex flex-col gap-1.5" data-locum-origem-diff="">
        {vinculo.mudancas.map((m) => (
          <li className="flex flex-col gap-0.5" key={`${m.campo}:${m.chave ?? ""}`}>
            <span className="text-foreground font-medium">{campoDaMudanca(m, t)}</span>
            {m.protegido === true ? (
              <span className="text-muted-foreground">{t("settings.servers.link.protectedChanged")}</span>
            ) : (
              <>
                <code className="font-mono text-[11px] break-all text-red-400/90">
                  {t("settings.servers.link.changed.before")}: {m.antes ?? vazio}
                </code>
                <code className="font-mono text-[11px] break-all text-emerald-400/90">
                  {t("settings.servers.link.changed.after")}: {m.depois ?? vazio}
                </code>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button className="cursor-pointer" data-locum-aceitar-origem={nome} disabled={ocupado} onClick={() => agir(() => call("mcp.aceitarOrigem", nome, vinculo.hash ?? ""))} size="sm">
          {t("settings.servers.link.changed.accept")}
        </Button>
        {vinculo.mantida ? null : (
          <Button className="cursor-pointer" data-locum-manter-origem={nome} disabled={ocupado} onClick={() => agir(() => call("mcp.manterAnterior", nome, vinculo.hash ?? ""))} size="sm" variant="outline">
            {t("settings.servers.link.changed.keep")}
          </Button>
        )}
      </div>
      {erro === null ? null : <p className="text-destructive">{erro}</p>}
    </div>
  );
}

/** Endereço que só a rede da casa alcança: o servidor falha fora da VPN, e a tela avisa. */
function redeInterna(servidor: Servidor): boolean {
  const url = servidor.config.url ?? "";
  return /\.internal\.|\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
}

/**
 * De onde veio o servidor, para a lista não misturar o que a pessoa
 * cadastrou com o que veio do Claude Code, de um plugin dele, de outra
 * ferramenta ou o que um app do catálogo cadastrou ao ligar. A origem é lida
 * dos arquivos das ferramentas a cada abertura: um servidor com o mesmo nome
 * de um que elas declaram conta como importado de lá.
 */
export function chaveDaOrigem(nome: string, origens: Record<string, string>, doCatalogo: ReadonlySet<string>): string {
  const origem = origens[nome];
  if (doCatalogo.has(nome)) return "apps";
  if (origem === "usuário") return "usuario";
  // Plugin do Claude Code vem como `nome@marketplace`; o resto é ferramenta.
  if (origem?.includes("@") === true) return `plugin:${origem.split("@")[0] ?? origem}`;
  if (origem !== undefined) return `ferramenta:${origem}`;
  return "seus";
}

export function tituloDaOrigem(chave: string, t: (chave: string, opcoes?: Record<string, unknown>) => string): string {
  if (chave === "apps") return t("settings.servers.groups.apps");
  if (chave === "usuario") return t("settings.servers.groups.user");
  if (chave.startsWith("plugin:")) return t("settings.servers.groups.plugin", { name: chave.slice("plugin:".length) });
  if (chave.startsWith("ferramenta:")) return t("settings.servers.groups.tool", { name: chave.slice("ferramenta:".length) });
  return t("settings.servers.groups.manual");
}

/** Rótulos curtos do servidor: transporte, leitura ou escrita, rede da casa e uso. */
export function TagsDoServidor({ servidor, usadoPor }: { servidor: Servidor; usadoPor: number }) {
  const { t } = useTranslation();
  const tag = "border-border text-muted-foreground rounded border px-1.5 py-px text-[10px] leading-4";
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className={tag}>{servidor.config.transport}</span>
      <span className={cn(tag, servidor.config.scope === "write" && "border-sev-medium/40 text-sev-medium")}>
        {t(servidor.config.scope === "write" ? "settings.servers.scopeWrite" : "settings.servers.scopeRead")}
      </span>
      {redeInterna(servidor) ? <span className={tag}>{t("settings.servers.tags.internal")}</span> : null}
      {usadoPor > 0 ? <span className={tag}>{t("settings.servers.tags.usedBy", { count: usadoPor })}</span> : null}
    </span>
  );
}

/**
 * O estado do servidor cadastrado: ponto, selo da última conexão, o erro
 * inteiro quando falhou, o interruptor de ligado e, para o servidor próprio
 * que pede autorização, o botão de autorizar aqui mesmo.
 */
export function EstadoDoServidor({
  autorizavel,
  emUso = false,
  onMudou,
  servidor,
}: {
  /** Servidor http fora do catálogo: o OAuth do Locum resolve sem passar pelo cartão. */
  autorizavel: boolean;
  /** Alguma automação ou agent usa o servidor: desligar pede uma confirmação. */
  emUso?: boolean;
  onMudou: () => void;
  servidor: Servidor;
}) {
  const { t } = useTranslation();
  const nome = servidor.config.name;
  const saude = servidor.health;
  const [ocupado, setOcupado] = useState<"ligar" | "autorizar" | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);

  const agir = (qual: NonNullable<typeof ocupado>, fazer: () => Promise<unknown>): void => {
    setOcupado(qual);
    setErro(null);
    fazer().then(
      () => {
        setOcupado(null);
        onMudou();
      },
      (falha: unknown) => {
        setOcupado(null);
        setErro(falha instanceof Error ? falha.message : String(falha));
      },
    );
  };

  return (
    <section className="flex flex-col gap-2" data-locum-servidor={nome} data-locum-habilitado={servidor.enabled ? "sim" : "nao"}>
      <div className="flex flex-wrap items-center gap-2">
        <PontoDoServidor ligado={servidor.enabled} saude={saude} />
        <span className="text-sm font-medium">{t(`settings.servers.dot.${chaveDoPonto(servidor.enabled, saude)}`)}</span>
        <SaudeDoServidor saude={saude} />
      </div>
      {saudeDoServidor(saude) === "failed" && saude.lastError !== null ? (
        <pre className="border-destructive/30 bg-destructive/5 text-destructive max-h-48 overflow-auto rounded-md border p-2 font-mono text-[11px] whitespace-pre-wrap">
          {saude.lastError}
        </pre>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          className="cursor-pointer"
          data-locum-ligar-servidor={nome}
          disabled={ocupado !== null}
          onClick={() => {
            if (servidor.enabled && emUso && !confirmando) {
              setConfirmando(true);
              return;
            }
            setConfirmando(false);
            agir("ligar", () => call("mcp.setEnabled", nome, !servidor.enabled));
          }}
          size="sm"
          variant={servidor.enabled ? "outline" : "default"}
        >
          {t(servidor.enabled ? (confirmando ? "settings.servers.turnOffConfirm" : "settings.servers.turnOff") : "settings.servers.turnOn")}
        </Button>
        {autorizavel ? (
          <Button
            className="cursor-pointer"
            data-locum-autorizar={nome}
            disabled={ocupado !== null}
            onClick={() => agir("autorizar", () => call("connections.connect", nome))}
            size="sm"
            variant="outline"
          >
            {t(ocupado === "autorizar" ? "connections.connecting" : saude.needsAuth ? "settings.servers.authorize" : "settings.servers.reauthorize")}
          </Button>
        ) : null}
      </div>
      {confirmando ? (
        <p className="text-muted-foreground text-xs" data-locum-desligar-aviso={nome}>
          {t("settings.servers.turnOffInUse")}
        </p>
      ) : null}
      {erro === null ? null : <p className="text-destructive text-xs">{erro}</p>}
    </section>
  );
}

/**
 * As ferramentas do servidor, separadas entre leitura e escrita, com o peso de
 * cada uma. Desligado não sobe sozinho: listar roda o comando, e isso é da
 * pessoa.
 */
export function FerramentasDoServidor({ servidor }: { servidor: Servidor }) {
  const { t } = useTranslation();
  const nome = servidor.config.name;
  const [ferramentas, setFerramentas] = useState<Ferramenta[] | null>(null);
  const [guardada, setGuardada] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  const carregar = (): void => {
    setErro(null);
    call("mcp.tools", nome).then(
      (lista) => {
        if (!vivo.current) return;
        setFerramentas(lista);
        setGuardada(false);
        // Listar grava a contagem no cadastro: "O que libera" acompanha.
        invalidateReads("connections.list");
      },
      (falha: unknown) => {
        if (!vivo.current) return;
        // Falhar ao subir o servidor não apaga o que já se sabe dele: a lista guardada fica na tela.
        setFerramentas((antes) => antes ?? []);
        setErro(falha instanceof Error ? falha.message : String(falha));
      },
    );
  };
  useEffect(() => {
    // A lista guardada aparece na hora, ligado ou não; subir o servidor é que depende de estar ligado.
    void read("mcp.toolsCached", nome)
      .then((c) => {
        if (!vivo.current || c === null) return;
        setFerramentas((atual) => atual ?? c.tools);
        setGuardada(true);
      })
      .catch(() => undefined);
    if (servidor.enabled) carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nome]);

  const leituras = (ferramentas ?? []).filter(ehLeituraDa);
  const escritas = (ferramentas ?? []).filter((f) => !ehLeituraDa(f));

  return (
    <div className="flex flex-col gap-2" data-locum-ferramentas-de={nome}>
      <div className="flex items-center gap-2">
        {ferramentas === null ? null : (
          <span className="text-muted-foreground text-xs">
            {t("settings.servers.detail.toolsCount", { read: leituras.length, write: escritas.length })}
          </span>
        )}
        <Button className="ml-auto cursor-pointer" onClick={carregar} size="sm" variant="ghost">
          <RefreshCw aria-hidden className="size-3.5" />
          {t("settings.servers.detail.reload")}
        </Button>
      </div>
      {erro === null ? null : <p className="text-destructive text-xs">{erro}</p>}
      {guardada && ferramentas !== null && ferramentas.length > 0 ? (
        <p className="text-muted-foreground text-xs" data-locum-ferramentas-guardada="">
          {t(servidor.enabled ? "settings.servers.detail.toolsCached" : "settings.servers.detail.toolsCachedOff")}
        </p>
      ) : null}
      {ferramentas === null ? (
        <p className="text-muted-foreground text-xs">
          {t(servidor.enabled ? "connections.loading" : "settings.servers.detail.toolsOff")}
        </p>
      ) : ferramentas.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t("settings.servers.noTools")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {[...leituras, ...escritas].map((f) => (
            <li
              className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 hover:bg-muted/40"
              data-locum-ferramenta={`${nome}/${f.name}`}
              data-locum-tokens={f.estimatedTokens}
              key={f.name}
            >
              <span className="flex items-center gap-2">
                <span className="font-mono text-xs">{f.name}</span>
                <span
                  className={cn(
                    "rounded border px-1.5 text-[10px] leading-4",
                    ehLeituraDa(f) ? "border-border text-muted-foreground" : "border-sev-medium/40 text-sev-medium",
                  )}
                >
                  {t(ehLeituraDa(f) ? "settings.servers.scopeRead" : "settings.servers.scopeWrite")}
                </span>
                <span className="text-muted-foreground ml-auto text-[10px] tabular-nums">
                  {t("settings.servers.detail.tokens", { count: f.estimatedTokens })}
                </span>
              </span>
              {f.description ? <span className="text-muted-foreground line-clamp-2 text-xs">{f.description}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * O que só interessa a quem administra: onde o servidor roda, de onde veio, os
 * rótulos, e a credencial colada. Fica atrás de "detalhes técnicos".
 */
export function DetalhesTecnicos({
  credencial,
  onMudou,
  origem,
  servidor,
  vinculo,
}: {
  credencial: Credencial | undefined;
  onMudou: () => void;
  origem: string;
  servidor: Servidor;
  vinculo?: Vinculo;
}) {
  const { t, i18n } = useTranslation();
  const nome = servidor.config.name;
  const saude = servidor.health;
  const efetiva = vinculo?.efetivo ?? servidor.config;
  const http = servidor.config.transport !== "stdio";
  const [desvinculando, setDesvinculando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [campo, setCampo] = useState(http ? "Authorization" : "API_KEY");
  const [valor, setValor] = useState("");
  const titulo = "text-muted-foreground text-[11px] font-medium tracking-wide uppercase";
  const campoCss = "border-border bg-card focus:ring-ring h-9 w-full rounded-md border px-3 text-sm outline-none focus:ring-2";

  const guardar = (): void => {
    setOcupado(true);
    setErro(null);
    (async () => {
      await call("mcp.setCredential", nome, { campo, valor });
      setValor("");
      await call("mcp.test", nome);
    })().then(
      () => {
        setOcupado(false);
        onMudou();
      },
      (falha: unknown) => {
        setOcupado(false);
        setErro(falha instanceof Error ? falha.message : String(falha));
      },
    );
  };

  return (
    <div className="flex flex-col gap-5 text-sm" data-locum-detalhe={nome}>
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">{origem}</span>
          <TagsDoServidor servidor={servidor} usadoPor={0} />
        </div>
        <p className="text-muted-foreground text-xs">
          {saude.lastOkAt === null
            ? t("settings.servers.detail.neverOk")
            : t("settings.servers.health.ok", { when: quando(i18n.language, saude.lastOkAt / 1000) })}
        </p>
        <h3 className={titulo}>{t(http ? "settings.servers.detail.url" : "settings.servers.detail.command")}</h3>
        <code className="bg-muted/40 rounded-md p-2 font-mono text-[11px] break-all" data-locum-destino="">{destinoDe(servidor, vinculo)}</code>
        {Object.keys(efetiva.env ?? {}).length + Object.keys(efetiva.headers ?? {}).length > 0 ? (
          <p className="text-muted-foreground text-xs">
            {t(http ? "settings.servers.detail.headers" : "settings.servers.detail.env", {
              names: Object.keys((http ? efetiva.headers : efetiva.env) ?? {}).join(", ") || "-",
            })}
          </p>
        ) : null}
        {vinculo === undefined ? null : (
          <div className="flex flex-col gap-2" data-locum-vinculo-detalhe={nome}>
            <p className="text-muted-foreground text-xs">{t("settings.servers.link.readOnly")}</p>
            {vinculo.faltando.length === 0 ? null : (
              <p className="text-xs text-amber-400">{t("settings.servers.link.missing", { names: vinculo.faltando.join(", ") })}</p>
            )}
            <h3 className={titulo}>{t("settings.servers.link.editAtOrigin")}</h3>
            <code className="bg-muted/40 rounded-md p-2 font-mono text-[11px] break-all" data-locum-arquivo-origem="">
              {vinculo.arquivo ?? vinculo.rotulo}
            </code>
            <div className="flex flex-wrap gap-2">
              {vinculo.arquivo === null ? null : (
                <Button className="cursor-pointer" onClick={() => void call("mcp.mostrarOrigem", nome)} size="sm" variant="outline">
                  {t("settings.servers.link.reveal")}
                </Button>
              )}
              <Button
                className="cursor-pointer"
                data-locum-desvincular={nome}
                disabled={ocupado}
                onClick={() => {
                  if (!desvinculando) {
                    setDesvinculando(true);
                    return;
                  }
                  setOcupado(true);
                  setErro(null);
                  call("mcp.desvincular", nome).then(
                    () => {
                      setOcupado(false);
                      setDesvinculando(false);
                      onMudou();
                    },
                    (falha: unknown) => {
                      setOcupado(false);
                      setErro(falha instanceof Error ? falha.message : String(falha));
                    },
                  );
                }}
                size="sm"
                variant="outline"
              >
                {t(desvinculando ? "settings.servers.link.unlinkConfirm" : "settings.servers.link.unlink")}
              </Button>
            </div>
            {desvinculando ? <p className="text-muted-foreground text-xs">{t("settings.servers.link.unlinkHint")}</p> : null}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={titulo}>{t("settings.servers.detail.credential")}</h3>
        {credencial === undefined ? (
          <p className="text-muted-foreground text-xs">{t("settings.servers.detail.noCredential")}</p>
        ) : (
          <Credenciais credencial={credencial} />
        )}
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            guardar();
          }}
        >
          <p className="text-muted-foreground text-xs">
            {t(http ? "settings.servers.detail.pasteHttp" : "settings.servers.detail.pasteStdio")}
          </p>
          <div className="flex gap-2">
            <input
              aria-label={t(http ? "settings.servers.detail.header" : "settings.servers.detail.variable")}
              autoComplete="off"
              className={cn(campoCss, "w-40 shrink-0 font-mono text-xs")}
              onChange={(e) => setCampo(e.target.value)}
              value={campo}
            />
            <input
              aria-label={t("settings.servers.detail.value")}
              autoComplete="off"
              className={campoCss}
              onChange={(e) => setValor(e.target.value)}
              placeholder={t("settings.servers.detail.value")}
              type="password"
              value={valor}
            />
          </div>
          <div>
            <Button className="cursor-pointer" disabled={ocupado || valor.trim() === ""} size="sm" type="submit">
              {t(ocupado ? "settings.servers.testing" : "settings.servers.detail.save")}
            </Button>
          </div>
        </form>
        {erro === null ? null : <p className="text-destructive text-xs">{erro}</p>}
      </section>
    </div>
  );
}

function chaveDoPonto(ligado: boolean, saude: Servidor["health"]): "off" | ReturnType<typeof saudeDoServidor> {
  return ligado ? saudeDoServidor(saude) : "off";
}

/** Estado num relance: desligado, precisa autorizar, falhou, respondeu ou nunca testado. */
export function PontoDoServidor({ ligado, saude }: { ligado: boolean; saude: Servidor["health"] }) {
  const { t } = useTranslation();
  const chave = chaveDoPonto(ligado, saude);
  const cor = {
    off: "bg-muted-foreground/30",
    auth: "bg-destructive",
    failed: "bg-destructive",
    ok: "bg-emerald-500",
    untested: "bg-sev-medium",
  }[chave];
  return (
    <span
      aria-label={t(`settings.servers.dot.${chave}`)}
      className={cn("size-2 shrink-0 rounded-full", cor)}
      role="img"
      title={t(`settings.servers.dot.${chave}`)}
    />
  );
}

/**
 * O que o cadastro sabe da última conexão, de teste ou de execução. Credencial
 * recusada ganha selo vermelho: é o caso em que o passo quebraria calado.
 */
export function SaudeDoServidor({ saude }: { saude: Servidor["health"] }) {
  const { t, i18n } = useTranslation();
  const estado = saudeDoServidor(saude);

  if (estado === "auth") {
    return (
      <Badge data-locum-saude="autenticar" title={saude.lastError ?? undefined} variant="destructive">
        {t("settings.servers.health.needsAuth")}
      </Badge>
    );
  }
  if (estado === "failed") {
    return (
      <span className="text-destructive text-xs" data-locum-saude="falhou" title={saude.lastError ?? undefined}>
        {t("settings.servers.health.failed", { when: quando(i18n.language, saude.lastFailureAt! / 1000) })}
      </span>
    );
  }
  if (estado === "ok" && saude.lastOkAt !== null) {
    return (
      <span className="text-muted-foreground text-xs" data-locum-saude="ok">
        {t("settings.servers.health.ok", { when: quando(i18n.language, saude.lastOkAt / 1000) })}
      </span>
    );
  }
  return null;
}

export function ResultadoDoTeste({ estado, nome }: { estado: EstadoDoTeste; nome: string }) {
  const { t } = useTranslation();

  if (estado.fase === "parado" || estado.fase === "testando") return null;

  if (estado.fase === "recusado") {
    return (
      <p className="text-destructive text-xs" data-locum-ok="nao" data-locum-teste={nome}>
        {t("settings.servers.refused", { message: estado.erro })}
      </p>
    );
  }

  const { teste } = estado;
  return (
    <p
      className={teste.ok ? "text-muted-foreground text-xs" : "text-destructive text-xs"}
      data-locum-ferramentas={teste.toolCount}
      data-locum-ok={teste.ok ? "sim" : "nao"}
      data-locum-teste={nome}
    >
      {teste.ok
        ? t("settings.servers.ok", { count: teste.toolCount, elapsed: teste.elapsedMs })
        : t("settings.servers.failed", {
            elapsed: teste.elapsedMs,
            error: teste.error ?? t("settings.servers.noReason"),
          })}
    </p>
  );
}
