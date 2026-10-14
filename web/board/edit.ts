// Editing a board (Edit mode on the board page): drag notes and groups
// (into another group, or out of one, by letting go there), double-click to
// write a note (or, on the background, to add one), shift-drag from one note
// to another to connect them; click an edge to select it, double-click it
// (or Enter) for its label, arrowheads and line; Delete, undo and redo.
// Every change is a change to the document (web/board/doc.ts), laid out
// again: a moved item, and the others in its group, keep the positions they
// have (x and y), so nothing else moves; "Tidy" forgets them all.

import { effect, signal } from "@preact/signals-core";
import { INK, type Board, type InkStyle, type Item } from "./board";
import { inkNode, type BoardDoc, type BoardPage, type DocEdge, type DocGroup, type DocNode, type DocNote } from "./doc";
import { prepare, type ImageStore, type ImageInfo } from "./images";
import { InPlace, type InPlaceHost } from "./inplace";

interface Found { node: DocNode; parent: DocGroup | null; siblings: DocNode[] }

export function find(doc: BoardDoc | BoardPage, id: string): Found | null {
  const walk = (list: DocNode[], parent: DocGroup | null): Found | null => {
    for (const n of list) {
      if (n.id === id) return { node: n, parent, siblings: list };
      if (n.kind === "group") {
        const f = walk(n.children, n);
        if (f) return f;
      }
    }
    return null;
  };
  return walk(doc.nodes ?? [], null);
}

function ids(n: DocNode): string[] {
  return n.kind === "group" ? [n.id, ...n.children.flatMap(ids)] : [n.id];
}

/** A copy of the document without positions (automatic layout again). */
export function tidy<T extends BoardDoc | BoardPage>(doc: T): T {
  const strip = (n: DocNode): DocNode => {
    const { x: _x, y: _y, ...rest } = n as any;
    return rest.kind === "group" ? { ...rest, children: rest.children.map(strip) } : rest;
  };
  return { ...doc, nodes: (doc.nodes ?? []).map(strip) };
}

export class Editor {
  /** Edit mode (the toolbar shows while it is on) */
  readonly editing = signal(false);
  /** connecting by taps (the toolbar's Connect, for touch screens too): a
   * note tapped, then another, makes an edge between them */
  readonly connecting = signal(false);
  /** the Select tool: a drag on the background draws a rectangle selecting what it holds (no shift needed; Space-drag pans) */
  readonly selecting = signal(false);
  /** the Draw tool: a drag draws a stroke, in the pen's style (the pen row: pen.ts; Space-drag pans) */
  readonly drawing = signal(false);
  /** the Erase tool: a drag removes the strokes it goes across (one undo brings them all back) */
  readonly erasing = signal(false);
  /** the pen's style (the pen row's) */
  penStyle: () => InkStyle = () => ({ size: 3, color: INK });
  private connectFrom: string | null = null;
  private space = false;
  get on() { return this.editing.value; }
  /** whether items are selected in Edit (the arrow keys then move them) */
  get hasSelection() { return this.on && this.selected.length > 0; }
  /** whether Esc is the editor's now: a tool on, something selected, an edge's panel open (else it is the page's: the whole board) */
  get escapes() {
    return this.on && (this.edgeSel !== null || this.selected.length > 0 || !!this.panel || this.drawing.value || this.erasing.value || this.connecting.value || this.selecting.value);
  }
  private undos: string[] = [];
  private redos: string[] = [];
  private selected: string[] = [];
  private edgeSel: number | null = null; // the selected edge: its index in the page's edges
  private panel: HTMLElement | null = null; // an edge's
  private inplace: InPlace | null = null; // the item being written where it is
  /** whether items are being dragged or resized now (the board is not laid out again meanwhile: mount.ts) */
  moving = false;
  /** a drag or a resize ended */
  onSettled: (() => void) | null = null;
  private hold(on: boolean) {
    this.moving = on;
    if (!on) this.onSettled?.();
  }
  /** Whether the page's keys and clipboard are this board's (one of several on a page: focus.ts) */
  isActive: () => boolean = () => true;
  /** Run a code item (its code is as it was: a changed one runs as the board is laid out again) */
  onRun: ((id: string) => void) | null = null;
  /** the code highlighter (HTML), once the notebook is loaded: code is written in the notebook's editor */
  highlight: (() => ((src: string) => string) | null) | null = null;
  /** where pictures are kept (images.ts) */
  images: ImageStore | null = null;

