// The drawer (design note: the board drawer, step 1): a note's whole
// content in a panel on the right of the board, its card on the canvas
// keeping its size.  A click on a note opens it (mount.ts); it holds only
// the note's id, and draws it again from the document and the outputs
// whenever either changes, so it never differs from the card.  Not modal:
// the board stays live beside it.
// - Its width: a grip on its left edge (a separator: drag, arrow keys,
//   Home/End; a double-click puts the default back), kept in this browser
//   as a fraction of the board's width, never in the document.
// - On a board under 600 px wide it is a sheet at the bottom instead: a
//   grip on its top edge, two heights to settle at, and a drag down closes it.
// - Esc closes it (what is open inside it first); the focus goes back to
//   where it was.

export interface DrawerHost {
  /** the board's root (.sbb): the drawer is drawn in it, so a page embedding the board holds it */
  root: HTMLElement;
  /** what the drawer shows for this note: its content as its card draws it, all of it (null: none now) */
  content(id: string): HTMLElement | null;
  /** its title, as its card's (null: none) */
  title(id: string): HTMLElement | null;
  /** its title as plain text, to say it opened */
  label(id: string): string;
  /** the room it takes from the board, for the camera: on the right, or (a sheet) at the bottom */
  insets(right: number, bottom: number): void;
  /** the drawer was opened on this note (the camera shows its card beside it) */
  shown(id: string): void;
  /** Edit: write the note where it is (shown only in Edit) */
  edit(id: string): void;
}

const NARROW = 600; // a board narrower than this: the sheet at the bottom (the board's own breakpoint, board.css)
const MIN_W = 280, MAX_W = 0.8, DEFAULT_W = 480, DEFAULT_FRACTION = 0.4;
const SHEET_HEIGHTS = [0.45, 0.9], SHEET_MIN = 0.2, SHEET_CLOSE = 0.25;
const WIDTH_KEY = "sagebrush-board:drawer-width", HEIGHT_KEY = "sagebrush-board:drawer-height";
const GAP = 12; // between the drawer and what the camera keeps clear of it

// (a fraction kept in this browser; where storage is refused (a sandboxed frame), for this page only)
const memory = new Map<string, number>();
function readFraction(key: string): number | null {
  let v: string | null = null;
  try { v = localStorage.getItem(key); } catch { return memory.get(key) ?? null; }
  const f = v === null ? NaN : Number(v);
  return Number.isFinite(f) && f > 0 && f <= 1 ? f : (memory.get(key) ?? null);
}
function keepFraction(key: string, f: number) {
  memory.set(key, f);
  try { localStorage.setItem(key, String(Math.round(f * 1e4) / 1e4)); } catch {}
}

export class Drawer {
  readonly el = document.createElement("aside");
  private head = document.createElement("div");
  private heading = document.createElement("h2");
  private body = document.createElement("div");
  private grip = document.createElement("div");
  private editBtn = document.createElement("button");
  private say = document.createElement("div");
  private shownId: string | null = null;
  private editing = false;
  private frame = 0;
  private back: HTMLElement | null = null;
  private sized = 0; // the width (or the sheet's height) drawn, in pixels

