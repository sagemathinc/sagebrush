// A small, restricted HTML: the formatting Jupyter notebooks use in their
// Markdown (colored spans, bold and underline, tables, images with a width,
// <br>), and the HTML outputs of code, shown without any way to run script.
//
// Not a parser that trusts the browser to agree with it: the fragment is
// read as a sequence of tags and text, and every tag kept is written out
// again from scratch: an allowed name, allowed attributes whose values are
// checked (entities decoded first, so `&#106;avascript:` is seen as what it
// is) and escaped.  Everything else is dropped (a comment, <script> and
// <style> with their contents), or shown as text (a stray `<`).  No id or
// name attribute (DOM clobbering), no class, no event handlers, no
// url() or expression() in a style, no SVG, MathML, forms, frames or
// objects: nothing a browser could be talked into running.

import { PixelBudget, imageSize } from "./image-size";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// tags kept, with the attributes each may have (besides the global ones)
const TAGS: Record<string, string[]> = {
  b: [], strong: [], i: [], em: [], u: [], s: [], strike: [], del: [], ins: [], sub: [], sup: [], small: [], big: [], mark: [],
  code: [], kbd: [], samp: [], var: [], abbr: [], cite: [], q: [], dfn: [], tt: [],
  br: [], hr: [], wbr: [], p: [], div: [], span: [], center: [], blockquote: [], pre: [], address: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  ul: [], ol: ["start", "type", "reversed"], li: ["value"], dl: [], dt: [], dd: [],
  table: ["border", "cellpadding", "cellspacing", "width"], caption: [], thead: [], tbody: [], tfoot: [], tr: ["valign"],
  th: ["colspan", "rowspan", "width", "valign", "scope"], td: ["colspan", "rowspan", "width", "valign"], colgroup: ["span", "width"], col: ["span", "width"],
  font: ["color", "size", "face"], img: ["src", "alt", "width", "height"], a: ["href"], details: ["open"], summary: [],
  figure: [], figcaption: [], section: [], article: [], header: [], footer: [], nav: [], aside: [], main: [],
};
const GLOBAL = ["style", "title", "align", "dir", "lang"];
const VOID = new Set(["br", "hr", "wbr", "img", "col"]);
// (their contents dropped too, not shown as text)
const DROP = new Set(["script", "style", "template", "noscript", "iframe", "object", "embed", "svg", "math", "textarea", "title", "xmp", "noembed", "noframes", "plaintext", "select"]);

// style properties kept (values checked below)
const PROPS = new Set([
  "color", "background-color", "text-align", "vertical-align", "font-weight", "font-style", "font-size", "font-family", "font-variant",
  "text-decoration", "text-decoration-line", "text-decoration-color", "text-transform", "text-indent", "letter-spacing", "word-spacing", "line-height",
  "white-space", "width", "height", "max-width", "max-height", "min-width", "min-height",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border", "border-top", "border-right", "border-bottom", "border-left", "border-color", "border-width", "border-style", "border-collapse", "border-spacing", "border-radius",
  "list-style-type", "display", "float", "clear",
]);
const DISPLAY = new Set(["inline", "block", "inline-block", "none", "table", "table-row", "table-cell", "list-item", "flex", "inline-flex"]);
// a value: words, numbers, units, #hex, commas, parentheses (rgb(), hsl()), spaces, quotes for font names; nothing else
const VALUE = /^[-#.,%()\w\s'"]*$/;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", tab: "\t", newline: "\n", colon: ":" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export interface SafeOptions {
  /** a cell's attachments (`attachment:name` images), name -> {mime: base64} */
  attachments?: Record<string, Record<string, string>> | null;
  /** whether images may come from other sites (https:); false for what code produced, which could otherwise send data away in an image's address */
  remote?: boolean;
}

