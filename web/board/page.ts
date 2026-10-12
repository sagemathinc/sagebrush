// The board page (web/board/index.html).  /board/?doc=URL shows a board
// document (web/board/doc.ts); /board/ alone, Sagebrush's own architecture
// (examples/sagebrush.json); ?items=N&strokes=N, a synthetic board for the
// benchmark (bench.mjs, window.boardBench).  A document's tour steps through
// its items with ← and →, and #N in the address is step N.
//
// window.sagebrush.board is the API for an agent driving the page (in the
// shared browser, say): load(doc), focus(ids), step(n), snapshot().
import { Board, synthetic, type Camera } from "./board";
import { layout, type BoardDoc, type DocNote } from "./doc";
import { render as markdown } from "../markdown";

const q = new URLSearchParams(location.search);
const board = new Board(document.getElementById("board")!);
const $ = (id: string) => document.getElementById(id)!;
let doc: BoardDoc | null = null;
let at = -1; // the tour's step; -1 before it starts
let placed: { id: string; kind: string; x: number; y: number; w: number; h: number }[] = [];

let mathModule: Promise<{ typeset: (el: Element) => void }> | null = null;
const hasMath = (s: string) => /\$|\\\(|\\\[/.test(s);

async function load(d: BoardDoc) {
  if (!d || !Array.isArray(d.nodes)) throw new Error("board: a document needs nodes");
  doc = d;
  board.markdown = (s) => markdown(s);
  if (hasMath(JSON.stringify(d))) {
    // KaTeX, the notebook's (its stylesheet and fonts beside it)
    mathModule ??= import(new URL("../sagebrush-math.js", import.meta.url).href);
    const m = await mathModule;
    board.typeset = (el) => m.typeset(el);
  }
  const measure = (n: DocNote, w: number) => board.measure({ kind: "note", ...n }, w);
  const { items, edges } = layout(d, measure);
  board.setItems(items, edges);
  placed = items.map(({ id, kind, x, y, w, h }) => ({ id, kind, x, y, w, h }));
  document.title = (d.title ? d.title + " — " : "") + "Board — Sagebrush";
  $("title").textContent = d.title ?? "";
  const n = d.steps?.length ?? 0;
  $("tour").hidden = !n && !d.intro;
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
  if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
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
  const url = new URL(q.get("doc") ?? "examples/sagebrush.json", location.href);
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url.pathname}: ${r.status} ${r.statusText}`);
    return r.json();
  }).then(load).catch(fail);
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
    /** The document, the tour's step, the camera, and the laid out items' boxes. */
    snapshot: () => ({ doc, step: at, camera: board.camera, view: board.view(), items: placed }),
  },
};