  // (edits are to the page shown: pg(d) is it, within the whole document d)
  constructor(private board: Board, private doc: () => BoardDoc | null, private change: (d: BoardDoc) => Promise<void>,
    private pg: (d: BoardDoc) => BoardPage = (d) => d as BoardPage) {
    board.onItemDown = (it, e) => this.down(it, e);
    board.onDoubleClick = (it, x, y) => this.dblclick(it, x, y);
    board.onEdgeDown = (ed) => {
      if (!this.on || this.panel || ed.src === undefined) return false;
      this.select(null);
      this.selectEdge(ed.src);
      return true;
    };
    board.onEdgeDoubleClick = (ed) => {
      if (!this.on || ed.src === undefined) return false;
      this.openEdge(ed.src);
      return true;
    };
    board.onBackgroundDown = (e) => this.backgroundDown(e);
    // drawing and erasing: the board follows the pointer (board.ts); a
    // stroke drawn goes at the page's top level, over what is there
    board.pen = () => (this.on && this.drawing.value && !this.space && !this.panel ? this.penStyle() : null);
    board.eraser = () => this.on && this.erasing.value && !this.space && !this.panel;
    board.onStroke = (points, style) => {
      if (!points.length) return;
      this.commit((d) => { (this.pg(d).nodes ??= []).push(inkNode("s" + Math.random().toString(36).slice(2, 8), points, style)); });
    };
    board.onErase = (gone) => { this.commit((d) => { for (const id of gone) remove(this.pg(d), id); }); };
    // (the resize handle's cursor)
    board.el.addEventListener("pointermove", (e) => {
      const at = this.on && !this.panel && e.pointerType === "mouse" && this.atHandle(e);
      board.el.style.cursor = at ? "nwse-resize" : "";
    });
    this.listen(window, "keydown", (e) => this.key(e));
    // copying, cutting and pasting items (the page's own clipboard events: no permission asked)
    this.listen(document, "copy", (e) => this.clip(e, false));
    this.listen(document, "cut", (e) => this.clip(e, true));
    this.listen(document, "paste", (e) => this.paste(e));
    this.effects.push(effect(() => {
      const on = this.editing.value;
      if (!on) { this.select(null); this.close(); this.connecting.value = false; }
      this.board.el.classList.toggle("editing", on);
    }), effect(() => {
      this.board.el.classList.toggle("connecting", this.connecting.value);
      if (!this.connecting.value && this.connectFrom) { this.connectFrom = null; this.select(null); }
      if (this.connecting.value) { this.selecting.value = false; this.drawing.value = false; this.erasing.value = false; }
    }), effect(() => {
      this.board.el.classList.toggle("selecting", this.selecting.value);
      if (this.selecting.value) { this.connecting.value = false; this.drawing.value = false; this.erasing.value = false; }
    }), effect(() => {
      // (one tool at a time: drawing, nothing selected nor being written)
      this.board.el.classList.toggle("drawing", this.drawing.value);
      if (this.drawing.value) { this.connecting.value = false; this.selecting.value = false; this.erasing.value = false; this.select(null); this.close(); }
    }), effect(() => {
      this.board.el.classList.toggle("erasing", this.erasing.value);
      if (this.erasing.value) { this.connecting.value = false; this.selecting.value = false; this.drawing.value = false; this.select(null); this.close(); }
    }), effect(() => { if (!this.editing.value) { this.selecting.value = false; this.drawing.value = false; this.erasing.value = false; } }));
    // (Space held: a drag pans, whatever the tool)
    this.listen(window, "keydown", (e) => { if (e.key === " " && !this.typing() && this.isActive()) this.space = true; });
    this.listen(window, "keyup", (e) => { if (e.key === " ") this.space = false; });
  }
  // (the page's events it listens to, and its effects, until destroy())
  private offs: (() => void)[] = [];
  private effects: (() => void)[] = [];
  private listen(t: EventTarget, type: string, f: (e: any) => void) {
    t.addEventListener(type, f);
    this.offs.push(() => t.removeEventListener(type, f));
  }
  /** Stop (the board is unmounted): what is being written is kept first; then
   * no more listening to the page, and its effects disposed. */
  async destroy() {
    await this.inplace?.end();
    this.close();
    for (const f of [...this.offs.splice(0), ...this.effects.splice(0)]) f();
  }

  setOn(on: boolean) {
    this.editing.value = on;
  }

  /** Apply a change made to a copy of the document; undoable (with `merge`,
   * one step with the change before it: a new note and its first text).
   * Whether there is now an undo step holding it (false: merged back to
   * where its step started, so none), or null if nothing changed. */
  async commit(f: (d: BoardDoc) => void, merge = false, record = true): Promise<boolean | null> {
    const cur = this.doc();
    if (!cur) return null;
    const before = JSON.stringify(cur), d = JSON.parse(before) as BoardDoc;
    f(d);
    const after = JSON.stringify(d);
    if (after === before) return null;
    let stepped = record;
    // (not recorded: a setting kept in the document, the toolbar's tools, is no step to undo)
    if (!record) {}
    else if (!merge || !this.undos.length) this.undos.push(before);
    // (merged back to where it started: no step at all)
    else if (this.undos.at(-1) === after) { this.undos.pop(); stepped = false; }
    if (this.undos.length > 200) this.undos.shift();
    this.redos = [];
    await this.change(d);
    this.selectEdge(this.edgeSel);
    this.gone();
    return stepped;
  }
  // (the item being written is no longer there: undone, or removed by an agent)
  private gone() {
    if (this.inplace && !this.board.item(this.inplace.id)) this.inplace.abandon();
  }
  async undo() {
    // (what is being written is kept first: it is what undo takes back)
    await this.inplace?.end();
    const cur = this.doc(), prev = this.undos.pop();
    if (!cur || !prev) return;
    this.redos.push(JSON.stringify(cur));
    this.selectEdge(null);
    await this.change(this.keep(cur, JSON.parse(prev)));
    this.gone();
  }
  async redo() {
    await this.inplace?.end();
    const cur = this.doc(), next = this.redos.pop();
    if (!cur || !next) return;
    this.undos.push(JSON.stringify(cur));
    this.selectEdge(null);
    await this.change(this.keep(cur, JSON.parse(next)));
    this.gone();
  }
  // (the settings undo leaves as they are: the toolbar's tools)
  private keep(cur: BoardDoc, d: BoardDoc): BoardDoc {
    if (cur.tools) d.tools = cur.tools;
    else delete d.tools;
    return d;
  }

