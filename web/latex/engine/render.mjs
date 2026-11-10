// Demo renderer: the DemoMachine's output events -> HTML chunks (one per top-level block).
// SECURITY (private prototype; the light review reads this file):
//  - every piece of document text reaches the HTML only through esc() (no raw HTML from the document, ever);
//  - math goes through KaTeX with trust:false, a finite maxSize and maxExpand, strict warnings counted and ignored;
//  - link targets: only http:, https: and mailto: URLs (escaped) and our own "#id" anchors;
//  - colors: a fixed name list or numbers from \definecolor (validated); sizes: parsed numbers with fixed units;
//  - images: only names in the caller's allowlist map (opts.images), never a document-supplied URL;
//  - no eval / new Function anywhere.
// KaTeX's renderToString is given by the host (setKatex): on the site, the shared sagebrush-math.js's copy
let renderToString = null;
export function setKatex(f) { renderToString = f; }
import { CAT, isCs, catOf, codeOf, depthOf } from "./demo-machine.mjs";
import { TEXT_SYMBOLS, ACCENTS, SIZES, COLORS } from "./symbols.mjs";
import { itemOf, isCodeEnv, UNSUPPORTED_ENVS, stateOf, savedStates, mathPart, inlineHtml, blockHtml, mathFailHtml, whyRejected, STALE_TITLE, isPy } from "./sagetex.mjs";

