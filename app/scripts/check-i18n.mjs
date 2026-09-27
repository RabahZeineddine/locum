/**
 * Guarda contra literal de texto cravado fora do dicionário.
 *
 * O i18n do M4c só se mantém se alguém reclamar quando a próxima tela nascer
 * com texto direto no componente. Revisão humana não pega isso: uma string a
 * mais no meio de um JSX passa despercebida, e só aparece quando o app roda em
 * inglês e uma frase sai em português.
 *
 * A varredura é por posição, e não por formato da string. Procurar "texto que
 * parece prosa" acusaria nome de evento, consulta SQL e caminho de arquivo,
 * e o barulho faria a guarda ser desligada na primeira semana. Aqui só conta
 * literal que chega a uma pessoa pelo lugar onde está: conteúdo de JSX,
 * atributo que o navegador mostra ou lê em voz alta, e propriedade que o
 * Electron pinta em menu ou notificação. Fora dessas posições, literal é
 * identificador até prova em contrário.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Onde procurar.
 *
 * `renderer/components` fica de fora: shadcn e AI Elements entram
 * vendorizados, o texto em inglês deles veio do registry, e reescrever isso
 * para o dicionário quebraria a próxima atualização do upstream. O que essas
 * telas mostram de nosso passa por props, que são varridas normalmente na
 * chamada.
 */
const RAIZES = ["renderer/src", "renderer/lib", "electron"];

/** Atributo de JSX que vira texto na tela ou no leitor. */
const ATRIBUTOS = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "label",
  "placeholder",
  "title",
]);

/**
 * Propriedade de objeto que o Electron mostra.
 *
 * Cobre o template do menu da bandeja, o `Notification`, e as caixas de
 * diálogo. É lista fechada de propósito: `name`, `id` e `type` moram em
 * objetos parecidos e não são texto de produto.
 */
const PROPRIEDADES = new Set([
  "body",
  "buttonLabel",
  "detail",
  "label",
  "message",
  "placeholder",
  "sublabel",
  "subtitle",
  "title",
  "toolTip",
]);

/**
 * O que passa mesmo numa posição visível.
 *
 * Nome do produto não se traduz, e uma string sem letra nenhuma é separador ou
 * pontuação, não frase.
 */
const PERMITIDOS = new Set(["Locum"]);

const TEM_LETRA = /\p{L}/u;

function arquivos(raiz) {
  const absoluta = join(appDir, raiz);
  const achados = [];
  const pilha = [absoluta];

  while (pilha.length > 0) {
    const atual = pilha.pop();
    for (const entrada of readdirSync(atual)) {
      const caminho = join(atual, entrada);
      if (statSync(caminho).isDirectory()) {
        pilha.push(caminho);
      } else if (/\.tsx?$/.test(entrada) && !/\.d\.ts$/.test(entrada)) {
        achados.push(caminho);
      }
    }
  }

  return achados.sort();
}

/** Nome do atributo ou da propriedade, já sem as aspas quando vier entre elas. */
function nomeDe(no) {
  if (ts.isIdentifier(no) || ts.isJsxNamespacedName(no)) return no.getText();
  if (ts.isStringLiteral(no)) return no.text;
  return null;
}

/** O texto de um literal, ou null quando o nó não é literal de texto puro. */
function textoDe(no) {
  if (ts.isStringLiteral(no) || ts.isNoSubstitutionTemplateLiteral(no)) return no.text;
  // Template com interpolação continua sendo frase: `Olá, ${nome}` precisa do
  // dicionário tanto quanto a versão sem buraco.
  if (ts.isTemplateExpression(no)) {
    return no.head.text + no.templateSpans.map((s) => s.literal.text).join("");
  }
  return null;
}

function suspeito(texto) {
  const limpo = texto.trim();
  return limpo !== "" && TEM_LETRA.test(limpo) && !PERMITIDOS.has(limpo);
}

