import { Braces } from "lucide-react";
import type { GrupoDeReferencias, Referencia } from "../../../src/config/referencias";
import { posicaoDoCursor, type PosicaoDoCursor } from "@/lib/posicao-do-cursor";
import { filtrarSugestoes, inserirSugestao, marcadorAberto } from "@/lib/sugestao-de-variavel";
import { cn } from "@/lib/utils";
import { createContext, createElement, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { useTranslation } from "react-i18next";

/**
 * O que o passo aberto pode citar com `{{...}}`: o painel do nó entrega o
 * catálogo uma vez, e cada campo com marcador o lê daqui. Fora de um painel o
 * campo é um campo comum.
 */
const VariaveisContext = createContext<readonly GrupoDeReferencias[]>([]);
export const VariaveisDoNo = VariaveisContext.Provider;
export const useVariaveisDoNo = (): readonly GrupoDeReferencias[] => useContext(VariaveisContext);

type Opcao = { grupo: GrupoDeReferencias; item: Referencia };
type Campo = HTMLInputElement & HTMLTextAreaElement;

type Props = Omit<ComponentPropsWithoutRef<"input">, "value" | "onChange" | "type"> & {
  tipo?: "input" | "textarea";
  valor: string;
  mudar: (valor: string) => void;
  /** Catálogo próprio; sem ele vale o do painel. */
  grupos?: readonly GrupoDeReferencias[];
};

const LARGURA_DA_LISTA = 288;

/**
 * Campo de texto (linha ou área) que sugere `{{caminho}}` ao digitar `{{`, ou
 * pelo botão `{ }`. Setas escolhem, Enter ou Tab inserem, Esc fecha, e o mouse
 * também escolhe. A lista abre na linha do cursor.
 */
export function CampoComVariaveis({ tipo = "input", valor, mudar, grupos: dosProps, className, onFocus, onBlur, onKeyDown, ...resto }: Props) {
  const { t } = useTranslation();
  const doNo = useContext(VariaveisContext);
  const grupos = dosProps ?? doNo;
  const idLista = useId();
  const campo = useRef<Campo | null>(null);
  const lista = useRef<HTMLDivElement | null>(null);
  const [cursor, setCursor] = useState(valor.length);
  const [focado, setFocado] = useState(false);
  const [ativo, setAtivo] = useState(0);
  const [posicao, setPosicao] = useState<PosicaoDoCursor>({ top: 0, left: 0, altura: 0 });
  /** O marcador que a pessoa dispensou com Esc: volta a abrir assim que o texto dele muda. */
  const [dispensado, setDispensado] = useState<{ inicio: number; consulta: string } | null>(null);

  const marcador = focado ? marcadorAberto(valor, cursor) : null;
  const filtrados = useMemo(() => (marcador === null ? [] : filtrarSugestoes(grupos, marcador.consulta)), [grupos, marcador?.consulta, marcador === null]);
  const opcoes: Opcao[] = filtrados.flatMap((grupo) => grupo.itens.map((item) => ({ grupo, item })));
  const dispensadoAgora = marcador !== null && dispensado?.inicio === marcador.inicio && dispensado.consulta === marcador.consulta;
  const aberto = marcador !== null && !dispensadoAgora && opcoes.length > 0;
  const idDaOpcao = (i: number): string => `${idLista}-${i}`;
  const comLista = grupos.length > 0;
  const area = tipo === "textarea";

  useEffect(() => setAtivo(0), [marcador?.consulta]);

  // A lista abre onde o cursor está, e não no pé do campo.
  useLayoutEffect(() => {
    if (aberto && campo.current !== null) setPosicao(posicaoDoCursor(campo.current, cursor));
  }, [aberto, cursor, valor]);

  // Só a lista rola para mostrar a opção ativa: a página e o painel ficam onde estão.
  useEffect(() => {
    const item = document.getElementById(idDaOpcao(ativo));
    const caixa = lista.current;
    if (!aberto || item === null || caixa === null) return;
    if (item.offsetTop < caixa.scrollTop) caixa.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > caixa.scrollTop + caixa.clientHeight) caixa.scrollTop = item.offsetTop + item.offsetHeight - caixa.clientHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ativo, aberto]);

  // Digitar e mover o cursor só acontecem com o campo em foco, mesmo quando a janela não avisou o foco.
  const lerCursor = (el: HTMLInputElement | HTMLTextAreaElement): void => {
    setFocado(true);
    setCursor(el.selectionStart ?? el.value.length);
  };

  /** Troca `de..ate` por `texto` pelo caminho do navegador, que guarda o desfazer; sem ele, grava o texto pronto. */
  const trocarTrecho = (de: number, ate: number, texto: string, pronto: string): void => {
    const el = campo.current;
    if (el === null) return mudar(pronto);
    el.focus();
    el.setSelectionRange(de, ate);
    if (!document.execCommand("insertText", false, texto)) mudar(pronto);
    lerCursor(el);
  };

  const inserir = (opcao: Opcao): void => {
    const novo = inserirSugestao(valor, cursor, opcao.item.caminho);
    if (novo !== null) trocarTrecho(novo.de, novo.ate, novo.marcador, novo.texto);
  };

  const abrirPeloBotao = (): void => {
    const el = campo.current;
    if (el === null) return;
    const fim = el.selectionEnd ?? el.value.length;
    trocarTrecho(el.selectionStart ?? fim, fim, "{{", `${valor.slice(0, el.selectionStart ?? fim)}{{${valor.slice(fim)}`);
  };

  const aoTeclar = (e: React.KeyboardEvent<Campo>): void => {
    onKeyDown?.(e);
    if (!aberto || e.defaultPrevented) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setAtivo((a) => (a + (e.key === "ArrowDown" ? 1 : opcoes.length - 1)) % opcoes.length);
    } else if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
      e.preventDefault();
      inserir(opcoes[ativo]!);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDispensado({ inicio: marcador!.inicio, consulta: marcador!.consulta });
    }
  };

  let indice = -1;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="relative">
        {createElement(tipo, {
          ...resto,
          ref: campo,
          value: valor,
          className: cn(className, comLista && "pr-8"),
          // A caixa de texto de várias linhas não é um combobox: ela só diz que tem uma lista de sugestões.
          ...(area ? {} : { role: "combobox", "aria-expanded": aberto }),
          "aria-autocomplete": "list",
          "aria-haspopup": "listbox",
          "aria-controls": aberto ? idLista : undefined,
          "aria-activedescendant": aberto ? idDaOpcao(ativo) : undefined,
          onChange: (e: React.ChangeEvent<Campo>) => {
            mudar(e.target.value);
            lerCursor(e.target);
          },
          onSelect: (e: React.SyntheticEvent<Campo>) => lerCursor(e.currentTarget),
          onFocus: (e: React.FocusEvent<Campo>) => {
            setFocado(true);
            lerCursor(e.currentTarget);
            onFocus?.(e);
          },
          onBlur: (e: React.FocusEvent<Campo>) => {
            setFocado(false);
            onBlur?.(e);
          },
          onKeyDown: aoTeclar,
        })}
        {comLista ? (
          <button
            aria-label={t("automations.variables.insert")}
            className="text-muted-foreground hover:text-foreground absolute top-1.5 right-1.5 cursor-pointer rounded p-0.5"
            data-locum-variaveis-botao=""
            // mousedown, e não click: o click tiraria o foco do campo antes de inserir.
            onMouseDown={(e) => e.preventDefault()}
            onClick={abrirPeloBotao}
            title={t("automations.variables.insert")}
            type="button"
          >
            <Braces aria-hidden className="size-3.5" />
          </button>
        ) : null}
        {aberto ? (
          <div
            aria-label={t("automations.variables.label")}
            className="border-border bg-popover text-popover-foreground absolute z-50 max-h-64 max-w-full overflow-y-auto rounded-md border p-1 shadow-md"
            data-locum-variaveis=""
            id={idLista}
            ref={lista}
            role="listbox"
            style={{ top: posicao.top + posicao.altura + 4, left: Math.max(0, Math.min(posicao.left, (campo.current?.offsetWidth ?? LARGURA_DA_LISTA) - LARGURA_DA_LISTA)), width: LARGURA_DA_LISTA }}
          >
            {filtrados.map((grupo) => {
              const idTitulo = `${idLista}-g-${grupo.id}`;
              return (
                <div aria-labelledby={idTitulo} key={grupo.id} role="group">
                  <div className="text-muted-foreground px-2 py-1 text-[11px] font-medium" id={idTitulo}>
                    {grupo.tipo === "event" ? t("automations.variables.event") : t("automations.variables.step", { numero: grupo.numero, nome: grupo.nome })}
                  </div>
                  {grupo.itens.map((item) => {
                    indice += 1;
                    const i = indice;
                    const deQuem = (item.fontes ?? []).map((k) => t(`automations.triggers.${k}.title`, { defaultValue: k })).join(", ");
                    return (
                      <div
                        aria-selected={i === ativo}
                        className={cn("flex cursor-pointer items-baseline justify-between gap-2 rounded px-2 py-1 font-mono text-xs", i === ativo && "bg-muted")}
                        data-locum-variavel={item.caminho}
                        id={idDaOpcao(i)}
                        key={item.caminho}
                        // mousedown, e não click: o click tiraria o foco do campo antes de inserir.
                        onMouseDown={(e) => {
                          e.preventDefault();
                          inserir({ grupo, item });
                        }}
                        onMouseEnter={() => setAtivo(i)}
                        role="option"
                        title={deQuem === "" ? undefined : deQuem}
                      >
                        <span className="truncate">{item.caminho}</span>
                        <span className="text-muted-foreground max-w-[45%] shrink-0 truncate text-[10px]">{deQuem === "" ? item.tipo : `${item.tipo} · ${deQuem}`}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ) : null}
        <div aria-live="polite" className="sr-only" role="status">
          {aberto ? t("automations.variables.count", { count: opcoes.length }) : ""}
        </div>
      </div>
      {area && comLista ? <p className="text-muted-foreground text-[11px]">{t("automations.variables.hint")}</p> : null}
    </div>
  );
}
