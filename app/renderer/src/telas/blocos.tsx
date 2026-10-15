import { Badge } from "@/components/ui/badge";
import { ListGroup, ListRow } from "@/components/ui/list-row";
import { type ReadResult } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

type Credencial = ReadResult<"credentials.overview">["refs"][number];

/** Um bloco de preferências, uma por linha, como nos ajustes do sistema. */
export function Grupo({ children }: { children: React.ReactNode }) {
  return <div className="superficie divide-border divide-y overflow-hidden rounded-xl">{children}</div>;
}

/**
 * Uma preferência: nome e explicação à esquerda, controle à direita. O
 * controle que precisa de largura (um caminho de pasta) desce para baixo do
 * texto com `empilhado`.
 */
export function Preferencia({
  children,
  descricao,
  empilhado = false,
  titulo,
}: {
  children: React.ReactNode;
  descricao: string;
  empilhado?: boolean;
  titulo: string;
}) {
  return (
    <div
      className={cn(
        "flex gap-x-8 gap-y-3 px-4 py-4",
        empilhado ? "flex-col" : "flex-col lg:flex-row lg:items-center lg:justify-between",
      )}
    >
      <div className="flex max-w-[52ch] flex-col gap-0.5">
        <span className="text-sm font-medium">{titulo}</span>
        <span className="text-muted-foreground text-xs leading-relaxed">{descricao}</span>
      </div>
      <div className={cn("min-w-0 [&>*]:p-0", empilhado ? "w-full" : "lg:shrink-0")}>{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ secoes */

export function Secao({
  children,
  descricao,
  titulo,
}: {
  children: React.ReactNode;
  descricao: string;
  titulo: string;
}) {
  /*
   * Uma moldura só por seção.
   *
   * Antes a seção tinha borda e cada linha dentro dela também, então duas
   * molduras disputavam a mesma fronteira e o olho perdia onde um grupo
   * termina. Agora o fio separa linha de linha, e o grupo é delimitado pelo
   * espaço acima dele e pelo título.
   */
  return (
    <section className="flex flex-col gap-1">
      <h2 className="font-medium text-[15px] tracking-tight">{titulo}</h2>
      <p className="text-muted-foreground max-w-[68ch] text-xs">{descricao}</p>
      <div className="divide-border border-border superficie mt-2 divide-y overflow-hidden rounded-lg border">
        {children}
      </div>
    </section>
  );
}

/** Seção cujos itens já são cartões: sem a moldura de lista, em grade. */
export function SecaoEmGrade({
  children,
  colunas = false,
  descricao,
  titulo,
}: {
  children: React.ReactNode;
  colunas?: boolean;
  descricao: string;
  titulo: string;
}) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-[15px] font-medium tracking-tight">{titulo}</h2>
      <p className="text-muted-foreground max-w-[68ch] text-xs">{descricao}</p>
      <div className={cn("mt-2 grid items-start gap-3", colunas && "lg:grid-cols-2")}>{children}</div>
    </section>
  );
}

export function Vazio({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-3 text-muted-foreground text-sm">{children}</p>;
}

/**
 * A credencial de um cadastro: onde ela mora, e se existe valor la.
 *
 * O valor nao chega ate aqui nem por acidente. `credentials.overview` devolve
 * endereco e um booleano, e e isso que a tela tem para mostrar.
 */
export function Credenciais({ credencial }: { credencial: Credencial | undefined }) {
  const { t } = useTranslation();

  if (credencial === undefined) return null;
  return (
    <Badge
      data-locum-credencial={credencial.ref}
      data-locum-guardado={credencial.stored ? "sim" : "nao"}
      variant={credencial.stored ? "secondary" : "destructive"}
    >
      {t(credencial.stored ? "settings.credential.stored" : "settings.credential.missing", {
        ref: credencial.ref,
      })}
    </Badge>
  );
}

/* -------------------------------------------------------- linhas densas */

/** Grupo de linhas com o título e a frase acima, no lugar do cartão grande. */
export function GrupoDeLinhas({
  children,
  descricao,
  titulo,
}: {
  children: React.ReactNode;
  descricao?: string;
  titulo?: string;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      {titulo === undefined ? null : <h2 className="text-[13px] font-medium">{titulo}</h2>}
      {descricao === undefined ? null : <p className="text-muted-foreground max-w-[68ch] text-xs">{descricao}</p>}
      <ListGroup>{children}</ListGroup>
    </section>
  );
}

/**
 * Uma preferência em linha: rótulo e explicação à esquerda, controle à
 * direita. `empilhado` põe o controle embaixo, para o que precisa de largura.
 */
export function LinhaDePreferencia({
  children,
  descricao,
  empilhado = false,
  titulo,
}: {
  children: React.ReactNode;
  descricao: string;
  empilhado?: boolean;
  titulo: string;
}) {
  return (
    <ListRow className={cn("gap-x-6 py-2.5", empilhado ? "flex-col items-stretch gap-2" : "flex-wrap justify-between")}>
      <div className="flex min-w-48 max-w-[46ch] flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-medium">{titulo}</span>
        <span className="text-muted-foreground text-xs leading-relaxed">{descricao}</span>
      </div>
      <div className={cn("min-w-0 [&>*]:p-0", empilhado ? "w-full" : "shrink-0")}>{children}</div>
    </ListRow>
  );
}
