// Editing an item where it is (Edit mode: a double-click on it, Enter, or a
// new note).  It stays at its place, its size and its look, and its parts
// become editable there, in the order it shows them:
// - the title, as a title;
// - the picture (✕ takes it off);
// - the text, as blocks: each shown rendered until it is clicked, then its
//   Markdown, highlighted (blocks.ts);
// - the code, in the same box, highlighted; Shift+Enter runs it;
// - the detail and the link, when it has them.
// A small toolbar floats above it (on a phone, above the keyboard): run,
// { } (hide the code), + image, + code, + detail, + link, color, delete.
// There is no Cancel: leaving (a click outside, Esc) keeps what was written,
// and a whole visit is one undo step.  A part left empty is taken off.

import type { Board } from "./board";
import type { BoardDoc, DocGroup, DocNote } from "./doc";
import { prepare, type ImageStore, type ImageInfo } from "./images";
import { highlight as highlightPython, highlightMarkdown } from "../notebook/highlight.js";
import { icon } from "./icons";
import { BlockEditor } from "./blocks";
import { COLORS } from "./colors";

export interface InPlaceHost {
  board: Board;
  doc(): BoardDoc | null;
  /** the item's node, in the page shown of a document */
  node(d: BoardDoc, id: string): DocNote | DocGroup | null;
  /** apply a change (one undo step; with `merge`, one step with the one before): whether an undo step now holds it (null: nothing changed) */
  commit(f: (d: BoardDoc) => void, merge: boolean): Promise<boolean | null>;
  remove(d: BoardDoc, id: string): void;
  /** run a code item (as its code is in the document) */
  run(id: string): void;
  /** the board's code highlighter (its language), once the notebook is loaded */
  highlight(): ((src: string) => string) | null;
  images: ImageStore | null;
}

// a small or touch screen: the toolbar docks above the keyboard
const phone = () => innerWidth < 600 || matchMedia("(pointer: coarse)").matches;

export class InPlace {
  el!: HTMLElement;
  private bar = document.createElement("div");
  private colors: HTMLElement | null = null;
  private group = false;
  private title!: HTMLTextAreaElement;
  private text!: BlockEditor;
  private code: HTMLTextAreaElement | null = null;
  private codePart: HTMLElement | null = null;
  private detail: HTMLTextAreaElement | null = null;
  private ref: HTMLInputElement | null = null;
  private pic: { key: string; info: ImageInfo } | null = null;
  private picEl: HTMLElement | null = null;
  private hasCode = false;
  private hideCode = false;
  private color: string | undefined;
  private stepped = false; // whether this visit has an undo step (what it keeps next joins it)
  private ended = false;
  private ending: Promise<void> | null = null;
  private off: (() => void)[] = [];

  constructor(private host: InPlaceHost, readonly id: string, private fresh: boolean, private onEnd: () => void) {}

  /** Still being edited (not left). */
  get active() { return !this.ended; }

