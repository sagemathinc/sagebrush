// The board page (web/board/index.html).  /board/?doc=URL shows a board
// document (web/board/doc.ts); /board/ alone, Sagebrush's own architecture
// (examples/sagebrush.json); ?items=N&strokes=N, a synthetic board for the
// benchmark (bench.mjs, window.boardBench).  A document's tour steps through
// its items with ← and →, and #N in the address is step N.
//
// Edit (web/board/edit.ts) changes the document; the changed document is
// kept in this browser (localStorage, per source), until Revert.  The menu
// downloads it as JSON, opens a JSON file (or drop one on the page), or
// starts a new board.
//
// window.sagebrush.board is the API for an agent driving the page (in the
// shared browser, say): load(doc), focus(ids), step(n), snapshot().
import { Board, synthetic, type Camera } from "./board";
import { layout, type BoardDoc, type DocNote } from "./doc";
import { Editor, tidy } from "./edit";
import { render as markdown } from "../markdown";

const q = new URLSearchParams(location.search);
const board = new Board(document.getElementById("board")!);
const $ = (id: string) => document.getElementById(id)!;
let doc: BoardDoc | null = null;
let at = -1; // the tour's step; -1 before it starts
let placed: { id: string; kind: string; x: number; y: number; w: number; h: number }[] = [];
let routingGen = 0, routed = false;

