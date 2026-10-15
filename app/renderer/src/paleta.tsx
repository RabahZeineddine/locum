import { ArrowRight, Blocks, Bot, Plus, Search, Target, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Kbd } from "@/components/ui/kbd";
import { pedirAcaoDaTela } from "@/lib/acao-da-tela";
import { filtrarComandos, type GrupoDaPaleta as Grupo } from "@/lib/paleta";
import { call, useRead } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import { useCurrentInitiative } from "./current-initiative";
import { ROTAS_DA_BARRA, type TelaProps } from "./rotas";

const TECLA_ESC = "esc";

/** A barra lateral e outras telas abrem a paleta por este evento. */
export const EVENTO_ABRIR_PALETA = "locum:abrir-paleta";

interface Comando {
  id: string;
  grupo: Grupo;
  rotulo: string;
  icone?: ReactNode;
  /** Texto extra para a busca achar o comando por outro nome. */
  palavras?: string;
  executar: () => void;
}

const ROTULO_DO_GRUPO: Record<Grupo, string> = {
  actions: "palette.groupActions",
  go: "palette.groupGo",
  connections: "palette.groupConnections",
  agents: "palette.groupAgents",
  automations: "palette.groupAutomations",
  initiatives: "palette.groupInitiatives",
  prompts: "palette.groupPrompts",
};

/**
 * A paleta de comandos (⌘K): ir para qualquer tela, conexão, agent, automação
 * ou iniciativa pelo nome, e as ações de criar.
 *
 * A lista é escrita à mão aqui dentro, montada a partir das leituras que as
 * telas já fazem, pelo mesmo motivo do catálogo de canais do chat: decisão de
 * publicação (aprovar, comentar) nunca entra numa lista destas, então a lista
 * nunca vem de "todo canal disponível", só do que este arquivo escolheu
 * pendurar.
 *
 * Fechada, ela só escuta o teclado: as leituras vivem em `PaletaAberta`, que
 * monta na abertura.
 */