  /** Nothing selected, no note open (another page is shown). */
  clear() { this.select(null); this.selectEdge(null); this.close(); }
  private select(ids: string | string[] | null) {
    this.selected = ids === null ? [] : typeof ids === "string" ? [ids] : [...new Set(ids)];
    this.board.select(this.selected);
    // (one note selected, in Edit: its corner resizes it)
    this.board.handle = this.on && !this.inplace && this.selected.length === 1 && this.board.item(this.selected[0])?.kind === "note" ? this.selected[0] : null;
    this.board.request();
    if (this.selected.length) this.selectEdge(null);
  }
  /** The selected items not inside another selected one (what moves, copies, deletes). */
  private topSelected(d: BoardDoc): string[] {
    const sel = new Set(this.selected);
    return this.selected.filter((id) => {
      for (let f = find(this.pg(d), id); f?.parent; f = find(this.pg(d), f.parent.id)) if (sel.has(f.parent.id)) return false;
      return true;
    });
  }

  // A press on the background: with shift, a rectangle selecting what it
  // holds; a click (not a drag, which pans) selects nothing.
  private backgroundDown(e: PointerEvent): boolean {
    if (!this.on || this.panel || this.connecting.value) return false;
    // (the resize handle reaches past its item's corner)
    const h = this.atHandle(e);
    if (h) return this.resize(h, e);
    const marquee = (e.shiftKey || this.selecting.value) && !this.space && e.button === 0;
    if (!marquee) {
      const x0 = e.clientX, y0 = e.clientY;
      addEventListener("pointerup", (u) => { if (Math.hypot(u.clientX - x0, u.clientY - y0) < 4) { this.select(null); this.selectEdge(null); } }, { once: true });
      return false;
    }
    const a = this.board.toWorld(e.clientX, e.clientY);
    const move = (m: PointerEvent) => {
      const b = this.board.toWorld(m.clientX, m.clientY);
      this.board.marquee = { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
      this.board.request();
    };
    const up = (u: PointerEvent) => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      const b = this.board.toWorld(u.clientX, u.clientY);
      this.board.marquee = null;
      const inside = this.board.itemsIn(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)).map((it) => it.id);
      this.select([...this.selected, ...inside]);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    return true;
  }
  // (an edge is selected by its index in the document, and drawn so by its
  // id in the layout, found again after each layout)
  private selectEdge(src: number | null) {
    this.edgeSel = src;
    this.board.selectedEdge = src === null ? null : this.board.edgeList().find((e) => e.src === src)?.id ?? null;
    if (this.board.selectedEdge === null) this.edgeSel = null;
    this.board.request();
  }

  // Positions of a container's members as they are now on the board (in
  // its coordinates: a group's members from its inner origin, the top
  // level's in the world), written into the document.
  private freeze(_d: BoardDoc, parent: DocGroup | null, siblings: DocNode[]) {
    const o = parent ? this.board.item(parent.id)?.inner : { x: 0, y: 0 };
    if (!o) return;
    for (const s of siblings) {
      const it = this.board.item(s.id);
      if (it) { s.x = Math.round((it.x - o.x) * 10) / 10; s.y = Math.round((it.y - o.y) * 10) / 10; }
    }
  }

