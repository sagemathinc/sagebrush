// The board page (web/board/index.html).  /board/?doc=URL shows a board
// document (web/board/doc.ts); /board/ alone, Sagebrush's own architecture
// (examples/sagebrush.json); ?items=N&strokes=N, a synthetic board for the
// benchmark (bench.mjs, window.boardBench).  A document's tour steps through
// its items with ← and →, and #N in the address is step N.  A document with
// pages shows one at a time (PageUp, PageDown; #p2 is page 2, #p2-3 its
// step 3).  Print (or Save as PDF) puts every page on a sheet, or every step
// of the tour on one with its caption (print.ts).
//
// Edit (web/board/edit.ts) changes the document; the changed document is
// kept in this browser (localStorage, per source), until Revert.  The menu
// downloads it as JSON, opens a JSON file (or drop one on the page), or
// starts a new board.
//
// A Mermaid flowchart opens as a board too (mermaid.ts): ?doc= a .mmd file,
// or Markdown with ```mermaid blocks (a page each), ?mermaid=TEXT, the Open
// menu and a dropped file, or Import Mermaid… (pasted).
//
// Code items (notes with code) are Python, run on one interpreter for the
// board as a notebook's cells are, in reading order (code.ts, loaded the
// first time a board has some); their output shows under their code, or
// alone (hideCode; { } on the item shows the code: in Edit, for the board,
// otherwise only for this reader).
//
// window.sagebrush.board is the API for an agent driving the page (in the
// shared browser, say): load(doc), focus(ids), step(n), snapshot(), run(),
// outputs().
import { Board, synthetic, type Camera } from "./board";
import { layout, isBoard, pageCount, pageOf, pageView, codeOrder, cleanDoc, type BoardDoc, type BoardPage, type MeasuredNote } from "./doc";
import { BoardCode } from "./code";
import { Toolbar, defaultTools } from "./toolbar";
import { effect } from "@preact/signals-core";
import { Editor, tidy } from "./edit";
import { printSheets, type Sheet, type PrintOptions } from "./print";
import { boardFromText, fromMermaid } from "./mermaid";
import { embedded, exportHtml } from "./export";
import { render as markdown } from "../markdown";
import { Images, IMAGE_TYPES } from "./images";

const q = new URLSearchParams(location.search);
const board = new Board(document.getElementById("board")!);
// pictures: kept in this browser by name; a board that carries them (data: URLs) gives them up on the way in
const images = new Images();
board.imageUrl = (name) => images.url(name);
const $ = (id: string) => document.getElementById(id)!;
let doc: BoardDoc | null = null;
let at = -1; // the tour's step; -1 before it starts
let pageIx = 0, shownPage = -1; // the page shown
let placed: { id: string; kind: string; x: number; y: number; w: number; h: number }[] = [];
let routingGen = 0, routed = false;

