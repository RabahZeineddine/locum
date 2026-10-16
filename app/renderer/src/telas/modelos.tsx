import { Badge } from "@/components/ui/badge";
import { CabecalhoDaTela } from "@/components/cabecalho-da-tela";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { pontoDoProvedor } from "@/lib/estado-do-ponto";
import { call, invalidateReads, read, useRead, type ReadResult } from "@/lib/bridge";
import { avisoDoEnderecoDoOllama } from "@/lib/conexao-acao";
import { rotuloDoModelo, rotuloDoProvedor } from "@/lib/rotulos";
import { cn } from "@/lib/utils";
import { Cpu, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TelaProps } from "../rotas";
import { GrupoDeLinhas } from "./blocos";
import { LimitesDoProvedor } from "./limites";

type Provedor = ReadResult<"providers.list">[number];
type Orcamento = ReadResult<"agents.budgets">[number];
type Preco = ReadResult<"providers.prices">[number];
type ChaveDeProvedor = ReadResult<"providers.credentials">[number];
type ConferenciaDeProvedor = ReadResult<"providers.checkSecret">;

/* --------------------------------------------------------------- provedores */

type ModelosDoProvedor = { modelos: string[]; erro?: string };

/*
 * Os modelos de cada provedor ligado, lidos uma vez por conjunto de ligados.
 * Bate no catálogo de quem tem chave, que é de graça e só lista nomes; guardar
 * ou esquecer uma chave muda o conjunto, e a leitura refaz sozinha. Enquanto
 * não volta, o valor é nulo, e a linha diz que está lendo.
 */
function useModelosLigados(nomes: string): Map<string, ModelosDoProvedor> | null {
  const [lidos, setLidos] = useState<{ nomes: string; mapa: Map<string, ModelosDoProvedor> } | null>(null);
  useEffect(() => {
    if (nomes === "") return;
    let vivo = true;
    call("providers.allModels", { assinatura: true }).then(
      (lista) => vivo && setLidos({ nomes, mapa: new Map(lista.map((c) => [c.provedor, c])) }),
      () => vivo && setLidos({ nomes, mapa: new Map() }),
    );
    return () => {
      vivo = false;
    };
  }, [nomes]);
  return lidos?.nomes === nomes ? lidos.mapa : null;
}

const MODELOS_VISIVEIS = 12;

