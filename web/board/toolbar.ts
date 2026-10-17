// The toolbar for adding things (Edit mode only: getting the tools out).
// Each board keeps its own tools (the document's `tools`), as a workshop
// lays out the tools of the job at hand; a new board starts with the
// person's default.  "⋯" at its end is a menu of every tool: use any of
// them from there, and check the ones to keep on the toolbar.  A mode (a
// tool turned on, as Select or Connect) not on the toolbar shows its icon on
// "⋯", so it is plain that it is on.  The UI's state is signals
// (@preact/signals-core): an element bound to one updates itself when it
// changes.

import { effect, signal, type ReadonlySignal, type Signal } from "@preact/signals-core";
import { icon } from "./icons";

export interface Tool {
  id: string;
  label: string;
  /** a short glyph: in the menu, and on "⋯" while it is on */
  icon: string;
  title: string;
  /** a mode it turns on and off (Select, Connect), instead of an action */
  toggle?: Signal<boolean>;
  run?: () => void;
}

export const DEFAULT_TOOLS = ["note", "code", "image", "group", "connect", "draw"];
const DEFAULT_KEY = "sagebrush-board-tools";

/** The person's default tools for new boards (on a touch screen, with no
 * keyboard for Ctrl+Z, Undo too). */
export function defaultTools(): string[] {
  try {
    const t = JSON.parse(localStorage.getItem(DEFAULT_KEY) ?? "null");
    if (Array.isArray(t) && t.every((x) => typeof x === "string")) return t;
  } catch {}
  return matchMedia("(pointer: coarse)").matches ? [...DEFAULT_TOOLS, "undo"] : DEFAULT_TOOLS;
}

export class Toolbar {
  readonly el: HTMLElement;
  /** the tools shown, in order (the board's, else the default) */
  readonly tools = signal<string[]>(defaultTools());
  private panel: HTMLElement | null = null;
  private more!: HTMLButtonElement;
  private bound: (() => void)[] = []; // (the buttons' own effects, disposed with them)

  /** `change`: the board's tools were changed (kept in the document, not an undo step) */
  constructor(parent: HTMLElement, private all: Tool[], editing: ReadonlySignal<boolean>, private change: (ids: string[]) => void) {
    this.el = document.createElement("div");
    this.el.className = "board-toolbar";
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", "Add to the board");
    parent.append(this.el);
    // (its buttons' tooltips: one, drawn in the board below the button, never
    // under the pointer nor taking it; the browser's title tooltip, which some
    // Linux desktops open under the pointer, ends the hover and starts it
    // again: a flicker, William Oct 17.  Kept within the board, the first and
    // last buttons' too on a narrow screen, astra's UI-158-1)
    this.tip.className = "board-tip";
    this.tip.setAttribute("aria-hidden", "true");
    this.tip.hidden = true;
    parent.append(this.tip);
    this.el.addEventListener("pointerover", (e) => {
      const b = (e.target as Element).closest<HTMLElement>("[data-tip]");
      if (b && b !== this.tipOn && e.pointerType !== "touch") this.tipFor(b);
    });
    this.el.addEventListener("pointerout", (e) => {
      if (this.tipOn && !this.tipOn.contains(e.relatedTarget as Node | null)) this.hideTip();
    });
    this.el.addEventListener("pointerdown", () => this.hideTip());
    this.own.push(effect(() => {
      this.el.hidden = !editing.value;
      if (!editing.value) { this.closePanel(); this.hideTip(); }
    }), effect(() => this.render(this.tools.value)));
  }
  private tip = document.createElement("div");
  private tipOn: HTMLElement | null = null;
  private tipTimer = 0;
  // (shown after a moment, as the browser's are)
  private tipFor(b: HTMLElement) {
    this.hideTip();
    this.tipOn = b;
    this.tipTimer = window.setTimeout(() => this.showTip(b), 600);
  }
  private showTip(b: HTMLElement) {
    const tip = this.tip, root = tip.parentElement;
    if (!root || !b.isConnected || !b.dataset.tip) return;
    const rr = root.getBoundingClientRect(), br = b.getBoundingClientRect();
    const lo = Math.max(rr.left, 0) + 4, hi = Math.min(rr.right, innerWidth) - 4;
    tip.textContent = b.dataset.tip;
    tip.style.left = "0px";
    tip.style.maxWidth = `${Math.max(80, Math.min(280, hi - lo))}px`;
    tip.hidden = false;
    const w = tip.offsetWidth, x = Math.max(lo, Math.min(hi - w, br.left + br.width / 2 - w / 2));
    tip.style.left = `${x - rr.left}px`;
    tip.style.top = `${br.bottom + 8 - rr.top}px`;
  }
  private hideTip() {
    clearTimeout(this.tipTimer);
    this.tipOn = null;
    this.tip.hidden = true;
  }
  private own: (() => void)[] = []; // (its own effects)
  /** Take the toolbar away: its effects, its menu and its element. */
  destroy() {
    for (const d of [...this.own.splice(0), ...this.bound.splice(0)]) d();
    this.closePanel();
    this.hideTip();
    this.tip.remove();
    this.el.remove();
  }

