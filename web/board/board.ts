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

import { InkCapture, inkHit, inkOutline, inkPath } from "./ink";
import { iconEmoji } from "./stickers";
import { ICON_NAME, GROUP_PAD, GROUP_TITLE, refLabel, askOptions, type AskAnswer, type DocAsk } from "./doc";
import { answerProblem, scaleRange, ASK_LIMITS } from "./ask";

/** A page's backdrop (doc.ts BoardPage's slide and background). */
export interface Backdrop { slide?: { x: number; y: number; w: number; h: number }; color?: string; image?: string }

/** How a pen draws: its width, its color, and below 1 a highlighter's opacity. */
export interface InkStyle { size: number; color: string; opacity?: number }

/** Ink's color, unless a stroke says. */
export const INK = "#1d241a";

export interface Item {
  id: string;
  kind: "note" | "shape" | "ink" | "group" | "sticker";
  /** stickers: an emoji, or a CoCalc icon's name (drawn by the host, else as an emoji: stickers.ts) */
  emoji?: string;
  icon?: string;
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
  /** shown, not the page's own (a template's, under a page made from it): not picked, selected or dropped into */
  inert?: boolean;
  /** notes: Markdown shown only when zoomed in */
  detail?: string;
  /** a question (doc.ts DocAsk): its controls, in place of its text */
  ask?: DocAsk;
  /** notes: a link, shown at the note's foot */
  ref?: string;
  /** groups and notes: how deeply nested (groups are drawn outer first) */
  depth?: number;
  /** groups: where their members' positions are measured from */
  inner?: { x: number; y: number };
  /** groups: none in it (in Edit it says how to fill it, B3) */
  empty?: boolean;
  /** the group holding it */
  parent?: string;
  /** notes: an outline other than a rectangle (doc.ts's NoteShape) */
  shape?: string;
  /** code items (notes with code): the code, and where it is in the board's reading order (1, 2, ...) */
  code?: string;
  order?: number;
  /** code items: only the code's output shows */
  hideCode?: boolean;
  /** code items: its own language (doc.ts DocNote.mode), and the one it runs in when it is not the board's (shown, item 16) */
  mode?: string;
  lang?: string;
  /** notes: a picture (its name, size, and its address when not in this browser) */
  image?: { key: string; w: number; h: number; src?: string };
}

const LANG_NAMES: Record<string, string> = { python: "Python", sage: "Sage", magma: "Magma", matlab: "MATLAB" };
/** What an item's element shows. */
export type Content = Pick<Item, "kind" | "title" | "text" | "detail" | "ref" | "shape"> & Partial<Pick<Item, "id" | "code" | "order" | "hideCode" | "lang" | "image" | "inert" | "emoji" | "icon" | "color" | "ask">>;

