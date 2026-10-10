// Sagebrush's notebook: cells as in Jupyter (prompts, command and edit mode,
// Jupyter's keys, drag to reorder, + Code / + Text between cells), outputs
// (text, pictures, typeset math, 3D views, animations, @interact controls),
// Markdown cells with math, and Tab completion.  No framework: plain DOM in an
// element you give it.  Two plug-in points (web/notebook/types.ts):
//
//   - a Kernel runs code: WorkerKernel (worker-kernel.js) is Sagebrush in a
//     Web Worker, in this page; a CoCalc project kernel can be another.
//   - a Store keeps the document: IndexedDB, a file, CoCalc's Jupyter syncdb,
//     ...  attach(store) loads it, saves changes to it, and applies changes
//     from elsewhere (another tab, a collaborator, an agent) as they come.
//
//   const nb = createNotebook(document.querySelector("#cells"), { kernel, mode: "sage" });
//   await nb.attach(store);      // or nb.load(doc) and nb.on("change", (doc) => ...)
//
// See web/notebook/README.md.
import css from "./notebook.css" with { type: "text" };
import { render as renderMarkdown } from "../markdown.ts";
import { cellId } from "./ipynb.js";

export const SCENE3D = "application/vnd.sagebrush.scene3d+json";
const STOP_MESSAGE = "\nStopped (it did not respond to the interrupt, so the interpreter was restarted; variables are gone).\n";

