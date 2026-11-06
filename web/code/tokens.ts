// A code or text file's highlighting as tokens ([class, text]), for the code page (web/code/page.ts) to draw as text
// nodes only (astra, 1a: no file's text ever goes through innerHTML). Python and Sage come from the notebook's own
// highlighter (web/notebook/highlight.js), MATLAB from its own (highlight-matlab.js): their HTML, which has exactly one
// shape (escaped text, and <span class="hX">escaped text</span>), is read back into tokens, and the tokens must join to
// the source exactly or the text is drawn plain. Magma, JavaScript and JSON have a small scanner here; .txt is plain.
// The classes are the notebook's: hc comment, hs string, hn number, hk keyword, hb builtin, hf a name being defined.
import { highlight } from "../notebook/highlight.js";
import { highlightMatlab } from "../notebook/highlight-matlab.js";
import { nameOf, splitExt } from "../workspace/paths";

export type Lang = "python" | "sage" | "matlab" | "magma" | "js" | "json" | "text";
export type Tok = [cls: string, text: string];

/** The files the code page opens, by extension (1a: William, Nov 5, "so users can easily browse these .py (etc) files"). */
export const CODE_LANGS: Record<string, Lang> = { ".py": "python", ".sage": "sage", ".m": "matlab", ".mag": "magma", ".js": "js", ".json": "json", ".txt": "text" };

/** A file's language by its name, or null if the code page doesn't open it. */
export function langOf(path: string): Lang | null {
  return CODE_LANGS[splitExt(nameOf(path))[1].toLowerCase()] ?? null;
}

// (the one shape of the notebook highlighters' HTML: & and < escaped, nothing else)
const SHAPE = /<span class="(h[a-z])">([^<]*)<\/span>|([^<]+)/y;
const unesc = (s: string) => s.replace(/&(lt|amp);/g, (_, e) => (e === "lt" ? "<" : "&"));

/** The tokens of a notebook highlighter's HTML for `src`, or null if it isn't that shape or doesn't give back `src`
 * exactly (then the caller draws `src` plain). The highlighters end with one "\n" of their own, dropped here. */
export function tokensFromHtml(html: string, src: string): Tok[] | null {
  const out: Tok[] = [];
  for (let i = 0; i < html.length; ) {
    SHAPE.lastIndex = i;
    const m = SHAPE.exec(html);
    if (!m) return null;
    out.push(m[1] ? [m[1], unesc(m[2])] : ["", unesc(m[3])]);
    i = SHAPE.lastIndex;
  }
  const last = out.at(-1);
  if (last && last[1].endsWith("\n")) last[1] = last[1].slice(0, -1);
  if (last && last[1] === "") out.pop();
  return out.map((t) => t[1]).join("") === src ? out : null;
}

// ---- a small scanner for Magma, JavaScript and JSON: comments, strings, numbers, keywords
const MAGMA_KW = new Set("and assert by case catch cat declare default delete diff do elif else end error eval exists exit false for forall forward fprintf freeze function if import in intrinsic is join load local meet mod not notadj notin notsubset or print printf procedure quit random read readi repeat require requirege requirerange restore return save sdiff select subset then time to true try until vprint vprintf when where while xor".split(" "));
const JS_KW = new Set("async await break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield".split(" "));
const JSON_KW = new Set(["true", "false", "null"]);
const SCAN: Record<"magma" | "js" | "json", { re: RegExp; kw: Set<string> }> = {
  magma: { re: /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:\\.|[^"\\\n])*"?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g, kw: MAGMA_KW },
  js: { re: /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?)|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)/g, kw: JS_KW },
  json: { re: /(?!)()|("(?:\\.|[^"\\\n])*"?)|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z]+)/g, kw: JSON_KW },
};
function scan(src: string, lang: "magma" | "js" | "json"): Tok[] {
  const { re, kw } = SCAN[lang], out: Tok[] = [];
  let last = 0;
  for (const m of src.matchAll(re)) {
    if (m.index! > last) out.push(["", src.slice(last, m.index)]);
    const cls = m[1] ? "hc" : m[2] ? "hs" : m[3] ? "hn" : m[4] && kw.has(m[4]) ? "hk" : "";
    out.push([cls, m[0]]);
    last = m.index! + m[0].length;
  }
  if (last < src.length) out.push(["", src.slice(last)]);
  return out;
}

/** `src`'s tokens in `lang`: highlighted where the language has a highlighter, else one plain token. Always joins to
 * `src` exactly. */
export function tokensOf(src: string, lang: Lang): Tok[] {
  if (!src) return [];
  let t: Tok[] | null = null;
  if (lang === "python" || lang === "sage") t = tokensFromHtml(highlight(src, lang === "sage"), src);
  else if (lang === "matlab") t = tokensFromHtml(highlightMatlab(src), src);
  else if (lang === "magma" || lang === "js" || lang === "json") t = scan(src, lang);
  return t ?? [["", src]];
}

/** Draw `toks` into `el` as text nodes and <span>s whose text is set as text: nothing is parsed as HTML. */
export function drawTokens(el: HTMLElement, toks: Tok[]): void {
  const doc = el.ownerDocument, frag = doc.createDocumentFragment();
  for (const [cls, text] of toks) {
    if (!cls) { frag.append(doc.createTextNode(text)); continue; }
    const s = doc.createElement("span");
    s.className = cls;
    s.textContent = text;
    frag.append(s);
  }
  el.replaceChildren(frag);
}
