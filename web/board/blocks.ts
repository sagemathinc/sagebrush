// A Markdown text edited as blocks, as in Notion, without contenteditable:
// the text is a list of blocks (paragraphs, headings, list items, quotes,
// display math, fenced code), each shown rendered (the host's safe Markdown
// renderer, and KaTeX) until it is clicked.  Then it is its own Markdown, in
// a clear textarea over its highlighted copy, sized to fit, where it was.
// - Enter at the end of a block starts another (a list item, the next item;
//   an empty item ends the list); Shift+Enter is a new line in the block.
// - Backspace at the start joins a block to the one before (the first loses
//   its marker: a heading, an item or a quote becomes a paragraph); Delete
//   at the end joins the next one to it.
// - The arrows cross from block to block, keeping the caret's column.
// - What a block is follows its Markdown: "# " or "- " at its start makes it
//   a heading or a list item as it is typed.
// - A paste is text (Markdown or plain), never HTML.
// The Markdown stays the document: blocks are cut from it, with the space
// between them, and joined back exactly; there is no model to convert back.
// Nothing here is the board's: the notebook's Markdown cells can use it.

import { highlightMarkdown } from "../notebook/highlight.js";
import css from "./blocks.css" with { type: "text" };

// (its stylesheet, once a page, first: the page's own rules win)
function addStyle() {
  if (document.querySelector("style[data-mb]")) return;
  const s = document.createElement("style");
  s.dataset.mb = "";
  s.textContent = css;
  document.head.prepend(s);
}

export type BlockKind = "paragraph" | "heading" | "item" | "quote" | "math" | "code";

/** A block's Markdown, and the space after it (before the next block; "" for the last). */
export interface Block { src: string; sep: string }