// ------------------------------------------------------------ highlighting
// A small regex tokenizer for Python (and Sage's ^ and ^^): good enough for
// a notebook, and no dependency.
const KW = new Set("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case type self cls".split(" "));
const BI = new Set("abs all any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __import__ Exception ValueError TypeError KeyError IndexError StopIteration ZeroDivisionError ArithmeticError RuntimeError NotImplementedError AttributeError NameError".split(" "));
const SAGE_BI = new Set("factor is_prime is_prime_power is_square next_prime previous_prime nth_prime prime_range primes primes_first_n prime_pi divisors number_of_divisors sigma euler_phi moebius gcd lcm xgcd inverse_mod power_mod crt binomial factorial fibonacci isqrt sqrt srange prod continued_fraction numerator denominator valuation digits Rational Integer ZZ QQ RR n N".split(" "));
const TOKEN = /(#.*)|((?:\b[rRbBuUfFtT]{1,2})?(?:"""[\s\S]*?(?:"""|$(?![\s\S]))|'''[\s\S]*?(?:'''|$(?![\s\S]))|"(?:\\.|[^"\\\n])*(?:"|$)|'(?:\\.|[^'\\\n])*(?:'|$)))|(^[ \t]*@[\w.]+)|(\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?[jJ]?)\b)|([A-Za-z_]\w*)/gm;
export const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
export function highlight(src, sage) {
  let out = "", last = 0, prev = "";
  for (const m of src.matchAll(TOKEN)) {
    out += esc(src.slice(last, m.index));
    last = m.index + m[0].length;
    let cls = m[1] ? "hc" : m[2] ? "hs" : m[3] ? "hd" : m[4] ? "hn" : "";
    if (m[5]) {
      const w = m[5];
      cls = prev === "def" || prev === "class" ? "hf" : KW.has(w) ? "hk" : BI.has(w) || (sage && SAGE_BI.has(w)) ? "hb" : "";
      prev = w;
    }
    out += cls ? `<span class="${cls}">${esc(m[0])}</span>` : esc(m[0]);
  }
  return out + esc(src.slice(last)) + "\n"; // a final newline keeps the last line's height
}

// Markdown source, for the editor of a Markdown cell: headings, emphasis,
// code (fenced Python or Sage highlighted as code), links, HTML, and math
// ($...$, $$...$$, \(...\), \[...\]) with its TeX: delimiters, \commands,
// digits, letters and the {}^_& structure.  Colours only, so the text keeps
// the textarea's widths.
const MD = new RegExp([
  /^(```|~~~)([^\n]*)\n([\s\S]*?)(?:^(\1[ \t]*)$|$(?![\s\S]))/.source, // 1-4 fenced code
  /(\$\$[\s\S]*?(?:\$\$|$(?![\s\S]))|\\\[[\s\S]*?(?:\\\]|$(?![\s\S])))/.source, // 5 display math
  /(`+)([\s\S]*?)\6/.source, // 6-7 inline code
  /((?<![\\$])\$(?![\s$])(?:\\.|[^$\\\n])*?(?<!\s)\$|\\\((?:[^\n]|\n(?!\n))*?\\\))/.source, // 8 inline math
  /(^#{1,6}[ \t].*$)/.source, // 9 heading
  /(^[ \t]*(?:[-*+]|\d+[.)])(?=[ \t])|^[ \t]*>)/.source, // 10 list item, quote
  /(\*\*(?=\S)[^*\n]*?\S\*\*|__(?=\S)[^_\n]*?\S__|(?<![*\w])\*(?=\S)[^*\n]*?\S\*(?!\*)|(?<![_\w])_(?=\S)[^_\n]*?\S_(?![_\w]))/.source, // 11 emphasis
  /(!?\[)([^\]\n]*)(\]\()([^)\n]*)(\))/.source, // 12-16 link, image
  /(<\/?[A-Za-z][^>\n]*>|\\[\\`*_{}\[\]()#+\-.!$|])/.source, // 17 HTML, escape
].join("|"), "gm");
const span = (cls, text) => (text ? `<span class="${cls}">${esc(text)}</span>` : "");
function highlightTex(t) {
  // delimiters, then \commands, digits, letters and structure
  const m = /^(\$\$|\$|\\\[|\\\()([\s\S]*?)(\$\$|\$|\\\]|\\\))?$/.exec(t);
  const [open, body, close] = m ? [m[1], m[2], m[3] ?? ""] : ["", t, ""];
  const inner = body.replace(/(\\(?:[A-Za-z]+|.))|(\d+(?:\.\d+)?)|([A-Za-z]+)|([{}^_&])|([^\\\dA-Za-z{}^_&]+)/g,
    (_, c, d, l, st, o) => (c ? span("hk", c) : d ? span("hn", d) : l ? span("hb", l) : st ? span("hp", st) : esc(o)));
  return span("hd", open) + inner + span("hd", close);
}
export function highlightMarkdown(src, sage) {
  let out = "", last = 0;
  for (const m of src.matchAll(MD)) {
    out += esc(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) {
      const lang = m[2].trim().toLowerCase(), code = m[3];
      const body = /^(py|python|python3|sage|ipython|)$/.test(lang) ? highlight(code, sage || lang === "sage").slice(0, -1) : span("hs", code);
      out += span("hp", m[1] + m[2] + "\n") + body + span("hp", m[4] ?? "");
    } else if (m[5]) out += highlightTex(m[5]);
    else if (m[6]) out += span("hp", m[6]) + span("hs", m[7]) + span("hp", m[6]);
    else if (m[8]) out += highlightTex(m[8]);
    else if (m[9]) out += span("hf", m[9]);
    else if (m[10]) out += span("hk", m[10]);
    else if (m[11]) out += span("hk", m[11]);
    else if (m[12]) out += span("hp", m[12]) + span("hb", m[13]) + span("hp", m[14]) + span("hd", m[15]) + span("hp", m[16]);
    else if (m[17]) out += span("hd", m[17]);
    else out += esc(m[0]);
  }
  return out + esc(src.slice(last)) + "\n";
}

// ------------------------------------------------------------ page-wide pieces
let styled = false;
function addStyle() {
  if (styled || document.querySelector("style[data-sbnb]")) return;
  styled = true;
  const s = document.createElement("style");
  s.dataset.sbnb = "";
  s.textContent = css;
  document.head.prepend(s); // first: the page's own styles win
}
const h = (tag, cls, props = {}) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, props);

// SVG from Python code is put in the page only after removing anything
// active (scripts, event handlers, external links), with its ids made
// unique so that several plots' clip paths cannot collide.
const SVG_TAGS = new Set("svg g path line polyline polygon circle ellipse rect text tspan title desc defs clipPath linearGradient radialGradient stop use marker symbol mask pattern".split(" "));
let svgCount = 0;
export function safeSvg(text) {
  const root = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
  if (root.localName !== "svg") return null;
  const pre = `s${++svgCount}-`;
  const clean = (el) => {
    for (const child of [...el.children]) {
      if (SVG_TAGS.has(child.localName)) clean(child); else child.remove();
    }
    for (const { name, value } of [...el.attributes]) {
      const n = name.toLowerCase();
      if (n.startsWith("on") || /javascript:|data:|@import|expression\(/i.test(value)) el.removeAttribute(name);
      else if (n === "href" || n === "xlink:href") value.startsWith("#") ? el.setAttribute(name, "#" + pre + value.slice(1)) : el.removeAttribute(name);
      else if (n === "id") el.setAttribute(name, pre + value);
      else if (/url\(/i.test(value)) /url\(\s*#/i.test(value) ? el.setAttribute(name, value.replace(/url\(\s*#/gi, "url(#" + pre)) : el.removeAttribute(name);
    }
  };
  clean(root);
  return document.importNode(root, true);
}

// An animation (an SVG with one <g class="sb-frame"> per frame): play/pause,
// a frame slider and speed.  Without this page the SVG plays itself by CSS.
function player(fig, svg) {
  const frames = [...svg.querySelectorAll(":scope > g.sb-frame")];
  if (!frames.length) return;
  const delay = +svg.dataset.delay || 200, iterations = +svg.dataset.iterations || 0;
  const bar = fig.appendChild(h("div", "player"));
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Animation controls");
  const btn = bar.appendChild(document.createElement("button"));
  const range = bar.appendChild(h("input", "", { type: "range", min: 0, max: frames.length - 1, step: 1, value: 0 }));
  range.setAttribute("aria-label", "Frame");
  const label = bar.appendChild(document.createElement("output"));
  const speed = bar.appendChild(document.createElement("select"));
  speed.setAttribute("aria-label", "Speed");
  for (const v of [0.25, 0.5, 1, 2, 4]) speed.add(new Option(v + "×", v, false, v === 1));
  let i = 0, timer = null, loops = 0;
  const show = (k) => {
    i = k;
    frames.forEach((f, j) => { f.style.animation = "none"; f.style.visibility = j === k ? "visible" : "hidden"; });
    range.value = k;
    label.textContent = `${k + 1} / ${frames.length}`;
  };
  const stopPlay = () => { clearInterval(timer); timer = null; btn.textContent = "▶"; btn.setAttribute("aria-label", "Play"); };
  const play = () => {
    stopPlay();
    btn.textContent = "❚❚";
    btn.setAttribute("aria-label", "Pause");
    loops = 0;
    timer = setInterval(() => {
      if (!fig.isConnected) return stopPlay();
      if (i + 1 < frames.length) return show(i + 1);
      if (iterations && ++loops >= iterations) return stopPlay();
      show(0);
    }, delay / +speed.value);
  };
  btn.onclick = () => (timer ? stopPlay() : play());
  range.oninput = () => { stopPlay(); show(+range.value); };
  speed.onchange = () => { if (timer) play(); };
  show(0);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) stopPlay(); else play();
}

// Coordinates under the mouse, for plots made by _graphics (each panel
// carries its data ranges and pixel box): one tooltip for the page.
let tipInstalled = false;
function installPlotTip() {
  if (tipInstalled) return;
  tipInstalled = true;
  const tip = document.body.appendChild(h("div", "sbnb-pop sbnb-tip", { hidden: true }));
  let cross = null;
  const hide = () => { tip.hidden = true; cross?.remove(); cross = null; };
  const fmt = (v) => String(+v.toPrecision(5));
  document.addEventListener("pointermove", (e) => {
    const svg = e.target.closest?.("svg.sb-plot");
    const ctm = svg?.getScreenCTM();
    if (!ctm) return hide();
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    for (const g of svg.querySelectorAll("g.sb-panel")) {
      const [bx, by, bw, bh] = g.dataset.box.split(" ").map(Number);
      if (pt.x < bx || pt.x > bx + bw || pt.y < by || pt.y > by + bh) continue;
      const [x0, x1] = g.dataset.xr.split(" ").map(Number), [y0, y1] = g.dataset.yr.split(" ").map(Number);
      const at = (a, b, f, log) => (log ? 10 ** (Math.log10(a) + f * (Math.log10(b) - Math.log10(a))) : a + f * (b - a));
      const x = at(x0, x1, (pt.x - bx) / bw, g.dataset.xlog), y = at(y0, y1, 1 - (pt.y - by) / bh, g.dataset.ylog);
      tip.textContent = `x = ${fmt(x)}, y = ${fmt(y)}`;
      tip.hidden = false;
      tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 4) + "px";
      tip.style.top = e.clientY + 16 + "px";
      if (!cross || cross.ownerSVGElement !== svg) {
        cross?.remove();
        cross = svg.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "path"));
        cross.setAttribute("stroke", "currentColor");
        cross.setAttribute("stroke-opacity", "0.35");
        cross.setAttribute("stroke-dasharray", "3,3");
        cross.setAttribute("pointer-events", "none");
      }
      cross.setAttribute("d", `M${pt.x} ${by}V${by + bh}M${bx} ${pt.y}H${bx + bw}`);
      return;
    }
    hide();
  });
}

const TRASH_SVG = '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" d="M2.5 4h11M6 4V2.5h4V4M4 4l.8 9.5h6.4L12 4M6.8 6.5v5M9.2 6.5v5"/></svg>';
const MENU_HTML = `<button role="menuitem" data-m="above">Insert cell above <kbd>A</kbd></button><button role="menuitem" data-m="below">Insert cell below <kbd>B</kbd></button><hr>
<button role="menuitem" data-m="up">Move up <kbd>Alt+↑</kbd></button><button role="menuitem" data-m="down">Move down <kbd>Alt+↓</kbd></button><hr>
<button role="menuitem" data-m="type">Change to Markdown</button><button role="menuitem" data-m="split">Split at the cursor <kbd>Ctrl+;</kbd></button><button role="menuitem" data-m="clear">Clear output</button><button role="menuitem" data-m="delete" class="danger">Delete cell <kbd>D D</kbd></button>`;
const k = (...keys) => keys.map((x) => `<kbd>${x}</kbd>`).join("+");
const KEYS_HTML = `<form method="dialog"><b>Keyboard shortcuts</b><button aria-label="Close">✕</button></form>
<p>As in Jupyter: ${k("Esc")} leaves the editor for <b>command mode</b>, where single keys act on cells; ${k("Enter")} goes back to editing.</p>
<div class="cols"><div><h3>Both modes</h3><table>
<tr><td>${k("Shift", "Enter")}</td><td>run the cell, go to the next</td></tr>
<tr><td>${k("Ctrl", "Enter")}</td><td>run the cell</td></tr>
<tr><td>${k("Alt", "Enter")}</td><td>run, insert a cell below</td></tr>
<tr><td>${k("Alt", "↑")} ${k("↓")}</td><td>move the cell up or down</td></tr></table>
<h3>Edit mode</h3><table>
<tr><td>${k("Esc")} or ${k("Ctrl", "M")}</td><td>command mode</td></tr>
<tr><td>${k("↑")} ${k("↓")} at the first or last line</td><td>previous or next cell</td></tr>
<tr><td>${k("Tab")}</td><td>complete a name, or indent</td></tr>
<tr><td>${k("Shift", "Tab")}</td><td>dedent</td></tr>
<tr><td>${k("Ctrl", "]")} ${k("[")}</td><td>indent, dedent</td></tr>
<tr><td>${k("Ctrl", "/")}</td><td>comment or uncomment lines</td></tr>
<tr><td>${k("Ctrl", "Shift", "-")} or ${k("Ctrl", ";")}</td><td>split the cell at the cursor</td></tr></table></div>
<div><h3>Command mode</h3><table>
<tr><td>${k("Enter")}</td><td>edit the cell</td></tr>
<tr><td>${k("↑")} ${k("↓")} or ${k("K")} ${k("J")}</td><td>select the cell above or below</td></tr>
<tr><td>${k("A")} ${k("B")}</td><td>insert a cell above, below</td></tr>
<tr><td>${k("D")} ${k("D")}</td><td>delete the cell</td></tr>
<tr><td>${k("Z")}</td><td>undo the cell deletion</td></tr>
<tr><td>${k("X")} ${k("C")} ${k("V")}</td><td>cut, copy, paste below (${k("Shift", "V")}: above)</td></tr>
<tr><td>${k("M")} ${k("Y")}</td><td>to Markdown, to code</td></tr>
<tr><td>${k("Shift", "M")}</td><td>merge with the cell below</td></tr>
<tr><td>${k("I")} ${k("I")}</td><td>interrupt</td></tr>
<tr><td>${k("0")} ${k("0")}</td><td>restart the interpreter</td></tr>
<tr><td>${k("H")}</td><td>this list</td></tr></table></div></div>
<p>Drag a cell by its prompt (or the ⠿ handle) to move it. On a Mac, ${k("Cmd")} works where ${k("Ctrl")} is shown.</p>`;

/**
 * A notebook in `root`.
 * @param {HTMLElement} root
 * @param {object} [opts]
 * @param {import("./types").Kernel} [opts.kernel] runs code (none: cells cannot run)
 * @param {"python"|"sage"|"magma"} [opts.mode]
 * @param {string} [opts.assetBase] where sagebrush-math.js and sagebrush-viewer3d.js are (default: the page)
 * @param {boolean} [opts.readOnly]
 * @returns {import("./types").Notebook}
 */
export function createNotebook(root, opts = {}) {
  addStyle();
  installPlotTip();
  const kernel = opts.kernel ?? null;
  const asset = (name) => new URL(name, new URL(opts.assetBase ?? "./", location.href)).href;
  let mode = opts.mode ?? "python";
  let meta = {}; // the document's other fields (name, ...), kept as they are
  let execCount = 0;
  const listeners = {};
  const emit = (event, ...args) => { for (const f of listeners[event] ?? []) f(...args); };
  const isSage = () => mode === "sage";
  const isMagma = () => mode === "magma";

  root.classList.add("sbnb");
  root.replaceChildren();
  const cellsEl = root.appendChild(h("div", "cells"));
  const addend = root.appendChild(h("div", "addend"));
  addend.append(h("button", "", { textContent: "+ Code", title: "Add a code cell at the end", onclick: () => addCell("", null, true) }),
    h("button", "", { textContent: "+ Text", title: "Add a Markdown (text) cell at the end", onclick: () => addCell("", null, true, "markdown") }));
  const live = root.appendChild(h("div", "sbnb-sr"));
  live.setAttribute("aria-live", "polite");
  const announce = (text) => (live.textContent = text);
  const completer = document.body.appendChild(h("ul", "sbnb-pop sbnb-completer", { hidden: true }));
  completer.setAttribute("role", "listbox");
  completer.setAttribute("aria-label", "Completions");
  const menu = document.body.appendChild(h("div", "sbnb-pop sbnb-menu", { hidden: true, innerHTML: MENU_HTML }));
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Cell actions");
  const dropline = document.body.appendChild(h("div", "sbnb-pop sbnb-dropline", { hidden: true }));
  const keysDlg = document.body.appendChild(h("dialog", "sbnb-pop sbnb-keys", { innerHTML: KEYS_HTML }));
  keysDlg.setAttribute("aria-label", "Keyboard shortcuts");
  root.classList.toggle("readonly", !!opts.readOnly);

  const cells = () => [...cellsEl.children].map((el) => el.cell).filter(Boolean);
  const index = (cell) => cells().indexOf(cell);
  function paint(cell) {
    cell.hl.innerHTML = cell.type === "code" ? highlight(cell.ta.value, isSage()) : cell.type === "markdown" ? highlightMarkdown(cell.ta.value, isSage()) : esc(cell.ta.value) + "\n";
  }

  // ---------------------------------------------------------- output areas
  // Text goes into <pre> runs; pictures (Jupyter MIME bundles) into <figure>s.
  function appendText(box, text, isErr) {
    let pre = box.lastElementChild;
    if (!pre || pre.tagName !== "PRE" || pre.sbBundle) pre = box.appendChild(h("pre", "txt"));
    pre.appendChild(isErr ? h("span", "e", { textContent: text }) : document.createTextNode(text));
  }
  // 3D graphics: an interactive WebGL view (web/viewer3d.js, loaded on first
  // use) over the SVG, which stays for saving, agents and when WebGL fails.
  let viewer3d = null;
  function mount3d(fig, sceneText) {
    viewer3d ??= import(asset("sagebrush-viewer3d.js")).then(() => window.SagebrushViewer3d);
    viewer3d.then((v) => v?.mount(fig, JSON.parse(sceneText))).catch(() => {});
  }
  let mathModule = null;
  const loadMath = () => (mathModule ??= import(asset("sagebrush-math.js")));
  // Typeset math (show(expr), integrate_steps): text/latex through KaTeX,
  // with the text form until KaTeX has loaded (and if it cannot).
  function appendLatex(box, b) {
    const tex = b["text/latex"].trim().replace(/^\$\$([\s\S]*)\$\$$|^\$([\s\S]*)\$$/, (_, d, i) => d ?? i);
    const el = h("div", "latex-out");
    el.sbBundle = { "text/latex": b["text/latex"], "text/plain": b["text/plain"] ?? tex, "application/vnd.sagebrush.typeset": "1" };
    const m = h("div", "math display", { textContent: b["text/plain"] ?? tex });
    m.dataset.tex = tex;
    el.appendChild(m);
    box.appendChild(el);
    loadMath().then((mm) => mm.typeset(el)).catch(() => {});
  }
  function appendDisplay(box, b) {
    if (b["text/latex"] && b["application/vnd.sagebrush.typeset"]) return appendLatex(box, b);
    const fig = h("figure", "plot");
    const svg = b["image/svg+xml"] && safeSvg(b["image/svg+xml"]);
    if (svg && b[SCENE3D]) {
      fig.classList.add("plot3d");
      fig.sbBundle = { [SCENE3D]: b[SCENE3D], "image/svg+xml": b["image/svg+xml"], "text/plain": b["text/plain"] ?? "3D plot" };
      fig.appendChild(svg);
      box.appendChild(fig);
      mount3d(fig, b[SCENE3D]);
      return;
    }
    const raster = b["image/png"] ? ["image/png", b["image/png"]] : b["image/jpeg"] ? ["image/jpeg", b["image/jpeg"]] : null;
    if (svg) {
      fig.appendChild(svg);
      if (svg.classList.contains("sb-anim")) player(fig, svg);
    }
    else if (raster) fig.appendChild(Object.assign(new Image(), { src: `data:${raster[0]};base64,${raster[1]}`, alt: b["text/plain"] || "image" }));
    else {
      // nothing to draw: shown as text (JSON pretty-printed), and the whole
      // bundle kept for saving (an application/json result was saved as its
      // text repr only: the systematic review's R2-DOC-F2)
      const json = b["application/json"];
      let text = b["text/plain"] ?? "";
      if (json !== undefined) {
        try {
          text = JSON.stringify(typeof json === "string" ? JSON.parse(json) : json, null, 2);
        } catch {}
      }
      const el = h("pre", "txt rich-out", { textContent: text + "\n" });
      el.sbBundle = { ...b };
      box.appendChild(el);
      return;
    }
    box.appendChild(fig);
  }
  // nbformat keeps JSON MIME types (application/json, */*+json) as JSON
  const isJsonMime = (k) => k === "application/json" || k.endsWith("+json");
  // Where output goes: {out, display, interact, clear} for a box.
  function areaSink(box) {
    if (!box) return null;
    return {
      out: (text, isErr) => appendText(box, text, isErr),
      display: (b) => appendDisplay(box, b),
      interact: (spec) => renderInteract(box, spec),
      clear: () => box.replaceChildren(),
    };
  }

  // A cell's output as Jupyter outputs (stream and display_data).
  function saveOutputs(box) {
    // outputs loaded from a file and not changed since are saved as they
    // were: every MIME type, metadata, errors and execution counts (the
    // page shows only some of them)
    const L = box?.sbLoaded;
    if (L && box.children.length === L.els.length && L.els.every((e, i) => box.children[i] === e) && box.textContent === L.text) {
      return JSON.parse(L.json);
    }
    const outs = [];
    const stream = (name, text) => {
      const last = outs.at(-1);
      if (last?.output_type === "stream" && last.name === name) last.text += text;
      else outs.push({ output_type: "stream", name, text });
    };
    for (const el of box?.children ?? []) {
      if (el.tagName === "PRE" && el.sbBundle) {
        const data = {};
        for (const [k, v] of Object.entries(el.sbBundle)) {
          data[k] = v;
          if (isJsonMime(k) && typeof v === "string") {
            try {
              data[k] = JSON.parse(v);
            } catch {}
          }
        }
        outs.push({ output_type: "display_data", data, metadata: {} });
      } else if (el.tagName === "PRE") {
        for (const n of el.childNodes) stream(n.nodeType === 1 && n.classList.contains("e") ? "stderr" : "stdout", n.textContent);
      } else if ((el.tagName === "FIGURE" || el.classList.contains("latex-out")) && el.sbBundle) {
        // a big 3D scene (a mesh of millions of triangles) is not kept with the
        // notebook: its picture is, and running the cell again restores the view
        const b = { ...el.sbBundle };
        if ((b[SCENE3D]?.length ?? 0) > 8e6) delete b[SCENE3D];
        outs.push({ output_type: "display_data", data: b, metadata: {} });
      } else if (el.tagName === "FIGURE") {
        const svg = el.querySelector("svg"), img = el.querySelector("img"), data = {};
        if (svg) { data["image/svg+xml"] = new XMLSerializer().serializeToString(svg); data["text/plain"] = svg.getAttribute("aria-label") || "picture"; }
        else if (img) { const [head, b64] = img.src.split(","); data[head.slice(5, head.indexOf(";"))] = b64; data["text/plain"] = img.alt; }
        outs.push({ output_type: "display_data", data, metadata: {} });
      } else if (el.classList.contains("interact")) {
        stream("stdout", "[interactive controls: run the cell to use them]\n");
        outs.push(...saveOutputs(el.querySelector(".iout")));
      }
    }
    return outs;
  }
  const joinText = (t) => (Array.isArray(t) ? t.join("") : t ?? "");
  function loadOutputs(box, outs) {
    loadOutputsInto(box, outs);
    if (box) box.sbLoaded = { json: JSON.stringify(outs ?? []), els: [...box.children], text: box.textContent };
  }
  function loadOutputsInto(box, outs) {
    for (const o of outs ?? []) {
      if (o.output_type === "stream") appendText(box, joinText(o.text), o.name === "stderr");
      else if (o.output_type === "error") appendText(box, (o.traceback ?? []).join("\n").replace(/\x1b\[[0-9;]*m/g, "") + "\n", true);
      else if (o.data) {
        const b = {};
        for (const [key, v] of Object.entries(o.data)) b[key] = joinText(v);
        if (Object.keys(b).every((k) => k === "text/plain")) appendText(box, (b["text/plain"] ?? "") + "\n", false);
        else appendDisplay(box, b);
      }
    }
  }

  // ---------------------------------------------------------- @interact
  // Controls drawn from the kernel's spec; each change reruns the function
  // (one update in flight at a time, always with the latest values), and its
  // new output replaces the old in one step, so dragging a slider does not flicker.
  const interacts = new Map(); // "generation:id" -> state
  let controlCount = 0;
  const generation = () => kernel?.generation ?? 0;
  function interactBox(iid) {
    const it = interacts.get(generation() + ":" + iid);
    return it ? (it.buffer ?? it.out) : null;
  }
  if (kernel) kernel.targetSink = (target) => areaSink(interactBox(target));
  const forgetInteracts = (box) => box.querySelectorAll(".interact").forEach((el) => interacts.delete(el.dataset.key));
  function renderInteract(box, spec) {
    const it = { iid: spec.id, gen: generation(), name: spec.name, values: {}, setters: {}, busy: false, dirty: false, buffer: null, waiters: [] };
    const el = h("div", "interact");
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", `Controls of ${spec.name}`);
    const form = el.appendChild(h("div", "controls"));
    for (const c of spec.controls) control(form, c, it);
    it.out = el.appendChild(h("div", "iout"));
    it.out.setAttribute("aria-live", "polite");
    box.appendChild(el);
    el.dataset.key = it.gen + ":" + it.iid;
    interacts.set(el.dataset.key, it);
  }
  function control(form, c, it) {
    const id = `sbnb-ctl${++controlCount}`;
    const set = (v) => { it.values[c.name] = v; changed(it); };
    it.values[c.name] = c.value;
    if (c.kind === "text") return form.appendChild(h("div", "note", { textContent: c.value }));
    form.appendChild(h("label", "", { htmlFor: id, textContent: c.label }));
    const v = form.appendChild(h("div", "v"));
    if (c.kind === "slider" || c.kind === "range") {
      const fmt = (x) => (c.labels ? c.labels[x] : c.ints ? String(Math.round(x)) : String(+(+x).toPrecision(6)));
      const one = (val, suffix) => {
        const inp = h("input", "", { type: "range", id: id + suffix, min: c.min, max: c.max, step: c.step, value: val });
        inp.setAttribute("aria-valuetext", fmt(val));
        return inp;
      };
      const show = document.createElement("output");
      if (c.kind === "slider") {
        // ▶ steps the slider through its values, rerunning the function for
        // each one as fast as it computes (at most 30 frames a second)
        const playBtn = v.appendChild(h("button", "play", { textContent: "▶" }));
        playBtn.setAttribute("aria-label", `Play ${c.label}`);
        const inp = v.appendChild(one(c.value, ""));
        v.appendChild(show).textContent = fmt(c.value);
        const update = (x) => { inp.value = x; show.textContent = fmt(x); inp.setAttribute("aria-valuetext", fmt(x)); };
        let playing = false;
        const halt = () => { playing = false; playBtn.textContent = "▶"; playBtn.setAttribute("aria-label", `Play ${c.label}`); };
        const step = () => {
          if (!playing || !inp.isConnected || it.gen !== generation()) return halt();
          let x = +inp.value + +c.step;
          if (x > +c.max + 1e-9 * Math.abs(+c.step)) x = +c.min;
          update(x);
          const t0 = performance.now();
          it.waiters.push(() => setTimeout(step, Math.max(0, 33 - (performance.now() - t0))));
          set(+x);
        };
        playBtn.onclick = () => { if (playing) return halt(); playing = true; playBtn.textContent = "❚❚"; playBtn.setAttribute("aria-label", `Pause ${c.label}`); step(); };
        inp.oninput = () => { halt(); update(inp.value); set(+inp.value); };
        it.setters[c.name] = (x) => { update(x); it.values[c.name] = +x; };
      } else {
        const lo = v.appendChild(one(c.value[0], "")), hi = v.appendChild(one(c.value[1], "b"));
        hi.setAttribute("aria-label", c.label + " upper");
        v.appendChild(show).textContent = `${fmt(c.value[0])} – ${fmt(c.value[1])}`;
        const read = () => { const a = Math.min(+lo.value, +hi.value), b = Math.max(+lo.value, +hi.value); show.textContent = `${fmt(a)} – ${fmt(b)}`; return [a, b]; };
        lo.oninput = hi.oninput = () => set(read());
        it.setters[c.name] = (x) => { lo.value = x[0]; hi.value = x[1]; it.values[c.name] = read(); };
      }
    } else if (c.kind === "selector" && c.buttons) {
      const seg = v.appendChild(h("div", "seg", { id }));
      seg.setAttribute("role", "group");
      seg.setAttribute("aria-label", c.label);
      const buttons = c.options.map((o, i) => {
        const b = seg.appendChild(h("button", "", { textContent: o }));
        b.setAttribute("aria-pressed", String(i === c.value));
        b.onclick = () => { press(i); set(i); };
        return b;
      });
      const press = (i) => buttons.forEach((b, j) => b.setAttribute("aria-pressed", String(i === j)));
      it.setters[c.name] = (i) => { press(+i); it.values[c.name] = +i; };
    } else if (c.kind === "selector") {
      const sel = v.appendChild(h("select", "", { id }));
      c.options.forEach((o, i) => sel.add(new Option(o, i, false, i === c.value)));
      sel.onchange = () => set(+sel.value);
      it.setters[c.name] = (i) => { sel.value = i; it.values[c.name] = +i; };
    } else if (c.kind === "checkbox") {
      const box = v.appendChild(h("input", "", { type: "checkbox", id, checked: !!c.value }));
      box.onchange = () => set(box.checked);
      it.setters[c.name] = (x) => { box.checked = !!x; it.values[c.name] = !!x; };
    } else if (c.kind === "color") {
      const inp = v.appendChild(h("input", "", { type: "color", id, value: c.value }));
      inp.oninput = () => set(inp.value);
      it.setters[c.name] = (x) => { inp.value = x; it.values[c.name] = x; };
    } else {
      const inp = v.appendChild(h("input", "", { type: "text", id, value: c.value, spellcheck: false }));
      inp.onchange = () => set(inp.value);
      it.setters[c.name] = (x) => { inp.value = x; it.values[c.name] = String(x); };
    }
  }
  function changed(it) {
    if (!kernel || it.gen !== generation()) {
      it.out.replaceChildren();
      appendText(it.out, "The interpreter restarted: run this cell again.\n", true);
      for (const w of it.waiters.splice(0)) w();
      return;
    }
    if (it.busy) { it.dirty = true; return; }
    it.busy = true;
    it.buffer = document.createElement("div");
    const finish = () => {
      it.busy = false;
      if (it.dirty) { it.dirty = false; return changed(it); }
      for (const w of it.waiters.splice(0)) w();
    };
    kernel.interact(it.iid, it.values, {
      start() {},
      ...areaSink(it.buffer),
      done() { it.out.replaceChildren(...it.buffer.childNodes); it.buffer = null; finish(); },
      stopped(message) { it.buffer = null; appendText(it.out, message, true); it.dirty = false; finish(); },
    });
  }

  // ---------------------------------------------------------- running cells
  function settle(cell) {
    clearInterval(cell.timer);
    cell.runb.textContent = "▶";
    cell.el.classList.remove("queued", "running");
  }
  function run(cell) {
    if (cell.type === "markdown") return renderMd(cell);
    if (cell.type === "raw") return Promise.resolve(); // raw text is not run
    if (cell.el.classList.contains("queued") || cell.el.classList.contains("running")) return Promise.resolve();
    forgetInteracts(cell.out);
    cell.out.textContent = "";
    cell.time.textContent = "";
    if (!kernel) { appendText(cell.out, "(no kernel: this notebook cannot run code)\n", true); return Promise.resolve(); }
    cell.el.classList.add("queued");
    cell.n.textContent = "[*]";
    cell.runb.textContent = "■";
    let failed = false;
    return new Promise((resolve) => kernel.execute(cell.ta.value, { mode }, {
      start() {
        cell.el.classList.replace("queued", "running");
        const t0 = performance.now();
        cell.timer = setInterval(() => { cell.time.textContent = `running… ${((performance.now() - t0) / 1000).toFixed(1)} s`; }, 250);
      },
      ...areaSink(cell.out),
      out(text, isErr) { failed ||= isErr; appendText(cell.out, text, isErr); },
      done(ms) {
        settle(cell);
        cell.n.textContent = `[${++execCount}]`;
        cell.time.textContent = `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
        announce(`Cell ${index(cell) + 1} ${failed ? "raised an error" : "finished"}`);
        resolve();
      },
      stopped(message) {
        settle(cell);
        cell.n.textContent = "[ ]";
        cell.time.textContent = "";
        if (message) appendText(cell.out, message, true);
        resolve();
      },
      skipped() { settle(cell); cell.n.textContent = "[ ]"; resolve(); },
    }));
  }
  const runAll = () => Promise.all(cells().map(run)); // the kernel runs them in order
  const interrupt = () => kernel?.interrupt(STOP_MESSAGE);
  function clearOutputs() {
    for (const c of cells()) if (c.type === "code") { forgetInteracts(c.out); c.out.textContent = ""; c.time.textContent = ""; c.n.textContent = "[ ]"; }
  }
  kernel?.on("restart", () => { execCount = 0; });

  function autosize(ta) {
    if (!ta.offsetParent) return; // hidden: measured when it shows (the ResizeObserver below)
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }
  // Wrapped lines change with the width (phone rotation) and the font (web
  // fonts load after the first layout), so size every editor again then.
  let resizing = 0;
  const resizeAll = () => {
    cancelAnimationFrame(resizing);
    resizing = requestAnimationFrame(() => cellsEl.querySelectorAll(".ed textarea").forEach(autosize));
  };
  addEventListener("resize", resizeAll);
  document.fonts?.ready.then(resizeAll);
  // ...and when the notebook itself changes width, or shows after being hidden
  let lastWidth = -1;
  const sizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (w !== lastWidth) { lastWidth = w; if (w > 0) resizeAll(); }
  }) : null;
  sizeObserver?.observe(root);

  // ---------------------------------------------------------- Tab completion
  // Tab after a name or `obj.` asks the kernel (src/interactive.ts complete());
  // one match or a longer common prefix is inserted, several are listed below
  // the caret and filtered as you type: ↑/↓ choose, Tab/Enter accept, Esc closes.
  let comp = null; // { cell, start, matches, sel }
  function closeCompleter() {
    comp = null;
    completer.hidden = true;
    completer.textContent = "";
  }
  function caretBox(ta) {
    // a hidden copy of the editor text up to the caret, ending in a marker
    const pre = h("pre");
    pre.style.visibility = "hidden";
    pre.textContent = ta.value.slice(0, ta.selectionStart);
    const mark = pre.appendChild(h("span", "", { textContent: "​" }));
    ta.parentElement.appendChild(pre);
    const r = mark.getBoundingClientRect();
    pre.remove();
    return r;
  }
  function showCompleter() {
    const { cell, matches, sel, start } = comp;
    const word = cell.ta.value.slice(start, cell.ta.selectionStart);
    const dot = word.lastIndexOf(".") + 1; // list attribute names without `obj.`
    completer.innerHTML = matches.slice(0, 500).map((m, i) => `<li role="option" id="sbnb-comp${i}" aria-selected="${i === sel}">${esc(m.slice(dot))}</li>`).join("");
    completer.hidden = false;
    const r = caretBox(cell.ta);
    completer.style.left = Math.max(0, Math.min(r.left + scrollX, scrollX + document.documentElement.clientWidth - completer.offsetWidth - 4)) + "px";
    completer.style.top = r.bottom + scrollY + 2 + "px";
    cell.ta.setAttribute("aria-activedescendant", "sbnb-comp" + sel);
    completer.children[sel]?.scrollIntoView({ block: "nearest" });
  }
  function acceptCompletion(i = comp.sel) {
    const { cell, start, matches } = comp;
    const word = cell.ta.value.slice(start, cell.ta.selectionStart);
    closeCompleter();
    if (matches[i]?.startsWith(word)) document.execCommand("insertText", false, matches[i].slice(word.length));
  }
  // Re-filter the list as the word under the caret changes.
  function refilter(cell) {
    if (!comp || comp.cell !== cell) return;
    const word = cell.ta.value.slice(comp.start, cell.ta.selectionStart);
    if (cell.ta.selectionStart < comp.start || !/^[\w.]*$/.test(word) || word.lastIndexOf(".") !== comp.dot) return closeCompleter();
    comp.matches = comp.all.filter((m) => m.startsWith(word));
    if (!comp.matches.length) return closeCompleter();
    comp.sel = Math.min(comp.sel, comp.matches.length - 1);
    showCompleter();
  }
  async function tabComplete(cell) {
    const ta = cell.ta, pos = ta.selectionStart, value = ta.value;
    const before = value.slice(value.lastIndexOf("\n", pos - 1) + 1, pos);
    if (!kernel || ta.selectionEnd !== pos || !/[\w.]$/.test(before)) return false; // indent instead
    const m = await kernel.ask({ complete: before }, mode, {});
    if (ta.value !== value || ta.selectionStart !== pos || document.activeElement !== ta) return true; // stale
    const matches = m.matches ?? [], prefix = m.prefix ?? "";
    if (!matches.length) return true;
    let common = matches[0];
    for (const x of matches) while (!x.startsWith(common)) common = common.slice(0, -1);
    if (common.length > prefix.length) document.execCommand("insertText", false, common.slice(prefix.length));
    if (matches.length > 1) {
      comp = { cell, start: pos - prefix.length, all: matches, matches, sel: 0, dot: prefix.lastIndexOf(".") };
      showCompleter();
    }
    return true;
  }
  completer.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li");
    if (!li || !comp) return;
    e.preventDefault(); // keep the focus in the editor
    acceptCompletion([...completer.children].indexOf(li));
  });

  // ---------------------------------------------------------- cells, as in Jupyter
  // A cell is a gutter (the prompt [n]:, a run button, the drag handle), the
  // editor or its rendered Markdown, and the output; a toolbar shows at the top
  // right of the active or hovered cell, + Code / + Text below it.  Edit mode is
  // the focus in the editor; command mode (Esc) is the focus on the cell, where
  // single keys act on cells as in Jupyter (A, B, D D, M, Y, ...).
  function addCell(code = "", where = null, focus = false, type = "code", id = null) {
    const el = h("div", "cell");
    el.tabIndex = -1;
    el.setAttribute("role", "group");
    el.innerHTML = `<div class="gutter" draggable="true" title="Drag to move the cell"><span class="n">[ ]</span><button class="runb" data-a="run" draggable="false">▶</button></div>`
      + `<div class="body"><div class="ed"><pre aria-hidden="true"></pre><textarea rows="1" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea></div><div class="mdout" tabindex="0" title="Double-click or press Enter to edit"></div><div class="out"></div><div class="time"></div></div>`
      + `<div class="head" role="toolbar"><span class="drag" draggable="true" title="Drag to move the cell" aria-hidden="true">⠿</span><select data-a="type" aria-label="Cell type" title="Cell type (M: Markdown, Y: code, R: raw)"><option value="code">Code</option><option value="markdown">Markdown</option><option value="raw">Raw</option></select><button data-a="up" title="Move up (Alt+↑)" aria-label="Move up">↑</button><button data-a="down" title="Move down (Alt+↓)" aria-label="Move down">↓</button><button data-a="del" title="Delete (D D; Z undoes)" aria-label="Delete">${TRASH_SVG}</button><button data-a="menu" aria-haspopup="menu" aria-expanded="false" title="Cell actions">⋯</button></div>`
      + `<div class="adder"><button data-a="addcode" title="Insert a code cell below">+ Code</button><button data-a="addmd" title="Insert a Markdown (text) cell below">+ Text</button></div>`;
    const q = (s) => el.querySelector(s);
    const cell = { id: id ?? cellId(), el, type: "code", ta: q("textarea"), hl: q(".ed pre"), out: q(".out"), md: q(".mdout"), time: q(".time"), n: q(".n"), runb: q(".runb"), typeSel: q('[data-a="type"]'), menuBtn: q('[data-a="menu"]'), attachments: null, metadata: null };
    el.cell = cell;
    cell.md.addEventListener("dblclick", () => { if (!opts.readOnly) editMd(cell); });
    cell.ta.value = code;
    cell.ta.readOnly = !!opts.readOnly;
    cell.ta.addEventListener("input", () => { autosize(cell.ta); paint(cell); refilter(cell); });
    cell.ta.addEventListener("blur", () => { if (comp?.cell === cell) closeCompleter(); });
    cell.ta.addEventListener("click", () => { if (comp?.cell === cell) closeCompleter(); });
    cell.ta.addEventListener("keydown", (e) => editKey(cell, e));
    cell.runb.onclick = () => (el.classList.contains("running") || el.classList.contains("queued") ? interrupt() : run(cell));
    cell.menuBtn.onclick = () => openMenu(cell);
    cell.typeSel.onchange = () => { setType(cell, cell.typeSel.value); schedule(); edit(cell); };
    q('[data-a="up"]').onclick = () => move(cell, -1);
    q('[data-a="down"]').onclick = () => move(cell, 1);
    q('[data-a="del"]').onclick = () => remove(cell, true);
    q('[data-a="addcode"]').onclick = () => addCell("", { after: el }, true);
    q('[data-a="addmd"]').onclick = () => addCell("", { after: el }, true, "markdown");
    // a click on the gutter or the cell's margin selects it (command mode)
    el.addEventListener("click", (e) => { if (e.target === el || (e.target.closest(".gutter") && !e.target.closest("button"))) select(cell); });
    if (where?.before) where.before.before(el);
    else if (where?.after) where.after.after(el);
    else if (where?.first) cellsEl.prepend(el);
    else cellsEl.appendChild(el);
    setType(cell, type);
    autosize(cell.ta);
    paint(cell);
    relabel();
    if (focus) cell.ta.focus();
    return cell;
  }

  // The active cell (the bar on the left): the last one focused or clicked.
  let active = null;
  function activate(cell) {
    if (active === cell) return;
    active?.el.classList.remove("active");
    active = cell ?? null;
    active?.el.classList.add("active");
  }
  cellsEl.addEventListener("focusin", (e) => { const c = e.target.closest(".cell")?.cell; if (c) activate(c); });
  cellsEl.addEventListener("pointerdown", (e) => { const c = e.target.closest(".cell")?.cell; if (c) activate(c); });
  // command mode on a cell, or edit mode in it
  function select(cell) {
    if (!cell) return;
    activate(cell);
    (cell.el.classList.contains("rendered") ? cell.md : cell.el).focus({ preventScroll: true });
    cell.el.scrollIntoView({ block: "nearest" });
  }
  function edit(cell, where) {
    if (!cell) return;
    if (cell.el.classList.contains("rendered")) return select(cell); // rendered Markdown: Enter edits it
    cell.ta.focus({ preventScroll: true });
    if (where === "start") cell.ta.setSelectionRange(0, 0);
    else if (where === "end") cell.ta.setSelectionRange(cell.ta.value.length, cell.ta.value.length);
    cell.el.scrollIntoView({ block: "nearest" });
  }
  const prevCell = (cell) => cell.el.previousElementSibling?.cell;
  const nextCell = (cell) => cell.el.nextElementSibling?.cell;

  // The caret is on the first (last) visual row of the editor: ↑ (↓) leaves the cell.
  function atEdge(ta, up) {
    if (ta.selectionStart !== ta.selectionEnd) return false;
    const p = ta.selectionStart, v = ta.value;
    if (up ? v.lastIndexOf("\n", p - 1) >= 0 : v.indexOf("\n", p) >= 0) return false;
    const r = caretBox(ta), t = ta.getBoundingClientRect(), cs = getComputedStyle(ta), lh = parseFloat(cs.lineHeight) || 20;
    return up ? r.top - t.top < parseFloat(cs.paddingTop) + lh / 2 : t.bottom - r.bottom < parseFloat(cs.paddingBottom) + lh / 2 + 4;
  }

  // Line edits (indent, dedent, comment) on the lines the selection touches, undoably.
  function editLines(ta, f) {
    const v = ta.value, s0 = ta.selectionStart, s1 = ta.selectionEnd;
    const a = v.lastIndexOf("\n", s0 - 1) + 1;
    let b = v.indexOf("\n", s1 > s0 && v[s1 - 1] === "\n" ? s1 - 1 : s1);
    if (b < 0) b = v.length;
    const old = v.slice(a, b), next = f(old.split("\n")).join("\n");
    if (next === old) return;
    ta.setSelectionRange(a, b);
    document.execCommand(next ? "insertText" : "delete", false, next);
    if (s0 === s1 || !old.includes("\n")) { const p = Math.max(a, s0 + next.length - old.length); ta.setSelectionRange(p, p); }
    else ta.setSelectionRange(a, a + next.length);
  }
  const indentLines = (ls) => ls.map((l) => (l.trim() ? "    " + l : l));
  const dedentLines = (ls) => ls.map((l) => l.replace(/^( {1,4}|\t)/, ""));
  function commentLines(ls) {
    const cm = isMagma() ? "//" : "#", full = ls.filter((l) => l.trim());
    if (!full.length) return ls;
    if (full.every((l) => l.trimStart().startsWith(cm))) return ls.map((l) => l.replace(new RegExp(`^(\\s*)${cm} ?`), "$1"));
    const ind = Math.min(...full.map((l) => /^\s*/.exec(l)[0].length));
    return ls.map((l) => (l.trim() ? l.slice(0, ind) + cm + " " + l.slice(ind) : l));
  }

  // Split a cell at the caret (or around the selection): Ctrl+Shift+- as in Jupyter, Ctrl+; as in CoCalc.
  function split(cell) {
    const v = cell.ta.value, s0 = cell.ta.selectionStart, s1 = cell.ta.selectionEnd;
    const parts = (s1 > s0 ? [v.slice(0, s0), v.slice(s0, s1), v.slice(s1)] : [v.slice(0, s0), v.slice(s0)]).map((p) => p.replace(/^\n/, "").replace(/\n$/, ""));
    cell.ta.value = parts[0];
    autosize(cell.ta); paint(cell);
    let last = cell, lastNew = null;
    for (const p of parts.slice(1)) lastNew = last = addCell(p, { after: last.el }, false, cell.type);
    edit(parts.length === 3 ? nextCell(cell) : lastNew, "start");
    announce("Cell split");
  }
  // Merge with the cell below (Shift+M in command mode).
  function merge(cell) {
    const below = nextCell(cell);
    if (!below) return;
    cell.ta.value = [cell.ta.value, below.ta.value].filter((s) => s.trim()).join("\n");
    below.el.remove();
    forgetInteracts(cell.out); cell.out.textContent = ""; cell.time.textContent = "";
    autosize(cell.ta); paint(cell); relabel();
    if (cell.el.classList.contains("rendered")) renderMd(cell);
    select(cell);
    announce("Cells merged");
  }

  // Edit mode keys: run, leave, move between cells, indent, comment, split.
  function editKey(cell, e) {
    const ta = cell.ta, mod = e.ctrlKey || e.metaKey;
    if (comp?.cell === cell) {
      const n = comp.matches.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        comp.sel = (comp.sel + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        return showCompleter();
      }
      if ((e.key === "Tab" || e.key === "Enter") && !e.shiftKey && !mod) {
        e.preventDefault();
        return acceptCompletion();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        return closeCompleter();
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End" || e.key === "PageUp" || e.key === "PageDown") closeCompleter();
    }
    const done = () => e.preventDefault();
    if (e.key === "Enter" && (e.shiftKey || mod || e.altKey)) {
      done();
      run(cell);
      if (e.shiftKey) advance(cell);
      else if (e.altKey && !opts.readOnly) addCell("", { after: cell.el }, true);
    } else if (e.key === "Escape" || (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "m")) {
      done();
      select(cell); // command mode; Tab from there leaves the cell (no keyboard trap)
    } else if (opts.readOnly) {
      // nothing else changes a read-only notebook
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      done();
      move(cell, e.key === "ArrowUp" ? -1 : 1);
    } else if (mod && (e.key === ";" || (e.shiftKey && (e.key === "-" || e.key === "_" || e.code === "Minus")))) {
      done();
      split(cell);
    } else if (mod && !e.shiftKey && e.key === "/") {
      done();
      editLines(ta, commentLines);
    } else if (mod && (e.key === "]" || e.key === "[")) {
      done();
      editLines(ta, e.key === "]" ? indentLines : dedentLines);
    } else if (e.key === "Tab" && e.shiftKey && !mod) {
      done();
      editLines(ta, dedentLines);
    } else if (e.key === "Tab" && !mod && !e.altKey) {
      done();
      const v = ta.value, s0 = ta.selectionStart, s1 = ta.selectionEnd;
      if (v.slice(s0, s1).includes("\n")) editLines(ta, indentLines);
      else if (cell.type === "code" && /[\w.]$/.test(v.slice(0, s0)) && s0 === s1) tabComplete(cell);
      else document.execCommand("insertText", false, "    "); // keeps undo working
    } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !mod && !e.shiftKey && !e.altKey) {
      const up = e.key === "ArrowUp", to = up ? prevCell(cell) : nextCell(cell);
      if (to && atEdge(ta, up)) { done(); edit(to, up ? "end" : "start"); }
    } else if (e.key === "Enter" && cell.type === "code" && !e.isComposing) {
      // keep the indentation; one more level after a colon, one less after return/pass/...
      done();
      const v = ta.value, p = ta.selectionStart, line = v.slice(v.lastIndexOf("\n", p - 1) + 1, p);
      let ind = /^[ \t]*/.exec(line)[0];
      const atEol = ta.selectionEnd === (v.indexOf("\n", p) < 0 ? v.length : v.indexOf("\n", p));
      if (!isMagma() && /:\s*(#.*)?$/.test(line)) ind += "    ";
      else if (atEol && /^\s*(return|pass|break|continue|raise)\b/.test(line)) ind = ind.slice(0, Math.max(0, ind.length - 4));
      document.execCommand("insertText", false, "\n" + ind);
    } else if (e.key === "Backspace" && !mod && !e.altKey && ta.selectionStart === ta.selectionEnd) {
      // in the leading spaces, back to the previous multiple of four
      const v = ta.value, p = ta.selectionStart, before = v.slice(v.lastIndexOf("\n", p - 1) + 1, p);
      if (before.length && /^ +$/.test(before)) {
        done();
        ta.setSelectionRange(p - (before.length % 4 || 4), p);
        document.execCommand("delete");
      }
    }
  }

  // Command mode keys, on the selected cell (or its rendered Markdown).
  let lastKey = "", lastKeyAt = 0, clip = null;
  const trash = [];
  const twice = (key) => { const t = performance.now(), hit = lastKey === key && t - lastKeyAt < 800; lastKey = hit ? "" : key; lastKeyAt = t; return hit; };
  function remove(cell, command = false) {
    const next = nextCell(cell) ?? prevCell(cell);
    trash.push({ el: cell.el, next: cell.el.nextElementSibling, prev: cell.el.previousElementSibling });
    if (trash.length > 50) trash.shift();
    if (comp?.cell === cell) closeCompleter();
    cell.el.remove();
    if (active === cell) activate(null);
    if (!cells().length) addCell("", null, true);
    else if (command) select(next);
    else edit(next);
    relabel();
    announce("Cell deleted" + (command ? "; Z undoes" : ""));
  }
  function undelete() {
    const t = trash.pop();
    if (!t) return;
    if (t.next?.isConnected) t.next.before(t.el);
    else if (t.prev?.isConnected) t.prev.after(t.el);
    else cellsEl.appendChild(t.el);
    relabel();
    select(t.el.cell);
    announce("Cell restored");
  }
  function paste(cell, above) {
    if (!clip) return;
    let at = cell, first = null;
    for (const c of above ? [...clip].reverse() : clip) {
      const n = addCell(c.code, above ? { before: (first ?? at).el } : { after: at.el }, false, c.type);
      if (n.type === "markdown") renderMd(n);
      if (above) first = n; else at = n;
    }
    select(above ? first : at);
  }
  cellsEl.addEventListener("keydown", (e) => {
    const cell = e.target.closest?.(".cell")?.cell;
    if (!cell || (e.target !== cell.el && e.target !== cell.md)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Enter" && (e.shiftKey || mod || e.altKey)) {
      e.preventDefault();
      run(cell);
      if (e.shiftKey) advance(cell);
      else if (e.altKey && !opts.readOnly) addCell("", { after: cell.el }, true);
      return;
    }
    if (mod) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const ro = opts.readOnly;
    if (e.altKey) {
      if (!ro && (key === "ArrowUp" || key === "ArrowDown")) { e.preventDefault(); move(cell, key === "ArrowUp" ? -1 : 1); }
      return;
    }
    switch (key) {
      case "Enter": if (ro) return; if (cell.el.classList.contains("rendered")) editMd(cell); else edit(cell); break;
      case "ArrowUp": case "k": select(prevCell(cell) ?? cell); break;
      case "ArrowDown": case "j": select(nextCell(cell) ?? cell); break;
      case "c": clip = [{ type: cell.type, code: cell.ta.value }]; announce("Cell copied"); break;
      case "i": if (twice("i")) interrupt(); break;
      case "0": if (twice("0")) api.restart(); break;
      case "h": keysDlg.showModal(); break;
      default:
        if (ro) return;
        switch (key) {
          case "a": select(addCell("", { before: cell.el })); break;
          case "b": select(addCell("", { after: cell.el })); break;
          case "d": if (twice("d")) remove(cell, true); break;
          case "z": undelete(); break;
          case "x": clip = [{ type: cell.type, code: cell.ta.value }]; remove(cell, true); break;
          case "v": paste(cell, e.shiftKey); break;
          case "m": if (e.shiftKey) merge(cell); else if (cell.type !== "markdown") { setType(cell, "markdown"); schedule(); select(cell); } break;
          case "y": if (cell.type !== "code") { setType(cell, "code"); schedule(); select(cell); } break;
          case "r": if (cell.type !== "raw") { setType(cell, "raw"); schedule(); select(cell); } break;
          default: return;
        }
    }
    e.preventDefault();
  });

  // Drag a cell by its prompt (or the ⠿ in its toolbar) to move it.
  let dragCell = null;
  function dropBefore(y) {
    for (const c of cells()) { const r = c.el.getBoundingClientRect(); if (y < r.top + r.height / 2) return c.el; }
    return null;
  }
  function endDrag() {
    dragCell?.el.classList.remove("dragging");
    dragCell = null;
    dropline.hidden = true;
  }
  cellsEl.addEventListener("dragstart", (e) => {
    const cell = !opts.readOnly && e.target.closest?.(".gutter, .drag") && e.target.closest(".cell")?.cell;
    if (!cell) return; // e.g. text dragged out of an editor
    dragCell = cell;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", cell.ta.value);
    e.dataTransfer.setDragImage(cell.el, 30, 16);
    requestAnimationFrame(() => cell.el.classList.add("dragging"));
  });
  cellsEl.addEventListener("dragover", (e) => {
    if (!dragCell) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const before = dropBefore(e.clientY), box = cellsEl.getBoundingClientRect();
    const y = before ? before.getBoundingClientRect().top : cellsEl.lastElementChild.getBoundingClientRect().bottom;
    Object.assign(dropline.style, { top: `${y + scrollY - 2}px`, left: `${box.left + scrollX}px`, width: `${box.width}px` });
    dropline.hidden = false;
  });
  cellsEl.addEventListener("drop", (e) => {
    if (!dragCell) return;
    e.preventDefault();
    e.stopPropagation();
    const cell = dragCell, before = dropBefore(e.clientY);
    endDrag();
    if (before === cell.el || before === cell.el.nextElementSibling) return;
    if (before) before.before(cell.el); else cellsEl.appendChild(cell.el);
    relabel();
    select(cell);
    announce(`Moved to position ${index(cell) + 1}`);
  });
  cellsEl.addEventListener("dragend", endDrag);

  // ---------------------------------------------------------- Markdown cells
  function setType(cell, type) {
    // raw cells (nbformat's): text kept as it is, never run
    cell.type = type === "markdown" || type === "raw" ? type : "code";
    cell.el.classList.toggle("markdown", cell.type === "markdown");
    cell.el.classList.toggle("raw", cell.type === "raw");
    cell.el.classList.remove("rendered");
    cell.n.textContent = cell.type !== "code" ? "" : "[ ]";
    cell.runb.title = cell.type === "markdown" ? "Show the text (Shift+Enter)" : cell.type === "raw" ? "Raw text: not run" : "Run (Shift+Enter)";
    cell.typeSel.value = cell.type;
    if (cell.type !== "code") { forgetInteracts(cell.out); cell.out.textContent = ""; cell.time.textContent = ""; }
    paint(cell);
    relabel();
  }
  // (or 200 ms, whichever is first: a hidden page, e.g. a background tab, does not paint)
  const afterPaint = () => new Promise((resolve) => { requestAnimationFrame(() => setTimeout(resolve, 0)); setTimeout(resolve, 200); });
  // Highlight fenced Python/Sage code in Markdown as in code cells.
  const mdHighlight = (code, lang) => (!lang || /^(python|py|python3|sage|ipython)$/i.test(lang) ? highlight(code, /sage/i.test(lang) || (!lang && isSage())).replace(/\n$/, "") : null);
  async function renderMd(cell) {
    cell.md.innerHTML = cell.ta.value.trim() ? renderMarkdown(cell.ta.value, { highlight: mdHighlight, attachments: cell.attachments }) : '<p class="hc">Empty Markdown cell: double-click to edit.</p>';
    cell.el.classList.add("rendered");
    if (cell.md.querySelector(".math")) {
      await afterPaint(); // the text shows first; KaTeX (275 KB) typesets the math after
      try { (await loadMath()).typeset(cell.md); } catch {}
    }
    schedule();
  }
  function editMd(cell) {
    cell.el.classList.remove("rendered");
    autosize(cell.ta);
    cell.ta.focus();
  }

  // Accessible names: "Cell 3", "Cell 3 code", ...
  function relabel() {
    cells().forEach((c, i) => {
      c.el.setAttribute("aria-label", `Cell ${i + 1}${c.type === "markdown" ? " (Markdown)" : ""}`);
      c.md.setAttribute("aria-label", `Cell ${i + 1} text`);
      c.ta.setAttribute("aria-label", `Cell ${i + 1} code`);
      c.runb.setAttribute("aria-label", `Run cell ${i + 1}`);
      c.menuBtn.setAttribute("aria-label", `Cell ${i + 1} actions`);
    });
  }
  // Move to the next cell, making one at the end.
  function advance(cell) {
    const next = nextCell(cell) ?? (opts.readOnly ? null : addCell("", { after: cell.el }));
    if (!next) return;
    (next.el.classList.contains("rendered") ? next.md : next.ta).focus();
    next.el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function move(cell, d) {
    const sib = d < 0 ? cell.el.previousElementSibling : cell.el.nextElementSibling;
    if (!sib) return;
    const hadFocus = cell.el.contains(document.activeElement) ? document.activeElement : null;
    if (d < 0) sib.before(cell.el); else sib.after(cell.el);
    hadFocus?.focus();
    cell.el.scrollIntoView({ block: "nearest" });
    relabel();
    announce(`Moved to position ${index(cell) + 1}`);
  }

  // ---------------------------------------------------------- the cell menu
  let menuCell = null;
  function openMenu(cell) {
    if (menuCell === cell) return closeMenu(true);
    closeMenu(false);
    menuCell = cell;
    const r = cell.menuBtn.getBoundingClientRect();
    menu.hidden = false;
    menu.style.top = `${r.bottom + scrollY + 4}px`;
    menu.style.left = `${Math.max(8, r.right + scrollX - menu.offsetWidth)}px`;
    cell.menuBtn.setAttribute("aria-expanded", "true");
    menu.querySelector('[data-m="type"]').textContent = cell.type === "markdown" ? "Change to Code" : "Change to Markdown";
    menu.querySelector("button").focus();
  }
  function closeMenu(refocus) {
    if (!menuCell) return;
    menuCell.menuBtn.setAttribute("aria-expanded", "false");
    if (refocus) menuCell.menuBtn.focus();
    menu.hidden = true;
    menuCell = null;
  }
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !menuCell) return;
    const cell = menuCell;
    closeMenu(false);
    switch (b.dataset.m) {
      case "above": return void addCell("", { before: cell.el }, true);
      case "below": return void addCell("", { after: cell.el }, true);
      case "up": move(cell, -1); return cell.menuBtn.focus();
      case "down": move(cell, 1); return cell.menuBtn.focus();
      case "type": setType(cell, cell.type === "markdown" ? "code" : "markdown"); schedule(); return cell.ta.focus();
      case "split": return split(cell);
      case "clear": if (cell.type === "markdown") return cell.ta.focus(); forgetInteracts(cell.out); cell.out.textContent = ""; cell.time.textContent = ""; cell.n.textContent = "[ ]"; return cell.ta.focus();
      case "delete": return remove(cell);
    }
  });
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll("button")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1].focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      closeMenu(true);
    }
  });
  const onPointerDown = (e) => { if (menuCell && !menu.contains(e.target) && e.target !== menuCell.menuBtn) closeMenu(false); };
  document.addEventListener("pointerdown", onPointerDown);

  // ---------------------------------------------------------- the document
  // A document is {mode, cells: [{id, type?, code, outputs?, n?, attachments?, metadata?}], ...meta}.
  // A cell's metadata (nbformat's: tags, ...) is kept as it is.
  let loading = false, timer = null, lastJson = null, store = null, unsubscribe = null, saveChain = Promise.resolve(), savesPending = 0;
  // the document last known to be the store's (loaded, received, or saved
  // here): its revision and cells by id, the base of three-way merges with
  // changes from elsewhere (stores.js: revisions)
  let synced = null;
  const cellType = (c) => (c.type === "markdown" || c.type === "raw" ? c.type : "code");
  const cellKey = (c) => ({ code: c.code ?? "", outputs: JSON.stringify(c.outputs ?? []), type: cellType(c), metadata: JSON.stringify(c.metadata ?? null) });
  const setSynced = (rev, list) => { synced = { rev, cells: new Map((list ?? []).map((c) => [c.id, cellKey(c)])) }; };
  function snapshot() {
    return {
      ...meta, mode,
      cells: cells().map((c) => ({
        ...(c.type === "markdown"
          ? { id: c.id, type: "markdown", code: c.ta.value, ...(c.attachments ? { attachments: c.attachments } : {}) }
          : c.type === "raw"
            ? { id: c.id, type: "raw", code: c.ta.value }
            : { id: c.id, code: c.ta.value, outputs: saveOutputs(c.out), n: (/\[(\d+)\]/.exec(c.n.textContent) || [])[1] ?? null }),
        ...(c.metadata ? { metadata: c.metadata } : {}),
      })),
    };
  }
  // Changes (edits, cells added, moved or removed, new output) are reported
  // half a second after the last one, and only if the document changed.
  function schedule() {
    if (loading) return;
    clearTimeout(timer);
    emit("dirty");
    timer = setTimeout(flush, 500);
  }
  function flush() {
    clearTimeout(timer);
    timer = null;
    if (loading) return;
    const doc = snapshot(), json = JSON.stringify(doc);
    if (json === lastJson) return;
    lastJson = json;
    emit("change", doc);
    if (store) {
      // saves run one after another (a slow earlier write cannot land after
      // a later one), and a failed save is retried by the next flush; each
      // is made from the synced revision when it starts (stores.js)
      const st = store;
      const start = () => {
        try { return Promise.resolve(st.save(synced?.rev !== undefined ? { ...doc, baseRev: synced.rev } : doc)); } catch (e) { return Promise.reject(e); }
      };
      // (started at once when no earlier save is pending)
      const p = savesPending ? saveChain.then(start) : start();
      savesPending++;
      saveChain = p.then((t) => {
        if (store !== st) return;
        if (t && typeof t === "object" && t.conflict) {
          // written elsewhere first: merge that, then save the merge
          if (lastJson === json) lastJson = null;
          applyRemote(t.conflict, true, true);
          return;
        }
        const r = t && typeof t === "object" ? t.rev : undefined;
        if (r === undefined || synced?.rev === undefined || r > synced.rev) setSynced(r, doc.cells);
        emit("saved", (t && typeof t === "object" ? t.saved : t) ?? "saved");
      }, (e) => {
        if (lastJson === json) lastJson = null;
        emit("saved", "not saved: " + (e?.message ?? e));
      }).finally(() => { savesPending--; });
    }
  }
  cellsEl.addEventListener("input", schedule);
  const observer = new MutationObserver(schedule);
  observer.observe(cellsEl, { childList: true, subtree: true, characterData: true });
  const onHidden = () => { if (document.visibilityState === "hidden" && timer) flush(); };
  addEventListener("visibilitychange", onHidden);

  function fill(cell, c) {
    cell.metadata = c.metadata ?? null;
    if (cell.type === "raw") return;
    if (cell.type === "markdown") {
      cell.attachments = c.attachments ?? null;
      renderMd(cell);
    } else {
      loadOutputs(cell.out, c.outputs);
      if (c.n != null) cell.n.textContent = `[${c.n}]`;
    }
  }
  // Show a document, replacing what is there.
  function load(doc) {
    loading = true;
    const { cells: list, mode: m, rev, baseRev: _b, ...rest } = doc;
    meta = rest;
    setMode(m ?? mode, false);
    closeCompleter(); closeMenu(false); activate(null);
    cellsEl.textContent = "";
    execCount = 0;
    for (const c of list?.length ? list : [{ code: "" }]) fill(addCell(c.code ?? "", null, false, c.type, c.id), c);
    const snap = snapshot();
    lastJson = JSON.stringify(snap);
    setSynced(rev, snap.cells);
    Promise.resolve().then(() => { loading = false; }); // after the observer's records for this
  }
  // Apply a document changed elsewhere (another tab, a collaborator, an agent):
  // cells are matched by id; what changed is updated in place, so the cell
  // being edited keeps its caret and a running cell its output.  With
  // keepLocal, a three-way merge from the synced document (the one both
  // sides started from): a cell changed on one side only takes that change;
  // changed on both, the other side's text is taken and this side's kept in
  // a new cell after it, tagged "conflict"; cells inserted here stay, and a
  // cell edited on one side and deleted on the other stays (the systematic
  // review's R2-DOC-F1: a second unrelated change restored an old value, an
  // unrelated change deleted a new cell).  Without keepLocal (a revert), the
  // incoming document replaces this one.
  function applyRemote(doc, keepLocal = true, fromConflict = false) {
    const { cells: list, mode: m, rev, baseRev: _b, ...rest } = doc;
    // an older revision than the synced one (a late message) changes nothing
    if (keepLocal && rev !== undefined && synced?.rev !== undefined && rev <= synced.rev && !fromConflict) return;
    loading = true;
    const base = keepLocal ? synced?.cells ?? null : null;
    let dirty = false;
    meta = { ...meta, ...rest };
    if (m && m !== mode) setMode(m, false);
    const order = cells().map((c) => c.id);
    const mine = new Map(cells().map((c) => [c.id, c]));
    let prev = null;
    for (const rc of list ?? []) {
      const b = base?.get(rc.id);
      let c = mine.get(rc.id);
      if (!c) {
        // deleted here and unchanged there: stays deleted
        if (b && b.code === (rc.code ?? "") && b.outputs === JSON.stringify(rc.outputs ?? [])) { dirty = true; continue; }
        c = addCell(rc.code ?? "", prev ? { after: prev } : { first: true }, false, rc.type, rc.id);
        fill(c, rc);
        prev = c.el;
        continue;
      }
      mine.delete(rc.id);
      // type and metadata: a change here only is kept
      if (cellType(rc) !== c.type) {
        if (b && b.type === cellType(rc)) dirty = true;
        else setType(c, rc.type);
      }
      if ("metadata" in rc) { // (TimeTravel's versions have none)
        const lm = JSON.stringify(c.metadata ?? null), rm = JSON.stringify(rc.metadata ?? null);
        if (lm !== rm) {
          if (b && b.metadata === rm) dirty = true;
          else c.metadata = rc.metadata ?? null;
        }
      }
      const L = c.ta.value, Rt = rc.code ?? "";
      let textChanged = false, conflictText = null;
      if (L !== Rt) {
        if (b && b.code === Rt) dirty = true; // changed here only: kept
        else if (b && b.code !== L) { textChanged = true; conflictText = L; dirty = true; } // changed on both sides
        else textChanged = true; // changed there only
      }
      if (textChanged) setInput(c, Rt);
      if (c.type === "markdown") {
        c.attachments = rc.attachments ?? null;
        if (textChanged && c.el.classList.contains("rendered")) renderMd(c);
      } else if (c.type === "code" && !c.el.classList.contains("running") && !c.el.classList.contains("queued")) {
        const lo = JSON.stringify(saveOutputs(c.out)), ro = JSON.stringify(rc.outputs ?? []);
        if (lo !== ro) {
          if (b && b.outputs === ro) dirty = true; // new output here only: kept
          else {
            forgetInteracts(c.out);
            c.out.replaceChildren();
            loadOutputs(c.out, rc.outputs);
            c.n.textContent = rc.n != null ? `[${rc.n}]` : "[ ]";
          }
        } else c.n.textContent = rc.n != null ? `[${rc.n}]` : "[ ]";
      }
      if (c.el.previousElementSibling !== prev) prev ? prev.after(c.el) : cellsEl.prepend(c.el);
      prev = c.el;
      if (conflictText !== null) {
        const k = addCell(conflictText, { after: c.el }, false, c.type);
        k.metadata = { ...(c.metadata ?? {}), tags: [...(c.metadata?.tags ?? []), "conflict"] };
        emit("conflict", { id: c.id, copy: k.id });
        prev = k.el;
      }
    }
    // cells here that the incoming document does not have
    for (const c of mine.values()) {
      const b = base?.get(c.id);
      const keep = base && (!b || b.code !== c.ta.value); // inserted here, or edited here and deleted there
      if (keep) { dirty = true; continue; }
      if (active === c) activate(null);
      c.el.remove();
    }
    // kept cells go back after the cell they followed here
    for (const c of mine.values()) {
      if (!c.el.isConnected) continue;
      const i = order.indexOf(c.id);
      let after = null;
      for (let j = i - 1; j >= 0 && !after; j--) {
        const p = cells().find((x) => x.id === order[j]);
        if (p && p.el.isConnected && p !== c) after = p.el;
      }
      if (after) after.after(c.el);
      else cellsEl.prepend(c.el);
    }
    if (!cells().length) addCell("");
    relabel();
    // (a revert is not the store's document: the base stays until it is saved)
    if (keepLocal) setSynced(rev, list);
    lastJson = dirty ? null : JSON.stringify(snapshot()); // a merged change still has to be saved
    Promise.resolve().then(() => { loading = false; if (dirty) schedule(); });
    emit("remote", doc);
  }
  // Replace the cells with a document's (TimeTravel's revert): matched by id
  // and updated in place as for a change made elsewhere, but this one is a
  // change made here, so it is saved (and recorded).
  function replace(doc) {
    applyRemote(doc, false); // a revert replaces the local text too
    lastJson = null;
    Promise.resolve().then(flush); // after applyRemote's own microtask
  }
  // Set a cell's text, keeping the caret where it was if it is being edited.
  function setInput(cell, text) {
    const focused = document.activeElement === cell.ta, s0 = cell.ta.selectionStart, s1 = cell.ta.selectionEnd;
    cell.ta.value = text;
    if (focused) cell.ta.setSelectionRange(Math.min(s0, text.length), Math.min(s1, text.length));
    autosize(cell.ta);
    paint(cell);
    schedule();
  }
  function setMode(m, notify = true) {
    mode = ["python", "sage", "magma"].includes(m) ? m : "python";
    for (const c of cells()) paint(c);
    if (notify) { emit("mode", mode); schedule(); }
  }

  // ---------------------------------------------------------- for agents
  // A cell's output as text: pictures by their descriptions, controls by their values.
  function outputText(box) {
    const parts = [];
    for (const el of box.children) {
      if (el.tagName === "PRE") parts.push(el.textContent);
      else if (el.tagName === "FIGURE") parts.push(`[picture: ${el.querySelector("svg")?.getAttribute("aria-label") ?? el.querySelector("img")?.alt ?? ""}]\n`);
      else if (el.classList.contains("latex-out")) parts.push((el.sbBundle?.["text/plain"] ?? "") + "\n");
      else if (el.classList.contains("interact")) {
        const it = interacts.get(el.dataset.key);
        parts.push(`[interact ${it?.name ?? ""} id=${el.dataset.key} values=${JSON.stringify(it?.values ?? {})}]\n` + outputText(el.querySelector(".iout")));
      }
    }
    return parts.join("");
  }
  // Pictures in an output as PNG (what multimodal agents take), drawn from the SVG.
  async function pictures(box) {
    const out = [];
    // an animation contributes a few of its frames (first, middle, last)
    const svgs = [];
    // a 3D view as it is on the screen (its SVG is only the bounding box)
    for (const canvas of box.querySelectorAll("figure.plot3d canvas")) {
      try { out.push({ type: "image", data: canvas.toDataURL("image/png").split(",")[1], mimeType: "image/png" }); } catch {}
    }
    for (const svg of box.querySelectorAll("figure.plot svg")) {
      if (svg.closest("figure.plot3d")?.querySelector("canvas")) continue;
      const frames = svg.querySelectorAll(":scope > g.sb-frame");
      if (!frames.length) { svgs.push(svg); continue; }
      for (const f of [...new Set([0, frames.length >> 1, frames.length - 1])]) {
        const copy = svg.cloneNode(true);
        copy.querySelectorAll(":scope > g.sb-frame").forEach((g, j) => (j === f ? g.setAttribute("style", "") : g.remove()));
        svgs.push(copy);
      }
    }
    for (const svg of svgs.slice(0, 6)) {
      const w = svg.viewBox.baseVal?.width || 640, ht = svg.viewBox.baseVal?.height || 480;
      const img = new Image();
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
      try {
        await img.decode();
        const canvas = h("canvas", "", { width: w, height: ht });
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, ht);
        ctx.drawImage(img, 0, 0, w, ht);
        out.push({ type: "image", data: canvas.toDataURL("image/png").split(",")[1], mimeType: "image/png" });
      } catch {}
    }
    return out;
  }
  // Change an @interact's controls and rerun it; resolves to its output box.
  async function setInteract(key, values) {
    const it = interacts.get(key);
    if (!it) return null;
    for (const [name, v] of Object.entries(values ?? {})) if (it.setters[name]) it.setters[name](v);
    await new Promise((resolve) => { it.waiters.push(resolve); changed(it); });
    return it.out;
  }

  const api = {
    root, kernel,
    get mode() { return mode; },
    get meta() { return meta; },
    get active() { return active; },
    cells, addCell, run, runAll, interrupt, clearOutputs,
    /** A fresh interpreter and no outputs (Jupyter's Restart and clear). */
    restart() { kernel?.restart(); clearOutputs(); },
    setMode, setType, setInput, renderMd, select, edit,
    /** Measure every editor again now (after the notebook was hidden). */
    resize() { cellsEl.querySelectorAll(".ed textarea").forEach(autosize); },
    load, snapshot, applyRemote, replace, flush,
    setMeta(patch) { meta = { ...meta, ...patch }; schedule(); },
    /** Use a store: show its document, save changes to it, apply its changes from elsewhere. */
    async attach(s) {
      unsubscribe?.();
      unsubscribe = null;
      if (timer) flush();
      store = null;
      const doc = await s.load();
      load(doc);
      store = s;
      unsubscribe = s.subscribe?.((d) => applyRemote(d)) ?? null;
      return doc;
    },
    detach() { if (timer) flush(); unsubscribe?.(); unsubscribe = null; store = null; },
    get store() { return store; },
    on(event, f) { (listeners[event] ??= []).push(f); return () => { listeners[event] = listeners[event].filter((g) => g !== f); }; },
    showKeys() { keysDlg.showModal(); },
    setReadOnly(ro) { opts.readOnly = !!ro; root.classList.toggle("readonly", !!ro); for (const c of cells()) c.ta.readOnly = !!ro; },
    // outputs, for other places (a console's picture panel) and agents
    output: { text: appendText, display: appendDisplay, interact: renderInteract, forget: forgetInteracts, sink: areaSink },
    outputText, pictures, interacts, setInteract, saveOutputs, loadOutputs,
    destroy() {
      api.detach();
      observer.disconnect();
      sizeObserver?.disconnect();
      removeEventListener("resize", resizeAll);
      removeEventListener("visibilitychange", onHidden);
      document.removeEventListener("pointerdown", onPointerDown);
      for (const el of [completer, menu, dropline, keysDlg]) el.remove();
      root.replaceChildren();
      root.classList.remove("sbnb", "readonly");
    },
  };
  return api;
}