// whether a link or an image address is harmless (control characters and spaces, which browsers ignore inside a scheme, are taken out first)
const SAFE_LINK = /^(https?:|mailto:|#|\/(?!\/)|\.{1,2}\/|[\w.~-]+(?:[/?#]|$))/i;
// (an SVG in an <img> runs no script: an image element never does)
const DATA_IMG = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml)[;,]/i;
// (a raster data: image within image-size.ts's bounds by its header: a small
// file can say it is huge; else not shown, its alt text instead)
function shownSize(url: string): boolean {
  const m = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]*)$/i.exec(url);
  if (!m) return !/^data:image\/(?:png|jpe?g|gif|webp)/i.test(url);
  const type = "image/" + m[1].toLowerCase().replace("jpg", "jpeg");
  return new PixelBudget(Infinity).take(imageSize(type, m[2])) === null;
}
export function safeLink(href: string): string | null {
  const h = href.replace(/[\u0000- \u007f-\u009f]/g, "");
  return SAFE_LINK.test(h) && !/^[\w.~-]*:/.test(h.replace(/^(https?|mailto):/i, "")) ? h : null;
}
export function safeImage(src: string, o: SafeOptions = {}): string | null {
  const s = src.trim();
  const a = /^attachment:(.+)$/.exec(s);
  if (a) {
    const att = o.attachments?.[a[1]];
    if (!att) return null;
    const [mime, b64] = Object.entries(att)[0] ?? [];
    const url = `data:${mime};base64,${b64}`;
    return DATA_IMG.test(url) && shownSize(url) ? url : null;
  }
  if (DATA_IMG.test(s)) return shownSize(s) ? s : null;
  if (o.remote !== false && /^https?:\/\/[^\s"'<>\\]+$/i.test(s)) return s;
  return null;
}

function safeStyle(css: string): string {
  const out: string[] = [];
  for (const decl of css.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase(), value = decl.slice(i + 1).trim();
    if (!PROPS.has(prop) || !value || !VALUE.test(value) || /url|expression|javascript|image|var\(|attr\(|\\/i.test(value)) continue;
    if (prop === "display" && !DISPLAY.has(value.toLowerCase())) continue;
    out.push(`${prop}: ${value}`);
  }
  return out.join("; ");
}

const SIZE = /^\d+(?:\.\d+)?(?:px|%|em|rem)?$/i;
function attribute(tag: string, name: string, value: string, o: SafeOptions): string | null {
  switch (name) {
    case "style": { const s = safeStyle(value); return s || null; }
    case "href": return tag === "a" ? safeLink(value) : null;
    case "src": return tag === "img" ? safeImage(value, o) : null;
    case "width": case "height": case "border": case "cellpadding": case "cellspacing": return SIZE.test(value.trim()) ? value.trim() : null;
    case "colspan": case "rowspan": case "span": case "start": case "value": case "size": return /^-?\d{1,4}$/.test(value.trim()) ? value.trim() : null;
    case "align": return /^(left|right|center|justify)$/i.test(value.trim()) ? value.trim() : null;
    case "valign": return /^(top|middle|bottom|baseline)$/i.test(value.trim()) ? value.trim() : null;
    case "dir": return /^(ltr|rtl|auto)$/i.test(value.trim()) ? value.trim() : null;
    case "type": return /^[1aAiI]$/.test(value.trim()) ? value.trim() : null;
    case "scope": return /^(row|col|rowgroup|colgroup)$/i.test(value.trim()) ? value.trim() : null;
    case "color": return VALUE.test(value) && !/[()'"]/.test(value) ? value.trim() : null;
    case "face": return /^[-\w\s,'"]+$/.test(value) ? value : null;
    case "reversed": case "open": return "";
    case "title": case "alt": case "lang": return value;
    default: return null;
  }
}

const TAG = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

/** The fragment with only the restricted HTML left (see above). */
export function safeHtml(html: string, o: SafeOptions = {}): string {
  let out = "", last = 0, dropping: string | null = null;
  const text = (s: string) => { if (!dropping) out += s.replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
  for (const m of html.matchAll(TAG)) {
    text(html.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[0].startsWith("<!--")) continue;
    const close = m[1] === "/", name = m[2].toLowerCase();
    if (dropping) {
      if (close && name === dropping) dropping = null;
      continue;
    }
    if (DROP.has(name)) {
      if (!close && !m[4]) dropping = name;
      continue;
    }
    const allowed = TAGS[name];
    if (!allowed) continue;
    if (close) {
      if (!VOID.has(name)) out += `</${name}>`;
      continue;
    }
    let attrs = "";
    const seen = new Set<string>();
    for (const a of (m[3] ?? "").matchAll(ATTR)) {
      const an = a[1].toLowerCase();
      if (seen.has(an) || (!GLOBAL.includes(an) && !allowed.includes(an))) continue;
      seen.add(an);
      const raw = a[2] === undefined ? "" : a[2][0] === '"' || a[2][0] === "'" ? a[2].slice(1, -1) : a[2];
      const v = attribute(name, an, decodeEntities(raw), o);
      if (v === null) continue;
      attrs += v === "" && (an === "reversed" || an === "open") ? ` ${an}` : ` ${an}="${esc(v)}"`;
    }
    // (an outside link opens in another tab, without a handle on this one)
    if (name === "a" && /^https?:/i.test(/ href="([^"]*)"/.exec(attrs)?.[1] ?? "")) attrs += ' target="_blank" rel="noopener noreferrer"';
    if (name === "img" && !/ src="/.test(attrs)) continue;
    out += `<${name}${attrs}>`;
  }
  text(html.slice(last));
  return out;
}
