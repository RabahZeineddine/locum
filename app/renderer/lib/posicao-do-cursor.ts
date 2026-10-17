/**
 * Onde o cursor está dentro de um input ou textarea, em pixels a partir do canto
 * do campo. Não há API para isso: um espelho invisível com o mesmo estilo e o
 * texto até o cursor diz onde a próxima letra cairia.
 */

const ESTILOS = [
  "direction", "boxSizing", "width", "overflowX", "overflowY", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize", "lineHeight",
  "fontFamily", "textAlign", "textTransform", "textIndent", "letterSpacing", "wordSpacing", "tabSize",
] as const;

export interface PosicaoDoCursor {
  top: number;
  left: number;
  /** A altura da linha onde o cursor está. */
  altura: number;
}

export function posicaoDoCursor(campo: HTMLInputElement | HTMLTextAreaElement, cursor: number): PosicaoDoCursor {
  const estilo = getComputedStyle(campo);
  const espelho = document.createElement("div");
  for (const nome of ESTILOS) espelho.style[nome] = estilo[nome];
  const area = campo instanceof HTMLTextAreaElement;
  Object.assign(espelho.style, { position: "absolute", visibility: "hidden", top: "0", left: "-9999px", whiteSpace: area ? "pre-wrap" : "pre", overflowWrap: "break-word", height: "auto" });
  espelho.textContent = campo.value.slice(0, cursor);
  const ponto = document.createElement("span");
  ponto.textContent = campo.value.slice(cursor) || ".";
  espelho.append(ponto);
  document.body.append(espelho);
  const altura = Number.parseFloat(estilo.lineHeight) || Number.parseFloat(estilo.fontSize) * 1.3;
  const posicao = {
    top: ponto.offsetTop + Number.parseFloat(estilo.borderTopWidth) - campo.scrollTop,
    left: ponto.offsetLeft + Number.parseFloat(estilo.borderLeftWidth) - campo.scrollLeft,
    altura,
  };
  espelho.remove();
  return posicao;
}

/** A faixa vertical que a pessoa vê de `el`: a interseção da janela com cada ancestral que rola. */
export function faixaVisivel(el: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let pai = el.parentElement; pai !== null; pai = pai.parentElement) {
    if (!/(auto|scroll|overlay)/.test(getComputedStyle(pai).overflowY)) continue;
    const r = pai.getBoundingClientRect();
    top = Math.max(top, r.top);
    bottom = Math.min(bottom, r.bottom);
  }
  return { top, bottom };
}