function varrer(caminho) {
  const fonte = ts.createSourceFile(
    caminho,
    readFileSync(caminho, "utf8"),
    ts.ScriptTarget.ES2023,
    true,
    caminho.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const achados = [];

  function acusar(no, texto, motivo) {
    const { line } = fonte.getLineAndCharacterOfPosition(no.getStart(fonte));
    achados.push({
      arquivo: relative(appDir, caminho),
      linha: line + 1,
      motivo,
      texto: texto.trim().replace(/\s+/g, " ").slice(0, 60),
    });
  }

  function visitar(no) {
    // Texto solto entre tags. O JSX preserva a indentação como conteúdo, então
    // só sobra o que tem letra depois do trim.
    if (ts.isJsxText(no)) {
      if (suspeito(no.text)) acusar(no, no.text, "texto dentro de JSX");
      return;
    }

    if (ts.isJsxAttribute(no) && no.initializer !== undefined) {
      const nome = nomeDe(no.name);
      if (nome !== null && ATRIBUTOS.has(nome)) {
        const valor = ts.isJsxExpression(no.initializer)
          ? no.initializer.expression
          : no.initializer;
        const texto = valor === undefined ? null : textoDe(valor);
        if (texto !== null && suspeito(texto)) acusar(no, texto, `atributo ${nome}`);
      }
    }

    // `{"texto"}` no meio do JSX escapa da regra do JsxText, e é como uma
    // string cravada costuma aparecer quando alguém foge do lint do editor.
    if (ts.isJsxExpression(no) && no.expression !== undefined && !ts.isJsxAttribute(no.parent)) {
      const texto = textoDe(no.expression);
      if (texto !== null && suspeito(texto)) acusar(no, texto, "expressão de JSX");
    }

    if (ts.isPropertyAssignment(no)) {
      const nome = nomeDe(no.name);
      if (nome !== null && PROPRIEDADES.has(nome)) {
        const texto = textoDe(no.initializer);
        if (texto !== null && suspeito(texto)) acusar(no, texto, `propriedade ${nome}`);
      }
    }

    ts.forEachChild(no, visitar);
  }

  ts.forEachChild(fonte, visitar);
  return achados;
}

const achados = RAIZES.flatMap(arquivos).flatMap(varrer);

if (achados.length > 0) {
  console.error(`${achados.length} literal de texto fora do dicionário:\n`);
  for (const a of achados) {
    console.error(`  ${a.arquivo}:${a.linha}  ${a.motivo}  ${JSON.stringify(a.texto)}`);
  }
  console.error(
    "\nMova o texto para app/locales/en.json e app/locales/pt-BR.json e chame por t().",
  );
  process.exit(1);
}

/*
 * Paridade de chaves entre os dois dicionários.
 *
 * Texto gerado em `src/` (context.md, corpo de prompt) não passa pela
 * varredura de JSX acima, porque não é tela: passa por `text-service.ts`
 * direto. Esta checagem garante que toda chave existe nos dois lados, ainda
 * que ninguém a leia num componente. O sufixo `_zero` fica de fora porque só
 * pt-BR o exige, e a checagem acima já cobre esse caso.
 */
function achatar(objeto, caminho = "") {
  const chaves = [];
  for (const [chave, valor] of Object.entries(objeto)) {
    const atual = caminho ? `${caminho}.${chave}` : chave;
    if (valor && typeof valor === "object" && !Array.isArray(valor)) {
      chaves.push(...achatar(valor, atual));
    } else {
      chaves.push(atual);
    }
  }
  return chaves;
}

const semSufixoZero = (chave) => !chave.endsWith("_zero");
const enDicionario = JSON.parse(readFileSync(new URL("../locales/en.json", import.meta.url), "utf8"));
const ptDicionario = JSON.parse(readFileSync(new URL("../locales/pt-BR.json", import.meta.url), "utf8"));
const enChaves = new Set(achatar(enDicionario).filter(semSufixoZero));
const ptChaves = new Set(achatar(ptDicionario).filter(semSufixoZero));

const faltaEmPt = [...enChaves].filter((chave) => !ptChaves.has(chave)).sort();
const faltaEmEn = [...ptChaves].filter((chave) => !enChaves.has(chave)).sort();

if (faltaEmPt.length > 0 || faltaEmEn.length > 0) {
  console.error("paridade de chaves quebrada entre en.json e pt-BR.json:\n");
  for (const chave of faltaEmPt) console.error(`  falta em pt-BR: ${chave}`);
  for (const chave of faltaEmEn) console.error(`  falta em en: ${chave}`);
  process.exit(1);
}

/*
 * Plural sem forma para zero, em português.
 *
 * Em pt-BR o Intl.PluralRules põe o zero na categoria "one", então uma chave só
 * com `_one` e `_other` escreve "0 achado" e "hoje em 0 execução". Em inglês o
 * zero cai em "other" e sai certo, o que esconde o defeito de quem testa num
 * idioma só. A chave nova sem `_zero` quebra aqui, em vez de sair errada na tela.
 */
const PLURAIS_COM_ZERO = ["pt-BR"];
const semZero = [];
for (const idioma of PLURAIS_COM_ZERO) {
  const dicionario = JSON.parse(readFileSync(new URL(`../locales/${idioma}.json`, import.meta.url), "utf8"));
  const andar = (objeto, caminho) => {
    for (const base of new Set(Object.keys(objeto).filter((k) => k.endsWith("_one")).map((k) => k.slice(0, -4)))) {
      if (!(`${base}_zero` in objeto)) semZero.push(`${idioma}: ${caminho}${base}`);
    }
    for (const [chave, valor] of Object.entries(objeto)) {
      if (valor && typeof valor === "object") andar(valor, `${caminho}${chave}.`);
    }
  };
  andar(dicionario, "");
}

if (semZero.length > 0) {
  console.error(`${semZero.length} plural sem forma para zero:\n`);
  for (const chave of semZero) console.error(`  ${chave}`);
  console.error(
    "\nEm pt-BR o zero cai em \"one\" e sai no singular. Acrescente a chave _zero, em geral igual à _other.",
  );
  process.exit(1);
}

console.log(`check-i18n: nenhum literal solto em ${RAIZES.join(", ")}, e todo plural em pt-BR tem forma para zero.`);
