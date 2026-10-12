// Editing a board (Edit mode on the board page): drag notes and groups
// (into another group, or out of one, by letting go there), double-click to
// write a note (or, on the background, to add one), shift-drag from one note
// to another to connect them; click an edge to select it, double-click it
// (or Enter) for its label, arrowheads and line; Delete, undo and redo.
// Every change is a change to the document (web/board/doc.ts), laid out
// again: a moved item, and the others in its group, keep the positions they
// have (x and y), so nothing else moves; "Tidy" forgets them all.

import { effect, signal } from "@preact/signals-core";
import type { Board, Item } from "./board";
import type { BoardDoc, BoardPage, DocEdge, DocGroup, DocNode, DocNote } from "./doc";

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
  private connectFrom: string | null = null;
  get on() { return this.editing.value; }
  private undos: string[] = [];
  private redos: string[] = [];
  private selected: string | null = null;
  private edgeSel: number | null = null; // the selected edge: its index in the page's edges
  private panel: HTMLElement | null = null;
  /** Run a code item (its code is as it was: a changed one runs as the board is laid out again) */
  onRun: ((id: string) => void) | null = null;

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
    addEventListener("keydown", (e) => this.key(e));
    effect(() => {
      const on = this.editing.value;
      if (!on) { this.select(null); this.close(); this.connecting.value = false; }
      this.board.el.classList.toggle("editing", on);
    });
    effect(() => {
      this.board.el.classList.toggle("connecting", this.connecting.value);
      if (!this.connecting.value && this.connectFrom) { this.connectFrom = null; this.select(null); }
    });
  }

  setOn(on: boolean) {
    this.editing.value = on;
  }

  /** Apply a change made to a copy of the document; undoable (with `merge`,
   * one step with the change before it: a new note and its first text). */
  async commit(f: (d: BoardDoc) => void, merge = false) {
    const cur = this.doc();
    if (!cur) return;
    const before = JSON.stringify(cur), d = JSON.parse(before) as BoardDoc;
    f(d);
    const after = JSON.stringify(d);
    if (after === before) return;
    if (!merge || !this.undos.length) this.undos.push(before);
    // (merged back to where it started: no step at all)
    else if (this.undos.at(-1) === after) this.undos.pop();
    if (this.undos.length > 200) this.undos.shift();
    this.redos = [];
    await this.change(d);
    this.selectEdge(this.edgeSel);
  }
  async undo() {
    const cur = this.doc(), prev = this.undos.pop();
    if (!cur || !prev) return;
    this.redos.push(JSON.stringify(cur));
    this.selectEdge(null);
    await this.change(JSON.parse(prev));
  }
  async redo() {
    const cur = this.doc(), next = this.redos.pop();
    if (!cur || !next) return;
    this.undos.push(JSON.stringify(cur));
    this.selectEdge(null);
    await this.change(JSON.parse(next));
  }

  /** Nothing selected, no note open (another page is shown). */
  clear() { this.select(null); this.selectEdge(null); this.close(); }
  private select(id: string | null) {
    this.selected = id;
    this.board.select(id);
    if (id) this.selectEdge(null);
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
    if (e.shiftKey && it.kind === "note") {
      // connect: a dashed line to the pointer, an edge where it is let go
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
        }
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
      return true;
    }
    // drag (or, not moved, select)
    const d0 = this.doc(), f = d0 && find(this.pg(d0), it.id);
    if (!f) return false;
    const moving = ids(f.node), self = new Set(moving);
    const from = f.parent?.id ?? null;
    // (where it would go if let go here: the innermost group under the
    // pointer, not itself or inside it; or the top level)
    const targetAt = (cx: number, cy: number) => { const w = this.board.toWorld(cx, cy); return this.board.groupsAt(w.x, w.y, self)[0]?.id ?? null; };
    let last = { x: e.clientX, y: e.clientY }, dist = 0;
    const move = (m: PointerEvent) => {
      const dx = (m.clientX - last.x) / z(), dy = (m.clientY - last.y) / z();
      dist += Math.abs(m.clientX - last.x) + Math.abs(m.clientY - last.y);
      last = { x: m.clientX, y: m.clientY };
      if (dist > 3) {
        this.board.translate(moving, dx, dy);
        const t = targetAt(m.clientX, m.clientY);
        this.board.dropTarget = t !== from ? t : null;
      }
    };
    const up = (u: PointerEvent) => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      this.board.dropTarget = null;
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
    p.className = "board-editor board-edge-editor";
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
    // (a code item's code is edited in any mode, as a notebook's cells are)
    if (!this.on) {
      if (it?.code === undefined) return false;
      this.open(it.id);
      return true;
    }
    if (it) { this.open(it.id); return true; }
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

  /** A new code item where (x, y) is (the world; at the top level), its code being written. */
  addCode(x: number, y: number) {
    const id = "c" + Math.random().toString(36).slice(2, 8);
    return this.commit((d) => { const p = this.pg(d); p.nodes ??= []; this.freeze(d, null, p.nodes); p.nodes.push({ id, kind: "code", code: "", x: Math.round(x - 220), y: Math.round(y - 40) }); }).then(() => this.open(id, true));
  }

  /** Write a note or a group's title and text (a code item's code), in a panel over it. */
  open(id: string, fresh = false) {
    this.close();
    const d = this.doc(), f = d && find(this.pg(d), id), r = this.board.clientRect(id);
    if (!f || !r) return;
    const n = f.node as Omit<DocNote, "kind"> & { kind?: "note" | "group" | "code" };
    const code = n.kind === "code";
    const p = document.createElement("div");
    p.className = "board-editor" + (code ? " board-code-editor" : "");
    p.innerHTML = `<input class="be-title" placeholder="Title"><textarea class="be-text" placeholder="Markdown, with math: $x^2$"></textarea>` +
      (n.kind === "group" ? "" : `<details><summary>Detail, shown zoomed in</summary><textarea class="be-detail"></textarea></details><input class="be-ref" placeholder="Link (https://…)">`) +
      `<div class="be-row"><button class="be-del">Delete</button><span></span><button class="be-cancel">Cancel</button><button class="be-done">${code ? "Run" : "Done"}</button></div>`;
    const $ = <T extends HTMLElement>(s: string) => p.querySelector(s) as T | null;
    $<HTMLInputElement>(".be-title")!.value = n.title ?? "";
    $<HTMLTextAreaElement>(".be-text")!.value = n.text ?? "";
    if (code) {
      // its code first; its text (Markdown, above the code) is a caption
      const ta = document.createElement("textarea");
      ta.className = "be-code";
      ta.placeholder = "Python (Shift+Enter runs it, and what depends on it)";
      ta.spellcheck = false;
      ta.value = n.code ?? "";
      ta.addEventListener("keydown", (e) => {
        if (e.key !== "Tab" || e.shiftKey) return;
        e.preventDefault();
        ta.setRangeText("    ", ta.selectionStart, ta.selectionEnd, "end");
      });
      $(".be-title")!.after(ta);
      $<HTMLTextAreaElement>(".be-text")!.placeholder = "Text above the code (Markdown, with math)";
      $<HTMLTextAreaElement>(".be-text")!.rows = 2;
    }
    if ($(".be-detail")) {
      $<HTMLTextAreaElement>(".be-detail")!.value = n.detail ?? "";
      if (n.detail) $<HTMLDetailsElement>("details")!.open = true;
      $<HTMLInputElement>(".be-ref")!.value = n.ref ?? "";
    }
    // over the item, inside the window
    const w = Math.min(innerWidth - 16, Math.max(320, r.width));
    this.place(p, () => {
      p.style.width = w + "px";
      p.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + "px";
      p.style.top = Math.max(52, Math.min(innerHeight - 330, r.top)) + "px";
    });
    document.body.append(p);
    this.panel = p;
    this.select(id);
    const done = () => {
      const v = (s: string) => ($<HTMLInputElement>(s)?.value ?? "").trim();
      if (code && ($<HTMLTextAreaElement>(".be-code")?.value ?? "").replace(/\s+$/, "") === (n.code ?? "")) this.onRun?.(id);
      this.close();
      this.commit((d) => {
        const g = find(this.pg(d), id);
        if (!g) return;
        const m = g.node as any;
        const set = (k: string, val: string) => { if (val) m[k] = val; else delete m[k]; };
        set("title", v(".be-title"));
        set("text", v(".be-text"));
        if (m.kind === "code") m.code = ($<HTMLTextAreaElement>(".be-code")?.value ?? "").replace(/\s+$/, "");
        if (m.kind !== "group") { set("detail", v(".be-detail")); set("ref", v(".be-ref")); }
      }, fresh);
    };
    const cancel = () => {
      this.close();
      // (a new note left empty: not kept)
      if (fresh && !v0()) this.commit((d) => remove(this.pg(d), id), true);
    };
    const v0 = () => ["title", "text", "code"].some((k) => ($<HTMLInputElement>(`.be-${k}`)?.value ?? "").trim());
    $(".be-done")!.onclick = done;
    $(".be-cancel")!.onclick = cancel;
    $(".be-del")!.onclick = () => { this.close(); this.commit((d) => remove(this.pg(d), id)); };
    p.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") cancel();
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey || (code && e.shiftKey))) { e.preventDefault(); done(); }
    });
    (code ? $<HTMLTextAreaElement>(".be-code") : fresh || !n.text ? $<HTMLInputElement>(".be-title") : $<HTMLTextAreaElement>(".be-text"))!.focus();
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
    this.unplace?.();
    this.unplace = null;
    this.panel?.remove();
    this.panel = null;
  }

  private key(e: KeyboardEvent) {
    if (this.panel || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    // (undo and redo also outside Edit: opening or importing a board replaces it)
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") { e.shiftKey ? this.redo() : this.undo(); }
    else if (mod && e.key.toLowerCase() === "y") this.redo();
    else if (!this.on) return;
    else if ((e.key === "Delete" || e.key === "Backspace") && this.edgeSel !== null) this.deleteEdge(this.edgeSel);
    else if (e.key === "Enter" && this.edgeSel !== null) this.openEdge(this.edgeSel);
    else if (e.key === "Escape" && this.edgeSel !== null) this.selectEdge(null);
    else if ((e.key === "Delete" || e.key === "Backspace") && this.selected) { const id = this.selected; this.select(null); this.commit((d) => remove(this.pg(d), id)); }
    else if (e.key === "Enter" && this.selected) this.open(this.selected);
    else if (e.key === "Escape" && this.connecting.value) this.connecting.value = false;
    else if (e.key === "Escape" && this.selected) this.select(null);
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
