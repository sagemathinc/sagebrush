// The Share dialog's file list (share-ux-plan r2 §1, §4), drawn from a Selection: shared with Download's.
import { reasonText, type Bounds, type Selection } from "./selection";

const ROW_H = 40;
const OVERSCAN = 8;
const num = (n: number) => n.toLocaleString("en-US");
/** A long path shortened in the middle (UI-5); the full path is the title. */
export function middle(s: string, max = 52): string {
  if (s.length <= max) return s;
  const keep = max - 1, head = Math.ceil(keep / 2);
  return s.slice(0, head) + "…" + s.slice(s.length - (keep - head));
}

export interface FileListHost {
  list: HTMLElement;
  inner: HTMLElement;
  summary: HTMLElement;
  selection: () => Selection | null;
  busy: () => boolean;
  bounds: () => Bounds;
  fmtSize: (n: number) => string;
  drawn?: (s: ReturnType<Selection["summary"]>) => void;
  /** which rows show (Share's "Add files…": the notebook and its files, the rest by search); all of them if absent.
   * The order stays the selection's own: a row never moves, it only shows or hides */
  visible?: (r: Selection["rows"][number]) => boolean;
}

export function createFileList(h: FileListHost) {
  const { list, inner, summary } = h;
  const draw = () => {
    const sel = h.selection();
    if (!sel) return;
    // (the rows shown, in the selection's order: each drawn at its place among them)
    const shown: number[] = [];
    sel.rows.forEach((r, i) => { if (!h.visible || h.visible(r)) shown.push(i); });
    inner.style.height = `${shown.length * ROW_H}px`;
    const first = Math.max(0, Math.floor(list.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(shown.length, Math.ceil((list.scrollTop + (list.clientHeight || 300)) / ROW_H) + OVERSCAN);
    const keep = new Map<number, number>();
    for (let k = first; k < last; k++) keep.set(shown[k], k);
    for (const el of [...inner.children] as HTMLElement[]) if (!keep.has(Number(el.dataset.i))) el.remove();
    const have = new Set([...inner.children].map((el) => Number((el as HTMLElement).dataset.i)));
    for (const i of keep.keys()) if (!have.has(i)) inner.append(rowEl(i));
    for (const el of [...inner.children] as HTMLElement[]) { el.style.top = `${keep.get(Number(el.dataset.i))! * ROW_H}px`; fill(el); }
    const s = sel.summary(h.bounds());
    summary.textContent = `${num(s.files)} of ${num(s.of)} files${s.sizesKnown ? `, ${h.fmtSize(s.bytes)}` : ""}${s.over ? ` — ${s.over}` : ""}`;
    h.drawn?.(s);
  };
  const rowEl = (i: number) => {
    const el = document.createElement("div");
    el.className = "sharerow";
    el.dataset.i = String(i);
    el.innerHTML = `<label><input type="checkbox"><span class="name"></span><span class="size"></span></label><div class="why"></div>`;
    const box = el.querySelector("input") as HTMLInputElement;
    box.addEventListener("click", (e) => {
      const sel = h.selection();
      if (!sel || h.busy()) return e.preventDefault();
      sel.toggle(i, e.shiftKey);
      queueMicrotask(draw);
    });
    box.addEventListener("keydown", (e) => {
      const sel = h.selection();
      if (e.key !== " " || !sel) return;
      // (Space and Shift+Space: the range from the keyboard, UI-8; the native
      // toggle, on keyup, is cancelled too)
      e.preventDefault();
      if (h.busy() || e.repeat) return;
      sel.toggle(i, e.shiftKey);
      draw();
    });
    box.addEventListener("keyup", (e) => {
      if (e.key === " ") e.preventDefault();
    });
    return el;
  };
  const fill = (el: HTMLElement) => {
    const sel = h.selection()!, r = sel.rows[Number(el.dataset.i)];
    const box = el.querySelector("input") as HTMLInputElement;
    box.checked = r.checked;
    box.disabled = !!r.notebook || h.busy();
    const name = el.querySelector(".name") as HTMLElement, size = el.querySelector(".size") as HTMLElement, why = el.querySelector(".why") as HTMLElement;
    const shown = r.path.replace(/^\/+/, "");
    name.textContent = " " + middle(shown);
    name.title = shown;
    size.textContent = r.notebook ? "this notebook" : r.size === undefined ? "size unknown" : h.fmtSize(r.size);
    why.textContent = r.reason ? reasonText(r.reason) : r.notebook || r.checked ? "" : sel.state === "analyzing" ? "still analyzing" : sel.state === "not-analyzed" ? "not analyzed" : "";
  };
  list.addEventListener("scroll", () => draw(), { passive: true });
  return { draw };
}
