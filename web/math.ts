// Math in Markdown cells: KaTeX, loaded the first time a cell has math.
// Its stylesheet and fonts are served beside this module (dist/katex/), so
// pages elsewhere on the site (web/embed) find them too.
import katex from "katex";

let css: Promise<void> | null = null;
/** KaTeX's stylesheet, added once: resolved once it has loaded (or failed), so math is first shown already styled. */
export function ready(): Promise<void> {
  // (a page that carries the stylesheet itself, an exported board, has #sb-katex)
  css ??= document.getElementById("sb-katex") ? Promise.resolve() : new Promise<void>((done) => {
    const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: new URL("katex/katex.min.css", import.meta.url).href });
    link.onload = link.onerror = () => done();
    document.head.appendChild(link);
  });
  return css;
}
export function typeset(root: Element) {
  void ready();
  for (const el of root.querySelectorAll<HTMLElement>(".math[data-tex]")) {
    try {
      katex.render(el.dataset.tex ?? "", el, { displayMode: el.classList.contains("display"), throwOnError: false, output: "htmlAndMathml" });
    } catch {
      // left as the source text
    }
  }
}
