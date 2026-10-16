import { argsDoTexto, definirNoCaminho, ehReferencia, textoDosArgs, valorDoTexto, type Campo as CampoGerado } from "@/lib/formulario-de-schema";
import type { ReferenciaDisponivel } from "@/lib/automacao";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CAMPO } from "./campos";

type Args = Record<string, unknown>;
type Foco = (aplicar: (v: string) => void) => (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => void;

function textoDoValor(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v) && v.every((x) => typeof x !== "object")) return v.join("\n");
  return typeof v === "string" ? v : JSON.stringify(v);
}

const caminhoDaReferencia = (v: unknown): string => (ehReferencia(v) ? v.replace(/^\{\{\s*|\s*\}\}$/g, "") : "");

/**
 * Texto digitado que não volta idêntico do valor gravado (`1.` vira 1): guarda
 * o que a pessoa digitou e só o troca quando o valor muda por outro caminho.
 */
function useTextoDigitado(valor: unknown, converter: (texto: string) => unknown): [string, (t: string) => void] {
  const [texto, setTexto] = useState(() => textoDoValor(valor));
  useEffect(() => {
    if (textoDoValor(converter(texto)) !== textoDoValor(valor)) setTexto(textoDoValor(valor));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valor]);
  return [texto, setTexto];
}