// ------------------------------------------------------------------ helpers
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
// eslint-disable-next-line no-control-regex
export const esc = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[&<>"']/g, (c) => ESC[c]);
// (esc's inverse, for HTML made here turned back into text)
const UNESC = Object.fromEntries(Object.entries(ESC).map(([c, e]) => [e, c]));
const unesc = (s) => s.replace(/&(?:amp|lt|gt|quot|#39|#x27|apos);/g, (e) => UNESC[e] ?? e);
const safeUrl = (u) => { const s = String(u).trim(); return /^(https?:\/\/|mailto:)[^\s"'<>\\]*$/i.test(s) && s.length < 2048 ? s : null; };
// (\roman of 0 or less: nothing, as TeX's \romannumeral; past 4999, the number in digits, a bound on the text)
const roman = (n) => { if (n <= 0) return ""; if (n > 4999) return String(n); const v = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]]; let s = ""; for (const [k, r] of v) while (n >= k) { s += r; n -= k; } return s; };
const alph = (n) => (n >= 1 && n <= 26 ? String.fromCharCode(96 + n) : String(n));
const Alph = (n) => alph(n).toUpperCase();
// a TeX dimension -> CSS (fixed units only), or null; rel = the length of 1\textwidth in CSS (a percentage)
const OV_STEPS_MAX = 100;   // (a frame's steps, at most)
// beamer's frames, blocks and overlay commands are engine/beamer.mjs, installed by the host (installBeamer): the worker
// when a render says it needs them (needBeamer: the class beamer, or an overlay command met), and then renders again;
// the CLI and the tests at once. Until then they render as an unknown environment or command would
const BEAMER_CMDS = new Set(["only", "uncover", "visible", "invisible", "pause", "onslide", "alt"]);
let beamer = false;
export function installBeamer(m) { m.install(Renderer.prototype, CMDS, { esc, OV_STEPS_MAX }); beamer = true; }
function cssDim(s) {
  const m = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*(pt|mm|cm|in|em|ex|bp|pc|px|sp|\\textwidth|\\linewidth|\\columnwidth|\\hsize|\\textheight)?/.exec(String(s));
  if (!m) return null;
  let v = parseFloat(m[1]); const u = m[2] || "pt";
  if (!Number.isFinite(v)) return null;
  if (u.startsWith("\\")) { if (u === "\\textheight") return Math.max(-100, Math.min(100, v * 60)).toFixed(2) + "vh"; return Math.max(-100, Math.min(100, v * 100)).toFixed(2) + "%"; }
  const pt = { pt: 1, bp: 1.00375, pc: 12, mm: 2.84528, cm: 28.4528, in: 72.27, px: 0.75, sp: 1 / 65536, em: 10, ex: 4.3 }[u];
  v = Math.max(-2000, Math.min(2000, v * pt));
  return (u === "em" || u === "ex") ? (parseFloat(m[1]).toFixed(3) + u) : v.toFixed(2) + "pt";
}
const dimPt = (s) => { const m = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*(pt|mm|cm|in|em|ex|bp|pc|px)?/.exec(String(s)); if (!m) return null; const k = { pt: 1, bp: 1.00375, pc: 12, mm: 2.84528, cm: 28.4528, in: 72.27, px: 0.75, em: 10, ex: 4.3 }[m[2] || "pt"]; const v = parseFloat(m[1]) * k; return Number.isFinite(v) ? Math.max(-5000, Math.min(5000, v)) : null; };

// ------------------------------------------------------------------ events -> tree
// node: {t:"x",v} token | {t:"g",kids} brace group | {t:"e",env,user,kids} | {t:"s",cmd,star,kids} title/footnote/caption
//       {t:"v",text} \verb | {t:"V",env,text} verbatim | {t:"L",key} | {t:"R",cmd,key,opt} | {t:"doc"} | {t:"cls",cls,opt}
// items: SageTeX S1's code items, numbered here in expansion order (the order they run in)
// (a source position marker, {k:"pos", at}, isn't a node: it goes on the next node as n.p, so arguments read past it)
export function buildTree(events, items = []) {
  const root = { t: "g", kids: [] }; const st = [root];
  let pos = -1, last = -1;   // (last: the latest marker, kept: a code item's source position, it.at)
  const top = () => st[st.length - 1];
  for (const e of events) {
    const before = top().kids.length, at = top();
    if (typeof e === "number") { top().kids.push({ t: "x", v: e }); if (pos >= 0) { at.kids[before].p = pos; pos = -1; } continue; }
    if (e.k === "pos") { pos = last = e.at; continue; }
    switch (e.k) {
      case "o": { const g = { t: "g", kids: [] }; top().kids.push(g); st.push(g); break; }
      case "c": if (st.length > 1 && top().t === "g") st.pop(); break;
      case "be": { const n = { t: "e", env: e.env, user: !!e.user, kids: [] }; top().kids.push(n); st.push(n); break; }
      case "ee": { let i = st.length - 1; while (i > 0 && !(st[i].t === "e" && st[i].env === e.env)) i--; if (i > 0) st.length = i; break; }
      case "sec": { const n = { t: "s", cmd: e.cmd, star: !!e.star, short: e.short, kids: [] }; top().kids.push(n); st.push(n); break; }
      case "eot": { let i = st.length - 1; while (i > 0 && st[i].t !== "s") i--; if (i > 0) st.length = i; break; }
      case "verb": top().kids.push({ t: "v", text: e.text }); break;
      case "ctr": top().kids.push({ t: "C", name: e.name, v: e.v }); break;
      case "verbenv": {
        const v = { t: "V", env: e.env, text: e.text };
        if (isCodeEnv(e.env)) { v.n = items.length; v.it = itemOf(e); v.it.at = last; items.push(v.it); }
        top().kids.push(v); break;
      }
      case "sage": { const it = itemOf(e); it.at = last; top().kids.push({ t: "S", n: items.length, it }); items.push(it); break; }
      case "sageunsup": top().kids.push({ t: "U", name: e.name, msg: e.msg }); break;
      // (PythonTeX: a stale result read back begins (on) or ends; what is drawn in between is faded, R3-4)
      case "z": top().kids.push({ t: "Z", on: e.on }); break;
      case "label": top().kids.push({ t: "L", key: e.key }); break;
      case "ref": top().kids.push({ t: "R", cmd: e.cmd, key: e.key, opt: e.opt }); break;
      case "doc": st.length = 1; root.kids.push({ t: "doc" }); break;
      case "cls": top().kids.push({ t: "cls", cls: e.cls, opt: e.opt }); break;
      case "err": top().kids.push({ t: "err", code: e.code, name: e.name, text: e.text }); break;
      default: break;
    }
    if (pos >= 0 && at.kids.length > before) { at.kids[before].p = pos; pos = -1; }
  }
  return root.kids;
}

// ------------------------------------------------------------------ the flow (paragraphs and blocks)
const styleKey = (s) => (s.f || "") + (s.b ? "b" : "") + (s.i ? "i" : "") + (s.sl ? "l" : "") + (s.sc ? "c" : "") + (s.u ? "u" : "") + (s.st ? "s" : "") + "|" + (s.size || "") + "|" + (s.color || "");
function styleOpen(s) {
  const cls = [];
  if (s.f === "tt") cls.push("tt"); else if (s.f === "sf") cls.push("sf");
  if (s.b) cls.push("b"); if (s.i) cls.push("it"); if (s.sl) cls.push("sl"); if (s.sc) cls.push("sc"); if (s.u) cls.push("ul"); if (s.st) cls.push("so");
  if (s.size) cls.push(s.size);
  if (!cls.length && !s.color) return null;
  return "<span" + (cls.length ? ' class="' + cls.join(" ") + '"' : "") + (s.color ? ' style="color:' + s.color + '"' : "") + ">";
}
function typo(s) {   // TeX's ligatures for text (not typewriter)
  return s.replace(/!`/g, "¡").replace(/\?`/g, "¿").replace(/---/g, "—").replace(/--/g, "–").replace(/``/g, "“").replace(/''/g, "”")
    .replace(/`/g, "‘").replace(/'/g, "’");
}
function serializeRuns(runs) {
  let out = "", i = 0;
  while (i < runs.length) {
    const k = runs[i].k, tt = !!runs[i].tt; let body = "", txt = "", j = i;
    for (; j < runs.length && runs[j].k === k; j++) {
      const r = runs[j];
      if (r.raw) { if (txt) { body += esc(tt ? txt : typo(txt)); txt = ""; } body += r.s; } else txt += r.s;
    }
    if (txt) body += esc(tt ? txt : typo(txt));
    const o = styleOpen(runs[i].st);
    out += o ? o + body + "</span>" : body;
    i = j;
  }
  return out;
}
// (a reader of the preview is told a page ends there (board's A1); it shows as a line (style.ts))
export const NEWPAGE = '<div class="newpage" role="separator" aria-label="Page break"></div>';
// (PythonTeX R3-4: what is drawn inside a stale result read back is faded, by the results pass's chunk
//  (engine/pythontex.mjs, installStale): {on(on), s(style), b(block html)}; nothing without it)
let Z = null;
export const installStale = (z) => { Z = z; };
const zst = (st) => (Z ? Z.s(st) : st);
class Flow {
  // (pos: the source offset of the latest node walked; rootPos[k]: the offset where top-level item k began, or -1)
  constructor(inline = false) { this.inline = inline; this.root = { items: [] }; this.stack = [this.root]; this.runs = null; this.noindent = false; this.pcls = ""; this.pos = -1; this.parPos = -1; this.rootPos = []; }
  atRoot(p) { if (this.cur() === this.root) this.rootPos[this.root.items.length - 1] = p; }
  cur() { return this.stack[this.stack.length - 1]; }
  ensure(st) { if (!this.runs) { this.runs = []; this.pni = this.noindent; this.noindent = false; this.afterDisplay = false; this.pal = st ? st.al || "" : ""; this.parPos = this.pos; } }
  text(s, st) { if (!s) return; st = zst(st); this.ensure(st); this.runs.push({ s, st, k: styleKey(st), tt: st.f === "tt", raw: false }); }
  space(st) {
    if (!this.runs || !this.runs.length) return;
    st = zst(st);
    const last = this.runs[this.runs.length - 1];
    if (!last.raw && (last.s.endsWith(" ") || last.s.endsWith(" "))) return;
    this.runs.push({ s: " ", st, k: styleKey(st), tt: st.f === "tt", raw: false });
  }
  html(h, st) { st = zst(st); this.ensure(st); this.runs.push({ s: h, st, k: styleKey(st), raw: true }); }
  par() {
    if (!this.runs) return;
    const runs = this.runs; this.runs = null;
    while (runs.length && !runs[runs.length - 1].raw && runs[runs.length - 1].s === " ") runs.pop();
    const h = serializeRuns(runs);
    // (a \pagebreak met in this paragraph: the page breaks after it (TeX: after that line))
    const pg = this.pgAfter; this.pgAfter = false;
    if (!h.trim()) { if (pg) this.pageBreak(); return; }
    if (this.inline) { const it = this.cur().items; if (it.length) it.push(" "); it.push(h); return; }
    const cls = [this.pni ? "ni" : "", this.pal ? "al-" + this.pal : ""].filter(Boolean).join(" ");
    this.cur().items.push('<div class="p' + (cls ? " " + cls : "") + '">' + h + "</div>");
    this.atRoot(this.parPos);
    if (pg) this.pageBreak();
  }
  // (a page break: none on an empty page (TeX's \newpage there does nothing: two in a row, or one before anything, make
  //  no blank page), nor after everything (finish))
  pageBreak() {
    this.par();
    const it = this.cur().items;
    if (it[it.length - 1] === NEWPAGE || (this.cur() === this.root && !it.length)) return;
    it.push(NEWPAGE); this.atRoot(this.pos);
  }
  block(h) { this.par(); this.cur().items.push(Z ? Z.b(h) : h); this.atRoot(this.pos); }
  open(tag, attrs = "", head = "") { this.par(); const b = { tag, attrs, head, tail: "", items: [], pos: this.pos }; this.stack.push(b); return b; }
  close(b) {
    this.par();
    if (!this.stack.includes(b)) return;
    while (this.stack.length > 1) {
      const x = this.stack.pop();
      this.cur().items.push("<" + x.tag + x.attrs + ">" + x.head + x.items.join("") + x.tail + "</" + x.tag + ">");
      this.atRoot(x.pos ?? -1);
      if (x === b) break;
    }
  }
  finish() {
    this.par(); while (this.stack.length > 1) this.close(this.cur());
    if (this.root.items[this.root.items.length - 1] === NEWPAGE) { this.root.items.pop(); this.rootPos.length = this.root.items.length; }
    return this.root.items;
  }
  inlineHtml() { return this.finish().join(""); }
}

// ------------------------------------------------------------------ KaTeX
const KCACHE = new Map();
function texMath(src, display, macros, macroSig, stats) {
  const key = (display ? "D" : "I") + macroSig + "\u0000" + src;
  const hit = KCACHE.get(key);
  if (hit !== undefined) { if (hit.includes("katex-error")) { stats.katexErrors++; if (stats.katexErrorSamples.length < 5) stats.katexErrorSamples.push(src.slice(0, 120)); } return hit; }
  let html;
  try {
    html = renderToString(src, { displayMode: display, throwOnError: false, trust: false, maxSize: 20, maxExpand: 1000,
      strict: () => { stats.katexWarnings++; return "ignore"; }, macros: Object.assign({}, macros), output: "htmlAndMathml" });
  } catch (e) { html = '<span class="katex-error">' + esc(String(e && e.message || e).slice(0, 200)) + "</span>"; }
  if (html.includes("katex-error")) { stats.katexErrors++; if (stats.katexErrorSamples.length < 5) stats.katexErrorSamples.push(src.slice(0, 120)); }
  if (KCACHE.size > 20000) KCACHE.clear();
  KCACHE.set(key, html);
  return html;
}

// ------------------------------------------------------------------ the renderer
const SPACING_ACCENTS = { "~": "~", "^": "^", "'": "´", "`": "`", "\"": "¨", "=": "¯", ".": "˙", u: "˘", v: "ˇ", H: "˝", c: "¸", r: "˚" };
const KATEX_ENVS = new Set(["array", "darray", "matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "smallmatrix", "subarray", "cases", "dcases", "rcases", "drcases",
  "aligned", "alignedat", "gathered", "split", "CD", "equation", "equation*", "align", "align*", "gather", "gather*", "alignat", "alignat*"]);
const MATH_ENVS = new Set(["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "eqnarray", "eqnarray*",
  "displaymath", "flalign", "flalign*", "alignat", "alignat*", "math"]);
const LIST_ENVS = new Set(["itemize", "enumerate", "description", "list", "compactitem", "compactenum", "inparaenum", "asparaenum"]);
// (a counter stepped as TeX's \advance by 1 does it, on a 32-bit register: 2147483647 steps to -2147483648)
const step = (v) => (v + 1) | 0;
const SEC_LEVEL = { part: -1, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5 };
const NOOP = new Set(["relax", "protect", "makeatletter", "makeatother", "sloppy", "fussy", "nobreak", "allowbreak", "frenchspacing", "nonfrenchspacing",
  "ignorespaces", "leavevmode", "null", "vfill", "vfil", "nopagebreak", "nolinebreak", "indent",
  "makeindex", "makeglossary", "maketitle@", "frontmatter", "mainmatter", "backmatter", "normalsize", "selectfont", "onecolumn", "twocolumn",
  "flushbottom", "raggedbottom", "strut", "unskip", "hss", "hfilneg", "break", "filbreak", "goodbreak", "noindent@", "centerline@", "displaystyle", "textstyle", "boldmath", "unboldmath",
  "thicklines@", "listoffigures", "listoftables", "FloatBarrier", "vss", "smallskipamount", "ifhmode", "fi", "else",
  ]);
// commands whose arguments are consumed silently: name -> [optional count, mandatory count]
// (saved boxes: their copies, all \usebox's together, at most BOX_MAX: each copy's HTML characters, and BOX_KEY for each
//  of its SageTeX items, which a box with no HTML still copies (astra, BOX653-EXPAND-1's residual))
// (a \nameref's title as text: at most NAME_MAX characters each, NAME_TOTAL for all the \nameref's of a document
//  together, and titles naming titles at most NAME_DEPTH deep (astra, REF682-EXPAND-1))
export const NAME_MAX = 4096, NAME_TOTAL = 1 << 20, NAME_DEPTH = 64;
export const BOX_MAX = 1 << 20, BOX_KEY = 16;
export const boxCost = (b) => b.h.length + BOX_KEY * b.keys.length;
export const fitsBoxes = (used, add) => used + add <= BOX_MAX;
// (cleveref's names, singular and plural, and \Cref's for its abbreviated ones)
const CREF = { section: ["section", "sections"], subsection: ["section", "sections"], subsubsection: ["section", "sections"], chapter: ["chapter", "chapters"],
  equation: ["eq.", "eqs."], figure: ["fig.", "figs."], table: ["table", "tables"], item: ["item", "items"], footnote: ["footnote", "footnotes"] };
const CREF_CAP = { "eq.": "Equation", "eqs.": "Equations", "fig.": "Figure", "figs.": "Figures" };
const GOBBLE = { index: [0, 1], glossary: [0, 1], addcontentsline: [0, 3], markboth: [0, 2], markright: [0, 1], pagestyle: [0, 1], thispagestyle: [0, 1],
  pagenumbering: [0, 1], hypersetup: [0, 1], lstset: [0, 1], bibliographystyle: [0, 1], nocite: [0, 1], addtolength: [0, 2], settowidth: [0, 2],
  settoheight: [0, 2], settodepth: [0, 2], newlength: [0, 1], hyphenation: [0, 1], graphicspath: [0, 1], DeclareGraphicsExtensions: [0, 1],
  DeclareGraphicsRule: [0, 4], lstdefinelanguage: [1, 1], lstdefinestyle: [0, 2], geometry: [0, 1], usetikzlibrary: [0, 1], tikzset: [0, 1], pgfplotsset: [0, 1],
  sisetup: [0, 1], captionsetup: [1, 1], setlist: [1, 1], newgeometry: [0, 1], titleformat: [1, 5], titlespacing: [0, 4], fancyhead: [1, 1], fancyfoot: [1, 1],
  fancyhf: [0, 1], linespread: [0, 1], setstretch: [0, 1], enlargethispage: [0, 1], includeonly: [0, 1], newsavebox: [0, 1], allowdisplaybreaks: [1, 0], restylefloat: [0, 1],
  floatstyle: [0, 1], newfloat: [1, 3], floatname: [0, 2], DeclareUnicodeCharacter: [0, 2], colorlet: [0, 2], pdfbookmark: [1, 2],
  bookmark: [1, 1], urlstyle: [0, 1], newtheoremstyle: [0, 9], crefname: [0, 3], Crefname: [0, 3], includepdf: [1, 1], printbibliography: [1, 0], addbibresource: [1, 1],
  usetheme: [1, 1], usecolortheme: [1, 1], usefonttheme: [1, 1], useinnertheme: [1, 1], useoutertheme: [1, 1], setbeamertemplate: [0, 2],
  setbeamercolor: [0, 2], setbeamerfont: [0, 2], setbeamersize: [0, 1], setbeamercovered: [0, 1], titlegraphic: [0, 1], logo: [0, 1],
  AtBeginSection: [1, 1], AtBeginSubsection: [1, 1], beamertemplatenavigationsymbolsempty: [0, 0] };

class Renderer {
  constructor(opts) {
    this.opts = opts || {};
    this.images = this.opts.images || {}; this.imageRefs = new Set(); this.inputMisses = [];
    this.cls = "article"; this.book = false; this.clsOpt = "";
    // (frames: a beamer document's frames, in order {n, title, at}; problems: what the preview can't show or found wrong,
    //  each {kind, name, at} with at the source offset of the nearest node before it, or -1: `sagebrush latex check`)
    this.frameList = []; this.problems = []; this.lastPos = -1; this.ov = null;
    this.ctr = { part: 0, chapter: 0, section: 0, subsection: 0, subsubsection: 0, paragraph: 0, subparagraph: 0, equation: 0, figure: 0, table: 0, footnote: 0 };
    this.appendix = false;
    this.thmCtr = {}; this.thms = {}; this.thmStyle = "plain"; this.eqWithin = null;
    this.labels = new Map(); this.target = { text: "", id: "", kind: "" };
    this.refs = []; this.toc = []; this.fnotes = []; this.bib = new Map(); this.bibN = 0;
    this.meta = { title: null, author: null, date: null, thanks: [] };
    // (the SageTeX items in each title field, shown where \\maketitle or \\titlepage prints it: run, sageField)
    this.metaSage = { title: [], author: [], date: [], institute: [], thanks: [] }; this.sageField = null;
    this.macros = { "\\varheartsuit": "\\heartsuit", "\\vardiamondsuit": "\\diamondsuit" }; this.macroSig = ""; this.colors = {};
    this.boxes = new Map(); this.boxUsed = 0;   // (saved boxes: \sbox, \savebox, lrbox; shown by \usebox, BOX_MAX for the copies)
    this.unknown = new Map(); this.stats = { katexErrors: 0, katexErrorSamples: [], katexWarnings: 0, unknownCommands: 0 };
    this.idn = 0; this.lists = []; this.unitlength = 1; // pt
    this.secnumdepth = 3;
  }
  nid(p) { return p + "-" + (++this.idn); }
  setTarget(text, id, kind) { this.target = { text: String(text), id, kind }; }
  // (a label: the current target, and the current label name, \nameref's: the last section's or caption's title)
  label(key) { if (!this.labels.has(key)) this.labels.set(key, Object.assign({ name: this.labelName ?? "" }, this.target)); }
  refPh(n) { this.refs.push(n); return "\u0001R" + (this.refs.length - 1) + "\u0002"; }
  unk(name, flow, st) {
    if (BEAMER_CMDS.has(name)) this.needBeamer = true;
    if (this.inPreamble) return;
    this.stats.unknownCommands++; this.unknown.set(name, (this.unknown.get(name) || 0) + 1);
    this.problem("command", name);
    flow.html('<span class="unk" title="not supported in this prototype">\\' + esc(name) + "</span>", st);
  }

  problem(kind, name) { if (!this.inPreamble && this.problems.length < 500) this.problems.push({ kind, name: String(name), at: this.lastPos }); }

  // ---- argument readers over a sibling list
  isSp(n) { return n && n.t === "x" && !isCs(n.v) && catOf(n.v) === CAT.SPACE; }
  isChar(n, code) { return n && n.t === "x" && !isCs(n.v) && codeOf(n.v) === code && catOf(n.v) !== CAT.SPACE; }
  csName(n) { return n && n.t === "x" && isCs(n.v) ? this.I.name(n.v) : null; }
  arg(nodes, i) {        // -> [kids, newIndex]: the next mandatory argument after position i
    let j = i + 1; while (j < nodes.length && this.isSp(nodes[j])) j++;
    if (j >= nodes.length) return [[], i];
    const n = nodes[j];
    if (n.t === "g") return [n.kids, j];
    return [[n], j];
  }
  // a beamer overlay specification <..> right after i (spaces skipped): its last index, else i (all steps are shown)
  spec(nodes, i) {
    let j = i + 1; while (j < nodes.length && this.isSp(nodes[j])) j++;
    if (!this.isChar(nodes[j], 60)) return i;
    for (let k = j + 1; k < nodes.length && k < j + 40; k++) { if (this.isChar(nodes[k], 62)) return k; if (nodes[k].t !== "x") return i; }
    return i;
  }
  opt(nodes, i) {        // -> [kids|null, newIndex]: a [..] optional argument right after i (spaces skipped)
    let j = i + 1; while (j < nodes.length && this.isSp(nodes[j])) j++;
    if (!this.isChar(nodes[j], 91)) return [null, i];
    const out = []; let d = 0;
    for (let k = j + 1; k < nodes.length; k++) {
      const n = nodes[k];
      if (this.isChar(n, 91)) d++;
      else if (this.isChar(n, 93)) { if (d === 0) return [out, k]; d--; }
      out.push(n);
    }
    return [null, i];
  }
  star(nodes, i) { if (this.isChar(nodes[i + 1], 42)) return [true, i + 1]; return [false, i]; }
  str(nodes) {           // plain text of a node list (for names, urls, dimensions)
    let s = "";
    for (const n of nodes) {
      if (n.t === "x") { if (isCs(n.v)) { const nm = this.I.name(n.v); s += nm.startsWith("\u0001") ? nm.slice(1) : "\\" + nm + (/^[A-Za-z@]+$/.test(nm) ? " " : ""); } else s += String.fromCodePoint(codeOf(n.v)); }
      else if (n.t === "g") s += "{" + this.str(n.kids) + "}";
      else if (n.t === "v") s += n.text;
    }
    return s;
  }
  inline(nodes, ctx) { const f = new Flow(true); this.walk(nodes, Object.assign({}, ctx, { st: Object.assign({}, ctx.st) }), f); return f.inlineHtml(); }

  // ---- math source from nodes (expanded tokens back to TeX for KaTeX)
  mathStr(nodes, row) {
    let s = "";
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      switch (n.t) {
        case "x":
          if (isCs(n.v)) {
            const nm = this.I.name(n.v);
            if (nm.startsWith("\u0001")) { s += nm.slice(1); break; }
            if (nm === "nonumber" || nm === "notag") { if (row) row.nonum = true; break; }
            if (nm === "tag" && row) row.tag = true;
            if (nm === "par") break;
            s += "\\" + nm + (/^[A-Za-z@]+$/.test(nm) ? " " : "");
          } else {
            const c = catOf(n.v), k = codeOf(n.v);
            if (c === CAT.SPACE) s += " "; else if (c === CAT.PARAM) s += "\\#"; else s += String.fromCodePoint(k);
          }
          break;
        case "g": s += "{" + this.mathStr(n.kids, row) + "}"; break;
        case "e": {
          if (KATEX_ENVS.has(n.env)) { s += "\\begin{" + n.env + "}" + this.mathStr(n.kids, row) + "\\end{" + n.env + "}"; break; }
          let kids = n.kids;
          if (n.env === "minipage") { let j = -1; for (let q = 0; q < 3; q++) [, j] = this.opt(kids, j); [, j] = this.arg(kids, j); kids = kids.slice(j + 1); }
          s += "\\text{" + this.mathStr(kids, row).replace(/\\par\b/g, " ") + "}"; break;
        }
        case "s": s += this.mathStr(n.kids, row); break;
        case "v": s += "\\texttt{" + n.text.replace(/[\\{}$&#^_%~]/g, (c) => "\\" + (c === "\\" ? "backslash " : c === "~" ? "textasciitilde " : c === "^" ? "textasciicircum " : c)) + "}"; break;
        case "L": this.label(n.key); break;
        case "R": { const ref = this.resolveRef(n, true); s += "\\text{" + ref.replace(/[\\{}$&#^_%~]/g, "") + "}"; break; }
        case "S": {
          const st = stateOf(this.sageStates, n.n, n.it);
          this.sageSeen(n.n);
          if (st.s === "error" || st.s === "blocked") this.mathFails.push({ st, n: n.n + 1 });
          else if (st.s === "stale" && n.it.mode === "sage") this.mathStale = true;
          s += mathPart(st, n.it); break;
        }
        default: break;
      }
      if (s.length > 200000) break;
    }
    return s;
  }
  math(src, display) {
    const h = texMath(src, display, this.macros, this.macroSig, this.stats);
    if (h.includes("katex-error")) this.problem("math", String(src).slice(0, 120));
    // (a region holding a stale \sage value: the whole of it marked stale, as one value can't be marked inside KaTeX)
    const marked = this.mathStale ? '<span class="sagestale" title="' + esc(STALE_TITLE) + '">' + h + "</span>" : h;
    this.mathStale = false;
    if (!this.mathFails.length) return marked;
    const f = this.mathFails; this.mathFails = [];
    return marked + mathFailHtml(f, esc);
  }

  // ---- the walk
  walk(nodes, ctx, flow) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.p !== undefined) { this.lastPos = n.p; if (!flow.inline) flow.pos = n.p; }
      switch (n.t) {
        case "x": i = this.tok(nodes, i, ctx, flow); break;
        case "g": this.walk(n.kids, Object.assign({}, ctx, { st: Object.assign({}, ctx.st) }), flow); break;
        case "e":
          try { this.env(n, ctx, flow); } catch (err) { this.stats.renderErrors = (this.stats.renderErrors || 0) + 1; flow.block('<div class="placeholder">[could not render this ' + esc(n.env) + " environment: " + esc(String((err && err.message) || err).slice(0, 120)) + "]</div>"); }
          break;
        case "s": this.sec(n, ctx, flow); break;
        case "v": flow.html('<code class="verb">' + esc(n.text) + "</code>", ctx.st); break;
        // (a counter set or added to (\setcounter, \addtocounter): the renderer's own numbering follows it; enumi..enumiv,
        //  the enclosing enumerate of that depth)
        case "C": {
          if (Object.hasOwn(this.ctr, n.name)) this.ctr[n.name] = n.v;
          // (secnumdepth: which levels are numbered, as in LaTeX: 0 none below chapter, 4 and 5 \paragraph and \subparagraph)
          if (n.name === "secnumdepth") this.secnumdepth = n.v;
          const d = { enumi: 1, enumii: 2, enumiii: 3, enumiv: 4 }[n.name], L = d && this.lists.filter((x) => x.kind === "enum")[d - 1];
          if (L) L.n = n.v;
          break;
        }
        case "V":
          if (n.it) { this.sageSeen(n.n); flow.block(blockHtml(stateOf(this.sageStates, n.n, n.it), n.it, esc, n.n + 1)); break; }
          if (UNSUPPORTED_ENVS.has(n.env)) { flow.block('<pre class="verbatim code">' + esc(n.text) + '</pre><div class="sagestate"><span class="sagechip s-notrun">' + esc(n.env) + " is not supported in this preview: not run</span></div>"); break; }
          if (n.env !== "comment" && !n.env.startsWith("filecontents")) flow.block('<pre class="verbatim' + (n.env === "lstlisting" || n.env === "minted" ? " code" : "") + '">' + esc(n.text) + "</pre>"); break;
        case "L": this.label(n.key); break;
        case "R": flow.html(this.refPh(n), ctx.st); break;
        case "S": this.sageSeen(n.n); flow.html(inlineHtml(stateOf(this.sageStates, n.n, n.it), n.it, esc, (l) => this.math(l, false), n.n + 1), ctx.st); break;
        case "U": flow.html('<span class="sagechip s-notrun">' + esc(n.msg ?? "\\" + n.name + " is not supported in this preview: not run") + "</span>", ctx.st); break;
        case "Z": Z?.on(n.on); break;
        case "err":
          // (an \input or \include not read: its name and why, never silent; in the preamble too, listed for the page's note)
          if (n.code === "input") {
            if (this.problems.length < 500) this.problems.push({ kind: "input", name: String(n.name), at: this.lastPos, why: String(n.text || "") });
            if (this.inPreamble) { if (this.inputMisses.length < 50) this.inputMisses.push({ name: String(n.name), why: String(n.text || "") }); }
            else flow.html('<span class="unk errchip" title="\\input or \\include: the file is not in the preview">[input: ' + esc(n.name) + ": " + esc(n.text || "not found") + "]</span>", ctx.st);
            break;
          }
          // (a half-typed argument: what was read, then a note; LaTeX would say "Paragraph ended before \x was complete")
          this.problem(n.code === "runaway" ? "runaway" : "redefined", n.name);
          if (n.code === "runaway") { const tx = String(n.text || "").replace(/\s+$/, ""); flow.html('<span class="unk errchip" title="LaTeX: Paragraph ended before \\' + esc(n.name) + ' was complete">\\' + esc(n.name) + esc(tx.length > 40 ? tx.slice(0, 40) + "…" : tx) + " not finished</span>", ctx.st); break; }
          flow.html('<span class="unk errchip" title="LaTeX would stop here">\\newcommand: \\' + esc(n.name) + " is already defined</span>", ctx.st); break;
        case "cls": this.cls = n.cls; this.clsOpt = typeof n.opt === "string" ? n.opt : ""; this.book = /^(book|report|memoir|scrbook|scrreprt)$/.test(n.cls); this.secnumdepth = depthOf(n.cls); break;
        default: break;
      }
    }
  }
  // collect math between delimiters at this sibling level; returns [nodes, endIndex]
  until(nodes, i, pred) { const out = []; let j = i + 1; for (; j < nodes.length; j++) { if (pred(nodes[j], j)) return [out, j]; out.push(nodes[j]); } return [out, j - 1]; }
  tok(nodes, i, ctx, flow) {
    const n = nodes[i], st = ctx.st;
    if (!isCs(n.v)) {
      const c = catOf(n.v), k = codeOf(n.v);
      if (c === CAT.SPACE) { flow.space(st); return i; }
      if (c === CAT.MATH) {
        const display = this.isMathTok(nodes[i + 1]);
        if (display) {
          const r = this.mathUntil(nodes, i + 1, (x, jj) => this.isMathTok(x) && this.isMathTok(nodes[jj + 1]));
          if (!r.closed) { this.unclosedMath("$$", r.m, true, flow, ctx); return r.j; }
          this.displayMath(this.mathStr(r.m), flow, ctx);
          return Math.min(nodes.length - 1, r.j + 1);
        }
        const r = this.mathUntil(nodes, i, (x) => this.isMathTok(x));
        if (!r.closed) { this.unclosedMath("$", r.m, false, flow, ctx); return r.j; }
        flow.html(this.math(this.mathStr(r.m), false), st);
        return r.j;
      }
      flow.text(String.fromCodePoint(k), st);
      return i;
    }
    const name = this.I.name(n.v);
    if (name.startsWith("\u0001")) { flow.text(name === "\u0001~" ? " " : name.slice(1), st); return i; }
    if (name === "par") { if (!flow.runs && flow.afterDisplay) flow.noindent = false; flow.afterDisplay = false; flow.par(); return i; }
    if (name === "[") { const r = this.mathUntil(nodes, i, (x) => this.csName(x) === "]"); if (!r.closed) this.unclosedMath("\\[", r.m, true, flow, ctx); else this.displayMath(this.mathStr(r.m), flow, ctx); return r.j; }
    if (name === "(") { const r = this.mathUntil(nodes, i, (x) => this.csName(x) === ")"); if (!r.closed) this.unclosedMath("\\(", r.m, false, flow, ctx); else flow.html(this.math(this.mathStr(r.m), false), st); return r.j; }
    if (Object.hasOwn(CMDS, name)) return CMDS[name].call(this, nodes, i, ctx, flow);
    if (Object.hasOwn(SIZES, name)) { st.size = SIZES[name]; return i; }
    if (Object.hasOwn(TEXT_SYMBOLS, name)) { flow.text(TEXT_SYMBOLS[name], st); return i; }
    if (Object.hasOwn(ACCENTS, name)) {
      const [a, j] = this.arg(nodes, i);
      let base = this.str(a).replace(/^\{|\}$/g, "");
      if (base === "\\i " || base === "\\i") base = "ı"; if (base === "\\j " || base === "\\j") base = "ȷ";
      if (!base) { flow.text(Object.hasOwn(SPACING_ACCENTS, name) ? SPACING_ACCENTS[name] : "", st); return j; }
      flow.text((base + ACCENTS[name]).normalize("NFC"), st); return j;
    }
    if (NOOP.has(name)) return i;
    if (Object.hasOwn(GOBBLE, name)) { let j = i; const [no, nm] = GOBBLE[name]; [, j] = this.star(nodes, j); for (let k = 0; k < no; k++) [, j] = this.opt(nodes, j); for (let k = 0; k < nm; k++) [, j] = this.arg(nodes, j); return j; }
    if (Object.hasOwn(this.macros, "\\" + name)) { flow.html(this.math(this.mathStr([n]), false), st); return i; }
    this.unk(name, flow, st);
    return i;
  }
  isMathTok(n) { return n && n.t === "x" && !isCs(n.v) && catOf(n.v) === CAT.MATH; }
  // math between delimiters at this sibling level, as TeX reads it: it can't go past a \par (a blank line) or the end
  // of the list; then it is unclosed ({closed: false}, j the node before the \par, which the walk then takes)
  mathUntil(nodes, i, pred) {
    const m = [];
    for (let j = i + 1; j < nodes.length; j++) {
      if (pred(nodes[j], j)) return { m, j, closed: true };
      if (this.csName(nodes[j]) === "par") return { m, j: j - 1, closed: false };
      m.push(nodes[j]);
    }
    return { m, j: nodes.length - 1, closed: false };
  }
  // an unclosed formula (being typed, say): what there is of it, and a note; the rest of the document renders as text
  unclosedMath(open, m, display, flow, ctx) {
    this.stats.unclosedMath = (this.stats.unclosedMath || 0) + 1;
    const src = this.mathStr(m);
    const h = (src.trim() ? this.math(src, display) : "") + '<span class="mathopen" title="Math can\'t continue past a blank line or the end of a group">' + esc(open) + " not closed</span>";
    if (!display) { flow.html(h, ctx.st); return; }
    flow.par();
    flow.block('<div class="dmath">' + h + "</div>");
    flow.noindent = true; flow.afterDisplay = true;
  }
  displayMath(src, flow, ctx, num) {
    flow.par();
    const tag = num ? "\\tag{" + num + "}" : "";
    flow.block('<div class="dmath"' + (this.target.id && num ? ' id="' + this.target.id + '"' : "") + ">" + this.math(src + tag, true) + "</div>");
    flow.noindent = true; flow.afterDisplay = true;
    void ctx;
  }
  eqNumber() {
    this.ctr.equation = step(this.ctr.equation);
    const pre = this.eqWithin === "section" ? this.secNum(1) + "." : this.book ? this.chapNum() + "." : "";
    return pre + this.ctr.equation;
  }
  chapNum() { return this.appendix && this.book ? Alph(this.ctr.chapter) : String(this.ctr.chapter); }
  secNum(level) {
    const top = this.book ? 0 : 1;
    const parts = [];
    for (let l = top; l <= level; l++) {
      const v = this.ctr[["chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"][l]];
      parts.push(l === top && this.appendix ? Alph(v) : String(v));
    }
    return parts.join(".");
  }

  // ---- sectioning, captions, footnotes
  sec(n, ctx, flow) {
    if (n.cmd === "footnote") return this.footnote(n, ctx, flow);
    if (n.cmd === "caption") return this.caption(n, ctx, flow);
    if (n.cmd === "thanks") { const [h, ks] = this.captured(() => this.inline(n.kids, ctx)); this.meta.thanks.push(h); this.metaSage.thanks.push(...ks); flow.html("<sup>*</sup>", ctx.st); return; }
    const level = SEC_LEVEL[n.cmd];
    const names = ["chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"];
    let num = "";
    if (n.cmd === "part") { if (!n.star) { this.ctr.part = step(this.ctr.part); num = roman(this.ctr.part).toUpperCase(); } }
    else if (!n.star) {
      this.ctr[n.cmd] = step(this.ctr[n.cmd]);
      for (let l = level + 1; l < names.length; l++) this.ctr[names[l]] = 0;
      if (n.cmd === "chapter") { this.ctr.equation = 0; this.ctr.figure = 0; this.ctr.table = 0; this.ctr.footnote = 0; }
      if (n.cmd === "section" && this.eqWithin === "section") this.ctr.equation = 0;
      for (const [k, th] of Object.entries(this.thms)) if (th.within === n.cmd) this.thmCtr[k] = 0;
      if ((this.book && level <= this.secnumdepth) || (!this.book && level >= 1 && level <= this.secnumdepth)) num = this.secNum(level);
    }
    if (n.cmd === "chapter" && this.book) this.flushFootnotes(flow);
    const id = this.nid("sec");
    // (only a numbered heading is a label's target: a \label after a starred one, or one past secnumdepth, is the last
    //  numbered one's, as in TeX)
    if (num) this.setTarget(num, id, n.cmd);
    const title = this.inline(n.kids, ctx);
    this.labelName = title;
    // (an unstarred part says "Part" with its numeral, which TeX leaves empty at 0 or less)
    if (n.cmd === "part") flow.block('<h1 class="part" id="' + id + '">' + (!n.star ? '<div class="partnum">Part ' + num + "</div>" : "") + title + "</h1>");
    else if (n.cmd === "chapter") flow.block('<h1 class="chapter" id="' + id + '">' + (num ? '<div class="chapnum">' + (this.appendix ? "Appendix " : "Chapter ") + esc(num) + "</div>" : "") + title + "</h1>");
    else if (level >= 4) { flow.par(); flow.html('<span class="runin" id="' + id + '">' + (num ? esc(num) + " " : "") + title + "</span> ", ctx.st); }
    else flow.block("<h" + (level + 1) + ' id="' + id + '">' + (num ? '<span class="secnum">' + esc(num) + "</span>" : "") + title + "</h" + (level + 1) + ">");
    if (level <= 2 && (num || n.cmd === "chapter" || n.cmd === "part")) this.toc.push({ level, num, title, id });
    flow.noindent = true;
  }
  footnote(n, ctx, flow) {
    // (\footnote[n]: that number, signed, within TeX's limit, the counter not stepped, as in LaTeX; anything else (TeX
    //  would read its leading number and set the rest as text, \footnote[2a] as 2 and a stray "a") the counter, and said)
    const opt = n.short ?? "", num = /^\s*[+-]?\d+\s*$/.test(opt);
    if (!num && opt.trim()) this.problem("footnote", "\\footnote[" + opt.trim().slice(0, 40) + "]: not a number; TeX would read its leading digits and set the rest as text");
    const k = num ? Math.max(-2147483647, Math.min(2147483647, +opt)) : (this.ctr.footnote = step(this.ctr.footnote)), id = this.nid("fn");
    const save = this.target;
    this.setTarget(String(k), id, "footnote");
    const f = new Flow(false);
    this.walk(n.kids, Object.assign({}, ctx, { st: { al: "" } }), f);
    this.fnotes.push({ k, id, html: f.finish().join("") });
    this.target = save;
    flow.html('<sup class="fnref"><a href="#' + id + '">' + k + "</a></sup>", ctx.st);
  }
  flushFootnotes(flow) {
    if (!this.fnotes.length) return;
    flow.block('<div class="footnotes">' + this.fnotes.map((x) => '<div class="fn" id="' + x.id + '"><sup>' + x.k + "</sup> " + x.html.replace(/^<div class="p[^"]*">|<\/div>$/g, "") + "</div>").join("") + "</div>");
    this.fnotes = [];
  }
  caption(n, ctx, flow) {
    const fl = this.floatKind || "figure";
    this.ctr[fl] = step(this.ctr[fl]);
    const num = (this.book ? this.chapNum() + "." : "") + this.ctr[fl];
    const id = this.nid(fl);
    this.setTarget(num, id, fl);
    const text = this.inline(n.kids, ctx);
    this.labelName = text;
    flow.block('<div class="caption" id="' + id + '"><span class="capnum">' + (fl === "table" ? "Table " : "Figure ") + esc(num) + ":</span> " + text + "</div>");
  }

  // ---- environments
  env(n, ctx, flow) {
    const env = n.env;
    const c2 = Object.assign({}, ctx, { st: Object.assign({}, ctx.st) });
    if (MATH_ENVS.has(env)) return this.mathEnv(n, ctx, flow);
    if (LIST_ENVS.has(env)) return this.list(n, c2, flow);
    if (Object.hasOwn(this.thms, env)) return this.theorem(n, c2, flow);
    switch (env) {
      case "center": case "flushleft": case "flushright": {
        c2.st.al = env === "center" ? "c" : env === "flushleft" ? "l" : "r";
        const b = flow.open("div", ' class="' + env + '"'); this.walk(n.kids, c2, flow); flow.close(b); return;
      }
      case "quote": case "quotation": case "verse": { const b = flow.open("blockquote", ' class="' + env + '"'); this.walk(n.kids, c2, flow); flow.close(b); return; }
      case "abstract": { const b = flow.open("div", ' class="abstract"', '<div class="abshead">Abstract</div>'); this.walk(n.kids, c2, flow); flow.close(b); return; }
      case "proof": {
        let kids = n.kids; let head = "Proof";
        const [o, j] = this.opt(kids, -1); if (o) { head = this.inline(o, ctx); kids = kids.slice(j + 1); }
        const b = flow.open("div", ' class="proof"');
        flow.html('<span class="proofhead">' + head + ".</span> ", c2.st);
        this.walk(kids, c2, flow);
        flow.ensure(c2.st);
        flow.html('<span class="qed">∎</span>', c2.st);
        flow.close(b); return;
      }
      case "multicols": case "multicols*": {
        const [a, j] = this.arg(n.kids, -1); const k = Math.max(1, Math.min(6, parseInt(this.str(a), 10) || 2));
        const [o, j2] = this.opt(n.kids, j);
        if (o) this.walk(o, c2, flow);
        const b = flow.open("div", ' class="multicols" style="column-count:' + k + '"'); this.walk(n.kids.slice((o ? j2 : j) + 1), c2, flow); flow.close(b); return;
      }
      // (beamer: columns side by side, each a minipage of its width)
      case "columns": { const b = flow.open("div", ' class="bcols" style="display:flex;gap:1em;align-items:flex-start"'); this.walk(n.kids, c2, flow); flow.close(b); return; }
      case "lrbox": { const [a, j] = this.arg(n.kids, -1); this.saveBox(a, () => this.inline(n.kids.slice(j + 1), c2)); return; }
      case "column":
      case "minipage": {
        let j = -1; let pos = "c"; let o;
        [o, j] = this.opt(n.kids, j); if (o) pos = this.str(o).trim()[0] || "c";
        [o, j] = this.opt(n.kids, j); [o, j] = this.opt(n.kids, j);
        const [w, j2] = this.arg(n.kids, j); const width = cssDim(this.str(w)) || "100%";
        const b = flow.open("div", ' class="minipage va-' + esc(pos) + '" style="width:' + width + '"');
        this.walk(n.kids.slice(j2 + 1), c2, flow); flow.close(b); return;
      }
      case "figure": case "figure*": case "table": case "table*": case "wrapfigure": case "wraptable": {
        let kids = n.kids; let cls = "float";
        if (env.startsWith("wrap")) { const [, j0] = this.opt(kids, -1); const [side, j1] = this.arg(kids, j0); const [w, j2] = this.arg(kids, j1); cls += " wrap-" + (/[lLiI]/.test(this.str(side)) ? "l" : "r"); kids = kids.slice(j2 + 1); c2.wrapW = cssDim(this.str(w)); }
        else { const [, j] = this.opt(kids, -1); kids = kids.slice(j + 1); }
        const save = this.floatKind; this.floatKind = env.startsWith("table") || env === "wraptable" ? "table" : "figure";
        c2.st.al = "c";
        const b = flow.open("div", ' class="' + cls + '"' + (c2.wrapW ? ' style="width:' + c2.wrapW + '"' : ""));
        this.walk(kids, c2, flow); flow.close(b); this.floatKind = save; return;
      }
      case "tabular": case "tabular*": case "tabularx": case "array": case "longtable": return this.tabular(n, c2, flow);
      case "thebibliography": return this.bibliography(n, c2, flow);
      case "picture": return this.picture(n, c2, flow);
      case "titlepage": case "document": case "itshape": case "bfseries": case "small": case "footnotesize": case "large": case "scope": {
        if (env === "itshape") c2.st.i = true; if (env === "bfseries") c2.st.b = true; if (Object.hasOwn(SIZES, env)) c2.st.size = SIZES[env];
        const b = flow.open("div", ' class="env-' + esc(env) + '"'); this.walk(n.kids, c2, flow); flow.close(b); return;
      }
      case "tikzpicture": case "tikzcd": case "axis": case "pspicture": {
        this.problem("not-rendered", env);
        flow.block('<div class="placeholder">[' + esc(env) + ": not rendered in this prototype]</div>"); return;
      }
      // (beamer: its blocks, and each frame a slide; in another class, unknown environments as before)
      case "block": case "alertblock": case "exampleblock":
        if (this.cls === "beamer" && beamer) return this.bblock(n, c2, flow);
      // falls through
      case "frame":
        if (this.cls === "beamer" && beamer && env === "frame") return this.frame(n.kids, c2, flow);
      // falls through
      default:
        if (n.user) { this.walk(n.kids, c2, flow); return; }
        if (!Object.hasOwn(SIZES, env)) { this.unknown.set("env:" + env, (this.unknown.get("env:" + env) || 0) + 1); this.problem("environment", env); }
        else c2.st.size = SIZES[env];
        { const b = flow.open("div", ' class="env-unknown" title="' + esc(env) + '"'); this.walk(n.kids, c2, flow); flow.close(b); }
    }
  }
  // a beamer overlay specification <..> right after i: [its last index, its text normalized (step numbers, "+" and "." resolved
  // with the frame's counter: "2-", "1,3-4", "-3"), or null]; outside a frame, the text as written
  ovSpec(nodes, i) {
    const k = this.spec(nodes, i);
    if (k === i) return [i, null];
    let j = i + 1; while (j < nodes.length && this.isSp(nodes[j])) j++;
    let t = ""; for (let q = j + 1; q < k; q++) if (nodes[q].t === "x" && !isCs(nodes[q].v)) t += String.fromCodePoint(codeOf(nodes[q].v));
    return [k, this.ovNorm(t)];
  }
  ovNorm(t) {
    const ov = this.ov; if (!ov) return null;
    const parts = [];
    for (let p of String(t).replace(/\s+/g, "").replace(/^[a-z]+@/i, "").split(",")) {
      // (+ and . : the frame's counter, + advancing it first; +(d) and .(d) offset it)
      p = p.replace(/([+.])(?:\((-?\d+)\))?/g, (_, c, d) => { if (c === "+") ov.plus++; return String(Math.max(1, Math.max(1, ov.plus) + (d ? +d : 0))); });
      const m = /^(\d*)(-?)(\d*)$/.exec(p);
      if (!m || (!m[1] && !m[3])) continue;
      const a = m[1] ? Math.min(+m[1], OV_STEPS_MAX) : 1, z = m[2] ? (m[3] ? Math.min(+m[3], OV_STEPS_MAX) : null) : a;
      ov.max = Math.max(ov.max, a, z || 0);
      parts.push(m[2] ? a + "-" + (z ?? "") : String(a));
    }
    return parts.length ? parts.join(",") : null;
  }
  mathEnv(n, ctx, flow) {
    const env = n.env, base = env.replace(/\*$/, ""), numbered = !env.endsWith("*") && env !== "displaymath" && env !== "math";
    if (env === "math") { flow.html(this.math(this.mathStr(n.kids), false), ctx.st); return; }
    if (base === "equation" || base === "displaymath" || base === "multline") {
      const row = {};
      const id = this.nid("eq");
      let num = null;
      if (numbered) { num = this.eqNumber(); this.setTarget(num, id, "equation"); }
      let src = this.mathStr(n.kids, row);
      if (base === "multline") src = "\\begin{gathered}" + src + "\\end{gathered}";
      if (row.nonum || row.tag) { if (num) this.ctr.equation--; num = null; }
      flow.par();
      flow.block('<div class="dmath" id="' + id + '">' + this.math(src + (num ? "\\tag{" + num + "}" : ""), true) + "</div>");
      flow.noindent = true; flow.afterDisplay = true;
      return;
    }
    // multi-row: split at top-level \\ ; each numbered row gets \tag
    const rows = [[]];
    for (const k of n.kids) { if (this.csName(k) === "\\") rows.push([]); else rows[rows.length - 1].push(k); }
    const id = this.nid("eq");
    const parts = [];
    for (const r of rows) {
      const row = {};
      let num = null;
      const empty = r.every((x) => this.isSp(x));
      if (numbered && !empty) { num = this.eqNumber(); this.setTarget(num, id, "equation"); }
      let src = this.mathStr(r, row);
      if (base === "eqnarray") src = src.replace(/&/, "&").replace(/&([^&]*)&/, "&$1");
      if (row.nonum || row.tag) { if (num) this.ctr.equation--; num = null; }
      parts.push(src + (num ? "\\tag{" + num + "}" : ""));
    }
    const envName = base === "gather" ? "gather*" : base === "alignat" ? "align*" : base === "flalign" ? "align*" : "align*";
    let body = parts.join("\\\\");
    if (base === "alignat") body = body.replace(/^\s*\{[^}]*\}/, "");
    flow.par();
    flow.block('<div class="dmath" id="' + id + '">' + this.math("\\begin{" + envName + "}" + body + "\\end{" + envName + "}", true) + "</div>");
    flow.noindent = true; flow.afterDisplay = true;
  }
  list(n, ctx, flow) {
    const env = n.env;
    const kind = env === "description" ? "desc" : /enum/.test(env) ? "enum" : "item";
    const depth = this.lists.filter((x) => x.kind === kind).length + 1;
    const L = { kind, depth, n: 0, li: null };
    this.lists.push(L);
    const b = flow.open(kind === "enum" ? "ol" : "ul", ' class="list ' + kind + " d" + Math.min(depth, 4) + '"');
    const kids = n.kids;
    let i = 0;
    // anything before the first \item renders as plain content
    const walkUntilItem = (from) => { let j = from; for (; j < kids.length; j++) if (this.csName(kids[j]) === "item") break; return j; };
    const first = walkUntilItem(0);
    // (beamer: itemize[<+->] gives every item that spec, an item's own <..> instead)
    let lead = kids.slice(0, first), dflt = null;
    if (this.ov) { const [o, oj] = this.opt(lead, -1); if (o && this.isChar(o[0], 60)) { dflt = this.str(o).trim().replace(/^<|>$/g, ""); lead = lead.slice(oj + 1); } }
    this.walk(lead, ctx, flow);
    i = first;
    while (i < kids.length) {
      // \item[label] (and beamer's \item<2->[label])
      const [si, ispec] = this.ovSpec(kids, i);
      const spec = ispec ?? (dflt !== null ? this.ovNorm(dflt) : null);
      const [o, j] = this.opt(kids, si);
      if (L.li) flow.close(L.li);
      let lbl;
      if (o) lbl = this.inline(o, ctx);
      else if (kind === "enum") {
        L.n = step(L.n);
        const nums = this.lists.filter((x) => x.kind === "enum").map((x) => x.n);
        const d = depth;
        lbl = d === 1 ? nums[0] + "." : d === 2 ? "(" + alph(nums[1]) + ")" : d === 3 ? roman(nums[2]) + "." : Alph(nums[3]) + ".";
        const ref = nums[0] + (d >= 2 ? (d === 2 ? alph(nums[1]) : "(" + alph(nums[1]) + ")") : "") + (d >= 3 ? roman(nums[2]) : "") + (d >= 4 ? Alph(nums[3]) : "");
        lbl = esc(lbl);
        this.setTarget(ref, "", "item");
      } else if (kind === "item") lbl = ["•", "–", "∗", "·"][Math.min(depth, 4) - 1];
      else lbl = "";
      const id = this.nid("it"); if (kind === "enum" && !o) this.target.id = id;
      L.li = flow.open("li", ' id="' + id + '"' + (spec ? ' class="ov" data-ov="' + esc(spec) + '" data-ovm="uncover"' : ""), kind === "desc" ? (lbl ? '<span class="dlabel">' + lbl + "</span> " : "") : '<span class="lbl">' + lbl + "</span>");
      const next = walkUntilItem(j + 1);
      this.walk(kids.slice(j + 1, next), ctx, flow);
      i = next;
    }
    if (L.li) flow.close(L.li);
    flow.close(b);
    this.lists.pop();
  }
  theorem(n, ctx, flow) {
    const th = this.thms[n.env];
    let kids = n.kids; let note = "";
    const [o, j] = this.opt(kids, -1); if (o) { note = " (" + this.inline(o, ctx) + ")"; kids = kids.slice(j + 1); }
    let num = "";
    if (!th.star) {
      const key = th.shared || n.env;
      const t2 = this.thms[key] || th;
      this.thmCtr[key] = (this.thmCtr[key] || 0) + 1;
      const w = t2.within;
      num = (w ? (w === "chapter" ? this.chapNum() : this.secNum(SEC_LEVEL[w] ?? 1)) + "." : "") + this.thmCtr[key];
    }
    const id = this.nid("thm");
    this.setTarget(num, id, n.env);
    const c2 = Object.assign({}, ctx, { st: Object.assign({}, ctx.st, { i: th.style === "plain" ? true : ctx.st.i }) });
    const b = flow.open("div", ' class="thm thm-' + th.style + '" id="' + id + '"');
    flow.html('<span class="thmhead">' + esc(th.title) + (num ? " " + esc(num) : "") + "</span>" + note + (th.style === "remark" ? ". " : '<span class="thmhead">.</span> '), Object.assign({}, c2.st, { i: false }));
    this.walk(kids, c2, flow);
    flow.close(b);
  }
  tabular(n, ctx, flow) {
    let kids = n.kids; let j = -1;
    if (n.env === "tabular*" || n.env === "tabularx") { [, j] = this.arg(kids, j); }
    let o; [o, j] = this.opt(kids, j); void o;
    const [specN, j2] = this.arg(kids, j);
    kids = kids.slice(j2 + 1);
    // column spec
    const spec = this.str(specN); const cols = []; let borderL = false;
    for (let s = spec.replace(/\*\{(\d+)\}\{([^{}]*)\}/g, (_, k, x) => x.repeat(Math.min(50, +k))), p = 0; p < s.length; p++) {
      const ch = s[p];
      if (ch === "|") { if (cols.length) cols[cols.length - 1].br = true; else borderL = true; continue; }
      if ("lcrX".includes(ch)) { cols.push({ al: ch === "X" ? "l" : ch }); continue; }
      if ("pmb".includes(ch) && s[p + 1] === "{") { let d = 0, q = p + 1; for (; q < s.length; q++) { if (s[q] === "{") d++; else if (s[q] === "}" && --d === 0) break; } cols.push({ al: "l", w: cssDim(s.slice(p + 2, q)) }); p = q; continue; }
      if ((ch === "@" || ch === ">" || ch === "<" || ch === "!") && s[p + 1] === "{") { let d = 0, q = p + 1; for (; q < s.length; q++) { if (s[q] === "{") d++; else if (s[q] === "}" && --d === 0) break; } p = q; continue; }
    }
    if (n.env === "array") return this.arrayEnv(n, ctx, flow);
    const rows = [{ cells: [[]], top: false }];
    for (let k = 0; k < kids.length; k++) {
      const x = kids[k];
      if (x.t === "x" && !isCs(x.v) && catOf(x.v) === CAT.ALIGN) { rows[rows.length - 1].cells.push([]); continue; }
      const nm = this.csName(x);
      if (nm === "\\" || nm === "tabularnewline") { const [, k2] = this.opt(kids, k); k = k2; rows.push({ cells: [[]], top: false }); continue; }
      if (nm === "hline" || nm === "toprule" || nm === "midrule" || nm === "bottomrule") { const r = rows[rows.length - 1]; if (r.cells.length === 1 && r.cells[0].every((y) => this.isSp(y))) r.top = true; else r.bottom = true; continue; }
      if (nm === "cline" || nm === "cmidrule") { const [, k2] = this.arg(kids, k); k = k2; continue; }
      rows[rows.length - 1].cells[rows[rows.length - 1].cells.length - 1].push(x);
    }
    if (rows.length && rows[rows.length - 1].cells.length === 1 && rows[rows.length - 1].cells[0].every((y) => this.isSp(y))) {
      const last = rows.pop(); if (last.top && rows.length) rows[rows.length - 1].bottom = true;
    }
    let h = '<table class="tabular' + (borderL ? " bl" : "") + '"><tbody>';
    for (const r of rows) {
      h += "<tr" + (r.top ? ' class="ht"' : "") + (r.bottom ? ' style="border-bottom:1px solid currentColor"' : "") + ">";
      let ci = 0;
      for (const cell of r.cells) {
        let span = 1, al = (cols[ci] || {}).al || "l", content = cell;
        // \multicolumn{n}{spec}{text}
        const first = cell.findIndex((y) => !this.isSp(y));
        if (first >= 0 && this.csName(cell[first]) === "multicolumn") {
          const [a1, q1] = this.arg(cell, first); const [a2, q2] = this.arg(cell, q1); const [a3] = this.arg(cell, q2);
          span = Math.max(1, Math.min(50, parseInt(this.str(a1), 10) || 1)); const sp = this.str(a2); al = /c/.test(sp) ? "c" : /r/.test(sp) ? "r" : "l"; content = a3;
        }
        const col = cols[ci] || {};
        const style = (col.w ? "width:" + col.w + ";" : "") + (col.br ? "border-right:1px solid currentColor;" : "");
        h += "<td" + (span > 1 ? ' colspan="' + span + '"' : "") + ' class="al-' + al + '"' + (style ? ' style="' + style + '"' : "") + ">" + this.inline(content, ctx) + "</td>";
        ci += span;
      }
      h += "</tr>";
    }
    h += "</tbody></table>";
    flow.html(h, ctx.st);
  }
  arrayEnv(n, ctx, flow) { flow.html(this.math("\\begin{array}" + this.mathStr(n.kids) + "\\end{array}", false), ctx.st); }
  bibliography(n, ctx, flow) {
    const [, j] = this.arg(n.kids, -1);
    const kids = n.kids.slice(j + 1);
    flow.block('<h2 class="bibhead">' + (this.book ? "Bibliography" : "References") + "</h2>");
    const b = flow.open("ol", ' class="bib"');
    let li = null;
    for (let i = 0; i < kids.length; i++) {
      if (this.csName(kids[i]) === "bibitem") {
        const [o, j1] = this.opt(kids, i); const [k, j2] = this.arg(kids, j1);
        if (li) flow.close(li);
        const key = this.str(k).trim(); const num = ++this.bibN; const lab = o ? this.inline(o, ctx) : String(num);
        this.bib.set(key, { lab, id: "bib-" + num });
        li = flow.open("li", ' id="bib-' + num + '"', '<span class="biblab">[' + lab + "]</span> ");
        i = j2; continue;
      }
      const start = i; let end = i; while (end < kids.length && this.csName(kids[end]) !== "bibitem") end++;
      this.walk(kids.slice(start, end), ctx, flow); i = end - 1;
    }
    if (li) flow.close(li);
    flow.close(b);
  }

  // ---- picture (LaTeX picture environment -> SVG)
  picture(n, ctx, flow) {
    const P = new PicParser(this, n.kids, ctx);
    flow.html(P.render(), ctx.st);
  }

  resolveRef(r, plain) {
    if (r.cmd === "cite" || r.cmd === "citep" || r.cmd === "citet") {
      const parts = r.key.split(",").map((k) => k.trim()).filter(Boolean).map((k) => { const b = this.bib.get(k); return b ? (plain ? b.lab : '<a href="#' + b.id + '">' + b.lab + "</a>") : (plain ? "?" : '<span class="missing">' + esc(k) + "</span>"); });
      return "[" + parts.join(", ") + (r.opt ? ", " + esc(r.opt) : "") + "]";
    }
    if (r.cmd === "cref" || r.cmd === "Cref") return this.cref(r, plain);
    const L = this.labels.get(r.key);
    if (!L) return plain ? "??" : '<span class="missing" title="' + esc(r.key) + '">??</span>';
    // (\nameref: the title the label was under, a section's or a caption's; one that names itself, "??", as hyperref ends)
    if (r.cmd === "nameref") {
      const nm = this.nameText(r.key, plain);
      if (nm === null) return plain ? "??" : '<span class="missing" title="' + esc(r.key) + '">??</span>';
      // (all of a document's \nameref's together: at most NAME_TOTAL characters of titles, counted before each is shown)
      if ((this.nameOut = (this.nameOut ?? 0) + nm.length) > NAME_TOTAL) { this.nameSaid("past " + NAME_TOTAL + " characters of titles in all: the rest left out"); return "\u2026"; }
      return plain ? nm : L.id ? '<a class="ref" href="#' + L.id + '">' + nm + "</a>" : nm;
    }
    let txt = L.text || "??";
    if (r.cmd === "eqref") txt = "(" + txt + ")";
    if (r.cmd === "pageref") txt = "↑";
    if (r.cmd === "autoref") {
      const nm = { section: "Section", subsection: "Section", subsubsection: "Section", chapter: "Chapter", equation: "Equation", figure: "Figure", table: "Table", item: "Item", footnote: "Footnote" }[L.kind]
        || (this.thms[L.kind] ? this.thms[L.kind].title : "");
      txt = (nm ? (r.cmd === "cref" ? nm.toLowerCase() : nm) + " " : "") + txt;
    }
    if (plain) return txt;
    return L.id ? '<a class="ref" href="#' + L.id + '">' + esc(txt) + "</a>" : esc(txt);
  }
  // (a label's \nameref text: its title with the references in it resolved, as text (no link inside the link): the final
  //  pass replaces each placeholder once, so one \nameref brings in is resolved here (daybreak3, #682); null if the title
  //  names itself, directly or through others (TeX: "??"))
  nameText(key, plain, seen = new Set()) {
    const L = this.labels.get(key);
    // (only a \nameref inside a title can name a missing label here, and it asks for text)
    if (!L) return "??";
    if (seen.has(key)) return null;
    if (seen.size >= NAME_DEPTH) { this.nameSaid("titles naming titles past " + NAME_DEPTH + " deep: the rest left out"); this.nameTaint = (this.nameTaint ?? 0) + 1; return "??"; }
    // (each label's title as text, worked out once (a label reached through many titles isn't worked out again: whether it
    //  reaches a cycle doesn't depend on where it's reached from), at most NAME_MAX characters, checked before each piece
    //  is added (titles naming others twice each doubled per level: astra, REF682-EXPAND-1); past it, cut and said once.
    //  A title whose working out met the depth cut depends on how deep it was reached: kept only for that depth left
    //  (nameMemoAt), so the same label named directly, or less deep, is worked out again and gets its whole title
    //  (daybreak3, #682 r3); at most NAME_DEPTH of those per label, so the work stays bounded)
    const memo = (this.nameMemo ??= new Map()), memoAt = (this.nameMemoAt ??= new Map()), left = NAME_DEPTH - seen.size;
    let m = memo.get(key);
    if (m === undefined) {
      m = memoAt.get(key)?.get(left);
      // (a result cut by depth, reused: whoever uses it is cut by depth too)
      if (m !== undefined) this.nameTaint = (this.nameTaint ?? 0) + 1;
    }
    if (m === undefined) {
      const t0 = this.nameTaint ?? 0;
      seen.add(key);
      let text = "", cycle = false, cut = false;
      for (const part of L.name.replace(/<[^>]*>/g, "").split(/(\u0001R\d+\u0002)/)) {
        const k = /^\u0001R(\d+)\u0002$/.exec(part), q = k && this.refs[+k[1]];
        const t = !q ? unesc(part) : q.cmd === "nameref" ? this.nameText(q.key, true, seen) : this.resolveRef(q, true);
        if (t === null) { cycle = true; break; }
        if (text.length + t.length > NAME_MAX) { text += t.slice(0, NAME_MAX - text.length) + "\u2026"; cut = true; break; }
        text += t;
      }
      seen.delete(key);
      if (cut) this.nameSaid("a title past " + NAME_MAX + " characters, cut");
      m = cycle ? null : text;
      if ((this.nameTaint ?? 0) === t0) memo.set(key, m);
      else { let at = memoAt.get(key); if (!at) memoAt.set(key, (at = new Map())); at.set(left, m); }
    }
    // (in HTML: the title as made, its markup kept; one with references in it, as its text, escaped once)
    //  (and a title cut at NAME_MAX, references in it or not, as the text it was cut to: what is shown is what was said,
    //  astra's #682 r3 note)
    return m === null ? null : plain ? m : /\u0001R/.test(L.name) || m.length > NAME_MAX ? esc(m) : L.name;
  }
  // (each kind of cut said once, as a problem)
  nameSaid(why) { (this.nameWhy ??= new Set()).has(why) || (this.nameWhy.add(why), this.problem("expansion", "\\nameref: " + why)); }
  // cleveref's \cref and \Cref, with its defaults (TeX Live's; astra4's digest, gap 2): each kind named ("section 1",
  // "eq. (1)", "fig. 1"), the keys of one kind together, the kinds in the order they first come, each kind's sorted,
  // runs of three or more as "a to c"; "and" between two, commas and a last "and" between more (between kinds, ", and");
  // \Cref names the first kind capitalized; keys with no label, "??" each
  cref(r, plain) {
    const groups = new Map();
    for (const key of r.key.split(",").map((k) => k.trim()).filter(Boolean)) {
      const L = this.labels.get(key), kind = L ? L.kind : "\u0000";
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(L ?? { missing: key });
    }
    const num = (L) => String(L.text).split(".").map(Number);
    const cmp = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1); return 0; };
    const next = (a, b) => { const x = num(a), y = num(b); return x.length === y.length && x.slice(0, -1).join() === y.slice(0, -1).join() && y.at(-1) === x.at(-1) + 1; };
    const and = (xs, oxford) => xs.length < 3 ? xs.join(" and ") : xs.slice(0, -1).join(", ") + (oxford ? ", and " : " and ") + xs.at(-1);
    const parts = [...groups].map(([kind, Ls], g) => {
      // (keys with no label: "??" each, together, as cleveref prints them: "????" for two)
      if (kind === "\u0000") return Ls.map((x) => plain ? "??" : '<span class="missing" title="' + esc(x.missing) + '">??</span>').join("");
      Ls.sort(cmp);
      const show = (L) => { const t = kind === "equation" ? "(" + L.text + ")" : L.text; return plain ? t : L.id ? '<a class="ref" href="#' + L.id + '">' + esc(t) + "</a>" : esc(t); };
      const items = [];
      for (let i = 0; i < Ls.length; ) { let j = i; while (j + 1 < Ls.length && next(Ls[j], Ls[j + 1])) j++; if (j - i >= 2) items.push(show(Ls[i]) + " to " + show(Ls[j])); else for (let k = i; k <= j; k++) items.push(show(Ls[k])); i = j + 1; }
      const th = this.thms[kind]?.title.toLowerCase(), nm = CREF[kind] ?? (th ? [th, th + "s"] : null);
      let name = nm ? nm[Ls.length > 1 ? 1 : 0] : "";
      if (name && r.cmd === "Cref" && g === 0) name = CREF_CAP[name] ?? name[0].toUpperCase() + name.slice(1);
      // (a theorem's name is the document's own text: escaped in HTML (astra, REF682-HTML-1))
      return (name ? (plain ? name : esc(name)) + " " : "") + and(items, false);
    });
    return and(parts, true);
  }
  tocHtml() {
    if (!this.toc.length) return "";
    return '<div class="toc"><h2>Contents</h2>' + this.toc.map((t) => '<div class="toc' + t.level + '"><a href="#' + t.id + '">' + (t.num ? '<span class="tocnum">' + esc(t.num) + "</span>" : "") + t.title.replace(/<a [^>]*>|<\/a>/g, "") + "</a></div>").join("") + "</div>";
  }
  // an item rendered: shown, unless in the preamble; inside a title field (\title, \author, \date, \institute, \thanks),
  // kept with that field instead, and shown only if \maketitle or \titlepage prints it (run)
  sageSeen(k) { if (this.sageField) this.sageField.push(k); else if (!this.inPreamble) this.sageShown.add(k); }
  /** fn's result, and the SageTeX items it rendered (a title field's) */
  // a saved box: its HTML and SageTeX items, by the box's name as written (\saved); shown by \usebox, its items then
  // shown too (a box never used is never shown, as in TeX)
  boxName(a) { return this.str(a).trim(); }
  saveBox(a, fn) { const [h, keys] = this.captured(fn); this.boxes.set(this.boxName(a), { h, keys: [...new Set(keys)] }); }
  captured(fn) { const prev = this.sageField; this.sageField = []; try { return [fn(), this.sageField]; } finally { this.sageField = prev; } }
  titleHtml() {
    const m = this.meta;
    if (!m.title && !m.author) return "";
    const date = m.date !== null ? m.date : esc(new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }));
    return '<div class="titleblock">' + (m.title ? '<div class="title">' + m.title + "</div>" : "") + (m.author ? '<div class="author">' + m.author + "</div>" : "") + (m.institute ? '<div class="institute">' + m.institute + "</div>" : "") + (date ? '<div class="date">' + date + "</div>" : "") +
      (m.thanks.length ? '<div class="thanks">' + m.thanks.map((t) => "<div>* " + t + "</div>").join("") + "</div>" : "") + "</div>";
  }

  run(events, I) {
    this.I = I;
    this.sageItems = []; this.sageStates = (this.opts.sage && Array.isArray(this.opts.sage.states)) ? this.opts.sage.states : [];
    this.sageShown = new Set(); this.mathFails = []; this.mathStale = false; Z?.on();
    const nodes = buildTree(events, this.sageItems);
    // (saved results, `sagebrush latex run`'s file: item n's counts while it and every item before it are the code that
    //  was run, the code running in order in one session; sagetex.mjs savedStates)
    if (this.opts.sage && Array.isArray(this.opts.sage.saved)) this.sageStates = savedStates(this.sageItems, this.opts.sage.saved);
    // preamble: definitions and metadata only (its text output is discarded)
    const di = nodes.findIndex((x) => x.t === "doc");
    const pre = di >= 0 ? nodes.slice(0, di) : [];
    const body = di >= 0 ? nodes.slice(di + 1) : nodes;
    const ctx = { st: { al: "" } };
    this.inPreamble = true; this.walk(pre, ctx, new Flow(false)); this.inPreamble = false;
    this.macroSig = String(Object.keys(this.macros).length) + ":" + Object.entries(this.macros).map(([k, v]) => k + "=" + v).join(";").length;
    const flow = new Flow(false);
    this.walk(body, { st: { al: "" } }, flow);
    this.flushFootnotes(flow);
    let chunks = flow.finish();
    this.chunkPos = chunks.map((_, k) => flow.rootPos[k] ?? -1);
    // SageTeX S1 (astra4 S1E01-A3): an item the preview never showed (in an argument the renderer drops, the
    // preamble, ...) is never run: it becomes an error (so every later item is blocked), said once at the top
    // (a title field's items are shown if the title block is printed (a \maketitle or \titlepage chunk) and has that
    //  field, as titleHtml writes it)
    // eslint-disable-next-line no-control-regex
    if (chunks.some((c) => c.includes("\u0001TITLE\u0002")) && (this.meta.title || this.meta.author)) {
      const m = this.meta, printed = { title: !!m.title, author: !!m.author, institute: !!m.institute, date: m.date === null || !!m.date, thanks: m.thanks.length > 0 };
      for (const f of Object.keys(printed)) if (printed[f]) for (const k of this.metaSage[f]) this.sageShown.add(k);
    }
    // (and those beamer's furniture shows: engine/beamer.mjs)
    if (this.furnishShown) this.furnishShown();
    const hidden = this.sageItems.filter((it, k) => !this.sageShown.has(k));
    for (const it of hidden) if (!it.err) it.err = "hidden";
    if (hidden.length) this.chunkPos.unshift(-1);
    if (hidden.length) chunks.unshift('<div class="sagestate"><span class="sagechip s-error">' + esc(hidden.length + (hidden.some(isPy) ? " code item" : " Sage code item") + (hidden.length === 1 ? "" : "s") + " can't be run: " + whyRejected({ err: "hidden" })) + "</span></div>");
    // resolve references, the table of contents and the title block
    const toc = this.tocHtml(), title = this.titleHtml();
    // eslint-disable-next-line no-control-regex
    chunks = chunks.map((c) => c.replace(/\u0001TOC\u0002/g, () => toc).replace(/\u0001TITLE\u0002/g, () => title).replace(/\u0001R(\d+)\u0002/g, (_, k) => this.resolveRef(this.refs[+k], false))
      // (beamer's headline (h), footline (f) or sidebar (s) of frame k: engine/beamer.mjs, once every section is known)
      .replace(/\u0001B([hfs])(\d+)\u0002/g, (_, w, k) => this.furnish(w, +k)));
    return chunks;
  }
}

// ------------------------------------------------------------------ commands
const st1 = (fn) => function (nodes, i, ctx, flow) {   // a style command with one argument
  const [a, j] = this.arg(nodes, i);
  const c2 = Object.assign({}, ctx, { st: Object.assign({}, ctx.st) }); fn(c2.st);
  this.walk(a, c2, flow); return j;
};
const decl = (fn) => function (nodes, i, ctx) { fn(ctx.st); return i; };
const box = (render) => function (nodes, i, ctx, flow) { return render.call(this, nodes, i, ctx, flow); };
const CMDS = {
  textbf: st1((s) => { s.b = true; }), textit: st1((s) => { s.i = true; }), textsl: st1((s) => { s.sl = true; }), textsc: st1((s) => { s.sc = true; }),
  texttt: st1((s) => { s.f = "tt"; }), textsf: st1((s) => { s.f = "sf"; }), textrm: st1((s) => { s.f = ""; }), textup: st1((s) => { s.i = false; s.sl = false; }),
  textmd: st1((s) => { s.b = false; }), textnormal: st1((s) => { s.f = ""; s.b = false; s.i = false; s.sl = false; s.sc = false; }),
  emph: st1((s) => { s.i = !s.i; }), underline: st1((s) => { s.u = true; }), uline: st1((s) => { s.u = true; }), ul: st1((s) => { s.u = true; }),
  sout: st1((s) => { s.st = true; }), st: st1((s) => { s.st = true; }), hl: st1((s) => { s.u = true; }), mbox: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); flow.html('<span class="mbox">' + this.inline(a, ctx) + "</span>", ctx.st); return j; },
  bfseries: decl((s) => { s.b = true; }), itshape: decl((s) => { s.i = true; }), slshape: decl((s) => { s.sl = true; }), scshape: decl((s) => { s.sc = true; }),
  upshape: decl((s) => { s.i = false; s.sl = false; }), mdseries: decl((s) => { s.b = false; }), ttfamily: decl((s) => { s.f = "tt"; }), sffamily: decl((s) => { s.f = "sf"; }),
  rmfamily: decl((s) => { s.f = ""; }), normalfont: decl((s) => { s.f = ""; s.b = false; s.i = false; s.sl = false; s.sc = false; }),
  bf: decl((s) => { s.b = true; s.i = false; s.f = ""; }), it: decl((s) => { s.i = true; s.b = false; }), sl: decl((s) => { s.sl = true; }), sc: decl((s) => { s.sc = true; }),
  tt: decl((s) => { s.f = "tt"; }), sf: decl((s) => { s.f = "sf"; }), rm: decl((s) => { s.f = ""; s.b = false; s.i = false; }), em: decl((s) => { s.i = !s.i; }),
  centering: decl((s) => { s.al = "c"; }), raggedright: decl((s) => { s.al = "l"; }), raggedleft: decl((s) => { s.al = "r"; }),
  textsuperscript: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); flow.html("<sup>" + this.inline(a, ctx) + "</sup>", ctx.st); return j; },
  textsubscript: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); flow.html("<sub>" + this.inline(a, ctx) + "</sub>", ctx.st); return j; },
  "\\": function (nodes, i, ctx, flow) { let [, j] = this.star(nodes, i); const [o, j2] = this.opt(nodes, j); flow.html("<br>" + (o ? '<span class="vsp" style="height:' + (cssDim(this.str(o)) || "0") + '"></span>' : ""), ctx.st); return o ? j2 : j; },
  newline: function (nodes, i, ctx, flow) { flow.html("<br>", ctx.st); return i; },
  linebreak: function (nodes, i, ctx, flow) { const [, j] = this.opt(nodes, i); flow.html("<br>", ctx.st); return j; },
  noindent: function (nodes, i, ctx, flow) { flow.par(); flow.noindent = true; return i; },
  item: function (nodes, i) { const [, j] = this.opt(nodes, i); return j; },
  today: function (nodes, i, ctx, flow) { flow.text(new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }), ctx.st); return i; },
  LaTeX: function (nodes, i, ctx, flow) { flow.html('<span class="latex">L<span class="a">a</span>T<span class="e">e</span>X</span>', ctx.st); return i; },
  LaTeXe: function (nodes, i, ctx, flow) { flow.html('<span class="latex">L<span class="a">a</span>T<span class="e">e</span>X&thinsp;2<sub>&epsilon;</sub></span>', ctx.st); return i; },
  TeX: function (nodes, i, ctx, flow) { flow.html('<span class="latex">T<span class="e">e</span>X</span>', ctx.st); return i; },
  BibTeX: function (nodes, i, ctx, flow) { flow.html('<span class="sc">Bib</span><span class="latex">T<span class="e">e</span>X</span>', ctx.st); return i; },
  title: function (nodes, i, ctx) { const [a, j] = this.arg(nodes, i); [this.meta.title, this.metaSage.title] = this.captured(() => this.inline(a, ctx)); return j; },
  author: function (nodes, i, ctx) {
    const [a, j] = this.arg(nodes, i);
    const parts = [[]]; for (const x of a) { if (this.csName(x) === "and") parts.push([]); else parts[parts.length - 1].push(x); }
    [this.meta.author, this.metaSage.author] = this.captured(() => parts.map((p) => '<span class="auth">' + this.inline(p, ctx) + "</span>").join("")); return j;
  },
  date: function (nodes, i, ctx) { const [a, j] = this.arg(nodes, i); [this.meta.date, this.metaSage.date] = this.captured(() => this.inline(a, ctx)); return j; },
  maketitle: function (nodes, i, ctx, flow) { flow.block("\u0001TITLE\u0002"); return i; },
  titlepage: function (nodes, i, ctx, flow) { flow.block("\u0001TITLE\u0002"); return i; },   // (beamer's title frame)
  alert: function (nodes, i, ctx, flow) { const j0 = this.spec(nodes, i); const [a, j] = this.arg(nodes, j0); flow.html('<span class="alert">' + this.inline(a, ctx) + "</span>", ctx.st); return j; },
  structure: function (nodes, i, ctx, flow) { const j0 = this.spec(nodes, i); const [a, j] = this.arg(nodes, j0); flow.html('<span class="structure">' + this.inline(a, ctx) + "</span>", ctx.st); return j; },
  note: function (nodes, i) { const j0 = this.spec(nodes, i); const [, j1] = this.opt(nodes, j0); const [, j] = this.arg(nodes, j1); return j; },
  institute: function (nodes, i, ctx) { const [, j0] = this.opt(nodes, i); const [a, j] = this.arg(nodes, j0); [this.meta.institute, this.metaSage.institute] = this.captured(() => this.inline(a, ctx)); return j; },
  tableofcontents: function (nodes, i, ctx, flow) { flow.block("\u0001TOC\u0002"); return i; },
  appendix: function (nodes, i) { this.appendix = true; if (this.book) this.ctr.chapter = 0; else this.ctr.section = 0; return i; },
  url: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); const u = this.str(a).replace(/\\([#%&_~$])/g, "$1"); const s = safeUrl(u); flow.html(s ? '<a class="url" href="' + esc(s) + '" target="_blank" rel="noopener noreferrer">' + esc(u) + "</a>" : '<span class="url">' + esc(u) + "</span>", ctx.st); return j; },
  nolinkurl: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); flow.html('<span class="url">' + esc(this.str(a)) + "</span>", ctx.st); return j; },
  href: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); const [b, j2] = this.arg(nodes, j); const s = safeUrl(this.str(a).replace(/\\([#%&_~$])/g, "$1")); const inner = this.inline(b, ctx); flow.html(s ? '<a href="' + esc(s) + '" target="_blank" rel="noopener noreferrer">' + inner + "</a>" : inner, ctx.st); return j2; },
  hyperref: function (nodes, i, ctx, flow) { const [, j] = this.opt(nodes, i); const [b, j2] = this.arg(nodes, j); flow.html(this.inline(b, ctx), ctx.st); return j2; },
  texorpdfstring: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); const [, j2] = this.arg(nodes, j); this.walk(a, ctx, flow); return j2; },
  ensuremath: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); flow.html(this.math(this.mathStr(a), false), ctx.st); return j; },
  fbox: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); flow.html('<span class="tex-fbox">' + this.inline(a, ctx) + "</span>", ctx.st); return j; },
  frame: function (nodes, i, ctx, flow) {
    if (this.cls === "beamer" && beamer) { const [a, j] = this.arg(nodes, this.opt(nodes, this.spec(nodes, i))[1]); this.frame(a, ctx, flow); return j; } const [a, j] = this.arg(nodes, i); flow.html('<span class="tex-fbox frame">' + this.inline(a, ctx) + "</span>", ctx.st); return j; },
  shadowbox: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); flow.html('<span class="tex-fbox shadow">' + this.inline(a, ctx) + "</span>", ctx.st); return j; },
  doublebox: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); flow.html('<span class="tex-fbox double">' + this.inline(a, ctx) + "</span>", ctx.st); return j; },
  ovalbox: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); flow.html('<span class="tex-fbox oval">' + this.inline(a, ctx) + "</span>", ctx.st); return j; },
  Ovalbox: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); flow.html('<span class="tex-fbox oval">' + this.inline(a, ctx) + "</span>", ctx.st); return j; },
  makebox: box(function (nodes, i, ctx, flow) { return this.makebox(nodes, i, ctx, flow, false); }),
  // saved boxes (astra4's digest, gap 3: they were dropped, silently): \sbox{\name}{text}, \savebox{\name}[width][pos]{text}
  // (as \makebox), and lrbox (the environments) kept, and \usebox{\name} shows the box; one never saved shows nothing,
  // as TeX's empty box, and check says so
  sbox: function (nodes, i, ctx) { const [a, j0] = this.arg(nodes, i), [b, j] = this.arg(nodes, j0); this.saveBox(a, () => this.inline(b, ctx)); return j; },
  savebox: function (nodes, i, ctx) { const [a, j0] = this.arg(nodes, i); let j = j0; this.saveBox(a, () => { const f = new Flow(true); j = this.makebox(nodes, j0, ctx, f, false); return f.inlineHtml(); }); return j; },
  usebox: function (nodes, i, ctx, flow) {
    const [a, j] = this.arg(nodes, i), b = this.boxes.get(this.boxName(a));
    if (!b) { this.problem("box", "\\usebox of a box not saved: " + this.boxName(a)); return j; }
    // (every copy within one budget, BOX_MAX, checked before it's made: a box copied into a box, again and again, would
    //  double each time (astra, BOX653-EXPAND-1); its SageTeX items too, each once in the box (a box doubled into itself
    //  with no HTML still doubled them, BOX653-EXPAND-1's residual); past it, left out, said once)
    const cost = boxCost(b);
    if (!fitsBoxes(this.boxUsed, cost)) { if (!this.boxOver) { this.boxOver = true; this.problems.push({ kind: "box", name: "saved boxes left out from here on: over the budget for their copies", at: this.lastPos }); } return j; }
    this.boxUsed += cost;
    // (its SageTeX seen as where it's used is: shown in the body, held in a field or another box until those are, never
    //  in the preamble (daybreak3, BOX653-SAGE-CAPTURE-1))
    for (const k of b.keys) this.sageSeen(k);
    flow.html(b.h, ctx.st); return j;
  },
  framebox: box(function (nodes, i, ctx, flow) { return this.makebox(nodes, i, ctx, flow, true); }),
  parbox: function (nodes, i, ctx, flow) {
    let j = i, o, pos = "c", h = null, ipos = null;
    [o, j] = this.opt(nodes, j); if (o) pos = this.str(o).trim()[0] || "c";
    [o, j] = this.opt(nodes, j); if (o) h = cssDim(this.str(o));
    [o, j] = this.opt(nodes, j); if (o) ipos = this.str(o).trim()[0] || null;
    const [w, j2] = this.arg(nodes, j); const [a, j3] = this.arg(nodes, j2);
    const width = cssDim(this.str(w)) || "auto";
    const f = new Flow(false); this.walk(a, Object.assign({}, ctx, { st: Object.assign({}, ctx.st, { al: "" }) }), f);
    const inner = f.finish().join("");
    const ip = ipos || pos;
    flow.html('<span class="parbox va-' + esc(pos === "m" ? "c" : pos) + '" style="width:' + width + (h ? ";height:" + h : "") + '"><span class="pbin ip-' + esc(ip === "m" ? "c" : ip) + '">' + inner + "</span></span>", ctx.st);
    return j3;
  },
  raisebox: function (nodes, i, ctx, flow) { const [d, j] = this.arg(nodes, i); let j2 = j, o; [o, j2] = this.opt(nodes, j2); [o, j2] = this.opt(nodes, j2); void o; const [a, j3] = this.arg(nodes, j2); flow.html('<span style="display:inline-block;position:relative;bottom:' + (cssDim(this.str(d)) || "0") + '">' + this.inline(a, ctx) + "</span>", ctx.st); return j3; },
  phantom: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); flow.html('<span class="phantom">' + this.inline(a, ctx) + "</span>", ctx.st); return j; },
  hphantom: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); flow.html('<span class="phantom hph">' + this.inline(a, ctx) + "</span>", ctx.st); return j; },
  vphantom: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); flow.html('<span class="phantom vph">' + this.inline(a, ctx) + "</span>", ctx.st); return j; },
  smash: function (nodes, i, ctx, flow) { const [, j0] = this.opt(nodes, i); const [a, j] = this.arg(nodes, j0); flow.html('<span class="smash">' + this.inline(a, ctx) + "</span>", ctx.st); return j; },
  llap: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); flow.html('<span class="tex-llap"><span>' + this.inline(a, ctx) + "</span></span>", ctx.st); return j; },
  rlap: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); flow.html('<span class="tex-rlap"><span>' + this.inline(a, ctx) + "</span></span>", ctx.st); return j; },
  marginpar: function (nodes, i, ctx, flow) { const [, j0] = this.opt(nodes, i); const [a, j] = this.arg(nodes, j0); flow.html('<span class="marginpar">' + this.inline(a, Object.assign({}, ctx, { st: { al: "" } })) + "</span>", ctx.st); return j; },
  todo: function (nodes, i, ctx, flow) { const [, j0] = this.opt(nodes, i); const [a, j] = this.arg(nodes, j0); flow.html('<span class="marginpar todo">' + this.inline(a, Object.assign({}, ctx, { st: { al: "" } })) + "</span>", ctx.st); return j; },
  hspace: function (nodes, i, ctx, flow) { const [, j0] = this.star(nodes, i); const [a, j] = this.arg(nodes, j0); const w = cssDim(this.str(a)); flow.html('<span class="hsp" style="width:' + (w || "0") + '"></span>', ctx.st); return j; },
  vspace: function (nodes, i, ctx, flow) { const [, j0] = this.star(nodes, i); const [a, j] = this.arg(nodes, j0); const h = cssDim(this.str(a)); flow.block('<div class="vsp" style="height:' + (h && !h.startsWith("-") ? h : "0") + '"></div>'); return j; },
  vskip: function (nodes, i, ctx, flow) { const [d, j] = this.dimen(nodes, i); flow.block('<div class="vsp" style="height:' + (cssDim(d) || "0") + '"></div>'); return j; },
  hskip: function (nodes, i, ctx, flow) { const [d, j] = this.dimen(nodes, i); flow.html('<span class="hsp" style="width:' + (cssDim(d) || "0") + '"></span>', ctx.st); return j; },
  kern: function (nodes, i, ctx, flow) { const [d, j] = this.dimen(nodes, i); flow.html('<span class="hsp" style="width:' + (cssDim(d) || "0") + '"></span>', ctx.st); return j; },
  bigskip: function (nodes, i, ctx, flow) { flow.block('<div class="vsp" style="height:1em"></div>'); return i; },
  medskip: function (nodes, i, ctx, flow) { flow.block('<div class="vsp" style="height:.5em"></div>'); return i; },
  smallskip: function (nodes, i, ctx, flow) { flow.block('<div class="vsp" style="height:.25em"></div>'); return i; },
  bigbreak: function (nodes, i, ctx, flow) { flow.block('<div class="vsp" style="height:1em"></div>'); return i; },
  medbreak: function (nodes, i, ctx, flow) { flow.block('<div class="vsp" style="height:.5em"></div>'); return i; },
  smallbreak: function (nodes, i, ctx, flow) { flow.block('<div class="vsp" style="height:.25em"></div>'); return i; },
  hrule: function (nodes, i, ctx, flow) { flow.block("<hr>"); return i; },
  // (a page break, as TeX's (Codex W05: it was ignored): printed (and in a PDF) the page ends there; in the preview, a
  //  line where it does. \newpage, \clearpage: the paragraph ends, then the page. \pagebreak in a paragraph: the page
  //  breaks after it, the paragraph kept whole (TeX: after its line); [n] below 4 is only a hint: nothing. Within an
  //  inline flow (a box): nothing. A beamer frame's: none (style.ts))
  newpage: function (nodes, i, ctx, flow) { if (!flow.inline) flow.pageBreak(); return i; },
  clearpage: function (nodes, i, ctx, flow) { if (!flow.inline) flow.pageBreak(); return i; },
  cleardoublepage: function (nodes, i, ctx, flow) { if (!flow.inline) flow.pageBreak(); return i; },
  pagebreak: function (nodes, i, ctx, flow) {
    const [a, j] = this.opt(nodes, i);
    if ((a ? this.str(a).trim() : "4") !== "4" || flow.inline) return j;
    if (flow.runs) flow.pgAfter = true; else flow.pageBreak();
    return j;
  },
  rule: function (nodes, i, ctx, flow) { const [, j0] = this.opt(nodes, i); const [w, j1] = this.arg(nodes, j0); const [h, j2] = this.arg(nodes, j1); flow.html('<span class="rule" style="width:' + (cssDim(this.str(w)) || "0") + ";height:" + (cssDim(this.str(h)) || "0") + '"></span>', ctx.st); return j2; },
  symbol: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); const c = this.charCode(this.str(a)); if (c !== null) flow.text(String.fromCodePoint(c), ctx.st); return j; },
  char: function (nodes, i, ctx, flow) { let s = "", j = i + 1; while (j < nodes.length && nodes[j].t === "x" && !isCs(nodes[j].v) && catOf(nodes[j].v) !== CAT.SPACE && /["'`0-9A-Fa-f]/.test(String.fromCodePoint(codeOf(nodes[j].v)))) { s += String.fromCodePoint(codeOf(nodes[j].v)); j++; } if (this.isSp(nodes[j])) j++; const c = this.charCode(s); if (c !== null) flow.text(String.fromCodePoint(c), ctx.st); return j - 1; },
  color: function (nodes, i, ctx) { const [o, j0] = this.opt(nodes, i); const [a, j] = this.arg(nodes, j0); const c = this.colorOf(this.str(a).trim(), o ? this.str(o) : null); if (c) ctx.st.color = c; return j; },
  textcolor: function (nodes, i, ctx, flow) { const [o, j0] = this.opt(nodes, i); const [a, j] = this.arg(nodes, j0); const [b, j2] = this.arg(nodes, j); const c = this.colorOf(this.str(a).trim(), o ? this.str(o) : null); const c2 = Object.assign({}, ctx, { st: Object.assign({}, ctx.st, c ? { color: c } : {}) }); this.walk(b, c2, flow); return j2; },
  colorbox: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); const [b, j2] = this.arg(nodes, j); const c = this.colorOf(this.str(a).trim(), null); flow.html('<span class="cbox"' + (c ? ' style="background:' + c + '"' : "") + ">" + this.inline(b, ctx) + "</span>", ctx.st); return j2; },
  definecolor: function (nodes, i) { const [a, j] = this.arg(nodes, i); const [m, j2] = this.arg(nodes, j); const [v, j3] = this.arg(nodes, j2); const c = this.parseColor(this.str(m).trim(), this.str(v)); if (c) this.colors[this.str(a).trim()] = c; return j3; },
  newtheorem: function (nodes, i, ctx) {
    const [star, j0] = this.star(nodes, i);
    const [a, j1] = this.arg(nodes, j0); const [sh, j2] = this.opt(nodes, j1); const [t, j3] = this.arg(nodes, sh ? j2 : j1); const [w, j4] = this.opt(nodes, j3);
    const name = this.str(a).trim();
    this.thms[name] = { title: this.str(t).trim().replace(/[{}\\]/g, ""), shared: sh ? this.str(sh).trim() : null, within: w ? this.str(w).trim() : null, style: this.thmStyle, star };
    void ctx; return w ? j4 : j3;
  },
  theoremstyle: function (nodes, i) { const [a, j] = this.arg(nodes, i); const s = this.str(a).trim(); this.thmStyle = s === "definition" ? "definition" : s === "remark" ? "remark" : "plain"; return j; },
  numberwithin: function (nodes, i) { const [a, j] = this.arg(nodes, i); const [b, j2] = this.arg(nodes, j); if (this.str(a).trim() === "equation") this.eqWithin = this.str(b).trim(); return j2; },
  DeclareMathOperator: function (nodes, i) {
    const [star, j0] = this.star(nodes, i); const [a, j1] = this.arg(nodes, j0); const [b, j2] = this.arg(nodes, j1);
    const cs = this.str(a).trim(); if (/^\\[A-Za-z]+$/.test(cs)) this.macros[cs] = "\\operatorname" + (star ? "*" : "") + "{" + this.mathStr(b) + "}";
    return j2;
  },
  setlength: function (nodes, i) { const [a, j] = this.arg(nodes, i); const [b, j2] = this.arg(nodes, j); if (this.str(a).trim() === "\\unitlength") { const v = dimPt(this.str(b)); if (v) this.unitlength = v; } return j2; },
  linethickness: function (nodes, i) { const [, j] = this.arg(nodes, i); return j; },
  thicklines: function (nodes, i) { return i; }, thinlines: function (nodes, i) { return i; },
  includegraphics: function (nodes, i, ctx, flow) {
    const [, j0] = this.star(nodes, i); const [o, j1] = this.opt(nodes, j0); const [a, j2] = this.arg(nodes, o ? j1 : j0);
    const name = this.str(a).trim(); const opts = o ? this.str(o) : "";
    let style = "";
    const wm = /width\s*=\s*([^,]+)/.exec(opts); const hm = /height\s*=\s*([^,]+)/.exec(opts); const sm = /scale\s*=\s*([0-9.]+)/.exec(opts);
    if (wm) { const d = cssDim(wm[1]); if (d) style += "width:" + d + ";"; }
    else if (hm) { const d = cssDim(hm[1]); if (d) style += "height:" + (d.endsWith("vh") ? (parseFloat(d) / 2).toFixed(1) + "vh" : d) + ";"; }
    else if (sm) style += "width:" + Math.min(100, parseFloat(sm[1]) * 50).toFixed(0) + "%;";
    // (the site: the page resolves each name as written, and gives a blob: URL or a reason; recorded for it here)
    if (this.imageRefs.size < 256) this.imageRefs.add(name);
    const key = name.replace(/\.(pdf|png|jpe?g|eps|gif|svg)$/i, "");
    const v = Object.hasOwn(this.images, name) ? this.images[name] : Object.hasOwn(this.images, key) ? this.images[key] : null;
    if (typeof v === "string") flow.html('<img class="graphic" src="' + esc(v) + '" alt="' + esc(name) + '"' + (style ? ' style="' + style + '"' : "") + ">", ctx.st);
    else flow.html('<span class="imgph"' + (style ? ' style="' + style + '"' : "") + ">[image: " + esc(name) + (v && typeof v.why === "string" ? ": " + esc(v.why) : "") + "]</span>", ctx.st);
    return j2;
  },
  bibliography: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); flow.block('<div class="placeholder">[bibliography from ' + esc(this.str(a)) + ".bib: BibTeX is not run]</div>"); return j; },
  printindex: function (nodes, i, ctx, flow) { flow.block('<div class="placeholder">[index: not generated in this prototype]</div>'); return i; },
  includepdf: function (nodes, i, ctx, flow) { const [, j0] = this.opt(nodes, i); const [a, j] = this.arg(nodes, j0); flow.block('<div class="placeholder">[included PDF: ' + esc(this.str(a)) + "]</div>"); return j; },
  bibnote: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); this.footnote({ kids: a }, ctx, flow); return j; },
  footnotemark: function (nodes, i, ctx, flow) { const [, j] = this.opt(nodes, i); flow.html("<sup>" + (this.ctr.footnote + 1) + "</sup>", ctx.st); return j; },
  centerline: function (nodes, i, ctx, flow) { const [a, j] = this.arg(nodes, i); flow.block('<div class="center"><div class="p al-c">' + this.inline(a, ctx) + "</div></div>"); return j; },
  bibitem: function (nodes, i) { const [, j0] = this.opt(nodes, i); const [, j] = this.arg(nodes, j0); return j; },
  begin: function (nodes, i) { return i; }, end: function (nodes, i) { return i; },
};
Renderer.prototype.makebox = function (nodes, i, ctx, flow, framed) {
  let j = i, o, w = null, pos = "c";
  [o, j] = this.opt(nodes, j); if (o) w = cssDim(this.str(o));
  if (o) { const [p, j2] = this.opt(nodes, j); if (p) { pos = this.str(p).trim()[0] || "c"; j = j2; } }
  const [a, j3] = this.arg(nodes, j);
  const al = pos === "l" ? "left" : pos === "r" ? "right" : pos === "s" ? "justify" : "center";
  flow.html('<span class="' + (framed ? "tex-fbox mkbox" : "mkbox") + '" style="' + (w ? "width:" + w + ";" : "") + "text-align:" + al + '">' + this.inline(a, ctx) + "</span>", ctx.st);
  return j3;
};
Renderer.prototype.dimen = function (nodes, i) {   // a TeX <dimen> written as characters: "1.5em plus 1pt minus .5pt"
  let j = i + 1;
  const read = () => {     // the next word of [-+0-9.a-zA-Z] after spaces -> [word, index of its last node]
    let q = j; while (q < nodes.length && this.isSp(nodes[q])) q++;
    let w = "", last = -1;
    while (q < nodes.length && nodes[q].t === "x" && !isCs(nodes[q].v) && catOf(nodes[q].v) !== CAT.SPACE && /[-+0-9.a-zA-Z]/.test(String.fromCodePoint(codeOf(nodes[q].v))) && w.length < 40) { w += String.fromCodePoint(codeOf(nodes[q].v)); last = q; q++; }
    return [w, last];
  };
  const UNIT = /^(pt|mm|cm|in|em|ex|bp|pc|sp|px|fil)/;
  let [w, last] = read(); if (!w) return ["", i];
  let dim = w; j = last + 1;
  if (/^[-+0-9.]+$/.test(w)) { const [u, l2] = read(); if (UNIT.test(u)) { dim += u; last = l2; j = l2 + 1; } }
  for (let g = 0; g < 2; g++) {
    const [kw, l3] = read(); if (!/^(plus|minus)$/i.test(kw)) break;
    last = l3; j = l3 + 1;
    const [v, l4] = read(); if (!v) break; last = l4; j = l4 + 1;
    if (/^[-+0-9.]+$/.test(v)) { const [u, l5] = read(); if (UNIT.test(u)) { last = l5; j = l5 + 1; } }
  }
  return [dim, last];
};
Renderer.prototype.charCode = function (s) {
  s = s.trim(); let m;
  if ((m = /^"([0-9A-Fa-f]+)$/.exec(s))) return parseInt(m[1], 16) <= 0x10ffff ? parseInt(m[1], 16) : null;
  if ((m = /^'([0-7]+)$/.exec(s))) return parseInt(m[1], 8);
  if ((m = /^`\\?(.)$/u.exec(s))) return m[1].codePointAt(0);
  if ((m = /^([0-9]+)$/.exec(s))) return parseInt(m[1], 10) <= 0x10ffff ? parseInt(m[1], 10) : null;
  return null;
};
Renderer.prototype.colorOf = function (name, model) {
  if (model) return this.parseColor(model.trim(), name);
  if (Object.hasOwn(this.colors, name)) return this.colors[name];
  if (Object.hasOwn(COLORS, name)) return COLORS[name];
  const m = /^([a-z]+)!(\d{1,3})$/.exec(name); if (m && Object.hasOwn(COLORS, m[1])) return COLORS[m[1]];
  return null;
};
Renderer.prototype.parseColor = function (model, spec) {
  const nums = String(spec).split(",").map((x) => parseFloat(x));
  const ok = (a, n, max) => a.length === n && a.every((x) => Number.isFinite(x) && x >= 0 && x <= max);
  if (model === "rgb" && ok(nums, 3, 1)) return "rgb(" + nums.map((x) => Math.round(x * 255)).join(",") + ")";
  if (model === "RGB" && ok(nums, 3, 255)) return "rgb(" + nums.map((x) => Math.round(x)).join(",") + ")";
  if (model === "gray" && ok(nums, 1, 1)) { const g = Math.round(nums[0] * 255); return "rgb(" + g + "," + g + "," + g + ")"; }
  if (model === "HTML" && /^[0-9A-Fa-f]{6}$/.test(String(spec).trim())) return "#" + String(spec).trim();
  if (model === "cmyk" && ok(nums, 4, 1)) { const [c, m, y, k] = nums; return "rgb(" + [c, m, y].map((x) => Math.round(255 * (1 - x) * (1 - k))).join(",") + ")"; }
  return null;
};

// ------------------------------------------------------------------ picture -> SVG
class PicParser {
  constructor(R, kids, ctx) { this.R = R; this.k = kids; this.p = 0; this.ctx = ctx; this.lw = 0.4; this.items = []; this.u = R.unitlength; }
  sp() { while (this.p < this.k.length && (this.R.isSp(this.k[this.p]) || this.R.csName(this.k[this.p]) === "par")) this.p++; }
  ch(code) { this.sp(); if (this.R.isChar(this.k[this.p], code)) { this.p++; return true; } return false; }
  coord() {   // (x,y) -> [x, y] or null
    const save = this.p;
    if (!this.ch(40)) return null;
    let s = "";
    while (this.p < this.k.length && !this.R.isChar(this.k[this.p], 41)) { const n = this.k[this.p++]; s += n.t === "x" && !isCs(n.v) ? String.fromCodePoint(codeOf(n.v)) : ""; }
    this.p++;
    const parts = s.split(",").map((x) => parseFloat(x));
    if (parts.length !== 2 || !parts.every(Number.isFinite)) { this.p = save; return null; }
    return parts;
  }
  group() { this.sp(); const n = this.k[this.p]; if (n && n.t === "g") { this.p++; return n.kids; } if (n) { this.p++; return [n]; } return []; }
  optStr() { this.sp(); if (!this.R.isChar(this.k[this.p], 91)) return null; let s = ""; this.p++; while (this.p < this.k.length && !this.R.isChar(this.k[this.p], 93)) { const n = this.k[this.p++]; if (n.t === "x" && !isCs(n.v)) s += String.fromCodePoint(codeOf(n.v)); } this.p++; return s; }
  num(kids) { const v = parseFloat(this.R.str(kids)); return Number.isFinite(v) ? v : 0; }
  // one picture object at (x, y): returns nothing, appends SVG items (coordinates in picture units)
  object(x, y, kids, depth = 0) {
    if (depth > 4) return;
    const sub = new PicParser(this.R, kids, this.ctx); sub.u = this.u; sub.lw = this.lw;
    sub.sp();
    const nm = this.R.csName(sub.k[sub.p]);
    if (nm === "line" || nm === "vector") {
      sub.p++; const d = sub.coord(); const len = sub.num(sub.group());
      if (d) { const [dx, dy] = d; let ex, ey; if (dx === 0) { ex = 0; ey = Math.sign(dy) * len; } else { ex = Math.sign(dx) * len; ey = (dy / dx) * ex; } this.items.push({ t: nm, x1: x, y1: y, x2: x + ex, y2: y + ey, lw: this.lw }); }
    } else if (nm === "circle") {
      sub.p++; const fill = sub.ch(42); const d = sub.num(sub.group()); this.items.push({ t: "circle", x, y, r: d / 2, fill, lw: this.lw });
    } else if (nm === "oval") {
      sub.p++; const d = sub.coord(); const part = sub.optStr() || ""; if (d) this.items.push({ t: "oval", x, y, w: d[0], h: d[1], part, lw: this.lw });
    } else if (nm === "qbezier") {
      sub.p++; const a = sub.coord(), b = sub.coord(), c = sub.coord(); if (a && b && c) this.items.push({ t: "qb", a, b, c, lw: this.lw });
    } else if (nm === "makebox" || nm === "framebox" || nm === "dashbox") {
      sub.p++; const d = sub.coord(); sub.optStr(); const txt = this.R.inline(sub.group(), this.ctx); this.items.push({ t: "text", x: x + (d ? d[0] / 2 : 0), y: y + (d ? d[1] / 2 : 0), html: txt, anchor: "c", box: nm === "framebox" && d ? d : null });
    } else {
      const html = this.R.inline(kids, this.ctx);
      if (html.trim()) this.items.push({ t: "text", x, y, html, anchor: "bl" });
    }
  }
  render() {
    const size = this.coord() || [10, 10]; const off = this.coord() || [0, 0];
    let guard = 0;
    while (this.p < this.k.length && guard++ < 20000) {
      this.sp(); if (this.p >= this.k.length) break;
      const n = this.k[this.p]; const nm = this.R.csName(n);
      if (nm === "put") { this.p++; const c = this.coord(); const g = this.group(); if (c) this.object(c[0], c[1], g); continue; }
      if (nm === "multiput") { this.p++; const c = this.coord(); const d = this.coord(); const cnt = Math.min(500, Math.max(0, Math.floor(this.num(this.group())))); const g = this.group(); if (c && d) for (let q = 0; q < cnt; q++) this.object(c[0] + q * d[0], c[1] + q * d[1], g); continue; }
      if (nm === "qbezier") { this.object(0, 0, [n].concat(this.k.slice(this.p + 1, this.p + 1 + this.countCoords(this.p + 1, 3)))); this.p += 1 + this.countCoords(this.p + 1, 3); continue; }
      if (nm === "thicklines") { this.lw = 0.8; this.p++; continue; }
      if (nm === "thinlines") { this.lw = 0.4; this.p++; continue; }
      if (nm === "linethickness") { this.p++; const v = dimPt(this.R.str(this.group())); if (v !== null) this.lw = Math.max(0.05, Math.min(10, v)); continue; }
      if (nm === "setlength") { this.p++; const a = this.group(); const b = this.group(); if (this.R.str(a).trim() === "\\unitlength") { const v = dimPt(this.R.str(b)); if (v) this.u = v; } continue; }
      this.p++;
    }
    // SVG in pt (1 picture unit = this.u pt), y up
    const u = this.u, W = Math.max(1, size[0] * u), H = Math.max(1, size[1] * u), x0 = off[0], y0 = off[1];
    const X = (x) => ((x - x0) * u).toFixed(2), Y = (y) => (H - (y - y0) * u).toFixed(2);
    let svg = "", html = "";
    for (const it of this.items.slice(0, 5000)) {
      const sw = (it.lw || 0.4).toFixed(2);
      if (it.t === "line" || it.t === "vector") {
        svg += '<line x1="' + X(it.x1) + '" y1="' + Y(it.y1) + '" x2="' + X(it.x2) + '" y2="' + Y(it.y2) + '" stroke="currentColor" stroke-width="' + sw + '"' + (it.t === "vector" ? ' marker-end="url(#ah)"' : "") + "/>";
      } else if (it.t === "circle") {
        svg += '<circle cx="' + X(it.x) + '" cy="' + Y(it.y) + '" r="' + (it.r * u).toFixed(2) + '" ' + (it.fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="' + sw + '"') + "/>";
      } else if (it.t === "oval") {
        const w = it.w * u, h = it.h * u, r = Math.min(w, h) / 2, cx = +X(it.x), cy = +Y(it.y);
        const x1 = cx - w / 2, y1 = cy - h / 2;
        const part = it.part.replace(/[^tblr]/g, "");
        if (!part) svg += '<rect x="' + x1.toFixed(2) + '" y="' + y1.toFixed(2) + '" width="' + w.toFixed(2) + '" height="' + h.toFixed(2) + '" rx="' + r.toFixed(2) + '" fill="none" stroke="currentColor" stroke-width="' + sw + '"/>';
        else {
          const clipT = part.includes("t") ? 0 : part.includes("b") ? h / 2 : 0, clipH = part.includes("t") && !part.includes("b") ? h / 2 : part.includes("b") && !part.includes("t") ? h / 2 : h;
          const clipL = part.includes("l") && !part.includes("r") ? 0 : part.includes("r") && !part.includes("l") ? w / 2 : 0, clipW = (part.includes("l") !== part.includes("r")) ? w / 2 : w;
          const cid = "oc" + (++this.R.idn);
          svg += '<clipPath id="' + cid + '"><rect x="' + (x1 + clipL - sw).toFixed(2) + '" y="' + (y1 + clipT - sw).toFixed(2) + '" width="' + (clipW + 2 * sw).toFixed(2) + '" height="' + (clipH + 2 * sw).toFixed(2) + '"/></clipPath>';
          svg += '<rect clip-path="url(#' + cid + ')" x="' + x1.toFixed(2) + '" y="' + y1.toFixed(2) + '" width="' + w.toFixed(2) + '" height="' + h.toFixed(2) + '" rx="' + r.toFixed(2) + '" fill="none" stroke="currentColor" stroke-width="' + sw + '"/>';
        }
      } else if (it.t === "qb") {
        svg += '<path d="M' + X(it.a[0]) + " " + Y(it.a[1]) + " Q" + X(it.b[0]) + " " + Y(it.b[1]) + " " + X(it.c[0]) + " " + Y(it.c[1]) + '" fill="none" stroke="currentColor" stroke-width="' + sw + '"/>';
      } else if (it.t === "text") {
        const left = ((it.x - x0) * u).toFixed(2), bottom = ((it.y - y0) * u).toFixed(2);
        if (it.box) svg += '<rect x="' + X(it.x - it.box[0] / 2) + '" y="' + Y(it.y + it.box[1] / 2) + '" width="' + (it.box[0] * u).toFixed(2) + '" height="' + (it.box[1] * u).toFixed(2) + '" fill="none" stroke="currentColor" stroke-width="0.4"/>';
        html += '<span class="pictext' + (it.anchor === "c" ? " pc" : "") + '" style="left:' + left + "pt;bottom:" + bottom + 'pt">' + it.html + "</span>";
      }
    }
    return '<span class="picture" style="width:' + W.toFixed(2) + "pt;height:" + H.toFixed(2) + 'pt"><svg width="' + W.toFixed(2) + 'pt" height="' + H.toFixed(2) + 'pt" viewBox="0 0 ' + W.toFixed(2) + " " + H.toFixed(2) + '" overflow="visible">' +
      '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="currentColor"/></marker></defs>' + svg + "</svg>" + html + "</span>";
  }
  countCoords(from, n) { let q = from, seen = 0; while (q < this.k.length && seen < n) { if (this.R.isChar(this.k[q], 41)) seen++; q++; } return q - from; }
}

// ------------------------------------------------------------------ entry
export function render(events, intern, opts) {
  const R = new Renderer(opts);
  const chunks = R.run(events, intern);
  const unknown = [...R.unknown].sort((a, b) => b[1] - a[1]).slice(0, 40);
  return { chunks, chunkPos: R.chunkPos, sageItems: R.sageItems, sageStates: R.sageStates, imageRefs: [...R.imageRefs], inputMisses: R.inputMisses, frames: R.frameList, problems: R.problems, beamer: R.cls === "beamer", needBeamer: !beamer && (R.cls === "beamer" || !!R.needBeamer), stats: Object.assign({}, R.stats, { unknown, labels: R.labels.size, refs: R.refs.length, toc: R.toc.length, sageItems: R.sageItems.length }) };
}