  private render(ids: string[]) {
    for (const d of this.bound.splice(0)) d();
    this.hideTip();
    this.el.replaceChildren();
    for (const id of ids) {
      const t = this.all.find((x) => x.id === id);
      if (!t) continue;
      const b = document.createElement("button");
      // (its name; on a narrow screen, its icon)
      // (a tool named by its glyph, as undo: its icon everywhere)
      b.append(glyph(t, "tb-i"), t.label === t.icon ? glyph(t, "tb-l") : Object.assign(document.createElement("span"), { className: "tb-l", textContent: t.label }));
      // (a tool named by its glyph, as undo: named by its title, without its keys, to a screen reader)
      b.setAttribute("aria-label", t.label === t.icon ? t.title.replace(/\s*\([^)]*\)\s*$/, "") : t.label);
      // (its tooltip drawn in the board, not the browser's: see showTip)
      b.dataset.tip = t.title;
      b.dataset.tool = t.id;
      this.use(b, t);
      this.el.append(b);
    }
    const more = (this.more = document.createElement("button"));
    more.className = "tb-more";
    more.dataset.tip = "Every tool; check the ones to keep on the toolbar";
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-label", "More tools");
    // (a mode on that is not on the toolbar: its icon on "⋯")
    this.bound.push(effect(() => {
      const on = this.all.filter((t) => t.toggle?.value && !this.tools.value.includes(t.id));
      more.replaceChildren(...on.map((t) => glyph(t, "tb-on-i")), "⋯");
      more.classList.toggle("tb-on", on.length > 0);
    }));
    more.onclick = (e) => { e.stopPropagation(); this.panel ? this.closePanel() : this.openPanel(); };
    this.el.append(more);
  }

  // a button that uses a tool: runs it, or turns its mode on and off
  private use(b: HTMLButtonElement, t: Tool, after?: () => void) {
    if (t.toggle) {
      const on = t.toggle;
      this.bound.push(effect(() => b.setAttribute("aria-pressed", String(on.value))));
      b.onclick = () => { on.value = !on.value; after?.(); };
    } else b.onclick = () => { after?.(); t.run?.(); };
  }

  // the menu: every tool (use it), and whether it is on the toolbar; at "⋯"
  private openPanel() {
    const p = document.createElement("div");
    p.className = "board-toolbar-panel sbb-layer";
    p.setAttribute("role", "menu");
    for (const t of this.all) {
      const row = document.createElement("div");
      row.className = "tb-row";
      const use = document.createElement("button");
      use.className = "tb-use";
      use.dataset.tool = t.id;
      use.title = t.title;
      use.setAttribute("role", "menuitem");
      use.append(glyph(t, "tb-icon"), ` ${t.label === t.icon ? t.title.replace(/ \(.*$/, "") : t.label}`);
      this.use(use, t, () => this.closePanel());
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = this.tools.value.includes(t.id);
      box.dataset.tool = t.id;
      box.title = "On the toolbar";
      box.setAttribute("aria-label", `${t.label} on the toolbar`);
      box.onchange = () => {
        // (in the order of the list)
        this.change(this.all.map((x) => x.id).filter((id) => (id === t.id ? box.checked : this.tools.value.includes(id))));
      };
      row.append(use, box);
      p.append(row);
    }
    const def = document.createElement("button");
    def.className = "tb-default";
    def.textContent = "Use this toolbar for new boards";
    def.onclick = () => {
      try { localStorage.setItem(DEFAULT_KEY, JSON.stringify(this.tools.value)); } catch {}
      def.textContent = "Saved as your default";
    };
    p.append(def);
    p.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.body.append(p);
    // (at "⋯": below it, its right edge at the button's, kept on the screen)
    const r = this.more.getBoundingClientRect();
    p.style.top = r.bottom + 6 + "px";
    p.style.left = Math.max(8, Math.min(innerWidth - p.offsetWidth - 8, r.right - p.offsetWidth)) + "px";
    this.panel = p;
    setTimeout(() => addEventListener("pointerdown", this.outside), 0);
  }
  private outside = () => this.closePanel();
  private closePanel() {
    this.panel?.remove();
    this.panel = null;
    removeEventListener("pointerdown", this.outside);
  }
}

// a tool's icon in a span of this class: its drawing, else its glyph
function glyph(t: Tool, className: string): HTMLSpanElement {
  const span = Object.assign(document.createElement("span"), { className });
  const svg = icon(t.id);
  if (svg) span.append(svg);
  else span.textContent = t.icon;
  return span;
}