/** Um campo do schema: valor fixo, ou referência a algo do evento ou de um passo anterior. */
function CampoDoArgumento({
  campo,
  caminho,
  valor,
  aplicar,
  referencias,
  focar,
}: {
  campo: CampoGerado;
  caminho: string[];
  valor: unknown;
  aplicar: (caminho: string[], valor: unknown) => void;
  referencias: readonly ReferenciaDisponivel[];
  focar: Foco;
}) {
  const { t } = useTranslation();
  const id = caminho.join(".");
  const [emReferencia, setEmReferencia] = useState(() => ehReferencia(valor));
  const gravar = (v: unknown): void => aplicar(caminho, v);
  const converter = (texto: string): unknown => (campo.tipo === "json" ? jsonOuTexto(texto) : valorDoTexto(texto, campo));
  const [texto, setTexto] = useTextoDigitado(valor, converter);
  const digitar = (novo: string): void => {
    setTexto(novo);
    gravar(converter(novo));
  };
  const longo = campo.tipo === "array" || campo.tipo === "json" || (campo.tipo === "string" && /text|body|message|content|description/i.test(campo.nome));
  const jsonInvalido = campo.tipo === "json" && typeof valor === "string" && valor.trim() !== "" && !(valor as string).includes("{{");

  if (campo.tipo === "object" && campo.campos !== undefined && !emReferencia) {
    return (
      <fieldset className="border-border flex flex-col gap-2 rounded-md border p-2" data-locum-arg-objeto={id}>
        <legend className="text-muted-foreground px-1 text-xs">
          {campo.nome}
          {campo.obrigatorio ? " *" : ""}
        </legend>
        {campo.descricao === undefined ? null : <p className="text-muted-foreground line-clamp-2 text-[11px]">{campo.descricao}</p>}
        {campo.campos.map((filho) => (
          <CampoDoArgumento
            aplicar={aplicar}
            campo={filho}
            caminho={[...caminho, filho.nome]}
            focar={focar}
            key={filho.nome}
            referencias={referencias}
            valor={(valor as Args | undefined)?.[filho.nome]}
          />
        ))}
      </fieldset>
    );
  }

  const modo = (ref: boolean): void => {
    setEmReferencia(ref);
    if (!ref && ehReferencia(valor)) {
      gravar(undefined);
      setTexto("");
    }
  };
  return (
    <div className="flex flex-col gap-1" data-locum-arg-campo={id}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          {campo.nome}
          {campo.obrigatorio ? " *" : ""}
        </span>
        <span className="flex gap-0.5 text-[11px]">
          {([false, true] as const).map((ref) => (
            <button
              aria-pressed={emReferencia === ref}
              className={cn("cursor-pointer rounded px-1.5 py-0.5", emReferencia === ref ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
              data-locum-arg-modo={`${id}:${ref ? "ref" : "fixo"}`}
              key={String(ref)}
              onClick={() => modo(ref)}
              type="button"
            >
              {t(ref ? "automations.steps.mcp.call.modeRef" : "automations.steps.mcp.call.modeFixed")}
            </button>
          ))}
        </span>
      </div>
      {emReferencia ? (
        <div className="flex flex-col gap-1">
          <select
            className={cn(CAMPO, "font-mono text-xs")}
            data-locum-arg-ref={id}
            onChange={(e) => gravar(e.target.value === "" ? undefined : `{{${e.target.value}}}`)}
            value={referencias.some((r) => r.caminho === caminhoDaReferencia(valor)) ? caminhoDaReferencia(valor) : ""}
          >
            <option value="">{t("automations.steps.mcp.call.refChoose")}</option>
            {(["event", "step"] as const).map((grupo) => {
              const doGrupo = referencias.filter((r) => r.grupo === grupo);
              return doGrupo.length === 0 ? null : (
                <optgroup key={grupo} label={t(grupo === "event" ? "automations.steps.mcp.call.refEvent" : "automations.steps.mcp.call.refSteps")}>
                  {doGrupo.map((r) => (
                    <option key={r.caminho} value={r.caminho}>
                      {r.caminho}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
          <input
            className={cn(CAMPO, "font-mono text-xs")}
            data-locum-arg-ref-texto={id}
            onChange={(e) => gravar(e.target.value.trim() === "" ? undefined : `{{${e.target.value.trim().replace(/^\{\{\s*|\s*\}\}$/g, "")}}}`)}
            placeholder={t("automations.steps.mcp.call.refType")}
            value={caminhoDaReferencia(valor)}
          />
        </div>
      ) : campo.tipo === "enum" ? (
        <select
          className={CAMPO}
          data-locum-arg={id}
          onChange={(e) => gravar(e.target.value === "" ? undefined : (campo.opcoes ?? []).find((o) => String(o) === e.target.value))}
          value={valor === undefined ? "" : String(valor)}
        >
          <option value="">{t("automations.steps.mcp.call.enumChoose")}</option>
          {(campo.opcoes ?? []).map((o) => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
            </option>
          ))}
        </select>
      ) : campo.tipo === "boolean" ? (
        <select className={CAMPO} data-locum-arg={id} onChange={(e) => gravar(valorDoTexto(e.target.value, campo))} value={typeof valor === "boolean" ? String(valor) : ""}>
          <option value="">{t("automations.steps.mcp.call.enumChoose")}</option>
          <option value="true">{t("automations.steps.mcp.call.yes")}</option>
          <option value="false">{t("automations.steps.mcp.call.no")}</option>
        </select>
      ) : longo ? (
        <textarea
          className={cn(CAMPO, "min-h-20 font-mono text-xs")}
          data-locum-arg={id}
          onChange={(e) => digitar(e.target.value)}
          onFocus={focar(digitar)}
          placeholder={campo.tipo === "array" ? t("automations.steps.mcp.call.arrayHint") : undefined}
          value={texto}
        />
      ) : (
        <input className={cn(CAMPO, "font-mono text-xs")} data-locum-arg={id} onChange={(e) => digitar(e.target.value)} onFocus={focar(digitar)} value={texto} />
      )}
      {jsonInvalido ? <p className="text-destructive text-[11px]">{t("automations.steps.mcp.call.jsonInvalid")}</p> : null}
      {campo.descricao === undefined ? null : <p className="text-muted-foreground line-clamp-2 text-[11px]">{campo.descricao}</p>}
    </div>
  );
}

function jsonOuTexto(texto: string): unknown {
  if (texto.trim() === "") return undefined;
  if (texto.includes("{{")) return texto.trim();
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

/** O editor cru: guarda o texto enquanto não é JSON de objeto, e só grava o que é. */
function EditorJson({ args, mudar }: { args: Args; mudar: (a: Args) => void }) {
  const { t } = useTranslation();
  const [texto, setTexto] = useState(() => textoDosArgs(args));
  const valido = argsDoTexto(texto) !== null;
  return (
    <div className="flex flex-col gap-1">
      <textarea
        className={cn(CAMPO, "min-h-24 font-mono text-xs")}
        data-locum-args-json=""
        onChange={(e) => {
          setTexto(e.target.value);
          const novo = argsDoTexto(e.target.value);
          if (novo !== null) mudar(novo);
        }}
        value={texto}
      />
      {valido ? null : <p className="text-destructive text-[11px]">{t("automations.steps.mcp.call.jsonInvalid")}</p>}
    </div>
  );
}

/**
 * Os argumentos da ferramenta: formulário gerado do schema, ou o editor cru
 * quando a ferramenta não trouxe schema ou a pessoa prefere o JSON. Os dois
 * leem e gravam o mesmo `args`, então alternar não perde valor.
 */
export function FormularioDaChamada({
  campos,
  args,
  mudar,
  referencias,
  focar,
}: {
  campos: readonly CampoGerado[];
  args: Args;
  mudar: (args: Args) => void;
  referencias: readonly ReferenciaDisponivel[];
  focar: Foco;
}) {
  const { t } = useTranslation();
  const [cru, setCru] = useState(false);
  if (campos.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs">{t("automations.steps.mcp.call.argsJson")}</span>
        <EditorJson args={args} mudar={mudar} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5" data-locum-args-form={cru ? "json" : "campos"}>
      <button
        className="text-primary w-fit cursor-pointer text-[11px] hover:underline"
        data-locum-args-alternar=""
        onClick={() => setCru(!cru)}
        type="button"
      >
        {t(cru ? "automations.steps.mcp.call.viewForm" : "automations.steps.mcp.call.viewJson")}
      </button>
      {cru ? (
        <EditorJson args={args} mudar={mudar} />
      ) : (
        campos.map((c) => (
          <CampoDoArgumento
            aplicar={(caminho, valor) => mudar(definirNoCaminho(args, caminho, valor))}
            campo={c}
            caminho={[c.nome]}
            focar={focar}
            key={c.nome}
            referencias={referencias}
            valor={args[c.nome]}
          />
        ))
      )}
    </div>
  );
}
