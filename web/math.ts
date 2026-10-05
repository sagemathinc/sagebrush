// Math in Markdown cells: KaTeX, loaded the first time a cell has math.
// Its stylesheet and fonts are served from this site (dist/katex/).
import katex from "katex";

let css = false;
export function typeset(root: Element) {
  if (!css) {
    css = true;
    const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: new URL("katex/katex.min.css", location.href).href });
    document.head.appendChild(link);
  }
  for (const el of root.querySelectorAll<HTMLElement>(".math[data-tex]")) {
    try {
      katex.render(el.dataset.tex ?? "", el, { displayMode: el.classList.contains("display"), throwOnError: false, output: "htmlAndMathml" });
    } catch {
      // left as the source text
    }
  }
}
