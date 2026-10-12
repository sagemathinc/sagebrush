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

export const DEFAULT_TOOLS = ["note", "code", "group", "connect"];
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
      this.use(b, t);
      this.el.append(b);
    }
    const more = (this.more = document.createElement("button"));
    more.className = "tb-more";
    more.title = "Every tool; check the ones to keep on the toolbar";
    more.setAttribute("aria-haspopup", "menu");
    // (a mode on that is not on the toolbar: its icon on "⋯")
    this.bound.push(effect(() => {
      const on = this.all.filter((t) => t.toggle?.value && !this.tools.value.includes(t.id));
      more.textContent = on.length ? `${on.map((t) => t.icon).join(" ")} ⋯` : "⋯";
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
    p.className = "board-toolbar-panel";
    p.setAttribute("role", "menu");
    for (const t of this.all) {
      const row = document.createElement("div");
      row.className = "tb-row";
      const use = document.createElement("button");
      use.className = "tb-use";
      use.dataset.tool = t.id;
      use.title = t.title;
      use.setAttribute("role", "menuitem");
      use.append(Object.assign(document.createElement("span"), { className: "tb-icon", textContent: t.icon }), ` ${t.label}`);
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