  /** Start editing (`at`: where it was double-clicked, in the world: that part gets the caret); false if the item is not there. */
  start(at?: { x: number; y: number }): boolean {
    const { board } = this.host, d = this.host.doc(), n = d && this.host.node(d, this.id);
    if (!d || !n || !board.item(this.id)) return false;
    // close enough to read and write in (far out, there are no elements at all)
    if (board.camera.z < 0.75) {
      const b = board.bounds([this.id])!, c = board.cameraFor(b.x0, b.y0, b.x1, b.y1, 1);
      board.setCamera(c.z >= 0.75 ? c : { z: 0.9, x: b.x0 - 24 / 0.9, y: b.y0 - (board.insets.top + 24) / 0.9 });
    }
    board.render();
    // (an earlier visit's element, its fields not yet kept: built again from the document)
    if (board.editing === this.id) board.editElement(null);
    const el = board.editElement(this.id);
    if (!el) return false;
    this.el = el;
    // (the caret where it was double-clicked: in its title or code as shown, before they become fields)
    const p = at && this.toClient(at), shown = p ? caretIn(el, p.x, p.y) : null;
    this.group = n.kind === "group";
    const note = n as DocNote;
    this.color = n.color;
    this.hasCode = !this.group && note.code !== undefined;
    this.hideCode = !!note.hideCode;
    if (!this.group && note.image && d.images?.[note.image]) this.pic = { key: note.image, info: d.images[note.image] };
    this.build(note);
    this.toolbar();
    this.listen();
    this.fit();
    // the field to write in: the one double-clicked, where it was; else a
    // code item's code, a new or untitled note's title, or the end of its text
    let first: HTMLTextAreaElement | HTMLInputElement;
    const hit = shown?.part === "title" ? this.title : shown?.part === "code" ? this.code : p ? this.fieldAt(p.x, p.y) : null;
    if (hit === "text" || (!hit && !(this.hasCode && !this.hideCode) && !this.fresh && note.text)) {
      this.text.focus(hit === "text" && p ? p : "end");
      first = this.text.field!;
    } else {
      first = (hit as HTMLTextAreaElement | HTMLInputElement | null) ?? (this.hasCode && !this.hideCode ? this.code! : this.title);
      const k = shown ? Math.min(shown.offset, first.value.length) : (hit && p && caretAt(first, p.x, p.y)) ?? first.value.length;
      first.focus({ preventScroll: true });
      first.setSelectionRange(k, k);
    }
    // (a double tap is followed by its mouse events, whose press takes the
    // focus to where the tap was: given back, in the click, so that a phone's keyboard opens)
    const back = () => { if (!this.ended && !this.el.contains(document.activeElement)) first.focus({ preventScroll: true }); };
    document.addEventListener("click", back, true);
    const unback = () => document.removeEventListener("click", back, true);
    setTimeout(unback, 700);
    this.off.push(unback);
    requestAnimationFrame(() => { this.fit(); this.room(); this.place(); this.reveal(); });
    return true;
  }

  private toClient(w: { x: number; y: number }) {
    const { board } = this.host, r = board.el.getBoundingClientRect(), c = board.camera;
    return { x: r.left + (w.x - c.x) * c.z, y: r.top + (w.y - c.y) * c.z };
  }
  // the field at a point of the page, if any ("text": the blocks)
  private fieldAt(x: number, y: number): HTMLTextAreaElement | HTMLInputElement | "text" | null {
    for (const f of [this.title, this.text.el, this.code, this.detail, this.ref]) {
      const r = f && !f.closest("[hidden]") && f.getBoundingClientRect();
      if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return f === this.text.el ? "text" : (f as HTMLTextAreaElement | HTMLInputElement);
    }
    return null;
  }

  // Its element, its parts made fields: what it keeps (a code item's head,
  // its picture, its output) and fields for the rest, in the order it shows them.
  private build(n: DocNote) {
    const el = this.el;
    el.classList.add("board-editing");
    el.classList.remove("board-picture");
    const head = el.querySelector<HTMLElement>(":scope > .board-code-head");
    const out = el.querySelector<HTMLElement>(":scope > .board-code-out");
    this.title = area("be-title", n.title ?? "", "Title");
    this.title.rows = 1;
    if (head) {
      head.querySelector(":scope > b")?.remove();
      head.insertBefore(this.title, head.querySelector(".board-code-toggle"));
    }
    const { board } = this.host;
    this.text = new BlockEditor(n.text ?? "", {
      render: (s) => board.markdown?.(s) ?? esc(s),
      typeset: board.typeset,
      placeholder: this.group ? "Text (Markdown)" : "Text: Markdown, with math: $x^2$",
      onChange: () => { this.fit(); this.place(); },
    });
    const text = this.text.el;
    text.classList.add("be-text");
    // (a code item without text: none shown, until Enter in its title)
    text.hidden = !n.text && n.code !== undefined;
    const parts: (HTMLElement | null)[] = [head ?? this.title, this.pic ? this.picture() : null, text];
    if (!this.group) {
      parts.push(this.codeField(n.code ?? ""), out);
      if (n.detail) parts.push(this.detailField(n.detail));
      if (n.ref) parts.push(this.refField(n.ref));
    }
    el.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
    if (this.codePart) this.codePart.hidden = !this.hasCode || this.hideCode;
  }

  private picture(): HTMLElement {
    const box = document.createElement("div");
    box.className = "be-pic";
    const img = document.createElement("img");
    img.className = "board-img";
    img.alt = "";
    img.draggable = false;
    img.style.aspectRatio = `${this.pic!.info.w} / ${this.pic!.info.h}`;
    img.src = this.pic!.info.src ?? this.host.images?.url(this.pic!.key) ?? "";
    const x = button("be-unpic", "Remove the picture");
    x.textContent = "✕";
    x.onclick = () => { this.pic = null; this.picEl?.remove(); this.picEl = null; this.save(); };
    box.append(img, x);
    return (this.picEl = box);
  }