/** Code items' engine (code.ts, through page.ts): their output, state and running. */
export interface CodeHost {
  /** a code item's code, highlighted in its language (its id says which) */
  highlight(src: string, id: string): string;
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
/** The least zoom a board opens at (its notes' 14 px text at 8.4 px): a larger board opens at it, from its start. */
export const LEGIBLE = 0.6;
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
  /** Items' elements are kept from one drawing to the next only within an
   * epoch: another document shown starts one (mount.ts), so its notes are
   * drawn, and their pictures counted, afresh (SEC-4DF-1). */
  epoch = 0;
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
  /** the item with a grip just outside its top left corner, which drags it
   * (Edit: the one selected, or the one being written, William's B2) */
  grip: string | null = null;
  /** the item with the control that adds another of its kind below it
   * (Edit: the one selected), and its kind's name ("Code", "Note"...),
   * William's item 7 */
  addSame: { id: string; label: string } | null = null;
  /** that control's look: a "+" just outside the item's top right corner,
   * across from the grip (`plus`), or a "+ Code" chip under its bottom
   * edge (`chip`) */
  addSameStyle: "plus" | "chip" = "plus";
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
  /** a question answered with its controls: its answer, or its note (the
   * reader's own words); null removes it.  None: questions shown read-only
   * (a version being looked at, a host that takes no answers). */
  onAnswer: ((id: string, patch: { answer?: AskAnswer | null; note?: string | null }) => void) | null = null;
  /** a CoCalc icon by its name, as the host draws it (stickers: none, an emoji close to it: stickers.ts) */
  icon: ((name: string) => Element | null) | null = null;
  /** where a picture's bytes are, by its name (images.ts) */
  imageUrl: ((name: string) => string | undefined) | null = null;
  /** The page's backdrop (mount.ts, from the page): a slide's card (white,
   * with a soft shadow: what Present shows), and a background color, on
   * the card or, without one, behind the whole board; a picture covers the
   * card (only a slide has one: a board without edges has nothing to cover). */
  backdrop: Backdrop | null = null;
  private backImage: { name: string; img: HTMLImageElement } | null = null;
  /** a press on an item (not a link): return true to take it (the board does not pan) */
  onItemDown: ((it: Item, e: PointerEvent) => boolean) | null = null;
  /** A link to a place on the board (`#…`): the words it shows (its page's or item's title), or null. */
  linkLabel: ((ref: string) => string | null) | null = null;
  /** Drawing (the Draw tool): the pen's style, asked at each press (null:
   * the press doesn't draw); a stroke drawn, its points as InkCapture keeps them */
  pen: (() => InkStyle | null) | null = null;
  onStroke: ((points: number[], style: InkStyle) => void) | null = null;
  /** Erasing (the Erase tool): asked at each press; the strokes a drag went across */
  eraser: (() => boolean) | null = null;
  onErase: ((ids: string[]) => void) | null = null;
  /** a pen (not a finger) has drawn on this board: from then on a finger
   * pans, so the palm resting on the screen while writing draws nothing */
  penSeen = false;
  private live: { id: number; touch: boolean; cap: InkCapture; style: InkStyle } | null = null;
  private erased: { id: number; touch: boolean; ids: Set<string> } | null = null;
  /** a double click: on an item, or (null) on the background at world (x, y); return true when handled */
  onDoubleClick: ((it: Item | null, x: number, y: number) => boolean) | null = null;
  /** a press, or a double click, on an edge (not over a note): return true to take it */
  onEdgeDown: ((e: Edge, ev: PointerEvent) => boolean) | null = null;
  /** A second finger came while the first drags or resizes an item (edit.ts):
   * that dropped, true if there was one; the two fingers then pinch. */
  onTouchJoin: (() => boolean) | null = null;
  onEdgeDoubleClick: ((e: Edge) => boolean) | null = null;
  /** an edge drawn selected, and a group outlined as where a dragged item would go */
  selectedEdge: string | null = null;
  dropTarget: string | null = null;
  private selection = new Set<string>();
  private foundId: string | null = null; // (the item Find shows, outlined)
  private revealed: string | null = null; // (a group whose whole title is shown: a click on its title's band, UI-0CC-2)
  private titleRects = new Map<string, { x0: number; y0: number; x1: number; y1: number }>(); // (far out, where groups' titles were drawn)
  /** A click on a group's title band (or elsewhere: null), for the host to reveal it, or not, in reading. */
  onTitleClick: ((id: string | null) => void) | null = null;
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
  /** The board's size changed (a phone turned, full screen): its canvas, and so cameraFor(), already the new size. */
  onResize: (() => void) | null = null;
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
      // (being edited: kept whatever it now shows, as tall as its fields; not
      // into another document's epoch, CORR-A48-4: no longer edited)
      if (el && it.id === this.editingId && !el.dataset.key?.startsWith(this.epoch + "[")) { this.editingId = null; this.editingEl = null; }
      else if (el && it.id === this.editingId) {
        el.style.cssText = placement(it) + `height:auto;min-height:${+it.h}px;`;
        this.cache.set(it.id, el);
      } else if (el && el.dataset.key === this.epoch + this.keyOf(it)) {
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

  /** How many times the camera has been told to move (zoomAt, panBy,
   * setCamera, flyTo; a flight counts once, when asked for, before its first
   * frame): whoever moved it last can tell whether anyone has since. */
  moves = 0;

  /** Zoom by `factor`, keeping the screen point (sx, sy) where it is (a flight under way stops). */
  zoomAt(factor: number, sx: number, sy: number) {
    this.moves++;
    cancelAnimationFrame(this.flight);
    const c = this.camera, z = Math.min(8, Math.max(0.02, c.z * factor));
    const wx = c.x + sx / c.z, wy = c.y + sy / c.z;
    this.camera = { x: wx - sx / z, y: wy - sy / z, z };
    this.request();
  }
  panBy(dx: number, dy: number) {
    this.moves++;
    cancelAnimationFrame(this.flight);
    this.camera = { ...this.camera, x: this.camera.x + dx / this.camera.z, y: this.camera.y + dy / this.camera.z };
    this.request();
  }
  setCamera(c: Camera) {
    this.moves++;
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

  /** Keep item `id` clear of the bars over the board (the insets: the top
   * bar, the tour's caption): moved up just enough that its bottom is above
   * the caption, never so far that its top goes under the top bar; its
   * zoom kept.  For a card grown under the caption (a question's feedback).
   * `bottom`: what it now shows at its bottom is what matters (the options
   * to choose from, William Oct 17): its bottom above the caption even if
   * its top then goes under the top bar. */
  keepClear(id: string, bottom = false) {
    const it = this.byId.get(id);
    if (!it) return;
    const H = this.canvas.height / this.dpr, i = this.insets, c = this.camera, m = 8;
    const below = (it.y + it.h - c.y) * c.z - (H - i.bottom - m), room = (it.y - c.y) * c.z - (i.top + m);
    const dy = bottom ? below : Math.min(below, room);
    if (below > 0 && dy > 0) this.flyTo({ ...c, y: c.y + dy / c.z });
  }

  /** Item `id` within the clear part of the view (between the bars over
   * the board), the board moved as little as that takes; its zoom kept. */
  bringIntoView(id: string) {
    const it = this.byId.get(id);
    if (!it) return;
    const W = this.canvas.width / this.dpr, H = this.canvas.height / this.dpr, i = this.insets, c = this.camera, m = 24;
    const l = (it.x - c.x) * c.z, t = (it.y - c.y) * c.z, r = l + it.w * c.z, b = t + it.h * c.z;
    let dx = 0, dy = 0;
    if (r > W - i.right - m) dx = r - (W - i.right - m);
    if (l - dx < i.left + m) dx = l - (i.left + m);
    if (b > H - i.bottom - m) dy = b - (H - i.bottom - m);
    if (t - dy < i.top + m) dy = t - (i.top + m);
    if (dx || dy) this.flyTo({ ...c, x: c.x + dx / c.z, y: c.y + dy / c.z });
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

  /** The board as it opens: all of it, or, when that would make its notes'
   * text too small to read (a zoom under LEGIBLE), at that zoom, centered
   * along an axis it fits, else from its start (its left, its top): the rest
   * a scroll away (friction 6, 12); smoothly unless `now`. */
  overview(now = false) {
    const b = this.bounds();
    if (!b) return;
    let c = this.cameraFor(b.x0, b.y0, b.x1, b.y1, 1.5);
    if (c.z < LEGIBLE) {
      const W = this.canvas.width / this.dpr, H = this.canvas.height / this.dpr, i = this.insets, z = LEGIBLE;
      const w = Math.max(50, W - i.left - i.right), h = Math.max(50, H - i.top - i.bottom), m = Math.min(32, w / 12);
      const at = (lo: number, hi: number, start: number, room: number) => ((hi - lo) * z <= room - 2 * m ? (lo + hi) / 2 - (start + room / 2) / z : lo - (start + m) / z);
      c = { x: at(b.x0, b.x1, i.left, w), y: at(b.y0, b.y1, i.top, h), z };
    }
    if (now) this.setCamera(c);
    else this.flyTo(c);
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
    this.moves++;
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
    this.onResize?.();
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
      el.classList.toggle("found", it.id === this.foundId);
      el.classList.toggle("reveal", it.id === this.revealed);
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
    el.dataset.key = this.epoch + this.keyOf(it);
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

  // a sticker's element: its icon (the host's element, as given; or an emoji
  // close to it; or a mark named by its tooltip), or its emoji; no frame
  private sticker(it: Content): HTMLElement {
    const el = document.createElement("div");
    el.className = "board-item board-sticker" + (it.inert ? " board-inert" : "");
    const drawn = it.icon && ICON_NAME.test(it.icon) ? this.icon?.(it.icon) : null;
    if (drawn) {
      el.append(drawn);
    } else {
      const g = document.createElement("span");
      g.className = "board-sticker-glyph";
      g.textContent = it.emoji || (it.icon && iconEmoji(it.icon)) || "●";
      if (!it.emoji && it.icon && !iconEmoji(it.icon) && it.color) g.style.color = it.color;
      el.append(g);
    }
    if (it.icon) el.title = it.icon;
    return el;
  }

  // (an item's content as drawn: a question's whole definition, and whether it
  // can be answered now, CORR-448-1, CORR-448-3)
  private keyOf(it: Item): string {
    return contentKey(it) + (it.ask ? "\u0000" + JSON.stringify([it.ask, this.askFeedback.get(this.askScope + it.ask.id) ?? null, !!this.onCheck, this.askDecided.get(this.askScope + it.ask.id) ?? null, !!this.onDecide]) + (this.onAnswer ? "+" : "-") : "");
  }
  /** Ask the host which of a question's `decide` options the reader's words show (mount.ts); none: no host to ask. */
  onDecide: ((id: string, words: string) => void) | null = null;
  /** The reader chose among a question's options, or asked for them again (mount.ts binds it to the question as it is). */
  onChoose: ((id: string) => void) | null = null;
  private askFocus: string | null = null; // (a question whose own words get the focus when it is next drawn)
  /** What the host decided each question's words show (mount.ts): `pending` while it is asked; `option` a name of its decide, or null for none; `refused`, why it couldn't. */
  askDecided = new Map<string, { pending?: boolean; option?: string | null; refused?: string; list?: boolean; chosen?: string }>();  // (and the reader's answer to it: `list`, No pressed; `chosen`, the option they confirmed or chose, "" their own words)
  /** The page shown, as askDecided's keys begin with it ("p2/"): a question's id is its page's own (CORR-B21-2). */
  askScope = "";

  // The reader's words decided among the question's options: the host
  // proposes, the reader confirms (William, Oct 17).  A button asks the host;
  // the option it proposes is shown with Yes and No: Yes goes on to that
  // option's next step, No shows every option and "Something else", in the
  // reader's own words.  With no option proposed (none matched, the host
  // couldn't say) or no host to ask, the options show at once.
  private askDecideEl(a: DocAsk, id: string, words: () => string, own: () => void): HTMLElement {
    const box = document.createElement("div");
    box.className = "board-ask-decide";
    const key = this.askScope + id, fb = this.askDecided.get(key), opts = a.decide ?? [];
    // (the reader's answer, kept with the host's: drawn again with it)
    const answer = (patch: { list?: boolean; chosen?: string | undefined }) => {
      const cur = this.askDecided.get(key) ?? {};
      if (!this.askDecided.has(key)) this.askDecided.set(key, cur);
      Object.assign(cur, patch);
      this.onChoose?.(id);
      this.onAskResize?.(id, true, true);
    };
    // (an option with no `about`: its name as words, a sentence's capital first)
    const label = (o: { name: string; about?: string }) => o.about ?? o.name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
    const stop = (el: HTMLElement) => { for (const t of ["pointerdown", "mousedown", "dblclick", "click", "keydown"]) el.addEventListener(t, (e) => e.stopPropagation()); return el; };
    const md = (src: string) => { const d = document.createElement("div"); d.className = "board-text board-ask-message"; if (this.markdown) d.innerHTML = this.markdown(src); else d.textContent = src; glueMath(d); box.append(d); return d; };
    const esc = (s: string) => s.trim().replace(/[\\`*_[\]<>#!|~$]/g, "\\$&");
    // (a choice: a link to its option's next step, if it has one, else a button)
    const choice = (text: string, name: string, next: string | undefined, cls: string, rich = false) => {
      const c = next ? Object.assign(document.createElement("a"), { href: "#" + next }) : Object.assign(document.createElement("button"), { type: "button" });
      c.className = cls;
      // (where it goes, said: the item's title or first line, never its id)
      if (next) c.title = "→ " + (this.linkLabel?.("#" + next) ?? "Go to the next step");
      // (an option's words are the board's Markdown, math too, as the question's own)
      if (rich && this.markdown) { const l = document.createElement("span"); l.className = "board-ask-label"; l.innerHTML = this.markdown(text); glueMath(l); c.append(l); }
      else c.textContent = text;
      c.addEventListener("click", () => answer({ chosen: name, list: false }));
      return c;
    };
    if (this.onDecide) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "board-ask-check";
      b.textContent = fb?.pending ? "Asking…" : "Get feedback on my words";
      b.title = "Asks which of the ideas this question looks for your words show (your words aren't sent to whoever made the board until you submit)";
      b.disabled = !!fb?.pending;
      const why = document.createElement("span");
      why.className = "board-ask-why";
      b.onclick = () => {
        const v = words();
        if (!v.trim()) { why.textContent = "Write something in your own words first"; return; }
        if (v.length > ASK_LIMITS.text) { why.textContent = `Longer than ${ASK_LIMITS.text} characters`; return; }
        this.onDecide?.(id, v);
      };
      const row = document.createElement("div");
      row.className = "board-ask-foot";
      row.append(b, why);
      box.append(stop(row));
    }
    if (fb?.pending) return box;
    const chosen = fb?.chosen !== undefined ? (fb.chosen === "" ? null : opts.find((o) => o.name === fb.chosen)) : undefined;
    // (chosen: said, with its next step; a way to choose again)
    if (chosen !== undefined) {
      md(chosen ? `**You chose:** ${label(chosen)}` : "**Something else:** your own words stand. Submit them, and they reach whoever made the board.");
      const row = document.createElement("div");
      row.className = "board-ask-foot";
      if (chosen?.next) row.append(choice("→ " + (this.linkLabel?.("#" + chosen.next) ?? "Go to the next step"), chosen.name, chosen.next, "board-ref"));
      const again = Object.assign(document.createElement("button"), { type: "button", className: "board-ask-clear", textContent: "Choose again" });
      again.onclick = () => answer({ chosen: undefined, list: true });
      row.append(again);
      box.append(stop(row));
      return box;
    }
    const proposed = typeof fb?.option === "string" ? opts.find((o) => o.name === fb.option) : undefined;
    if (proposed && !fb?.list) {
      md(`**Your words suggest:** ${label(proposed)}\n\nIs that what you meant?`);
      const row = document.createElement("div");
      row.className = "board-ask-yesno";
      const no = Object.assign(document.createElement("button"), { type: "button", className: "board-ask-no", textContent: "No" });
      no.onclick = () => answer({ list: true });
      row.append(choice("Yes", proposed.name, proposed.next, "board-ask-yes"), no);
      box.append(stop(row));
      return box;
    }
    // (every option, and the reader's own words)
    if (fb?.refused !== undefined) md(`**Couldn't get feedback:** ${esc(fb.refused)}${/[.!?]$/.test(fb.refused.trim()) ? "" : "."} Choose what is closest yourself:`);
    else if (fb?.option === null) md("Your words didn't match any of the ideas this question looks for. Which is closest to what you mean?");
    else if (proposed) md("Then which is closest to what you mean?");
    // (asked for again, Choose again, whatever the host said before, or nothing: astra's UI-E29-1)
    else if (!this.onDecide || fb?.list) md("Which is closest to what you mean?");
    else return box;
    const list = document.createElement("div");
    list.className = "board-ask-choices";
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", "Which is closest to what you mean?");
    for (const o of opts) list.append(choice(label(o), o.name, o.next, "board-ask-choice", true));
    const mine = Object.assign(document.createElement("button"), { type: "button", className: "board-ask-choice board-ask-own", textContent: "Something else: in my own words" });
    mine.onclick = () => { own(); answer({ chosen: "", list: false }); };
    list.append(mine);
    box.append(stop(list));
    return box;
  }
  /** A question's answer checked by its check (mount.ts): the answer the controls hold. None: no Check (no interpreter). */
  onCheck: ((id: string, answer: AskAnswer) => void) | null = null;
  /** What the last check of each question said, and its hints so far, rendered (mount.ts); `pending` while it runs. */
  askFeedback = new Map<string, { pending?: boolean; message?: string | null; hints?: (string | null)[] }>();  // (by page and question, askScope + id)

  private askCheckEl(a: DocAsk, id: string, current: () => AskAnswer | undefined, can: boolean): HTMLElement {
    const box = document.createElement("div");
    box.className = "board-ask-checked";
    const fb = this.askFeedback.get(this.askScope + id);
    if (can && this.onCheck) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "board-ask-check";
      b.textContent = fb?.pending ? "Checking…" : "Check";
      b.disabled = !!fb?.pending;
      // (pressed with a field still being written: the field keeps its focus, so
      // its answer isn't saved, and the card drawn again, under the press; the
      // check keeps the answer it checks)
      b.onmousedown = (e) => e.preventDefault();
      const why = document.createElement("span");
      why.className = "board-ask-why";
      b.onclick = () => {
        const v = current();
        if (v === undefined) { why.textContent = "Answer first, then check"; return; }
        const bad = answerProblem(a, v);
        if (bad) { why.textContent = bad.replace(/^its answer/, "The answer"); return; }
        this.onCheck?.(id, v);
      };
      const row = document.createElement("div");
      row.className = "board-ask-foot";
      row.append(b, why);
      for (const t of ["pointerdown", "mousedown", "dblclick", "click", "keydown"]) row.addEventListener(t, (e) => e.stopPropagation());
      box.append(row);
    }
    // the verdict, as the board keeps it; the check's own words, while shown
    const md = (src: string, cls: string) => { const d = document.createElement("div"); d.className = cls; if (this.markdown) d.innerHTML = this.markdown(src); else d.textContent = src; glueMath(d); box.append(d); return d; };
    if (a.result) {
      const v = document.createElement("div");
      v.className = "board-ask-result board-ask-" + a.result;
      v.textContent = a.result === "right" ? "✓ Right" : a.result === "wrong" ? "✗ Not yet" : "The check could not decide";
      box.append(v);
      if (fb?.message) md(fb.message, "board-text board-ask-message");
    }
    // the hints: one more after each wrong attempt (a computed one once Check has run it)
    // (one hint for each wrong attempt: a right one reveals none, CORR-A19-5)
    const wrong = a.wrongAttempts ?? 0;
    (a.hints ?? []).slice(0, Math.min(wrong, ASK_LIMITS.hints)).forEach((h, k) => {
      const shown = typeof h === "string" ? h : fb?.hints?.[k] ?? null;
      md(shown === null ? "_A hint from your answer: press Check to see it._" : `**Hint ${k + 1}.** ${shown}`, "board-text board-ask-hint");
    });
    // where to go now
    const to = a.result === "right" ? a.next?.right : a.result === "wrong" ? a.next?.wrong : undefined;
    if (to) {
      const l = document.createElement("a");
      l.className = "board-ref";
      l.href = "#" + to;
      l.textContent = "→ " + (this.linkLabel?.("#" + to) ?? "Go to the next step");
      box.append(l);
    }
    return box;
  }

  /** Questions whose "In your own words" is open (kept open as the board is drawn again). */
  askOpen = new Set<string>();
  /** Questions grown past their measured height: as tall as their open field, its preview, or a field made taller by hand needs. */
  askGrown = new Map<string, number>();
  /** A question's card needs another height: lay out again (mount.ts). */
  onAskResize: ((id: string, grown: boolean, bottom?: boolean) => void) | null = null;

  /** A question's controls (doc.ts DocAsk), each answer given at once to
   * onAnswer: a choice when it is made, a text or a number when it is left
   * (change); the reader's own words, offered on every question, in a field
   * of their own.  Without onAnswer, the same controls, disabled. */
  private askEl(a: DocAsk, id: string): HTMLElement {
    const box = document.createElement("div");
    box.className = "board-ask";
    box.dataset.ask = id;
    const can = !!this.onAnswer, set = (patch: { answer?: AskAnswer | null; note?: string | null }) => this.onAnswer?.(id, patch);
    const mdInto = (el: HTMLElement, src: string) => { if (this.markdown) el.innerHTML = this.markdown(src); else el.textContent = src; glueMath(el); };
    if (a.text) { const q = document.createElement("div"); q.className = "board-text board-ask-q"; mdInto(q, a.text); box.append(q); }
    // (each control: its events kept from the board, which would take them as a press on the note)
    const quiet = (el: HTMLElement) => { for (const t of ["pointerdown", "mousedown", "dblclick", "click", "keydown", "wheel"]) el.addEventListener(t, (e) => e.stopPropagation()); return el; };
    const name = `sbq-${id}-${++askSerial}`, ans = a.answer;
    // (its card as tall as it now needs: an open field, a preview, a field made taller by hand, UI-448-2)
    let growing = 0;
    const grow = () => {
      cancelAnimationFrame(growing);
      growing = requestAnimationFrame(() => {
        const card = box.closest<HTMLElement>(".board-item");
        if (!card || !card.isConnected) return;
        const need = card.scrollHeight + (card.offsetHeight - card.clientHeight);
        if (need > card.offsetHeight + 1) { this.askGrown.set(id, need); this.onAskResize?.(id, true); }
      });
    };
    // (a text with math in it: shown typeset under its field as it is typed,
    // a moment after the typing stops; past the length an answer may have,
    // not shown, and said, HARD-448-1)
    const preview = (f: HTMLInputElement | HTMLTextAreaElement) => {
      const pv = document.createElement("div");
      pv.className = "board-ask-preview board-text";
      let soon = 0;
      const show = () => {
        if (f.value.length > ASK_LIMITS.text) { pv.hidden = false; pv.textContent = `Longer than ${ASK_LIMITS.text} characters: not kept`; grow(); return; }
        pv.hidden = !/\$[^$]+\$/.test(f.value);
        if (pv.hidden) return;
        mdInto(pv, f.value);
        if (pv.isConnected) { this.typeset?.(pv); grow(); }
      };
      f.addEventListener("input", () => { clearTimeout(soon); soon = window.setTimeout(show, 200); });
      f.addEventListener("mouseup", grow);
      show();
      return pv;
    };
    // (a text kept only within the length an answer may have)
    const within = (v: string) => v.length <= ASK_LIMITS.text;
    const row = (control: HTMLInputElement, label: string) => {
      const l = document.createElement("label");
      l.className = "board-ask-opt";
      const t = document.createElement("span");
      t.className = "board-ask-label";
      mdInto(t, label);
      l.append(control, t);
      return l;
    };
    const opts = askOptions(a);
    // (the answer the controls hold now, saved or not: what Check checks)
    let current: () => AskAnswer | undefined = () => ans;
    if (a.input === "check" || a.input === "radio" || a.input === "choice") {
      const list = document.createElement("div");
      list.className = "board-ask-opts" + (a.input === "choice" ? " board-ask-list" : "");
      list.setAttribute("role", a.input === "check" ? "group" : "radiogroup");
      if (a.input === "check" && !opts.length) {
        const c = document.createElement("input");
        c.type = "checkbox";
        c.name = name;
        c.checked = ans === true;
        c.disabled = !can;
        c.onchange = () => set({ answer: c.checked });
        current = () => c.checked;
        list.append(row(c, "Yes"));
      } else {
        const chosen = new Set(Array.isArray(ans) ? ans : typeof ans === "string" ? [ans] : []);
        const inputs: HTMLInputElement[] = [];
        for (const o of opts) {
          const c = document.createElement("input");
          c.type = a.input === "check" ? "checkbox" : "radio";
          c.name = name;
          c.value = o.value;
          c.checked = chosen.has(o.value);
          c.disabled = !can;
          c.onchange = () => set({ answer: a.input === "check" ? inputs.filter((x) => x.checked).map((x) => x.value) : c.value });
          inputs.push(c);
          list.append(row(c, o.label));
        }
        current = () => (a.input === "check" ? inputs.filter((x) => x.checked).map((x) => x.value) : inputs.find((x) => x.checked)?.value);
      }
      box.append(quiet(list));
    } else if (a.input === "text") {
      const t = a.lines && a.lines > 1 ? document.createElement("textarea") : document.createElement("input");
      if (t instanceof HTMLTextAreaElement) t.rows = Math.min(a.lines ?? 1, 50);
      t.className = "board-ask-text";
      t.value = typeof ans === "string" ? ans : "";
      t.disabled = !can;
      t.placeholder = "Your answer";
      t.onchange = () => { if (within(t.value)) set({ answer: t.value === "" ? null : t.value }); };
      current = () => (t.value === "" || !within(t.value) ? undefined : t.value);
      box.append(quiet(t), preview(t));
    } else {
      const [lo, hi] = a.input === "scale" ? scaleRange(a) : [a.min, a.max];
      // (buttons for a short scale of safe whole numbers, counted, never stepped by a value that may not advance, CORR-448-4)
      if (a.input === "scale" && Number.isSafeInteger(lo) && Number.isSafeInteger(hi) && hi! >= lo! && hi! - lo! <= 10) {
        const bar = document.createElement("div");
        bar.className = "board-ask-scale";
        bar.setAttribute("role", "radiogroup");
        if (a.low) { const s = document.createElement("span"); s.className = "board-ask-end"; s.textContent = a.low; bar.append(s); }
        for (let k = 0; k <= hi! - lo!; k++) {
          const v = lo! + k;
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = String(v);
          b.setAttribute("role", "radio");
          b.setAttribute("aria-checked", String(ans === v));
          b.disabled = !can;
          b.onclick = () => set({ answer: ans === v ? null : v });
          bar.append(b);
        }
        if (a.high) { const s = document.createElement("span"); s.className = "board-ask-end"; s.textContent = a.high; bar.append(s); }
        box.append(quiet(bar));
      } else {
        const n = document.createElement("input");
        n.type = "number";
        n.className = "board-ask-number";
        if (lo !== undefined) n.min = String(lo);
        if (hi !== undefined) n.max = String(hi);
        n.step = a.step !== undefined ? String(a.step) : a.input === "scale" ? "1" : "any";
        n.value = typeof ans === "number" ? String(ans) : "";
        n.disabled = !can;
        n.placeholder = lo !== undefined && hi !== undefined ? `${lo} to ${hi}` : "A number";
        const why = document.createElement("div");
        why.className = "board-ask-why";
        why.setAttribute("role", "alert");
        // (a number it doesn't take: said here, not kept)
        n.onchange = () => {
          if (n.value.trim() === "") { why.textContent = ""; set({ answer: null }); return; }
          const v = Number(n.value), bad = Number.isFinite(v) ? answerProblem(a, v) : "its answer is a finite number";
          why.textContent = bad ? bad.replace(/^its answer/, "The answer") : "";
          if (!bad) set({ answer: v });
        };
        current = () => { const v = Number(n.value); return n.value.trim() === "" || !Number.isFinite(v) ? undefined : v; };
        box.append(quiet(n), why);
      }
    }
    // the reader's own words: on every question, open when there are some
    const words = document.createElement("details");
    words.className = "board-ask-words";
    words.open = !!a.note || this.askOpen.has(id);
    words.ontoggle = () => {
      if (words.open) { this.askOpen.add(id); grow(); }
      else if (this.askOpen.delete(id)) { this.askGrown.delete(id); this.onAskResize?.(id, false); }
    };
    const sum = document.createElement("summary");
    sum.textContent = "In your own words";
    const w = document.createElement("textarea");
    w.className = "board-ask-text";
    w.rows = 2;
    w.value = a.note ?? "";
    w.disabled = !can;
    w.placeholder = "Answer in your own words, if the choices don't fit (or to add something)";
    w.onchange = () => { if (within(w.value)) set({ note: w.value.trim() === "" ? null : w.value }); };
    words.append(sum, w, preview(w));
    // (the card may be drawn more than once as it grows: the one still shown takes it)
    if (this.askFocus === id) requestAnimationFrame(() => { if (w.isConnected && this.askFocus === id) { this.askFocus = null; w.focus({ preventScroll: true }); } });
    box.append(quiet(words));
    // (what the words show, asked of the host when the reader asks: the note's words, or a text question's answer)
    if (can && a.decide?.length) {
      const text = current;
      // ("Something else": the reader's own words, open and focused once the card is drawn again)
      box.append(this.askDecideEl(a, id, () => (w.value.trim() ? w.value : a.input === "text" ? String(text() ?? "") : ""), () => { this.askOpen.add(id); this.askFocus = id; }));
    }
    // its check: a button, then the verdict, the check's words, the hints
    // so far and where to go next (stream 5: teaching boards)
    if (a.check !== undefined) box.append(this.askCheckEl(a, id, current, can));
    // (its state: required; and a way to take an answer back)
    const foot = document.createElement("div");
    foot.className = "board-ask-foot";
    if (a.required) { const r = document.createElement("span"); r.className = "board-ask-req"; r.textContent = "required"; foot.append(r); }
    if (can && ans !== undefined) {
      const c = document.createElement("button");
      c.type = "button";
      c.className = "board-ask-clear";
      c.textContent = "Clear the answer";
      c.onclick = () => set({ answer: null });
      foot.append(quiet(c));
    }
    if (foot.childNodes.length) box.append(foot);
    return box;
  }

  /** An item's element, unplaced (also for measuring a note's height at a width: `now`, math typeset at once). */
  content(it: Content, now = false): HTMLElement {
    if (it.kind === "sticker") return this.sticker(it);
    const el = document.createElement("div");
    el.className = `board-item board-${it.kind}` + (it.shape && it.shape !== "rect" ? ` board-shape board-shape-${it.shape}` : it.shape ? " board-shape" : "") + (it.code !== undefined ? " board-code" : "") + (it.inert ? " board-inert" : "");
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
        run.setAttribute("aria-label", "Run");
        run.onclick = (e) => { e.stopPropagation(); this.code?.run(id); };
        head.append(run);
      }
      if (it.title) head.append(titleEl(it.title));
      // (a language not the board's: said, so that a reader isn't misled, item 16)
      if (it.lang) {
        const b = document.createElement("span"), name = LANG_NAMES[it.lang] ?? it.lang;
        b.className = "board-lang";
        b.textContent = name;
        b.title = `This item's code is ${name}, not the board's language; it shares no names with the board's other languages`;
        head.append(b);
      }
      if (this.onToggleCode && it.id) {
        const id = it.id, t = document.createElement("button");
        t.className = "board-code-toggle" + (it.hideCode ? " off" : "");
        t.textContent = "{ }";
        t.title = it.hideCode ? "Show the code" : "Hide the code (its output stays)";
        t.setAttribute("aria-pressed", String(!it.hideCode));
        t.setAttribute("aria-label", "Show the code");
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
      glueMath(d);
      el.append(d);
    };
    // (a question: its text, its controls and a field for the reader's own words, in place of its text as Markdown)
    if (it.ask && it.id) el.append(this.askEl(it.ask, it.id));
    else if (it.text) md(it.text, "board-text");
    if (it.code !== undefined) {
      if (!it.hideCode) {
        const pre = document.createElement("pre");
        pre.className = "sbnb board-code-src"; // (the notebook's colors for code)
        if (this.code) pre.innerHTML = this.code.highlight(it.code, it.id ?? "");
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
    // (a note with nothing in it, kept to be written in later: in Edit it says so, B2)
    if (it.kind === "note" && !it.title && !it.text && !it.image && it.code === undefined && !it.detail && !it.ref) {
      const e = document.createElement("div");
      e.className = "board-empty";
      e.setAttribute("aria-hidden", "true");
      e.textContent = "Empty note: double-click to write";
      el.append(e);
    }
    // (a place on the board: its page's or item's title, round 0's 15; the host goes there)
    if (it.ref?.startsWith("#")) {
      const a = document.createElement("a");
      a.className = "board-ref";
      a.href = it.ref;
      a.textContent = "→ " + (this.linkLabel?.(it.ref) ?? it.ref.slice(1));
      el.append(a);
    } else if (it.ref && /^https?:\/\//i.test(it.ref)) {
      const a = document.createElement("a");
      a.className = "board-ref";
      a.href = it.ref;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "↗ " + refLabel(it.ref);
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

  /** Notes' heights at their widths (or, `width`, the widths their text needs, at most `w`), as measure() and measureWidth() give them, all read after one layout. */
  measureMany(list: { it: Content; w: number; width?: boolean }[]): number[] {
    const els = list.map(({ it, w, width }) => {
      const el = this.content(it, true);
      el.style.cssText = width ? `left:0;top:0;width:max-content;max-width:${w}px;visibility:hidden;` : `left:0;top:0;width:${w}px;visibility:hidden;`;
      el.classList.add("board-measure");
      return el;
    });
    this.world.append(...els);
    const out = els.map((el, i) => (list[i].width ? el.offsetWidth + 1 : el.offsetHeight));
    for (const el of els) el.remove();
    return out;
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

  // the page's backdrop: the slide's card, its background color and picture
  private drawBackdrop(ctx: CanvasRenderingContext2D, v: { x0: number; y0: number; x1: number; y1: number }) {
    const b = this.backdrop, s = b?.slide;
    if (!b) return;
    if (s) {
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, .18)";
      ctx.shadowBlur = 12 * this.dpr;
      ctx.shadowOffsetY = 2 * this.dpr;
      ctx.fillStyle = "#fff";
      ctx.fillRect(s.x, s.y, s.w, s.h);
      ctx.restore();
    }
    const r = s ?? { x: v.x0, y: v.y0, w: v.x1 - v.x0, h: v.y1 - v.y0 };
    if (b.color) {
      ctx.fillStyle = b.color;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    // (a picture, once loaded: covering the card, cut to it)
    const url = s && b.image ? this.imageUrl?.(b.image) : undefined;
    if (!url || !s) return;
    if (this.backImage?.name !== b.image + "\n" + url) {
      const img = new Image();
      img.onload = () => this.request();
      img.src = url;
      this.backImage = { name: b.image + "\n" + url, img };
    }
    const img = this.backImage!.img;
    if (!img.complete || !img.naturalWidth) return;
    const k = Math.max(s.w / img.naturalWidth, s.h / img.naturalHeight), w = img.naturalWidth * k, h = img.naturalHeight * k;
    ctx.save();
    ctx.beginPath();
    ctx.rect(s.x, s.y, s.w, s.h);
    ctx.clip();
    ctx.drawImage(img, s.x + (s.w - w) / 2, s.y + (s.h - h) / 2, w, h);
    ctx.restore();
  }

  // behind the notes: groups (outer first) and edges
  private drawBack(v: { x0: number; y0: number; x1: number; y1: number }, far: boolean) {
    const ctx = this.bctx, c = this.camera, d = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.back.width, this.back.height);
    ctx.setTransform(c.z * d, 0, 0, c.z * d, -c.x * c.z * d, -c.y * c.z * d);
    this.drawBackdrop(ctx, v);
    if (!this.edges.length && !this.byId.size) return;
    const groups = [...this.boxes.query(v.x0, v.y0, v.x1, v.y1, new Set())].filter((it) => it.kind === "group").sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));
    for (const g of groups) {
      ctx.beginPath();
      ctx.roundRect(g.x, g.y, g.w, g.h, 14);
      ctx.fillStyle = g.color ?? GROUP;
      ctx.fill();
      ctx.lineWidth = (g.id === this.dropTarget ? 3 : 1) / c.z;
      ctx.strokeStyle = g.id === this.dropTarget ? "#2a6f2f" : "rgba(0,0,0,.18)";
      ctx.stroke();
      // (an empty group, in Edit: how to fill it, B3)
      if (g.empty && !far && this.el.classList.contains("editing")) {
        ctx.fillStyle = "#8a8f99";
        ctx.font = "italic 14px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Empty group: drag items into it", g.x + g.w / 2, g.y + g.h / 2);
        ctx.textAlign = "start";
      }
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
    // (near, no title is drawn on the canvas: none to hover there)
    if (!far) this.titleRects.clear();
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
        // (a sticker's emoji: drawn itself)
        if (it.kind === "sticker") {
          ctx.font = `${it.h * 0.8}px system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = it.color ?? INK;
          ctx.fillText(it.emoji || (it.icon && iconEmoji(it.icon)) || "●", it.x + it.w / 2, it.y + it.h / 2);
          continue;
        }
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
      // groups' titles, never over their members (friction 10 and 11: a
      // title was sized by its group's width, drawn over its members, and
      // left out when long or around other groups; astra's UI-0CC-1):
      // - in the band above its members the layout keeps for it, at one size
      //   for each level of nesting (16, 14, then 13 pixels on screen),
      //   smaller as that band is on screen, down to 10 pixels;
      // - the band smaller than that, above the group, at 10 pixels, where
      //   nothing else is (an item, or a title drawn);
      // - else not drawn: the band's tooltip, a click on it, and Find show it;
      // cut with "…" to the group's width, with a halo; the group revealed
      // (a click on its band, or Find's), its whole title on a plate.
      const groups = [...this.boxes.query(v.x0, v.y0, v.x1, v.y1, new Set())].filter((it) => it.kind === "group" && it.title).sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));
      ctx.lineJoin = "round";
      const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
      const holds = (a: Item, g: Item) => a.kind === "group" && a.x <= g.x && a.y <= g.y && a.x + a.w >= g.x + g.w && a.y + a.h >= g.y + g.h;
      this.titleRects.clear();
      for (const g of groups) {
        const whole = g.id === this.revealed || g.id === this.foundId, full = plainTitle(g.title!);
        const band = ((g.inner?.y ?? g.y + GROUP_PAD + GROUP_TITLE) - g.y) * c.z;
        let px = Math.min([16, 14][g.depth ?? 0] ?? 13, band - 6), top = g.y;
        if (px < 10) px = 10;
        ctx.font = `600 ${px / c.z}px system-ui, sans-serif`;
        const title = whole ? full : fitText(ctx, full, (g.w * c.z - 12) / c.z);
        if (!title) continue;
        const tw = ctx.measureText(title).width + 12 / c.z, th = (px + 6) / c.z;
        if (band - 6 < 10 && !whole) {
          // (above the group, where nothing is)
          top = g.y - th;
          const r = { x0: g.x, y0: top, x1: g.x + tw, y1: g.y };
          const busy = [...this.boxes.query(r.x0, r.y0, r.x1, r.y1, new Set())].some((it) => it !== g && !holds(it, g) && it.kind !== "ink") || taken.some((t) => t.x0 < r.x1 && r.x0 < t.x1 && t.y0 < r.y1 && r.y0 < t.y1);
          if (busy) continue;
        }
        const r = { x0: g.x, y0: top, x1: g.x + tw, y1: top + th };
        taken.push(r);
        this.titleRects.set(g.id, r);
        if (whole) { ctx.fillStyle = "rgba(250,250,247,.96)"; ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0); }
        ctx.lineWidth = 4 / c.z;
        ctx.strokeStyle = "rgba(250,250,247,.9)";
        ctx.strokeText(title, g.x + 6 / c.z, top + (px + 3) / c.z);
        ctx.fillStyle = "#1d241a";
        ctx.fillText(title, g.x + 6 / c.z, top + (px + 3) / c.z);
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
        // (a pen's stroke: its outline, filled; a highlighter's, see-through;
        // one being erased, faded; a selected one, outlined)
        if (this.selection.has(it.id)) {
          ctx.strokeStyle = "rgba(42, 111, 47, .9)";
          ctx.lineWidth = 3 / c.z;
          ctx.stroke(p);
        }
        ctx.fillStyle = it.color ?? INK;
        ctx.globalAlpha = (it.opacity ?? 1) * (this.erased?.ids.has(it.id) ? 0.2 : 1);
        ctx.fill(p);
        ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = it.color ?? "#2a6f2f";
        ctx.lineWidth = lw;
        ctx.stroke(p);
      }
      n++;
    }
    // the stroke being drawn (its outline as it is now: it changes only at its end as it goes on)
    if (this.live) {
      const { cap, style } = this.live;
      ctx.fillStyle = style.color;
      ctx.globalAlpha = style.opacity ?? 1;
      ctx.fill(new Path2D(inkPath(inkOutline(cap.points, { size: style.size, streamline: 0 }))));
      ctx.globalAlpha = 1;
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
    // (the grip: a rounded tab of six dots, at the same size on the screen at any zoom)
    const g = this.grip && !far ? this.byId.get(this.grip) : undefined;
    if (g) {
      const b = gripBox(g, c.z), r = 4 / c.z;
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#2a6f2f";
      ctx.lineWidth = 1.5 / c.z;
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.w, b.h, r);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#2a6f2f";
      for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) {
        ctx.beginPath();
        ctx.arc(b.x + b.w * (i ? 0.66 : 0.34), b.y + b.h * (0.27 + j * 0.23), 1.7 / c.z, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
    // (the control adding another of the selected item's kind: as the grip, at the same size on the screen at any zoom)
    const as = this.addSame && !far ? this.byId.get(this.addSame.id) : undefined;
    if (as) {
      const b = this.addSameBox(as, c.z), r = 4 / c.z;
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#2a6f2f";
      ctx.lineWidth = 1.5 / c.z;
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.w, b.h, this.addSameStyle === "chip" ? b.h / 2 : r);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#2a6f2f";
      ctx.strokeStyle = "#2a6f2f";
      ctx.lineWidth = 2 / c.z;
      // (the "+": a cross, 10 px; on the chip, before its kind's name)
      const px = this.addSameStyle === "chip" ? b.x + 13 / c.z : b.x + b.w / 2, py = b.y + b.h / 2, k = 5 / c.z;
      ctx.beginPath();
      ctx.moveTo(px - k, py); ctx.lineTo(px + k, py);
      ctx.moveTo(px, py - k); ctx.lineTo(px, py + k);
      ctx.stroke();
      if (this.addSameStyle === "chip") {
        ctx.font = `600 ${12 / c.z}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        ctx.textBaseline = "middle";
        ctx.fillText(this.addSame!.label, b.x + 23 / c.z, py + 0.5 / c.z);
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
  /** The grip's item, if the point (on the page) is on it (a finger's reach a little more). */
  gripAt(cx: number, cy: number, touch = false): string | null {
    const it = this.grip ? this.byId.get(this.grip) : undefined, c = this.camera;
    if (!it || c.z < FAR) return null;
    const b = gripBox(it, c.z), r = this.el.getBoundingClientRect(), reach = touch ? 10 : 3;
    const x0 = r.left + (b.x - c.x) * c.z, y0 = r.top + (b.y - c.y) * c.z;
    return cx >= x0 - reach && cx <= x0 + b.w * c.z + reach && cy >= y0 - reach && cy <= y0 + b.h * c.z + reach ? it.id : null;
  }
  /** The add-another control's item, if the point (on the page) is on it (a finger's reach a little more). */
  addSameAt(cx: number, cy: number, touch = false): string | null {
    const it = this.addSame ? this.byId.get(this.addSame.id) : undefined, c = this.camera;
    if (!it || c.z < FAR) return null;
    const b = this.addSameBox(it, c.z), r = this.el.getBoundingClientRect(), reach = touch ? 10 : 3;
    const x0 = r.left + (b.x - c.x) * c.z, y0 = r.top + (b.y - c.y) * c.z;
    return cx >= x0 - reach && cx <= x0 + b.w * c.z + reach && cy >= y0 - reach && cy <= y0 + b.h * c.z + reach ? it.id : null;
  }
  // (its box, world units: the "+", 22 px square, 4 px right of the top
  // right corner; the chip, 22 px high, as wide as its name, centred 6 px
  // under the bottom edge)
  private addSameBox(it: { x: number; y: number; w: number; h: number }, z: number) {
    if (this.addSameStyle === "plus") return { x: it.x + it.w + 4 / z, y: it.y, w: 22 / z, h: 22 / z };
    this.ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
    const w = (this.ctx.measureText(this.addSame?.label ?? "").width + 32) / z;
    return { x: it.x + it.w / 2 - w / 2, y: it.y + it.h + 6 / z, w, h: 22 / z };
  }
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
      // (a stroke: in the strokes' grid, and its path, which is where it was, made again)
      const grid = it.kind === "ink" ? this.strokes : this.boxes;
      grid.remove(it);
      it.x += dx;
      it.y += dy;
      if (it.inner) it.inner = { x: it.inner.x + dx, y: it.inner.y + dy };
      grid.add(it);
      if (it.kind === "ink") this.paths.delete(it.id);
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

  /** Outline the item Find shows (or none); a group's, its whole title shown. */
  setFound(id: string | null) {
    if (this.foundId) this.cache.get(this.foundId)?.classList.remove("found");
    this.foundId = id;
    if (id) this.cache.get(id)?.classList.add("found");
    this.request();
  }
  /** Show a group's whole title, over its members (or none's): its title cut, or not drawn, UI-0CC-2. */
  reveal(id: string | null) {
    if (this.revealed) this.cache.get(this.revealed)?.classList.remove("reveal");
    this.revealed = id;
    if (id) this.cache.get(id)?.classList.add("reveal");
    this.request();
  }
  get revealedId() { return this.revealed; }
  /** The group whose title is at a point on the page: its band, or where its title is drawn (the innermost). */
  titleAt(cx: number, cy: number): { id: string; title: string } | null {
    const w = this.toWorld(cx, cy);
    // (a title drawn, far out: where it was drawn, above its group too, the
    // innermost (drawn last); astra, on ec472da: a title above its group is
    // outside the group's box, so the box query below can't find it)
    let drawn: string | null = null;
    for (const [id, t] of this.titleRects) if (w.x >= t.x0 && w.x <= t.x1 && w.y >= t.y0 && w.y <= t.y1) drawn = id;
    const dg = drawn ? this.byId.get(drawn) : undefined;
    if (dg?.title) return { id: dg.id, title: plainTitle(dg.title) };
    // (else a group's band, the innermost)
    const gs = [...this.boxes.query(w.x - 1, w.y - 1, w.x + 1, w.y + 1, new Set())].filter((g) => g.kind === "group" && g.title).sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
    for (const g of gs) {
      const band = g.inner?.y ?? g.y + GROUP_PAD + GROUP_TITLE;
      if (w.x >= g.x && w.x <= g.x + g.w && w.y >= g.y && w.y < band) return { id: g.id, title: plainTitle(g.title!) };
    }
    return null;
  }
  /** An item's element, if it is mounted. */
  element(id: string): HTMLElement | null {
    return this.mounted.get(id) ?? null;
  }

  /** The notes and groups wholly inside a world rectangle. */
  itemsIn(x0: number, y0: number, x1: number, y1: number): Item[] {
    return this.near(x0, y0, x1, y1).filter((it) => it.x >= x0 && it.y >= y0 && it.x + it.w <= x1 && it.y + it.h <= y1);
  }
  /** The notes, groups and strokes overlapping a world rectangle (a large one: every item, not the grid's cells). */
  near(x0: number, y0: number, x1: number, y1: number): Item[] {
    const big = ((x1 - x0) / CELL) * ((y1 - y0) / CELL) > 4 * this.byId.size + 64;
    const its = big ? [...this.byId.values()] : [...this.boxes.query(x0, y0, x1, y1, new Set()), ...this.strokes.query(x0, y0, x1, y1, new Set())];
    return its.filter((it) => (it.kind === "note" || it.kind === "group" || it.kind === "ink" || it.kind === "sticker") && !it.inert && it.x < x1 && it.x + it.w > x0 && it.y < y1 && it.y + it.h > y0);
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
    return [...this.boxes.query(x, y, x + 0.01, y + 0.01, new Set())].filter((it) => it.kind === "group" && !it.inert && !except.has(it.id)).sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
  }

  // (erasing: the stroke at a page point goes, shown faded until the drag ends)
  private eraseAt(cx: number, cy: number) {
    const r = this.el.getBoundingClientRect(), it = this.inkAt(cx - r.left, cy - r.top, 8);
    if (it && this.erased && !this.erased.ids.has(it.id)) {
      this.erased.ids.add(it.id);
      this.request();
    }
  }

  /** The stroke at a screen point, the topmost: on it, or within `tol`
   * screen pixels of its edge (not in a loop's empty middle). */
  inkAt(sx: number, sy: number, tol = 5): Item | null {
    const c = this.camera, x = c.x + sx / c.z, y = c.y + sy / c.z, t = tol / c.z;
    const hits = [...this.strokes.query(x - t, y - t, x + t, y + t, new Set())];
    for (let i = hits.length - 1; i >= 0; i--) {
      const it = hits[i];
      if (it.outline && !it.inert && inkHit(it.outline, x - it.x, y - it.y, t)) return it;
    }
    return null;
  }

  /** The note or group at a screen point, innermost first. */
  itemAt(sx: number, sy: number): Item | null {
    const c = this.camera, x = c.x + sx / c.z, y = c.y + sy / c.z;
    const hits = [...this.boxes.query(x, y, x + 0.01, y + 0.01, new Set())].filter((it) => !it.inert);
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
    // (every finger on the board, where it is: one an item's drag took is still here)
    const touches = new Map<number, { x: number; y: number }>();
    for (const t of ["pointerdown", "pointermove"]) this.el.addEventListener(t, (e) => { const p = e as PointerEvent; if (p.pointerType === "touch") touches.set(p.pointerId, { x: p.clientX, y: p.clientY }); }, true);
    for (const t of ["pointerup", "pointercancel"]) this.el.addEventListener(t, (e) => { touches.delete((e as PointerEvent).pointerId); }, true);
    const mid = () => {
      const [p, q] = [...down.values()];
      return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, d: Math.hypot(p.x - q.x, p.y - q.y) };
    };
    // (a press on the selected item's grip, over another item's link: the
    // grip's, and the link not followed when it is let go, UI-BDC-2)
    // (only that press's own click: a pointer's (a keyboard's click is
    // the link's), and only until just after its release, when that click has
    // come, or its cancelling; astra's UI-36C-1)
    let gripPress = false;
    const gripDone = () => { gripPress = false; };
    this.el.addEventListener("click", (e) => { if (gripPress && e.detail > 0 && (e.target as Element).closest?.("a")) { e.preventDefault(); e.stopPropagation(); } gripPress = false; }, true);
    this.el.addEventListener("pointerup", () => { if (gripPress) setTimeout(gripDone, 0); }, true);
    this.el.addEventListener("pointercancel", gripDone, true);
    this.el.addEventListener("lostpointercapture", () => { if (gripPress) setTimeout(gripDone, 0); }, true);
    this.el.addEventListener("pointerdown", (e) => {
      gripPress = this.gripAt(e.clientX, e.clientY, e.pointerType === "touch") !== null;
      // (links, buttons, controls, 3D views, and the fields of the item being
      // edited, stay theirs, but for the selected item's grip over them; its
      // frame drags it, as any item's does)
      if (!gripPress && (e.target as Element).closest?.("a, " + FORM_CONTROLS + ", .board-code-out canvas, .board-editing :is(.mb, .be-md, .be-codebox, .board-code-out)")) return;
      cancelAnimationFrame(this.flight);
      const touch = e.pointerType === "touch";
      if (e.pointerType === "pen") this.penSeen = true;
      // (a second finger while a finger draws or erases: that is dropped, and the two pinch)
      if (touch && this.live?.touch) { this.live = null; this.request(); }
      if (touch && this.erased?.touch) { this.erased = null; this.request(); }
      // (a second finger while the first drags or resizes an item: that is
      // dropped, nothing of it kept, and the two pinch)
      if (touch && !e.isPrimary && down.size === 0) {
        const first = [...touches].find(([id]) => id !== e.pointerId);
        if (first && this.onTouchJoin?.()) down.set(first[0], first[1]);
      }
      // drawing, or erasing: the first pointer (a finger, only while no pen has been seen)
      if (down.size === 0 && e.isPrimary && e.button === 0 && !(touch && this.penSeen)) {
        const style = this.pen?.();
        if (style) {
          const w = this.toWorld(e.clientX, e.clientY);
          const cap = new InkCapture({ size: style.size, simulate: e.pointerType !== "pen", unit: 1 / this.camera.z });
          cap.add(w.x, w.y, e.pressure);
          this.live = { id: e.pointerId, touch, cap, style };
          e.preventDefault();
          down.set(e.pointerId, { x: e.clientX, y: e.clientY });
          this.el.setPointerCapture(e.pointerId);
          this.request();
          return;
        }
        if (this.eraser?.()) {
          this.erased = { id: e.pointerId, touch, ids: new Set() };
          this.eraseAt(e.clientX, e.clientY);
          e.preventDefault();
          down.set(e.pointerId, { x: e.clientX, y: e.clientY });
          this.el.setPointerCapture(e.pointerId);
          return;
        }
      }
      if (this.onItemDown && down.size === 0 && e.isPrimary) {
        const r = this.el.getBoundingClientRect();
        // (a stroke, drawn over the notes, before the note under it)
        const ink = this.inkAt(e.clientX - r.left, e.clientY - r.top);
        if (ink && this.onItemDown(ink, e)) return;
        const it = this.itemAt(e.clientX - r.left, e.clientY - r.top);
        // (an edge, drawn over groups and under notes, before the group it crosses)
        const ed = it?.kind !== "note" && it?.kind !== "sticker" && this.onEdgeDown ? this.edgeAt(e.clientX - r.left, e.clientY - r.top) : null;
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
      // (drawing: every point the pointer went through since the last event)
      if (this.live?.id === e.pointerId) {
        down.set(e.pointerId, { x: e.clientX, y: e.clientY });
        for (const c of e.getCoalescedEvents?.() ?? [e]) {
          const w = this.toWorld(c.clientX, c.clientY);
          this.live.cap.add(w.x, w.y, c.pressure);
        }
        this.request();
        return;
      }
      if (this.erased?.id === e.pointerId) {
        down.set(e.pointerId, { x: e.clientX, y: e.clientY });
        for (const c of e.getCoalescedEvents?.() ?? [e]) this.eraseAt(c.clientX, c.clientY);
        return;
      }
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
    for (const t of ["pointerup", "pointercancel"]) this.el.addEventListener(t, (e) => {
      const id = (e as PointerEvent).pointerId;
      down.delete(id);
      // (a stroke ends, or is dropped; what a drag erased goes)
      if (this.live?.id === id) {
        const { cap, style } = this.live;
        this.live = null;
        if (t === "pointerup") this.onStroke?.(cap.end(), style);
        this.request();
      }
      if (this.erased?.id === id) {
        const ids = [...this.erased.ids];
        this.erased = null;
        if (t === "pointerup" && ids.length) this.onErase?.(ids);
        this.request();
      }
    });
    // a group's title: its whole on a hover over its band (a tooltip), and
    // a click there, for the host (UI-0CC-2)
    this.el.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch" || down.size) return;
      const t = this.titleAt(e.clientX, e.clientY)?.title ?? null;
      if ((this.el.getAttribute("title") ?? null) !== t) { if (t) this.el.title = t; else this.el.removeAttribute("title"); }
    });
    // (a click, not the end of a drag)
    let pressed: { x: number; y: number } | null = null;
    this.el.addEventListener("pointerdown", (e) => { pressed = { x: e.clientX, y: e.clientY }; }, true);
    this.el.addEventListener("click", (e) => {
      if (e.detail > 1 || (pressed && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > 6)) return;
      this.onTitleClick?.(this.titleAt(e.clientX, e.clientY)?.id ?? null);
    });
    // (a double tap: touch screens' double-click, which not every browser
    // makes into a dblclick; one it does make is then ignored)
    let tap: { t: number; x: number; y: number } | null = null, start: { t: number; x: number; y: number } | null = null, doubled = 0;
    this.el.addEventListener("pointerdown", (e) => {
      if (atControl(e)) { start = null; tap = null; return; }
      if (e.pointerType === "touch" && e.isPrimary) start = { t: e.timeStamp, x: e.clientX, y: e.clientY };
    }, true);
    this.el.addEventListener("pointerup", (e) => {
      if (atControl(e)) { start = null; tap = null; return; }
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
      if (!editingAt(e) && !atControl(e)) this.doubleAt(e.clientX, e.clientY);
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
const contentKey = (it: Item) => JSON.stringify([it.kind, it.title, it.text, it.detail, it.ref, it.shape, it.code, it.order, it.hideCode, it.lang, it.image, it.emoji, it.icon, it.kind === "sticker" ? it.color : undefined, it.inert]);
// (a double-click in the item being edited selects a word, as in any field)
const editingAt = (e: Event) => !!(e.target as Element | null)?.closest?.(".board-editing");
// (a form's control, or its label: its presses and taps are its own, never the board's gestures, HARD-448-2)
// (a question's controls, kept from the board's double-click and double tap;
// a link elsewhere, as a note's reference, is not one: its double-click edits, CORR-6CE-1)
const FORM_CONTROLS = "button, input, select, textarea, .board-ask summary, .board-ask label, .board-ask-opts a, .board-ask-words a";
const atControl = (e: Event) => !!(e.target as Element | null)?.closest?.(FORM_CONTROLS);
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
// (each question's controls a radio group's name of their own)
let askSerial = 0;

/** Inline math kept on one line with the punctuation that touches it, as
 * text is ("$x$." never leaves the "." at the start of the next line, nor
 * "($x$" the "(" at the end of a line). */
export function glueMath(root: HTMLElement) {
  for (const m of [...root.querySelectorAll<HTMLElement>("span.math")]) {
    const next = m.nextSibling, prev = m.previousSibling;
    const after = next?.nodeType === 3 ? /^[.,;:!?)\]}%'"\u2019\u201d]+/.exec(next.textContent ?? "")?.[0] : undefined;
    const before = prev?.nodeType === 3 ? /[(\[{'"\u2018\u201c]+$/.exec(prev.textContent ?? "")?.[0] : undefined;
    if (!after && !before) continue;
    const g = document.createElement("span");
    g.className = "board-nowrap";
    m.before(g);
    if (before) { (prev as Text).textContent = prev!.textContent!.slice(0, -before.length); g.append(before); }
    g.append(m);
    if (after) { (next as Text).textContent = next!.textContent!.slice(after.length); g.append(after); }
  }
}

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
  glueMath(b);
  return b;
}
/** Text cut to a width with "…", in the canvas's font ("" when not even a letter and "…" fit). */
export function fitText(ctx: CanvasRenderingContext2D, t: string, width: number): string {
  if (ctx.measureText(t).width <= width) return t;
  // (the longest start that fits, found by halves)
  let lo = 0, hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(t.slice(0, mid).trimEnd() + "…").width <= width) lo = mid;
    else hi = mid - 1;
  }
  return lo ? t.slice(0, lo).trimEnd() + "…" : "";
}
/** A title as plain text (drawn on a canvas, or as an SVG label): its math as its TeX. */
export function plainTitle(title: string): string {
  return title.replace(TITLE_MATH, (_, a, b) => (a ?? b).trim());
}

// What a note shows far out: its title, or else its text's first line
// without Markdown (a flowchart's notes have only text)
const farLabels = new WeakMap<Item, string>();
// The grip's box (world units), left of an item's top left corner: 16 by 26
// pixels on the screen, 4 from the item
const gripBox = (it: { x: number; y: number }, z: number) => ({ x: it.x - 20 / z, y: it.y, w: 16 / z, h: 26 / z });
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