const BLANK = /^[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MATH = /^ {0,3}(\$\$|\\\[)/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
const QUOTE = /^ {0,3}>/;
const starts = (l: string) => FENCE.test(l) || MATH.test(l) || HEADING.test(l) || ITEM.test(l) || QUOTE.test(l);

/** What a block is, from its first line. */
export function kindOf(src: string): BlockKind {
  const l = src.split("\n", 1)[0];
  return FENCE.test(l) ? "code" : MATH.test(l) ? "math" : HEADING.test(l) ? "heading" : ITEM.test(l) ? "item" : QUOTE.test(l) ? "quote" : "paragraph";
}

/** A Markdown text as blocks (blank lines before the first and after the last are left out). */
export function splitBlocks(text: string): Block[] {
  const lines = text.split("\n"), out: Block[] = [];
  let i = 0;
  while (i < lines.length && BLANK.test(lines[i])) i++;
  while (i < lines.length) {
    const l = lines[i];
    let j = i; // the block's last line
    const fence = FENCE.exec(l);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1][0] === "`" ? "`" : "~"}{${fence[1].length},}[ \\t]*$`);
      for (j = i + 1; j < lines.length && !close.test(lines[j]); j++);
      j = Math.min(j, lines.length - 1);
    } else if (MATH.test(l)) {
      const open = MATH.exec(l)!, rest = l.slice(open[0].length), end = open[1] === "$$" ? "$$" : "\\]";
      if (!rest.includes(end)) for (j = i + 1; j < lines.length && !lines[j].includes(end); j++);
      j = Math.min(j, lines.length - 1);
    } else if (HEADING.test(l)) {
      j = i;
    } else if (ITEM.test(l)) {
      // (its continuation lines, up to a blank line or the next block)
      while (j + 1 < lines.length && !BLANK.test(lines[j + 1]) && !starts(lines[j + 1])) j++;
    } else if (QUOTE.test(l)) {
      while (j + 1 < lines.length && QUOTE.test(lines[j + 1])) j++;
    } else {
      while (j + 1 < lines.length && !BLANK.test(lines[j + 1]) && !starts(lines[j + 1])) j++;
    }
    let k = j + 1;
    while (k < lines.length && BLANK.test(lines[k])) k++;
    // (the space between: its newlines, and what blank lines hold)
    out.push({ src: lines.slice(i, j + 1).join("\n"), sep: k < lines.length ? "\n" + lines.slice(j + 1, k).map((b) => b + "\n").join("") : "" });
    i = k;
  }
  return out;
}

// (at least one block: an empty text is one empty block)
const splitOne = (text: string): Block[] => { const b = splitBlocks(text); return b.length ? b : [{ src: "", sep: "" }]; };

export function joinBlocks(bs: Block[]): string {
  return bs.map((b, i) => b.src + (i < bs.length - 1 ? b.sep : "")).join("");
}

// a block's marker: "# ", "- ", "1. ", "> " (null if it has none)
function marker(src: string): string | null {
  const m = /^ {0,3}#{1,6}[ \t]*/.exec(src) ?? ITEM.exec(src) ?? /^ {0,3}>[ \t]?/.exec(src);
  return m ? m[0] : null;
}
// the marker of the item after this one: "- " again, or the next number
function nextItem(src: string): string {
  const m = ITEM.exec(src)!, n = /^(\d+)([.)])$/.exec(m[2]);
  return m[1] + (n ? `${+n[1] + 1}${n[2]}` : m[2]) + " ";
}

// A field as tall as its lines, exactly: scrollHeight is a whole number of
// pixels, and what is below the field would move by its rounding as editing starts.
export function fitHeight(ta: HTMLTextAreaElement) {
  ta.style.height = "auto";
  const cs = getComputedStyle(ta), lh = parseFloat(cs.lineHeight), h = ta.scrollHeight;
  const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const border = cs.boxSizing === "border-box" ? parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) : 0;
  ta.style.height = (lh > 0 ? Math.max(1, Math.round((h - pad) / lh)) * lh + pad + border : h) + "px";
}

export interface BlockEditorOptions {
  /** Markdown to HTML: the host's safe renderer (this never renders markup itself) */
  render: (src: string) => string;
  /** math in rendered blocks (KaTeX), if any */
  typeset?: ((el: HTMLElement) => void) | null;
  /** the source's highlighting (HTML of escaped text); Markdown's by default */
  highlight?: (src: string) => string;
  placeholder?: string;
  /** after every change of the text */
  onChange?: (value: string) => void;
  /** a key in the block being written, before the editor's own: true if the host took it (a notebook's Shift+Enter) */
  onKey?: (e: KeyboardEvent) => boolean;
  /** ↑ on the first line of the first block, ↓ on the last of the last: true if the host moved on (to another cell) */
  onEdge?: (up: boolean) => boolean;
}

export class BlockEditor {
  readonly el = document.createElement("div");
  private blocks: Block[];
  private views: HTMLElement[] = [];
  private active = -1;
  private box = document.createElement("div");
  private pre = document.createElement("pre");
  private ta = document.createElement("textarea");
  private pressed = false; // a block pressed, its click to come

  constructor(value: string, private o: BlockEditorOptions) {
    addStyle();
    this.el.className = "mb";
    this.blocks = splitOne(value);
    this.box.className = "be-md mb-edit";
    this.pre.setAttribute("aria-hidden", "true");
    this.ta.rows = 1;
    this.ta.spellcheck = true;
    this.box.append(this.pre, this.ta);
    this.ta.addEventListener("input", () => this.input());
    this.ta.addEventListener("keydown", (e) => this.key(e));
    this.ta.addEventListener("paste", (e) => this.paste(e));
    // (focus gone elsewhere: the block is shown again)
    this.ta.addEventListener("blur", (e) => { if (!this.pressed && !this.el.contains(e.relatedTarget as Node | null)) this.deactivate(); });
    // A click on a block writes in it, the caret where it was (a link in it
    // is not followed).  The press takes the focus from the block being
    // written; it is shown again only once the click is done, so that nothing
    // moves under the pointer between the press and the click.
    this.el.addEventListener("pointerdown", (e) => {
      if (!(e.target as Element).closest?.(".mb-block")) return;
      this.pressed = true;
      // (no click came: shown again if the focus went elsewhere; a touch's
      // mouse events, and its click, come a little after it ends)
      addEventListener("pointerup", () => setTimeout(() => {
        if (this.pressed && !this.el.contains(document.activeElement)) this.deactivate();
        this.pressed = false;
      }, 400), { once: true });
    });
    this.el.addEventListener("click", (e) => {
      this.pressed = false;
      if ((e.target as Element).closest?.("a")) e.preventDefault();
      const v = (e.target as Element).closest?.(".mb-block") as HTMLElement | null, i = v ? this.views.indexOf(v) : -1;
      if (i >= 0) this.activate(i, { x: e.clientX, y: e.clientY });
    });
    this.renderAll();
  }

  /** The Markdown. */
  get value() { return joinBlocks(this.blocks); }
  set value(v: string) {
    this.active = -1;
    this.blocks = splitOne(v);
    this.renderAll();
  }
  /** The textarea of the block being written, if any. */
  get field(): HTMLTextAreaElement | null { return this.active >= 0 ? this.ta : null; }

  /** Write in it: at the start, the end, or the block at a point of the page (the caret there). */
  focus(at: "start" | "end" | { x: number; y: number } = "end") {
    if (at === "start") return this.activate(0, 0);
    if (at === "end") return this.activate(this.blocks.length - 1, Infinity);
    // (the block there, or the nearest above or below it)
    let i = this.views.findIndex((v) => v.getBoundingClientRect().bottom >= at.y);
    if (i < 0) i = this.views.length - 1;
    this.activate(i, at);
  }

  // ---- showing

  private renderAll() {
    this.views = this.blocks.map((b) => this.view(b));
    this.el.replaceChildren(...this.views);
  }
  private view(b: Block): HTMLElement {
    const v = document.createElement("div");
    v.className = "mb-block mb-" + kindOf(b.src);
    if (!b.src.trim()) {
      v.classList.add("mb-empty");
      v.dataset.placeholder = this.blocks.length <= 1 ? this.o.placeholder ?? "" : "";
    } else {
      v.innerHTML = this.o.render(b.src);
      if (this.o.typeset && v.querySelector(".math")) this.o.typeset(v);
    }
    return v;
  }

  // ---- writing in a block

  private activate(i: number, caret: number | { x: number; y: number }) {
    if (this.active !== i) {
      i = Math.max(0, Math.min(this.deactivate(i), this.blocks.length - 1));
      this.active = i;
      this.ta.value = this.blocks[i].src;
      this.views[i].replaceWith(this.box);
      this.views[i] = this.box;
      this.ta.placeholder = this.blocks.length === 1 ? this.o.placeholder ?? "" : "";
      this.paint();
    }
    this.ta.focus({ preventScroll: true });
    const k = typeof caret === "number" ? Math.min(caret, this.ta.value.length) : this.caretAt(caret.x, caret.y) ?? this.ta.value.length;
    this.ta.setSelectionRange(k, k);
  }

  // The block written in is shown again (cut again into blocks: a paste or
  // blank lines may have made several, and an empty one goes); `keep`: the
  // index of a block about to be written in, as it will be after that.
  private deactivate(keep = -1): number {
    const i = this.active;
    if (i < 0) return keep;
    this.active = -1;
    const b = this.blocks[i], parts = splitBlocks(b.src);
    if (parts.length) parts[parts.length - 1].sep = b.sep;
    // (an empty block goes, unless it is the only one)
    const now = parts.length || this.blocks.length === 1 ? (parts.length ? parts : [{ src: "", sep: b.sep }]) : [];
    this.blocks.splice(i, 1, ...now);
    const views = now.map((p) => this.view(p));
    this.views[i].replaceWith(...views);
    this.views.splice(i, 1, ...views);
    if (now.length !== 1) this.o.onChange?.(this.value);
    return keep > i ? keep + now.length - 1 : keep;
  }

  private paint() {
    this.pre.innerHTML = (this.o.highlight ?? ((s: string) => highlightMarkdown(s, false)))(this.ta.value);
    // (its kind as it is typed: "# " makes it a heading; first, so the field is measured in the heading's font)
    const k = kindOf(this.ta.value), h = /^ {0,3}(#{1,6})/.exec(this.ta.value);
    this.box.className = `be-md mb-edit mb-${k}` + (k === "heading" ? ` mb-h${h![1].length}` : "");
    fitHeight(this.ta);
  }

  private input() {
    this.blocks[this.active].src = this.ta.value;
    this.paint();
    this.o.onChange?.(this.value);
  }

  private paste(e: ClipboardEvent) {
    e.preventDefault();
    const t = (e.clipboardData?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
    this.ta.setRangeText(t, this.ta.selectionStart, this.ta.selectionEnd, "end");
    this.input();
  }

  private key(e: KeyboardEvent) {
    if (e.isComposing || this.o.onKey?.(e) || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const ta = this.ta, s = ta.selectionStart, end = ta.selectionEnd, n = ta.value.length, i = this.active;
    const none = s === end;
    const go = (j: number, caret: number | { x: number; y: number }) => { e.preventDefault(); this.activate(j, caret); };
    if (e.key === "Enter" && !e.shiftKey && none && s === n && this.closed()) {
      e.preventDefault();
      this.split();
    } else if (e.key === "Backspace" && none && s === 0) {
      if (i > 0) { e.preventDefault(); this.join(i - 1); }
      else if (marker(ta.value)) { e.preventDefault(); ta.setRangeText("", 0, marker(ta.value)!.length, "start"); this.input(); }
    } else if (e.key === "Delete" && none && s === n && i < this.blocks.length - 1) {
      e.preventDefault();
      this.join(i);
    } else if (e.key === "ArrowLeft" && !e.shiftKey && none && s === 0 && i > 0) go(i - 1, Infinity);
    else if (e.key === "ArrowRight" && !e.shiftKey && none && s === n && i < this.blocks.length - 1) go(i + 1, 0);
    else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && none) {
      const up = e.key === "ArrowUp", j = up ? i - 1 : i + 1;
      const r = this.caretRect(s), edge = this.caretRect(up ? 0 : n);
      if (!r || !edge || Math.abs(r.top - edge.top) > r.height / 2) return; // (not its first or last line: the textarea's own)
      // (the first block's first line, the last's last: the host's, if it goes on from there)
      if (j < 0 || j >= this.blocks.length) { if (this.o.onEdge?.(up)) e.preventDefault(); return; }
      e.preventDefault();
      const x = r.left;
      this.activate(j, up ? Infinity : 0);
      // (the same column, on the line next to where it was)
      const t = this.caretRect(up ? this.ta.value.length : 0);
      if (t) { const k = this.caretAt(x, t.top + t.height / 2); if (k !== null) this.ta.setSelectionRange(k, k); }
    }
  }

  // whether Enter at the end ends the block (fenced code and display math: only once closed)
  private closed(): boolean {
    const src = this.ta.value, k = kindOf(src);
    if (k === "code") {
      const lines = src.split("\n"), f = FENCE.exec(lines[0])!;
      return lines.length > 1 && new RegExp(`^ {0,3}${f[1][0] === "`" ? "`" : "~"}{${f[1].length},}[ \\t]*$`).test(lines[lines.length - 1]);
    }
    if (k === "math") {
      const open = MATH.exec(src)!, close = open[1] === "$$" ? "$$" : "\\]";
      return src.slice(open[0].length).includes(close);
    }
    return true;
  }

  // Enter at the end: the next block (the next list item; an empty item ends the list)
  private split() {
    const i = this.active, b = this.blocks[i];
    if (kindOf(b.src) === "item" && b.src.trim() === marker(b.src)!.trim()) {
      this.ta.value = "";
      this.input();
      return;
    }
    const item = kindOf(b.src) === "item";
    const nb: Block = { src: item ? nextItem(b.src) : "", sep: b.sep };
    b.sep = item ? "\n" : "\n\n";
    // (the block it was may now be several, or none)
    const n0 = this.blocks.length;
    this.deactivate();
    const at = i + this.blocks.length - n0;
    this.blocks.splice(at + 1, 0, nb);
    const v = this.view(nb);
    if (at >= 0) this.views[at].after(v);
    else this.el.prepend(v);
    this.views.splice(at + 1, 0, v);
    this.activate(at + 1, Infinity);
    this.o.onChange?.(this.value);
  }

  // Block j+1 joined to block j, the caret where they meet: written in block j.
  // (Into fenced code or display math nothing is joined: the caret only goes there.)
  private join(j: number) {
    this.blocks[this.active].src = this.ta.value;
    const a = this.blocks[j], b = this.blocks[j + 1];
    const into = kindOf(a.src);
    if (into === "code" || into === "math") {
      if (b.src.trim()) return this.activate(this.active === j ? j + 1 : j, this.active === j ? 0 : Infinity);
      // (an empty block after one: it goes)
      a.sep = b.sep;
      this.blocks.splice(j + 1, 1);
      this.active = -1;
      this.renderAll();
      this.activate(j, Infinity);
      this.o.onChange?.(this.value);
      return;
    }
    const body = b.src.slice(marker(b.src)?.length ?? 0), at = a.src.length;
    a.src += body;
    a.sep = b.sep;
    this.blocks.splice(j + 1, 1);
    this.active = -1;
    this.renderAll();
    this.activate(j, at);
    this.o.onChange?.(this.value);
  }

  // ---- where the caret is, from the highlighted copy (laid out as the text is)

  private caretRect(k: number): DOMRect | null {
    const walk = document.createTreeWalker(this.pre, NodeFilter.SHOW_TEXT), texts: Text[] = [];
    for (let t = walk.nextNode(); t; t = walk.nextNode()) texts.push(t as Text);
    let left = k;
    for (const [i, t] of texts.entries()) {
      const len = t.data.length;
      if (left < len || (left === len && i === texts.length - 1)) {
        const r = document.createRange();
        if (left < len) { r.setStart(t, left); r.setEnd(t, left + 1); }
        else { r.setStart(t, Math.max(0, left - 1)); r.setEnd(t, left); }
        return r.getClientRects()[0] ?? null;
      }
      left -= len;
    }
    return null;
  }
  private caretAt(x: number, y: number): number | null {
    this.pre.style.pointerEvents = "auto";
    this.ta.style.pointerEvents = "none";
    const doc = document as any;
    const at: { node: Node; offset: number } | null = doc.caretPositionFromPoint
      ? (({ offsetNode, offset }: any = doc.caretPositionFromPoint(x, y) ?? {}) => (offsetNode ? { node: offsetNode, offset } : null))()
      : (({ startContainer, startOffset }: any = doc.caretRangeFromPoint?.(x, y) ?? {}) => (startContainer ? { node: startContainer, offset: startOffset } : null))();
    this.pre.style.pointerEvents = "";
    this.ta.style.pointerEvents = "";
    if (!at || !this.pre.contains(at.node) || at.node.nodeType !== Node.TEXT_NODE) return null;
    let k = 0;
    const walk = document.createTreeWalker(this.pre, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t && t !== at.node; t = walk.nextNode()) k += t.textContent!.length;
    return Math.min(this.ta.value.length, k + at.offset);
  }
}
