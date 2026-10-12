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
  /** ink: points relative to (x, y), as x0, y0, x1, y1, ... */
  points?: Float32Array;
  width?: number;
  /** notes: Markdown shown only when zoomed in */
  detail?: string;
  /** notes: a link, shown at the note's foot */
  ref?: string;
  /** groups and notes: how deeply nested (groups are drawn outer first) */
  depth?: number;
  /** groups: where their members' positions are measured from */
  inner?: { x: number; y: number };
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface Camera {
  x: number; // world coordinates at the viewport's top left
  y: number;
  z: number; // zoom: screen pixels per world unit
}

const CELL = 512; // the spatial grid's cell, in world units
const FAR = 0.5; // below this zoom: rectangles on the canvas, no DOM (text under 7 px is not read)
const BUDGET = 4; // ms of building notes' elements per frame; the rest wait, drawn as placeholders
const PER_FRAME = 30; // and at most this many elements added (each costs the browser's layout too)
const MARGIN = 0.5; // mounted: the viewport plus this fraction around it
const CLOSE = 1.1; // from this zoom: notes' details
const GROUP = "#eef2ea", INK = "#2a6f2f", EDGE = "#5f7457";

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
  private byId = new Map<string, Item>();
  private close = false;
  private flight = 0;
  /** Markdown to HTML for notes (plain text without it), and math typesetting */
  markdown: ((src: string) => string) | null = null;
  typeset: ((el: HTMLElement) => void) | null = null;
  /** a press on an item (not a link): return true to take it (the board does not pan) */
  onItemDown: ((it: Item, e: PointerEvent) => boolean) | null = null;
  /** a double click: on an item, or (null) on the background at world (x, y); return true when handled */
  onDoubleClick: ((it: Item | null, x: number, y: number) => boolean) | null = null;
  private selected: string | null = null;
  private boxes = new Grid(); // notes and shapes
  private strokes = new Grid(); // ink
  private paths = new Map<string, Path2D>();
  private maxWidth = 0; // the widest stroke's width
  private mounted = new Map<string, HTMLElement>();
  private cache = new Map<string, HTMLElement>(); // rendered once, kept
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
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.resize();
    this.input();
  }

  setItems(items: Item[], edges: Edge[] = []) {
    this.edges = edges;
    this.byId = new Map(items.map((it) => [it.id, it]));
    this.boxes = new Grid();
    this.strokes = new Grid();
    this.paths.clear();
    for (const m of this.mounted.values()) m.remove();
    this.mounted.clear();
    this.cache.clear();
    this.mountedFor = null;
    this.maxWidth = 0;
    this.world.replaceChildren();
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
    const c = this.camera, v = this.view(), far = c.z < FAR;
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
  }

  // Mount `want`, nearest (cx, cy) first, building new elements for at most
  // BUDGET ms; returns whether all of them are mounted.
  private mount(want: Set<Item>, cx: number, cy: number): boolean {
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
      el.classList.toggle("selected", it.id === this.selected);
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
    el.style.cssText = `left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.h}px;` + (it.color && it.kind !== "group" ? `--c:${it.color};` : "");
    return el;
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
  content(it: Pick<Item, "kind" | "title" | "text" | "detail" | "ref">, now = false): HTMLElement {
    const el = document.createElement("div");
    el.className = `board-item board-${it.kind}`;
    if (it.title) {
      const h = document.createElement("b");
      h.textContent = it.title;
      el.append(h);
    }
    const md = (src: string, cls: string) => {
      const d = document.createElement("div");
      d.className = cls;
      if (this.markdown) d.innerHTML = this.markdown(src);
      else d.textContent = src;
      el.append(d);
    };
    if (it.text) md(it.text, "board-text");
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
  measure(it: Pick<Item, "kind" | "title" | "text" | "detail" | "ref">, w: number): number {
    const el = this.content(it, true);
    el.style.cssText = `left:0;top:0;width:${w}px;visibility:hidden;`;
    el.classList.add("board-measure");
    this.world.append(el);
    const h = el.offsetHeight;
    el.remove();
    return h;
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
      ctx.lineWidth = 1 / c.z;
      ctx.strokeStyle = "rgba(0,0,0,.18)";
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
    for (const e of this.edges) {
      const a = this.byId.get(e.from), b = this.byId.get(e.to);
      if (!a || !b) continue;
      if (Math.max(a.x + a.w, b.x + b.w) < v.x0 || Math.min(a.x, b.x) > v.x1 || Math.max(a.y + a.h, b.y + b.h) < v.y0 || Math.min(a.y, b.y) > v.y1) continue;
      const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
      const dx = bx - ax, dy = by - ay;
      // where the line leaves a box centered on its end: the fraction t of (dx, dy)
      const exit = (it: Item) => Math.min(dx ? it.w / 2 / Math.abs(dx) : Infinity, dy ? it.h / 2 / Math.abs(dy) : Infinity);
      const t0 = exit(a), t1 = 1 - exit(b);
      if (t1 <= t0) continue; // overlapping boxes (a group and a member)
      const x0 = ax + dx * t0, y0 = ay + dy * t0, x1 = ax + dx * t1, y1 = ay + dy * t1;
      const len = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / len, uy = (y1 - y0) / len;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1 - ux * head * 0.8, y1 - uy * head * 0.8);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - ux * head - uy * head * 0.45, y1 - uy * head + ux * head * 0.45);
      ctx.lineTo(x1 - ux * head + uy * head * 0.45, y1 - uy * head - ux * head * 0.45);
      ctx.fill();
      if (e.label) labels.push([e.label, (x0 + x1) / 2, (y0 + y1) / 2]);
    }
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
        for (const it of inView) if (it.title && it.w * c.z > 40 && ctx.measureText(it.title).width <= it.w - 8 / c.z) ctx.fillText(it.title, it.x + 4 / c.z, it.y + 14 / c.z);
      }
    }
    if (far) {
      // groups' titles over their members, as large as their groups allow
      // (between 11 and 22 pixels on screen), with a halo
      const groups = [...this.boxes.query(v.x0, v.y0, v.x1, v.y1, new Set())].filter((it) => it.kind === "group" && it.title).sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));
      ctx.lineJoin = "round";
      for (const g of groups) {
        // the title, or without its parenthetical when that is larger
        const size = (t: string) => Math.min(22, (g.w * c.z) / (t.length * 0.62), 11 + 11 / (1 + (g.depth ?? 0)));
        const short = g.title!.replace(/\s*\(.*\)\s*$/, "");
        const title = size(short) > size(g.title!) + 3 ? short : g.title!, px = size(title);
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
        p = new Path2D();
        const pts = it.points!;
        p.moveTo(it.x + pts[0], it.y + pts[1]);
        for (let i = 2; i < pts.length; i += 2) p.lineTo(it.x + pts[i], it.y + pts[i + 1]);
        this.paths.set(it.id, p);
      }
      ctx.strokeStyle = it.color ?? "#2a6f2f";
      ctx.lineWidth = lw;
      ctx.stroke(p);
      n++;
    }
    this.stats.drawn = n;
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
    this.mountedFor = null;
    this.request();
  }
  /** Outline one item (or none). */
  select(id: string | null) {
    if (this.selected) this.cache.get(this.selected)?.classList.remove("selected");
    this.selected = id;
    if (id) this.cache.get(id)?.classList.add("selected");
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
      if (e.ctrlKey) this.zoomAt(Math.exp(-e.deltaY / 200), e.clientX - r.left, e.clientY - r.top);
      else this.panBy(e.deltaX, e.deltaY);
    }, { passive: false });
    const down = new Map<number, { x: number; y: number }>();
    const mid = () => {
      const [p, q] = [...down.values()];
      return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, d: Math.hypot(p.x - q.x, p.y - q.y) };
    };
    this.el.addEventListener("pointerdown", (e) => {
      if ((e.target as Element).closest?.("a")) return; // links stay links
      cancelAnimationFrame(this.flight);
      if (this.onItemDown && down.size === 0 && e.isPrimary) {
        const r = this.el.getBoundingClientRect(), it = this.itemAt(e.clientX - r.left, e.clientY - r.top);
        if (it && this.onItemDown(it, e)) return;
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
    this.el.addEventListener("dblclick", (e) => {
      const r = this.el.getBoundingClientRect(), it = this.itemAt(e.clientX - r.left, e.clientY - r.top);
      const w = this.toWorld(e.clientX, e.clientY);
      if (this.onDoubleClick?.(it, w.x, w.y)) return;
      this.focus(it ? [it.id] : undefined);
    });
  }
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
