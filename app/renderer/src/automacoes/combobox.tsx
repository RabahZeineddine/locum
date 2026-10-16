import { cn } from "@/lib/utils";
import { listaComCache, lerDoCache, moverDestaque } from "@/lib/cache-de-lista";
import { Check, RefreshCw, X } from "lucide-react";
import { Popover } from "radix-ui";
import { useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

export interface OpcaoDoCombobox {
  id: string;
  rotulo: string;
  /** Agrupa as opções (a equipe de um canal). */
  grupo?: string;
  /** Texto pequeno à direita (1:1, grupo). */
  detalhe?: string;
}

/**
 * A lista que vem de rede, lida uma vez e guardada por alguns minutos
 * (`sessionStorage`). `pedir()` carrega se ainda não há lista; `pedir(true)` é
 * o "Atualizar".
 */
export function useListaEmCache<T>(chave: string, carregar: () => Promise<T[]>) {
  const [dados, setDados] = useState<T[] | null>(() => lerDoCache<T[]>(globalThis.sessionStorage, chave, Date.now()));
  const [lendo, setLendo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const pedir = (forcar = false): void => {
    if (lendo || (dados !== null && !forcar)) return;
    setLendo(true);
    setErro(null);
    listaComCache(globalThis.sessionStorage, chave, carregar, { forcar }).then(
      (lista) => {
        setDados(lista);
        setLendo(false);
      },
      (e: unknown) => {
        setErro(e instanceof Error ? e.message : String(e));
        setLendo(false);
      },
    );
  };
  return { dados, lendo, erro, pedir };
}

/**
 * Escolha de vários itens numa lista longa: o campo de busca está ali desde o
 * início, os escolhidos viram chips, e a lista abre ao focar ou digitar e fecha
 * ao escolher, por Esc ou por clique fora. Teclado: ↑ ↓ Enter Esc, e Backspace
 * com a busca vazia tira o último chip.
 */
export function ComboboxComChips({
  selecionados,
  opcoes,
  filtrar,
  carregando,
  aoAbrir,
  aoAtualizar,
  aoAlternar,
  aoRemover,
  rotuloDaBusca,
  limite,
  sonda,
}: {
  selecionados: readonly { id: string; rotulo: string }[];
  /** Nulo enquanto a lista não chegou. */
  opcoes: readonly OpcaoDoCombobox[] | null;
  /** As opções que valem para a busca, na ordem em que aparecem. */
  filtrar: (busca: string) => OpcaoDoCombobox[];
  carregando: boolean;
  aoAbrir: () => void;
  aoAtualizar: () => void;
  aoAlternar: (opcao: OpcaoDoCombobox) => void;
  aoRemover: (id: string) => void;
  rotuloDaBusca: string;
  /** Teto de escolhidos: passado dele, só dá para tirar. */
  limite?: number;
  sonda: string;
}) {
  const { t } = useTranslation();
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState("");
  const [destaque, setDestaque] = useState(0);
  const campo = useRef<HTMLInputElement>(null);
  const caixa = useRef<HTMLDivElement>(null);

  const marcado = new Set(selecionados.map((s) => s.id));
  const cheio = limite !== undefined && selecionados.length >= limite;
  const lista = opcoes === null ? [] : filtrar(busca);
  const livre = (o: OpcaoDoCombobox): boolean => !cheio || marcado.has(o.id);

  const abrir = (): void => {
    setAberto(true);
    aoAbrir();
  };
  const fechar = (): void => {
    setAberto(false);
    setBusca("");
    setDestaque(0);
  };
  const escolher = (o: OpcaoDoCombobox): void => {
    if (!livre(o)) return;
    aoAlternar(o);
    fechar();
    campo.current?.focus();
  };

  const teclado = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!aberto) abrir();
      else setDestaque((d) => moverDestaque(d, lista.length, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = lista[destaque];
      if (aberto && o !== undefined) escolher(o);
    } else if (e.key === "Escape") {
      if (aberto) {
        e.preventDefault();
        e.stopPropagation();
        fechar();
      }
    } else if (e.key === "Backspace" && busca === "" && selecionados.length > 0) {
      aoRemover(selecionados[selecionados.length - 1]!.id);
    }
  };

  let grupoAnterior: string | undefined;
  return (
    <Popover.Root onOpenChange={(a) => !a && fechar()} open={aberto}>
      <Popover.Anchor asChild>
        <div
          className="border-input focus-within:border-ring focus-within:ring-ring/40 flex min-h-8 w-full cursor-text flex-wrap items-center gap-1 rounded-md border px-1.5 py-1 focus-within:ring-2"
          data-locum-combobox={sonda}
          onClick={() => campo.current?.focus()}
          ref={caixa}
        >
          {selecionados.map((s) => (
            <span className="bg-muted flex max-w-full items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5 text-xs" data-locum-chip="" key={s.id}>
              <span className="truncate">{s.rotulo}</span>
              <button
                aria-label={t("automations.combobox.remove", { item: s.rotulo })}
                className="hover:text-foreground text-muted-foreground cursor-pointer rounded-full p-0.5"
                onClick={(e) => {
                  e.stopPropagation();
                  aoRemover(s.id);
                }}
                type="button"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          <input
            aria-autocomplete="list"
            aria-expanded={aberto}
            aria-label={rotuloDaBusca}
            className="placeholder:text-muted-foreground min-w-24 flex-1 bg-transparent px-1 text-xs outline-none"
            data-locum-combobox-busca=""
            onChange={(e) => {
              setBusca(e.target.value);
              setDestaque(0);
              if (!aberto) abrir();
            }}
            onClick={() => !aberto && abrir()}
            onFocus={() => !aberto && abrir()}
            onKeyDown={teclado}
            placeholder={selecionados.length === 0 ? rotuloDaBusca : ""}
            ref={campo}
            role="combobox"
            value={busca}
          />
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          align="start"
          className="bg-popover border-border z-50 flex max-h-72 w-(--radix-popover-trigger-width) flex-col overflow-hidden rounded-md border text-xs shadow-md"
          data-locum-combobox-lista={opcoes === null ? "carregando" : lista.length}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (caixa.current?.contains(e.target as Node)) e.preventDefault();
          }}
          onOpenAutoFocus={(e) => e.preventDefault()}
          sideOffset={4}
        >
          <ul className="min-h-0 flex-1 overflow-y-auto py-1" role="listbox">
            {opcoes === null ? (
              <li className="text-muted-foreground px-2.5 py-1.5">{t("automations.combobox.loading")}</li>
            ) : lista.length === 0 ? (
              <li className="text-muted-foreground px-2.5 py-1.5">{t("automations.combobox.noMatch", { termo: busca.trim() })}</li>
            ) : (
              lista.map((o, i) => {
                const cabecalho = o.grupo !== undefined && o.grupo !== grupoAnterior;
                grupoAnterior = o.grupo;
                return (
                  <li key={o.id} role="presentation">
                    {cabecalho ? <div className="text-muted-foreground px-2.5 pt-1.5 pb-0.5 text-[11px] font-medium">{o.grupo}</div> : null}
                    <div
                      aria-disabled={!livre(o)}
                      aria-selected={marcado.has(o.id)}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 px-2.5 py-1",
                        i === destaque && "bg-accent",
                        !livre(o) && "cursor-not-allowed opacity-50",
                      )}
                      data-locum-opcao={o.id}
                      onClick={() => escolher(o)}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => setDestaque(i)}
                      role="option"
                    >
                      <Check aria-hidden className={cn("size-3.5 shrink-0", marcado.has(o.id) ? "text-primary" : "invisible")} />
                      <span className="min-w-0 flex-1 truncate">{o.rotulo}</span>
                      {o.detalhe === undefined ? null : <span className="text-muted-foreground text-[11px]">{o.detalhe}</span>}
                    </div>
                  </li>
                );
              })
            )}
          </ul>
          <div className="border-border text-muted-foreground flex items-center gap-2 border-t px-2.5 py-1 text-[11px]">
            <span className="flex-1">
              {cheio ? t("automations.combobox.full", { max: limite }) : t("automations.combobox.keys")}
            </span>
            <button
              className="hover:text-foreground flex cursor-pointer items-center gap-1"
              data-locum-combobox-atualizar=""
              disabled={carregando}
              onClick={aoAtualizar}
              onMouseDown={(e) => e.preventDefault()}
              type="button"
            >
              <RefreshCw className={cn("size-3", carregando && "animate-spin")} />
              {t("automations.combobox.refresh")}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
