import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRead } from "@/lib/bridge";
import type { TelaProps } from "./rotas";

interface Comando {
  id: string;
  rotulo: string;
  executar: () => void;
}

/**
 * A paleta de comandos: ir para uma iniciativa, ou copiar um prompt salvo.
 *
 * A lista e escrita a mao aqui dentro, montada a partir de `initiatives.list`
 * e `prompts.list`, pelo mesmo motivo do catalogo de canais do chat: decisao
 * de publicacao (aprovar, comentar) nunca entra numa lista destas, entao a
 * lista nunca vem de "todo canal disponivel", so do que este arquivo escolheu
 * pendurar.
 */
export function Paleta({ navegar }: { navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  const [aberta, setAberta] = useState(false);
  const [consulta, setConsulta] = useState("");
  const campo = useRef<HTMLInputElement>(null);

  const iniciativas = useRead("initiatives.list");
  const prompts = useRead("prompts.list");

  useEffect(() => {
    const ouvir = (evento: KeyboardEvent) => {
      // `metaKey` no macOS, `ctrlKey` para quem chegar de teclado de PC.
      if (evento.key.toLowerCase() === "k" && (evento.metaKey || evento.ctrlKey)) {
        evento.preventDefault();
        setAberta((antes) => !antes);
        return;
      }
      if (evento.key === "Escape") setAberta(false);
    };

    globalThis.addEventListener("keydown", ouvir);
    return () => globalThis.removeEventListener("keydown", ouvir);
  }, []);

  useEffect(() => {
    if (aberta) campo.current?.focus();
    else setConsulta("");
  }, [aberta]);

  const comandos = useMemo<Comando[]>(() => {
    const irParaIniciativa = (iniciativas.data ?? []).map((iniciativa) => ({
      id: `initiative:${iniciativa.slug}`,
      rotulo: t("palette.goToInitiative", { title: iniciativa.title }),
      executar: () => {
        navegar("initiatives", `${iniciativa.slug}/context`);
        setAberta(false);
      },
    }));

    const copiarPrompt = (prompts.data ?? []).map((prompt) => ({
      id: `prompt:${prompt.id}`,
      rotulo: t("palette.copyPrompt", { name: prompt.name }),
      executar: () => {
        navigator.clipboard.writeText(prompt.body);
        setAberta(false);
      },
    }));

    return [...irParaIniciativa, ...copiarPrompt];
  }, [iniciativas.data, navegar, prompts.data, t]);

  const filtrados =
    consulta.trim().length === 0
      ? comandos
      : comandos.filter((comando) => comando.rotulo.toLowerCase().includes(consulta.trim().toLowerCase()));

  return (
    <div data-aberta={aberta ? "sim" : "nao"} data-locum-probe="paleta">
      {aberta ? (
        <div
          aria-label={t("palette.label")}
          aria-modal="true"
          className="sem-arrasto fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[20vh]"
          onClick={(evento) => {
            if (evento.target === evento.currentTarget) setAberta(false);
          }}
          role="dialog"
        >
          <div className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
            <input
              className="w-full bg-transparent px-4 py-3 text-popover-foreground text-sm outline-none placeholder:text-muted-foreground"
              onChange={(e) => setConsulta(e.target.value)}
              placeholder={t("palette.placeholder")}
              ref={campo}
              type="text"
              value={consulta}
            />
            <div className="border-border border-t" data-locum-probe="paleta-comandos" data-total={filtrados.length}>
              {filtrados.length === 0 ? (
                <div className="px-4 py-6 text-center text-muted-foreground text-sm">{t("palette.empty")}</div>
              ) : (
                <ul className="max-h-80 overflow-auto py-1">
                  {filtrados.map((comando) => (
                    <li key={comando.id}>
                      <button
                        className="hover:bg-accent w-full cursor-pointer px-4 py-2 text-left text-sm"
                        onClick={comando.executar}
                        type="button"
                      >
                        {comando.rotulo}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
