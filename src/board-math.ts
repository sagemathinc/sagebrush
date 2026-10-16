// Math typeset as SVG for `sagebrush board render` (web/board/svg.ts takes
// it as its `math`): MathJax's TeX input and SVG output, and only those,
// with the TeX packages a board's math uses.  Loaded only when a board to
// render has math (src/board-cli.ts), never by the browser board, which
// typesets with KaTeX.  Each formula is self-contained SVG paths (no fonts,
// no styles), so it looks the same in every viewer.
//
// A board's TeX is untrusted: no package that makes links, styles, classes
// or ids (html, color, unicode, ...) is loaded; MathJax's limits on macro
// expansion and buffer size bound its work; and its output is taken only
// if it has nothing but the elements and attributes below.  Else (and on a
// TeX error) the formula stays as its TeX.

import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import "mathjax-full/js/input/tex/base/BaseConfiguration.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import "mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js";
import "mathjax-full/js/input/tex/noundefined/NoUndefinedConfiguration.js";
import "mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";

/** A formula as SVG: its viewBox and inside, and its width, height and
 * depth (below the baseline) in pixels at the size asked. */
export interface MathSvg { viewBox: string; inner: string; w: number; h: number; d: number }

/** The longest formula typeset (a longer one stays as its TeX). */
export const TEX_MAX = 4000;
// (MathJax's ex for an em: its TeX fonts' x-height)
const EX = 0.431;
const TAGS = new Set(["svg", "g", "path", "rect", "text", "line"]);
const ATTRS = new Set(["xmlns", "xmlns:xlink", "viewBox", "width", "height", "style", "role", "focusable", "d", "transform", "fill", "stroke", "stroke-width", "x", "y", "x1", "y1", "x2", "y2", "font-family", "font-size", "font-style", "font-weight", "aria-hidden"]);

let adaptor: ReturnType<typeof liteAdaptor> | null = null, html: any = null;
function setup() {
  adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const tex = new TeX({ packages: ["base", "ams", "newcommand", "noundefined", "boldsymbol"], maxMacros: 1000, maxBuffer: 5 * 1024 });
  html = mathjax.document("", { InputJax: tex, OutputJax: new SVG({ fontCache: "none" }) });
}

/** TeX (without its $ signs) as SVG at font size `size`, or null (left as its TeX). */
export function texSvg(tex: string, display: boolean, size: number): MathSvg | null {
  if (tex.length > TEX_MAX || !tex.trim()) return null;
  if (!html) setup();
  let s: string;
  try {
    s = adaptor!.innerHTML(html.convert(tex, { display, em: size, ex: size * EX, containerWidth: 80 * size }));
  } catch {
    return null;
  }
  // (a TeX error: its message, not the formula)
  if (/data-mjx-error|data-mml-node="merror"/.test(s)) return null;
  s = s.replace(/\sdata-[\w-]+="[^"]*"/g, "");
  for (const m of s.matchAll(/<\/?([A-Za-z][\w:-]*)/g)) if (!TAGS.has(m[1])) return null;
  for (const m of s.matchAll(/\s([A-Za-z][\w:-]*)="/g)) if (!ATTRS.has(m[1])) return null;
  const root = /^<svg([^>]*)>([\s\S]*)<\/svg>$/.exec(s);
  if (!root || /\sstyle="/.test(root[2])) return null;
  const attr = (k: string) => new RegExp(`\\s${k}="([^"]*)"`).exec(root[1])?.[1];
  const exOf = (v: string | undefined) => (v && /^-?[\d.]+ex$/.test(v) ? parseFloat(v) * size * EX : NaN);
  const w = exOf(attr("width")), h = exOf(attr("height")), va = /vertical-align:\s*(-?[\d.]+ex)/.exec(attr("style") ?? "")?.[1];
  const d = va ? -exOf(va) : 0, viewBox = attr("viewBox");
  if (!(w > 0) || !(h > 0) || !Number.isFinite(d) || !viewBox || !/^[-\d. ]+$/.test(viewBox)) return null;
  return { viewBox, inner: root[2], w, h, d: Math.max(0, d) };
}
