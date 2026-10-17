import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { call, useRead, type ReadResult } from "@/lib/bridge";
import { semPrefixoDoIpc } from "@/lib/erro-da-ponte";
import { camposDoSchema, type Campo as CampoDoEsquema } from "@/lib/formulario-de-schema";
import { rotuloDaAcao } from "@/lib/rotulos";
import { escritoComoJson, montarConteudo, valoresIniciais, type ErroDoFormulario } from "@/lib/passo-avulso";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TelaProps } from "../rotas";
import { Campo } from "../automacoes/campos";

type Detalhe = NonNullable<ReadResult<"runs.get">>;

/** O run aceita ação nova quando terminou (ou espera uma decisão) e não é um ensaio. O serviço recusa de novo ao gravar. */
export function aceitaAcaoNova(detalhe: Detalhe): boolean {
  return detalhe.status !== "queued" && detalhe.status !== "running" && detalhe.event?.semConversa !== true && !detalhe.agentArchived;
}

/**
 * "Nova ação": propõe um passo avulso sobre o run. O formulário nasce do
 * `inputSchema` que o handler declara, sem formulário por ação; o alvo vem do
 * evento do run e aparece só para leitura.
 */
export function NovaAcao({ detalhe, navegar }: { detalhe: Detalhe; navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  const [aberto, setAberto] = useState(false);
  return (
    <>
      <Button data-locum-nova-acao="" onClick={() => setAberto(true)} size="sm" variant="outline">
        {t("runs.newAction.button")}
      </Button>
      {aberto ? <Dialogo detalhe={detalhe} navegar={navegar} aoFechar={() => setAberto(false)} /> : null}
    </>
  );
}

function Dialogo({ detalhe, navegar, aoFechar }: { detalhe: Detalhe; navegar: TelaProps["navegar"]; aoFechar: () => void }) {
  const { t } = useTranslation();
  const catalogo = useRead("actions.describe");
  // Quem tem `inputSchema` é oferecido; o resto não aparece.
  const oferecidas = (catalogo.data ?? []).filter((a) => a.inputSchema !== undefined && a.modes.includes("approve"));
  const [kind, setKind] = useState("");
  const [textos, setTextos] = useState<Record<string, string>>({});
  const [derivaDe, setDerivaDe] = useState("");
  const [erros, setErros] = useState<ErroDoFormulario[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [recusa, setRecusa] = useState<string | null>(null);
  const [proposta, setProposta] = useState<string | null>(null);

  const escolhida = oferecidas.find((a) => a.kind === kind);
  const campos = camposDoSchema(escolhida?.inputSchema);
  const alvo = detalhe.target;

  const trocarAcao = (novo: string): void => {
    setKind(novo);
    setTextos(valoresIniciais(oferecidas.find((a) => a.kind === novo)?.inputSchema));
    setErros([]);
    setRecusa(null);
  };

  const propor = (): void => {
    if (escolhida === undefined) return;
    const { conteudo, erros: achados } = montarConteudo(escolhida.inputSchema, textos);
    setErros(achados);
    if (achados.length > 0) return;
    setEnviando(true);
    setRecusa(null);
    call("runs.proporAcao", detalhe.id, { kind, conteudo, ...(derivaDe === "" ? {} : { derivaDe }) }).then(
      (r) => {
        setEnviando(false);
        setProposta(r.stepKey);
      },
      (e: unknown) => {
        setEnviando(false);
        const mensagem = semPrefixoDoIpc(e instanceof Error ? e.message : String(e));
        const recusada = /proposta_recusada:([^:]+):/.exec(mensagem);
        setRecusa(recusada === null ? mensagem : t("runs.newAction.refused", { kind: rotuloDaAcao(t, recusada[1]!) }));
      },
    );
  };

  return (
    <Dialog onOpenChange={(a) => !a && !enviando && aoFechar()} open>
      <DialogContent data-locum-nova-acao-dialogo="">
        <DialogHeader>
          <DialogTitle>{t("runs.newAction.title")}</DialogTitle>
          <DialogDescription>{t("runs.newAction.description")}</DialogDescription>
        </DialogHeader>

        {proposta !== null ? (
          <p className="text-[13px]" data-locum-nova-acao-feita={proposta}>
            {t("runs.newAction.queued", { step: proposta })}
          </p>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
            <div className="border-border bg-card flex flex-col gap-0.5 rounded-md border px-3 py-2 text-xs" data-locum-nova-acao-alvo="">
              <span className="text-muted-foreground">{t("runs.newAction.target")}</span>
              {alvo === null ? (
                <span>{t("runs.newAction.noTarget")}</span>
              ) : (
                <>
                  <span>{[alvo.repo, alvo.pull === undefined ? null : `#${alvo.pull}`].filter(Boolean).join(" ")}</span>
                  {alvo.title === undefined ? null : <span className="text-muted-foreground">{alvo.title}</span>}
                </>
              )}
            </div>

            <Campo rotulo={t("runs.newAction.kind")}>
              <Select data-locum-nova-acao-tipo="" onChange={(e) => trocarAcao(e.target.value)} value={kind}>
                <option value="">{t("runs.newAction.choose")}</option>
                {oferecidas.map((a) => (
                  <option key={a.kind} value={a.kind}>
                    {rotuloDaAcao(t, a.kind)}
                  </option>
                ))}
              </Select>
            </Campo>
            {catalogo.status === "ready" && oferecidas.length === 0 ? (
              <p className="text-muted-foreground text-xs">{t("runs.newAction.none")}</p>
            ) : null}

            {escolhida === undefined ? null : (
              <>
                {campos.map((campo) => (
                  <CampoDoFormulario
                    campo={campo}
                    kind={kind}
                    erro={erros.find((e) => e.campo === campo.nome)?.motivo}
                    key={campo.nome}
                    texto={textos[campo.nome] ?? ""}
                    aoMudar={(v) => setTextos((atual) => ({ ...atual, [campo.nome]: v }))}
                  />
                ))}
                <Campo rotulo={t("runs.newAction.derivesFrom")}>
                  <Select onChange={(e) => setDerivaDe(e.target.value)} value={derivaDe}>
                    <option value="">{t("runs.newAction.derivesNone")}</option>
                    {detalhe.steps.filter((p) => p.origem === "fluxo").map((p) => (
                      <option key={p.stepKey} value={p.stepKey}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Campo>
              </>
            )}
            {recusa === null ? null : <p className="text-destructive text-xs" data-locum-nova-acao-recusa="">{recusa}</p>}
          </div>
        )}

        <DialogFooter>
          {proposta !== null ? (
            <>
              <Button onClick={aoFechar} variant="ghost">{t("runs.newAction.close")}</Button>
              <Button onClick={() => navegar("inbox")}>{t("runs.newAction.openQueue")}</Button>
            </>
          ) : (
            <>
              <Button disabled={enviando} onClick={aoFechar} variant="ghost">{t("runs.newAction.cancel")}</Button>
              <Button data-locum-nova-acao-propor="" disabled={enviando || escolhida === undefined} onClick={propor}>
                {t("runs.newAction.propose")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Um campo do esquema: o controle vem do tipo, e o nome e a descrição são os que o handler declarou. */
function CampoDoFormulario({
  campo,
  kind,
  texto,
  erro,
  aoMudar,
}: {
  campo: CampoDoEsquema;
  kind: string;
  texto: string;
  erro: ErroDoFormulario["motivo"] | undefined;
  aoMudar: (valor: string) => void;
}) {
  const { t } = useTranslation();
  // Rótulo e ajuda vêm do dicionário, por ação e campo; o nome e a descrição do esquema só entram sem texto.
  const base = `runs.newAction.fields.${kind.replaceAll(".", "_")}.${campo.nome}`;
  const nome = t(`${base}.label`, { defaultValue: campo.nome });
  const rotulo = campo.obrigatorio ? `${nome} *` : nome;
  const ajuda = t(`${base}.help`, { defaultValue: campo.descricao ?? "" });
  let controle;
  if (campo.tipo === "enum") {
    controle = (
      <Select data-locum-nova-acao-campo={campo.nome} onChange={(e) => aoMudar(e.target.value)} value={texto}>
        <option value="">{t("runs.newAction.choose")}</option>
        {(campo.opcoes ?? []).map((o) => (
          <option key={String(o)} value={String(o)}>{String(o)}</option>
        ))}
      </Select>
    );
  } else if (campo.tipo === "boolean") {
    controle = (
      <Select data-locum-nova-acao-campo={campo.nome} onChange={(e) => aoMudar(e.target.value)} value={texto}>
        <option value="">{t("runs.newAction.choose")}</option>
        {["true", "false"].map((v) => (
          <option key={v} value={v}>{v}</option>
        ))}
      </Select>
    );
  } else if (campo.tipo === "array" || escritoComoJson(campo) || campo.tipo === "string") {
    controle = (
      <Textarea
        className={escritoComoJson(campo) ? "font-mono text-xs" : undefined}
        data-locum-nova-acao-campo={campo.nome}
        onChange={(e) => aoMudar(e.target.value)}
        rows={campo.tipo === "string" ? 2 : 4}
        value={texto}
      />
    );
  } else {
    controle = <Input data-locum-nova-acao-campo={campo.nome} onChange={(e) => aoMudar(e.target.value)} value={texto} />;
  }
  return (
    <div className="flex flex-col gap-1">
      <Campo ajuda={ajuda === "" ? undefined : ajuda} rotulo={rotulo}>
        {controle}
      </Campo>
      {erro === undefined ? null : <span className="text-destructive text-xs">{t(`runs.newAction.error.${erro}`)}</span>}
    </div>
  );
}