let mathModule: Promise<{ typeset: (el: Element) => void }> | null = null;
const hasMath = (s: string) => /\$|\\\(|\\\[/.test(s);

// (a note's height at a width, measured once)
const heights = new Map<string, number>();
// (?mermaid=TEXT: a flowchart given in the address; an exported file, its own)
const source = embedded() ? "embedded:" + location.pathname : q.get("doc") ?? (q.has("mermaid") ? "mermaid:" + q.get("mermaid") : "examples/sagebrush.json");
const saveKey = "sagebrush-board:" + source;
let original: BoardDoc | null = null;

/** Lay out and draw a document, the camera where it is. */
async function show(d: BoardDoc) {
  if (!isBoard(d)) throw new Error("board: a document needs nodes (or pages of them)");
  // (only data: whatever it came from, REACT-XSS)
  d = cleanDoc(d);
  await images.absorb(d);
  await images.ensure(Object.keys(d.images ?? {}));
  doc = d;
  pageIx = Math.max(0, Math.min(pageCount(d) - 1, pageIx));
  const v = flipped.size ? flip(pageView(d, pageIx)) : pageView(d, pageIx);
  board.markdown = (s) => markdown(s);
  if (hasMath(JSON.stringify(d))) {
    // KaTeX, the notebook's (its stylesheet and fonts beside it)
    // (an exported file carries the module as text: imported from a Blob)
    const own = document.getElementById("sb-math")?.textContent;
    mathModule ??= import(own ? URL.createObjectURL(new Blob([own], { type: "text/javascript" })) : new URL("../sagebrush-math.js", import.meta.url).href);
    const m = await mathModule;
    board.typeset = (el) => m.typeset(el);
  }
  // (edges' routes are found between frames: large boards show at once,
  // their edges straight until routed)
  const { items, edges, routing } = layout(v, measure, { deferRoutes: true });
  // (laid out again after an edit: an edge whose ends did not move keeps its
  // route until the new ones are ready, so only the moved items' edges are
  // straight meanwhile; the new routes replace them all at once)
  const before = new Map((shownPage === pageIx ? board.edgeList() : []).map((e) => [`${e.from}\0${e.to}\0${e.label ?? ""}`, e]));
  const now = new Map(items.map((it) => [it.id, it]));
  const still = (id: string) => {
    const a = board.item(id), b = now.get(id);
    return !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  };
  for (const e of edges) {
    const old = before.get(`${e.from}\0${e.to}\0${e.label ?? ""}`);
    if (old?.points && still(e.from) && still(e.to)) { e.points = old.points; e.lx = old.lx; e.ly = old.ly; }
  }
  // code items: their places in the reading order; the engine runs what changed
  const order = codeOrder(d);
  const nth = new Map(order.map((c, i) => [c.id, i + 1]));
  for (const it of items) if (it.code !== undefined) it.order = nth.get(it.id);
  if (order.length || code) engine()?.sync(order, d.mode ?? "python").catch((e) => console.warn("board: code items:", e));
  for (const b of document.querySelectorAll<HTMLButtonElement>("#lang button")) b.setAttribute("aria-pressed", String(b.dataset.mode === (d.mode ?? "python")));
  board.setItems(items, edges);
  toolbar.tools.value = d.tools ?? defaultTools();
  shownPage = pageIx;
  const gen = ++routingGen;
  routed = false;
  // (routed now if that is quick, 40 ms; the rest between frames)
  const work = (budget: number) => {
    if (gen !== routingGen) return;
    const t0 = performance.now();
    while (performance.now() - t0 < budget) {
      if (routing.next().done) { routed = true; board.request(); return; }
    }
    setTimeout(() => work(12), 0);
  };
  work(40);
  placed = items.map(({ id, kind, x, y, w, h }) => ({ id, kind, x, y, w, h }));
  document.title = (d.title ? d.title + " — " : "") + "Board — Sagebrush";
  $("title").textContent = d.title ?? "";
  $("tour").hidden = !v.steps?.length && !v.intro;
  pageBar();
  // (a board's pictures aside: carried, or kept here, they are the same)
  const same = (a: BoardDoc, b: BoardDoc) => JSON.stringify({ ...a, images: undefined }) === JSON.stringify({ ...b, images: undefined });
  $("revert").hidden = !original || same(original, d);
}

// A reader's { } outside Edit: the code items whose code shows (or hides)
// otherwise than the board says, for this reader only.
const flipped = new Set<string>();
function flip(v: BoardDoc): BoardDoc {
  const node = (n: any): any => (n.kind === "group" ? { ...n, children: n.children.map(node) } : flipped.has(n.id) && n.code !== undefined ? { ...n, hideCode: !n.hideCode } : n);
  return { ...v, nodes: (v.nodes ?? []).map(node) };
}
board.onToggleCode = (id) => {
  if (editor.on) { flipped.delete(id); editor.toggleCode(id); return; }
  if (!flipped.delete(id)) flipped.add(id);
  if (doc) show(doc).catch(fail);
};

function measure(n: MeasuredNote, w: number) {
  // (a code item's height changes with its output: measured each time)
  if (n.code !== undefined) return board.measure({ ...n, kind: "note", order: 1, image: n.img }, w);
  const k = JSON.stringify([n.title, n.text, n.detail, n.ref, n.shape, n.img?.w, n.img?.h, w]);
  let h = heights.get(k);
  if (h === undefined) heights.set(k, (h = board.measure({ ...n, kind: "note", image: n.img }, w)));
  return h;
}
// (and a `fit` note's width)
measure.width = (n: MeasuredNote, max: number) => {
  const k = JSON.stringify(["w", n.title, n.text, n.detail, n.ref, n.shape, n.img?.w, n.img?.h, max]);
  let w = heights.get(k);
  if (w === undefined) heights.set(k, (w = board.measureWidth({ ...n, kind: "note", image: n.img }, max)));
  return w;
};

// The engine of code items (none in an exported file: the code shows, as text)
let code: BoardCode | null = null;
function engine(): BoardCode | null {
  if (code || embedded()) return code;
  const c = (code = new BoardCode(new URL("../", import.meta.url)));
  c.onChange = () => { board.codeStates(); relayout(); };
  c.ready.then((ok) => {
    if (!ok) return;
    board.setCode({ highlight: (s) => c.highlight!(s), output: (id, copy) => c.output(id, copy), state: (id) => c.state(id), run: (id) => { c.run([id]); } });
    relayout();
  });
  return c;
}
// (laid out again as outputs change: once a frame at most)
let relayoutFrame = 0;
function relayout() {
  if (!relayoutFrame) relayoutFrame = requestAnimationFrame(() => { relayoutFrame = 0; if (doc) show(doc).catch(fail); });
}

/** Show a document from the start: the whole board, or the page and step in the address (#N, #pP, #pP-N). */
async function load(d: BoardDoc) {
  const m = /^#(?:p(\d+)(?:-(\d+))?|(\d+))$/.exec(location.hash);
  pageIx = m?.[1] ? Number(m[1]) - 1 : 0;
  await show(d);
  at = -1;
  const n = Number(m?.[2] ?? m?.[3] ?? 0);
  step(n && pageView(d, pageIx).steps?.length ? n - 1 : -1, true);
}

/** Show page i (0-based), from its start. */
async function page(i: number) {
  if (!doc) return;
  // (first: what is being written is kept on its own page)
  editor.clear();
  pageIx = Math.max(0, Math.min(pageCount(doc) - 1, i));
  await show(doc);
  step(-1, true);
}

// the page picker: shown when there are pages
function pageBar() {
  const d = doc!, n = pageCount(d), sel = $("pgsel") as HTMLSelectElement;
  $("pages").hidden = n < 2;
  sel.replaceChildren(...Array.from({ length: n }, (_, i) => new Option(`${i + 1}. ${pageOf(d, i).title || "Page " + (i + 1)}`, String(i))));
  sel.value = String(pageIx);
  ($("pgprev") as HTMLButtonElement).disabled = pageIx <= 0;
  ($("pgnext") as HTMLButtonElement).disabled = pageIx >= n - 1;
  $("rmpage").hidden = $("namepage").hidden = n < 2;
}

/** The steps of the page shown. */
const steps = () => (doc ? pageView(doc, pageIx).steps ?? [] : []);
const hashFor = (i: number) => (pageIx ? `#p${pageIx + 1}${i >= 0 ? "-" + (i + 1) : ""}` : i >= 0 ? `#${i + 1}` : "");

function caption(md: string, where: string) {
  const el = $("say");
  el.innerHTML = markdown(md);
  if (board.typeset && hasMath(md)) board.typeset(el);
  $("where").textContent = where;
  // the camera keeps clear of the title bar and the caption
  board.insets = { top: 44, right: 0, left: 0, bottom: $("tour").hidden ? 0 : $("tour").offsetHeight + 18 };
}

/** Go to step `i` of the tour (-1: the whole board, and the intro). */
function step(i: number, now = false) {
  const ss = steps();
  at = Math.max(-1, Math.min(ss.length - 1, i));
  if (at < 0) {
    caption((doc && pageView(doc, pageIx).intro) ?? "", ss.length ? `${ss.length} steps` : "");
    board.focus(undefined, now);
  } else {
    const s = ss[at];
    caption(s.say ?? "", `${at + 1} / ${ss.length}`);
    board.focus(typeof s.focus === "string" ? [s.focus] : s.focus, now);
  }
  history.replaceState(null, "", location.pathname + location.search + hashFor(at));
  ($("prev") as HTMLButtonElement).disabled = at < 0;
  ($("next") as HTMLButtonElement).disabled = at >= ss.length - 1;
}

$("prev").onclick = () => step(at - 1);
$("next").onclick = () => step(at + 1);
$("fit").onclick = () => board.focus();
addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
  // (items selected in Edit: the arrow keys move them; in Edit, Space held pans)
  if (editor.hasSelection && e.key.startsWith("Arrow")) return;
  if (editor.on && e.key === " ") return;
  if (e.key === "ArrowRight" || e.key === " ") step(at + 1);
  else if (e.key === "ArrowLeft") step(at - 1);
  else if (e.key === "Escape" || e.key === "0") step(-1);
  else if (e.key === "PageDown") page(pageIx + 1);
  else if (e.key === "PageUp") page(pageIx - 1);
  else if (e.key === "+" || e.key === "=") board.zoomAt(1.25, innerWidth / 2, innerHeight / 2);
  else if (e.key === "-") board.zoomAt(0.8, innerWidth / 2, innerHeight / 2);
  else return;
  e.preventDefault();
});

