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
import { docHead, entryExamples, searchIndex, type DocEntry } from "../docsearch";
import { prepare, type ImageStore, type ImageInfo } from "./images";
import { highlight as highlightPython, highlightMarkdown } from "../notebook/highlight.js";
import { icon } from "./icons";
import { BlockEditor, fitHeight } from "./blocks";
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
  highlight(id: string): ((src: string) => string) | null;
  /** Tab's completions of the code before the caret, in a language (none: Tab indents) */
  complete(mode: string, before: string): Promise<{ matches: string[]; prefix: string } | null>;
  /** the function search's index of a language; none: no search box */
  docs: ((lang: string) => Promise<DocEntry[] | null>) | null;
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
  private headHeight = 0; // (an untitled code item's head, as shown)
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
      // (not a field it doesn't show: an untitled item's first that it does, its detail or link)
      if (first.hidden) first = this.detail ?? this.ref ?? (this.title.hidden = false, this.title);
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
      if (!head.querySelector(":scope > b")) this.headHeight = parseFloat(getComputedStyle(head).height) || 0;
      head.querySelector(":scope > b")?.remove();
      head.insertBefore(this.title, head.querySelector(".board-code-toggle"));
      // (▶ and { } stay where they are, so the title and the code do not
      // move: here they run and hide the code as it is written)
      const run = head.querySelector<HTMLElement>(".board-code-run"), toggle = head.querySelector<HTMLElement>(".board-code-toggle");
      if (run) run.onclick = (e) => { e.stopPropagation(); this.run(); };
      if (toggle) toggle.onclick = (e) => { e.stopPropagation(); this.toggleCode(); };
      for (const b of [run, toggle]) b?.addEventListener("mousedown", (e) => e.preventDefault());
    } else if (!n.title && !this.fresh && (n.text || n.detail || n.ref || this.pic)) {
      // (an item with no title shows none: its field only once + Title asks
      // for it, what it shows staying where it was: its text, picture,
      // detail or link, CORR-9E1-1)
      this.title.hidden = true;
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
    // (no text: none shown where its field would push down what the item
    // shows under it, its code, detail or link, until Enter in its title or
    // + Text asks for it; a new item's shown, to write in, CORR-9E1-1)
    text.hidden = !n.text && (n.code !== undefined || (!this.fresh && !!(n.detail || n.ref)));
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

  /** The language of its code: its own (item 16), else the board's. */
  private language(): string {
    const d = this.host.doc(), n = d && (this.host.node(d, this.id) as DocNote | null);
    return n?.mode ?? d?.mode ?? "python";
  }

  // the code: highlighted under a clear textarea (the board's language once the notebook is loaded)
  private codeField(src: string): HTMLElement {
    const part = document.createElement("div");
    part.className = "be-codepart";
    const box = document.createElement("div");
    box.className = "be-codebox";
    const pre = document.createElement("pre");
    pre.setAttribute("aria-hidden", "true");
    // (its language: the item's own, else the board's; named in the placeholder)
    const lang = this.language();
    const ta = area("be-code", src, `${LANGUAGES[lang] ?? "Python"} (Shift+Enter runs it, and what depends on it)`);
    ta.spellcheck = false;
    ta.setAttribute("autocapitalize", "off");
    ta.setAttribute("autocomplete", "off");
    // (until its language's interpreter is loaded: Python's and Sage's own highlighting; Magma's and MATLAB's text as it is, not as Python)
    const fallback = (s: string) => (lang === "python" || lang === "sage" ? highlightPython(s, lang === "sage") : esc(s));
    const paint = () => { pre.innerHTML = (this.host.highlight(this.id) ?? fallback)(ta.value); };
    ta.addEventListener("input", paint);
    ta.addEventListener("input", () => this.refilter());
    ta.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== ta) this.closeCompleter(); }, 150));
    ta.addEventListener("keydown", (e) => {
      // (the completions listed: ↑/↓ choose, Tab or Enter take one, Esc closes the list, not the item)
      if (this.comp && this.completerKey(e)) return;
      if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        // (after a name or obj.: its completions, as the notebook's Tab; else indent)
        const s0 = ta.selectionStart, before = ta.value.slice(ta.value.lastIndexOf("\n", s0 - 1) + 1, s0);
        if (ta.selectionEnd === s0 && /[\w.]$/.test(before)) { void this.tabComplete(ta, before); return; }
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
  // ---- Tab completion, as the notebook's (web/notebook/notebook.js): the
  // interpreter of the code's language completes the name before the caret;
  // one match, or a longer common prefix, is inserted; several are listed at
  // the caret, filtered as one types.
  // (`matches`: the ones listed, at most SHOWN of those that fit what is
  // typed, `more` the rest: what ↑/↓, Enter and a press choose among is
  // what is shown, astra's UI-7A6-1)
  private comp: { ta: HTMLTextAreaElement; start: number; all: string[]; matches: string[]; more: number; sel: number; dot: number } | null = null;
  private completer: HTMLUListElement | null = null;
  private async tabComplete(ta: HTMLTextAreaElement, before: string) {
    const value = ta.value, pos = ta.selectionStart;
    const m = await this.host.complete(this.language(), before);
    // (stale: the code or the caret moved meanwhile, or the item was left)
    if (this.ended || ta.value !== value || ta.selectionStart !== pos || document.activeElement !== ta || !m?.matches.length) return;
    let common = m.matches[0];
    for (const x of m.matches) while (!x.startsWith(common)) common = common.slice(0, -1);
    if (common.length > m.prefix.length) insertText(ta, common.slice(m.prefix.length));
    if (m.matches.length > 1) {
      this.comp = { ta, start: pos - m.prefix.length, all: m.matches, matches: m.matches.slice(0, SHOWN), more: Math.max(0, m.matches.length - SHOWN), sel: 0, dot: m.prefix.lastIndexOf(".") };
      this.showCompleter();
    }
  }
  private showCompleter() {
    const c = this.comp!;
    const word = c.ta.value.slice(c.start, c.ta.selectionStart), dot = word.lastIndexOf(".") + 1;
    let ul = this.completer;
    if (!ul) {
      ul = this.completer = document.createElement("ul");
      ul.className = "be-completer sbb-layer";
      ul.setAttribute("role", "listbox");
      ul.setAttribute("aria-label", "Completions");
      // (a press on one takes it; the focus stays in the code)
      ul.addEventListener("mousedown", (e) => {
        const li = (e.target as Element).closest("li");
        e.preventDefault();
        if (li?.getAttribute("role") === "option") this.acceptCompletion([...ul!.children].indexOf(li));
      });
      document.body.append(ul);
    }
    ul.replaceChildren(...c.matches.map((m, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.id = `be-comp-${i}`;
      li.setAttribute("aria-selected", String(i === c.sel));
      li.textContent = m.slice(dot);
      return li;
    }));
    if (c.more) {
      const li = document.createElement("li");
      li.className = "be-comp-more";
      li.setAttribute("role", "presentation");
      li.textContent = `${c.more} more: type to narrow`;
      ul.append(li);
    }
    ul.hidden = false;
    c.ta.setAttribute("aria-activedescendant", `be-comp-${c.sel}`);
    const r = caretRect(c.ta);
    ul.style.left = `${Math.max(4, Math.min(r.left, innerWidth - ul.offsetWidth - 4))}px`;
    ul.style.top = `${r.bottom + 2}px`;
    ul.children[c.sel]?.scrollIntoView({ block: "nearest" });
  }
  private closeCompleter() {
    this.comp?.ta.removeAttribute("aria-activedescendant");
    this.comp = null;
    if (this.completer) this.completer.hidden = true;
  }
  private acceptCompletion(i = this.comp?.sel ?? 0) {
    const c = this.comp;
    if (!c) return;
    const word = c.ta.value.slice(c.start, c.ta.selectionStart), m = c.matches[i];
    this.closeCompleter();
    if (m?.startsWith(word)) insertText(c.ta, m.slice(word.length));
  }
  // (the list as the word before the caret changes)
  private refilter() {
    const c = this.comp;
    if (!c) return;
    const word = c.ta.value.slice(c.start, c.ta.selectionStart);
    if (c.ta.selectionStart < c.start || !/^[\w.]*$/.test(word) || word.lastIndexOf(".") !== c.dot) return this.closeCompleter();
    const fit = c.all.filter((m) => m.startsWith(word));
    if (!fit.length) return this.closeCompleter();
    c.matches = fit.slice(0, SHOWN);
    c.more = fit.length - c.matches.length;
    c.sel = Math.min(c.sel, c.matches.length - 1);
    this.showCompleter();
  }
  // (a key while the list shows: true if it was the list's)
  private completerKey(e: KeyboardEvent): boolean {
    const c = this.comp!;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      c.sel = (c.sel + (e.key === "ArrowDown" ? 1 : c.matches.length - 1)) % c.matches.length;
      this.showCompleter();
    } else if ((e.key === "Tab" || e.key === "Enter") && !e.shiftKey) this.acceptCompletion();
    else if (e.key === "Escape") this.closeCompleter();
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
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
    b.append(tool("ip-title", "Add a title", "title", () => this.addPart("title"), true), tool("ip-text", "Add text", "text", () => this.addPart("text"), true));
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
    if (!this.group && this.host.docs) b.append(this.docSearch(this.host.docs));
    // (a press on the toolbar leaves the focus, and the keyboard, where they are)
    b.addEventListener("mousedown", (e) => { if ((e.target as Element).closest("button")) e.preventDefault(); });
    document.body.append(b);
    this.refresh();
  }

  // What the toolbar offers now.
  private refresh() {
    const q = (s: string) => this.bar.querySelector<HTMLElement>(s);
    q(".ip-title")!.hidden = !this.title.hidden;
    // (+ Text for a note whose text isn't shown; a code item's comes with Enter in its title, as before)
    q(".ip-text")!.hidden = !this.text.el.hidden || this.hasCode;
    // (the head's { }: its state, and its tooltip the action it now takes; its
    // name stays "Show the code", pressed while the code shows, as a toggle's
    // name should, WAI-ARIA APG, A11Y-9E1-2)
    const toggle = this.el.querySelector<HTMLElement>(":scope > .board-code-head > .board-code-toggle");
    toggle?.classList.toggle("off", this.hideCode);
    toggle?.setAttribute("aria-pressed", String(!this.hideCode));
    if (toggle) toggle.title = this.hideCode ? "Show the code" : "Hide the code (its output stays)";
    if (!this.group) {
      q(".ip-run")!.hidden = !this.hasCode;
      q(".ip-hide")!.hidden = !this.hasCode;
      q(".ip-hide")!.setAttribute("aria-pressed", String(this.hideCode));
      q(".ip-hide")!.title = this.hideCode ? "Show the code" : "Hide the code: show only its output";
      q(".ip-code")!.hidden = this.hasCode;
      q(".ip-detail")!.hidden = !!this.detail;
      q(".ip-link")!.hidden = !!this.ref;
      q(".ip-image")!.title = this.pic ? "Another picture" : "Add a picture";
      const ds = q(".ip-docs");
      if (ds) ds.hidden = !this.hasCode;
    }
    const s = q(".ip-swatch")!;
    s.style.background = this.color ?? "";
    s.classList.toggle("none", !this.color);
    if (this.color) this.el.style.setProperty("--c", this.color);
    else this.el.style.removeProperty("--c");
  }

  // The function search, as the notebook's (William: while a code item is
  // edited): the functions of its language, by name or what they do; one
  // chosen shows its documentation, and its examples can go into the code.
  private docPanel: HTMLElement | null = null;
  private docSearch(docs: (lang: string) => Promise<DocEntry[] | null>): HTMLElement {
    const box = document.createElement("span");
    box.className = "ip-docs";
    const input = document.createElement("input");
    input.type = "search";
    input.className = "ip-docs-q";
    input.placeholder = "Search functions";
    input.setAttribute("aria-label", "Search the functions of the code's language");
    input.setAttribute("autocomplete", "off");
    input.spellcheck = false;
    const list = document.createElement("ul");
    list.className = "ip-docs-list";
    list.setAttribute("role", "listbox");
    list.hidden = true;
    let found: DocEntry[] = [], sel = 0, seq = 0;
    const mark = () => [...list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === sel)));
    const note = (s: string) => { found = []; list.replaceChildren(Object.assign(document.createElement("li"), { className: "ip-docs-note", textContent: s })); list.hidden = false; };
    const search = async () => {
      const q = input.value.trim(), n = ++seq;
      if (!q) { list.hidden = true; found = []; return; }
      let idx: DocEntry[] | null = null;
      try { idx = await docs(this.language()); } catch { idx = null; }
      // (another search since, Esc or the box left meanwhile: this one is not wanted, astra's CORR-7A6-2)
      if (n !== seq || this.ended || input.value.trim() !== q || document.activeElement !== input) return;
      if (!idx) return note(`No function search for ${LANGUAGES[this.language()] ?? this.language()} here`);
      found = searchIndex(idx, q, 12);
      if (!found.length) return note("No function matches");
      sel = 0;
      list.replaceChildren(...found.map((e) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        const h = document.createElement("code");
        h.textContent = docHead(e);
        const s = document.createElement("span");
        s.textContent = e.summary ?? "";
        li.append(h, s);
        return li;
      }));
      mark();
      list.hidden = false;
    };
    input.addEventListener("input", () => void search());
    input.addEventListener("keydown", (e) => {
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && found.length) {
        e.preventDefault();
        sel = (sel + (e.key === "ArrowDown" ? 1 : found.length - 1)) % found.length;
        mark();
        list.children[sel]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && found[sel]) {
        e.preventDefault();
        this.openDoc(found[sel]);
      } else if (e.key === "Escape" && (!list.hidden || input.value)) {
        // (Esc empties the search first; again, it leaves the item)
        e.preventDefault();
        e.stopPropagation();
        input.value = "";
        seq++;
        list.hidden = true;
        found = [];
      }
    });
    input.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== input) { seq++; list.hidden = true; } }, 150));
    input.addEventListener("focus", () => { if (found.length) list.hidden = false; else if (input.value.trim()) void search(); });
    list.addEventListener("mousedown", (e) => {
      const li = (e.target as Element).closest("li");
      const i = li ? [...list.children].indexOf(li) : -1;
      e.preventDefault();
      if (found[i]) this.openDoc(found[i]);
    });
    box.append(input, list);
    return box;
  }
  // A function's documentation, under the toolbar.
  private openDoc(e: DocEntry) {
    this.docPanel?.remove();
    const p = (this.docPanel = document.createElement("div"));
    p.className = "ip-doc";
    p.setAttribute("role", "dialog");
    p.setAttribute("aria-label", docHead(e));
    const h = document.createElement("code");
    h.className = "ip-doc-head";
    h.textContent = docHead(e);
    const body = document.createElement("pre");
    body.className = "ip-doc-body";
    body.textContent = e.doc || e.summary || "";
    const ex = entryExamples(e), row = document.createElement("div");
    row.className = "ip-doc-row";
    if (ex) {
      const ins = document.createElement("button");
      ins.type = "button";
      ins.className = "ip-doc-insert";
      ins.textContent = "Insert its examples";
      ins.onclick = () => this.insertCode(ex);
      row.append(ins);
    }
    const x = document.createElement("button");
    x.type = "button";
    x.className = "ip-doc-close";
    x.textContent = "Close";
    x.onclick = () => this.closeDoc();
    row.append(x);
    p.append(h, body, row);
    p.addEventListener("keydown", (k) => { if (k.key === "Escape") { k.preventDefault(); k.stopPropagation(); this.closeDoc(); } });
    this.bar.querySelector<HTMLElement>(".ip-docs-list")!.hidden = true;
    this.bar.append(p);
    this.placeDoc();
  }
  // (beside the item, where there is room, so that the code stays in view; else under the toolbar)
  private placeDoc() {
    const p = this.docPanel;
    if (!p) return;
    p.style.width = "";
    const r = this.el.getBoundingClientRect(), b = this.bar.getBoundingClientRect();
    // (on the side with more room, narrower if it must be, down to 300 px)
    const right = innerWidth - r.right - 20, left = r.left - 20, w = Math.min(p.offsetWidth, Math.max(right, left));
    const x = w < 300 ? null : right >= left ? r.right + 12 : r.left - 12 - w;
    if (x === null) { p.style.left = p.style.top = ""; p.style.right = "0"; return; }
    p.style.width = `${w}px`;
    p.style.right = "auto";
    p.style.left = `${x - b.left}px`;
    p.style.top = `${Math.max(clearTop(), Math.min(r.top, innerHeight - p.offsetHeight - 8)) - b.top}px`;
  }
  private closeDoc() {
    this.docPanel?.remove();
    this.docPanel = null;
    if (!this.ended) this.code?.focus({ preventScroll: true });
  }
  // (code put in at the caret, on lines of its own: one undo step of the field)
  private insertCode(src: string) {
    const ta = this.code;
    if (!ta || this.ended) return;
    if (this.hideCode) this.toggleCode();
    ta.focus({ preventScroll: true });
    const k = ta.selectionStart, v = ta.value;
    const pre = k > 0 && v[k - 1] !== "\n" ? "\n" : "", post = k < v.length && v[k] !== "\n" ? "\n" : "";
    insertText(ta, pre + src.replace(/\s+$/, "") + post);
    this.closeDoc();
  }

  private addPart(k: "title" | "text" | "code" | "detail" | "ref") {
    let f: HTMLTextAreaElement | HTMLInputElement;
    if (k === "text") {
      this.text.el.hidden = false;
      this.text.focus("end");
      this.refresh();
      this.fit();
      this.place();
      return;
    }
    if (k === "title") {
      this.title.hidden = false;
      f = this.title;
    } else if (k === "code") {
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
      if (this.el.contains(t) || this.bar.contains(t) || this.completer?.contains(t) || t.closest?.(".sb-fileinput")) return;
      // (its grip drags it, still being written, William's B2)
      if (this.host.board.gripAt(e.clientX, e.clientY, e.pointerType === "touch") === this.id) return;
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
      fitHeight(ta);
    }
    // (an untitled code item's head as tall as it was while its title is empty: the code below stays where it was)
    if (this.headHeight) this.title.style.maxHeight = this.title.value ? "" : this.headHeight + "px";
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
    this.placeDoc();
  }

  // Room for the toolbar above the item or below it, so that it covers
  // nothing of it (on a phone it is under the Edit toolbar): the board moves
  // down only if there is room for it in neither place (William: the text
  // being written stays where it was as editing starts, if it can).
  private room() {
    if (phone()) return;
    const r = this.el.getBoundingClientRect(), bh = this.bar.offsetHeight, need = clearTop() + bh + 8;
    if (r.top < need && r.bottom + 8 + bh > innerHeight) this.host.board.panBy(0, r.top - need);
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

  /** Leave, keeping what is written (a new item left empty is kept too, to
   * be moved and written in later: William's B2); done when it is kept. */
  end(): Promise<void> {
    if (this.ending) return this.ending;
    if (this.ended) return Promise.resolve();
    this.close();
    return (this.ending = (async () => {
      await this.save();
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
    this.completer?.remove();
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

// (the completions listed at most: the notebook's 500)
const SHOWN = 500;
const LANGUAGES: Record<string, string> = { python: "Python", sage: "Sage", magma: "Magma", matlab: "MATLAB" };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function area(cls: string, value: string, placeholder: string) {
  const ta = document.createElement("textarea");
  ta.className = cls;
  ta.rows = 1; // (then as tall as what it holds: fit())
  ta.value = value;
  ta.placeholder = placeholder;
  return ta;
}

// Text put in a field as typed (the field's own undo keeps it).
function insertText(ta: HTMLTextAreaElement, s: string) {
  ta.focus({ preventScroll: true });
  if (!document.execCommand("insertText", false, s)) {
    ta.setRangeText(s, ta.selectionStart, ta.selectionEnd, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

// The caret of a highlighted field, on the page: in its highlighted copy, laid out as its text is.
function caretRect(ta: HTMLTextAreaElement): { left: number; bottom: number } {
  const pre = ta.previousElementSibling, k = ta.selectionStart;
  const fall = ta.getBoundingClientRect();
  if (!(pre instanceof HTMLPreElement)) return { left: fall.left, bottom: fall.bottom };
  const walk = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  let n = 0;
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    const len = t.textContent!.length;
    if (n + len >= k) {
      const r = document.createRange();
      r.setStart(t, k - n);
      r.collapse(true);
      const b = r.getClientRects()[0] ?? r.getBoundingClientRect();
      if (b && (b.left || b.bottom)) return { left: b.left, bottom: b.bottom };
      break;
    }
    n += len;
  }
  return { left: fall.left, bottom: fall.bottom };
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
