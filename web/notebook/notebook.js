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
import { BlockEditor } from "../board/blocks.ts";
import { loadRemotePicture, safeHtml } from "../safe-html.ts";
import { PixelBudget, dataUrl, imageSize, pictureKey } from "../image-size.ts";
import { cellId } from "./ipynb.js";
import { Reactive, SCOPE_SEP } from "../../src/notebook-reactive.ts";

export const SCENE3D = "application/vnd.sagebrush.scene3d+json";
export const GRAPH = "application/vnd.sagebrush.graph+json";
const STOP_MESSAGE = "\nStopped: it did not stop when interrupted, so the interpreter was restarted; variables are gone.\n";

// ------------------------------------------------------------ highlighting
// (web/notebook/highlight.js, which the board's editor uses too)
import { esc, highlight, highlightMarkdown } from "./highlight.js";
import { highlightMatlab } from "./highlight-matlab.js";
import { armStop, disarmStop, stopIgnored } from "./stop-guard.js";
export { esc, highlight, highlightMarkdown };

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
// active (scripts, event handlers) and every address off the picture itself,
// with its ids made unique so that several plots' clip paths cannot collide.
// Elements and attributes are judged by namespace and local name, never by
// the prefix the text chose (x:href is an XLink href).  An attribute value
// (or style declaration) may name the picture's own ids, url(#id), and
// otherwise contains no backslash (CSS escapes), slash or colon: so nothing in
// it can load from anywhere else (design/security.md); and the only CSS
// functions are transforms, colors and arithmetic.  Only aria-* and data-*
// attributes, which are text, may hold anything.
const SVG_NS = "http://www.w3.org/2000/svg", XLINK_NS = "http://www.w3.org/1999/xlink", XML_NS = "http://www.w3.org/XML/1998/namespace";
const SVG_TAGS = new Set("svg g path line polyline polygon circle ellipse rect text tspan title desc defs clipPath linearGradient radialGradient stop use marker symbol mask pattern image".split(" "));
// (an <image>'s only allowed source: an inline raster picture, e.g. contourf's bands)
const RASTER_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]*$/;
const LOCAL_URL = /url\(\s*(['"]?)#([\w.-]+)\1\s*\)/gi;
// (the CSS functions a value may use: transforms, colors, arithmetic; never
// one that loads, as image-set(), image(), cross-fade(), even from this site)
const SVG_FUNCS = new Set("matrix translate translatex translatey rotate scale scalex scaley skewx skewy rgb rgba hsl hsla var calc min max clamp".split(" "));
// (and no property that takes an image or other content, as a style or an attribute)
const SVG_NO_PROPS = /^(background|cursor|list-style|content|border-image|mask-image|shape-outside|-webkit-)/i;
function svgValue(v, pre) {
  const rest = v.replace(LOCAL_URL, "");
  if (/[\\/:\u0000]|url\(|@import|expression\(/i.test(rest)) return null;
  for (const m of rest.matchAll(/([\w-]*)\s*\(/g)) if (!SVG_FUNCS.has(m[1].toLowerCase())) return null;
  return v.replace(LOCAL_URL, (_, q, id) => `url(#${pre}${id})`);
}
// (the properties a style may set: how the picture's own shapes and text are painted, never where the picture
// sits on the page, how big it is or what it stacks over (position, inset, z-index, width, margin, ...), so a
// picture stays within its place in the output)
const SVG_STYLE_PROPS = new Set(("fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-dasharray stroke-dashoffset " +
  "stroke-linecap stroke-linejoin stroke-miterlimit opacity color font font-family font-size font-style font-weight " +
  "font-variant font-stretch text-anchor dominant-baseline alignment-baseline baseline-shift letter-spacing word-spacing " +
  "text-decoration writing-mode transform transform-origin transform-box visibility clip-path clip-rule mask marker " +
  "marker-start marker-mid marker-end stop-color stop-opacity flood-color flood-opacity lighting-color vector-effect " +
  "shape-rendering text-rendering image-rendering color-interpolation paint-order animation-delay").split(" "));
// (and no viewport unit in a value: a length relative to the page, not the picture)
const VIEWPORT_UNIT = /\d(vw|vh|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh)\b/i;
function svgStyle(v, pre) {
  const out = [];
  for (const decl of v.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const p = decl.slice(0, i).trim().toLowerCase(), val = svgValue(decl.slice(i + 1), pre);
    if (SVG_STYLE_PROPS.has(p) && val !== null && !VIEWPORT_UNIT.test(val)) out.push(`${p}:${val.trim()}`);
  }
  return out.join(";");
}
let svgCount = 0;
export function safeSvg(text, pixels = new PixelBudget(Infinity)) {
  const root = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
  if (root.namespaceURI !== SVG_NS || root.localName !== "svg") return null;
  const pre = `s${++svgCount}-`;
  const isHref = (a) => a.localName === "href" && (a.namespaceURI === null || a.namespaceURI === XLINK_NS);
  const clean = (el) => {
    for (const child of [...el.children]) {
      if (child.namespaceURI === SVG_NS && SVG_TAGS.has(child.localName)) clean(child); else child.remove();
    }
    for (const a of [...el.attributes]) {
      const { localName: n, value } = a;
      let keep = null;
      if (isHref(a)) {
        // (an inline raster within the bounds its header gives, counted in the document's pixels: image-size.ts, SEC-89C-3)
        if (el.localName === "image") { const m = RASTER_URL.exec(value); keep = m && pixels.take(imageSize("image/" + m[1], value.slice(value.indexOf(",") + 1)), "image/" + m[1] + "\n" + pictureKey(value)) === null ? value : null; }
        else keep = /^#[\w.-]+$/.test(value) ? "#" + pre + value.slice(1) : null;
      } else if (a.namespaceURI === XML_NS) keep = n === "space" || n === "lang" ? svgValue(value, pre) : null;
      else if (a.namespaceURI === null && /^[a-z_][\w.-]*$/i.test(n) && !/^on/i.test(n) && !SVG_NO_PROPS.test(n)) {
        // (text for people and the page's script, never read as CSS or an address)
        if (/^(aria|data)-/i.test(n)) keep = value;
        else keep = n === "style" ? svgStyle(value, pre) : svgValue(value, pre);
        if (keep !== null && n === "id") keep = pre + keep;
        if (keep !== null && !/^(aria|data)-/i.test(n) && VIEWPORT_UNIT.test(keep)) keep = null;
      }
      if (keep === null) el.removeAttributeNode(a);
      else if (keep !== value) a.value = keep;
    }
    if (el.localName === "image" && ![...el.attributes].some(isHref)) el.remove();
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
<button role="menuitem" data-m="type">Change to Markdown</button><button role="menuitem" data-m="split">Split at the cursor <kbd>Ctrl+;</kbd></button><button role="menuitem" data-m="clear">Clear output</button><button role="menuitem" data-m="manual" aria-checked="false">Run only by hand</button><button role="menuitem" data-m="delete" class="danger">Delete cell <kbd>D D</kbd></button>`;
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
 * @param {"python"|"sage"|"magma"|"matlab"} [opts.mode]
 * @param {string} [opts.assetBase] where sagebrush-math.js and sagebrush-viewer3d.js are (default: the page)
 * @param {(name: string) => string | undefined} [opts.assetUrl] the URL of one of them, if not under assetBase (a blob: in a downloaded file)
 * @param {boolean} [opts.readOnly]
 * @returns {import("./types").Notebook}
 */
export function createNotebook(root, opts = {}) {
  addStyle();
  installPlotTip();
  // the interpreter; a page may give each notebook its own (setKernel)
  let kernel = opts.kernel ?? null;
  const asset = (name) => opts.assetUrl?.(name) ?? new URL(name, new URL(opts.assetBase ?? "./", location.href)).href;
  let mode = opts.mode ?? "python";
  let meta = {}; // the document's other fields (name, ...), kept as they are
  // (the pixels of the pictures this document shows: image-size.ts)
  let pixels = new PixelBudget();
  // Remote pictures in Markdown: shown at once in a document written in this
  // browser (its host's store says so: `here`, which a document from
  // elsewhere never brings, index.html's openDocument), else each when
  // clicked, as one can't be measured before it is decoded (William, SEC-89C-3)
  const remotePictures = () => (opts.remotePictures ?? (meta.here === true ? true : "click"));
  root.addEventListener("click", loadRemotePicture);
  let execCount = 0;
  const listeners = {};
  const emit = (event, ...args) => { for (const f of listeners[event] ?? []) f(...args); };
  const isSage = () => mode === "sage";
  const isMagma = () => mode === "magma";
  const isMatlab = () => mode === "matlab";

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
    cell.hl.innerHTML = cell.type === "code" ? (isMatlab() ? highlightMatlab(cell.ta.value) : highlight(cell.ta.value, isSage())) : cell.type === "markdown" ? highlightMarkdown(cell.ta.value, isSage()) : esc(cell.ta.value) + "\n";
    // (a Markdown cell's blocks: its text changed elsewhere, merged, undone, an agent's)
    if (cell.blocks && cell.ta.value !== cell.blocksText) { cell.blocksText = cell.ta.value; cell.blocks.value = cell.ta.value; }
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
  // A graph's picture (Graph.plot): a canvas whose vertices can be dragged
  // (web/graph/view.ts, loaded on first use) over the SVG, which stays
  let graphView = null;
  function mountGraph(fig, graph) {
    graphView ??= import(asset("sagebrush-graphview.js")).then(() => window.SagebrushGraphView);
    graphView.then((v) => v?.mount(fig, graph)).catch(() => {});
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
  // Markdown output (mo.md, IPython.display.Markdown): drawn as Markdown cells are
  function appendMarkdown(box, b) {
    const el = h("div", "md-out");
    el.sbBundle = { "text/markdown": b["text/markdown"], "text/plain": b["text/plain"] ?? b["text/markdown"] };
    // (no images from other sites: code made this, and an image's address could carry away what it read)
    el.innerHTML = renderMarkdown(b["text/markdown"], { highlight: mdHighlight, remote: false, pixels });
    box.appendChild(el);
    if (el.querySelector(".math")) loadMath().then((mm) => mm.typeset(el)).catch(() => {});
  }
  // HTML output (IPython.display.HTML, tables): the restricted HTML of
  // web/safe-html.ts (formatting only, nothing that runs), no images from
  // other sites
  function appendHtml(box, b) {
    const el = h("div", "html-out");
    el.sbBundle = { ...b };
    el.innerHTML = safeHtml(b["text/html"], { remote: false, pixels });
    box.appendChild(el);
  }
  // A picture past the document's pixels: says why, and shows it when asked.
  // (`src`: the picture's data: address, to show it when counted again in
  // another budget it fits: recountPictures)
  function bigPicture(why, show, src = null) {
    const p = h("div", "big-picture");
    p.sbShow = show;
    p.sbSrc = src;
    p.textContent = `A picture not shown: ${why}. `;
    const go = h("button");
    go.type = "button";
    go.textContent = "Show it";
    go.onclick = () => p.replaceWith(show());
    p.append(go);
    return p;
  }
  // The pictures the code cells show, counted again in the budget now (a
  // board shows another document with them kept, SEC-4DF-1): those past it
  // become placeholders, kept as they were for saving.
  // (each picture's key as it was counted when shown: a figure's raster by
  // its bytes, a Markdown or HTML picture by its address)
  const keyOf = (d, src, inFigure) => d.type + "\n" + (inFigure ? d.base64 : pictureKey(src));
  function recountPictures() {
    for (const c of cells()) {
      if (c.type !== "code") continue;
      for (const img of [...c.out.querySelectorAll("img")]) {
        const src = img.getAttribute("src") ?? "", d = dataUrl(src);
        if (!d) continue;
        const fig = img.parentElement?.tagName === "FIGURE" ? img.parentElement : null;
        const why = pixels.take(imageSize(d.type, d.base64), keyOf(d, src, !!fig));
        if (!why) continue;
        if (fig) fig.sbBundle ??= { [d.type]: d.base64, "text/plain": img.alt };
        img.replaceWith(bigPicture(why, () => img, src));
      }
      // (and a picture not shown before, that fits now: shown, CORR-A48-2)
      for (const p of [...c.out.querySelectorAll(".big-picture")]) {
        const d = p.sbSrc ? dataUrl(p.sbSrc) : null;
        if (d && pixels.take(imageSize(d.type, d.base64), keyOf(d, p.sbSrc, p.parentElement?.tagName === "FIGURE")) === null) p.replaceWith(p.sbShow());
      }
      for (const im of [...c.out.querySelectorAll("svg image")]) {
        const href = im.getAttribute("href") ?? im.getAttributeNS(XLINK_NS, "href") ?? "", m = RASTER_URL.exec(href);
        if (!m || pixels.take(imageSize("image/" + m[1], href.slice(href.indexOf(",") + 1)), "image/" + m[1] + "\n" + pictureKey(href)) !== null) im.remove();
      }
    }
  }
  // (an output that can't be drawn, however malformed: said, with its text, the rest of the document drawn all the same)
  function appendDisplay(box, b) {
    try {
      drawDisplay(box, b);
    } catch (e) {
      const el = h("div", "html-out");
      el.sbBundle = { ...b };
      const plain = typeof b["text/plain"] === "string" ? b["text/plain"] : "";
      el.textContent = `(this output couldn't be shown: ${String(e?.message ?? e).slice(0, 200)})` + (plain ? "\n" + plain : "");
      el.style.whiteSpace = "pre-wrap";
      box.appendChild(el);
    }
  }
  function drawDisplay(box, b) {
    if (b["text/latex"] && b["application/vnd.sagebrush.typeset"]) return appendLatex(box, b);
    if (typeof b["text/markdown"] === "string" && !b["image/svg+xml"] && !b["image/png"] && !b["image/jpeg"] && !b["image/webp"]) return appendMarkdown(box, b);
    const fig = h("figure", "plot");
    const svg = b["image/svg+xml"] && safeSvg(b["image/svg+xml"], pixels);
    if (svg && b[SCENE3D]) {
      fig.classList.add("plot3d");
      fig.sbBundle = { [SCENE3D]: b[SCENE3D], "image/svg+xml": b["image/svg+xml"], "text/plain": b["text/plain"] ?? "3D plot" };
      fig.appendChild(svg);
      box.appendChild(fig);
      mount3d(fig, b[SCENE3D]);
      return;
    }
    // (as text, or as JSON when an .ipynb file kept it as JSON: passed as it
    // is, the view checks its size or its fields before reading it, HARD-4D6-1)
    const graph = typeof b[GRAPH] === "string" || (b[GRAPH] && typeof b[GRAPH] === "object") ? b[GRAPH] : null;
    if (svg && graph !== null) {
      fig.classList.add("plotgraph");
      fig.sbBundle = { [GRAPH]: graph, "image/svg+xml": b["image/svg+xml"], "text/plain": b["text/plain"] ?? "graph" };
      fig.appendChild(svg);
      box.appendChild(fig);
      mountGraph(fig, graph);
      return;
    }
    // (WebP: a board's previews of pictures, web/board/preview.ts)
    const raster = ["image/png", "image/jpeg", "image/webp"].map((t) => [t, b[t]]).find(([, v]) => typeof v === "string") ?? null;
    if (svg) {
      fig.appendChild(svg);
      if (svg.classList.contains("sb-anim")) player(fig, svg);
    }
    else if (raster) {
      // (within the bounds its header gives, and this document's pixels in
      // all: image-size.ts; else a placeholder, the picture kept as it was)
      const show = () => Object.assign(new Image(), { src: `data:${raster[0]};base64,${raster[1]}`, alt: b["text/plain"] || "image" });
      const why = pixels.take(imageSize(raster[0], raster[1]), raster[0] + "\n" + pictureKey(raster[1]));
      if (!why) fig.appendChild(show());
      else {
        fig.sbBundle = { ...b };
        fig.appendChild(bigPicture(why, show, `data:${raster[0]};base64,${raster[1]}`));
      }
    }
    else if (typeof b["text/html"] === "string" && !b["application/json"]) return appendHtml(box, b);
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
  // (waiting(on): an input() field shown, then answered or gone; a run's
  // sink uses it to pause its timer)
  function areaSink(box, waiting) {
    if (!box) return null;
    return {
      out: (text, isErr) => appendText(box, text, isErr),
      display: (b) => appendDisplay(box, b),
      interact: (spec) => renderInteract(box, spec),
      clear: () => box.replaceChildren(),
      input: (prompt, reply) => askInput(box, prompt, reply, waiting),
    };
  }
  // input(): a text field under the cell, as in Jupyter.  Enter sends the
  // line; the run then writes the prompt and the line as its output.  A Stop
  // ends the wait in the worker and removes the field at once (the kernel
  // retires the question: reply.onretire); so does the run's end (settle).
  function askInput(box, prompt, reply, waiting) {
    if (opts.readOnly) return reply(null);
    const row = h("div", "stdin");
    let open = true;
    const close = () => {
      row.remove();
      if (open) waiting?.(false);
      open = false;
    };
    reply.onretire = close;
    waiting?.(true);
    const field = h("input", "stdin-field", { type: "text", spellcheck: false, autocomplete: "off" });
    field.setAttribute("aria-label", prompt ? `input: ${prompt}` : "input");
    row.append(h("span", "stdin-prompt", { textContent: prompt }), field);
    field.addEventListener("keydown", (e) => {
      // (the notebook's own keys don't act while typing an answer)
      e.stopPropagation();
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      close();
      reply(field.value);
    });
    box.appendChild(row);
    field.focus({ preventScroll: true });
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
      } else if ((el.tagName === "FIGURE" || el.classList.contains("latex-out") || el.classList.contains("md-out")) && el.sbBundle) {
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
  // (which interpreter, and which start of it: interacts drawn by another are stale)
  const generation = () => (kernel ? `${kernel.uid ?? 0}.${kernel.generation}` : "0");
  function interactBox(iid) {
    const it = interacts.get(generation() + ":" + iid);
    return it ? (it.buffer ?? it.out) : null;
  }
  // An output is stale when this interpreter did not produce it: after a
  // restart, or loaded from storage, or from another tab (opts.staleOnLoad).
  // It stays visible, dimmed, until the cell runs again.
  const stoppedText = (ms) => `stopped after ${secs(ms)}; the interpreter restarted`;
  const STOPPED_TITLE = "It did not stop when interrupted, so the interpreter was restarted: run the cells you need again";
  function markStale(cell) {
    if (cell.type !== "code" || (!cell.out.childNodes.length && !/\d/.test(cell.n.textContent))) return;
    cell.el.classList.add("stale");
    // (the cell the restart stopped keeps saying so, UI-D1D-1)
    if (cell.stoppedAfter != null) {
      cell.time.textContent = stoppedText(cell.stoppedAfter);
      cell.time.title = STOPPED_TITLE;
      return;
    }
    cell.time.textContent = "stale";
    cell.time.title = "Not computed by the current interpreter: run the cell to update it";
  }
  const freshen = (cell) => { cell.el.classList.remove("stale"); cell.time.title = ""; };
  // Remote approval's view of this page (remote-gate.js): each cell's text and
  // its text version (cell.version: a frozen {text}, replaced with the text:
  // setText, the input listener), and the settings as one frozen object,
  // replaced whenever one of them changes (gateCfg = null right after every
  // write of mode, meta or reactiveOn).
  let gateCfg = null;
  const gatePage = (k) => ({
    reactive: () => k.reactive,
    displayed: (id) => cellById(id)?.ta.value,
    version: (id) => cellById(id)?.version,
    // (a version whose text isn't what is shown: a new one, from what is shown)
    repair: (id, text) => {
      const v = Object.freeze({ text });
      const c = cellById(id);
      if (c) c.version = v;
      return v;
    },
    config: () => (gateCfg ??= Object.freeze({ mode, seedNamespace: meta.seed ?? "", reactive: reactive() })),
    mode: () => mode,
    seedNamespace: () => meta.seed ?? "",
    reactiveFlag: () => reactive(),
    seed: async (ns, id) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ns}:${id}`)))].map((b) => b.toString(16).padStart(2, "0")).join(""),
  });
  // A person's run of these cells, on a remote kernel: their consent, captured now (the notebook's seed
  // made first).  Only a Run gesture's handler calls it (run(cell, true), runAll(true)), synchronously.
  function consentFor(ids) {
    if (!kernel?.remoteGate) return {};
    if (!/^[0-9a-f]{64}$/.test(meta.seed ?? "")) {
      meta = { ...meta, seed: [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("") };
      gateCfg = null;
      schedule();
    }
    return { consent: kernel.remoteGate.capture(ids) };
  }
  // (a remote kernel runs only in the reactive notebook: there is nothing to check a run against otherwise)
  const REMOTE_NEEDS_REACTIVE = "(a remote kernel runs cells only in the reactive notebook)\n";
  function bindKernel(k) {
    kernel = k;
    if (!k) return;
    // (a remote kernel runs only what this page approved: web/notebook/remote-gate.js, given by the page that made the kernel)
    if (k.remote && opts.remoteGate && !k.remoteGate) k.remoteGate = opts.remoteGate(k, gatePage(k));
    k.targetSink = (target) => areaSink(interactBox(target));
    k.execCount ??= 0;
    k.ran ??= new Set(); // the cells whose output this interpreter computed
    if (!k.__sbnbBound) {
      k.__sbnbBound = true;
      k.on("restart", () => {
        k.execCount = 0;
        k.ran = new Set();
        k.reactive?.restarted();
        if (k === kernel) for (const c of cells()) markStale(c);
      });
      // (a mode's library being fetched before its first run, web/lib-lazy.ts:
      // said where the user is looking, on the cells waiting for it)
      k.on("loading", (what) => {
        if (k !== kernel) return;
        for (const c of cells()) if (c.el.classList.contains("queued")) c.time.textContent = what ? `loading ${what}…` : "";
      });
    }
  }
  bindKernel(kernel);
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
    } else if (c.kind === "button") {
      // (ipywidgets' Button: the value counts the clicks)
      const b = v.appendChild(h("button", "", { id, textContent: c.text }));
      b.onclick = () => set((it.values[c.name] ?? 0) + 1);
      it.setters[c.name] = (x) => { it.values[c.name] = +x; };
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
      done(ms, info) {
        it.out.replaceChildren(...it.buffer.childNodes);
        it.buffer = null;
        // widgets are inputs: the cells reading the ones that changed rerun (not the cell showing them)
        if (info?.names?.length && reactive() && kernel.reactive) {
          const owner = it.out.closest(".cell")?.cell;
          kernel.reactive.namesChanged(info.names, owner ? [owner.id] : []);
        }
        finish();
      },
      stopped(message) { it.buffer = null; appendText(it.out, message, true); it.dirty = false; finish(); },
    });
  }

  // ---------------------------------------------------------- running cells
  function settle(cell) {
    clearInterval(cell.timer);
    disarmStop(cell);
    cell.el.classList.remove("queued", "running");
    // (an input() field still waiting: its run ended, by a Stop or a restart)
    for (const row of cell.out.querySelectorAll(".stdin")) row.remove();
  }
  // A code cell's last run time, kept in the document (for the estimates of
  // stale cells, and the time limit's choices, after a reload): two
  // significant digits, changed only when it changes noticeably (a rerun
  // taking about as long leaves the document as it was).
  function rememberTime(cell, ms) {
    const r = ms < 10 ? Math.round(ms) : Number(ms.toPrecision(2));
    if (cell.ms == null || Math.abs(r - cell.ms) > Math.max(50, cell.ms / 4)) cell.ms = r;
  }
  // (the scheduler learns the times kept in the document, where it has none)
  function seedTimes() {
    const r = kernel?.reactive;
    if (r) for (const c of cells()) if (c.type === "code" && c.ms != null && !r.times.has(c.id)) r.times.set(c.id, c.ms);
  }
  // (`gesture`: a person's Run, from its handler: their consent to run the cell as shown is captured)
  function run(cell, gesture = false) {
    if (cell.type === "markdown") return renderMd(cell);
    if (cell.type === "raw") return Promise.resolve(); // raw text is not run
    // On a remote kernel a Run can be in flight for a round trip or more before the cell even shows it queued.
    // A person's Run of a text whose Run is already requested and not yet settled (pending, queued or running)
    // is a double click: nothing more.  A Run of any other text is their new run: it is queued behind the ones
    // in flight, with their consent to the text as it is now.  (A local kernel keeps the rule below.)
    if (kernel?.remote && gesture && reactive()) {
      const text = cell.ta.value;
      const asked = (cell.runsAsked ??= new Set());
      if (asked.has(text)) return Promise.resolve();
      asked.add(text);
      return engine().run([cell.id], consentFor([cell.id])).finally(() => asked.delete(text));
    }
    if (cell.el.classList.contains("queued") || cell.el.classList.contains("running")) return Promise.resolve();
    // the reactive notebook: the cell, its stale ancestors, its descendants (within the budget)
    if (reactive()) return engine().run([cell.id], gesture ? consentFor([cell.id]) : {});
    if (kernel?.remote) { appendText(cell.out, REMOTE_NEEDS_REACTIVE, true); return Promise.resolve(); }
    return execCell(cell, cell.ta.value);
  }
  // Run a cell's code (`forget`: global names to delete first); resolves to
  // {ok, ms, stopped} when it is done.
  // (`extra`: more for the kernel, a remote run's gate)
  function execCell(cell, code, forget = [], scoped = null, extra = null) {
    forgetInteracts(cell.out);
    cell.out.textContent = "";
    cell.time.textContent = "";
    cell.stoppedAfter = null;
    freshen(cell);
    cell.el.classList.remove("cancelled", "error");
    if (!kernel) { appendText(cell.out, "(no kernel: this notebook cannot run code)\n", true); return Promise.resolve({ ok: false, ms: 0, stopped: true }); }
    cell.el.classList.add("queued");
    cell.n.textContent = "[*]";
    armStop(cell);
    let failed = false;
    let waited = 0, waitFrom = null;
    const k = kernel;
    return cellSeed(cell).then((seed) => new Promise((resolve) => k.execute(code, { mode, cell: cell.id, forget, mangle: reactive(), ...(seed ? { seed } : {}), ...(scoped ? { scoped } : {}), ...(extra ?? {}) }, {
      start() {
        cell.el.classList.replace("queued", "running");
        const t0 = (cell.t0 = performance.now());
        cell.timer = setInterval(() => {
          if (waitFrom === null) cell.time.textContent = `running… ${((performance.now() - t0 - waited) / 1000).toFixed(1)} s`;
        }, 250);
      },
      // (while input() waits for a person, the timer stops and says so; the
      // wait isn't the cell's time, shown or remembered for the estimates)
      ...areaSink(cell.out, (on) => {
        if (on && waitFrom === null) {
          waitFrom = performance.now();
          cell.time.textContent = "waiting for input";
        } else if (!on && waitFrom !== null) {
          waited += performance.now() - waitFrom;
          waitFrom = null;
        }
      }),
      out(text, isErr) { failed ||= isErr; appendText(cell.out, text, isErr); },
      done(ms, info) {
        if (waitFrom !== null) waited += performance.now() - waitFrom;
        ms = Math.max(0, ms - waited);
        settle(cell);
        // (the notebook was switched away from while this ran: its output went to
        // the cell as it was then; if the notebook is shown again, the cell shown
        // now gets it; if not, the output is lost, so the run counts as stopped
        // and the cell stays stale)
        if (!cell.el.isConnected) {
          const live = kernel === k ? cellById(cell.id) : null;
          if (!live) return resolve({ ok: false, ms, stopped: true });
          forgetInteracts(live.out);
          live.out.replaceChildren(...cell.out.childNodes);
          settle(live);
          freshen(live);
          live.el.classList.remove("cancelled", "error");
          cell = live;
        }
        cell.n.textContent = `[${kernel ? ++kernel.execCount : ++execCount}]`;
        kernel?.ran?.add(cell.id);
        if (!info?.interrupted) rememberTime(cell, ms);
        cell.time.textContent = `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
        announce(`Cell ${index(cell) + 1} ${failed || info?.error ? "raised an error" : "finished"}`);
        resolve({ ok: !info?.error, ms, ...(info?.interrupted ? { stopped: true, interrupted: true } : {}), ...(info?.files ? { files: info.files } : {}) });
      },
      stopped(message) {
        // (a running cell whose interpreter was ended, Stop's last resort:
        // how long it ran, and why it stopped, rather than no time at all)
        // (less any wait for a person at input(), as for a finished run)
        if (waitFrom !== null) waited += performance.now() - waitFrom;
        waitFrom = null;
        const ran = cell.el.classList.contains("running") && cell.t0 != null ? Math.max(0, performance.now() - cell.t0 - waited) : null;
        settle(cell);
        cell.n.textContent = "[ ]";
        cell.stoppedAfter = ran;
        cell.time.textContent = ran != null ? stoppedText(ran) : "";
        if (ran != null) cell.time.title = STOPPED_TITLE;
        if (message) appendText(cell.out, message, true);
        resolve({ ok: false, ms: 0, stopped: true });
      },
      skipped(info) {
        settle(cell);
        cell.n.textContent = "[ ]";
        // (not sent at all: a remote run that wasn't approved, or changed; the scheduler marks it stale)
        if (info?.notRun) {
          if (info.note) appendText(cell.out, info.note, true);
          return resolve({ ok: false, ms: 0, notRun: info.notRun, ...(info.note ? { note: info.note } : {}) });
        }
        resolve({ ok: false, ms: 0, stopped: true });
      },
    })));
  }
  // The reactive notebook's per-cell seed: SHA-256 of the notebook's seed (made
  // once, kept in the document) and the cell's id, so a cell draws the same
  // random numbers however often and in whatever order it runs, and verify()
  // recomputes them exactly.  (Python's random, numpy.random, Sage's: not os.urandom.)
  async function cellSeed(cell) {
    if (!reactive() || !crypto.subtle) return null;
    if (!/^[0-9a-f]{64}$/.test(meta.seed ?? "")) {
      meta = { ...meta, seed: [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("") };
      gateCfg = null;
      schedule();
    }
    const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${meta.seed}:${cell.id}`));
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // (the kernel runs them in order; the reactive notebook in graph order)
  // (`gesture`: a person's Run all: their consent to every code cell as shown)
  const runAll = (gesture = false) => (reactive() ? engine().runAll(gesture ? consentFor(cells().filter((c) => c.type === "code").map((c) => c.id)) : {}) : Promise.all(cells().map((c) => run(c))));

  // ---------------------------------------------------------- the reactive notebook
  // (design/reactive-notebook.md; the scheduler is src/notebook-reactive.ts,
  // the analysis a worker's: opts.analyzer.analyze(code, mode))
  let reactiveOn = !!opts.reactive;
  let budget = opts.budget ?? 2000;
  const reactive = () => reactiveOn && !!kernel && !!opts.analyzer;
  const analyses = new Map(); // mode + code -> Promise<analysis>
  const cellById = (id) => cells().find((c) => c.id === id);
  // The scheduler of the interpreter's state: one per interpreter (kept on it).
  function engine() {
    if (kernel.reactive) kernel.reactive.budget = budget; // (the notebook's, when interpreters are switched)
    if (!kernel.reactive) {
      // (the notebook shown may change: this scheduler acts only while its
      // interpreter is the one shown; otherwise its runs stop, it sees the
      // cells it last saw, and it touches no other notebook's cells)
      const k = kernel;
      const shown = () => kernel === k;
      let lastCells = [];
      const baseHost = {
        // (a cell's code is its text version's text: what a consent captured is what is registered)
        cells: () => (shown() ? (lastCells = cells().filter((c) => c.type === "code").map((c) => ({ id: c.id, code: c.version.text, version: c.version, manual: !!c.metadata?.sagebrush?.manual }))) : lastCells),
        analyze(code) {
          const key = mode + "\0" + code;
          if (!analyses.has(key)) {
            if (analyses.size > 2000) analyses.clear();
            analyses.set(key, opts.analyzer.analyze(code, mode).then((a) => {
              // (the analyzer failed, not the code: not kept, so that the next run asks again)
              if (a.error?.kind === "analyzer") analyses.delete(key);
              return a.error ? a : { defs: new Set(a.defs), refs: new Set(a.refs), deleted: new Set(a.deleted), mutations: new Set(a.mutations ?? []), imports: new Map(a.imports ?? []) };
            }));
          }
          return analyses.get(key);
        },
        execute(id, code, forget, scoped, extra) {
          if (!shown()) return Promise.resolve({ ok: false, ms: 0, stopped: true });
          const cell = cellById(id);
          return cell ? execCell(cell, code, forget, scoped, extra).then((x) => { markEdited(cell); return x; }) : Promise.resolve({ ok: false, ms: 0, stopped: true });
        },
        forget: (names, _cells, extra) => new Promise((resolve) => k.execute("", { mode, forget: names, ...(extra ?? {}) }, { start() {}, out() {}, display() {}, interact() {}, clear() {}, done: resolve, stopped: resolve, skipped: resolve })),
        // page-order scoping (src/rename.ts in the analyzer's worker)
        ...(opts.analyzer?.rename ? { rename: (q) => opts.analyzer.rename({ ...q, mode, sep: SCOPE_SEP }) } : {}),
        status(id, st) {
          if (!shown()) return;
          const cell = cellById(id);
          if (cell) { showStatus(cell, st); markEdited(cell); }
          emit("status", id, st);
        },
      };
      // (a remote kernel: every run is checked and admitted by its gate)
      const r = (kernel.reactive = new Reactive(k.remoteGate ? k.remoteGate.host(baseHost) : baseHost));
      r.budget = budget;
    }
    return kernel.reactive;
  }
  const label = (id) => { const c = cellById(id); return c ? `cell ${index(c) + 1}` : "a deleted cell"; };
  const labels = (ids) => ids.map(label).join(", ").replace(/, ([^,]*)$/, " and $1");
  const secs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);
  function errorText(e) {
    if (e.name) e = { ...e, name: kernel?.reactive ? kernel.reactive.written(e.name) : e.name };
    switch (e.kind) {
      case "analyzer":
        return `This cell could not be analyzed (${e.message}). Run it again.`;
      case "multiple-definition":
        return e.reading
          ? `${e.name} is defined by ${labels(e.cells)}, so this cell cannot tell which one it reads. Rename it in all but one of them.`
          : `${e.name} is also defined by ${labels(e.cells)}. A name read by other cells can be defined by only one cell: rename it in one of them, or start it with _ to keep it private to its cell.`;
      case "cycle":
        return `${labels(e.cells)} depend on each other in a cycle, so none of them can run first. Move a definition to break it.`;
      case "import-star":
        return `${e.message} Import the names you use (from m import a, b), or the module (import m).`;
      default:
        return /^SyntaxError\b/.test(e.message ?? "") ? e.message : `SyntaxError: ${e.message}`;
    }
  }
  function showStatus(cell, st) {
    const cls = cell.el.classList;
    if (st.state === "queued") {
      cls.remove("stale", "cancelled", "error");
      cls.add("queued");
      cell.n.textContent = "[*]";
      armStop(cell);
      return;
    }
    if (st.state === "running" || st.state === "done") return; // (execCell's sink)
    settle(cell);
    if (st.state === "stale") {
      cls.remove("cancelled", "error");
      const ms = kernel?.reactive?.times.get(cell.id);
      const why = { budget: `not rerun automatically${ms ? ` (it takes about ${secs(ms)})` : ""}`, manual: "a manual cell: run it yourself", ancestor: "a cell it depends on is stale", interrupted: "interrupted", loaded: "not computed in this session", restart: "the interpreter restarted", approval: st.note?.trim() || "not run on the remote kernel: run it to approve it" }[st.why] ?? "";
      cls.add("stale");
      // (with how long it took last time, if known)
      const est = ms != null && ms > 0 && st.why !== "budget" ? ` (~${secs(ms)})` : "";
      cell.time.textContent = "stale" + (st.why === "budget" || st.why === "manual" ? ": " + why : "") + est;
      cell.time.title = `Stale: ${why}. Run the cell to update it.`;
      // (the cell the restart stopped says so, not merely stale)
      if (cell.stoppedAfter != null) {
        cell.time.textContent = stoppedText(cell.stoppedAfter);
        cell.time.title = STOPPED_TITLE;
      }
      if (cell.n.textContent === "[*]") cell.n.textContent = "[ ]";
      return;
    }
    forgetInteracts(cell.out);
    cell.out.textContent = "";
    cell.time.textContent = "";
    freshen(cell);
    cell.n.textContent = "[ ]";
    if (st.state === "cancelled") {
      cls.remove("error");
      cls.add("cancelled");
      const what = { exception: "raised an error", error: "has an error", interrupted: "was interrupted" }[st.why];
      appendText(cell.out, `Not run: ${label(st.by)}, which this cell depends on, ${what}.\n`, true);
    } else if (st.state === "error") {
      cls.remove("cancelled");
      cls.add("error");
      // a syntax error in a cell just run: the interpreter shows it (where, and in
      // its language's words); such a cell defines nothing, so running it is harmless.
      // (Not on a remote kernel: it runs only what a person's Run approved, through the gate, so the
      // analyzer's own message is shown, below, and nothing is sent.)
      if (st.submitted && st.errors.every((e) => e.kind === "syntax") && !kernel?.remote) {
        execCell(cell, cell.ta.value).then(() => cls.add("error"));
        markEdited(cell);
        return;
      }
      for (const e of st.errors) appendText(cell.out, errorText(e) + "\n", true);
      // the fix of a name several cells define: the later definitions get new names, in page order
      const names = [...new Set(st.errors.filter((e) => e.kind === "multiple-definition").map((e) => e.name))];
      if (names.length && opts.analyzer?.rename && !opts.readOnly) {
        const bar = cell.out.appendChild(h("div", "fixes"));
        for (const n of names) {
          const b = bar.appendChild(h("button", "", { textContent: `Rename the later definitions of ${n} (${n}_2, …)`, title: `Keep the meaning of the cells in page order: each cell below the first that defines ${n} defines ${n}_2, ${n}_3, …, and the cells below it read that one` }));
          b.onclick = async () => {
            b.disabled = true;
            const r = await fixRedefinitions(n);
            if (!r) { b.disabled = false; b.textContent = `Cannot rename ${n} automatically here: rename it by hand`; }
          };
        }
      }
      markEdited(cell);
    }
  }
  // Give `name` one defining cell, keeping the meaning of the cells in page
  // order (src/rename.ts), and run what changed.  Resolves to the run's
  // report, or null if it cannot be done automatically.
  async function fixRedefinitions(name) {
    if (!reactive() || !opts.analyzer?.rename) return null;
    const r = engine();
    const code = cells().filter((c) => c.type === "code");
    const taken = new Set();
    const info = await Promise.all(code.map(async (c) => {
      const a = await r.host.analyze(c.ta.value);
      if (!a.error) for (const n of [...a.defs, ...a.refs]) taken.add(n);
      return { id: c.id, code: c.ta.value, defines: !a.error && a.defs.has(name), reads: !a.error && a.refs.has(name) };
    }));
    const sources = await opts.analyzer.rename({ name, cells: info, taken: [...taken], mode });
    if (!sources) return null;
    return (await applyEdits({ set: sources.map(([id, c]) => ({ id, code: c })) })).report ?? {};
  }
  // A manual cell (kept in its metadata, sagebrush.manual) never reruns automatically.
  function setManual(cell, on) {
    const sb = { ...(cell.metadata?.sagebrush ?? {}) };
    if (on) sb.manual = true;
    else delete sb.manual;
    const md = { ...(cell.metadata ?? {}) };
    if (Object.keys(sb).length) md.sagebrush = sb;
    else delete md.sagebrush;
    cell.metadata = Object.keys(md).length ? md : null;
    showManual(cell);
    schedule();
  }
  function showManual(cell) {
    const on = !!cell.metadata?.sagebrush?.manual;
    cell.el.classList.toggle("manual", on);
    cell.runb.title = on ? "A manual cell: it runs only when you run it (Shift+Enter)" : cell.type === "code" ? "Run (Shift+Enter)" : cell.runb.title;
  }
  // A cell whose code differs from what last ran ("edited": its output and
  // what other cells see are the old code's)
  function markEdited(cell) {
    const r = kernel?.reactive;
    const sub = reactive() && r ? r.submitted(cell.id) : undefined;
    // (or never ran, with code)
    cell.el.classList.toggle("edited", reactive() && cell.type === "code" && (sub !== undefined ? sub !== cell.ta.value : cell.ta.value.trim() !== ""));
  }
  // The page changed outside the scheduler (cells moved, deleted elsewhere, a document loaded).
  function reactiveSync() {
    if (!reactive() || !kernel.reactive) return;
    // (with page-order scoping, a move can change what a cell reads: those rerun)
    kernel.reactive.reordered();
    for (const c of cells()) if (c.type === "code") markEdited(c);
  }
  const interrupt = () => kernel?.interrupt(STOP_MESSAGE);
  function clearOutputs() {
    for (const c of cells()) if (c.type === "code") { forgetInteracts(c.out); c.out.textContent = ""; c.time.textContent = ""; c.n.textContent = "[ ]"; freshen(c); }
  }

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
    resizing = requestAnimationFrame(() => cellsEl.querySelectorAll(".ed textarea, .mb-edit textarea").forEach(autosize));
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
  // A cell's editor text: the only assignment of it, with its text version (remote approval's: a frozen
  // object replaced with the text; the input listener replaces it for typing and execCommand).
  function setText(cell, text) {
    cell.ta.value = text;
    cell.version = Object.freeze({ text: cell.ta.value });
  }
  function addCell(code = "", where = null, focus = false, type = "code", id = null) {
    const el = h("div", "cell");
    el.tabIndex = -1;
    el.setAttribute("role", "group");
    el.innerHTML = `<div class="gutter" draggable="true" title="Drag to move the cell"><span class="n">[ ]</span><button class="runb" data-a="run" draggable="false">▶</button></div>`
      + `<div class="body"><div class="ed"><pre aria-hidden="true"></pre><textarea rows="1" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea></div><div class="mdout" tabindex="0" title="Double-click or press Enter to edit"></div><div class="out"></div><div class="time"></div></div>`
      + `<div class="head" role="toolbar"><span class="drag" draggable="true" title="Drag to move the cell" aria-hidden="true">⠿</span><select data-a="type" aria-label="Cell type" title="Cell type (M: Markdown, Y: code, R: raw)"><option value="code">Code</option><option value="markdown">Markdown</option><option value="raw">Raw</option></select><button data-a="up" title="Move up (Alt+↑)" aria-label="Move up">↑</button><button data-a="down" title="Move down (Alt+↓)" aria-label="Move down">↓</button><button data-a="del" title="Delete (D D; Z undoes)" aria-label="Delete">${TRASH_SVG}</button><button data-a="menu" aria-haspopup="menu" aria-expanded="false" title="Cell actions">⋯</button></div>`
      + `<div class="adder"><button data-a="addcode" title="Insert a code cell below">+ Code</button><button data-a="addmd" title="Insert a Markdown (text) cell below">+ Text</button></div>`;
    const q = (s) => el.querySelector(s);
    const cell = { id: id ?? cellId(), el, type: "code", ta: q("textarea"), hl: q(".ed pre"), out: q(".out"), md: q(".mdout"), time: q(".time"), n: q(".n"), runb: q(".runb"), typeSel: q('[data-a="type"]'), menuBtn: q('[data-a="menu"]'), attachments: null, metadata: null, blocks: null, blocksText: null };
    el.cell = cell;
    cell.md.addEventListener("dblclick", (e) => { if (!opts.readOnly) editMd(cell, { x: e.clientX, y: e.clientY }); });
    setText(cell, code);
    cell.ta.readOnly = !!opts.readOnly;
    // (typing and execCommand edits: a new text version first)
    cell.ta.addEventListener("input", () => { cell.version = Object.freeze({ text: cell.ta.value }); autosize(cell.ta); paint(cell); refilter(cell); markEdited(cell); });
    cell.ta.addEventListener("blur", () => { if (comp?.cell === cell) closeCompleter(); });
    cell.ta.addEventListener("click", () => { if (comp?.cell === cell) closeCompleter(); });
    cell.ta.addEventListener("keydown", (e) => editKey(cell, e));
    // (Stop, while the cell is queued or running; not the second click of a double click, nor one just after the
    // button turned into Stop: stop-guard.js)
    cell.runb.onclick = (e) => {
      if (!(el.classList.contains("running") || el.classList.contains("queued"))) return run(cell, true);
      if (!stopIgnored(cell.stopArmedAt, performance.now(), e?.detail ?? 0)) interrupt();
    };
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
    if (focus) focusInput(cell, "start");
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
  cellsEl.addEventListener("pointerdown", (e) => { const c = e.target.closest(".cell")?.cell; if (c) { activate(c); if (e.isTrusted && c.type === "code") warm(); } });
  // X1: the language's environment loaded at the user's first action in a
  // code cell (pointing at it, typing in it, moving onto it with the
  // keyboard) or their choice of the language (nb.warm, index.html's menu),
  // not at opening: never from focus (element.focus() makes trusted focus
  // events) nor from load or restore.  The kernel sends one warm-up per
  // language and interpreter while it is pending or done (worker-kernel.js
  // warm), so this is a Map lookup for every later action.
  function warm() {
    if (kernel?.warm) kernel.warm(mode);
  }
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
    if (ensureBlocks(cell)) { cell.blocks.focus(where === "start" ? "start" : "end"); cell.el.scrollIntoView({ block: "nearest" }); return; }
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
    const cm = isMagma() ? "//" : isMatlab() ? "%" : "#", full = ls.filter((l) => l.trim());
    if (!full.length) return ls;
    if (full.every((l) => l.trimStart().startsWith(cm))) return ls.map((l) => l.replace(new RegExp(`^(\\s*)${cm} ?`), "$1"));
    const ind = Math.min(...full.map((l) => /^\s*/.exec(l)[0].length));
    return ls.map((l) => (l.trim() ? l.slice(0, ind) + cm + " " + l.slice(ind) : l));
  }

  // Split a cell at the caret (or around the selection): Ctrl+Shift+- as in Jupyter, Ctrl+; as in CoCalc.
  function split(cell) {
    const v = cell.ta.value, s0 = cell.ta.selectionStart, s1 = cell.ta.selectionEnd;
    const parts = (s1 > s0 ? [v.slice(0, s0), v.slice(s0, s1), v.slice(s1)] : [v.slice(0, s0), v.slice(s0)]).map((p) => p.replace(/^\n/, "").replace(/\n$/, ""));
    setText(cell, parts[0]);
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
    setText(cell, [cell.ta.value, below.ta.value].filter((s) => s.trim()).join("\n"));
    below.el.remove();
    forgetInteracts(cell.out); cell.out.textContent = ""; cell.time.textContent = "";
    autosize(cell.ta); paint(cell); relabel();
    if (cell.el.classList.contains("rendered")) renderMd(cell);
    select(cell);
    announce("Cells merged");
  }

  // Edit mode keys: run, leave, move between cells, indent, comment, split.
  function editKey(cell, e) {
    if (e.isTrusted && cell.type === "code") warm();
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
      run(cell, true);
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
      if (isMatlab() ? /^\s*(if|for|parfor|while|function|switch|case|otherwise|try|catch|else|elseif)\b(?!.*\bend\b)/.test(line) : !isMagma() && /:\s*(#.*)?$/.test(line)) ind += "    ";
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
    // its names go; the cells reading them rerun
    if (reactive() && cell.type === "code") engine().remove([cell.id]);
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
    reactiveSync();
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
    // (command mode: a key that lands on a code cell, the one selected after it)
    if (e.isTrusted) queueMicrotask(() => { if (active?.type === "code") warm(); });
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Enter" && (e.shiftKey || mod || e.altKey)) {
      e.preventDefault();
      run(cell, true);
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
    reactiveSync();
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
    // (a Markdown cell being written is blocks; one about to be shown rendered,
    // as a notebook's are when it opens, is not made blocks first)
    if (cell.type === "markdown") queueMicrotask(() => ensureBlocks(cell));
    else closeBlocks(cell);
    paint(cell);
    relabel();
  }
  // (or 200 ms, whichever is first: a hidden page, e.g. a background tab, does not paint)
  const afterPaint = () => new Promise((resolve) => { requestAnimationFrame(() => setTimeout(resolve, 0)); setTimeout(resolve, 200); });
  // Highlight fenced Python/Sage code in Markdown as in code cells.
  const mdHighlight = (code, lang) => (/^(matlab|m)$/i.test(lang ?? "") || (!lang && isMatlab()) ? highlightMatlab(code).replace(/\n$/, "")
    : !lang || /^(python|py|python3|sage|ipython)$/i.test(lang) ? highlight(code, /sage/i.test(lang) || (!lang && isSage())).replace(/\n$/, "") : null);
  async function renderMd(cell) {
    closeBlocks(cell);
    cell.md.innerHTML = cell.ta.value.trim() ? renderMarkdown(cell.ta.value, { highlight: mdHighlight, attachments: cell.attachments, pixels, remote: remotePictures() }) : '<p class="hc">Empty Markdown cell: double-click to edit.</p>';
    cell.el.classList.add("rendered");
    if (cell.md.querySelector(".math")) {
      await afterPaint(); // the text shows first; KaTeX (275 KB) typesets the math after
      try { (await loadMath()).typeset(cell.md); } catch {}
    }
    schedule();
  }
  // (at: where it was double-clicked: that block, the caret there; nothing
  // moves, as the blocks are laid out as the text was shown)
  function editMd(cell, at) {
    cell.el.classList.remove("rendered");
    if (ensureBlocks(cell)) return cell.blocks.focus(at ?? "end");
    autosize(cell.ta);
    cell.ta.focus();
  }
  // A Markdown cell being written: its text as blocks (web/board/blocks.ts),
  // each shown rendered until it is clicked, then its own Markdown, as a
  // board's text is.  The cell's textarea keeps the text: what is saved,
  // merged, recorded and run; the blocks write to it, and follow it (paint).
  const ensureBlocks = (cell) => (cell.type === "markdown" && !cell.el.classList.contains("rendered") && cell.el.isConnected ? openBlocks(cell) : cell.blocks);
  function openBlocks(cell) {
    if (cell.blocks || opts.readOnly) return cell.blocks;
    const b = new BlockEditor(cell.ta.value, {
      render: (src) => renderMarkdown(src, { highlight: mdHighlight, attachments: cell.attachments, pixels, remote: remotePictures() }),
      typeset: (el) => { loadMath().then((m) => m.typeset(el)).catch(() => {}); },
      highlight: (src) => highlightMarkdown(src, isSage()),
      placeholder: "Text: Markdown, with math: $x^2$",
      onChange: (v) => { cell.blocksText = v; setText(cell, v); cell.ta.dispatchEvent(new Event("input")); },
      onKey: (e) => mdKey(cell, e),
      onEdge: (up) => { const to = up ? prevCell(cell) : nextCell(cell); if (!to) return false; edit(to, up ? "end" : "start"); return true; },
    });
    cell.blocks = b;
    cell.blocksText = cell.ta.value;
    cell.ta.closest(".ed").before(b.el);
    cell.el.classList.add("blocks");
    return b;
  }
  function closeBlocks(cell) {
    if (!cell.blocks) return;
    cell.blocks.el.remove();
    cell.blocks = cell.blocksText = null;
    cell.el.classList.remove("blocks");
  }
  // The notebook's keys in a block being written: Shift/Ctrl/Alt+Enter show
  // the text (and go on), Esc is command mode, Alt+↑/↓ move the cell.
  function mdKey(cell, e) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Enter" && (e.shiftKey || mod || e.altKey)) {
      e.preventDefault();
      run(cell, true);
      if (e.shiftKey) advance(cell);
      else if (e.altKey && !opts.readOnly) addCell("", { after: cell.el }, true);
    } else if (e.key === "Escape" || (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "m")) {
      e.preventDefault();
      select(cell);
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      move(cell, e.key === "ArrowUp" ? -1 : 1);
    } else return false;
    return true;
  }
  // Write in a cell: its blocks (Markdown) or its editor.
  function focusInput(cell, where = "end") {
    if (ensureBlocks(cell)) return cell.blocks.focus(where);
    cell.ta.focus();
    if (where === "start") cell.ta.setSelectionRange(0, 0);
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
    if (next.el.classList.contains("rendered")) next.md.focus();
    else focusInput(next, "start");
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
    reactiveSync();
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
    // (the reactive notebook: a manual cell never reruns automatically)
    const man = menu.querySelector('[data-m="manual"]');
    man.hidden = !reactive() || cell.type !== "code";
    man.setAttribute("role", "menuitemcheckbox");
    man.setAttribute("aria-checked", String(!!cell.metadata?.sagebrush?.manual));
    man.textContent = (cell.metadata?.sagebrush?.manual ? "✓ " : "") + "Run only by hand";
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
      case "type": setType(cell, cell.type === "markdown" ? "code" : "markdown"); schedule(); return focusInput(cell);
      case "split": return split(cell);
      case "clear": if (cell.type === "markdown") return focusInput(cell); forgetInteracts(cell.out); cell.out.textContent = ""; cell.time.textContent = ""; cell.n.textContent = "[ ]"; return cell.ta.focus();
      case "delete": return remove(cell);
      case "manual": setManual(cell, !cell.metadata?.sagebrush?.manual); return cell.menuBtn.focus();
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
  let loading = false, timer = null, lastJson = null, store = null, unsubscribe = null, saveChain = Promise.resolve(), savesPending = 0, lastSaveError = null;
  // The document shown, from when it is loaded until another is (or it is
  // detached): what is known of it, which its saves keep to, even one still
  // waiting its turn when another document is shown (CORR-989-1).
  // - synced: the document last known to be the store's (loaded, received,
  //   or saved here): its revision and cells by id, the base of three-way
  //   merges with changes from elsewhere (stores.js: revisions)
  // - remoteSeen: documents applied from elsewhere so far: a save waiting
  //   its turn, made before one, is made again from what is here then, which
  //   has that change merged in, so it never writes the change back over
  //   (CORR-0B0-2); only while this document is the one shown
  let shown = { synced: null, remoteSeen: 0 };
  // (the page's: keeps a save of a document no longer shown that met a change made elsewhere)
  let detachedConflict = null;
  // (such saves the page couldn't keep, the latest of each showing: tried
  // again by saved(), which rejects while any is not kept; a save of
  // another document doesn't make them kept, CORR-E46-1.  Every keeping,
  // first or again, runs in turn with the saves (saveChain), so an older
  // one never lands after a newer one, CORR-900-1)
  const unkept = new Map();
  // (documents left with saves still to make, or not kept: at most
  // MAX_LEFT; past it, no other document is shown until they are, so what
  // is held for them is bounded, LIMIT-900-2)
  const MAX_LEFT = 4;
  const outstanding = new Set();
  const leftCount = () => [...outstanding].filter((s) => s !== shown).length;
  // ("left": how many, said whenever it may have changed: the page asks
  // before closing while there are any, their saves only here)
  const leftChanged = () => emit("left", leftCount());
  // (one whose save was busy stays outstanding until it is sent again: counted, asked about before closing)
  const leftSettled = (s) => { if (!s.inflight && !unkept.has(s) && !busy.has(s)) outstanding.delete(s); leftChanged(); };
  async function keepDetached(key, doc, theirs) {
    try {
      if (!detachedConflict) throw new Error("changed elsewhere after it was closed here, and not kept");
      await detachedConflict(doc, theirs, key);
      unkept.delete(key);
      leftSettled(key);
    } catch (e) {
      unkept.set(key, { doc, theirs, error: e ?? new Error("not kept") });
      outstanding.add(key);
      leftChanged();
      emit("saved", `not saved: ${doc.name ?? "a notebook"} changed elsewhere after it was closed here, and your changes to it couldn't be kept (${e?.message ?? e})`);
    }
  }
  const cellType = (c) => (c.type === "markdown" || c.type === "raw" ? c.type : "code");
  const cellKey = (c) => ({ code: c.code ?? "", outputs: JSON.stringify(c.outputs ?? []), type: cellType(c), metadata: JSON.stringify(c.metadata ?? null), ms: c.ms ?? null });
  const syncedOf = (rev, list) => ({ rev, cells: new Map((list ?? []).map((c) => [c.id, cellKey(c)])) });
  const setSynced = (rev, list) => { shown.synced = syncedOf(rev, list); };
  function snapshot() {
    return {
      ...meta, mode,
      cells: cells().map((c) => ({
        ...(c.type === "markdown"
          ? { id: c.id, type: "markdown", code: c.ta.value, ...(c.attachments ? { attachments: c.attachments } : {}) }
          : c.type === "raw"
            ? { id: c.id, type: "raw", code: c.ta.value }
            : { id: c.id, code: c.ta.value, outputs: saveOutputs(c.out), n: (/\[(\d+)\]/.exec(c.n.textContent) || [])[1] ?? null, ...(c.ms != null ? { ms: c.ms } : {}) }),
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
    const doc = snapshot(), json = JSON.stringify(doc), mine = shown, seen = mine.remoteSeen;
    if (json === lastJson) return;
    lastJson = json;
    emit("change", doc);
    if (store) queueSave(mine, store, doc, json, seen);
  }
  // (a save the workspace's lock didn't let through in time, "busy" (notebook/stores.js LOCK_WAIT): kept by
  // document, and sent again as it was by the next saved(), whether that document is still shown or was left;
  // nothing of it is lost while another tab holds the lock)
  const busy = new Map();
  function queueSave(mine, st, doc, json, seen) {
    {
      // (this document's saves numbered: a busy one is kept only if no later save of it was asked for since, and
      // a later one that succeeds supersedes it, so an older edit is never sent again over a newer one: astra's
      // CORR-9D7-1)
      const seq = mine.saveSeq = (mine.saveSeq ?? 0) + 1;
      busy.delete(mine);
      let sent = doc;
      mine.inflight = (mine.inflight ?? 0) + 1;
      outstanding.add(mine);
      leftChanged();
      // saves run one after another (a slow earlier write cannot land after
      // a later one), and a failed save is retried by the next flush; each
      // is made from the synced revision when it starts (stores.js)
      const start = () => {
        if (mine === shown && seen !== mine.remoteSeen) sent = snapshot();
        const base = mine.synced?.rev;
        try { return Promise.resolve(st.save(base !== undefined ? { ...sent, baseRev: base } : sent)); } catch (e) { return Promise.reject(e); }
      };
      // (started at once when no earlier save is pending)
      const p = savesPending ? saveChain.then(start) : start();
      savesPending++;
      saveChain = p.then((t) => {
        // (an older busy one, superseded by this save: its error no longer stands, and it isn't sent again)
        if ((busy.get(mine)?.seq ?? Infinity) <= seq) busy.delete(mine);
        if (mine.busyError && mine.busySeq <= seq) { if (lastSaveError === mine.busyError) lastSaveError = null; mine.busyError = null; }
        if (t && typeof t === "object" && t.conflict) {
          // written elsewhere first: merge that, then save the merge; a
          // document no longer shown has nothing here to merge into: what
          // this save had is kept by the page, beside the other, never over
          // it, before saved() resolves (CORR-B54-1)
          if (mine !== shown || store !== st) {
            return keepDetached(mine, sent, t.conflict);
          }
          if (lastJson === json) lastJson = null;
          applyRemote(t.conflict, true, true);
          return;
        }
        // (its revision kept for its next save, shown or not)
        const r = t && typeof t === "object" ? t.rev : undefined;
        if (r === undefined || mine.synced?.rev === undefined || r > mine.synced.rev) mine.synced = syncedOf(r, sent.cells);
        if (mine !== shown || store !== st) return;
        lastSaveError = null;
        emit("saved", (t && typeof t === "object" ? t.saved : t) ?? "saved");
      }, (e) => {
        if (lastJson === json) lastJson = null;
        // (a busy one superseded by a later save of this document, asked for since: that one answers for it)
        if (e?.busy && seq !== mine.saveSeq) return;
        if (e?.busy) { busy.set(mine, { st, sent, json, seq }); mine.busyError = e; mine.busySeq = seq; }
        lastSaveError = e ?? new Error("not saved");
        emit("saved", "not saved: " + (e?.message ?? e));
      }).finally(() => { savesPending--; mine.inflight--; leftSettled(mine); });
    }
  }
  // Every change so far saved: resolves once the saves asked for (this one
  // too, and a merge a conflict asked for) are done; rejects with why, if
  // the last one failed, or if what is here is still not saved after a few
  // rounds (written elsewhere each time, CORR-7F9-1).  For leaving the page
  // (the notebook's Whiteboard)
  async function saved() {
    for (let i = 0; i < 5; i++) {
      flush();
      // (busy ones sent again, the shown document's by flush already)
      for (const [m, b] of [...busy]) if (busy.get(m) === b && m !== shown) queueSave(m, b.st, b.sent, b.json, m.remoteSeen);
      await saveChain;
      if (lastSaveError) throw lastSaveError;
      // (saves of documents no longer shown that couldn't be kept: tried
      // again, in turn with the saves; one kept or replaced meanwhile isn't)
      if (unkept.size) {
        saveChain = saveChain.then(async () => { for (const [key, u] of [...unkept]) if (unkept.get(key) === u) await keepDetached(key, u.doc, u.theirs); });
        await saveChain;
      }
      if (unkept.size) throw [...unkept.values()].at(-1).error;
      if (!timer && !savesPending) return;
    }
    throw new Error("changed elsewhere each time it was saved");
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
      cell.ms = typeof c.ms === "number" && c.ms >= 0 ? c.ms : null;
      if (opts.staleOnLoad && !kernel?.ran?.has(cell.id)) markStale(cell);
    }
  }
  // Show a document, replacing what is there.
  function load(doc) {
    loading = true;
    shown = { synced: null, remoteSeen: 0 }; // (another document: its own)
    leftChanged();
    pixels = new PixelBudget();
    const { cells: list, mode: m, rev, baseRev: _b, ...rest } = doc;
    meta = rest;
    gateCfg = null;
    kernel?.remoteGate?.documentReplaced(); // (another document: approvals and records start over)
    setMode(m ?? mode, false);
    closeCompleter(); closeMenu(false); activate(null);
    cellsEl.textContent = "";
    execCount = 0; // (without a kernel; an interpreter keeps its own count)
    for (const c of list?.length ? list : [{ code: "" }]) fill(addCell(c.code ?? "", null, false, c.type, c.id), c);
    const snap = snapshot();
    lastJson = JSON.stringify(snap);
    setSynced(rev, snap.cells);
    Promise.resolve().then(() => { loading = false; }); // after the observer's records for this
    reactiveLoad();
  }
  // The reactive notebook takes the document's cells as they are: their
  // code registered, stale unless this interpreter computed them.
  function reactiveLoad() {
    if (!reactive()) return;
    const a = meta.autorun;
    budget = a === "always" ? Infinity : a === "never" ? 0 : typeof a === "number" && a >= 0 ? a : opts.budget ?? 2000;
    for (const c of cells()) if (c.type === "code") showManual(c);
    if (kernel.reactive) reactiveSync();
    else engine().load({ fresh: kernel.ran ?? new Set() });
    seedTimes();
    emit("budget", budget); // (after: a listener may ask for the engine)
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
    if (keepLocal && rev !== undefined && shown.synced?.rev !== undefined && rev <= shown.synced.rev && !fromConflict) return;
    // (an edit made here merged with one made there, as CoCalc's set_cell_input does (plan-exact-only r1): the journal
    // store's mergeText (cocalc-ai's mergeText, from the lazily loaded history bundle).  None for a revert, nor for a
    // store without it (a page's local store before the journal, the embed's memory store: no sync), which keeps the
    // older rule: theirs, and this one in a copy)
    const merge = keepLocal ? store?.mergeText : undefined;
    shown.remoteSeen++;
    loading = true;
    const base = keepLocal ? shown.synced?.cells ?? null : null;
    let dirty = false;
    meta = { ...meta, ...rest };
    gateCfg = null;
    if (!keepLocal) kernel?.remoteGate?.documentReplaced(); // (a revert replaces the document)
    if (m && m !== mode) setMode(m, false);
    const order = cells().map((c) => c.id);
    const mine = new Map(cells().map((c) => [c.id, c]));
    let prev = null;
    for (const rc of list ?? []) {
      const b = base?.get(rc.id);
      let c = mine.get(rc.id);
      if (!c) {
        // deleted here and unchanged there: stays deleted (with the merge: unless its input changed there; new outputs
        // alone don't bring a cell back, as in dbMerge3)
        if (b && b.code === (rc.code ?? "") && (merge || b.outputs === JSON.stringify(rc.outputs ?? []))) { dirty = true; continue; }
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
      // the last run time (a cache, never a conflict): a change here only is
      // kept; otherwise the incoming one, unless it has none
      if (c.type === "code") {
        const lt = c.ms ?? null, rt = typeof rc.ms === "number" && rc.ms >= 0 ? rc.ms : null;
        if (lt !== rt) {
          if (rt === null || (b && b.ms === rt)) dirty = true;
          else {
            c.ms = rt;
            kernel?.reactive?.times.set(c.id, rt);
          }
        }
      }
      const L = c.ta.value, Rt = rc.code ?? "";
      let textChanged = false, conflictText = null, text = Rt, sel = null;
      if (L !== Rt) {
        if (b && b.code === Rt) dirty = true; // changed here only: kept
        else if (b && b.code !== L) { // changed on both sides
          dirty = true;
          if (merge) {
            // (the two merged, the selection mapped onto the result; no copy)
            ({ text, sel } = merge({ base: b.code, local: L, remote: Rt, sel: [c.ta.selectionStart, c.ta.selectionEnd] }));
            textChanged = text !== L;
          } else { textChanged = true; conflictText = L; }
        } else textChanged = true; // changed there only
      }
      if (textChanged) {
        const dir = c.ta.selectionDirection;
        setInput(c, text);
        if (sel && document.activeElement === c.ta) c.ta.setSelectionRange(sel[0], sel[1], dir);
      }
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
            if (opts.staleOnLoad) { markStale(c); kernel?.reactive?.staleFromElsewhere(c.id); }
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
    reactiveSync();
    seedTimes(); // (cells new from there)
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
    setText(cell, text);
    if (focused) cell.ta.setSelectionRange(Math.min(s0, text.length), Math.min(s1, text.length));
    autosize(cell.ta);
    paint(cell);
    markEdited(cell);
    schedule();
  }
  function setMode(m, notify = true) {
    const before = mode;
    mode = ["python", "sage", "magma", "matlab"].includes(m) ? m : "python";
    gateCfg = null;
    for (const c of cells()) paint(c);
    if (notify) { emit("mode", mode); schedule(); }
    // (the reactive notebook: its cells are analyzed again in the new language, and stale)
    if (mode !== before && reactive() && kernel.reactive) {
      kernel.reactive.reset();
      kernel.remoteGate?.documentReplaced();
    }
  }

  // ---------------------------------------------------------- for agents
  // An agent's batch of changes, applied together and then run once (the
  // reactive notebook: what they affect reruns, in graph order):
  //   {set: [{id, code?, type?}], insert: [{code, type?, after?: id | null (first), id?}], remove: [id]}
  // Resolves to {ids (of inserted cells), report (the run's), outputs (id -> text of the cells that ran)}.
  async function applyEdits(changes = {}, { run: doRun = true, budget: b } = {}) {
    const changed = [];
    for (const c of changes.set ?? []) {
      const cell = cellById(c.id);
      if (!cell) throw new Error(`no cell ${c.id}`);
      if (c.type && c.type !== cell.type) setType(cell, c.type);
      if (typeof c.code === "string" && c.code !== cell.ta.value) setInput(cell, c.code);
      if (cell.type === "markdown") renderMd(cell);
      else if (cell.type === "code") changed.push(cell.id);
    }
    const ids = [];
    for (const c of changes.insert ?? []) {
      const after = c.after === null ? null : c.after !== undefined ? cellById(c.after) : cells().at(-1);
      if (c.after && !after) throw new Error(`no cell ${c.after}`);
      const cell = addCell(c.code ?? "", after ? { after: after.el } : { first: true }, false, c.type ?? "code", c.id ?? null);
      ids.push(cell.id);
      if (cell.type === "markdown") renderMd(cell);
      else if (cell.type === "code") changed.push(cell.id);
    }
    const removed = [];
    for (const id of changes.remove ?? []) {
      const cell = cellById(id);
      if (!cell) continue;
      if (active === cell) activate(null);
      cell.el.remove();
      if (cell.type === "code") removed.push(id);
    }
    if (!cells().length) addCell("");
    relabel();
    schedule();
    let report = null;
    if (doRun && reactive()) report = await engine().run(changed, { remove: removed, ...(b !== undefined ? { budget: b } : {}) });
    else if (doRun) for (const id of changed) await run(cellById(id));
    const ran = report ? report.ran : changed;
    return { ids, report, outputs: Object.fromEntries(ran.map((id) => [id, cellById(id) ? outputText(cellById(id).out) : ""])) };
  }
  // The dependency graph, for agents: each code cell's names and edges, and its state.
  function graph() {
    const r = reactive() ? engine() : null;
    return cells().filter((c) => c.type === "code").map((c, i) => {
      const a = r?.graph.analysis(c.id);
      const cls = c.el.classList;
      // (how its last run ended, from the scheduler: raised, interrupted, waiting)
      const end = r?.outcome.get(c.id);
      const state = cls.contains("running") ? "running" : cls.contains("queued") ? "queued" : cls.contains("error") ? "error" : end === "cancelled" || cls.contains("cancelled") ? "cancelled" : cls.contains("stale") ? "stale" : end === "exception" ? "failed" : end === "stopped" ? "interrupted" : r && r.submitted(c.id) === undefined ? "not run" : "ok";
      const written = (n) => (r ? r.written(n) : n);
      return {
        id: c.id, index: index(c), state, edited: cls.contains("edited"),
        // (names as written: page-order scoping's xʹ2 is x)
        defines: a ? [...new Set([...a.defs].map(written))] : [], reads: a ? [...new Set([...a.refs].filter((n) => r.graph.definers.has(n)).map(written))] : [],
        ...(a?.mutations?.size ? { mutates: [...new Set([...a.mutations].filter((n) => r.graph.definers.has(n)).map(written))] } : {}),
        parents: r ? [...r.graph.parents(c.id)] : [], children: r ? [...r.graph.children(c.id)] : [],
        ...(r?.errors.has(c.id) ? { errors: r.errors.get(c.id).map(errorText) } : {}),
        ...(r?.times.has(c.id) ? { ms: Math.round(r.times.get(c.id)) } : {}),
        ...(c.metadata?.sagebrush?.manual ? { manual: true } : {}),
      };
    });
  }
  // Recompute everything from scratch in a fresh interpreter and compare
  // with what was shown: resolves to {same, changed: [{id, before, after}], report}.
  // (A difference means an output depended on something besides the code:
  // a mutation the graph does not see, the clock, an unseeded random number.)
  async function verify() {
    if (!kernel) throw new Error("no kernel");
    // (compared whole: pictures by their data, not only their descriptions)
    // (with the ids that pictures number from counters made the same, in
    // their SVG only: the plot's sbclip7, and safeSvg's per-picture prefix s12-)
    // (one to one, in order of first use, so that each reference keeps pointing at its own)
    // (in the parsed SVG's id attributes and references only, not its text)
    const ids = (svg) => {
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      if (doc.querySelector("parsererror")) return svg;
      const names = new Map();
      const norm = (id) => {
        id = id.replace(/^s\d+-/, "");
        if (!/^sbclip\d+$/.test(id)) return id;
        if (!names.has(id)) names.set(id, `sbclip#${names.size}`);
        return names.get(id);
      };
      for (const el of doc.querySelectorAll("*")) {
        for (const { name, value } of [...el.attributes]) {
          if (name === "id") el.setAttribute(name, norm(value));
          else if (/(^|:)href$/.test(name) && value.startsWith("#")) el.setAttribute(name, "#" + norm(value.slice(1)));
          else if (/url\(\s*#/i.test(value)) el.setAttribute(name, value.replace(/url\(\s*#([^)\s]*)/gi, (_, id) => "url(#" + norm(id)));
        }
      }
      return new XMLSerializer().serializeToString(doc);
    };
    const whole = (c) => JSON.stringify(saveOutputs(c.out).map((o) => (typeof o.data?.["image/svg+xml"] === "string" ? { ...o, data: { ...o.data, "image/svg+xml": ids(o.data["image/svg+xml"]) } } : o)));
    const before = new Map(cells().filter((c) => c.type === "code").map((c) => [c.id, [outputText(c.out), whole(c)]]));
    const ready = new Promise((resolve) => { const off = kernel.on("ready", () => { off(); resolve(); }); });
    kernel.restart();
    await ready;
    const report = reactive() ? await engine().runAll() : (await Promise.all(cells().map((c) => run(c))), null);
    const same = [], changed = [];
    for (const c of cells()) {
      if (c.type !== "code") continue;
      const after = outputText(c.out), [beforeText, beforeWhole] = before.get(c.id) ?? ["", ""];
      if (whole(c) === beforeWhole) same.push(c.id);
      else changed.push({ id: c.id, before: beforeText, after, ...(after === beforeText ? { pictures: true } : {}) });
    }
    return { same, changed, report };
  }
  // A cell's output as text: pictures by their descriptions, controls by their values.
  function outputText(box) {
    const parts = [];
    for (const el of box.children) {
      if (el.tagName === "PRE") parts.push(el.textContent);
      else if (el.tagName === "FIGURE") parts.push(`[picture: ${el.querySelector("svg")?.getAttribute("aria-label") ?? el.querySelector("img")?.alt ?? ""}]\n`);
      else if (el.classList.contains("latex-out") || el.classList.contains("md-out")) parts.push((el.sbBundle?.["text/plain"] ?? "") + "\n");
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
    root,
    get kernel() { return kernel; },
    get mode() { return mode; },
    get meta() { return meta; },
    get active() { return active; },
    // (run and runAll: programmatic, so with no person's consent; runAllGesture: only from a person's Run all handler)
    cells, addCell, run: (cell) => run(cell), runAll: () => runAll(), runAllGesture: () => runAll(true), interrupt, clearOutputs,
    /** A fresh interpreter; the outputs stay, marked stale until their cells run again. */
    restart() { kernel?.restart(); },
    /** Use another interpreter (each notebook its own, on the full page): the outputs shown become stale unless it made them. */
    setKernel(k, { stale = true } = {}) { if (k === kernel) return; bindKernel(k); if (stale) for (const c of cells()) markStale(c); },
    /** The reactive notebook (design/reactive-notebook.md): on or off, and its budget (ms; Infinity: autorun, 0: lazy). */
    setReactive(on) { reactiveOn = !!on; gateCfg = null; if (on) reactiveLoad(); else for (const c of cells()) c.el.classList.remove("edited", "cancelled", "error"); },
    /** the scheduler (null until the document is loaded, or when off); reactiveOn: whether the notebook is reactive */
    get reactive() { return reactive() ? kernel.reactive ?? null : null; },
    get reactiveOn() { return reactive(); },
    get budget() { return budget; },
    setBudget(ms, { save = true } = {}) {
      budget = ms;
      if (kernel?.reactive) kernel.reactive.budget = ms;
      // (kept in the document: "always", "never" or milliseconds)
      if (save) { meta = { ...meta, autorun: ms === Infinity ? "always" : ms <= 0 ? "never" : ms }; gateCfg = null; schedule(); }
      emit("budget", ms);
    },
    setManual,
    /** Files changed outside the notebook's cells (uploaded, deleted): the cells that read them rerun (the reactive notebook). */
    filesChanged(paths) { return reactive() && kernel.reactive ? kernel.reactive.filesChanged(paths) : Promise.resolve(null); },
    // (what each cell's last run read, by cell id: the Share dialog's runtime evidence, share-ux-plan r2 §2.1)
    fileReads() { return reactive() && kernel.reactive ? new Map([...kernel.reactive.files].map(([id, io]) => [id, [...io.reads]])) : new Map(); },
    /**
     * Each code cell's output key, time from root, whether a widget moved
     * since it ran, and how many files its last run, and those of the cells
     * it depends on, read (design/outputs.md):
     * {id: {key, ms, fromRoot, untimed, widget, reads}}, or null when the
     * notebook is not reactive.  A key is null for
     * a cell with an error, or reading from one.
     */
    async outputKeys() {
      const r = reactive() ? kernel.reactive : null;
      if (!r || !crypto.subtle) return null;
      const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
      const keys = await r.keys({ mode, seed: (id) => `${meta.seed ?? ""}:${id}`, hash: async (t) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t))) });
      // (built from entries: an id is any string, "__proto__" too, SEC-781-1)
      return Object.fromEntries(cells().filter((c) => c.type === "code").map((c) => {
        const { ms, untimed } = r.fromRoot(c.id);
        // (files read by it or by anything it depends on: its key doesn't say their bytes, SEC-B88-2)
        let reads = 0;
        for (const a of r.graph.closure([c.id], { children: false })) reads += r.files.get(a)?.reads?.length ?? 0;
        return [c.id, { key: keys.get(c.id) ?? null, ms: r.times.get(c.id) ?? null, fromRoot: ms, untimed, widget: r.widgetDriven.has(c.id), reads }];
      }));
    },
    /** Run cells (ids) and delete others as one action, then what depends on them (the reactive notebook; resolves to its report). */
    // (programmatic: never with a person's consent)
    runCells(ids, { consent: _consent, ...o } = {}) { return reactive() ? engine().run(ids, o) : Promise.all(ids.map((id) => cellById(id)).filter(Boolean).map((c) => run(c))); },
    applyEdits, graph, verify, fixRedefinitions,
    setMode, setType, setInput, renderMd, select, edit,
    /** X1: load the language's environment now, for the user's choice of it (index.html's menu). */
    warm,
    /** Measure every editor again now (after the notebook was hidden). */
    resize() { cellsEl.querySelectorAll(".ed textarea").forEach(autosize); },
    load, snapshot, applyRemote, replace, flush, saved,
    setMeta(patch) { meta = { ...meta, ...patch }; gateCfg = null; schedule(); },
    /** Count this document's pictures in `budget` (a board's: shared by its
     * pictures, notes and code, afresh for each document shown, image-size.ts). */
    usePictures(budget) { pixels = budget; },
    /** Count the pictures the code cells show in the budget now (another document shown, keeping them): past it, placeholders; placeholders that fit, shown. */
    recountPictures,
    /** The next run's prompt number less one (after TimeTravel replayed runs). */
    setExecCount(k) { if (kernel) kernel.execCount = k; else execCount = k; },
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
      // (2c-3: another device's changes reached this notebook's history: merged with the record by the store, then with
      // what this page shows, its unsaved edits merged cell by cell (applyRemote), and saved.  Every edit is kept, as in
      // CoCalc's Jupyter (plan-exact-only r1): nothing to say)
      if (s.journaled) s.onremote = async () => {
        if (store !== s) return;
        const rec = await s.loadRecord();
        if (!rec || store !== s) return;
        const { j: _j, hash: _h, rev: _r, unjournaled: _u, ...mine } = rec;
        const { doc: merged } = await s.mergeRemote(mine);
        if (store !== s) return;
        // (the merge is not yet the record: shown against the record's own revision, the base its save then needs (a
        // change typed meanwhile kept by applyRemote, cell by cell), and saved: after applyRemote's loading phase,
        // marked unsaved, so even a clean remote change is saved (astra's CORR-2C3-5))
        // (fromConflict: past the check that drops a document no newer than the one shown: the record's revision is it)
        applyRemote({ ...merged, rev: rec.rev }, true, true);
        Promise.resolve().then(() => { if (store !== s) return; lastJson = null; schedule(); });
      };
      return doc;
    },
    /** A save of a document no longer shown here met a change made
     * elsewhere: `f(doc, theirs, key)` keeps `doc` (what that save had)
     * somewhere of its own, never over theirs; `key` is the same for every
     * such save of one showing of a document, so a later one can go where
     * the first went.  saved() waits for it, and tries again what it failed
     * to keep (rejecting while any isn't kept).  Returns the one it replaces. */
    /** Before another document is shown: resolves if this one may be left;
     * else (MAX_LEFT documents left with saves not yet made or kept) tries
     * those again and rejects, saying why, if they still aren't (LIMIT-900-2). */
    async mayLeave() {
      if (leftCount() < MAX_LEFT) return;
      await saved().catch(() => {});
      const n = leftCount();
      if (n >= MAX_LEFT) throw Object.assign(new Error(`changes to ${n} notebooks you left aren't saved or kept yet${unkept.size ? ` (${[...unkept.values()].at(-1).error?.message ?? "not kept"})` : ""}: another opens once they are`), { leaving: true });
    },
    /** Documents left here with saves not yet made, or not kept (LIMIT-900-2). */
    get leftOutstanding() { return leftCount(); },
    /** Saves of documents no longer shown that met a change made elsewhere and couldn't be kept: only in this page. */
    get unkeptCount() { return unkept.size; },
    onDetachedConflict(f) { const was = detachedConflict; detachedConflict = f; return was; },
    detach() { if (timer) flush(); unsubscribe?.(); unsubscribe = null; if (store?.journaled) store.onremote = null; store = null; shown = { synced: null, remoteSeen: 0 }; leftChanged(); },
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
