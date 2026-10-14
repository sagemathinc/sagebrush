// Boards (design/board.md): the renderer.
//
// One container whose CSS transform is the camera holds the items' DOM;
// only the items near the viewport are mounted (a spatial grid finds them);
// far out, items are drawn on a canvas as colored rectangles with titles
// and no DOM at all; ink is on the canvas too, each stroke a cached Path2D.
// Panning and zooming change the transform (and redraw the canvas) once per
// animation frame; mounting follows only when the view has left the region
// mounted for it.  Groups (boxes holding notes) and edges between items are
// drawn on a canvas behind the notes; notes show Markdown with math, and
// their detail (semantic zoom) only when zoomed in.

import { inkPath } from "./ink";

/** Ink's color, unless a stroke says. */
export const INK = "#1d241a";

export interface Item {
  id: string;
  kind: "note" | "shape" | "ink" | "group";
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string;
  text?: string;
  color?: string;
  /** ink: points relative to (x, y), as x0, y0, x1, y1, ... (a line as wide as `width`) */
  points?: Float32Array;
  width?: number;
  /** ink: its outline relative to (x, y), x0, y0, ...: a shape to fill (ink.ts) */
  outline?: number[];
  /** ink: below 1, a highlighter's */
  opacity?: number;
  /** notes: Markdown shown only when zoomed in */
  detail?: string;
  /** notes: a link, shown at the note's foot */
  ref?: string;
  /** groups and notes: how deeply nested (groups are drawn outer first) */
  depth?: number;
  /** groups: where their members' positions are measured from */
  inner?: { x: number; y: number };
  /** the group holding it */
  parent?: string;
  /** notes: an outline other than a rectangle (doc.ts's NoteShape) */
  shape?: string;
  /** code items (notes with code): the code, and where it is in the board's reading order (1, 2, ...) */
  code?: string;
  order?: number;
  /** code items: only the code's output shows */
  hideCode?: boolean;
  /** notes: a picture (its name, size, and its address when not in this browser) */
  image?: { key: string; w: number; h: number; src?: string };
}

/** What an item's element shows. */
export type Content = Pick<Item, "kind" | "title" | "text" | "detail" | "ref" | "shape"> & Partial<Pick<Item, "id" | "code" | "order" | "hideCode" | "image">>;

/** Code items' engine (code.ts, through page.ts): their output, state and running. */
export interface CodeHost {
  highlight(src: string): string;
  /** the live output element (a copy for measuring and printing) */
  output(id: string, copy: boolean): HTMLElement | null;
  /** "" (up to date), or queued, running, stale, error, failed, cancelled, interrupted (code.ts's CodeState) */
  state(id: string): string;
  run(id: string): void;
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  label?: string;
  /** its route (web/board/route.ts): x0, y0, x1, y1, ...; straight from border to border without one */
  points?: number[];
  /** where its label goes (its center) */
  lx?: number;
  ly?: number;
  /** arrowheads: at the end (the default), none, or both ends; the line's style */
  arrow?: "none" | "both";
  line?: "dotted" | "thick";
  /** its index in the document's (the page's) edges */
  src?: number;
}

export interface Camera {
  x: number; // world coordinates at the viewport's top left
  y: number;
  z: number; // zoom: screen pixels per world unit
}

const CELL = 512; // the spatial grid's cell, in world units
const FAR = 0.5; // below this zoom: rectangles on the canvas, no DOM (text under 7 px is not read)
// ...unless few items are in view: then their text shows down to this zoom
// (6 px: small but still read; few elements cost nothing to show)
const FEW_FAR = 0.35, FEW = 300;
const BUDGET = 4; // ms of building notes' elements per frame; the rest wait, drawn as placeholders
const PER_FRAME = 30; // and at most this many elements added (each costs the browser's layout too)
const MARGIN = 0.5; // mounted: the viewport plus this fraction around it
const CLOSE = 1.1; // from this zoom: notes' details
const GROUP = "#eef2ea", EDGE = "#5f7457";

// A uniform grid: each item is in the cells its box overlaps.
class Grid {
  private cells = new Map<string, Item[]>();
  add(it: Item) {
    for (let i = Math.floor(it.x / CELL); i <= Math.floor((it.x + it.w) / CELL); i++) {
      for (let j = Math.floor(it.y / CELL); j <= Math.floor((it.y + it.h) / CELL); j++) {
        const k = i + "," + j;
        (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(it);
      }
    }
  }
  remove(it: Item) {
    for (let i = Math.floor(it.x / CELL); i <= Math.floor((it.x + it.w) / CELL); i++) {
      for (let j = Math.floor(it.y / CELL); j <= Math.floor((it.y + it.h) / CELL); j++) {
        const c = this.cells.get(i + "," + j);
        if (c) { const k = c.indexOf(it); if (k >= 0) c.splice(k, 1); }
      }
    }
  }
  /** Whether more than `max` items overlap the rectangle (an item in several cells may count more than once: a bound, found quickly). */
  more(x0: number, y0: number, x1: number, y1: number, max: number): boolean {
    let n = 0;
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
      for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++) {
        for (const it of this.cells.get(i + "," + j) ?? []) if (it.x < x1 && it.x + it.w > x0 && it.y < y1 && it.y + it.h > y0 && ++n > max) return true;
      }
    }
    return false;
  }
  query(x0: number, y0: number, x1: number, y1: number, out: Set<Item>): Set<Item> {
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
      for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++) {
        for (const it of this.cells.get(i + "," + j) ?? []) if (it.x < x1 && it.x + it.w > x0 && it.y < y1 && it.y + it.h > y0) out.add(it);
      }
    }
    return out;
  }
}

