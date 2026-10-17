import type { GrupoDeReferencias, Referencia } from "../../../src/config/referencias";
import { filtrarSugestoes, inserirSugestao, marcadorAberto } from "@/lib/sugestao-de-variavel";
import { cn } from "@/lib/utils";
import { createContext, createElement, useContext, useEffect, useId, useMemo, useRef, useState, type ComponentPropsWithoutRef } from "react";
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

type Props = Omit<ComponentPropsWithoutRef<"input">, "value" | "onChange" | "type"> & {
  tipo?: "input" | "textarea";
  valor: string;
  mudar: (valor: string) => void;
  /** Catálogo próprio; sem ele vale o do painel. */
  grupos?: readonly GrupoDeReferencias[];
};

/**
 * Campo de texto (linha ou área) que sugere `{{caminho}}` ao digitar `{{`.
 * Setas escolhem, Enter ou Tab inserem, Esc fecha, e o mouse também escolhe.
 */
export function CampoComVariaveis({ tipo = "input", valor, mudar, grupos: dosProps, className, onFocus, onBlur, onKeyDown, ...resto }: Props) {
  const { t } = useTranslation();
  const doNo = useContext(VariaveisContext);
  const grupos = dosProps ?? doNo;
  const idLista = useId();
  const campo = useRef<(HTMLInputElement & HTMLTextAreaElement) | null>(null);
  const [cursor, setCursor] = useState(valor.length);
  const [focado, setFocado] = useState(false);
  const [ativo, setAtivo] = useState(0);
  /** O `{{` que a pessoa dispensou com Esc: não reabre até começar outro. */
  const [dispensado, setDispensado] = useState<number | null>(null);

  const marcador = focado ? marcadorAberto(valor, cursor) : null;
  const filtrados = useMemo(() => (marcador === null ? [] : filtrarSugestoes(grupos, marcador.consulta)), [grupos, marcador?.consulta, marcador === null]);
  const opcoes: Opcao[] = filtrados.flatMap((grupo) => grupo.itens.map((item) => ({ grupo, item })));
  const aberto = marcador !== null && marcador.inicio !== dispensado && opcoes.length > 0;
  const idDaOpcao = (i: number): string => `${idLista}-${i}`;

  useEffect(() => setAtivo(0), [marcador?.consulta]);
  useEffect(() => {
    if (aberto) document.getElementById(idDaOpcao(ativo))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ativo, aberto]);

  // Digitar e mover o cursor só acontecem com o campo em foco, mesmo quando a janela não avisou o foco.
  const lerCursor = (el: HTMLInputElement | HTMLTextAreaElement): void => {
    setFocado(true);
    setCursor(el.selectionStart ?? el.value.length);
  };

  const inserir = (opcao: Opcao): void => {
    const novo = inserirSugestao(valor, cursor, opcao.item.caminho);
    if (novo === null) return;
    mudar(novo.texto);
    setCursor(novo.cursor);
    setDispensado(null);
    requestAnimationFrame(() => {
      campo.current?.focus();
      campo.current?.setSelectionRange(novo.cursor, novo.cursor);
    });
  };

  const aoTeclar = (e: React.KeyboardEvent<HTMLInputElement & HTMLTextAreaElement>): void => {
    onKeyDown?.(e);
    if (!aberto || e.defaultPrevented) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setAtivo((a) => (a + (e.key === "ArrowDown" ? 1 : opcoes.length - 1)) % opcoes.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      inserir(opcoes[ativo]!);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDispensado(marcador!.inicio);
    }
  };

  let indice = -1;
  return (
    <div className="relative">
      {createElement(tipo, {
        ...resto,
        ref: campo,
        value: valor,
        className,
        role: "combobox",
        "aria-autocomplete": "list",
        "aria-expanded": aberto,
        "aria-controls": aberto ? idLista : undefined,
        "aria-activedescendant": aberto ? idDaOpcao(ativo) : undefined,
        onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => {
          mudar(e.target.value);
          lerCursor(e.target);
        },
        onSelect: (e: React.SyntheticEvent<HTMLInputElement & HTMLTextAreaElement>) => lerCursor(e.currentTarget),
        onFocus: (e: React.FocusEvent<HTMLInputElement & HTMLTextAreaElement>) => {
          setFocado(true);
          lerCursor(e.currentTarget);
          onFocus?.(e);
        },
        onBlur: (e: React.FocusEvent<HTMLInputElement & HTMLTextAreaElement>) => {
          setFocado(false);
          onBlur?.(e);
        },
        onKeyDown: aoTeclar,
      })}
      {aberto ? (
        <div
          aria-label={t("automations.variables.label")}
          className="border-border bg-popover text-popover-foreground absolute top-full right-0 left-0 z-50 mt-1 max-h-64 overflow-y-auto rounded-md border p-1 shadow-md"
          data-locum-variaveis=""
          id={idLista}
          role="listbox"
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
                    >
                      <span className="truncate">{item.caminho}</span>
                      <span className="text-muted-foreground shrink-0 text-[10px]">{item.tipo}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
