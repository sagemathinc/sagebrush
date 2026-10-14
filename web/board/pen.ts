// The pen row (Edit, while Draw or Erase is on): under the Edit toolbar,
// the pen's colors and widths, a highlighter, and the eraser.  The choice
// is the person's, kept in this browser, as their default tools are.

import { effect, type Signal } from "@preact/signals-core";
import type { InkStyle } from "./board";
import { icon } from "./icons";

export const PEN_COLORS: [string, string][] = [["Black", "#1d241a"], ["Blue", "#1d4ed8"], ["Red", "#c0392b"], ["Green", "#2a6f2f"], ["Orange", "#d97706"], ["Purple", "#7c3aed"]];
export const PEN_SIZES: [string, number][] = [["Thin", 2], ["Medium", 3.5], ["Thick", 6]];
// (a highlighter: wide, and what is under it shows through)
const HIGHLIGHTER = { size: 18, opacity: 0.35 };
const KEY = "sagebrush-board-pen";

interface Pen { color: string; size: number; highlighter: boolean }

function load(): Pen {
  const pen: Pen = { color: PEN_COLORS[0][1], size: PEN_SIZES[1][1], highlighter: false };
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (PEN_COLORS.some(([, c]) => c === p?.color)) pen.color = p.color;
    if (PEN_SIZES.some(([, s]) => s === p?.size)) pen.size = p.size;
    pen.highlighter = p?.highlighter === true;
  } catch {}
  return pen;
}

export class PenRow {
  readonly el: HTMLElement;
  private pen = load();
  private off: () => void;

  /** In `parent` (the board's element), below `under` (the Edit toolbar's). */
  constructor(parent: HTMLElement, private drawing: Signal<boolean>, private erasing: Signal<boolean>, private under: () => HTMLElement | null) {
    const el = (this.el = document.createElement("div"));
    el.className = "ink-row";
    el.setAttribute("role", "toolbar");
    el.setAttribute("aria-label", "Pen");
    el.hidden = true;
    const button = (cls: string, title: string, pressed: () => boolean, click: () => void) => {
      const b = document.createElement("button");
      b.className = cls;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.onclick = () => { click(); this.save(); this.refresh(); };
      (b as any).pressed = pressed;
      el.append(b);
      return b;
    };
    const draw = () => { this.drawing.value = true; };
    for (const [name, c] of PEN_COLORS) {
      const b = button("ink-c", name, () => this.pen.color === c && !this.erasing.value, () => { this.pen.color = c; draw(); });
      const dot = document.createElement("span");
      dot.style.setProperty("--c", c);
      b.append(dot);
    }
    el.append(Object.assign(document.createElement("span"), { className: "ink-sep" }));
    for (const [name, size] of PEN_SIZES) {
      const b = button("ink-s", name, () => this.pen.size === size && !this.pen.highlighter && !this.erasing.value, () => { this.pen.size = size; this.pen.highlighter = false; draw(); });
      const dot = document.createElement("span");
      dot.style.width = dot.style.height = Math.round(size * 1.6 + 2) + "px";
      b.append(dot);
    }
    button("ink-h", "Highlighter", () => this.pen.highlighter && !this.erasing.value, () => { this.pen.highlighter = true; draw(); }).append(icon("highlighter")!);
    el.append(Object.assign(document.createElement("span"), { className: "ink-sep" }));
    button("ink-e", "Eraser: drag across strokes to remove them", () => this.erasing.value, () => { this.erasing.value = true; }).append(icon("erase")!);
    parent.append(el);
    this.off = effect(() => {
      el.hidden = !this.drawing.value && !this.erasing.value;
      this.refresh();
    });
  }

  /** How the pen draws now. */
  style(): InkStyle {
    return this.pen.highlighter ? { color: this.pen.color, ...HIGHLIGHTER } : { color: this.pen.color, size: this.pen.size };
  }

  private save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.pen)); } catch {}
  }

  // which buttons are on, and where the row is: just under the Edit toolbar
  private refresh() {
    for (const b of this.el.querySelectorAll("button")) b.setAttribute("aria-pressed", String((b as any).pressed()));
    if (this.el.hidden) return;
    const t = this.under();
    if (t) this.el.style.top = t.offsetTop + t.offsetHeight + 6 + "px";
  }

  destroy() {
    this.off();
    this.el.remove();
  }
}
