// Documents open in View mode (William, Nov 4: "should that be the default behavior for ALL documents? It's obviously
// good from a security point of view, and also reduces the chances of accidentally messing things up"), except one
// the person made here or last left in Edit: "They should open in edit mode". What each document was last left in, by
// the person's own toggle, is kept in this browser (localStorage), by kind and id; an editor records Edit for a
// document the person makes (a board: a blank one opens in Edit), so both exceptions are one rule. Only Edit is kept
// (View is the default), at most MAX documents, the oldest going first. This is the page's own editing UI: writes
// through the workspace (an agent, another tab, sync) keep their own grants. A lost write here (another tab's at the
// same moment) opens that document in View: the safe side.

export type DocMode = "view" | "edit";
const STORE = "sagebrush-doc-modes";
const MAX = 1000;
/** the shortcut, said in the Edit control's title */
export const EDIT_TITLE = "Edit (E)";
export const EDITING_TITLE = "Editing: Esc for View";

export const modeKey = (kind: string, id: string) => `${kind}:${id}`;
/** key -> when it was left in Edit (ms): only entries that are a finite time are taken, into a record of its own (no
 * prototype); anything else in the store, or a store that can't be read, is none (View: the safe side). */
function kept(): Record<string, number> {
  const k: Record<string, number> = Object.create(null);
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) for (const [key, t] of Object.entries(v)) if (typeof t === "number" && Number.isFinite(t)) k[key] = t;
  } catch {}
  return k;
}

/** The mode `key` opens in: Edit if the person last left it in Edit (or made it) here, else View. */
export function modeOf(key: string): DocMode {
  return Object.hasOwn(kept(), key) ? "edit" : "view";
}

/** The person left `key` in `mode` (their own toggle, or made it: Edit). What the store held that isn't a kept
 * time is dropped as it is written; nothing here throws (a store that can't be written keeps what it had). */
export function rememberMode(key: string, mode: DocMode): void {
  try {
    const k = kept();
    delete k[key];
    if (mode === "edit") {
      k[key] = Date.now();
      const keys = Object.keys(k);
      if (keys.length > MAX) for (const x of keys.sort((a, b) => k[a] - k[b]).slice(0, keys.length - MAX)) delete k[x];
    }
    localStorage.setItem(STORE, JSON.stringify(k));
  } catch {}
}

/** Whether focus is where typing goes (a field, an editor): there E types, and Esc keeps its own meaning. */
export function typingIn(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t.matches("input, textarea, select, [role=textbox]"));
}

/** The one shortcut, the same in every editor: E for Edit, Esc back to View, neither while typing nor with a modifier.
 * Which one `e` asks for, or null. */
export function shortcutMode(e: KeyboardEvent): DocMode | null {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat || typingIn(e.target) || typingIn(document.activeElement)) return null;
  if (e.key === "e" || e.key === "E") return "edit";
  if (e.key === "Escape") return "view";
  return null;
}