function fail(e: unknown) {
  $("tour").hidden = false;
  caption("**This board could not be shown:** " + String((e as Error)?.message ?? e).replace(/[<>&]/g, ""), "");
}

if (q.has("items") || q.has("strokes")) {
  $("tour").hidden = true;
  board.setItems(synthetic(Number(q.get("items") ?? 2000), Number(q.get("strokes") ?? 20000)));
  board.setCamera({ x: 0, y: 0, z: 1 });
} else {
  const url = new URL(source.startsWith("mermaid:") || source.startsWith("embedded:") ? "data:," : source, location.href);
  // (JSON, or a Mermaid flowchart, or Markdown with some)
  (source.startsWith("embedded:") ? Promise.resolve(JSON.parse(embedded()!.textContent!) as BoardDoc) : source.startsWith("mermaid:") ? Promise.resolve(fromMermaid(source.slice(8))) : fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url.pathname}: ${r.status} ${r.statusText}`);
    return r.text();
  }).then((t) => boardFromText(t, decodeURIComponent(url.pathname.split("/").pop() ?? "")))).then((d: BoardDoc) => {
    original = d;
    // (this browser's edits of it, if any)
    let saved: BoardDoc | null = null;
    try { saved = JSON.parse(localStorage.getItem(saveKey) ?? "null"); } catch {}
    return load(isBoard(saved) ? saved! : d);
  }).catch(fail);
}

// editing, and keeping what was edited
const editor = new Editor(board, () => doc, async (d) => {
  await show(d);
  // (the document as shown: its pictures' bytes are kept apart, images.ts)
  try { localStorage.setItem(saveKey, JSON.stringify(doc)); } catch {}
}, (d) => pageOf(d, pageIx));
editor.onRun = (id) => { code?.run([id]); };
editor.highlight = () => code?.highlight ?? null;
editor.images = images;
const editBtn = $("edit");
editBtn.onclick = () => editor.setOn(!editor.on);
effect(() => {
  editBtn.setAttribute("aria-pressed", String(editor.editing.value));
  $("hint").hidden = !editor.editing.value;
});
// the toolbar, in Edit mode: adds at the middle of the view
const center = () => { const v = board.view(); return { x: (v.x0 + v.x1) / 2, y: (v.y0 + v.y1) / 2 }; };
const toolbar = new Toolbar(document.body, [
  { id: "select", label: "Select", icon: "↖", title: "Select: drag on the background to select what the rectangle holds (Space-drag pans); Esc to stop", toggle: editor.selecting },
  { id: "note", label: "Note", icon: "¶", title: "Add a note (Markdown, with math)", run: () => { const c = center(); editor.addNote(c.x, c.y); } },
  { id: "code", label: "Code", icon: "{ }", title: "Add a note with Python code (any note can have code: + Code in its editor)", run: () => { const c = center(); editor.addCode(c.x, c.y); } },
  { id: "image", label: "Image", icon: "▨", title: "Add pictures (or paste one, or drop files on the board)", run: () => pickImages() },
  { id: "group", label: "Group", icon: "▣", title: "Add a group (drag notes into it)", run: () => { const c = center(); editor.addGroup(c.x, c.y); } },
  { id: "connect", label: "Connect", icon: "⤳", title: "Connect notes: tap one, then another (or shift-drag from one to the other); Esc to stop", toggle: editor.connecting },
  { id: "page", label: "Page", icon: "⧉", title: "Add a page after this one", run: () => $("addpage").click() },
  { id: "undo", label: "↶", icon: "↶", title: "Undo (Ctrl+Z)", run: () => editor.undo() },
  { id: "redo", label: "↷", icon: "↷", title: "Redo (Ctrl+Shift+Z)", run: () => editor.redo() },
// (which tools a board shows is a setting, not an edit to undo)
], editor.editing, (ids) => editor.commit((d) => { d.tools = ids; }, false, false));
// pictures chosen from files (or the camera, on a phone), added in the middle of the view
function pickImages() {
  const input = Object.assign(document.createElement("input"), { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", multiple: true });
  // (in the DOM, out of sight: some browsers do not open the chooser for a detached input)
  input.className = "sb-fileinput";
  input.style.cssText = "position:fixed;left:-9999px";
  input.onchange = () => { input.remove(); const c = center(); if (input.files?.length) editor.addImages(input.files, c.x, c.y).catch(fail); };
  // (one at most: a chooser cancelled earlier left its input behind)
  for (const old of document.querySelectorAll("input.sb-fileinput")) old.remove();
  document.body.append(input);
  input.click();
}
const menu = $("menu");
$("menubtn").onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
addEventListener("click", () => { menu.hidden = true; });
const fileName = () => ((doc?.title ?? "board").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "board") + ".json";
$("examples").onclick = async () => {
  const list = $("exlist");
  try {
    const ex = (await (await fetch(new URL("examples/index.json", location.href))).json()) as { file: string; title: string; about: string }[];
    list.replaceChildren(...ex.map((e) => {
      const a = document.createElement("a");
      a.href = `?doc=${encodeURIComponent("examples/" + e.file)}`;
      if (source === "examples/" + e.file) a.className = "current";
      a.append(Object.assign(document.createElement("b"), { textContent: e.title }), Object.assign(document.createElement("span"), { textContent: e.about }));
      return a;
    }));
  } catch (e) {
    list.textContent = "The examples could not be loaded: " + String(e);
  }
  ($("exdlg") as HTMLDialogElement).showModal();
};
$("tidy").onclick = () => editor.commit((d) => { const p = pageOf(d, pageIx); Object.assign(p, tidy(p)); });
// the language of the board's code (one per board): Python or Sage
for (const b of document.querySelectorAll<HTMLButtonElement>("#lang button")) {
  b.onclick = () => editor.commit((d) => { if (b.dataset.mode === "sage") d.mode = "sage"; else delete d.mode; });
}
$("pgprev").onclick = () => page(pageIx - 1);
$("pgnext").onclick = () => page(pageIx + 1);
($("pgsel") as HTMLSelectElement).onchange = (e) => { page(Number((e.target as HTMLSelectElement).value)); (e.target as HTMLElement).blur(); };
// a document's own nodes, edges and tour become its first page
const PAGE_KEYS = ["intro", "layout", "columns", "direction", "nodes", "edges", "steps"] as const;
function paged(d: BoardDoc): BoardPage[] {
  if (!d.pages?.length) {
    const p: any = { title: "Page 1" };
    for (const k of PAGE_KEYS) if (d[k] !== undefined) { p[k] = d[k]; delete d[k]; }
    p.nodes ??= [];
    d.pages = [p];
  }
  return d.pages!;
}
$("addpage").onclick = async () => {
  let n = 0;
  await editor.commit((d) => { const ps = paged(d); ps.splice(pageIx + 1, 0, { title: `Page ${ps.length + 1}`, nodes: [] }); n = pageIx + 1; });
  await page(n);
  if (!editor.on) editBtn.click();
};
$("namepage").onclick = () => {
  const name = prompt("This page's title", pageOf(doc!, pageIx).title ?? "");
  if (name !== null) editor.commit((d) => { pageOf(d, pageIx).title = name.trim() || undefined; });
};
$("rmpage").onclick = async () => {
  const p = pageOf(doc!, pageIx);
  if (pageCount(doc!) < 2 || (p.nodes?.length && !confirm(`Delete the page “${p.title || "Page " + (pageIx + 1)}” and everything on it? (Undo brings it back.)`))) return;
  await editor.commit((d) => {
    d.pages!.splice(pageIx, 1);
    // (one page left: the document's own again)
    if (d.pages!.length === 1) { const [q] = d.pages!; delete d.pages; for (const k of PAGE_KEYS) if (q[k] !== undefined) (d as any)[k] = q[k]; }
  });
  await page(Math.min(pageIx, pageCount(doc!) - 1));
};
$("download").onclick = async () => {
  const a = document.createElement("a");
  // (with its pictures)
  a.href = URL.createObjectURL(new Blob([JSON.stringify(await images.inline(doc!), null, 1)], { type: "application/json" }));
  a.download = fileName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
// Download as HTML: the board in one file (export.ts)
$("html").onclick = async () => {
  if (!doc) return;
  try {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([await exportHtml(await images.inline(doc))], { type: "text/html" }));
    a.download = fileName().replace(/\.json$/, ".html");
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    fail(e);
  }
};
// (an exported file has no examples beside it)
if (embedded()) $("examples").hidden = true;
$("copyjson").onclick = async () => navigator.clipboard?.writeText(JSON.stringify(await images.inline(doc!), null, 1));
async function openText(text: string, name?: string) {
  const d = boardFromText(text, name);
  if (!isBoard(d)) throw new Error("not a board: a document needs nodes (or pages of them)");
  pageIx = 0;
  await editor.commit((cur) => { for (const k of Object.keys(cur)) delete (cur as any)[k]; Object.assign(cur, d); });
  board.focus(undefined, true);
}
const picker = $("openfile") as HTMLInputElement;
$("open").onclick = () => picker.click();
picker.onchange = async () => {
  const f = picker.files?.[0];
  if (f) await openText(await f.text(), f.name).catch(fail);
  picker.value = "";
};
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", async (e) => {
  e.preventDefault();
  // pictures: added where they were dropped (in Edit); another file opens as a board
  const files = [...(e.dataTransfer?.files ?? [])];
  const pics = files.filter((f) => IMAGE_TYPES.test(f.type));
  if (pics.length) {
    if (!editor.on) editor.setOn(true);
    const w = board.toWorld(e.clientX, e.clientY);
    await editor.addImages(pics, w.x, w.y).catch(fail);
    return;
  }
  const f = files[0];
  if (f) await openText(await f.text(), f.name).catch(fail);
});
// Import Mermaid…: a flowchart pasted in
const mmdlg = $("mmdlg") as HTMLDialogElement, mmtext = $("mmtext") as HTMLTextAreaElement;
$("mermaid").onclick = () => { $("mmerr").textContent = ""; mmdlg.showModal(); mmtext.focus(); };
$("mm-go").onclick = async (e) => {
  e.preventDefault();
  try {
    await openText(mmtext.value);
    mmdlg.close();
  } catch (err) {
    $("mmerr").textContent = String((err as Error)?.message ?? err);
  }
};
$("newboard").onclick = () => editor.commit((d) => {
  for (const k of Object.keys(d)) delete (d as any)[k];
  Object.assign(d, { title: "Untitled board", nodes: [] });
  pageIx = 0;
}).then(() => { if (!editor.on) editBtn.click(); });
$("revert").onclick = async () => {
  if (!original) return;
  try { localStorage.removeItem(saveKey); } catch {}
  pageIx = 0;
  await editor.commit((d) => { for (const k of Object.keys(d)) delete (d as any)[k]; Object.assign(d, JSON.parse(JSON.stringify(original))); });
  try { localStorage.removeItem(saveKey); } catch {}
  board.focus(undefined, true);
};
// Print, or save as PDF: the sheets
/** Sheets for printing: each page whole ("pages"), or each step of each
 * page's tour with its caption ("tour"; a page with no tour, whole). */
function sheets(mode: "pages" | "tour" = "pages"): Sheet[] {
  const d = doc!, n = pageCount(d), out: Sheet[] = [];
  for (let i = 0; i < n; i++) {
    const v = pageView(d, i);
    const { items, edges } = layout(v, measure);
    const box = (ids?: string[]) => {
      const its = ids ? items.filter((it) => ids.includes(it.id)) : items;
      if (!its.length) return { x0: 0, y0: 0, x1: 400, y1: 300 };
      return { x0: Math.min(...its.map((it) => it.x)), y0: Math.min(...its.map((it) => it.y)), x1: Math.max(...its.map((it) => it.x + it.w)), y1: Math.max(...its.map((it) => it.y + it.h)) };
    };
    const title = d.pages?.length ? [d.title, pageOf(d, i).title || `Page ${i + 1}`].filter(Boolean).join(" — ") : d.title;
    const where = n > 1 ? `page ${i + 1} of ${n}` : "";
    const ss = mode === "tour" ? v.steps ?? [] : [];
    if (!ss.length || v.intro) out.push({ items, edges, box: box(), title, caption: mode === "tour" ? v.intro : undefined, folio: where });
    ss.forEach((s, k) => out.push({ items, edges, box: box(typeof s.focus === "string" ? [s.focus] : s.focus), title, caption: s.say, folio: [where, `step ${k + 1} of ${ss.length}`].filter(Boolean).join(", ") }));
  }
  return out;
}
async function printBoard(o: PrintOptions & { mode?: "pages" | "tour"; dialog?: boolean } = {}) {
  if (!doc) return null;
  // (math typeset in sheets too)
  return printSheets(board, sheets(o.mode), { ...o, markdown: (s) => markdown(s) });
}
const prdlg = $("prdlg") as HTMLDialogElement;
$("print").onclick = () => {
  const d = doc!, tours = Array.from({ length: pageCount(d) }, (_, i) => pageView(d, i).steps?.length ?? 0).reduce((a, b) => a + b, 0);
  const n = pageCount(d);
  $("pr-pages-n").textContent = n > 1 ? `${n} pages, a sheet each` : "the whole board, on one sheet";
  ($("pr-tour") as HTMLInputElement).disabled = !tours;
  $("pr-tour-n").textContent = tours ? `${tours} steps, a sheet each with its caption (and a page's intro, with the whole page)` : "this board has no tour";
  if (!tours) ($("pr-pages") as HTMLInputElement).checked = true;
  prdlg.showModal();
};
$("pr-go").onclick = async (e) => {
  e.preventDefault();
  const f = new FormData($("prform") as HTMLFormElement);
  prdlg.close();
  await printBoard({ mode: f.get("mode") as "pages" | "tour", paper: f.get("paper") as "letter" | "a4", orientation: f.get("orient") as "landscape" | "portrait" });
};
// (⌘P prints the sheets, not the screen)
addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "p" && doc) { e.preventDefault(); $("print").click(); }
});

