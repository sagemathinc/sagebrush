// Editing a board (Edit mode on the board page): drag notes and groups,
// double-click to write a note (or, on the background, to add one),
// shift-drag from one note to another to connect them, Delete, undo and
// redo.  Every change is a change to the document (web/board/doc.ts), laid
// out again: a moved item, and the others in its group, keep the positions
// they have (x and y), so nothing else moves; "Tidy" forgets them all.

import type { Board, Item } from "./board";
import type { BoardDoc, DocGroup, DocNode, DocNote } from "./doc";

interface Found { node: DocNode; parent: DocGroup | null; siblings: DocNode[] }

export function find(doc: BoardDoc, id: string): Found | null {
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
  return walk(doc.nodes, null);
}

function ids(n: DocNode): string[] {
  return n.kind === "group" ? [n.id, ...n.children.flatMap(ids)] : [n.id];
}

/** A copy of the document without positions (automatic layout again). */
export function tidy(doc: BoardDoc): BoardDoc {
  const strip = (n: DocNode): DocNode => {
    const { x: _x, y: _y, ...rest } = n as any;
    return rest.kind === "group" ? { ...rest, children: rest.children.map(strip) } : rest;
  };
  return { ...doc, nodes: doc.nodes.map(strip) };
}

export class Editor {
  on = false;
  private undos: string[] = [];
  private redos: string[] = [];
  private selected: string | null = null;
  private panel: HTMLElement | null = null;

  constructor(private board: Board, private doc: () => BoardDoc | null, private change: (d: BoardDoc) => Promise<void>) {
    board.onItemDown = (it, e) => this.down(it, e);
    board.onDoubleClick = (it, x, y) => this.dblclick(it, x, y);
    addEventListener("keydown", (e) => this.key(e));
  }

  setOn(on: boolean) {
    this.on = on;
    if (!on) { this.select(null); this.close(); }
    this.board.el.classList.toggle("editing", on);
  }

  /** Apply a change made to a copy of the document; undoable. */
  async commit(f: (d: BoardDoc) => void) {
    const cur = this.doc();
    if (!cur) return;
    const before = JSON.stringify(cur), d = JSON.parse(before) as BoardDoc;
    f(d);
    if (JSON.stringify(d) === before) return;
    this.undos.push(before);
    if (this.undos.length > 200) this.undos.shift();
    this.redos = [];
    await this.change(d);
  }
  async undo() {
    const cur = this.doc(), prev = this.undos.pop();
    if (!cur || !prev) return;
    this.redos.push(JSON.stringify(cur));
    await this.change(JSON.parse(prev));
  }
  async redo() {
    const cur = this.doc(), next = this.redos.pop();
    if (!cur || !next) return;
    this.undos.push(JSON.stringify(cur));
    await this.change(JSON.parse(next));
  }

  private select(id: string | null) {
    this.selected = id;
    this.board.select(id);
  }