export class Board {
  readonly el: HTMLElement;
  private world: HTMLElement;
  private canvas: HTMLCanvasElement; // in front of the notes: ink, and everything far out
  private ctx: CanvasRenderingContext2D;
  private back: HTMLCanvasElement; // behind them: groups and edges
  private bctx: CanvasRenderingContext2D;
  private edges: Edge[] = [];
  /** an edge being drawn: from an item to a world point */
  pending: { from: string; x: number; y: number } | null = null;
  /** a rectangle being drawn to select what it holds, and the alignment guides of a drag (world coordinates) */
  marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** the item with a resize handle at its bottom right corner (Edit: the one selected note) */
  handle: string | null = null;
  guides: { xs: number[]; ys: number[] } | null = null;
  /** a press on the background (no item there): return true to take it (the board does not pan) */
  onBackgroundDown: ((e: PointerEvent) => boolean) | null = null;
  private byId = new Map<string, Item>();
  private close = false;
  private flight = 0;
  /** Markdown to HTML for notes (plain text without it), and math typesetting */
  markdown: ((src: string) => string) | null = null;
  typeset: ((el: HTMLElement) => void) | null = null;
  /** code items' output and running (none: their code only): setCode() */
  code: CodeHost | null = null;
  /** a code item's { } (show or hide its code) was clicked */
  onToggleCode: ((id: string) => void) | null = null;
  /** where a picture's bytes are, by its name (images.ts) */
  imageUrl: ((name: string) => string | undefined) | null = null;
  /** a press on an item (not a link): return true to take it (the board does not pan) */
  onItemDown: ((it: Item, e: PointerEvent) => boolean) | null = null;
  /** a double click: on an item, or (null) on the background at world (x, y); return true when handled */
  onDoubleClick: ((it: Item | null, x: number, y: number) => boolean) | null = null;
  /** a press, or a double click, on an edge (not over a note): return true to take it */
  onEdgeDown: ((e: Edge, ev: PointerEvent) => boolean) | null = null;
  onEdgeDoubleClick: ((e: Edge) => boolean) | null = null;
  /** an edge drawn selected, and a group outlined as where a dragged item would go */
  selectedEdge: string | null = null;
  dropTarget: string | null = null;
  private selection = new Set<string>();
  private boxes = new Grid(); // notes and shapes
  private strokes = new Grid(); // ink
  private paths = new Map<string, Path2D>();
  private maxWidth = 0; // the widest stroke's width
  private mounted = new Map<string, HTMLElement>();
  private cache = new Map<string, HTMLElement>(); // rendered once, kept
  /** the item being edited where it is (edit.ts): its element is kept as it is, and mounted wherever the camera goes */
  private editingId: string | null = null;
  private editingEl: HTMLElement | null = null;
  /** after each frame drawn (the camera may have moved): what floats over the board follows */
  onRender: (() => void) | null = null;
  camera: Camera = { x: 0, y: 0, z: 1 };
  /** screen space that focus() keeps clear (a toolbar, a caption) */
  insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private frame = 0;
  private mountedFor: { x0: number; y0: number; x1: number; y1: number; far: boolean } | null = null;
  private unbuilt = false; // the last mount ran out of its budget
  private dpr = Math.max(1, globalThis.devicePixelRatio || 1);
  /** counters, for the benchmark */
  stats = { frames: 0, mounts: 0, mounted: 0, drawn: 0 };

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "board";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "board-canvas";
    this.back = document.createElement("canvas");
    this.back.className = "board-canvas board-back";
    this.world = document.createElement("div");
    this.world.className = "board-world";
    this.el.append(this.back, this.world, this.canvas);
    parent.append(this.el);
    this.ctx = this.canvas.getContext("2d")!;
    this.bctx = this.back.getContext("2d")!;
    this.sizes.observe(this.el);
    this.resize();
    this.input();
  }

  private sizes = new ResizeObserver(() => this.resize());
  /** Take the board away: its element, and nothing left waiting (frames, the observer). */
  destroy() {
    this.sizes.disconnect();
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.flight);
    cancelAnimationFrame(this.mathFrame);
    this.frame = this.flight = this.mathFrame = 0;
    this.math = [];
    this.el.remove();
  }

  setItems(items: Item[], edges: Edge[] = []) {
    this.edges = edges;
    this.byId = new Map(items.map((it) => [it.id, it]));
    this.boxes = new Grid();
    this.strokes = new Grid();
    this.paths.clear();
    // (an element whose item shows the same is kept, and stays mounted, only
    // placed again: laid out again after an edit, or as a code item's output
    // grows, the board neither builds every note again nor blinks)
    const old = this.cache;
    this.cache = new Map();
    for (const it of items) {
      const el = old.get(it.id);
      if (el && it.id === this.editingId) {
        // (being edited: kept whatever it now shows, as tall as its fields)
        el.style.cssText = placement(it) + `height:auto;min-height:${+it.h}px;`;
        this.cache.set(it.id, el);
      } else if (el && el.dataset.key === contentKey(it)) {
        el.style.cssText = placement(it);
        this.cache.set(it.id, el);
      }
    }
    for (const [id, m] of this.mounted) if (this.cache.get(id) !== m) { m.remove(); this.mounted.delete(id); }
    this.mountedFor = null;
    this.maxWidth = 0;
    for (const it of items) {
      (it.kind === "ink" ? this.strokes : this.boxes).add(it);
      if (it.kind === "ink") this.maxWidth = Math.max(this.maxWidth, it.width ?? 2);
    }
    this.request();
  }

  /** Zoom by `factor`, keeping the screen point (sx, sy) where it is. */
  zoomAt(factor: number, sx: number, sy: number) {
    const c = this.camera, z = Math.min(8, Math.max(0.02, c.z * factor));
    const wx = c.x + sx / c.z, wy = c.y + sy / c.z;
    this.camera = { x: wx - sx / z, y: wy - sy / z, z };
    this.request();
  }
  panBy(dx: number, dy: number) {
    this.camera = { ...this.camera, x: this.camera.x + dx / this.camera.z, y: this.camera.y + dy / this.camera.z };
    this.request();
  }
  setCamera(c: Camera) {
    cancelAnimationFrame(this.flight);
    this.camera = c;
    this.request();
  }

  /** The camera showing the world rectangle (x0, y0)-(x1, y1), with a margin, zoomed in at most to `max`. */
  cameraFor(x0: number, y0: number, x1: number, y1: number, max = 1.5): Camera {
    const W = this.canvas.width / this.dpr, H = this.canvas.height / this.dpr, i = this.insets;
    const w = Math.max(50, W - i.left - i.right), h = Math.max(50, H - i.top - i.bottom), m = Math.min(32, w / 12);
    const z = Math.min(max, (w - 2 * m) / Math.max(1, x1 - x0), (h - 2 * m) / Math.max(1, y1 - y0));
    // the rectangle's center at the center of the clear area
    return { x: (x0 + x1) / 2 - (i.left + w / 2) / z, y: (y0 + y1) / 2 - (i.top + h / 2) / z, z };
  }

  /** The bounds of the items with these ids (all items when none are given). */
  bounds(ids?: string[]) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of ids ? ids.map((i) => this.byId.get(i)).filter((i) => i) as Item[] : this.byId.values()) {
      x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y);
      x1 = Math.max(x1, it.x + it.w); y1 = Math.max(y1, it.y + it.h);
    }
    return x0 <= x1 ? { x0, y0, x1, y1 } : null;
  }

  /** Move the camera to show these items (all when none are given), smoothly unless `now`. */
  focus(ids?: string[], now = false) {
    const b = this.bounds(ids);
    if (!b) return;
    const c = this.cameraFor(b.x0, b.y0, b.x1, b.y1, ids ? 2 : 1.5);
    if (now) this.setCamera(c);
    else this.flyTo(c);
  }

  /** Move the camera to `to` over `ms`, zooming geometrically. */
  flyTo(to: Camera, ms = 450) {
    cancelAnimationFrame(this.flight);
    const from = this.camera, t0 = performance.now();
    const w = this.canvas.width / this.dpr / 2, h = this.canvas.height / this.dpr / 2;
    // interpolate the center and log(zoom)
    const cx0 = from.x + w / from.z, cy0 = from.y + h / from.z, cx1 = to.x + w / to.z, cy1 = to.y + h / to.z;
    const step = () => {
      const u = Math.min(1, (performance.now() - t0) / ms), e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
      const z = from.z * (to.z / from.z) ** e, cx = cx0 + (cx1 - cx0) * e, cy = cy0 + (cy1 - cy0) * e;
      this.camera = { x: cx - w / z, y: cy - h / z, z };
      this.render();
      if (u < 1) this.flight = requestAnimationFrame(step);
    };
    this.flight = requestAnimationFrame(step);
  }

  request() {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }

  private resize() {
    const r = this.el.getBoundingClientRect();
    for (const cv of [this.canvas, this.back]) {
      cv.width = Math.max(1, Math.round(r.width * this.dpr));
      cv.height = Math.max(1, Math.round(r.height * this.dpr));
      cv.style.width = r.width + "px";
      cv.style.height = r.height + "px";
    }
    this.mountedFor = null;
    this.request();
  }

  /** The world rectangle in view. */
  view() {
    const c = this.camera, w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    return { x0: c.x, y0: c.y, x1: c.x + w / c.z, y1: c.y + h / c.z };
  }

  render() {
    this.stats.frames++;
    const c = this.camera, v = this.view(), far = c.z < FAR && (c.z < FEW_FAR || this.boxes.more(v.x0, v.y0, v.x1, v.y1, FEW));
    // the camera: one transform
    this.world.style.transform = `translate(${-c.x * c.z}px, ${-c.y * c.z}px) scale(${c.z})`;
    this.world.style.visibility = far ? "hidden" : "visible";
    if (this.close !== c.z >= CLOSE) this.world.classList.toggle("close", (this.close = c.z >= CLOSE));
    // mount what is near the view, when the view left what was mounted for
    const m = this.mountedFor;
    if (!m || this.unbuilt || m.far !== far || v.x0 < m.x0 || v.y0 < m.y0 || v.x1 > m.x1 || v.y1 > m.y1) {
      const mw = (v.x1 - v.x0) * MARGIN, mh = (v.y1 - v.y0) * MARGIN;
      const r = { x0: v.x0 - mw, y0: v.y0 - mh, x1: v.x1 + mw, y1: v.y1 + mh, far };
      this.unbuilt = !this.mount(far ? new Set() : this.boxes.query(r.x0, r.y0, r.x1, r.y1, new Set()), (v.x0 + v.x1) / 2, (v.y0 + v.y1) / 2);
      this.mountedFor = r;
      if (this.unbuilt) this.request();
    }
    this.drawBack(v, far);
    this.draw(v, far);
    this.onRender?.();
  }

  /** Edit an item where it is: its element, mounted, kept as it is until
   * this is called with another item or null (then it is built again from
   * the document).  The editor puts its fields in it. */
  editElement(id: string | null): HTMLElement | null {
    const was = this.editingId, wasEl = this.editingEl;
    this.editingId = id;
    this.editingEl = null;
    if (was && (was !== id || !id)) {
      wasEl?.remove();
      if (this.cache.get(was) === wasEl) { this.cache.delete(was); this.mounted.delete(was); }
    }
    this.mountedFor = null;
    this.request();
    const it = id ? this.byId.get(id) : undefined;
    if (!id || !it) return null;
    let el = this.cache.get(id);
    if (!el) {
      el = this.itemEl(it);
      this.cache.set(id, el);
    }
    el.style.height = "auto";
    el.style.minHeight = +it.h + "px";
    if (!el.isConnected) {
      this.world.append(el);
      this.mounted.set(id, el);
    }
    return (this.editingEl = el);
  }
  /** The item being edited where it is, if any, and its element. */
  get editing() { return this.editingId; }
  get editingElement() { return this.editingEl; }

  // Mount `want`, nearest (cx, cy) first, building new elements for at most
  // BUDGET ms; returns whether all of them are mounted.
  private mount(want: Set<Item>, cx: number, cy: number): boolean {
    // (the item being edited stays, wherever the camera goes)
    const ed = this.editingId ? this.byId.get(this.editingId) : undefined;
    if (ed) want.add(ed);
    const ids = new Set([...want].map((it) => it.id));
    for (const [id, el] of this.mounted) {
      if (!ids.has(id)) {
        el.remove();
        this.mounted.delete(id);
      }
    }
    const frag = document.createDocumentFragment();
    const todo = [...want].filter((it) => !this.mounted.has(it.id));
    const d = (it: Item) => Math.abs(it.x + it.w / 2 - cx) + Math.abs(it.y + it.h / 2 - cy);
    if (todo.length > 50) todo.sort((a, b) => d(a) - d(b));
    const t0 = performance.now();
    let all = true, added = 0;
    for (const it of todo) {
      if (added >= PER_FRAME) { all = false; break; }
      added++;
      let el = this.cache.get(it.id);
      if (!el) {
        if (performance.now() - t0 > BUDGET) { all = false; break; }
        el = this.itemEl(it);
        this.cache.set(it.id, el);
      }
      el.classList.toggle("selected", this.selection.has(it.id));
      if (el.dataset.untypeset) { delete el.dataset.untypeset; this.typesetSoon(el); }
      frag.append(el);
      this.mounted.set(it.id, el);
      this.stats.mounts++;
    }
    this.world.append(frag);
    this.stats.mounted = this.mounted.size;
    return all;
  }

  private itemEl(it: Item): HTMLElement {
    const el = this.content(it);
    el.style.cssText = placement(it);
    el.dataset.key = contentKey(it);
    return el;
  }

  /** Run code items with this engine (their elements are built again). */
  setCode(host: CodeHost | null) {
    this.code = host;
    for (const [id, el] of this.cache) if (el.dataset.code) { el.remove(); this.cache.delete(id); this.mounted.delete(id); }
    this.mountedFor = null;
    this.request();
  }

  /** Show code items' states again, and their outputs (their elements, mounted or not). */
  codeStates() {
    for (const el of this.cache.values()) {
      const id = el.dataset.code;
      if (!id) continue;
      showState(el, this.code?.state(id) ?? "");
      // (an element built before the engine had its cell: the output now)
      const out = this.code?.output(id, false);
      // (after its code; or, the code hidden, after what comes before it)
      // (being edited: after its code's field)
      if (out && !el.contains(out)) (el.querySelector(".board-code-src, .be-codepart") ?? el.querySelector(".board-text") ?? el.querySelector(".board-code-head"))?.after(outBox(out));
    }
  }

  // math waiting to be typeset, a few milliseconds of it per frame (a fast
  // flight across thousands of notes never waits for KaTeX)
  private math: HTMLElement[] = [];
  private mathFrame = 0;
  private typesetSoon(el: HTMLElement) {
    this.math.push(el);
    if (!this.mathFrame) this.mathFrame = requestAnimationFrame(() => this.typesetSome());
  }
  private typesetSome() {
    this.mathFrame = 0;
    const t0 = performance.now();
    while (this.math.length && performance.now() - t0 < 4) {
      const el = this.math.pop()!; // (the latest mounted first: what is in view)
      if (el.isConnected) this.typeset?.(el);
      else el.dataset.untypeset = "1";
    }
    if (this.math.length) this.mathFrame = requestAnimationFrame(() => this.typesetSome());
  }

  /** An item's element, unplaced (also for measuring a note's height at a width: `now`, math typeset at once). */
  content(it: Content, now = false): HTMLElement {
    const el = document.createElement("div");
    el.className = `board-item board-${it.kind}` + (it.shape && it.shape !== "rect" ? ` board-shape board-shape-${it.shape}` : it.shape ? " board-shape" : "") + (it.code !== undefined ? " board-code" : "");
    // a code item: its place in the reading order and ▶ before the title
    if (it.code !== undefined) {
      const head = document.createElement("div");
      head.className = "board-code-head";
      const n = document.createElement("span");
      n.className = "board-code-n";
      n.textContent = it.order ? String(it.order) : "";
      n.title = "Its place in the board's reading order (top to bottom, then left to right; a group's items together)";
      head.append(n);
      if (this.code && it.id) {
        const id = it.id, run = document.createElement("button");
        run.className = "board-code-run";
        run.textContent = "▶";
        run.title = "Run (and what depends on it)";
        run.onclick = (e) => { e.stopPropagation(); this.code?.run(id); };
        head.append(run);
      }
      if (it.title) head.append(titleEl(it.title));
      if (this.onToggleCode && it.id) {
        const id = it.id, t = document.createElement("button");
        t.className = "board-code-toggle" + (it.hideCode ? " off" : "");
        t.textContent = "{ }";
        t.title = it.hideCode ? "Show the code" : "Hide the code (its output stays)";
        t.setAttribute("aria-pressed", String(!it.hideCode));
        t.onclick = (e) => { e.stopPropagation(); this.onToggleCode?.(id); };
        head.append(t);
      }
      el.append(head);
    } else if (it.title) {
      el.append(titleEl(it.title));
    }
    // its picture (as wide as the note; its height from its shape, before it loads)
    if (it.image) {
      const img = document.createElement("img");
      img.className = "board-img";
      img.alt = it.title ?? "";
      img.draggable = false;
      img.style.aspectRatio = `${it.image.w} / ${it.image.h}`;
      const src = it.image.src ?? this.imageUrl?.(it.image.key);
      if (src) img.src = src;
      el.append(img);
      if (onlyImage(it)) el.classList.add("board-picture");
    }
    const md = (src: string, cls: string) => {
      const d = document.createElement("div");
      d.className = cls;
      if (this.markdown) d.innerHTML = this.markdown(src);
      else d.textContent = src;
      el.append(d);
    };
    if (it.text) md(it.text, "board-text");
    if (it.code !== undefined) {
      if (!it.hideCode) {
        const pre = document.createElement("pre");
        pre.className = "sbnb board-code-src"; // (the notebook's colors for code)
        if (this.code) pre.innerHTML = this.code.highlight(it.code);
        else pre.textContent = it.code;
        el.append(pre);
      }
      // its output: the engine's own element (a copy, to measure or print)
      const out = it.id ? this.code?.output(it.id, now) : null;
      if (out) el.append(outBox(out));
      if (it.id) {
        el.dataset.code = it.id;
        showState(el, this.code?.state(it.id) ?? "");
      }
    }
    if (it.detail) md(it.detail, "board-detail");
    if (it.ref && /^https?:\/\//i.test(it.ref)) {
      const a = document.createElement("a");
      a.className = "board-ref";
      a.href = it.ref;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "↗ " + decodeURIComponent(it.ref.replace(/^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\//, "").replace(/^https?:\/\//, ""));
      el.append(a);
    }
    if (this.typeset && el.querySelector(".math")) {
      if (now) this.typeset(el);
      else this.typesetSoon(el);
    }
    return el;
  }

  /** A note's height at width `w`, as rendered (the element is measured in the world, unseen). */
  measure(it: Content, w: number): number {
    const el = this.content(it, true);
    el.style.cssText = `left:0;top:0;width:${w}px;visibility:hidden;`;
    el.classList.add("board-measure");
    this.world.append(el);
    const h = el.offsetHeight;
    el.remove();
    return h;
  }

  /** The width a note's text needs, at most `max` (its longest line, or `max` if it wraps). */
  measureWidth(it: Content, max: number): number {
    const el = this.content(it, true);
    el.style.cssText = `left:0;top:0;width:max-content;max-width:${max}px;visibility:hidden;`;
    el.classList.add("board-measure");
    this.world.append(el);
    const w = el.offsetWidth + 1; // (layout pixels: the camera's scale does not apply)
    el.remove();
    return w;
  }

  // behind the notes: groups (outer first) and edges
  private drawBack(v: { x0: number; y0: number; x1: number; y1: number }, far: boolean) {
    const ctx = this.bctx, c = this.camera, d = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.back.width, this.back.height);
    if (!this.edges.length && !this.byId.size) return;
    ctx.setTransform(c.z * d, 0, 0, c.z * d, -c.x * c.z * d, -c.y * c.z * d);
    const groups = [...this.boxes.query(v.x0, v.y0, v.x1, v.y1, new Set())].filter((it) => it.kind === "group").sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));
    for (const g of groups) {
      ctx.beginPath();
      ctx.roundRect(g.x, g.y, g.w, g.h, 14);
      ctx.fillStyle = g.color ?? GROUP;
      ctx.fill();
      ctx.lineWidth = (g.id === this.dropTarget ? 3 : 1) / c.z;
      ctx.strokeStyle = g.id === this.dropTarget ? "#2a6f2f" : "rgba(0,0,0,.18)";
      ctx.stroke();
    }
    // notes in view still waiting for their elements: placeholders
    if (!far && this.unbuilt) {
      for (const it of this.boxes.query(v.x0, v.y0, v.x1, v.y1, new Set())) {
        if (it.kind !== "note" || this.mounted.has(it.id)) continue;
        ctx.fillStyle = it.color ?? "#fff";
        ctx.fillRect(it.x, it.y, it.w, it.h);
      }
    }
    // edges: center to center, from border to border, an arrowhead at the end
    const lw = Math.max(1.6, 1.2 / c.z), head = Math.max(9, 7 / c.z);
    ctx.lineWidth = lw;
    ctx.strokeStyle = ctx.fillStyle = EDGE;
    const labels: [string, number, number][] = [];
    // an arrowhead at (x, y), pointing along (ux, uy)
    const arrowhead = (x: number, y: number, ux: number, uy: number) => {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - ux * head - uy * head * 0.45, y - uy * head + ux * head * 0.45);
      ctx.lineTo(x - ux * head + uy * head * 0.45, y - uy * head - ux * head * 0.45);
      ctx.fill();
    };
    for (const e of this.edges) {
      const a = this.byId.get(e.from), b = this.byId.get(e.to);
      if (!a || !b) continue;
      // its route, or straight from border to border
      let p = e.points;
      if (p) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
        if (x1 < v.x0 || x0 > v.x1 || y1 < v.y0 || y0 > v.y1) continue;
      } else {
        if (Math.max(a.x + a.w, b.x + b.w) < v.x0 || Math.min(a.x, b.x) > v.x1 || Math.max(a.y + a.h, b.y + b.h) < v.y0 || Math.min(a.y, b.y) > v.y1) continue;
        const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
        const dx = bx - ax, dy = by - ay;
        // where the line leaves a box centered on its end: the fraction t of (dx, dy)
        const exit = (it: Item) => Math.min(dx ? it.w / 2 / Math.abs(dx) : Infinity, dy ? it.h / 2 / Math.abs(dy) : Infinity);
        const t0 = exit(a), t1 = 1 - exit(b);
        if (t1 <= t0) continue; // overlapping boxes (a group and a member)
        p = [ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1];
      }
      const n = p.length, end = e.arrow !== "none", start = e.arrow === "both";
      const ex = p[n - 2], ey = p[n - 1], el = Math.hypot(ex - p[n - 4], ey - p[n - 3]) || 1, ux = (ex - p[n - 4]) / el, uy = (ey - p[n - 3]) / el;
      const sl = Math.hypot(p[2] - p[0], p[3] - p[1]) || 1, vx = (p[0] - p[2]) / sl, vy = (p[1] - p[3]) / sl;
      // the line (rounded corners), stopping short of its arrowheads
      const sel = e.id === this.selectedEdge;
      ctx.strokeStyle = ctx.fillStyle = sel ? "#1f7a2a" : EDGE;
      ctx.lineWidth = (e.line === "thick" ? lw * 2 : lw) * (sel ? 1.8 : 1);
      if (e.line === "dotted") ctx.setLineDash([4 * Math.max(1, 0.8 / c.z), 4 * Math.max(1, 0.8 / c.z)]);
      ctx.beginPath();
      ctx.moveTo(start ? p[0] - vx * head * 0.8 : p[0], start ? p[1] - vy * head * 0.8 : p[1]);
      for (let i = 2; i < n - 2; i += 2) {
        const r = Math.min(10, Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]) / 2, Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]) / 2);
        ctx.arcTo(p[i], p[i + 1], p[i + 2], p[i + 3], r);
      }
      ctx.lineTo(end ? ex - ux * head * 0.8 : ex, end ? ey - uy * head * 0.8 : ey);
      ctx.stroke();
      ctx.setLineDash([]);
      if (end) arrowhead(ex, ey, ux, uy);
      if (start) arrowhead(p[0], p[1], vx, vy);
      if (e.label) labels.push([e.label, e.lx ?? (p[0] + ex) / 2, e.ly ?? (p[1] + ey) / 2]);
    }
    ctx.lineWidth = lw;
    ctx.strokeStyle = ctx.fillStyle = EDGE;
    if (this.pending) {
      const a = this.byId.get(this.pending.from);
      if (a) {
        ctx.setLineDash([6 / c.z, 4 / c.z]);
        ctx.beginPath();
        ctx.moveTo(a.x + a.w / 2, a.y + a.h / 2);
        ctx.lineTo(this.pending.x, this.pending.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // labels, on top of every line, when legible
    if (labels.length && 12 * c.z >= 7) {
      ctx.font = "12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const [text, x, y] of labels) {
        const w = ctx.measureText(text).width + 10;
        ctx.fillStyle = "rgba(250,250,247,.92)";
        ctx.fillRect(x - w / 2, y - 9, w, 18);
        ctx.fillStyle = "#3d4a37";
        ctx.fillText(text, x, y);
      }
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }
  }

  private draw(v: { x0: number; y0: number; x1: number; y1: number }, far: boolean) {
    const ctx = this.ctx, c = this.camera, d = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(c.z * d, 0, 0, c.z * d, -c.x * c.z * d, -c.y * c.z * d);
    let n = 0;
    if (far) {
      // far out: the boxes as rectangles, with their titles when legible
      // (one path per color, one fill each: far fewer state changes than a
      // fillRect per item)
      const inView = new Set([...this.boxes.query(v.x0, v.y0, v.x1, v.y1, new Set())].filter((it) => it.kind !== "group"));
      const byColor = new Map<string, Item[]>();
      for (const it of inView) {
        // (a picture: drawn itself, once it is decoded)
        if (it.image) {
          const im = this.picture(it.image);
          if (im) { ctx.drawImage(im, it.x, it.y, it.w, it.h); continue; }
        }
        const k = it.color ?? "#9cc28f";
        (byColor.get(k) ?? byColor.set(k, []).get(k)!).push(it);
      }
      for (const [color, its] of byColor) {
        ctx.beginPath();
        for (const it of its) ctx.rect(it.x, it.y, it.w, it.h);
        ctx.fillStyle = color;
        ctx.fill();
      }
      n += inView.size;
      // titles, when legible
      if (260 * c.z > 40) {
        ctx.font = `${12 / c.z}px system-ui, sans-serif`;
        ctx.fillStyle = "#10140f";
        // (only titles that fit: squeezed text is worse than none)
        // (shrunk to fit its box, down to 7 px, rather than left out)
        const font = ctx.font;
        for (const it of inView) {
          const t = farLabel(it);
          if (!t || it.w * c.z <= 40) continue;
          const w = ctx.measureText(t).width, room = it.w - 8 / c.z;
          if (w <= room) { ctx.fillText(t, it.x + 4 / c.z, it.y + 14 / c.z); continue; }
          const px = (12 * room) / w;
          if (px < 7) continue;
          ctx.font = `${px / c.z}px system-ui, sans-serif`;
          ctx.fillText(t, it.x + 4 / c.z, it.y + (px + 2) / c.z);
          ctx.font = font;
        }
      }
    }
    if (far) {
      // groups' titles over their members, as large as their groups allow
      // (between 11 and 22 pixels on screen), with a halo
      const groups = [...this.boxes.query(v.x0, v.y0, v.x1, v.y1, new Set())].filter((it) => it.kind === "group" && it.title).sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));
      ctx.lineJoin = "round";
      // (a map's rule: a group is labeled while it is between 100 and 1,000
      // pixels wide on screen, so the levels of nesting take turns; a group
      // with no groups inside keeps its label when larger)
      const parents = new Set(groups.map((g) => g.parent).filter(Boolean));
      for (const g of groups) {
        const sw = g.w * c.z;
        if (sw < 100 || (sw > 1000 && parents.has(g.id))) continue;
        // the title, or without its parenthetical when that is larger
        const size = (t: string) => Math.min(22, (g.w * c.z) / (t.length * 0.62), 11 + 11 / (1 + (g.depth ?? 0)));
        const full = plainTitle(g.title!), short = full.replace(/\s*\(.*\)\s*$/, "");
        const title = size(short) > size(full) + 3 ? short : full, px = size(title);
        if (px < 11) continue;
        ctx.font = `600 ${px / c.z}px system-ui, sans-serif`;
        ctx.lineWidth = 4 / c.z;
        ctx.strokeStyle = "rgba(250,250,247,.9)";
        ctx.strokeText(title, g.x + 6 / c.z, g.y + (px + 4) / c.z, g.w - 12 / c.z);
        ctx.fillStyle = "#1d241a";
        ctx.fillText(title, g.x + 6 / c.z, g.y + (px + 4) / c.z, g.w - 12 / c.z);
      }
    }
    // ink (far out, strokes thinner than half a pixel are skipped, and when
    // all are, the query too)
    const ink = this.maxWidth * c.z < 0.5 ? [] : this.strokes.query(v.x0, v.y0, v.x1, v.y1, new Set());
    for (const it of ink) {
      const lw = it.width ?? 2;
      if (lw * c.z < 0.5) continue;
      let p = this.paths.get(it.id);
      if (!p) {
        if (it.outline) {
          const o = it.outline.map((v, i) => v + (i % 2 ? it.y : it.x));
          p = new Path2D(inkPath(o));
        } else {
          p = new Path2D();
          const pts = it.points!;
          p.moveTo(it.x + pts[0], it.y + pts[1]);
          for (let i = 2; i < pts.length; i += 2) p.lineTo(it.x + pts[i], it.y + pts[i + 1]);
        }
        this.paths.set(it.id, p);
      }
      if (it.outline) {
        // (a pen's stroke: its outline, filled; a highlighter's, see-through)
        ctx.fillStyle = it.color ?? INK;
        ctx.globalAlpha = it.opacity ?? 1;
        ctx.fill(p);
        ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = it.color ?? "#2a6f2f";
        ctx.lineWidth = lw;
        ctx.stroke(p);
      }
      n++;
    }
    // the selection rectangle being drawn, and a drag's alignment guides
    if (this.marquee) {
      const m = this.marquee;
      ctx.fillStyle = "rgba(42, 111, 47, .08)";
      ctx.strokeStyle = "rgba(42, 111, 47, .7)";
      ctx.lineWidth = 1 / c.z;
      ctx.fillRect(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
      ctx.strokeRect(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
    }
    if (this.handle && !far) {
      const it = this.byId.get(this.handle);
      if (it) {
        const s = 9 / c.z;
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "#2a6f2f";
        ctx.lineWidth = 1.5 / c.z;
        ctx.fillRect(it.x + it.w - s / 2, it.y + it.h - s / 2, s, s);
        ctx.strokeRect(it.x + it.w - s / 2, it.y + it.h - s / 2, s, s);
      }
    }
    if (this.guides) {
      ctx.strokeStyle = "#d6336c";
      ctx.lineWidth = 1 / c.z;
      ctx.beginPath();
      for (const x of this.guides.xs) { ctx.moveTo(x, v.y0); ctx.lineTo(x, v.y1); }
      for (const y of this.guides.ys) { ctx.moveTo(v.x0, y); ctx.lineTo(v.x1, y); }
      ctx.stroke();
    }
    this.stats.drawn = n;
  }

  /** Show an item at a new size at once (a resize under way: the document follows when it ends). */
  resizeItem(id: string, w: number, h?: number) {
    const it = this.byId.get(id);
    if (!it) return;
    it.w = w;
    if (h !== undefined) it.h = h;
    const el = this.cache.get(id);
    if (el) {
      el.style.cssText = placement(it);
      // (a note's height follows its text: measured again when the resize ends)
      if (h === undefined) el.style.height = "auto";
    }
    this.request();
  }

  // Pictures far out, as decoded images for the canvas (each loaded once; drawn when ready).
  private pictures = new Map<string, HTMLImageElement>();
  private picture(i: NonNullable<Item["image"]>): HTMLImageElement | null {
    const src = i.src ?? this.imageUrl?.(i.key);
    if (!src) return null;
    let im = this.pictures.get(src);
    if (!im) {
      im = new Image();
      im.onload = () => this.request();
      im.src = src;
      this.pictures.set(src, im);
    }
    return im.complete && im.naturalWidth ? im : null;
  }

  /** World coordinates of a point on the page (client coordinates). */
  toWorld(cx: number, cy: number) {
    const r = this.el.getBoundingClientRect(), c = this.camera;
    return { x: c.x + (cx - r.left) / c.z, y: c.y + (cy - r.top) / c.z };
  }
  /** The page rectangle (client coordinates) of an item. */
  clientRect(id: string) {
    const it = this.byId.get(id), r = this.el.getBoundingClientRect(), c = this.camera;
    return it ? { left: r.left + (it.x - c.x) * c.z, top: r.top + (it.y - c.y) * c.z, width: it.w * c.z, height: it.h * c.z } : null;
  }
  edgeList(): Edge[] {
    return this.edges;
  }
  item(id: string): Item | undefined {
    return this.byId.get(id);
  }
  /** Move these items by (dx, dy) world units now (dragging): their boxes, elements and edges. */
  translate(ids: string[], dx: number, dy: number) {
    for (const id of ids) {
      const it = this.byId.get(id);
      if (!it) continue;
      this.boxes.remove(it);
      it.x += dx;
      it.y += dy;
      if (it.inner) it.inner = { x: it.inner.x + dx, y: it.inner.y + dy };
      this.boxes.add(it);
      const el = this.cache.get(it.id);
      if (el) { el.style.left = it.x + "px"; el.style.top = it.y + "px"; }
    }
    const moved = new Set(ids);
    for (const e of this.edges) if (moved.has(e.from) || moved.has(e.to)) { delete e.points; delete e.lx; delete e.ly; }
    this.mountedFor = null;
    this.request();
  }
  /** Outline one item (or none). */
  /** Outline these items (one, several, or none). */
  select(ids: string | string[] | null) {
    for (const id of this.selection) this.cache.get(id)?.classList.remove("selected");
    this.selection = new Set(ids === null ? [] : typeof ids === "string" ? [ids] : ids);
    for (const id of this.selection) this.cache.get(id)?.classList.add("selected");
    this.request();
  }

  /** The notes and groups wholly inside a world rectangle. */
  itemsIn(x0: number, y0: number, x1: number, y1: number): Item[] {
    return this.near(x0, y0, x1, y1).filter((it) => it.x >= x0 && it.y >= y0 && it.x + it.w <= x1 && it.y + it.h <= y1);
  }
  /** The notes and groups overlapping a world rectangle (a large one: every item, not the grid's cells). */
  near(x0: number, y0: number, x1: number, y1: number): Item[] {
    const big = ((x1 - x0) / CELL) * ((y1 - y0) / CELL) > 4 * this.byId.size + 64;
    const its = big ? [...this.byId.values()] : [...this.boxes.query(x0, y0, x1, y1, new Set())];
    return its.filter((it) => (it.kind === "note" || it.kind === "group") && it.x < x1 && it.x + it.w > x0 && it.y < y1 && it.y + it.h > y0);
  }

  /** An edge's route, or its straight line from border to border (world coordinates). */
  edgePoints(e: Edge): number[] | null {
    if (e.points) return e.points;
    const a = this.byId.get(e.from), b = this.byId.get(e.to);
    if (!a || !b) return null;
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2, dx = bx - ax, dy = by - ay;
    const exit = (it: Item) => Math.min(dx ? it.w / 2 / Math.abs(dx) : Infinity, dy ? it.h / 2 / Math.abs(dy) : Infinity);
    const t0 = exit(a), t1 = 1 - exit(b);
    return t1 <= t0 ? null : [ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1];
  }

  /** The edge at a screen point: on its label, or within 6 pixels of its line. */
  edgeAt(sx: number, sy: number): Edge | null {
    const c = this.camera, x = c.x + sx / c.z, y = c.y + sy / c.z, tol = 6 / c.z;
    let best: Edge | null = null, bd = Infinity;
    for (const e of this.edges) {
      const p = this.edgePoints(e);
      if (!p) continue;
      if (e.label) {
        const lx = e.lx ?? (p[0] + p[p.length - 2]) / 2, ly = e.ly ?? (p[1] + p[p.length - 1]) / 2, w = e.label.length * 6.8 + 10;
        if (Math.abs(x - lx) <= w / 2 && Math.abs(y - ly) <= 9) return e;
      }
      for (let i = 0; i + 3 < p.length; i += 2) {
        const [x0, y0, x1, y1] = [p[i], p[i + 1], p[i + 2], p[i + 3]], L = (x1 - x0) ** 2 + (y1 - y0) ** 2;
        const t = L ? Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / L)) : 0;
        const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
        if (d < tol && d < bd) { bd = d; best = e; }
      }
    }
    return best;
  }

  /** The groups holding a world point, innermost first, leaving out `except`. */
  groupsAt(x: number, y: number, except: Set<string> = new Set()): Item[] {
    return [...this.boxes.query(x, y, x + 0.01, y + 0.01, new Set())].filter((it) => it.kind === "group" && !except.has(it.id)).sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
  }

  /** The note or group at a screen point, innermost first. */
  itemAt(sx: number, sy: number): Item | null {
    const c = this.camera, x = c.x + sx / c.z, y = c.y + sy / c.z;
    const hits = [...this.boxes.query(x, y, x + 0.01, y + 0.01, new Set())];
    hits.sort((a, b) => (a.kind === "group" ? 0 : 100) + (a.depth ?? 0) - ((b.kind === "group" ? 0 : 100) + (b.depth ?? 0)));
    return hits.pop() ?? null;
  }

  // wheel: pan (zoom with Ctrl, as trackpads pinch); drag: pan; two
  // fingers: pinch; double click: fly to the item there (or everything)
  private input() {
    this.el.addEventListener("wheel", (e) => {
      e.preventDefault();
      cancelAnimationFrame(this.flight);
      const r = this.el.getBoundingClientRect();
      const k = e.deltaMode === 1 ? 16 : 1; // (lines, Firefox's wheel)
      // (a trackpad's pinch is many small deltas, a mouse wheel's notch one
      // large one: capped, so both zoom at a comfortable rate)
      if (e.ctrlKey) this.zoomAt(Math.exp(-Math.sign(e.deltaY) * Math.min(10, Math.abs(e.deltaY * k)) / 50), e.clientX - r.left, e.clientY - r.top);
      else this.panBy(e.deltaX * k, e.deltaY * k);
    }, { passive: false });
    // (Safari's pinch: gesture events with a scale, not ctrl+wheel)
    let scale = 1;
    this.el.addEventListener("gesturestart", (e) => { e.preventDefault(); scale = 1; });
    this.el.addEventListener("gesturechange", (e: any) => {
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      this.zoomAt(e.scale / scale, e.clientX - r.left, e.clientY - r.top);
      scale = e.scale;
    });
    const down = new Map<number, { x: number; y: number }>();
    const mid = () => {
      const [p, q] = [...down.values()];
      return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, d: Math.hypot(p.x - q.x, p.y - q.y) };
    };
    this.el.addEventListener("pointerdown", (e) => {
      // (links, buttons, controls, 3D views, and the fields of the item being
      // edited, stay theirs; its frame drags it, as any item's does)
      if ((e.target as Element).closest?.("a, button, input, select, textarea, .board-code-out canvas, .board-editing :is(.mb, .be-md, .be-codebox, .board-code-out)")) return;
      cancelAnimationFrame(this.flight);
      if (this.onItemDown && down.size === 0 && e.isPrimary) {
        const r = this.el.getBoundingClientRect(), it = this.itemAt(e.clientX - r.left, e.clientY - r.top);
        // (an edge, drawn over groups and under notes, before the group it crosses)
        const ed = it?.kind !== "note" && this.onEdgeDown ? this.edgeAt(e.clientX - r.left, e.clientY - r.top) : null;
        if (ed && this.onEdgeDown!(ed, e)) return;
        if (it && this.onItemDown(it, e)) return;
        if (!it && !ed && this.onBackgroundDown?.(e)) return;
      }
      down.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.el.setPointerCapture(e.pointerId);
    });
    this.el.addEventListener("pointermove", (e) => {
      const last = down.get(e.pointerId);
      if (!last) return;
      if (down.size === 2) {
        const r = this.el.getBoundingClientRect(), a = mid();
        down.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const b = mid();
        this.panBy(a.x - b.x, a.y - b.y);
        if (a.d > 0) this.zoomAt(b.d / a.d, b.x - r.left, b.y - r.top);
      } else if (down.size === 1) {
        this.panBy(last.x - e.clientX, last.y - e.clientY);
        down.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
    });
    for (const t of ["pointerup", "pointercancel"]) this.el.addEventListener(t, (e) => { down.delete((e as PointerEvent).pointerId); });
    // (a double tap: touch screens' double-click, which not every browser
    // makes into a dblclick; one it does make is then ignored)
    let tap: { t: number; x: number; y: number } | null = null, start: { t: number; x: number; y: number } | null = null, doubled = 0;
    this.el.addEventListener("pointerdown", (e) => { if (e.pointerType === "touch" && e.isPrimary) start = { t: e.timeStamp, x: e.clientX, y: e.clientY }; }, true);
    this.el.addEventListener("pointerup", (e) => {
      if (e.pointerType !== "touch" || !e.isPrimary || !start) return;
      const quick = e.timeStamp - start.t < 300 && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 10;
      start = null;
      if (!quick) { tap = null; return; }
      if (tap && e.timeStamp - tap.t < 350 && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 25) {
        tap = null;
        doubled = e.timeStamp;
        if (!editingAt(e)) this.doubleAt(e.clientX, e.clientY);
      } else tap = { t: e.timeStamp, x: e.clientX, y: e.clientY };
    }, true);
    this.el.addEventListener("dblclick", (e) => {
      if (doubled && e.timeStamp - doubled < 600) return;
      if (!editingAt(e)) this.doubleAt(e.clientX, e.clientY);
    });
  }

  // a double-click (or double tap) at a point on the page
  private doubleAt(cx: number, cy: number) {
    {
      const e = { clientX: cx, clientY: cy };
      const r = this.el.getBoundingClientRect(), it = this.itemAt(e.clientX - r.left, e.clientY - r.top);
      const ed = it?.kind !== "note" && this.onEdgeDoubleClick ? this.edgeAt(e.clientX - r.left, e.clientY - r.top) : null;
      if (ed && this.onEdgeDoubleClick!(ed)) return;
      const w = this.toWorld(e.clientX, e.clientY);
      if (this.onDoubleClick?.(it, w.x, w.y)) return;
      // (flying there; already there, a double-click selects a word, as on
      // any page, and the camera stays)
      const b = this.bounds(it ? [it.id] : undefined);
      if (!b) return;
      const to = this.cameraFor(b.x0, b.y0, b.x1, b.y1, it ? 2 : 1.5), c = this.camera;
      if (Math.abs(to.z / c.z - 1) < 0.02 && Math.hypot(to.x - c.x, to.y - c.y) * c.z < 4) return;
      getSelection()?.removeAllRanges();
      this.flyTo(to);
    }
  }
}