  private down(it: Item, e: PointerEvent): boolean {
    if (!this.on || this.panel) return false;
    // (in Edit a press on an item moves or selects it: no text selection, and
    // none left from before, which the browser would start dragging instead)
    e.preventDefault();
    getSelection()?.removeAllRanges();
    const z = () => this.board.camera.z;
    if (this.connecting.value) {
      if (it.kind !== "note") return false;
      const from = this.connectFrom;
      if (!from || from === it.id) {
        this.connectFrom = from === it.id ? null : it.id;
        this.select(this.connectFrom);
        return true;
      }
      this.connectFrom = null;
      this.select(null);
      this.commit((d) => {
        const p = this.pg(d);
        if (!(p.edges ?? []).some((x) => x.from === from && x.to === it.id)) (p.edges ??= []).push({ from, to: it.id });
      });
      return true;
    }
    // (shift-click: add to the selection, or take out of it)
    const toggle = () => this.select(this.selected.includes(it.id) ? this.selected.filter((x) => x !== it.id) : [...this.selected, it.id]);
    if (e.shiftKey && it.kind !== "note") { toggle(); return true; }
    if (e.shiftKey && it.kind === "note") {
      // connect: a dashed line to the pointer, an edge where it is let go
      const x0 = e.clientX, y0 = e.clientY;
      const move = (m: PointerEvent) => {
        const w = this.board.toWorld(m.clientX, m.clientY);
        this.board.pending = { from: it.id, x: w.x, y: w.y };
        this.board.request();
      };
      const up = (u: PointerEvent) => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        this.board.pending = null;
        this.board.request();
        const r = this.board.el.getBoundingClientRect(), to = this.board.itemAt(u.clientX - r.left, u.clientY - r.top);
        if (to && to.id !== it.id && to.kind === "note") {
          this.commit((d) => {
            const p = this.pg(d);
            if (!(p.edges ?? []).some((x) => x.from === it.id && x.to === to.id)) (p.edges ??= []).push({ from: it.id, to: to.id });
          });
        } else if (Math.hypot(u.clientX - x0, u.clientY - y0) < 4) toggle();
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
      return true;
    }
    // the selected item's corner: resize it
    const h = this.atHandle(e);
    if (h) return this.resize(h, e);
    // drag (or, not moved, select): the selection, if this is one of several selected
    const d0 = this.doc(), f = d0 && find(this.pg(d0), it.id);
    if (!f) return false;
    const several = this.selected.length > 1 && this.selected.includes(it.id) ? this.topSelected(d0!) : null;
    const wasOnly = this.selected.length === 1 && this.selected[0] === it.id;
    const moving = several ? [...new Set(several.flatMap((id) => { const g = find(this.pg(d0!), id); return g ? ids(g.node) : []; }))] : ids(f.node), self = new Set(moving);
    const from = f.parent?.id ?? null;
    const snap = this.snapper(several ?? [it.id], self);
    // (where it would go if let go here: the innermost group under the
    // pointer, not itself or inside it; or the top level)
    const targetAt = (cx: number, cy: number) => { const w = this.board.toWorld(cx, cy); return this.board.groupsAt(w.x, w.y, self)[0]?.id ?? null; };
    let last = { x: e.clientX, y: e.clientY }, dist = 0;
    // (the pointer's offset since the press, and how far the items have moved: they differ by the snapping)
    const raw = { x: 0, y: 0 }, applied = { x: 0, y: 0 };
    this.hold(true);
    const move = (m: PointerEvent) => {
      raw.x += (m.clientX - last.x) / z();
      raw.y += (m.clientY - last.y) / z();
      dist += Math.abs(m.clientX - last.x) + Math.abs(m.clientY - last.y);
      last = { x: m.clientX, y: m.clientY };
      if (dist > 3) {
        const to = m.altKey ? { x: raw.x, y: raw.y, xs: [], ys: [] } : snap(raw.x, raw.y);
        this.board.translate(moving, to.x - applied.x, to.y - applied.y);
        applied.x = to.x;
        applied.y = to.y;
        this.board.guides = to.xs.length || to.ys.length ? { xs: to.xs, ys: to.ys } : null;
        if (!several) {
          const t = targetAt(m.clientX, m.clientY);
          this.board.dropTarget = t !== from ? t : null;
        }
      }
    };
    const up = (u: PointerEvent) => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      this.hold(false);
      this.board.dropTarget = null;
      this.board.guides = null;
      this.board.request();
      if (several) {
        if (dist <= 3) return;
        // (each where it was let go, in its group; the others keep their places)
        this.commit((d) => {
          for (const id of several) {
            const g = find(this.pg(d), id);
            if (!g) continue;
            this.freezeUp(d, g);
            this.contain(g.parent, g.siblings);
          }
        });
        return;
      }
      // (on a touch screen, a tap on the one item selected opens it: there is no Enter)
      if (dist <= 3 && u.pointerType === "touch" && wasOnly && u.type !== "pointercancel") { this.open(it.id); return; }
      if (dist <= 3) { this.select(it.id); return; }
      this.select(it.id);
      const target = u.type === "pointercancel" ? from : targetAt(u.clientX, u.clientY);
      this.commit((d) => {
        const g = find(this.pg(d), it.id);
        if (!g) return;
        // (its group's members, and every enclosing group's, keep their
        // places: a group growing moves nothing else)
        this.freezeUp(d, g);
        if (target === from) { this.contain(g.parent, g.siblings); return; }
        // into another group, or out to the top level: where it was let go,
        // and that group's members, and every group around it, stay put
        const into = target ? find(this.pg(d), target) : null;
        if (target && (!into || into.node.kind !== "group")) return;
        if (into) { this.freezeUp(d, into); this.freeze(d, into.node as DocGroup, (into.node as DocGroup).children); }
        g.siblings.splice(g.siblings.indexOf(g.node), 1);
        this.compact(g.parent, g.siblings);
        const o = target ? this.board.item(target)?.inner : { x: 0, y: 0 }, now = this.board.item(it.id);
        if (!o || !now) return;
        g.node.x = Math.round((now.x - o.x) * 10) / 10;
        g.node.y = Math.round((now.y - o.y) * 10) / 10;
        const list = into ? (into.node as DocGroup).children : (this.pg(d).nodes ??= []);
        list.push(g.node);
        this.contain(into ? (into.node as DocGroup) : null, list);
      });
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
    return true;
  }