  // Positions of a container's members as they are now on the board (in
  // its coordinates: a group's members from its inner origin, the top
  // level's in the world), written into the document.
  private freeze(d: BoardDoc, parent: DocGroup | null, siblings: DocNode[]) {
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
            if (!(d.edges ?? []).some((x) => x.from === it.id && x.to === to.id)) (d.edges ??= []).push({ from: it.id, to: to.id });
          });
        }
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
      return true;
    }
    // drag (or, not moved, select)
    const d0 = this.doc(), f = d0 && find(d0, it.id);
    if (!f) return false;
    const moving = ids(f.node);
    let last = { x: e.clientX, y: e.clientY }, dist = 0;
    const move = (m: PointerEvent) => {
      const dx = (m.clientX - last.x) / z(), dy = (m.clientY - last.y) / z();
      dist += Math.abs(m.clientX - last.x) + Math.abs(m.clientY - last.y);
      last = { x: m.clientX, y: m.clientY };
      if (dist > 3) this.board.translate(moving, dx, dy);
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      if (dist <= 3) { this.select(it.id); return; }
      this.select(it.id);
      this.commit((d) => {
        const g = find(d, it.id);
        if (!g) return;
        // (its group's members, and every enclosing group's, keep their
        // places: a group growing moves nothing else)
        this.freeze(d, g.parent, g.siblings);
        for (let p = g.parent; p; ) {
          const pf = find(d, p.id)!;
          this.freeze(d, pf.parent, pf.siblings);
          p = pf.parent;
        }
        // (moved above or left of its group's origin: the group moves out
        // that far, its members back by as much, so it still holds them)
        if (g.parent) {
          const minX = Math.min(0, ...g.siblings.map((s) => s.x ?? 0)), minY = Math.min(0, ...g.siblings.map((s) => s.y ?? 0));
          if (minX < 0 || minY < 0) {
            g.parent.x! += minX;
            g.parent.y! += minY;
            for (const s of g.siblings) { s.x! -= minX; s.y! -= minY; }
          }
        }
      });
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
    return true;
  }

  private dblclick(it: Item | null, x: number, y: number): boolean {
    if (!this.on) return false;
    if (it) { this.open(it.id); return true; }
    // a new note where the double click was (at the top level)
    const id = "n" + Math.random().toString(36).slice(2, 8);
    // (the others at the top level keep their places)
    this.commit((d) => { this.freeze(d, null, d.nodes); d.nodes.push({ id, title: "", text: "", x: Math.round(x - 130), y: Math.round(y - 30) }); }).then(() => this.open(id, true));
    return true;
  }

  /** Write a note or a group's title and text, in a panel over it. */
  open(id: string, fresh = false) {
    this.close();
    const d = this.doc(), f = d && find(d, id), r = this.board.clientRect(id);
    if (!f || !r) return;
    const n = f.node as Omit<DocNote, "kind"> & { kind?: "note" | "group" };
    const p = document.createElement("div");
    p.className = "board-editor";
    p.innerHTML = `<input class="be-title" placeholder="Title"><textarea class="be-text" placeholder="Markdown, with math: $x^2$"></textarea>` +
      (n.kind === "group" ? "" : `<details><summary>Detail, shown zoomed in</summary><textarea class="be-detail"></textarea></details><input class="be-ref" placeholder="Link (https://…)">`) +
      `<div class="be-row"><button class="be-del">Delete</button><span></span><button class="be-cancel">Cancel</button><button class="be-done">Done</button></div>`;
    const $ = <T extends HTMLElement>(s: string) => p.querySelector(s) as T | null;
    $<HTMLInputElement>(".be-title")!.value = n.title ?? "";
    $<HTMLTextAreaElement>(".be-text")!.value = n.text ?? "";
    if ($(".be-detail")) {
      $<HTMLTextAreaElement>(".be-detail")!.value = n.detail ?? "";
      if (n.detail) $<HTMLDetailsElement>("details")!.open = true;
      $<HTMLInputElement>(".be-ref")!.value = n.ref ?? "";
    }
    // over the item, inside the window
    const w = Math.min(innerWidth - 16, Math.max(320, r.width));
    p.style.width = w + "px";
    p.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + "px";
    p.style.top = Math.max(52, Math.min(innerHeight - 330, r.top)) + "px";
    document.body.append(p);
    this.panel = p;
    this.select(id);
    const done = () => {
      const v = (s: string) => ($<HTMLInputElement>(s)?.value ?? "").trim();
      this.close();
      this.commit((d) => {
        const g = find(d, id);
        if (!g) return;
        const m = g.node as any;
        const set = (k: string, val: string) => { if (val) m[k] = val; else delete m[k]; };
        set("title", v(".be-title"));
        set("text", v(".be-text"));
        if (m.kind !== "group") { set("detail", v(".be-detail")); set("ref", v(".be-ref")); }
      });
    };
    const cancel = () => {
      this.close();
      // (a new note left empty: not kept)
      if (fresh && !v0()) this.commit((d) => remove(d, id));
    };
    const v0 = () => ["title", "text"].some((k) => ($<HTMLInputElement>(`.be-${k}`)?.value ?? "").trim());
    $(".be-done")!.onclick = done;
    $(".be-cancel")!.onclick = cancel;
    $(".be-del")!.onclick = () => { this.close(); this.commit((d) => remove(d, id)); };
    p.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") cancel();
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) done();
    });
    (fresh || !n.text ? $<HTMLInputElement>(".be-title") : $<HTMLTextAreaElement>(".be-text"))!.focus();
  }

  private close() {
    this.panel?.remove();
    this.panel = null;
  }

  private key(e: KeyboardEvent) {
    if (!this.on || this.panel || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") { e.shiftKey ? this.redo() : this.undo(); }
    else if (mod && e.key.toLowerCase() === "y") this.redo();
    else if ((e.key === "Delete" || e.key === "Backspace") && this.selected) { const id = this.selected; this.select(null); this.commit((d) => remove(d, id)); }
    else if (e.key === "Enter" && this.selected) this.open(this.selected);
    else if (e.key === "Escape" && this.selected) this.select(null);
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

/** Remove a node (a group with its members) and the edges to and from it. */
export function remove(d: BoardDoc, id: string) {
  const f = find(d, id);
  if (!f) return;
  const gone = new Set(ids(f.node));
  f.siblings.splice(f.siblings.indexOf(f.node), 1);
  d.edges = (d.edges ?? []).filter((e) => !gone.has(e.from) && !gone.has(e.to));
  d.steps = d.steps?.map((s) => ({ ...s, focus: typeof s.focus === "string" ? s.focus : s.focus.filter((x) => !gone.has(x)) })).filter((s) => typeof s.focus !== "string" || !gone.has(s.focus));
}
