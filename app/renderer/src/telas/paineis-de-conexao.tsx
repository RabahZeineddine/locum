import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { call, invalidateReads, read, useRead, type ReadResult } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import { quando } from "./sessoes";
import { useState } from "react";
import { useTranslation } from "react-i18next";

type EstadoDoGithub = ReadResult<"github.status">;
type ConferenciaDoGithub = ReadResult<"github.check">;
type ContaDoGh = ReadResult<"github.ghAccounts">[number];
type Tracker = ReadResult<"trackers.list">[number];
type TesteDoTracker = ReadResult<"trackers.test">;
type CadastroDoSlack = ReadResult<"slack.get">;
type AppDoSlack = ReadResult<"connections.slackApp">;
type AppDoTeams = ReadResult<"connections.teamsApp">;

/* ------------------------------------------------------------------- github */

type Conferencia =
  | { fase: "parado" }
  | { fase: "conferindo" }
  | { fase: "respondeu"; resultado: ConferenciaDoGithub }
  | { fase: "recusado"; erro: string };

/**
 * As instâncias do Grafana, uma por servidor MCP (`grafana-dev`,
 * `grafana-prod`). Salvar com o mesmo nome troca o endereço, e o token só é
 * trocado quando um novo é colado.
 */
export function Grafana() {
  const { t } = useTranslation();
  const inicial = useRead("grafana.list");
  const [relidas, setRelidas] = useState<ReadResult<"grafana.list"> | null>(null);
  const [nome, setNome] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const instancias = relidas ?? inicial.data ?? [];

  const agir = (acao: () => Promise<ReadResult<"grafana.list">>, limpar: boolean): void => {
    setEnviando(true);
    setErro(null);
    acao().then(
      (novas) => {
        setRelidas(novas);
        setEnviando(false);
        if (limpar) {
          setNome("");
          setUrl("");
          setToken("");
        }
      },
      (falha: unknown) => {
        setEnviando(false);
        setErro(falha instanceof Error ? falha.message : String(falha));
      },
    );
  };

  const campo = "border-border bg-card focus:ring-ring h-9 w-full rounded-md border px-3 text-sm outline-none focus:ring-2";

  return (
    <div className="flex flex-col gap-3 px-4 py-3" data-locum-probe="grafana">
      <p className="text-muted-foreground text-xs">{t("settings.grafana.description")}</p>
      {instancias.length === 0 ? null : (
        <ul className="divide-border border-border divide-y rounded-md border">
          {instancias.map((i) => (
            <li className="flex items-center gap-3 px-3 py-2 text-sm" key={i.name}>
              <span className="font-mono text-xs font-medium">{i.name}</span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]">{i.url}</span>
              {i.hasToken ? null : <span className="text-sev-critical text-xs">{t("settings.grafana.noToken")}</span>}
              <Button
                className="h-7 cursor-pointer"
                disabled={enviando}
                onClick={() => {
                  setNome(i.name);
                  setUrl(i.url);
                }}
                size="sm"
                variant="ghost"
              >
                {t("settings.grafana.edit")}
              </Button>
              <Button
                className="h-7 cursor-pointer"
                disabled={enviando}
                onClick={() => agir(() => call("grafana.remove", i.name), false)}
                size="sm"
                variant="ghost"
              >
                {t("settings.grafana.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid grid-cols-1 gap-2 sm:grid-cols-[8rem_1fr]"
        onSubmit={(e) => {
          e.preventDefault();
          agir(() => call("grafana.save", { nome, url, token }), true);
        }}
      >
        <input
          aria-label={t("settings.grafana.name")}
          autoComplete="off"
          className={campo}
          onChange={(e) => setNome(e.target.value)}
          placeholder={t("settings.grafana.namePlaceholder")}
          required
          value={nome}
        />
        <input
          aria-label={t("settings.grafana.url")}
          autoComplete="off"
          className={campo}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t("settings.grafana.urlPlaceholder")}
          required
          type="url"
          value={url}
        />
        <input
          aria-label={t("settings.grafana.token")}
          autoComplete="off"
          className={cn(campo, "sm:col-span-2")}
          onChange={(e) => setToken(e.target.value)}
          placeholder={t("settings.grafana.tokenPlaceholder")}
          type="password"
          value={token}
        />
        <div className="sm:col-span-2">
          <Button className="cursor-pointer" disabled={enviando} size="sm" type="submit">
            {t("settings.grafana.save")}
          </Button>
        </div>
      </form>
      {erro === null ? null : <p className="text-sev-critical text-xs break-words">{erro}</p>}
    </div>
  );
}

/**
 * A credencial do GitHub: guardar, esquecer e perguntar de quem ela é.
 *
 * O valor digitado sai daqui numa direção só, para o keychain, e nunca volta:
 * não existe canal que devolva segredo, então nem recarregando a tela o campo
 * reaparece preenchido. O que fica visível é se há algo guardado, de quem é a
 * conta e quando foi a última conferência, que é o suficiente para alguém saber
 * se pode ligar um gatilho.
 *
 * Conferir fica atrás de um clique pela mesma razão do teste de servidor MCP:
 * ele sai para a rede, e abrir a tela de configuração não é pedir exame.
 */
/** `embutido`: dentro da parte do token no detalhe da conexão, que já diz o título e o estado. */
export function Github({ embutido = false }: { embutido?: boolean } = {}) {
  const { i18n, t } = useTranslation();
  const inicial = useRead("github.status");
  const contasIniciais = useRead("github.ghAccounts");
  const [recarregado, setRecarregado] = useState<EstadoDoGithub | null>(null);
  const [token, setToken] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [conferencia, setConferencia] = useState<Conferencia>({ fase: "parado" });

  const estado = recarregado ?? inicial.data ?? null;
  const [configDir, setConfigDir] = useState("");
  const [contasAlternativas, setContasAlternativas] = useState<ContaDoGh[] | null>(null);
  const contas = contasAlternativas ?? contasIniciais.data ?? [];

  const procurarContas = (): void => {
    read("github.ghAccounts", configDir.trim() || undefined).then(setContasAlternativas, () => setContasAlternativas([]));
  };

  const usarGh = (conta: ContaDoGh): void => {
    setSalvando(true);
    const dir = configDir.trim();
    call("github.useGh", {
      origem: "gh",
      host: conta.host,
      login: conta.login,
      ...(contasAlternativas !== null && dir.length > 0 ? { configDir: dir } : {}),
    })
      .then(recarregar, () => undefined)
      .finally(() => {
        setSalvando(false);
        invalidateReads("connections.list");
        invalidateReads("mcp.list");
        // Escolhida a conta, a conferência de sempre mostra login e escopos.
        conferir();
      });
  };

  const recarregar = (): Promise<void> =>
    read("github.status").then(setRecarregado, () => undefined);

  const guardar = (): void => {
    setSalvando(true);
    // O campo é limpo antes mesmo da resposta: o que foi digitado já está a
    // caminho do cofre, e deixá-lo na tela só aumenta a chance de ele aparecer
    // numa captura ou num ombro alheio.
    const valor = token;
    setToken("");
    call("github.save", valor)
      .then(recarregar, () => undefined)
      .finally(() => {
        setSalvando(false);
        // O estado da conexão e o do servidor que usa o token dependem dele.
        invalidateReads("connections.list");
        invalidateReads("mcp.list");
        // A conferência anterior era do token antigo, e o serviço já a apagou.
        setConferencia({ fase: "parado" });
      });
  };

  const esquecer = (): void => {
    call("github.forget")
      .then(recarregar, () => undefined)
      .finally(() => {
        setConferencia({ fase: "parado" });
        invalidateReads("connections.list");
        invalidateReads("mcp.list");
      });
  };

  const conferir = (): void => {
    setConferencia({ fase: "conferindo" });
    call("github.check").then(
      (resultado) => {
        setConferencia({ fase: "respondeu", resultado });
        void recarregar();
      },
      // `check` devolve a recusa do GitHub como dado, então chegar aqui quer
      // dizer que a ponte recusou, e não que o token está errado.
      (erro: unknown) =>
        setConferencia({
          fase: "recusado",
          erro: erro instanceof Error ? erro.message : String(erro),
        }),
    );
  };

  const conferidoEm =
    estado?.checkedAt == null
      ? null
      : new Date(estado.checkedAt * 1000).toLocaleString(i18n.language);

  return (
    <div
      className={cn("flex flex-col gap-3", !embutido && "px-4 py-3")}
      data-locum-github-ambiente={estado?.env === true ? "sim" : "nao"}
      data-locum-github-cofre={estado?.vault === true ? "aberto" : "fechado"}
      data-locum-github-conferido={estado?.checkedAt ?? ""}
      data-locum-github-guardado={estado === null ? "" : estado.stored ? "sim" : "nao"}
      data-locum-github-login={estado?.identity?.login ?? ""}
      data-locum-probe="github"
    >
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {embutido ? null : (
          <>
            <span className="w-40 shrink-0 truncate font-medium">{estado?.ref ?? ""}</span>
            <Badge variant={estado?.stored === true ? "secondary" : "destructive"}>
              {t(estado?.stored === true ? "settings.github.stored" : "settings.github.absent")}
            </Badge>
          </>
        )}
        {estado?.env === true ? (
          <Badge variant="outline">{t("settings.github.fromEnv")}</Badge>
        ) : null}
        {estado?.vault === false ? (
          <Badge variant="outline">{t("settings.github.noVault")}</Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Button
            data-locum-github-conferir=""
            disabled={conferencia.fase === "conferindo"}
            onClick={conferir}
            size="sm"
            variant="ghost"
          >
            {t(
              conferencia.fase === "conferindo"
                ? "settings.github.checking"
                : "settings.github.check",
            )}
          </Button>
          {estado?.stored === true ? (
            <Button data-locum-github-esquecer="" onClick={esquecer} size="sm" variant="ghost">
              {t("settings.github.forget")}
            </Button>
          ) : null}
        </div>
      </div>

      {estado?.vinculo == null ? null : (
        <p className="text-muted-foreground text-xs" data-locum-github-vinculo="">
          {t("settings.github.linked", { login: estado.vinculo.login, host: estado.vinculo.host })}
        </p>
      )}

      {estado?.identity == null ? null : (
        <p className="text-muted-foreground text-xs" data-locum-github-identidade="">
          {t("settings.github.identity", {
            login: estado.identity.login,
            scopes:
              estado.identity.scopes.length === 0
                ? t("settings.github.fineGrained")
                : estado.identity.scopes.join(", "),
          })}
          {conferidoEm === null ? null : ` · ${t("settings.github.when", { when: conferidoEm })}`}
        </p>
      )}

      <div className="flex flex-col gap-2" data-locum-github-como-conectar="">
        <p className="text-xs font-medium">{t("settings.github.howToConnect")}</p>
        {contas.map((conta, i) => (
          <div
            className="flex flex-wrap items-center gap-2 text-sm"
            data-locum-github-conta-gh={`${conta.host}/${conta.login}`}
            key={`${conta.host}/${conta.login}`}
          >
            <span>{t("settings.github.ghAccount", { login: conta.login, host: conta.host })}</span>
            {i === 0 ? <Badge variant="secondary">{t("settings.github.recommended")}</Badge> : null}
            {conta.scopes.length === 0 ? null : (
              <span className="text-muted-foreground text-xs">{conta.scopes}</span>
            )}
            <Button
              data-locum-github-usar-gh=""
              disabled={salvando}
              onClick={() => usarGh(conta)}
              size="sm"
              variant="secondary"
            >
              {t("settings.github.use")}
            </Button>
          </div>
        ))}
        {contas.length === 0 ? (
          <p className="text-muted-foreground text-xs" data-locum-github-sem-gh="">
            {t("settings.github.noGh")}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label={t("settings.github.configDir")}
            autoComplete="off"
            className="border-border bg-background focus-visible:ring-ring min-w-64 flex-1 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
            data-locum-github-config-dir=""
            onChange={(evento) => setConfigDir(evento.target.value)}
            placeholder={t("settings.github.configDirPlaceholder")}
            spellCheck={false}
            type="text"
            value={configDir}
          />
          <Button onClick={procurarContas} size="sm" variant="ghost">
            {t("settings.github.detect")}
          </Button>
        </div>
        <p className="text-muted-foreground max-w-[68ch] text-xs">{t("settings.github.ssh")}</p>
        <p className="text-xs font-medium">{t("settings.github.tokenOption")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/*
         * Campo de senha, e não de texto: o valor colado aqui aparece em
         * gravação de tela e em quem estiver olhando de lado, e o campo fica
         * numa tela que se abre para conferir outras coisas.
         */}
        <input
          aria-label={t("settings.github.field")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring min-w-64 flex-1 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-github-token=""
          onChange={(evento) => setToken(evento.target.value)}
          placeholder={t("settings.github.placeholder")}
          spellCheck={false}
          type="password"
          value={token}
        />
        <Button
          data-locum-github-salvar=""
          disabled={salvando || token.trim().length === 0}
          onClick={guardar}
          size="sm"
          variant="secondary"
        >
          {t(salvando ? "settings.github.saving" : "settings.github.save")}
        </Button>
      </div>

      <p className="text-muted-foreground max-w-[68ch] text-xs">
        {t("settings.github.howTo")}
      </p>
      <p className="text-muted-foreground max-w-[68ch] text-xs" data-locum-github-permissoes="">
        {t("settings.github.permissions")}
      </p>

      <ResultadoDoGithub conferencia={conferencia} />
    </div>
  );
}

function ResultadoDoGithub({ conferencia }: { conferencia: Conferencia }) {
  const { t } = useTranslation();

  if (conferencia.fase === "parado" || conferencia.fase === "conferindo") return null;

  if (conferencia.fase === "recusado") {
    return (
      <p
        className="text-destructive text-xs"
        data-locum-github-resultado="recusado"
        data-locum-ok="nao"
      >
        {t("settings.github.refused", { message: conferencia.erro })}
      </p>
    );
  }

  const { resultado } = conferencia;
  if (resultado.ok) {
    return (
      <p
        className="text-muted-foreground text-xs"
        data-locum-github-resultado="ok"
        data-locum-ok="sim"
      >
        {t("settings.github.answered", {
          login: resultado.login,
          scopes:
            resultado.scopes.length === 0
              ? t("settings.github.fineGrained")
              : resultado.scopes.join(", "),
        })}
      </p>
    );
  }

  return (
    <p
      className="text-destructive text-xs"
      data-locum-github-resultado={resultado.reason}
      data-locum-ok="nao"
    >
      {resultado.reason === "missing"
        ? t("settings.github.missing")
        : t("settings.github.failed", { error: resultado.message })}
    </p>
  );
}

/* ----------------------------------------------------------------- trackers */

type ExameDoTracker =
  | { fase: "parado" }
  | { fase: "testando" }
  | { fase: "respondeu"; resultado: TesteDoTracker }
  | { fase: "recusado"; erro: string };

/**
 * Onde a tarefa vai parar: um Jira ou um repositório de issues do GitHub.
 *
 * O cadastro é o mesmo desenho da credencial do GitHub, logo acima: o que se
 * digita sai daqui numa direção só, para o keychain, e o que fica visível é se
 * existe algo guardado, quando foi o último teste e quantos destinos ele
 * enxergou. Não existe canal que devolva o valor.
 *
 * Testar pergunta ao tracker quais projetos a credencial alcança. É o teste de
 * conexão inteiro, e não um endpoint de saúde à parte: "o serviço está no ar"
 * responde bem para um token sem permissão de projeto nenhum, que é justamente
 * o caso em que alguém precisa saber que não vai funcionar.
 *
 * Abrir tarefa não tem botão aqui, e nem canal na ponte. Quem abre é o passo
 * de ação, que nasce em modo de aprovação e para na fila até alguém clicar.
 */
const ROTULO_DO_TRACKER: Record<Tracker["kind"], string> = {
  "jira-atlassian": "settings.trackers.kindJiraAtlassian",
  jira: "settings.trackers.kindJira",
  "github-issues": "settings.trackers.kindGithub",
  shortcut: "settings.trackers.kindShortcut",
};

export function Trackers({ kinds }: { kinds: Tracker["kind"][] }) {
  const { t } = useTranslation();
  const inicial = useRead("trackers.list");
  const [relido, setRelido] = useState<Tracker[] | null>(null);
  const [tipo, setTipo] = useState<Tracker["kind"]>(kinds[0] ?? "jira");
  const [id, setId] = useState("");
  const [nome, setNome] = useState("");
  const [url, setUrl] = useState("");
  const [conta, setConta] = useState("");
  const [projeto, setProjeto] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // Cada painel da vitrine mostra só os trackers do serviço dele: o Jira mora
  // com a Atlassian, o GitHub Issues com o GitHub.
  const lista = (relido ?? inicial.data ?? []).filter((tracker) => kinds.includes(tracker.kind));
  const recusa = erro ?? inicial.error?.message ?? null;

  const reler = (): Promise<void> =>
    read("trackers.list").then(setRelido, (falha: unknown) =>
      setErro(falha instanceof Error ? falha.message : String(falha)),
    );

  const agir = (acao: Promise<unknown>): Promise<void> => {
    setOcupado(true);
    return acao
      .then(
        () => setErro(null),
        (falha: unknown) => setErro(falha instanceof Error ? falha.message : String(falha)),
      )
      .then(reler)
      .finally(() => setOcupado(false));
  };

  const cadastrar = (): void => {
    const finalId = id.trim() || (tipo === "shortcut" ? "shortcut" : tipo === "github-issues" ? "github-issues" : "jira");
    const finalNome = nome.trim() || (tipo === "shortcut" ? "Shortcut" : tipo === "github-issues" ? "GitHub Issues" : "Jira");
    const finalUrl = url.trim() || (tipo === "shortcut" ? "https://api.app.shortcut.com/api/v3" : "");

    void agir(
      call("trackers.register", {
        id: finalId,
        kind: tipo,
        label: finalNome,
        baseUrl: finalUrl,
        account: tipo === "jira" ? conta.trim() : "",
        project: projeto.trim(),
      }).then(() => {
        setId("");
        setNome("");
        setUrl("");
        setConta("");
        setProjeto("");
      }),
    );
  };

  // O e-mail só é exigido no Jira por token, e o endereço só no Jira: o GitHub
  // e o Shortcut têm URLs de fábrica conhecidas.
  const jira = tipo === "jira" || tipo === "jira-atlassian";
  const ehShortcut = tipo === "shortcut";
  const ehGithub = tipo === "github-issues";
  // O detalhe do GitHub só fala de GitHub: nada de Jira, e a ajuda é a das issues.
  const somenteGithub = kinds.length === 1 && kinds[0] === "github-issues";
  const precisaUrl = tipo === "jira" || tipo === "jira-atlassian";

  const valido =
    (ehShortcut || ehGithub || id.trim() !== "") &&
    (ehShortcut || ehGithub || nome.trim() !== "") &&
    (!precisaUrl || url.trim() !== "") &&
    (tipo !== "jira" || conta.trim() !== "");

  return (
    <div
      className="flex flex-col gap-3 px-4 py-3"
      data-locum-probe="trackers"
      data-locum-trackers={lista.map((tracker) => tracker.id).join(",")}
    >
      {lista.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t(somenteGithub ? "settings.trackers.emptyGithub" : "settings.trackers.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {lista.map((tracker) => (
            <LinhaDoTracker
              key={tracker.id}
              ocupado={ocupado}
              recarregar={reler}
              tracker={tracker}
            />
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {kinds.length > 1 ? (
          <select
            aria-label={t("settings.trackers.kind")}
            className="border-border bg-background focus-visible:ring-ring rounded-md border px-2 py-1.5 text-xs outline-none focus-visible:ring-1"
            data-locum-tracker-tipo=""
            onChange={(evento) => {
              const novoTipo = evento.target.value as Tracker["kind"];
              setTipo(novoTipo);
              if (novoTipo === "shortcut" && !nome) setNome("Shortcut");
              if (novoTipo === "github-issues" && !nome) setNome("GitHub Issues");
            }}
            value={tipo}
          >
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {t(ROTULO_DO_TRACKER[kind])}
              </option>
            ))}
          </select>
        ) : null}
        {!ehShortcut && !ehGithub ? (
          <input
            aria-label={t("settings.trackers.id")}
            autoComplete="off"
            className="border-border bg-background focus-visible:ring-ring w-36 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
            data-locum-tracker-id=""
            onChange={(evento) => setId(evento.target.value)}
            placeholder={t("settings.trackers.idHint")}
            spellCheck={false}
            value={id}
          />
        ) : null}
        <input
          aria-label={t("settings.trackers.label")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-40 rounded-md border px-3 py-1.5 text-xs outline-none focus-visible:ring-1"
          data-locum-tracker-nome=""
          onChange={(evento) => setNome(evento.target.value)}
          placeholder={ehShortcut ? "Shortcut" : t("settings.trackers.labelHint")}
          spellCheck={false}
          value={nome}
        />
        {precisaUrl ? (
          <input
            aria-label={t("settings.trackers.baseUrl")}
            autoComplete="off"
            className="border-border bg-background focus-visible:ring-ring min-w-48 flex-1 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
            data-locum-tracker-url=""
            onChange={(evento) => setUrl(evento.target.value)}
            placeholder={t(
              jira ? "settings.trackers.baseUrlHint" : "settings.trackers.baseUrlDefault",
            )}
            spellCheck={false}
            value={url}
          />
        ) : null}
        {tipo === "jira" ? (
          <input
            aria-label={t("settings.trackers.account")}
            autoComplete="off"
            className="border-border bg-background focus-visible:ring-ring w-52 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
            data-locum-tracker-conta=""
            onChange={(evento) => setConta(evento.target.value)}
            placeholder={t("settings.trackers.accountHint")}
            spellCheck={false}
            value={conta}
          />
        ) : null}
        {!ehShortcut ? (
          <input
            aria-label={t("settings.trackers.project")}
            autoComplete="off"
            className="border-border bg-background focus-visible:ring-ring w-40 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
            data-locum-tracker-projeto=""
            onChange={(evento) => setProjeto(evento.target.value)}
            placeholder={t(
              jira
                ? "settings.trackers.projectHint"
                : "settings.trackers.repoHint",
            )}
            spellCheck={false}
            value={projeto}
          />
        ) : null}
        <Button
          data-locum-tracker-salvar=""
          disabled={ocupado || !valido}
          onClick={cadastrar}
          size="sm"
          variant="secondary"
        >
          {t("settings.trackers.add")}
        </Button>
      </div>

      <p className="text-muted-foreground max-w-[68ch] text-xs">
        {t(
          tipo === "jira-atlassian"
            ? "settings.trackers.howToAtlassian"
            : somenteGithub
              ? "settings.trackers.howToGithub"
              : "settings.trackers.howTo",
        )}
      </p>

      {recusa === null ? null : (
        <p className="text-destructive text-xs" data-locum-trackers-erro={recusa}>
          {t("settings.trackers.refused", { message: recusa })}
        </p>
      )}
    </div>
  );
}

function LinhaDoTracker({
  ocupado,
  recarregar,
  tracker,
}: {
  ocupado: boolean;
  recarregar: () => Promise<void>;
  tracker: Tracker;
}) {
  const { i18n, t } = useTranslation();
  const [valor, setValor] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [exame, setExame] = useState<ExameDoTracker>({ fase: "parado" });
  const [projetos, setProjetos] = useState<{ key: string; name: string }[] | null>(null);
  const [carregandoProjetos, setCarregandoProjetos] = useState(false);

  const buscarProjetos = (): void => {
    setCarregandoProjetos(true);
    call("trackers.projects", tracker.id)
      .then((lista) => setProjetos(lista))
      .catch(() => undefined)
      .finally(() => setCarregandoProjetos(false));
  };

  const selecionarProjeto = (dest: string): void => {
    void call("trackers.setProject", tracker.id, dest).then(recarregar);
  };

  const guardar = (): void => {
    setSalvando(true);
    // O campo é limpo antes da resposta, como na chave de provedor: o que foi
    // digitado já está a caminho do cofre, e deixá-lo na tela só aumenta a
    // chance de aparecer numa captura ou num ombro alheio.
    const digitado = valor;
    setValor("");
    void call("trackers.saveSecret", tracker.id, digitado)
      .then(recarregar, () => undefined)
      .finally(() => {
        setSalvando(false);
        // O teste anterior era da credencial antiga, e o serviço já o apagou.
        setExame({ fase: "parado" });
        buscarProjetos();
      });
  };

  const esquecer = (): void => {
    void call("trackers.forgetSecret", tracker.id)
      .then(recarregar, () => undefined)
      .finally(() => setExame({ fase: "parado" }));
  };

  const testar = (): void => {
    setExame({ fase: "testando" });
    void call("trackers.test", tracker.id).then(
      (resultado) => {
        setExame({ fase: "respondeu", resultado });
        void recarregar();
        buscarProjetos();
      },
      // `test` devolve a recusa do tracker como dado, então chegar aqui quer
      // dizer que a ponte recusou, e não que a credencial está errada.
      (falha: unknown) =>
        setExame({ fase: "recusado", erro: falha instanceof Error ? falha.message : String(falha) }),
    );
  };

  // Pela Atlassian não há token do tracker: a credencial é a da conexão, que
  // se autoriza e se esquece no próprio cartão da Atlassian.
  const pelaConexao = tracker.kind === "jira-atlassian";

  const testadoEm =
    tracker.checkedAt === null
      ? null
      : new Date(tracker.checkedAt * 1000).toLocaleString(i18n.language);

  return (
    <li
      className="border-border flex flex-col gap-1.5 rounded-md border px-3 py-2 text-sm"
      data-locum-tracker={tracker.id}
      data-locum-tracker-destino={tracker.project ?? ""}
      data-locum-tracker-guardado={tracker.stored ? "sim" : "nao"}
      data-locum-tracker-ligado={tracker.enabled ? "sim" : "nao"}
      data-locum-tracker-kind={tracker.kind}
      data-locum-tracker-projetos={tracker.projectCount ?? -1}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-[13px]">{tracker.id}</span>
        <span className="text-muted-foreground text-xs">{tracker.label}</span>
        <Badge variant="outline">
          {t(ROTULO_DO_TRACKER[tracker.kind])}
        </Badge>
        <span className="text-muted-foreground font-mono text-xs">{tracker.baseUrl}</span>
        {tracker.project === null ? null : (
          <span className="text-muted-foreground font-mono text-xs">{tracker.project}</span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Button
            data-locum-tracker-ligar={tracker.id}
            disabled={ocupado}
            onClick={() => {
              void call("trackers.setEnabled", tracker.id, !tracker.enabled).then(
                recarregar,
                () => undefined,
              );
            }}
            size="sm"
            variant="ghost"
          >
            {t(tracker.enabled ? "settings.trackers.disable" : "settings.trackers.enable")}
          </Button>
          <Button
            data-locum-tracker-remover={tracker.id}
            disabled={ocupado}
            onClick={() => {
              void call("trackers.remove", tracker.id).then(recarregar, () => undefined);
            }}
            size="sm"
            variant="ghost"
          >
            {t("settings.trackers.remove")}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {pelaConexao ? null : (
          <>
              <input
                aria-label={t("settings.trackers.field", { tracker: tracker.id })}
                autoComplete="off"
                className="border-border bg-background focus-visible:ring-ring min-w-56 flex-1 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
                data-locum-tracker-credencial={tracker.id}
                disabled={!tracker.vault}
                onChange={(evento) => setValor(evento.target.value)}
                placeholder={t(
                  tracker.vault ? "settings.trackers.placeholder" : "settings.trackers.noVault",
                )}
                spellCheck={false}
                type="password"
                value={valor}
              />
              <Button
                data-locum-tracker-guardar={tracker.id}
                disabled={salvando || !tracker.vault || valor.trim().length === 0}
                onClick={guardar}
                size="sm"
                variant="secondary"
              >
                {t(salvando ? "settings.trackers.saving" : "settings.trackers.save")}
              </Button>
          </>
        )}
        <Button
          data-locum-tracker-testar={tracker.id}
          disabled={exame.fase === "testando"}
          onClick={testar}
          size="sm"
          variant="ghost"
        >
          {t(exame.fase === "testando" ? "settings.trackers.testing" : "settings.trackers.test")}
        </Button>
        {tracker.stored && !pelaConexao ? (
          <Button
            data-locum-tracker-esquecer={tracker.id}
            onClick={esquecer}
            size="sm"
            variant="ghost"
          >
            {t("settings.trackers.forget")}
          </Button>
        ) : null}

        {tracker.stored && projetos && projetos.length > 0 ? (
          <div className="flex items-center gap-1.5 ml-2">
            <span className="text-xs text-muted-foreground font-medium">{t("settings.trackers.projectLabel")}</span>
            <select
              className="border-border bg-background focus-visible:ring-ring rounded-md border px-2 py-1 text-xs outline-none focus-visible:ring-1"
              disabled={ocupado}
              onChange={(e) => selecionarProjeto(e.target.value)}
              value={tracker.project ?? ""}
            >
              <option value="">{t("settings.trackers.selectProject")}</option>
              {projetos.map((p) => (
                <option key={p.key} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        ) : tracker.stored && (tracker.kind === "shortcut" || tracker.kind === "jira-atlassian") ? (
          <Button
            className="text-xs"
            disabled={carregandoProjetos}
            onClick={buscarProjetos}
            size="sm"
            variant="outline"
          >
            {carregandoProjetos ? "Buscando..." : "Carregar Projetos"}
          </Button>
        ) : null}
      </div>

      <p className="text-muted-foreground text-xs">
        {t(
          pelaConexao
            ? tracker.stored
              ? tracker.kind === "shortcut" ? "settings.trackers.viaShortcut" : "settings.trackers.viaAtlassian"
              : tracker.kind === "shortcut" ? "settings.trackers.shortcutMissing" : "settings.trackers.atlassianMissing"
            : tracker.stored
              ? "settings.trackers.stored"
              : "settings.trackers.absent",
        )}
        {testadoEm === null
          ? null
          : ` · ${t("settings.trackers.lastCheck", {
              count: tracker.projectCount ?? 0,
              when: testadoEm,
            })}`}
      </p>

      <ResultadoDoTracker exame={exame} pelaConexao={pelaConexao} tracker={tracker.id} />
    </li>
  );
}

function ResultadoDoTracker({
  exame,
  pelaConexao,
  tracker,
}: {
  exame: ExameDoTracker;
  pelaConexao: boolean;
  tracker: string;
}) {
  const { t } = useTranslation();
  if (exame.fase === "parado" || exame.fase === "testando") return null;

  if (exame.fase === "recusado") {
    return (
      <p
        className="text-destructive text-xs"
        data-locum-tracker-resultado="recusado"
        data-locum-tracker-teste={tracker}
      >
        {t("settings.trackers.bridgeRefused", { message: exame.erro })}
      </p>
    );
  }

  const resultado = exame.resultado;
  if (resultado.ok) {
    return (
      <p
        className="text-muted-foreground text-xs"
        data-locum-ok="sim"
        data-locum-projetos={resultado.count}
        data-locum-tracker-resultado="ok"
        data-locum-tracker-teste={tracker}
      >
        {t("settings.trackers.answered", { count: resultado.count })}
      </p>
    );
  }

  return (
    <p
      className="text-destructive text-xs"
      data-locum-ok="nao"
      data-locum-projetos={-1}
      data-locum-tracker-resultado={resultado.reason}
      data-locum-tracker-teste={tracker}
    >
      {resultado.reason === "missing"
        ? t(pelaConexao ? "settings.trackers.atlassianMissing" : "settings.trackers.missing")
        : t("settings.trackers.failed", { error: resultado.message })}
    </p>
  );
}

/* -------------------------------------------------------------------- slack */

/**
 * O que esta máquina observa no Slack.
 *
 * Não há campo de token, e não é esquecimento: quem fala com o Slack é o
 * servidor MCP que alguém já autorizou, e aqui só se escolhe qual dos
 * cadastrados é ele. Uma credencial própria seria um segundo lugar de onde a
 * mesma conversa poderia vazar.
 *
 * Os nomes de argumento aparecem porque variam de um servidor de Slack para
 * outro: um chama o canal de `channel_id` e o outro de `channel`. Vêm
 * preenchidos com os mais comuns para que ninguém precise descobri-los antes de
 * observar o primeiro canal.
 *
 * Os da resposta são outros que os da leitura, e por isso têm campo próprio: a
 * ferramenta que lista histórico e a que publica em thread raramente chamam o
 * canal pelo mesmo nome.
 *
 * Nada aqui publica. Cadastrar canal faz o Locum ler, e cadastrar a ferramenta
 * de resposta só diz por onde ela sairia: responder em thread é passo de ação,
 * que para na fila de aprovação e espera o clique de alguém.
 */
/**
 * Slack pelo servidor MCP oficial, com o app que a pessoa cria no workspace.
 *
 * O Slack não tem registro automático de cliente, então o caminho é guiado:
 * criar o app pelo manifesto, ligar o MCP nele, colar o client id e autorizar.
 * O client id não é segredo (o app é público, com PKCE) e fica na máquina.
 */
export function SlackOficial() {
  const { t } = useTranslation();
  const inicial = useRead("connections.slackApp");
  const [relido, setRelido] = useState<AppDoSlack | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  const app = relido ?? inicial.data ?? null;
  const valorDoClientId = clientId ?? app?.clientId ?? "";
  const recusa = erro ?? inicial.error?.message ?? null;

  const agir = (acao: Promise<unknown>): void => {
    setOcupado(true);
    acao
      .then(
        () => setErro(null),
        (falha: unknown) => setErro(falha instanceof Error ? falha.message : String(falha)),
      )
      .then(() => read("connections.slackApp").then(setRelido, () => undefined))
      .finally(() => setOcupado(false));
  };

  const copiar = (): void => {
    if (app === null) return;
    void navigator.clipboard.writeText(app.manifest).then(() => {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    });
  };

  return (
    <div
      className="border-border flex flex-col gap-3 border-b px-4 py-3"
      data-locum-probe="slack-oficial"
      data-locum-slack-oficial-conectado={app?.connected ? "sim" : "nao"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t("settings.slackOfficial.title")}</span>
        {app?.connected ? <Badge variant="secondary">{t("settings.slackOfficial.connected")}</Badge> : null}
      </div>
      <p className="text-muted-foreground text-xs">{t("settings.slackOfficial.description")}</p>

      <ol className="text-muted-foreground flex list-decimal flex-col gap-1 pl-5 text-xs">
        <li>{t("settings.slackOfficial.stepCreate")}</li>
        <li>{t("settings.slackOfficial.stepMcp")}</li>
        <li>{t("settings.slackOfficial.stepInstall")}</li>
        <li>{t("settings.slackOfficial.stepClientId")}</li>
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-locum-slack-manifesto=""
          disabled={ocupado}
          onClick={() => agir(call("connections.openSlackManifest"))}
          size="sm"
          variant="secondary"
        >
          {t("settings.slackOfficial.openManifest")}
        </Button>
        <Button disabled={app === null} onClick={copiar} size="sm" variant="ghost">
          {copiado ? t("settings.slackOfficial.copied") : t("settings.slackOfficial.copyManifest")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={t("settings.slackOfficial.clientId")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-64 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-slack-client-id=""
          onChange={(evento) => setClientId(evento.target.value)}
          placeholder={t("settings.slackOfficial.clientIdHint")}
          spellCheck={false}
          value={valorDoClientId}
        />
        <Button
          data-locum-slack-conectar=""
          disabled={ocupado || valorDoClientId.trim() === ""}
          onClick={() => agir(call("connections.connectSlack", valorDoClientId.trim()))}
          size="sm"
        >
          {app?.connected ? t("settings.slackOfficial.reconnect") : t("settings.slackOfficial.connect")}
        </Button>
        {app?.connected ? (
          <Button
            disabled={ocupado}
            onClick={() => agir(call("connections.disconnectSlack"))}
            size="sm"
            variant="ghost"
          >
            {t("settings.slackOfficial.disconnect")}
          </Button>
        ) : null}
      </div>

      {ocupado ? <p className="text-muted-foreground text-xs">{t("settings.slackOfficial.waiting")}</p> : null}
      {recusa !== null ? (
        <p className="text-destructive text-xs" data-locum-slack-oficial-erro="">
          {recusa}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------- teams */

/**
 * Teams pelo Microsoft Graph, com o app que a organização registra no Entra.
 *
 * O caminho é guiado como o do Slack: registrar o app (pelo portal ou pelo
 * comando da CLI do Azure), colar tenant e client id e autorizar. Nenhum dos
 * dois é segredo, e os dois ficam na máquina. O consentimento do administrador
 * é opcional e só serve à empresa que não deixa o usuário consentir sozinho.
 */
export function TeamsPeloGraph() {
  const { t } = useTranslation();
  const inicial = useRead("connections.teamsApp");
  const [relido, setRelido] = useState<AppDoTeams | null>(null);
  const [tenant, setTenant] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  const app = relido ?? inicial.data ?? null;
  const valorDoTenant = tenant ?? app?.tenantId ?? "";
  const valorDoClientId = clientId ?? app?.clientId ?? "";
  const preenchido = valorDoTenant.trim() !== "" && valorDoClientId.trim() !== "";
  const recusa = erro ?? inicial.error?.message ?? null;

  const agir = (acao: Promise<unknown>, sucesso: string | null = null): void => {
    setOcupado(true);
    setAviso(null);
    acao
      .then(
        () => {
          setErro(null);
          setAviso(sucesso);
        },
        (falha: unknown) => setErro(falha instanceof Error ? falha.message : String(falha)),
      )
      .then(() => read("connections.teamsApp").then(setRelido, () => undefined))
      .finally(() => setOcupado(false));
  };

  const copiar = (): void => {
    if (app === null) return;
    void navigator.clipboard.writeText(app.command).then(() => {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    });
  };

  const campo =
    "border-border bg-background focus-visible:ring-ring w-80 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1";

  return (
    <div
      className="border-border flex flex-col gap-3 border-b px-4 py-3"
      data-locum-probe="teams"
      data-locum-teams-conectado={app?.connected ? "sim" : "nao"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t("settings.teams.title")}</span>
        {app?.connected ? <Badge variant="secondary">{t("settings.teams.connected")}</Badge> : null}
      </div>
      <p className="text-muted-foreground text-xs">{t("settings.teams.description")}</p>

      <ol className="text-muted-foreground flex list-decimal flex-col gap-1 pl-5 text-xs">
        <li>{t("settings.teams.stepRegister", { redirect: app?.redirectUri ?? "" })}</li>
        <li>
          {t(app?.channels ? "settings.teams.stepPermissionsChannels" : "settings.teams.stepPermissions", {
            scopes: (app?.scopes ?? []).join(", "),
          })}
        </li>
        <li>{t("settings.teams.stepIds")}</li>
      </ol>

      <div className="flex flex-col gap-1">
        <code className="bg-muted text-muted-foreground block overflow-x-auto rounded-md px-2 py-1 font-mono text-[11px] whitespace-nowrap">
          {app?.command ?? ""}
        </code>
        <div>
          <Button disabled={app === null} onClick={copiar} size="sm" variant="ghost">
            {copiado ? t("settings.teams.copied") : t("settings.teams.copyCommand")}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={t("settings.teams.tenant")}
          autoComplete="off"
          className={campo}
          data-locum-teams-tenant=""
          onChange={(evento) => setTenant(evento.target.value)}
          placeholder={t("settings.teams.tenantHint")}
          spellCheck={false}
          value={valorDoTenant}
        />
        <input
          aria-label={t("settings.teams.clientId")}
          autoComplete="off"
          className={campo}
          data-locum-teams-client-id=""
          onChange={(evento) => setClientId(evento.target.value)}
          placeholder={t("settings.teams.clientIdHint")}
          spellCheck={false}
          value={valorDoClientId}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-locum-teams-conectar=""
          disabled={ocupado || !preenchido}
          onClick={() => agir(call("connections.connectTeams", valorDoTenant.trim(), valorDoClientId.trim()))}
          size="sm"
        >
          {app?.connected ? t("settings.teams.reconnect") : t("settings.teams.connect")}
        </Button>
        <Button
          data-locum-teams-admin=""
          disabled={ocupado || !preenchido}
          onClick={() =>
            agir(
              call("connections.teamsAdminConsent", valorDoTenant.trim(), valorDoClientId.trim()),
              t("settings.teams.adminDone"),
            )
          }
          size="sm"
          variant="secondary"
        >
          {t("settings.teams.admin")}
        </Button>
        {app?.connected ? (
          <Button
            disabled={ocupado}
            onClick={() => agir(call("connections.disconnectTeams"))}
            size="sm"
            variant="ghost"
          >
            {t("settings.teams.disconnect")}
          </Button>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">{t("settings.teams.adminHow")}</p>

      <label className="flex cursor-pointer items-start gap-2 text-xs">
        <input
          checked={app?.channels ?? false}
          className="mt-0.5"
          data-locum-teams-canais-ligar=""
          disabled={ocupado || app === null}
          onChange={(evento) =>
            agir(
              call("connections.setTeamsChannels", evento.target.checked),
              app?.connected ? t("settings.teamsChannels.reconnect") : null,
            )
          }
          type="checkbox"
        />
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">{t("settings.teamsChannels.toggle")}</span>
          <span className="text-muted-foreground">
            {t("settings.teamsChannels.toggleHint", { scopes: (app?.channelScopes ?? []).join(", ") })}
          </span>
        </span>
      </label>

      {ocupado ? <p className="text-muted-foreground text-xs">{t("settings.teams.waiting")}</p> : null}
      {aviso !== null ? <p className="text-muted-foreground text-xs">{aviso}</p> : null}
      {recusa !== null ? (
        <p className="text-destructive text-xs" data-locum-teams-erro="">
          {recusa}
        </p>
      ) : null}
    </div>
  );
}

export function Slack() {
  const { t } = useTranslation();
  const servidores = useRead("mcp.list");
  const inicial = useRead("slack.get");
  const [recarregado, setRecarregado] = useState<CadastroDoSlack | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const cadastro = recarregado ?? inicial.data ?? null;
  const recusa = erro ?? inicial.error?.message ?? null;

  // Enquanto a leitura não voltou não há o que editar, e um formulário vazio
  // que aceitasse clique gravaria cadastro por cima do que ainda estava vindo.
  const [servidor, setServidor] = useState<string | null>(null);
  const [ferramenta, setFerramenta] = useState<string | null>(null);
  const [argCanal, setArgCanal] = useState<string | null>(null);
  const [argJanela, setArgJanela] = useState<string | null>(null);
  const [ferramentaDaResposta, setFerramentaDaResposta] = useState<string | null>(null);
  const [argCanalDaResposta, setArgCanalDaResposta] = useState<string | null>(null);
  const [argTexto, setArgTexto] = useState<string | null>(null);
  const [argThread, setArgThread] = useState<string | null>(null);

  const valorDoServidor = servidor ?? cadastro?.server ?? "";
  const valorDaFerramenta = ferramenta ?? cadastro?.tool ?? "";
  const valorDoArgCanal = argCanal ?? cadastro?.channelArg ?? "";
  const valorDoArgJanela = argJanela ?? cadastro?.sinceArg ?? "";
  const valorDaResposta = ferramentaDaResposta ?? cadastro?.postTool ?? "";
  const valorDoArgCanalDaResposta = argCanalDaResposta ?? cadastro?.postChannelArg ?? "";
  const valorDoArgTexto = argTexto ?? cadastro?.textArg ?? "";
  const valorDoArgThread = argThread ?? cadastro?.threadArg ?? "";

  const recarregar = (): Promise<void> =>
    read("slack.get").then(setRecarregado, (falha: unknown) =>
      setErro(falha instanceof Error ? falha.message : String(falha)),
    );

  const agir = (acao: Promise<unknown>): void => {
    setOcupado(true);
    acao
      .then(
        () => setErro(null),
        (falha: unknown) => setErro(falha instanceof Error ? falha.message : String(falha)),
      )
      .then(recarregar)
      .finally(() => setOcupado(false));
  };

  const podeSalvar =
    valorDoServidor !== "" &&
    valorDaFerramenta.trim() !== "" &&
    valorDoArgCanal.trim() !== "" &&
    valorDoArgJanela.trim() !== "" &&
    valorDaResposta.trim() !== "" &&
    valorDoArgCanalDaResposta.trim() !== "" &&
    valorDoArgTexto.trim() !== "" &&
    valorDoArgThread.trim() !== "";

  const salvar = (): void => {
    agir(
      call("slack.setSource", {
        server: valorDoServidor,
        tool: valorDaFerramenta.trim(),
        channelArg: valorDoArgCanal.trim(),
        sinceArg: valorDoArgJanela.trim(),
        postTool: valorDaResposta.trim(),
        postChannelArg: valorDoArgCanalDaResposta.trim(),
        textArg: valorDoArgTexto.trim(),
        threadArg: valorDoArgThread.trim(),
      }),
    );
  };

  const canais = cadastro?.channels ?? [];

  return (
    <details
      className="px-4 py-3"
      data-locum-probe="slack"
      data-locum-slack-canais={canais.join(",")}
      data-locum-slack-ferramenta-atual={cadastro?.tool ?? ""}
      data-locum-slack-resposta-atual={cadastro?.postTool ?? ""}
      data-locum-slack-servidor={cadastro?.server ?? ""}
    >
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
        {t("settings.slack.advanced")}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <p className="text-muted-foreground max-w-[68ch] text-xs">{t("settings.slack.advancedHint")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={t("settings.slack.server")}
            className="border-border bg-background cursor-pointer rounded-md border px-2 py-1.5 text-xs"
            data-locum-slack-escolha=""
            onChange={(evento) => setServidor(evento.target.value)}
            value={valorDoServidor}
          >
            <option value="">{t("settings.slack.serverNone")}</option>
            {(servidores.data ?? []).map((s) => (
              <option key={s.config.name} value={s.config.name}>
                {s.config.name}
              </option>
            ))}
          </select>

          <input
            aria-label={t("settings.slack.tool")}
            autoComplete="off"
            className="border-border bg-background focus-visible:ring-ring w-52 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
            data-locum-slack-ferramenta=""
            onChange={(evento) => setFerramenta(evento.target.value)}
            placeholder={t("settings.slack.toolHint")}
            spellCheck={false}
            value={valorDaFerramenta}
          />

          <input
            aria-label={t("settings.slack.channelArg")}
            autoComplete="off"
            className="border-border bg-background focus-visible:ring-ring w-32 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
            data-locum-slack-arg-canal=""
            onChange={(evento) => setArgCanal(evento.target.value)}
            placeholder={t("settings.slack.channelArgHint")}
            spellCheck={false}
            value={valorDoArgCanal}
          />

          <input
            aria-label={t("settings.slack.sinceArg")}
            autoComplete="off"
            className="border-border bg-background focus-visible:ring-ring w-32 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
            data-locum-slack-arg-janela=""
            onChange={(evento) => setArgJanela(evento.target.value)}
            placeholder={t("settings.slack.sinceArgHint")}
            spellCheck={false}
            value={valorDoArgJanela}
          />

          <input
            aria-label={t("settings.slack.postTool")}
            autoComplete="off"
            className="border-border bg-background focus-visible:ring-ring w-52 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
            data-locum-slack-ferramenta-resposta=""
            onChange={(evento) => setFerramentaDaResposta(evento.target.value)}
            placeholder={t("settings.slack.postToolHint")}
            spellCheck={false}
            value={valorDaResposta}
          />

          <input
            aria-label={t("settings.slack.postChannelArg")}
            autoComplete="off"
            className="border-border bg-background focus-visible:ring-ring w-32 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
            data-locum-slack-arg-canal-resposta=""
            onChange={(evento) => setArgCanalDaResposta(evento.target.value)}
            placeholder={t("settings.slack.postChannelArgHint")}
            spellCheck={false}
            value={valorDoArgCanalDaResposta}
          />

          <input
            aria-label={t("settings.slack.textArg")}
            autoComplete="off"
            className="border-border bg-background focus-visible:ring-ring w-32 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
            data-locum-slack-arg-texto=""
            onChange={(evento) => setArgTexto(evento.target.value)}
            placeholder={t("settings.slack.textArgHint")}
            spellCheck={false}
            value={valorDoArgTexto}
          />

          <input
            aria-label={t("settings.slack.threadArg")}
            autoComplete="off"
            className="border-border bg-background focus-visible:ring-ring w-32 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
            data-locum-slack-arg-thread=""
            onChange={(evento) => setArgThread(evento.target.value)}
            placeholder={t("settings.slack.threadArgHint")}
            spellCheck={false}
            value={valorDoArgThread}
          />

          <Button
            data-locum-slack-salvar=""
            disabled={ocupado || !podeSalvar}
            onClick={salvar}
            size="sm"
            variant="secondary"
          >
            {t("settings.slack.save")}
          </Button>
        </div>

        {canais.length === 0 ? null : (
          <>
          <p className="text-muted-foreground max-w-[68ch] text-xs">{t("settings.slack.legacyChannels")}</p>
          <ul className="flex flex-wrap gap-2">
            {canais.map((observado) => (
              <li
                className="border-border flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
                data-locum-slack-canal={observado}
                key={observado}
              >
                <span className="font-mono text-xs">{observado}</span>
                <Button
                  data-locum-slack-remover={observado}
                  disabled={ocupado}
                  onClick={() => agir(call("slack.removeChannel", observado))}
                  size="sm"
                  variant="ghost"
                >
                  {t("settings.slack.remove")}
                </Button>
              </li>
            ))}
          </ul>
          </>
        )}

        {recusa === null ? null : (
          <p className="text-destructive text-xs" data-locum-slack-erro={recusa}>
            {t("settings.slack.refused", { message: recusa })}
          </p>
        )}
      </div>
    </details>
  );
}

