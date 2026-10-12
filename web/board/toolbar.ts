// The toolbar for adding things (Edit mode only: getting the tools out).
// Each board keeps its own tools (the document's `tools`), as a workshop
// lays out the tools of the job at hand; a new board starts with the
// person's default.  The UI's state is signals (@preact/signals-core): an
// element bound to one updates itself when it changes.

import { effect, signal, type ReadonlySignal, type Signal } from "@preact/signals-core";

export interface Tool {
  id: string;
  label: string;
  title: string;
  /** a mode it turns on and off (Connect), instead of an action */
  toggle?: Signal<boolean>;
  run?: () => void;
}

export const DEFAULT_TOOLS = ["note", "code", "group", "connect"];
const DEFAULT_KEY = "sagebrush-board-tools";

/** The person's default tools for new boards. */
export function defaultTools(): string[] {
  try {
    const t = JSON.parse(localStorage.getItem(DEFAULT_KEY) ?? "null");
    if (Array.isArray(t) && t.every((x) => typeof x === "string")) return t;
  } catch {}
  return DEFAULT_TOOLS;
}

export class Toolbar {
  readonly el: HTMLElement;
  /** the tools shown, in order (the board's, else the default) */
  readonly tools = signal<string[]>(defaultTools());
  private panel: HTMLElement | null = null;
  private bound: (() => void)[] = []; // (the buttons' own effects, disposed with them)

  /** `change`: the board's tools were changed (an edit of the document) */
  constructor(parent: HTMLElement, private all: Tool[], editing: ReadonlySignal<boolean>, private change: (ids: string[]) => void) {
    this.el = document.createElement("div");
    this.el.className = "board-toolbar";
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", "Add to the board");
    parent.append(this.el);
    effect(() => {
      this.el.hidden = !editing.value;
      if (!editing.value) this.closePanel();
    });
    effect(() => this.render(this.tools.value));
  }

  private render(ids: string[]) {
    for (const d of this.bound.splice(0)) d();
    this.el.replaceChildren();
    for (const id of ids) {
      const t = this.all.find((x) => x.id === id);
      if (!t) continue;
      const b = document.createElement("button");
      b.textContent = t.label;
      b.title = t.title;
      b.dataset.tool = t.id;
      if (t.toggle) {
        const on = t.toggle;
        this.bound.push(effect(() => b.setAttribute("aria-pressed", String(on.value))));
        b.onclick = () => { on.value = !on.value; };
      } else b.onclick = () => t.run?.();
      this.el.append(b);
    }
    const more = document.createElement("button");
    more.textContent = "⋯";
    more.title = "Choose this board's tools";
    more.className = "tb-more";
    more.onclick = (e) => { e.stopPropagation(); this.panel ? this.closePanel() : this.openPanel(); };
    this.el.append(more);
  }

  // Customize: which tools this board shows; and the default for new boards
  private openPanel() {
    const p = document.createElement("div");
    p.className = "board-toolbar-panel";
    const shown = new Set(this.tools.value);
    for (const t of this.all) {
      const row = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = shown.has(t.id);
      box.dataset.tool = t.id;
      box.onchange = () => {
        // (in the order of the list)
        const next = this.all.map((x) => x.id).filter((id) => (id === t.id ? box.checked : this.tools.value.includes(id)));
        this.change(next);
      };
      row.append(box, ` ${t.label}`);
      row.title = t.title;
      p.append(row);
    }
    const def = document.createElement("button");
    def.textContent = "Use these for new boards";
    def.onclick = () => {
      try { localStorage.setItem(DEFAULT_KEY, JSON.stringify(this.tools.value)); } catch {}
      def.textContent = "Saved as your default";
    };
    p.append(def);
    p.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.el.after(p);
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