export function Paleta({ navegar }: { navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  const [aberta, setAberta] = useState(false);
  const fechar = useCallback(() => setAberta(false), []);

  useEffect(() => {
    const ouvir = (evento: KeyboardEvent) => {
      const comando = evento.metaKey || evento.ctrlKey;
      // `metaKey` no macOS, `ctrlKey` para quem chegar de teclado de PC.
      if (evento.key.toLowerCase() === "k" && comando) {
        evento.preventDefault();
        setAberta((antes) => !antes);
        return;
      }
      // ⌘J abre o Assistente por cima: a paleta sai da frente.
      if (evento.key.toLowerCase() === "j" && comando) setAberta(false);
      if (evento.key === "Escape") setAberta(false);
    };
    const abrir = () => setAberta(true);

    globalThis.addEventListener("keydown", ouvir);
    globalThis.addEventListener(EVENTO_ABRIR_PALETA, abrir);
    return () => {
      globalThis.removeEventListener("keydown", ouvir);
      globalThis.removeEventListener(EVENTO_ABRIR_PALETA, abrir);
    };
  }, []);

  return (
    <div data-aberta={aberta ? "sim" : "nao"} data-locum-probe="paleta">
      {aberta ? (
        <div
          aria-label={t("palette.label")}
          aria-modal="true"
          className="sem-arrasto fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[16vh]"
          onClick={(evento) => {
            if (evento.target === evento.currentTarget) setAberta(false);
          }}
          role="dialog"
        >
          <PaletaAberta fechar={fechar} navegar={navegar} />
        </div>
      ) : null}
    </div>
  );
}

function PaletaAberta({ fechar, navegar }: { fechar: () => void; navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  const [consulta, setConsulta] = useState("");
  const [indice, setIndice] = useState(0);
  const campo = useRef<HTMLInputElement>(null);
  const lista = useRef<HTMLDivElement>(null);

  const iniciativas = useRead("initiatives.list");
  const prompts = useRead("prompts.list");
  const conexoes = useRead("connections.list");
  const agents = useRead("library.profiles");
  const automacoes = useRead("agents.overview");
  const atual = useCurrentInitiative();

  useEffect(() => campo.current?.focus(), []);
  useEffect(() => setIndice(0), [consulta]);

  const comandos = useMemo<Comando[]>(() => {
    const ir = (fazer: () => void) => () => {
      fechar();
      fazer();
    };

    const acoes: Comando[] = [
      {
        id: "action:new-automation",
        grupo: "actions",
        rotulo: t("palette.newAutomation"),
        icone: <Plus />,
        executar: ir(() => {
          navegar("automations");
          pedirAcaoDaTela("nova-automacao");
        }),
      },
      {
        id: "action:new-agent",
        grupo: "actions",
        rotulo: t("palette.newAgent"),
        icone: <Plus />,
        executar: ir(() => navegar("agents", "novo")),
      },
      {
        id: "action:add-connection",
        grupo: "actions",
        rotulo: t("palette.addConnection"),
        icone: <Plus />,
        executar: ir(() => {
          navegar("connections");
          pedirAcaoDaTela("adicionar-conexao");
        }),
      },
    ];

    const telas: Comando[] = ROTAS_DA_BARRA.map(({ id, rotulo, icone: Icone }) => ({
      id: `go:${id}`,
      grupo: "go",
      rotulo: t("palette.goTo", { name: t(rotulo) }),
      palavras: t(rotulo),
      icone: <Icone />,
      executar: ir(() => navegar(id)),
    }));

    const deConexoes: Comando[] = (conexoes.data ?? []).map((c) => ({
      id: `connection:${c.id}`,
      grupo: "connections",
      rotulo: c.name,
      icone: <Blocks />,
      executar: ir(() => navegar("connections", c.id)),
    }));

    const deAgents: Comando[] = (agents.data ?? []).map((a) => ({
      id: `agent:${a.id}`,
      grupo: "agents",
      rotulo: a.name,
      icone: <Bot />,
      executar: ir(() => navegar("agents", a.id)),
    }));

    const deAutomacoes: Comando[] = (automacoes.data ?? []).map((a) => ({
      id: `automation:${a.id}`,
      grupo: "automations",
      rotulo: a.name,
      icone: <Workflow />,
      executar: ir(() => navegar("automations", a.id)),
    }));

    const irParaIniciativa: Comando[] = (iniciativas.data ?? []).map((iniciativa) => ({
      id: `initiative:${iniciativa.slug}`,
      grupo: "initiatives",
      rotulo: iniciativa.title,
      icone: <Target />,
      executar: ir(() => navegar("initiatives", iniciativa.slug)),
    }));

    const copiarPrompt: Comando[] = (prompts.data ?? []).map((prompt) => ({
      id: `prompt:${prompt.id}`,
      grupo: "prompts",
      rotulo: t("palette.copyPrompt", { name: prompt.name }),
      executar: ir(() => {
        navigator.clipboard.writeText(prompt.body);
      }),
    }));

    // A aba de acoes mostra o resultado; a paleta so dispara e leva ate la.
    const iniciativaAtual = (iniciativas.data ?? []).find((iniciativa) => iniciativa.slug === atual.slug);
    const abrirSessao: Comando[] = iniciativaAtual
      ? [
          {
            id: `session:${iniciativaAtual.slug}`,
            grupo: "actions",
            rotulo: t("palette.openSession", { title: iniciativaAtual.title }),
            executar: ir(() => {
              navegar("initiatives", `${iniciativaAtual.slug}/actions`);
              call("sessions.open", iniciativaAtual.slug, {}).catch((erro: unknown) => {
                console.error("[paleta] sessions.open recusado", erro);
              });
            }),
          },
        ]
      : [];

    return [...acoes, ...abrirSessao, ...telas, ...deConexoes, ...deAgents, ...deAutomacoes, ...irParaIniciativa, ...copiarPrompt];
  }, [agents.data, atual.slug, automacoes.data, conexoes.data, fechar, iniciativas.data, navegar, prompts.data, t]);

  const filtrados = useMemo(() => filtrarComandos(comandos, consulta), [comandos, consulta]);

  useEffect(() => {
    lista.current?.querySelector(`[data-indice="${indice}"]`)?.scrollIntoView({ block: "nearest" });
  }, [indice]);

  const aoTeclar = (evento: React.KeyboardEvent): void => {
    const comando = evento.metaKey || evento.ctrlKey;
    if (evento.key === "ArrowDown" || (evento.ctrlKey && evento.key.toLowerCase() === "n")) {
      evento.preventDefault();
      setIndice((i) => (filtrados.length === 0 ? 0 : (i + 1) % filtrados.length));
    } else if (evento.key === "ArrowUp" || (evento.ctrlKey && evento.key.toLowerCase() === "p")) {
      evento.preventDefault();
      setIndice((i) => (filtrados.length === 0 ? 0 : (i - 1 + filtrados.length) % filtrados.length));
    } else if (evento.key === "Enter") {
      evento.preventDefault();
      filtrados[indice]?.executar();
    } else if (evento.key === "Tab") {
      evento.preventDefault();
    }
    // As teclas de digitar não chegam aos atalhos das telas por trás; ⌘K, ⌘J e Esc seguem para a janela.
    if (!comando && evento.key !== "Escape") evento.stopPropagation();
  };

  return (
    <div
      className="w-full max-w-[560px] overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
      onKeyDown={aoTeclar}
      // Clicar em área sem campo não tira o foco do input.
      onMouseDown={(evento) => {
        if (evento.target !== campo.current) evento.preventDefault();
      }}
    >
      <div className="flex items-center gap-2 border-border border-b px-3">
        <Search aria-hidden className="text-muted-foreground size-4 shrink-0" />
        <input
          aria-activedescendant={filtrados.length === 0 ? undefined : `paleta-opcao-${indice}`}
          aria-controls="paleta-lista"
          aria-expanded="true"
          aria-label={t("palette.label")}
          className="h-11 w-full bg-transparent text-[14px] text-popover-foreground outline-none placeholder:text-muted-foreground"
          onChange={(e) => setConsulta(e.target.value)}
          placeholder={t("palette.placeholder")}
          ref={campo}
          role="combobox"
          type="text"
          value={consulta}
        />
        <Kbd>{TECLA_ESC}</Kbd>
      </div>
      <div data-locum-probe="paleta-comandos" data-total={filtrados.length} ref={lista}>
        {filtrados.length === 0 ? (
          <div className="px-4 py-8 text-center text-muted-foreground text-[13px]">{t("palette.empty")}</div>
        ) : (
          <div className="max-h-[360px] overflow-auto p-1.5" id="paleta-lista" role="listbox">
            {filtrados.map((comando, i) => (
              <div key={comando.id} role="presentation">
                {i === 0 || filtrados[i - 1]?.grupo !== comando.grupo ? (
                  <div className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground" role="presentation">
                    {t(ROTULO_DO_GRUPO[comando.grupo])}
                  </div>
                ) : null}
                <button
                  aria-selected={i === indice}
                  className={cn(
                    "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-left text-[13px]",
                    i === indice ? "bg-accent text-accent-foreground" : "text-popover-foreground",
                  )}
                  data-indice={i}
                  id={`paleta-opcao-${i}`}
                  onClick={comando.executar}
                  onMouseMove={() => setIndice(i)}
                  role="option"
                  tabIndex={-1}
                  type="button"
                >
                  <span className="text-muted-foreground flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5">{comando.icone ?? <ArrowRight />}</span>
                  <span className="min-w-0 flex-1 truncate">{comando.rotulo}</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-4 border-border border-t px-3 py-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          {t("palette.hintNavigate")}
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>↵</Kbd>
          {t("palette.hintSelect")}
        </span>
      </div>
    </div>
  );
}