let mathModule: Promise<{ typeset: (el: Element) => void }> | null = null;
const hasMath = (s: string) => /\$|\\\(|\\\[/.test(s);

// (a note's height at a width, measured once)
const heights = new Map<string, number>();
const source = q.get("doc") ?? "examples/sagebrush.json";
const saveKey = "sagebrush-board:" + source;
let original: BoardDoc | null = null;

/** Lay out and draw a document, the camera where it is. */
async function show(d: BoardDoc) {
  if (!d || !Array.isArray(d.nodes)) throw new Error("board: a document needs nodes");
  doc = d;
  board.markdown = (s) => markdown(s);
  if (hasMath(JSON.stringify(d))) {
    // KaTeX, the notebook's (its stylesheet and fonts beside it)
    mathModule ??= import(new URL("../sagebrush-math.js", import.meta.url).href);
    const m = await mathModule;
    board.typeset = (el) => m.typeset(el);
  }
  const measure = (n: DocNote, w: number) => {
    const k = JSON.stringify([n.title, n.text, n.detail, n.ref, w]);
    let h = heights.get(k);
    if (h === undefined) heights.set(k, (h = board.measure({ kind: "note", ...n }, w)));
    return h;
  };
  // (edges' routes are found between frames: large boards show at once,
  // their edges straight until routed)
  const { items, edges, routing } = layout(d, measure, { deferRoutes: true });
  board.setItems(items, edges);
  const gen = ++routingGen;
  routed = false;
  const work = () => {
    if (gen !== routingGen) return;
    const t0 = performance.now();
    while (performance.now() - t0 < 12) {
      if (routing.next().done) { routed = true; board.request(); return; }
    }
    setTimeout(work, 0);
  };
  work();
  placed = items.map(({ id, kind, x, y, w, h }) => ({ id, kind, x, y, w, h }));
  document.title = (d.title ? d.title + " — " : "") + "Board — Sagebrush";
  $("title").textContent = d.title ?? "";
  $("tour").hidden = !d.steps?.length && !d.intro;
  $("revert").hidden = !original || JSON.stringify(original) === JSON.stringify(d);
}

/** Show a document from the start: the whole board, or step #N. */
async function load(d: BoardDoc) {
  await show(d);
  const n = d.steps?.length ?? 0;
  at = -1;
  const m = /^#(\d+)$/.exec(location.hash);
  if (m && n) step(Number(m[1]) - 1, true);
  else step(-1, true);
}

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
  const steps = doc?.steps ?? [];
  at = Math.max(-1, Math.min(steps.length - 1, i));
  if (at < 0) {
    caption(doc?.intro ?? "", steps.length ? `${steps.length} steps` : "");
    board.focus(undefined, now);
    history.replaceState(null, "", location.pathname + location.search);
  } else {
    const s = steps[at];
    caption(s.say ?? "", `${at + 1} / ${steps.length}`);
    board.focus(typeof s.focus === "string" ? [s.focus] : s.focus, now);
    history.replaceState(null, "", `#${at + 1}`);
  }
  ($("prev") as HTMLButtonElement).disabled = at < 0;
  ($("next") as HTMLButtonElement).disabled = at >= steps.length - 1;
}

$("prev").onclick = () => step(at - 1);
$("next").onclick = () => step(at + 1);
$("fit").onclick = () => board.focus();
addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "ArrowRight" || e.key === " ") step(at + 1);
  else if (e.key === "ArrowLeft") step(at - 1);
  else if (e.key === "Escape" || e.key === "0") step(-1);
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
  const url = new URL(source, location.href);
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url.pathname}: ${r.status} ${r.statusText}`);
    return r.json();
  }).then((d: BoardDoc) => {
    original = d;
    // (this browser's edits of it, if any)
    let saved: BoardDoc | null = null;
    try { saved = JSON.parse(localStorage.getItem(saveKey) ?? "null"); } catch {}
    return load(saved && Array.isArray(saved.nodes) ? saved : d);
  }).catch(fail);
}

// editing, and keeping what was edited
const editor = new Editor(board, () => doc, async (d) => {
  await show(d);
  try { localStorage.setItem(saveKey, JSON.stringify(d)); } catch {}
});
const editBtn = $("edit");
editBtn.onclick = () => {
  editor.setOn(!editor.on);
  editBtn.setAttribute("aria-pressed", String(editor.on));
  $("hint").hidden = !editor.on;
};
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
$("tidy").onclick = () => editor.commit((d) => Object.assign(d, tidy(d)));
$("download").onclick = () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 1)], { type: "application/json" }));
  a.download = fileName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("copyjson").onclick = () => navigator.clipboard?.writeText(JSON.stringify(doc, null, 1));
async function openText(text: string) {
  const d = JSON.parse(text) as BoardDoc;
  if (!Array.isArray(d?.nodes)) throw new Error("not a board: a document needs nodes");
  await editor.commit((cur) => { for (const k of Object.keys(cur)) delete (cur as any)[k]; Object.assign(cur, d); });
  board.focus(undefined, true);
}
const picker = $("openfile") as HTMLInputElement;
$("open").onclick = () => picker.click();
picker.onchange = async () => {
  const f = picker.files?.[0];
  if (f) await openText(await f.text()).catch(fail);
  picker.value = "";
};
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) await openText(await f.text()).catch(fail);
});
$("newboard").onclick = () => editor.commit((d) => {
  for (const k of Object.keys(d)) delete (d as any)[k];
  Object.assign(d, { title: "Untitled board", nodes: [] });
}).then(() => { if (!editor.on) editBtn.click(); });
$("revert").onclick = async () => {
  if (!original) return;
  try { localStorage.removeItem(saveKey); } catch {}
  await editor.commit((d) => { for (const k of Object.keys(d)) delete (d as any)[k]; Object.assign(d, JSON.parse(JSON.stringify(original))); });
  try { localStorage.removeItem(saveKey); } catch {}
  board.focus(undefined, true);
};
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
    /** The document, the tour's step, the camera, and the laid out items' boxes. */
    snapshot: () => ({ doc, step: at, camera: board.camera, view: board.view(), items: placed, routed, edges: board.edgeList().map(({ id, from, to, points }) => ({ id, from, to, points })) }),
    /** Change the document (undoable, as an edit): f gets a copy to modify. */
    edit: (f: (d: BoardDoc) => void) => editor.commit(f),
    /** Turn Edit mode on or off. */
    editing: (on: boolean) => { if (editor.on !== on) editBtn.click(); },
  },
};