function outputs() {
  return doc ? codeOrder(doc).map(({ id, code: src }) => ({ id, code: src, state: code?.state(id) ?? "", output: code?.text(id) ?? "" })) : [];
}

// first paint: the end of the first render after load
requestAnimationFrame(() => requestAnimationFrame(() => { (window as any).firstPaint = performance.now(); }));

// Measure frames while the camera moves along `path` (one camera per frame):
// the intervals between frames and the time render() takes in each.
async function bench(path: Camera[]) {
  const intervals: number[] = [], work: number[] = [];
  let last = performance.now();
  for (const c of path) {
    await new Promise<void>((r) => requestAnimationFrame(() => {
      const t0 = performance.now();
      board.setCamera(c);
      board.render();
      work.push(performance.now() - t0);
      intervals.push(t0 - last);
      last = t0;
      r();
    }));
  }
  const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
  return {
    frames: path.length,
    interval: { p50: pct(intervals, 0.5), p95: pct(intervals, 0.95), max: Math.max(...intervals) },
    work: { p50: pct(work, 0.5), p95: pct(work, 0.95), max: Math.max(...work) },
    mounted: board.stats.mounted, mounts: board.stats.mounts, drawn: board.stats.drawn,
  };
}
(window as any).board = board;
(window as any).boardBench = bench;
(window as any).sagebrush = {
  ...(window as any).sagebrush,
  board: {
    /** Show a board document (see web/board/doc.ts); resolves when it is laid out. */
    load,
    /** Fly to these item ids (all items when none). */
    focus: (ids?: string[]) => board.focus(ids),
    /** Go to step n of the tour (0-based; -1 for the whole board). */
    step,
    /** A Mermaid flowchart (or Markdown with some) as a board document, to load(), or to edit first. */
    fromMermaid: (text: string) => boardFromText(text),
    /** The board as one self-contained HTML file (its text). */
    exportHtml: async () => exportHtml(await images.inline(doc!)),
    /** the document as a file carries it: with its pictures (data: URLs) */
    portable: () => images.inline(doc!),
    /** Show page n (0-based). */
    page,
    /** Lay out the sheets to print (mode "pages" or "tour"; paper "letter" or "a4"; orientation) and open the print dialog, unless dialog: false. */
    print: async (o: PrintOptions & { mode?: "pages" | "tour"; dialog?: boolean } = {}) => { const r = await printBoard(o); return r?.querySelectorAll(".pr-sheet").length ?? 0; },
    /** The document, the tour's step, the camera, and the laid out items' boxes. */
    snapshot: () => ({ doc, page: pageIx, pages: doc ? pageCount(doc) : 0, step: at, camera: board.camera, view: board.view(), items: placed, routed, edges: board.edgeList().map(({ id, from, to, points, label, lx, ly, src }) => ({ id, from, to, points, label, lx, ly, src })), selectedEdge: board.selectedEdge }),
    /** Change the document (undoable, as an edit): f gets a copy to modify. */
    edit: (f: (d: BoardDoc) => void) => editor.commit(f),
    /** Run code items (all when none are given), then what depends on them; resolves to outputs(). */
    run: async (ids?: string[]) => {
      const c = engine();
      if (c) { await c.idle(); await (ids ? c.run(ids) : c.runAll()); }
      return outputs();
    },
    /** Code items in reading order: their state ("" when up to date, or queued, running, stale, error, cancelled) and output as text, after what was asked for has run. */
    outputs: async () => { await code?.idle(); return outputs(); },
    /** Turn Edit mode on or off. */
    editing: (on: boolean) => editor.setOn(on),
  },
};