function ListaDeModelos({ modelos, provedor }: { modelos: ModelosDoProvedor | null; provedor: string }) {
  const { t } = useTranslation();
  const [todos, setTodos] = useState(false);

  if (modelos === null) {
    return <p className="text-muted-foreground text-xs">{t("settings.providers.modelsLoading")}</p>;
  }
  if (modelos.erro !== undefined && modelos.modelos.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        {t("settings.providers.modelsError", { message: modelos.erro })}
      </p>
    );
  }
  if (modelos.modelos.length === 0) {
    return <p className="text-muted-foreground text-xs">{t("settings.providers.modelsNone")}</p>;
  }

  const visiveis = todos ? modelos.modelos : modelos.modelos.slice(0, MODELOS_VISIVEIS);
  const resto = modelos.modelos.length - visiveis.length;
  return (
    <div className="flex flex-wrap gap-1" data-locum-modelos={provedor}>
      {visiveis.map((m) => (
        <span
          className="bg-muted text-foreground rounded px-1.5 py-0.5 text-xs"
          data-locum-modelo={m}
          key={m}
          title={m}
        >
          {rotuloDoModelo(m)}
        </span>
      ))}
      {resto > 0 ? (
        <button
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring cursor-pointer rounded px-1.5 py-0.5 text-xs outline-none focus-visible:ring-2"
          onClick={() => setTodos(true)}
          type="button"
        >
          {t("settings.providers.modelsMore", { count: resto })}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Desligar vale para o que o Locum acha sozinho, como o Claude Code instalado
 * na máquina: o provedor some do chat, dos agents e da substituição, sem
 * apagar chave nem desinstalar nada.
 */
function LigaDesligaProvedor({ provedor, recarregar }: { provedor: Provedor; recarregar: () => Promise<void> }) {
  const { t } = useTranslation();
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const alternar = (): void => {
    setEnviando(true);
    setErro(null);
    call("providers.setEnabled", provedor.name, provedor.disabled).then(
      async () => {
        await recarregar();
        setEnviando(false);
      },
      (falha: unknown) => {
        setEnviando(false);
        setErro(falha instanceof Error ? falha.message : String(falha));
      },
    );
  };

  return (
    <span className="ml-auto flex items-center gap-2">
      {erro === null ? null : <span className="text-sev-critical text-xs">{erro}</span>}
      <Button disabled={enviando} onClick={alternar} size="sm" variant="ghost">
        {t(provedor.disabled ? "settings.providers.enable" : "settings.providers.disable")}
      </Button>
    </span>
  );
}

function LinhaDoProvedor({
  chave,
  modelos,
  precos,
  provedor,
  recarregar,
  recarregarPrecos,
}: {
  chave: ChaveDeProvedor | undefined;
  modelos: ModelosDoProvedor | null;
  precos: Preco[];
  provedor: Provedor;
  recarregar: () => Promise<void>;
  recarregarPrecos: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const contagem = provedor.available && modelos !== null && modelos.modelos.length > 0 ? modelos.modelos.length : null;

  return (
    <div
      className="border-border border-b text-[13px] last:border-b-0"
      data-locum-chave-ambiente={chave?.env === true ? "sim" : "nao"}
      data-locum-chave-conferida={chave?.checkedAt ?? ""}
      data-locum-chave-guardada={chave === undefined ? "" : chave.stored ? "sim" : "nao"}
      data-locum-chave-modelos={chave?.modelCount ?? ""}
      data-locum-chave-ref={chave?.ref ?? ""}
      data-locum-disponivel={provedor.available ? "sim" : "nao"}
      data-locum-provider={provedor.name}
    >
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
        <StatusDot estado={pontoDoProvedor(provedor, modelos)} />
        <span className="min-w-24 truncate font-medium" title={provedor.name}>{rotuloDoProvedor(provedor.name)}</span>
        {/* O ponto leva a cor; o texto ao lado diz o mesmo em palavras e fica neutro. */}
        {provedor.available ? (
          <span className="text-muted-foreground shrink-0 text-xs">{t("settings.providers.available")}</span>
        ) : null}
        {provedor.subscription ? (
          <span className="text-muted-foreground border-border shrink-0 rounded border px-1.5 text-[11px]">
            {t("settings.providers.subscription")}
          </span>
        ) : null}
        {provedor.disabled ? (
          <span className="text-muted-foreground shrink-0 text-xs">{t("settings.providers.disabled")}</span>
        ) : null}
        {contagem === null ? null : (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums" data-locum-modelos-contagem={contagem}>
            {t("settings.providers.modelCount", { count: contagem })}
          </span>
        )}
        {chave === undefined || chave.ref === null || (!chave.stored && !provedor.available) ? null : (
          <Badge
            data-locum-credencial={chave.ref}
            data-locum-guardado={chave.stored ? "sim" : "nao"}
            variant={chave.stored ? "secondary" : "outline"}
          >
            {t(chave.stored ? "settings.credential.stored" : "settings.credential.missing", {
              ref: chave.ref,
            })}
          </Badge>
        )}
        {/* Com campo de chave ou de endereço logo abaixo, o nome da variável de ambiente só repete o campo. */}
        {provedor.requires.length > 0 && (chave === undefined || chave.variable === null) && provedor.name !== "ollama" ? (
          <span className="text-muted-foreground text-xs">
            {t(provedor.available ? "settings.providers.uses" : "settings.providers.missing", {
              requirements: provedor.requires.join(", "),
            })}
          </span>
        ) : null}
        {provedor.available || provedor.disabled ? (
          <LigaDesligaProvedor provedor={provedor} recarregar={recarregar} />
        ) : null}
      </div>

      <div className="flex flex-col gap-2 pr-3 pb-2.5 pl-[1.875rem] empty:hidden">
        {provedor.available ? <ListaDeModelos modelos={modelos} provedor={provedor.name} /> : null}

        <LimitesDoProvedor disponivel={provedor.available} nome={provedor.name} />

        {provedor.name === "ollama" ? <EnderecoDoOllama recarregar={recarregar} /> : null}

        {/* Assinatura sem ação na tela: diz o que fazer fora dela para o provedor ficar disponível. */}
        {provedor.subscription && !provedor.available && !provedor.disabled ? (
          <p className="text-muted-foreground max-w-[68ch] text-xs" data-locum-assinatura-ajuda={provedor.name}>
            {t(`settings.providers.subscriptionHelp.${provedor.name}`, { defaultValue: "" })}
          </p>
        ) : null}

        {chave === undefined || chave.variable === null ? null : provedor.available || provedor.disabled ? (
          <ChaveDoProvedor chave={chave} provedor={provedor} recarregar={recarregar} />
        ) : (
          // Recolhida enquanto o provedor não está em uso: cinco campos de senha
          // abertos viravam o assunto da tela. Fechada, ela continua no DOM.
          <details className="group">
            <summary className="text-primary hover:text-foreground w-fit cursor-pointer list-none text-xs font-medium">
              <Plus aria-hidden className="mr-1 inline size-3.5 align-[-2px]" />
              {t("settings.providers.addKey")}
            </summary>
            <div className="mt-2">
              <ChaveDoProvedor chave={chave} provedor={provedor} recarregar={recarregar} />
            </div>
          </details>
        )}

        {/*
          A assinatura gasta cota do plano, e não token cobrado: preço ali não mede
          nada. Nos outros, o preço só serve ao orçamento, então fica recolhido e
          só aparece no provedor que já roda.
        */}
        {provedor.subscription || !provedor.available ? null : (
          <details className="group">
            <summary className="text-muted-foreground hover:text-foreground w-fit cursor-pointer text-xs">
              {t("settings.prices.summary", { count: precos.length })}
            </summary>
            <div className="pt-2">
              <PrecosDoProvedor precos={precos} provedor={provedor.name} recarregar={recarregarPrecos} />
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

/**
 * O endereço do Ollama, editado aqui. Fica nos ajustes, e não na variável de
 * ambiente: vale na hora, sem reiniciar. Sem endereço salvo, a variável
 * `OLLAMA_BASE_URL` continua valendo para quem já a usava.
 */
const EXEMPLO_DO_OLLAMA = "http://127.0.0.1:11434/v1";

function EnderecoDoOllama({ recarregar }: { recarregar: () => Promise<void> }) {
  const { t } = useTranslation();
  const lido = useRead("providers.ollamaUrl");
  const [valor, setValor] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  if (lido.data === undefined) return null;
  const { saved, env } = lido.data;
  const atual = valor ?? saved ?? env ?? "";
  const aviso = avisoDoEnderecoDoOllama(atual);

  const gravar = (endereco: string | null): void => {
    setEnviando(true);
    setErro(null);
    call("providers.setOllamaUrl", endereco).then(
      async () => {
        await recarregar();
        invalidateReads("providers.ollamaUrl");
        setValor(null);
        setEnviando(false);
      },
      (falha: unknown) => {
        setEnviando(false);
        setErro(falha instanceof Error ? falha.message : String(falha));
      },
    );
  };

  return (
    <form
      className="flex flex-col gap-1.5"
      data-locum-ollama=""
      onSubmit={(e) => {
        e.preventDefault();
        gravar(atual.trim());
      }}
    >
      <label className="text-xs font-medium" htmlFor="ollama-url">
        {t("settings.providers.ollama.label")}
      </label>
      <div className="flex gap-2">
        <Input
          autoComplete="off"
          className="flex-1 font-mono text-xs"
          data-locum-ollama-url=""
          id="ollama-url"
          onChange={(e) => setValor(e.target.value)}
          placeholder={EXEMPLO_DO_OLLAMA}
          value={atual}
        />
        <Button
          data-locum-ollama-salvar=""
          disabled={enviando || atual.trim() === "" || atual.trim() === saved || aviso === "invalid"}
          size="sm"
          type="submit"
        >
          {t("settings.providers.ollama.save")}
        </Button>
        {saved === null ? null : (
          <Button disabled={enviando} onClick={() => gravar(null)} size="sm" type="button" variant="ghost">
            {t("settings.providers.ollama.clear")}
          </Button>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {saved === null && env !== null ? t("settings.providers.ollama.fromEnv") : t("settings.providers.ollama.hint")}
      </p>
      {aviso === null ? null : (
        <p
          className={cn(
            "flex items-center gap-1.5 text-xs",
            aviso === "invalid" ? "text-sev-critical" : "text-muted-foreground",
          )}
          data-locum-ollama-aviso={aviso}
        >
          <StatusDot estado={aviso === "invalid" ? "erro" : "aviso"} />
          {t(`settings.providers.ollama.${aviso}`)}
        </p>
      )}
      {erro === null ? null : <p className="text-sev-critical text-xs">{erro}</p>}
    </form>
  );
}

/**
 * O preço de cada modelo deste provedor, em dólar por milhão de tokens.
 *
 * É o que o runtime nativo multiplica pelo uso de cada passo. Modelo sem
 * preço aqui custa zero no registro, e o orçamento dele só vale em tokens; a
 * seção de orçamentos avisa quando é esse o caso.
 */
function PrecosDoProvedor({
  precos,
  provedor,
  recarregar,
}: {
  precos: Preco[];
  provedor: string;
  recarregar: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [modelo, setModelo] = useState("");
  const [entrada, setEntrada] = useState("");
  const [saida, setSaida] = useState("");
  const [recusa, setRecusa] = useState<string | null>(null);

  const numero = (texto: string): number => Number(texto.replace(",", "."));
  const valido =
    modelo.trim().length > 0 &&
    entrada.trim().length > 0 &&
    saida.trim().length > 0 &&
    numero(entrada) >= 0 &&
    numero(saida) >= 0;

  const recusar = (erro: unknown): void => setRecusa(erro instanceof Error ? erro.message : String(erro));

  const gravar = (): void => {
    setRecusa(null);
    call("providers.setPrice", {
      provider: provedor,
      model: modelo.trim(),
      inputUsdPerMtok: numero(entrada),
      outputUsdPerMtok: numero(saida),
    }).then(() => {
      setModelo("");
      setEntrada("");
      setSaida("");
      return recarregar();
    }, recusar);
  };

  const apagar = (nome: string): void => {
    setRecusa(null);
    call("providers.removePrice", provedor, nome).then(recarregar, recusar);
  };

  const campo = "font-mono text-xs";

  return (
    <div className="flex flex-col gap-1.5" data-locum-precos={provedor}>
      {precos.map((preco) => (
        <div
          className="flex flex-wrap items-center gap-3 text-xs"
          data-locum-preco={`${preco.provider}/${preco.model}`}
          key={preco.model}
        >
          <span className="w-48 shrink-0 truncate font-mono">{preco.model}</span>
          <span className="tabular-nums">
            {t("settings.prices.rate", {
              input: preco.inputUsdPerMtok,
              output: preco.outputUsdPerMtok,
            })}
          </span>
          <Button onClick={() => apagar(preco.model)} size="sm" variant="ghost">
            {t("settings.prices.remove")}
          </Button>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={t("settings.prices.model", { provider: provedor })}
          className={cn(campo, "min-w-40 flex-1")}
          onChange={(evento) => setModelo(evento.target.value)}
          placeholder={t("settings.prices.modelPlaceholder")}
          spellCheck={false}
          value={modelo}
        />
        <Input
          aria-label={t("settings.prices.input")}
          className={cn(campo, "w-28")}
          inputMode="decimal"
          onChange={(evento) => setEntrada(evento.target.value)}
          placeholder={t("settings.prices.input")}
          value={entrada}
        />
        <Input
          aria-label={t("settings.prices.output")}
          className={cn(campo, "w-28")}
          inputMode="decimal"
          onChange={(evento) => setSaida(evento.target.value)}
          placeholder={t("settings.prices.output")}
          value={saida}
        />
        <Button disabled={!valido} onClick={gravar} size="sm" variant="secondary">
          {t("settings.prices.save")}
        </Button>
      </div>

      {recusa === null ? null : (
        <p className="text-destructive text-xs">{t("settings.prices.refused", { message: recusa })}</p>
      )}
    </div>
  );
}

type Exame =
  | { fase: "parado" }
  | { fase: "conferindo" }
  | { fase: "respondeu"; resultado: ConferenciaDeProvedor }
  | { fase: "recusado"; erro: string };

/**
 * A chave de um provedor: guardar, esquecer e perguntar o catálogo.
 *
 * Mesma viagem de mão única da credencial do GitHub. O valor digitado sai
 * daqui para o keychain e nunca volta, porque não existe canal que devolva
 * segredo: o que fica visível é se há algo guardado, quando foi a última
 * conferência e quantos modelos ela contou.
 *
 * Guardar deixa o provedor disponível na hora, sem reabrir a janela. Quem faz
 * isso é o serviço, que remonta o registro com a chave nova antes de
 * responder; aqui só se relê o que mudou.
 *
 * Conferir fica atrás de um clique pela mesma razão do teste de servidor MCP:
 * ele sai para a rede, e abrir a tela de configuração não é pedir exame.
 */
function ChaveDoProvedor({
  chave,
  provedor,
  recarregar,
}: {
  chave: ChaveDeProvedor;
  provedor: Provedor;
  recarregar: () => Promise<void>;
}) {
  const { i18n, t } = useTranslation();
  const [valor, setValor] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [exame, setExame] = useState<Exame>({ fase: "parado" });

  const guardar = (): void => {
    setSalvando(true);
    // O campo é limpo antes mesmo da resposta, como no token do GitHub: o que
    // foi digitado já está a caminho do cofre, e deixá-lo na tela só aumenta a
    // chance de ele aparecer numa captura ou num ombro alheio.
    const digitado = valor;
    setValor("");
    call("providers.saveSecret", provedor.name, digitado)
      .then(recarregar, () => undefined)
      .finally(() => {
        setSalvando(false);
        // A conferência anterior era da chave antiga, e o serviço já a apagou.
        setExame({ fase: "parado" });
      });
  };

  const esquecer = (): void => {
    call("providers.forgetSecret", provedor.name)
      .then(recarregar, () => undefined)
      .finally(() => setExame({ fase: "parado" }));
  };

  const conferir = (): void => {
    setExame({ fase: "conferindo" });
    call("providers.checkSecret", provedor.name).then(
      (resultado) => {
        setExame({ fase: "respondeu", resultado });
        void recarregar();
      },
      // `checkSecret` devolve a recusa do provedor como dado, então chegar
      // aqui quer dizer que a ponte recusou, e não que a chave está errada.
      (erro: unknown) =>
        setExame({
          fase: "recusado",
          erro: erro instanceof Error ? erro.message : String(erro),
        }),
    );
  };

  const conferidaEm =
    chave.checkedAt === null ? null : new Date(chave.checkedAt * 1000).toLocaleString(i18n.language);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={t("settings.providerKey.field", { provider: provedor.name })}
          autoComplete="off"
          className="min-w-56 flex-1 font-mono text-xs"
          data-locum-chave-campo={provedor.name}
          disabled={!chave.vault}
          onChange={(evento) => setValor(evento.target.value)}
          placeholder={t(
            chave.vault ? "settings.providerKey.placeholder" : "settings.providerKey.noVault",
            { variable: chave.variable },
          )}
          spellCheck={false}
          type="password"
          value={valor}
        />
        <Button
          data-locum-chave-salvar={provedor.name}
          disabled={salvando || !chave.vault || valor.trim().length === 0}
          onClick={guardar}
          size="sm"
          variant="secondary"
        >
          {t(salvando ? "settings.providerKey.saving" : "settings.providerKey.save")}
        </Button>
        {/* Sem chave guardada nem no ambiente, conferir só responderia "falta chave". */}
        {chave.stored || chave.env ? (
        <Button
          data-locum-chave-conferir={provedor.name}
          disabled={exame.fase === "conferindo"}
          onClick={conferir}
          size="sm"
          variant="ghost"
        >
          {t(
            exame.fase === "conferindo"
              ? "settings.providerKey.checking"
              : "settings.providerKey.check",
          )}
        </Button>
        ) : null}
        {chave.stored ? (
          <Button
            data-locum-chave-esquecer={provedor.name}
            onClick={esquecer}
            size="sm"
            variant="ghost"
          >
            {t("settings.providerKey.forget")}
          </Button>
        ) : null}
      </div>

      {chave.env && !chave.stored ? (
        <p className="text-muted-foreground text-xs">
          {t("settings.providerKey.fromEnv", { variable: chave.variable })}
        </p>
      ) : null}

      {conferidaEm === null ? null : (
        <p className="text-muted-foreground text-xs" data-locum-chave-historico={provedor.name}>
          {t("settings.providerKey.lastCheck", {
            count: chave.modelCount ?? 0,
            when: conferidaEm,
          })}
        </p>
      )}

      <ResultadoDaChave exame={exame} provedor={provedor.name} />
    </div>
  );
}

/* ---------------------------------------------- provedores cadastrados */

type Cadastrado = ReadResult<"providers.registered">[number];
type Remocao = ReadResult<"providers.remove">;

/**
 * Gateway compatível com OpenAI: cadastrar, ver e remover.
 *
 * A lista de provedores acima é fixa no código, e é por isso que esta seção
 * existe: um segundo gateway da empresa, um Ollama em outra máquina ou um
 * OpenRouter não têm onde entrar sem ela. O que se cadastra aqui aparece lá em
 * cima como qualquer outro provedor, com campo de chave próprio, e um passo
 * pode apontar para ele pelo identificador.
 *
 * Remover pede dois cliques quando o provedor está em uso. O primeiro volta
 * com a lista de onde ele aparece, e é o serviço que a monta: a tela mostra o
 * que recebeu e oferece o segundo clique, mas a decisão de não apagar em
 * silêncio é do lado que apaga.
 */
function ProvedoresCadastrados({
  chaves,
  modelos,
  provedores,
  recarregar,
}: {
  chaves: Map<string, ChaveDeProvedor>;
  modelos: Map<string, ModelosDoProvedor> | null;
  provedores: Provedor[];
  recarregar: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const inicial = useRead("providers.registered");
  const [id, setId] = useState("");
  const [nome, setNome] = useState("");
  const [url, setUrl] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // Por provedor, e não um só para a seção: duas remoções avisadas ao mesmo
  // tempo mostrariam a lista de uso de uma na linha da outra.
  const [avisos, setAvisos] = useState<Record<string, Remocao>>({});

  const lista = inicial.data ?? [];
  const recusa = erro ?? inicial.error?.message ?? null;

  const reler = (): Promise<void> => {
    invalidateReads("providers.registered");
    return recarregar().then(
      () => undefined,
      (falha: unknown) => setErro(falha instanceof Error ? falha.message : String(falha)),
    );
  };

  const agir = (acao: Promise<unknown>): Promise<unknown> => {
    setOcupado(true);
    return acao
      .then(
        (resultado) => {
          setErro(null);
          return resultado;
        },
        (falha: unknown) => {
          setErro(falha instanceof Error ? falha.message : String(falha));
          return undefined;
        },
      )
      .then(async (resultado) => {
        await reler();
        return resultado;
      })
      .finally(() => setOcupado(false));
  };

  const cadastrar = (): void => {
    void agir(
      call("providers.register", { id: id.trim(), label: nome.trim(), baseUrl: url.trim() }).then(
        () => {
          setId("");
          setNome("");
          setUrl("");
        },
      ),
    );
  };

  const remover = (alvo: string, force: boolean): void => {
    void agir(call("providers.remove", alvo, force)).then((resultado) => {
      const remocao = resultado as Remocao | undefined;
      setAvisos((antes) => {
        const proximos = { ...antes };
        // Removido ou recusado pela ponte, o aviso anterior sai: ele descrevia
        // um provedor que não está mais lá, ou uma tentativa que não chegou.
        if (remocao === undefined || remocao.removed) delete proximos[alvo];
        else proximos[alvo] = remocao;
        return proximos;
      });
    });
  };

  const valido = id.trim() !== "" && nome.trim() !== "" && url.trim() !== "";

  return (
    <div
      className="flex flex-col"
      data-locum-cadastrados={lista.map((p) => p.id).join(",")}
      data-locum-probe="provedores-cadastrados"
    >
      {lista.length === 0 ? (
        <EmptyState
          className="m-3 py-5"
          icone={<Plus aria-hidden />}
          titulo={t("settings.registered.empty")}
        />
      ) : (
        <ul className="flex flex-col">
          {lista.map((cadastrado) => (
            <LinhaDoCadastrado
              aoRemover={(force) => remover(cadastrado.id, force)}
              aviso={avisos[cadastrado.id]}
              cadastrado={cadastrado}
              chave={chaves.get(cadastrado.id)}
              key={cadastrado.id}
              modelos={modelos?.get(cadastrado.id) ?? null}
              ocupado={ocupado}
              provedor={provedores.find((p) => p.name === cadastrado.id)}
              recarregar={reler}
            />
          ))}
        </ul>
      )}

      <div className="border-border flex flex-wrap items-center gap-2 border-t px-3 py-2">
        <Input
          aria-label={t("settings.registered.id")}
          autoComplete="off"
          className="w-40 font-mono text-xs"
          data-locum-cadastrar-id=""
          onChange={(evento) => setId(evento.target.value)}
          placeholder={t("settings.registered.idHint")}
          spellCheck={false}
          value={id}
        />
        <Input
          aria-label={t("settings.registered.label")}
          autoComplete="off"
          className="w-44 text-xs"
          data-locum-cadastrar-nome=""
          onChange={(evento) => setNome(evento.target.value)}
          placeholder={t("settings.registered.labelHint")}
          spellCheck={false}
          value={nome}
        />
        <Input
          aria-label={t("settings.registered.baseUrl")}
          autoComplete="off"
          className="min-w-56 flex-1 font-mono text-xs"
          data-locum-cadastrar-url=""
          onChange={(evento) => setUrl(evento.target.value)}
          placeholder={t("settings.registered.baseUrlHint")}
          spellCheck={false}
          value={url}
        />
        <Button
          data-locum-cadastrar-salvar=""
          disabled={ocupado || !valido}
          onClick={cadastrar}
          size="sm"
          variant="secondary"
        >
          {t("settings.registered.add")}
        </Button>
      </div>

      <p className="text-muted-foreground max-w-[68ch] px-3 pb-2 text-xs">{t("settings.registered.howTo")}</p>

      {recusa === null ? null : (
        <p className="text-destructive px-3 pb-2 text-xs" data-locum-cadastrados-erro={recusa}>
          {t("settings.registered.refused", { message: recusa })}
        </p>
      )}
    </div>
  );
}

function LinhaDoCadastrado({
  aoRemover,
  aviso,
  cadastrado,
  chave,
  modelos,
  ocupado,
  provedor,
  recarregar,
}: {
  aoRemover: (force: boolean) => void;
  aviso: Remocao | undefined;
  cadastrado: Cadastrado;
  chave: ChaveDeProvedor | undefined;
  modelos: ModelosDoProvedor | null;
  ocupado: boolean;
  provedor: Provedor | undefined;
  recarregar: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const usos = aviso === undefined || aviso.removed ? [] : aviso.usedBy;

  return (
    <li
      className="border-border flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-[13px] last:border-b-0"
      data-locum-cadastrado={cadastrado.id}
      data-locum-cadastrado-nome={cadastrado.label}
      data-locum-cadastrado-url={cadastrado.baseUrl}
      data-locum-cadastrado-usos={usos.length}
    >
      <StatusDot estado={provedor === undefined ? "ocioso" : pontoDoProvedor(provedor, modelos)} />
      <span className="font-mono text-[13px]">{cadastrado.id}</span>
      <span className="text-muted-foreground text-xs">{cadastrado.label}</span>
      <span className="text-muted-foreground font-mono text-xs">{cadastrado.baseUrl}</span>

      <div className="ml-auto flex items-center gap-1">
        <Button
          data-locum-cadastrado-remover={cadastrado.id}
          disabled={ocupado}
          onClick={() => aoRemover(false)}
          size="sm"
          variant="ghost"
        >
          {t("settings.registered.remove")}
        </Button>
        {usos.length === 0 ? null : (
          <Button
            data-locum-cadastrado-forcar={cadastrado.id}
            disabled={ocupado}
            onClick={() => aoRemover(true)}
            size="sm"
            variant="ghost"
          >
            {t("settings.registered.removeAnyway")}
          </Button>
        )}
      </div>

      {usos.length === 0 ? null : (
        <p className="text-destructive w-full text-xs">
          {t("settings.registered.inUse", {
            count: usos.length,
            where: usos
              .map((uso) =>
                uso.kind === "step"
                  ? t("settings.registered.useStep", { agent: uso.agentId, step: uso.stepKey })
                  : t("settings.registered.useFallback", { from: uso.from, to: uso.to }),
              )
              .join(", "),
          })}
        </p>
      )}
      {chave === undefined || chave.variable === null || provedor === undefined ? null : (
        <div className="w-full pl-[1.875rem]">
          <ChaveDoProvedor chave={chave} provedor={provedor} recarregar={recarregar} />
        </div>
      )}
    </li>
  );
}

function ResultadoDaChave({ exame, provedor }: { exame: Exame; provedor: string }) {
  const { t } = useTranslation();

  if (exame.fase === "parado" || exame.fase === "conferindo") return null;

  if (exame.fase === "recusado") {
    return (
      <p className="text-destructive text-xs" data-locum-chave-resultado="recusado">
        {t("settings.providerKey.bridgeRefused", { message: exame.erro })}
      </p>
    );
  }

  const { resultado } = exame;
  if (resultado.ok) {
    return (
      <p className="text-chart-2 text-xs" data-locum-chave-resultado="ok">
        {t("settings.providerKey.answered", { count: resultado.count, provider: provedor })}
      </p>
    );
  }

  return (
    <p className="text-destructive text-xs" data-locum-chave-resultado={resultado.reason}>
      {resultado.reason === "missing"
        ? t("settings.providerKey.missing", { provider: provedor })
        : t("settings.providerKey.failed", { message: resultado.message })}
    </p>
  );
}


/**
 * Modelos: de onde vêm os modelos desta máquina. Primeiro os provedores
 * ligados, com o estado e os modelos de cada um; depois como adicionar outro.
 *
 * Chave e endereço se editam aqui mesmo, sem variável de ambiente nem
 * reinício. Provedor de fábrica é só o público: endereço de empresa entra como
 * "compatível com OpenAI".
 */
export function Modelos(_props: TelaProps) {
  const { t } = useTranslation();
  const provedores = useRead("providers.list");
  const chaves = useRead("providers.credentials");
  /*
   * Guardar chave muda duas leituras ao mesmo tempo: a chave em si e a
   * disponibilidade do provedor. Elas voltam juntas para que a linha nunca
   * apareça com chave guardada e provedor ainda apagado, que é o meio segundo
   * em que alguém acharia que não funcionou.
   */
  const [provedoresRecarregados, setProvedoresRecarregados] = useState<{
    lista: Provedor[];
    chaves: ChaveDeProvedor[];
  } | null>(null);

  const recarregarProvedores = (): Promise<void> =>
    Promise.all([read("providers.list"), read("providers.credentials")]).then(
      ([lista, novasChaves]) => setProvedoresRecarregados({ lista, chaves: novasChaves }),
      () => undefined,
    );

  // O GLM e de uma empresa: some da lista enquanto nao estiver configurado.
  const listaDeProvedores = (provedoresRecarregados?.lista ?? provedores.data ?? []).filter((p) => p.visible);
  // O desligado fica entre os ligados, com o botão de religar: foi a pessoa
  // que desligou, e ele não precisa de chave nenhuma para voltar.
  const ligados = listaDeProvedores.filter((p) => p.available || p.disabled);
  // Gateway cadastrado sem chave guarda a chave na própria linha, na seção de
  // gateways: aqui ele apareceria duas vezes, e longe de onde foi cadastrado.
  const paraLigar = listaDeProvedores.filter((p) => !p.available && !p.disabled && p.registered === null);
  const modelos = useModelosLigados(ligados.filter((p) => p.available).map((p) => p.name).join(","));
  const chavesPorProvedor = new Map(
    (provedoresRecarregados?.chaves ?? chaves.data ?? []).map((c) => [c.provider, c]),
  );
  const orcamentos = useRead("agents.budgets");
  const precos = useRead("providers.prices");
  /*
   * Gravar preço muda o aviso do orçamento: modelo que ganhou preço deixa de
   * ser medido só em tokens. As duas leituras voltam juntas pelo mesmo motivo
   * das de provedor logo acima.
   */
  const [precosRecarregados, setPrecosRecarregados] = useState<{
    precos: Preco[];
    orcamentos: Orcamento[];
  } | null>(null);

  const recarregarPrecos = (): Promise<void> =>
    Promise.all([read("providers.prices"), read("agents.budgets")]).then(
      ([novosPrecos, novosOrcamentos]) =>
        setPrecosRecarregados({ precos: novosPrecos, orcamentos: novosOrcamentos }),
      () => undefined,
    );
  const listaDePrecos = precosRecarregados?.precos ?? precos.data ?? [];

  const leituras = [provedores, chaves, orcamentos, precos];
  const erro = leituras.find((l) => l.status === "error")?.error;
  const pronto = leituras.every((l) => l.status === "ready");
  const estado = erro !== undefined ? "erro" : pronto ? "pronto" : "carregando";

  const linha = (provedor: Provedor, comModelos: boolean) => (
    <LinhaDoProvedor
      chave={chavesPorProvedor.get(provedor.name)}
      key={provedor.name}
      modelos={comModelos && modelos !== null ? (modelos.get(provedor.name) ?? null) : null}
      precos={comModelos ? listaDePrecos.filter((p) => p.provider === provedor.name) : []}
      provedor={provedor}
      recarregar={recarregarProvedores}
      recarregarPrecos={recarregarPrecos}
    />
  );

  return (
    <div
      className="mx-auto flex w-full max-w-4xl flex-col gap-6"
      data-estado={estado}
      data-locum-probe="models"
      data-locum-provedores={listaDeProvedores.map((p) => p.name).join(",")}
    >
      <CabecalhoDaTela descricao={t("models.lead")} titulo={t("models.title")} />

      {erro === undefined ? null : (
        <p className="text-destructive text-sm">{t("settings.refused", { channel: erro.channel, message: erro.message })}</p>
      )}

      <GrupoDeLinhas descricao={t("settings.providers.description")} titulo={t("settings.providers.title")}>
        {ligados.length === 0 ? (
          <EmptyState
            className="m-3 py-5"
            icone={<Cpu aria-hidden />}
            titulo={t("settings.providers.empty")}
          />
        ) : (
          ligados.map((p) => linha(p, true))
        )}
      </GrupoDeLinhas>

      {paraLigar.length === 0 ? null : (
        <GrupoDeLinhas descricao={t("settings.providers.addDescription")} titulo={t("settings.providers.addTitle")}>
          {paraLigar.map((p) => linha(p, false))}
        </GrupoDeLinhas>
      )}

      <GrupoDeLinhas descricao={t("settings.registered.description")} titulo={t("settings.registered.title")}>
        <ProvedoresCadastrados
          chaves={chavesPorProvedor}
          modelos={modelos}
          provedores={provedoresRecarregados?.lista ?? provedores.data ?? []}
          recarregar={recarregarProvedores}
        />
      </GrupoDeLinhas>
    </div>
  );
}
