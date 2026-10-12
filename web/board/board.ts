// Boards (design/board.md), step 0: the renderer's core, measured.
//
// One container whose CSS transform is the camera holds the items' DOM;
// only the items near the viewport are mounted (a spatial grid finds them);
// far out, items are drawn on a canvas as colored rectangles with titles
// and no DOM at all; ink is on the canvas too, each stroke a cached Path2D.
// Panning and zooming change the transform (and redraw the canvas) once per
// animation frame; mounting follows only when the view has left the region
// mounted for it.

export interface Item {
  id: string;
  kind: "note" | "shape" | "ink";
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
}

export interface Camera {
  x: number; // world coordinates at the viewport's top left
  y: number;
  z: number; // zoom: screen pixels per world unit
}

const CELL = 512; // the spatial grid's cell, in world units
const FAR = 0.35; // below this zoom: rectangles on the canvas, no DOM
const MARGIN = 0.5; // mounted: the viewport plus this fraction around it

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
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private boxes = new Grid(); // notes and shapes
  private strokes = new Grid(); // ink
  private paths = new Map<string, Path2D>();
  private maxWidth = 0; // the widest stroke's width
  private mounted = new Map<string, HTMLElement>();
  private cache = new Map<string, HTMLElement>(); // rendered once, kept
  camera: Camera = { x: 0, y: 0, z: 1 };
  private frame = 0;
  private mountedFor: { x0: number; y0: number; x1: number; y1: number; far: boolean } | null = null;
  private dpr = Math.max(1, globalThis.devicePixelRatio || 1);
  /** counters, for the benchmark */
  stats = { frames: 0, mounts: 0, mounted: 0, drawn: 0 };

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "board";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "board-canvas";
    this.world = document.createElement("div");
    this.world.className = "board-world";
    this.el.append(this.canvas, this.world);
    parent.append(this.el);
    this.ctx = this.canvas.getContext("2d")!;
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.resize();
    this.input();
  }

  setItems(items: Item[]) {
    this.boxes = new Grid();
    this.strokes = new Grid();
    this.paths.clear();
    for (const m of this.mounted.values()) m.remove();
    this.mounted.clear();
    this.cache.clear();
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
    this.camera = c;
    this.request();
  }

  private request() {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }

  private resize() {
    const r = this.el.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.style.width = r.width + "px";
    this.canvas.style.height = r.height + "px";
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
    // mount what is near the view, when the view left what was mounted for
    const m = this.mountedFor;
    if (!m || m.far !== far || v.x0 < m.x0 || v.y0 < m.y0 || v.x1 > m.x1 || v.y1 > m.y1) {
      const mw = (v.x1 - v.x0) * MARGIN, mh = (v.y1 - v.y0) * MARGIN;
      const r = { x0: v.x0 - mw, y0: v.y0 - mh, x1: v.x1 + mw, y1: v.y1 + mh, far };
      this.mount(far ? new Set() : this.boxes.query(r.x0, r.y0, r.x1, r.y1, new Set()));
      this.mountedFor = r;
    }
    this.draw(v, far);
  }

  private mount(want: Set<Item>) {
    const ids = new Set([...want].map((it) => it.id));
    for (const [id, el] of this.mounted) {
      if (!ids.has(id)) {
        el.remove();
        this.mounted.delete(id);
      }
    }
    const frag = document.createDocumentFragment();
    for (const it of want) {
      if (this.mounted.has(it.id)) continue;
      let el = this.cache.get(it.id);
      if (!el) {
        el = this.itemEl(it);
        this.cache.set(it.id, el);
      }
      frag.append(el);
      this.mounted.set(it.id, el);
      this.stats.mounts++;
    }
    this.world.append(frag);
    this.stats.mounted = this.mounted.size;
  }

  private itemEl(it: Item): HTMLElement {
    const el = document.createElement("div");
    el.className = `board-item board-${it.kind}`;
    el.style.cssText = `left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.h}px;` + (it.color ? `--c:${it.color};` : "");
    if (it.title) {
      const h = document.createElement("b");
      h.textContent = it.title;
      el.append(h);
    }
    if (it.text) {
      const p = document.createElement("p");
      p.textContent = it.text;
      el.append(p);
    }
    return el;
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
      const inView = this.boxes.query(v.x0, v.y0, v.x1, v.y1, new Set());
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
        for (const it of inView) if (it.title && it.w * c.z > 40) ctx.fillText(it.title, it.x + 4 / c.z, it.y + 14 / c.z, it.w - 8 / c.z);
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

  // wheel: pan (zoom with Ctrl, as trackpads pinch); drag: pan
  private input() {
    this.el.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      if (e.ctrlKey) this.zoomAt(Math.exp(-e.deltaY / 200), e.clientX - r.left, e.clientY - r.top);
      else this.panBy(e.deltaX, e.deltaY);
    }, { passive: false });
    let last: { x: number; y: number } | null = null;
    this.el.addEventListener("pointerdown", (e) => { last = { x: e.clientX, y: e.clientY }; this.el.setPointerCapture(e.pointerId); });
    this.el.addEventListener("pointermove", (e) => {
      if (!last) return;
      this.panBy(last.x - e.clientX, last.y - e.clientY);
      last = { x: e.clientX, y: e.clientY };
    });
    this.el.addEventListener("pointerup", () => { last = null; });
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