  // the code: highlighted under a clear textarea (the board's language once the notebook is loaded)
  private codeField(src: string): HTMLElement {
    const part = document.createElement("div");
    part.className = "be-codepart";
    const box = document.createElement("div");
    box.className = "be-codebox";
    const pre = document.createElement("pre");
    pre.setAttribute("aria-hidden", "true");
    const ta = area("be-code", src, "Python (Shift+Enter runs it, and what depends on it)");
    ta.spellcheck = false;
    ta.setAttribute("autocapitalize", "off");
    ta.setAttribute("autocomplete", "off");
    const paint = () => { pre.innerHTML = (this.host.highlight() ?? ((s: string) => highlightPython(s, false)))(ta.value); };
    ta.addEventListener("input", paint);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        ta.setRangeText("    ", ta.selectionStart, ta.selectionEnd, "end");
        ta.dispatchEvent(new Event("input"));
      } else if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        this.run();
      }
    });
    paint();
    box.append(pre, ta);
    part.append(box);
    this.code = ta;
    return (this.codePart = part);
  }
  private detailField(src: string): HTMLElement {
    this.detail = area("be-detail", src, "Detail, shown when zoomed in (Markdown)");
    const f = markdownField(this.detail);
    f.classList.add("board-detail");
    return f;
  }
  private refField(src: string): HTMLElement {
    const r = document.createElement("input");
    r.className = "be-ref";
    r.value = src;
    r.placeholder = "Link (https://…)";
    r.spellcheck = false;
    this.ref = r;
    return r;
  }

  // The toolbar over the item.
  private toolbar() {
    const b = this.bar;
    b.className = "ip-bar sbb-layer";
    b.setAttribute("role", "toolbar");
    b.setAttribute("aria-label", "This item");
    const tool = (cls: string, label: string, ic: string, f: () => void, plus = false) => {
      const t = button(cls, label);
      if (plus) t.append(Object.assign(document.createElement("span"), { className: "ip-plus", textContent: "+" }));
      t.append(icon(ic)!);
      t.onclick = f;
      return t;
    };
    const sw = button("ip-color", "Color");
    sw.append(Object.assign(document.createElement("span"), { className: "ip-swatch" }));
    sw.onclick = () => this.palette();
    if (!this.group) {
      b.append(
        tool("ip-run", "Run (Shift+Enter), and what depends on it", "run", () => this.run()),
        tool("ip-hide", "Hide the code: show only its output", "code", () => this.toggleCode()),
        tool("ip-image", this.pic ? "Another picture" : "Add a picture", "image", () => this.choosePicture(), true),
        tool("ip-code", "Add code", "code", () => this.addPart("code"), true),
        tool("ip-detail", "Add a detail, shown when zoomed in", "detail", () => this.addPart("detail"), true),
        tool("ip-link", "Add a link", "link", () => this.addPart("ref"), true),
      );
    }
    b.append(sw, tool("ip-delete", "Delete", "trash", () => this.del()));
    // (a press on the toolbar leaves the focus, and the keyboard, where they are)
    b.addEventListener("mousedown", (e) => { if ((e.target as Element).closest("button")) e.preventDefault(); });
    document.body.append(b);
    this.refresh();
  }

  // What the toolbar offers now.
  private refresh() {
    const q = (s: string) => this.bar.querySelector<HTMLElement>(s);
    if (!this.group) {
      q(".ip-run")!.hidden = !this.hasCode;
      q(".ip-hide")!.hidden = !this.hasCode;
      q(".ip-hide")!.setAttribute("aria-pressed", String(this.hideCode));
      q(".ip-hide")!.title = this.hideCode ? "Show the code" : "Hide the code: show only its output";
      q(".ip-code")!.hidden = this.hasCode;
      q(".ip-detail")!.hidden = !!this.detail;
      q(".ip-link")!.hidden = !!this.ref;
      q(".ip-image")!.title = this.pic ? "Another picture" : "Add a picture";
    }
    const s = q(".ip-swatch")!;
    s.style.background = this.color ?? "";
    s.classList.toggle("none", !this.color);
    if (this.color) this.el.style.setProperty("--c", this.color);
    else this.el.style.removeProperty("--c");
  }

  private addPart(k: "code" | "detail" | "ref") {
    let f: HTMLTextAreaElement | HTMLInputElement;
    if (k === "code") {
      this.hasCode = true;
      // (a code item now: its state and output show in it once it runs, board.ts codeStates)
      this.el.dataset.code = this.id;
      this.hideCode = false;
      this.codePart!.hidden = false;
      f = this.code!;
    } else if (k === "detail") {
      if (!this.detail) {
        const f = this.detailField(""), r = this.el.querySelector(":scope > .be-ref");
        if (r) r.before(f);
        else this.el.append(f);
      }
      f = this.detail!;
    } else {
      if (!this.ref) this.el.append(this.refField(""));
      f = this.ref!;
    }
    this.refresh();
    f.focus();
    this.fit();
    this.place();
  }

  private toggleCode() {
    this.hideCode = !this.hideCode;
    this.codePart!.hidden = this.hideCode;
    this.refresh();
    // (shown again: as tall as its code; it could not be measured hidden)
    this.fit();
    this.place();
    this.save();
  }

  private palette() {
    if (this.colors) { this.colors.remove(); this.colors = null; return; }
    const p = document.createElement("div");
    p.className = "ip-colors";
    p.setAttribute("role", "group");
    p.setAttribute("aria-label", "Color");
    for (const [name, c] of [["None", ""], ...COLORS] as [string, string][]) {
      const s = button("ip-c" + (c ? "" : " none"), name);
      if (c) s.style.background = c;
      s.setAttribute("aria-pressed", String((this.color ?? "") === c));
      s.onclick = () => {
        this.color = c || undefined;
        p.remove();
        this.colors = null;
        this.refresh();
        this.save();
      };
      p.append(s);
    }
    this.bar.append(p);
    this.colors = p;
  }

  private choosePicture() {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp" });
    input.className = "sb-fileinput";
    input.style.cssText = "position:fixed;left:-9999px";
    input.onchange = async () => {
      input.remove();
      const f = input.files?.[0], ready = f ? await prepare(f) : null;
      if (!ready || !this.host.images || this.ended) return;
      this.pic = { key: await this.host.images.put(ready.blob), info: { w: ready.w, h: ready.h } };
      const old = this.picEl;
      const box = this.picture();
      if (old) old.replaceWith(box);
      else this.text.el.before(box);
      this.refresh();
      this.save();
      this.place();
    };
    // (one at most: a chooser cancelled earlier left its input behind)
    for (const old of document.querySelectorAll("input.sb-fileinput")) old.remove();
    document.body.append(input);
    input.click();
  }

  private listen() {
    const on = <K extends keyof DocumentEventMap>(t: EventTarget, type: K | string, f: (e: any) => void, capture = false) => {
      t.addEventListener(type, f, capture);
      this.off.push(() => t.removeEventListener(type, f, capture));
    };
    // leaving: a press anywhere else (or Esc)
    on(document, "pointerdown", (e: PointerEvent) => {
      const t = e.target as Element;
      if (this.el.contains(t) || this.bar.contains(t) || t.closest?.(".sb-fileinput")) return;
      this.end();
    }, true);
    const keys = (e: KeyboardEvent) => {
      // (the board's and the page's keys are not for these fields)
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); this.end(); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.end(); }
      else if (e.key === "Enter" && e.target === this.title && !e.shiftKey) {
        e.preventDefault();
        this.text.el.hidden = false;
        this.text.focus("start");
        this.fit();
      }
    };
    on(this.el, "keydown", keys);
    on(this.bar, "keydown", keys);
    on(this.el, "input", () => { this.fit(); this.place(); });
    on(this.el, "focusin", () => this.reveal());
    const vv = window.visualViewport;
    if (vv) for (const t of ["resize", "scroll"]) on(vv, t, () => { this.place(); this.reveal(); });
    on(window, "resize", () => this.place());
  }

  /** Fields as tall as what they hold. */
  private fit() {
    for (const ta of this.el.querySelectorAll<HTMLTextAreaElement>("textarea")) {
      // (a hidden field has no height to measure: measured when it shows)
      if (!ta.offsetParent) continue;
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
    }
  }

  /** The toolbar above the item (below it if there is no room), or, on a
   * phone, a thin row right under the Edit toolbar (William: the keyboard and
   * the toolbars filled the screen), within what the keyboard leaves. */
  place() {
    if (this.ended) return;
    const b = this.bar, vv = window.visualViewport;
    if (phone()) {
      b.classList.add("ip-dock");
      const tb = document.querySelector(".board-toolbar:not([hidden])")?.getBoundingClientRect();
      const L = vv?.offsetLeft ?? 0, W = vv?.width ?? innerWidth, bw = b.offsetWidth;
      const mid = tb ? tb.left + tb.width / 2 : L + W / 2;
      b.style.top = Math.round(Math.max(tb ? tb.bottom : 48, vv?.offsetTop ?? 0)) + "px";
      b.style.left = Math.round(Math.max(L, Math.min(L + W - bw, mid - bw / 2))) + "px";
      return;
    }
    const r = this.el.getBoundingClientRect(), bw = b.offsetWidth, bh = b.offsetHeight, top0 = clearTop();
    let top = r.top - bh - 8;
    if (top < top0) top = r.bottom + 8 + bh <= innerHeight ? r.bottom + 8 : top0;
    b.style.top = Math.round(Math.min(top, innerHeight - bh - 8)) + "px";
    b.style.left = Math.round(Math.max(8, Math.min(innerWidth - bw - 8, r.left))) + "px";
  }

  // Room for the toolbar above the item, so that it covers nothing of it
  // (on a phone it is under the Edit toolbar): the board moves down if need be.
  private room() {
    if (phone()) return;
    const top = this.el.getBoundingClientRect().top, need = clearTop() + this.bar.offsetHeight + 8;
    if (top < need) this.host.board.panBy(0, top - need);
    this.host.board.render();
  }

  // The field being written in, in view: below the top bar, the Edit
  // toolbar (and on a phone the item's), above the keyboard, within the sides.
  private reveal() {
    const a = document.activeElement;
    if (this.ended || !(a instanceof HTMLElement) || !this.el.contains(a)) return;
    // (on a phone, below the item's toolbar, under the Edit toolbar)
    const vv = window.visualViewport, top = Math.max((vv?.offsetTop ?? 0) + 48, clearTop(), phone() ? this.bar.getBoundingClientRect().bottom + 6 : 0);
    const bottom = (vv ? vv.offsetTop + vv.height : innerHeight) - 8;
    const left = (vv?.offsetLeft ?? 0) + 8, right = (vv ? vv.offsetLeft + vv.width : innerWidth) - 8;
    const r = a.getBoundingClientRect(), need = Math.min(r.height, 48);
    const dy = r.top < top ? r.top - top : r.top + need > bottom ? r.top + need - bottom : 0;
    const dx = r.left < left ? r.left - left : r.right > right && r.width <= right - left ? r.right - right : 0;
    if (dx || dy) this.host.board.panBy(dx, dy);
  }

  // What the fields say, written into its node.
  private apply(d: BoardDoc, n: any) {
    const v = (el: HTMLInputElement | HTMLTextAreaElement | null) => (el?.value ?? "").trim();
    const set = (k: string, val: string | boolean | undefined) => { if (val) n[k] = val; else delete n[k]; };
    set("title", v(this.title));
    set("text", this.text.value.trim());
    set("color", this.color);
    if (this.group) return;
    set("image", this.pic?.key);
    if (this.pic) (d.images ??= {})[this.pic.key] ??= { w: this.pic.info.w, h: this.pic.info.h };
    const c = this.codeNow();
    set("code", c || undefined);
    set("hideCode", !!c && this.hideCode);
    set("detail", v(this.detail));
    set("ref", v(this.ref));
  }
  // (code left empty: no code)
  private codeNow() { return this.hasCode ? this.code!.value.replace(/\s+$/, "") : ""; }
  private empty() { return !this.pic && !this.title.value.trim() && !this.text.value.trim() && !this.codeNow(); }

  /** Keep what is written: the visit's undo step, or part of it. */
  private async save() {
    const r = await this.host.commit((d) => { const n = this.host.node(d, this.id); if (n) this.apply(d, n); }, this.fresh || this.stepped);
    if (r !== null) this.stepped = r;
  }

  /** Run its code as it is written (Shift+Enter, ▶): kept, then run. */
  async run() {
    if (!this.hasCode) return;
    const d = this.host.doc(), before = d && (this.host.node(d, this.id) as DocNote | null)?.code, c = this.codeNow();
    await this.save();
    // (changed code runs as the board is laid out again; unchanged, it is run here)
    if (c && c === before) this.host.run(this.id);
  }

  private del() {
    this.close();
    this.ending = (async () => {
      await this.host.commit((d) => this.host.remove(d, this.id), this.fresh || this.stepped);
      this.finish();
    })();
  }

  /** Leave, keeping what is written (a new item left empty is not kept); done when it is kept. */
  end(): Promise<void> {
    if (this.ending) return this.ending;
    if (this.ended) return Promise.resolve();
    this.close();
    return (this.ending = (async () => {
      if (this.fresh && this.empty()) await this.host.commit((d) => this.host.remove(d, this.id), true);
      else await this.save();
      this.finish();
    })());
  }

  /** Leave without keeping anything (the item is gone: undone, or removed by someone else). */
  abandon() {
    if (this.ended) return;
    this.close();
    this.finish();
  }

  private close() {
    this.ended = true;
    for (const f of this.off) f();
    this.off = [];
    this.bar.remove();
    for (const ta of this.el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input")) ta.readOnly = true;
  }
  // (its element is built again from the document)
  private finish() {
    if (this.host.board.editingElement === this.el) this.host.board.editElement(null);
    this.onEnd();
  }
}