  constructor(private host: DrawerHost) {
    const el = this.el;
    el.className = "sbb-drawer";
    el.dataset.sbb = "drawer";
    el.hidden = true;
    const headingId = "sbb-drawer-h" + Math.random().toString(36).slice(2, 10);
    this.heading.id = headingId;
    this.heading.tabIndex = -1;
    el.setAttribute("aria-labelledby", headingId);
    this.grip.className = "sbb-drawer-grip";
    this.grip.tabIndex = 0;
    this.grip.setAttribute("role", "separator");
    this.grip.title = "Drag to resize (double-click: the usual size)";
    this.head.className = "sbb-drawer-head";
    this.editBtn.className = "sbb-drawer-edit";
    this.editBtn.type = "button";
    this.editBtn.textContent = "Edit";
    this.editBtn.title = "Write in this note where it is on the board";
    this.editBtn.hidden = true;
    this.editBtn.onclick = () => { if (this.shownId) this.host.edit(this.shownId); };
    const close = document.createElement("button");
    close.className = "sbb-drawer-close";
    close.type = "button";
    close.title = "Close (Esc)";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.onclick = () => this.close();
    this.head.append(this.heading, this.editBtn, close);
    this.body.className = "sbb-drawer-body";
    el.append(this.grip, this.head, this.body);
    // (said to a screen reader when a click opened it: outside the drawer, which is hidden when closed)
    this.say.className = "sbb-sr";
    this.say.setAttribute("aria-live", "polite");
    host.root.append(el, this.say);
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.defaultPrevented || typing(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    });
    this.resizing();
  }

  /** the note shown, or null when closed */
  get id(): string | null { return this.shownId; }
  get isOpen(): boolean { return this.shownId !== null; }
  private get sheet(): boolean { return this.host.root.clientWidth < NARROW; }

  /** Show note `id` (`keyboard`: the focus goes to the drawer; else it stays where it is, and the opening is said). */
  open(id: string, keyboard = false) {
    const was = this.shownId;
    if (!this.render(id)) return;
    if (was === null) {
      const a = document.activeElement;
      this.back = a instanceof HTMLElement && a !== document.body && !this.el.contains(a) ? a : null;
    }
    this.el.hidden = false;
    this.host.root.classList.add("sbb-drawer-open");
    this.layout();
    if (was !== id) this.body.scrollTop = 0;
    if (keyboard) this.heading.focus();
    else this.say.textContent = `Opened: ${this.host.label(id) || "the note"}`;
    this.host.shown(id);
  }

  /** Close it; the focus goes back to where it was if it was in the drawer. */
  close() {
    if (this.shownId === null) return;
    const had = this.el.contains(document.activeElement);
    this.shownId = null;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.el.hidden = true;
    this.host.root.classList.remove("sbb-drawer-open", "sbb-sheet-open");
    this.body.replaceChildren();
    this.say.textContent = "";
    this.host.insets(0, 0);
    if (had) {
      const b = this.back;
      if (b?.isConnected) b.focus();
      else this.host.root.querySelector<HTMLElement>(".board")?.focus();
    }
    this.back = null;
  }

  /** In Edit: its Edit button shows. */
  setEditing(on: boolean) {
    this.editing = on;
    this.editBtn.hidden = !on || this.body.querySelector(".sbb-drawer-gone") !== null;
  }

  /** The document or the outputs changed: drawn again, once per frame, where it was scrolled to. */
  changed() {
    if (this.shownId === null || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const id = this.shownId;
      if (id === null) return;
      const top = this.body.scrollTop;
      if (!this.render(id)) this.gone();
      this.body.scrollTop = top;
    });
  }

  /** The board's size changed: its width (or height) within bounds again, and the room it takes. */
  layout() {
    if (this.shownId === null) return;
    const root = this.host.root, sheet = this.sheet;
    this.el.classList.toggle("sbb-sheet", sheet);
    root.classList.toggle("sbb-sheet-open", sheet);
    this.grip.setAttribute("aria-orientation", sheet ? "horizontal" : "vertical");
    this.grip.setAttribute("aria-label", sheet ? "Resize the panel's height" : "Resize the panel's width");
    if (sheet) {
      const H = root.clientHeight, f = readFraction(HEIGHT_KEY) ?? SHEET_HEIGHTS[0];
      this.size(f * H, false);
    } else {
      const W = root.clientWidth, f = readFraction(WIDTH_KEY);
      this.size(f === null ? Math.min(DEFAULT_W, DEFAULT_FRACTION * W) : f * W, false);
    }
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.el.remove();
    this.say.remove();
  }

  // ------------------------------------------------------------------ drawing

  private render(id: string): boolean {
    const content = this.host.content(id);
    if (!content) return false;
    this.shownId = id;
    const t = this.host.title(id);
    this.heading.replaceChildren(...(t ? [t] : []));
    if (!t) this.heading.textContent = "Note";
    this.body.replaceChildren(content);
    this.setEditing(this.editing);
    return true;
  }

  // (the note was deleted, here or by someone else: said, rather than the drawer vanishing)
  private gone() {
    const p = document.createElement("p");
    p.className = "sbb-drawer-gone";
    p.textContent = "This note was deleted.";
    this.body.replaceChildren(p);
    this.editBtn.hidden = true;
  }

  // ------------------------------------------------------------------ size

  private bounds(): [number, number] {
    const root = this.host.root;
    if (this.sheet) { const H = root.clientHeight; return [Math.round(SHEET_MIN * H), Math.round(SHEET_HEIGHTS[1] * H)]; }
    const W = root.clientWidth;
    return [Math.min(MIN_W, Math.round(MAX_W * W)), Math.round(MAX_W * W)];
  }

  /** Its width (a sheet: its height), within bounds; `keep`: kept in this browser too. */
  private size(px: number, keep: boolean) {
    const [lo, hi] = this.bounds(), v = Math.round(Math.max(lo, Math.min(hi, px)));
    this.sized = v;
    const root = this.host.root, sheet = this.sheet;
    if (sheet) { this.el.style.width = ""; this.el.style.height = v + "px"; root.style.setProperty("--sbb-sheet-h", v + "px"); root.style.removeProperty("--sbb-drawer-w"); }
    else { this.el.style.height = ""; this.el.style.width = v + "px"; root.style.setProperty("--sbb-drawer-w", v + "px"); root.style.removeProperty("--sbb-sheet-h"); }
    this.grip.setAttribute("aria-valuemin", String(lo));
    this.grip.setAttribute("aria-valuemax", String(hi));
    this.grip.setAttribute("aria-valuenow", String(v));
    if (keep) keepFraction(sheet ? HEIGHT_KEY : WIDTH_KEY, v / (sheet ? root.clientHeight : root.clientWidth));
    if (sheet) this.host.insets(0, v + GAP);
    else this.host.insets(v + GAP, 0);
  }

  private resizing() {
    const g = this.grip;
    let drag: { id: number; moved: boolean } | null = null;
    g.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      drag = { id: e.pointerId, moved: false };
      g.setPointerCapture(e.pointerId);
      this.el.classList.add("sbb-drawer-resizing");
    });
    g.addEventListener("pointermove", (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      drag.moved = true;
      const r = this.host.root.getBoundingClientRect();
      if (this.sheet) this.size(r.bottom - e.clientY, false);
      else this.size(r.right - e.clientX, false);
    });
    const end = (e: PointerEvent) => {
      if (!drag || drag.id !== e.pointerId) return;
      const moved = drag.moved;
      drag = null;
      this.el.classList.remove("sbb-drawer-resizing");
      if (!moved) return;
      if (this.sheet) {
        // (let go: closed if dragged down far enough, else at the nearer of its two heights)
        const H = this.host.root.clientHeight, f = this.sized / H;
        if (f < SHEET_CLOSE) { this.close(); return; }
        const to = SHEET_HEIGHTS.reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a));
        this.size(to * H, true);
      } else this.size(this.sized, true);
    };
    g.addEventListener("pointerup", end);
    g.addEventListener("pointercancel", end);
    g.addEventListener("dblclick", () => {
      const root = this.host.root;
      if (this.sheet) this.size(SHEET_HEIGHTS[0] * root.clientHeight, true);
      else this.size(Math.min(DEFAULT_W, DEFAULT_FRACTION * root.clientWidth), true);
    });
    g.addEventListener("keydown", (e) => {
      const [lo, hi] = this.bounds(), step = e.shiftKey ? 64 : 16, sheet = this.sheet;
      const grow = sheet ? "ArrowUp" : "ArrowLeft", shrink = sheet ? "ArrowDown" : "ArrowRight";
      let to: number;
      if (e.key === grow) to = this.sized + step;
      else if (e.key === shrink) to = this.sized - step;
      else if (e.key === "Home") to = lo;
      else if (e.key === "End") to = hi;
      else return;
      e.preventDefault();
      e.stopPropagation();
      this.size(to, true);
    });
  }
}

// (keys typed into a field, or into what is being written: theirs, not the drawer's)
function typing(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);
}