  // Resizing: one selected note (a picture, or any note) has a handle at its
  // bottom right corner (the board draws it): dragging it sets the note's
  // width; a picture keeps its shape, and a note's height follows its text.
  private atHandle(e: PointerEvent): Item | null {
    if (this.selected.length !== 1) return null;
    const it = this.board.item(this.selected[0]), r = it && it.kind === "note" ? this.board.clientRect(it.id) : null;
    if (!it || !r) return null;
    const reach = e.pointerType === "touch" ? 22 : 10;
    return Math.abs(e.clientX - (r.left + r.width)) <= reach && Math.abs(e.clientY - (r.top + r.height)) <= reach ? it : null;
  }
  private resize(it: Item, e: PointerEvent): boolean {
    e.preventDefault();
    const z = this.board.camera.z, x0 = e.clientX, w0 = it.w, ratio = it.image && !it.title && !it.text && it.code === undefined && !it.detail && !it.ref ? it.image.h / it.image.w : 0;
    let w = w0;
    this.hold(true);
    const move = (m: PointerEvent) => {
      w = Math.max(ratio ? 24 : 120, Math.round(w0 + (m.clientX - x0) / z));
      this.board.resizeItem(it.id, w, ratio ? Math.round(w * ratio) : undefined);
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      this.hold(false);
      if (w === w0) return;
      this.commit((d) => {
        const g = find(this.pg(d), it.id);
        if (!g || g.node.kind === "group") return;
        this.freezeUp(d, g);
        const n = g.node as DocNote;
        n.w = w;
        // (its height follows: its text's, or its picture's shape; and it no longer fits its text)
        delete n.h;
        delete n.fit;
        this.contain(g.parent, g.siblings);
      });
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
    return true;
  }

  /** Add pictures (files: pasted, dropped, chosen) at (x, y) in the world, each a note that is only the picture. */
  async addImages(files: Iterable<Blob>, x: number, y: number, opts: { paste?: boolean } = {}) {
    if (!this.images) return;
    const added: { id: string; key: string; info: ImageInfo; w: number }[] = [];
    for (const f of files) {
      const p = await prepare(f, opts);
      if (!p) continue;
      const key = await this.images.put(p.blob);
      // (at its natural size, in CSS pixels: a 2x screenshot at half its pixels)
      added.push({ id: "p" + Math.random().toString(36).slice(2, 8), key, info: { w: p.w, h: p.h }, w: Math.min(480, p.cssW) });
    }
    if (!added.length) return;
    await this.commit((d) => {
      const p = this.pg(d);
      p.nodes ??= [];
      this.freeze(d, null, p.nodes);
      added.forEach((a, i) => {
        (d.images ??= {})[a.key] = a.info;
        p.nodes!.push({ id: a.id, image: a.key, w: a.w, x: Math.round(x - a.w / 2 + 30 * i), y: Math.round(y - (a.w * a.info.h) / a.info.w / 2 + 30 * i) });
      });
    });
    this.select(added.map((a) => a.id));
  }

  // Alignment while dragging: the moving items' box, its edges and middle,
  // snaps to those of the items in view (not moving, not around them) within
  // 6 pixels; returns the offset to apply, and the guides to draw.
  private snapper(top: string[], self: Set<string>) {
    const boxes = top.map((id) => this.board.item(id)).filter((b): b is Item => !!b);
    const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.w)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
    const v = this.board.view();
    const around = (o: Item) => o.x <= x0 && o.y <= y0 && o.x + o.w >= x1 && o.y + o.h >= y1;
    const others = this.board.near(v.x0, v.y0, v.x1, v.y1).filter((o) => !self.has(o.id) && !around(o));
    const xs = others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w]), ys = others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h]);
    const best = (lines: number[], edges: number[]) => {
      const tol = 6 / this.board.camera.z;
      let d = Infinity, at: number[] = [];
      for (const l of lines) for (const e of edges) {
        const k = l - e;
        if (Math.abs(k) > tol || Math.abs(k) > Math.abs(d) + 1e-6) continue;
        if (Math.abs(Math.abs(k) - Math.abs(d)) < 1e-6) at.push(l);
        else { d = k; at = [l]; }
      }
      return { d: Number.isFinite(d) ? d : 0, at: Number.isFinite(d) ? [...new Set(at)] : [] };
    };
    return (dx: number, dy: number) => {
      if (!boxes.length) return { x: dx, y: dy, xs: [] as number[], ys: [] as number[] };
      const bx = best(xs, [x0 + dx, (x0 + x1) / 2 + dx, x1 + dx]), by = best(ys, [y0 + dy, (y0 + y1) / 2 + dy, y1 + dy]);
      return { x: dx + bx.d, y: dy + by.d, xs: bx.at, ys: by.at };
    };
  }

  // The selection as a clipboard's text (and in it, its edges); pasted
  // back, with new ids, beside where it was (another board: in the middle
  // of the view).  Text that is not one is a new note.
  private copied(): string | null {
    const d = this.doc();
    if (!d || !this.selected.length) return null;
    const nodes = this.topSelected(d).map((id) => find(this.pg(d), id)?.node).filter((n): n is DocNode => !!n);
    const inside = new Set(nodes.flatMap(ids));
    const edges = (this.pg(d).edges ?? []).filter((e) => inside.has(e.from) && inside.has(e.to));
    // (positions in the world, to paste beside)
    const at = Object.fromEntries(nodes.map((n) => [n.id, this.board.item(n.id)]).filter(([, it]) => it).map(([id, it]) => [id, { x: (it as Item).x, y: (it as Item).y }]));
    // (and the sizes of their pictures, kept in this browser)
    const pics = new Set<string>();
    const walk = (ns: DocNode[]) => { for (const n of ns) { if (n.kind === "group") walk(n.children); else if (n.kind !== "ink" && n.image) pics.add(n.image); } };
    walk(nodes);
    const images = Object.fromEntries([...pics].filter((k) => d.images?.[k]).map((k) => [k, d.images![k]]));
    return JSON.stringify({ "sagebrush-board": 1, nodes, edges, at, ...(pics.size ? { images } : {}) });
  }
  private clip(e: ClipboardEvent, cut: boolean) {
    if (!this.isActive()) return;
    if (!this.on || this.panel || this.typing()) return;
    const text = this.copied();
    if (!text) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", text);
    if (cut) this.deleteSelected();
  }
  private paste(e: ClipboardEvent) {
    if (!this.isActive()) return;
    if (!this.on || this.panel || this.typing()) return;
    // a picture (a screenshot, say): a note that is it, in the middle of the view
    const pics = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (pics.length) {
      e.preventDefault();
      const v = this.board.view();
      this.addImages(pics, (v.x0 + v.x1) / 2, (v.y0 + v.y1) / 2, { paste: true });
      return;
    }
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text.trim()) return;
    e.preventDefault();
    this.insert(text);
  }
  private typing() {
    const a = document.activeElement;
    return a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || (a as HTMLElement | null)?.isContentEditable;
  }
  private insert(text: string) {
    let data: { nodes: DocNode[]; edges: DocEdge[]; at?: Record<string, { x: number; y: number }>; images?: Record<string, ImageInfo> } | null = null;
    try {
      const j = JSON.parse(text);
      if (j?.["sagebrush-board"] && Array.isArray(j.nodes)) data = j;
    } catch {}
    const v = this.board.view(), cx = (v.x0 + v.x1) / 2, cy = (v.y0 + v.y1) / 2;
    if (!data) {
      // (plain text: a note holding it)
      const id = "n" + Math.random().toString(36).slice(2, 8);
      return this.commit((d) => { const p = this.pg(d); p.nodes ??= []; this.freeze(d, null, p.nodes); p.nodes.push({ id, text: text.trim(), x: Math.round(cx - 130), y: Math.round(cy - 30) }); }).then(() => this.select(id));
    }
    const fresh = new Map<string, string>();
    const renew = (n: DocNode): DocNode => {
      const id = (n.kind === "group" ? "g" : "n") + Math.random().toString(36).slice(2, 8);
      fresh.set(n.id, id);
      return n.kind === "group" ? { ...n, id, children: n.children.map(renew) } : { ...n, id };
    };
    const nodes = data.nodes.map(renew);
    nodes.forEach((n, i) => {
      const was = data!.at?.[data!.nodes[i].id];
      n.x = Math.round(was ? was.x + 24 : cx - 130 + 24 * i);
      n.y = Math.round(was ? was.y + 24 : cy - 30 + 24 * i);
    });
    const edges = data.edges.filter((e) => fresh.has(e.from) && fresh.has(e.to)).map((e) => ({ ...e, from: fresh.get(e.from)!, to: fresh.get(e.to)! }));
    return this.commit((d) => {
      const p = this.pg(d);
      p.nodes ??= [];
      this.freeze(d, null, p.nodes);
      p.nodes.push(...nodes);
      if (edges.length) (p.edges ??= []).push(...edges);
      for (const [k, v] of Object.entries(data!.images ?? {})) if (v && typeof v.w === "number" && typeof v.h === "number") (d.images ??= {})[k] ??= { w: v.w, h: v.h };
    }).then(() => this.select(nodes.map((n) => n.id)));
  }
  private deleteSelected() {
    const d = this.doc();
    if (!d) return;
    const gone = this.topSelected(d);
    this.select(null);
    this.commit((d) => { for (const id of gone) remove(this.pg(d), id); });
  }
  // the selection moved by (dx, dy) world units, each in its group
  private nudge(dx: number, dy: number) {
    const d0 = this.doc();
    if (!d0) return;
    const top = this.topSelected(d0);
    this.board.translate([...new Set(top.flatMap((id) => { const g = find(this.pg(d0), id); return g ? ids(g.node) : []; }))], dx, dy);
    this.commit((d) => {
      for (const id of top) {
        const g = find(this.pg(d), id);
        if (!g) continue;
        this.freezeUp(d, g);
        this.contain(g.parent, g.siblings);
      }
    });
  }

  // A container's members, and every enclosing group's, keep their places.
  private freezeUp(d: BoardDoc, f: Found) {
    this.freeze(d, f.parent, f.siblings);
    for (let p = f.parent; p; ) {
      const pf = find(this.pg(d), p.id)!;
      this.freeze(d, pf.parent, pf.siblings);
      p = pf.parent;
    }
  }
  // A member moved above or left of its group's origin: the group moves out
  // that far, its members back by as much, so it still holds them.
  private contain(parent: DocGroup | null, siblings: DocNode[]) {
    if (!parent) return;
    const minX = Math.min(0, ...siblings.map((s) => s.x ?? 0)), minY = Math.min(0, ...siblings.map((s) => s.y ?? 0));
    if (minX < 0 || minY < 0) {
      parent.x = (parent.x ?? 0) + minX;
      parent.y = (parent.y ?? 0) + minY;
      for (const s of siblings) { s.x = (s.x ?? 0) - minX; s.y = (s.y ?? 0) - minY; }
    }
  }
  // A member taken out: the group closes up around the rest (its corner moves
  // in as far as they allow, the rest staying where they are).
  private compact(parent: DocGroup | null, siblings: DocNode[]) {
    if (!parent || !siblings.length) return;
    const minX = Math.min(...siblings.map((s) => s.x ?? 0)), minY = Math.min(...siblings.map((s) => s.y ?? 0));
    if (minX > 0 || minY > 0) {
      const dx = Math.max(0, minX), dy = Math.max(0, minY);
      parent.x = (parent.x ?? 0) + dx;
      parent.y = (parent.y ?? 0) + dy;
      for (const s of siblings) { s.x = (s.x ?? 0) - dx; s.y = (s.y ?? 0) - dy; }
    }
  }

  /** An edge's label, arrowheads and line, in a panel by its label (or middle). */
  openEdge(src: number) {
    this.close();
    const d = this.doc(), e = d && this.pg(d).edges?.[src], laid = this.board.edgeList().find((x) => x.src === src);
    const pts = laid && this.board.edgePoints(laid);
    if (!e || !laid || !pts) return;
    this.select(null);
    this.selectEdge(src);
    const wx = laid.lx ?? (pts[0] + pts[pts.length - 2]) / 2, wy = laid.ly ?? (pts[1] + pts[pts.length - 1]) / 2;
    const r = this.board.el.getBoundingClientRect(), c = this.board.camera;
    const cx = r.left + (wx - c.x) * c.z, cy = r.top + (wy - c.y) * c.z;
    const p = document.createElement("div");
    p.className = "board-editor board-edge-editor sbb-layer";
    p.innerHTML = `<input class="be-label" placeholder="Label">` +
      `<div class="be-row"><select class="be-arrow" title="Arrowheads"><option value="">→ at the end</option><option value="both">↔ both ends</option><option value="none">— none</option></select>` +
      `<select class="be-line" title="Line"><option value="">solid</option><option value="dotted">dotted</option><option value="thick">thick</option></select>` +
      `<button class="be-rev" title="Point it the other way">⇄</button></div>` +
      `<div class="be-row"><button class="be-del">Delete</button><span></span><button class="be-cancel">Cancel</button><button class="be-done">Done</button></div>`;
    const $ = <T extends HTMLElement>(s: string) => p.querySelector(s) as T;
    $<HTMLInputElement>(".be-label").value = e.label ?? "";
    $<HTMLSelectElement>(".be-arrow").value = e.arrow ?? "";
    $<HTMLSelectElement>(".be-line").value = e.line ?? "";
    let reversed = false;
    $(".be-rev").onclick = () => { reversed = !reversed; $(".be-rev").classList.toggle("on", reversed); };
    const w = Math.min(innerWidth - 16, 320);
    this.place(p, () => {
      p.style.width = w + "px";
      p.style.left = Math.max(8, Math.min(innerWidth - w - 8, cx - w / 2)) + "px";
      p.style.top = Math.max(52, Math.min(innerHeight - 140, cy + 14)) + "px";
    });
    document.body.append(p);
    this.panel = p;
    const done = () => {
      const label = $<HTMLInputElement>(".be-label").value.trim(), arrow = $<HTMLSelectElement>(".be-arrow").value, line = $<HTMLSelectElement>(".be-line").value;
      this.close();
      this.commit((d) => {
        const x = this.pg(d).edges?.[src] as DocEdge | undefined;
        if (!x) return;
        const set = (k: "label" | "arrow" | "line", v: string) => { if (v) (x as any)[k] = v; else delete x[k]; };
        set("label", label);
        set("arrow", arrow);
        set("line", line);
        if (reversed) [x.from, x.to] = [x.to, x.from];
      });
    };
    const del = () => { this.close(); this.deleteEdge(src); };
    $(".be-done").onclick = done;
    $(".be-cancel").onclick = () => this.close();
    $(".be-del").onclick = del;
    p.addEventListener("keydown", (k) => {
      k.stopPropagation();
      if (k.key === "Escape") this.close();
      else if (k.key === "Enter" && !(k.target instanceof HTMLSelectElement)) { k.preventDefault(); done(); }
    });
    $<HTMLInputElement>(".be-label").focus();
  }

  private deleteEdge(src: number) {
    this.selectEdge(null);
    this.commit((d) => { this.pg(d).edges?.splice(src, 1); });
  }

  private dblclick(it: Item | null, x: number, y: number): boolean {
    if (!this.on) return false;
    if (it) { this.open(it.id, false, { x, y }); return true; }
    // a new note where the double click was (at the top level)
    this.addNote(x, y);
    return true;
  }

  /** A new note where (x, y) is (the world; at the top level), being written. */
  addNote(x: number, y: number) {
    const id = "n" + Math.random().toString(36).slice(2, 8);
    // (the others at the top level keep their places)
    return this.commit((d) => { const p = this.pg(d); p.nodes ??= []; this.freeze(d, null, p.nodes); p.nodes.push({ id, title: "", text: "", x: Math.round(x - 130), y: Math.round(y - 30) }); }).then(() => this.open(id, true));
  }

  /** A new empty group where (x, y) is (at the top level): notes are dragged into it. */
  addGroup(x: number, y: number) {
    const id = "g" + Math.random().toString(36).slice(2, 8);
    return this.commit((d) => { const p = this.pg(d); p.nodes ??= []; this.freeze(d, null, p.nodes); p.nodes.push({ id, kind: "group", title: "", children: [], x: Math.round(x - 100), y: Math.round(y - 40) }); }).then(() => this.open(id, true));
  }

  /** A new note with code where (x, y) is (the world; at the top level), its code being written. */
  addCode(x: number, y: number) {
    const id = "c" + Math.random().toString(36).slice(2, 8);
    return this.commit((d) => { const p = this.pg(d); p.nodes ??= []; this.freeze(d, null, p.nodes); p.nodes.push({ id, code: "", x: Math.round(x - 220), y: Math.round(y - 40) }); }).then(() => this.open(id, true));
  }

  /** Show or hide a code item's code (its output stays). */
  toggleCode(id: string) {
    return this.commit((d) => {
      const n = find(this.pg(d), id)?.node as DocNote | undefined;
      if (!n || n.code === undefined) return;
      if (n.hideCode) delete n.hideCode;
      else n.hideCode = true;
    });
  }

  /**
   * Write an item where it is (inplace.ts): its parts become fields in its
   * own element, with a small toolbar over it.  Leaving keeps what was
   * written, as one undo step (with `fresh`, one with adding it).
   */
  open(id: string, fresh = false, at?: { x: number; y: number }) {
    // (already being written: a touch's tap on it selected and its double tap both say so)
    if (this.inplace?.id === id && this.inplace.active) return;
    this.close();
    const s: InPlace = new InPlace(this.host, id, fresh, () => {
      if (this.inplace !== s) return;
      this.inplace = null;
      this.select(this.selected); // (its resize handle back)
    });
    if (!s.start(at)) return;
    this.inplace = s;
    this.select(id);
  }
  // what editing in place needs of the editor
  private get host(): InPlaceHost {
    const ed = this;
    return {
      board: this.board,
      doc: () => this.doc(),
      node: (d, id) => (find(this.pg(d), id)?.node as DocNote | DocGroup | undefined) ?? null,
      commit: (f, merge) => this.commit(f, merge),
      remove: (d, id) => remove(this.pg(d), id),
      run: (id) => this.onRun?.(id),
      highlight: () => this.highlight?.() ?? null,
      get images() { return ed.images; },
    };
  }

  // On a small or touch screen a panel is a sheet: as wide as the screen, at
  // the top of what the keyboard leaves of it (the visual viewport: an
  // iPhone does not resize the page for its keyboard), its buttons first,
  // so that the keyboard never hides them.
  private unplace: (() => void) | null = null;
  private place(p: HTMLElement, desktop: () => void) {
    if (innerWidth >= 600 && !matchMedia("(pointer: coarse)").matches) return desktop();
    p.classList.add("be-sheet");
    const row = p.querySelector(".be-done")?.closest(".be-row");
    if (row) p.prepend(row);
    const vv = window.visualViewport;
    const fit = () => {
      p.style.top = (vv?.offsetTop ?? 0) + "px";
      p.style.maxHeight = (vv?.height ?? innerHeight) + "px";
    };
    fit();
    vv?.addEventListener("resize", fit);
    vv?.addEventListener("scroll", fit);
    this.unplace = () => { vv?.removeEventListener("resize", fit); vv?.removeEventListener("scroll", fit); };
  }

  private close() {
    this.inplace?.end();
    this.unplace?.();
    this.unplace = null;
    this.panel?.remove();
    this.panel = null;
  }

  private key(e: KeyboardEvent) {
    if (!this.isActive()) return;
    if (this.panel || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    // (undo and redo also outside Edit: opening or importing a board replaces it)
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") { e.shiftKey ? this.redo() : this.undo(); }
    else if (mod && e.key.toLowerCase() === "y") this.redo();
    else if (!this.on) return;
    else if ((e.key === "Delete" || e.key === "Backspace") && this.edgeSel !== null) this.deleteEdge(this.edgeSel);
    else if (e.key === "Enter" && this.edgeSel !== null) this.openEdge(this.edgeSel);
    else if (e.key === "Escape" && this.edgeSel !== null) this.selectEdge(null);
    else if ((e.key === "Delete" || e.key === "Backspace") && this.selected.length) this.deleteSelected();
    else if (e.key === "Enter" && this.selected.length === 1) this.open(this.selected[0]);
    else if (mod && e.key.toLowerCase() === "d" && this.selected.length) { const t = this.copied(); if (t) this.insert(t); }
    else if (mod && e.key.toLowerCase() === "a") this.select(this.board.itemsIn(-1e9, -1e9, 1e9, 1e9).filter((it) => !it.parent).map((it) => it.id));
    else if (e.key.startsWith("Arrow") && this.selected.length) { const k = e.shiftKey ? 10 : 1; this.nudge(e.key === "ArrowLeft" ? -k : e.key === "ArrowRight" ? k : 0, e.key === "ArrowUp" ? -k : e.key === "ArrowDown" ? k : 0); }
    else if (e.key === "Escape" && (this.drawing.value || this.erasing.value)) { this.drawing.value = false; this.erasing.value = false; }
    else if (e.key === "Escape" && this.connecting.value) this.connecting.value = false;
    else if (e.key === "Escape" && this.selecting.value && !this.selected.length) this.selecting.value = false;
    else if (e.key === "Escape" && this.selected.length) this.select(null);
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

/** Remove a node (a group with its members) and the edges to and from it. */
export function remove(d: BoardDoc | BoardPage, id: string) {
  const f = find(d, id);
  if (!f) return;
  const gone = new Set(ids(f.node));
  f.siblings.splice(f.siblings.indexOf(f.node), 1);
  d.edges = (d.edges ?? []).filter((e) => !gone.has(e.from) && !gone.has(e.to));
  d.steps = d.steps?.map((s) => ({ ...s, focus: typeof s.focus === "string" ? s.focus : s.focus.filter((x) => !gone.has(x)) })).filter((s) => typeof s.focus !== "string" || !gone.has(s.focus));
}