// Where the board is clear of the top bar and the Edit toolbar (page coordinates).
const clearTop = () => Math.max(48, document.querySelector(".board-toolbar:not([hidden])")?.getBoundingClientRect().bottom ?? 0) + 6;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function area(cls: string, value: string, placeholder: string) {
  const ta = document.createElement("textarea");
  ta.className = cls;
  ta.rows = 1; // (then as tall as what it holds: fit())
  ta.value = value;
  ta.placeholder = placeholder;
  return ta;
}

function button(cls: string, label: string) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.title = label;
  b.setAttribute("aria-label", label);
  return b;
}

// The text position under a point of the page, and its place in the text
// of `within` (null if the point is not on its text).
function caretPoint(within: Element, x: number, y: number): number | null {
  const doc = document as any;
  const at: { node: Node; offset: number } | null = doc.caretPositionFromPoint
    ? (({ offsetNode, offset }: any = doc.caretPositionFromPoint(x, y) ?? {}) => (offsetNode ? { node: offsetNode, offset } : null))()
    : (({ startContainer, startOffset }: any = doc.caretRangeFromPoint?.(x, y) ?? {}) => (startContainer ? { node: startContainer, offset: startOffset } : null))();
  if (!at || !within.contains(at.node) || at.node.nodeType !== Node.TEXT_NODE) return null;
  let k = 0;
  const walk = document.createTreeWalker(within, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t && t !== at.node; t = walk.nextNode()) k += t.textContent!.length;
  return k + at.offset;
}
// ...in an item as shown: its title's or its code's (their text is the field's)
function caretIn(el: HTMLElement, x: number, y: number): { part: "title" | "code"; offset: number } | null {
  for (const [part, sel] of [["title", ":scope > b, :scope > .board-code-head > b"], ["code", ":scope > .board-code-src"]] as const) {
    // (a title with math typeset is not its source's text: no place in it)
    const e = el.querySelector(sel), k = e && !e.querySelector(".math") ? caretPoint(e, x, y) : null;
    if (k !== null) return { part, offset: k };
  }
  return null;
}
// ...in a highlighted field, from its highlighted copy, laid out as its text is
function caretAt(f: HTMLTextAreaElement | HTMLInputElement, x: number, y: number): number | null {
  const pre = f.previousElementSibling;
  if (!(pre instanceof HTMLPreElement)) return null;
  pre.style.pointerEvents = "auto";
  f.style.pointerEvents = "none";
  const k = caretPoint(pre, x, y);
  pre.style.pointerEvents = "";
  f.style.pointerEvents = "";
  return k === null ? null : Math.min(f.value.length, k);
}

// A Markdown field, highlighted: its text, coloured, under the textarea,
// whose own text is clear (only its caret and selection show).  Colours only,
// so the two keep the same widths.
export function markdownField(ta: HTMLTextAreaElement): HTMLElement {
  const box = document.createElement("div");
  box.className = "be-md";
  const pre = document.createElement("pre");
  pre.setAttribute("aria-hidden", "true");
  box.append(pre, ta);
  const paint = () => {
    pre.innerHTML = highlightMarkdown(ta.value, false);
    pre.scrollTop = ta.scrollTop;
  };
  ta.addEventListener("input", paint);
  ta.addEventListener("scroll", () => { pre.scrollTop = ta.scrollTop; });
  paint();
  return box;
}