// An element's position and size, and its color.
// (numbers, and a color checked when the document was read: doc.ts cleanDoc; checked again, as items also come from elsewhere)
const placement = (it: Item) => `left:${+it.x}px;top:${+it.y}px;width:${+it.w}px;height:${+it.h}px;` + (it.color && it.kind !== "group" && /^[#\w(),.%\s-]+$/.test(it.color) ? `--c:${it.color};` : "");
// (a note that is only a picture: shown as the picture alone; as doc.ts's onlyImage)
const onlyImage = (it: Content) => !!it.image && !it.title && !it.text && it.code === undefined && !it.detail && !it.ref;
// What an element shows (kept when this is unchanged).
const contentKey = (it: Item) => JSON.stringify([it.kind, it.title, it.text, it.detail, it.ref, it.shape, it.code, it.order, it.hideCode, it.image]);
// (a double-click in the item being edited selects a word, as in any field)
const editingAt = (e: Event) => !!(e.target as Element | null)?.closest?.(".board-editing");
// A code item's output, in the box that gives it the notebook's styles.
function outBox(out: HTMLElement) {
  const box = document.createElement("div");
  box.className = "sbnb board-code-out";
  box.append(out);
  return box;
}
const STATES = ["queued", "running", "stale", "error", "failed", "cancelled", "interrupted"];
function showState(el: HTMLElement, state: string) {
  for (const s of STATES) el.classList.toggle("code-" + s, s === state);
}

// A title: its text, and its math ($...$, \(...\), as in Markdown) as
// elements KaTeX typesets; built as text and elements, never from markup.
const TITLE_MATH = /\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)|\\\(([\s\S]+?)\\\)/g;
function titleEl(title: string): HTMLElement {
  const b = document.createElement("b");
  let last = 0;
  for (const m of title.matchAll(TITLE_MATH)) {
    b.append(title.slice(last, m.index));
    const s = document.createElement("span");
    s.className = "math";
    s.dataset.tex = (m[1] ?? m[2]).trim();
    s.textContent = m[0];
    b.append(s);
    last = m.index + m[0].length;
  }
  b.append(title.slice(last));
  return b;
}
/** A title as plain text (drawn on a canvas, or as an SVG label): its math as its TeX. */
export function plainTitle(title: string): string {
  return title.replace(TITLE_MATH, (_, a, b) => (a ?? b).trim());
}

// What a note shows far out: its title, or else its text's first line
// without Markdown (a flowchart's notes have only text)
const farLabels = new WeakMap<Item, string>();
export function farLabel(it: Item): string {
  if (it.title) return plainTitle(it.title);
  let t = farLabels.get(it);
  if (t === undefined && !it.text && it.code) farLabels.set(it, (t = it.code.split("\n").find((l) => l.trim())?.trim() ?? ""));
  if (t === undefined) {
    t = (it.text ?? "").split("\n").find((l) => l.trim())?.replace(/\$\$?[^$]*\$\$?|!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\\(.)/g, "$1").replace(/[*_`#>]|^\s*[-+]\s/g, "").replace(/\s+/g, " ").trim() ?? "";
    farLabels.set(it, t);
  }
  return t;
}

/** A synthetic board: `n` notes in a loose grid, `strokes` ink strokes among them. */
export function synthetic(n: number, strokes: number, seed = 1): Item[] {
  let s = seed;
  // (32-bit integer arithmetic: a float product past 2^53 loses its low bits)
  const rand = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  const items: Item[] = [];
  const cols = Math.ceil(Math.sqrt(n));
  const colors = ["#cfe3c6", "#f3e3b5", "#d5e4f5", "#f2d0d0", "#e2d6f1"];
  for (let i = 0; i < n; i++) {
    items.push({
      id: "n" + i, kind: "note", x: (i % cols) * 320 + rand() * 40, y: Math.floor(i / cols) * 240 + rand() * 40, w: 260, h: 170,
      title: `Note ${i}`, text: "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.".slice(0, 40 + Math.floor(rand() * 60)),
      color: colors[i % colors.length],
    });
  }
  const span = cols * 320;
  for (let i = 0; i < strokes; i++) {
    const k = 8 + Math.floor(rand() * 24), pts = new Float32Array(2 * k);
    let px = 0, py = 0;
    for (let j = 0; j < k; j++) { px += rand() * 14 - 4; py += rand() * 14 - 7; pts[2 * j] = px; pts[2 * j + 1] = py; }
    items.push(stroke("s" + i, rand() * span, rand() * (Math.ceil(n / cols) * 240), pts, 1.5 + rand() * 2));
  }
  return items;
}

/** An ink item from points in world coordinates offset by (x, y): its box is the points'. */
export function stroke(id: string, x: number, y: number, pts: Float32Array, width = 2, color?: string): Item {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
    y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]);
  }
  const rel = new Float32Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) { rel[i] = pts[i] - x0; rel[i + 1] = pts[i + 1] - y0; }
  const pad = width;
  return { id, kind: "ink", x: x + x0 - pad, y: y + y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad, points: rel.map((v) => v + pad), width, ...(color ? { color } : {}) };
}
