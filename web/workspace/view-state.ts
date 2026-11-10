// Where you were in a document (H7): kept when you go to another and back, reload, or open it in a new tab. One
// mechanism for every editor (design: the per-file view state, r1): the shell keeps each document's view; the
// editor says what its view is (its own fields: a notebook's top cell, a board's position and zoom, a PDF's page)
// and applies it again. Opening another document is a new page, so the view is kept in localStorage: per browser,
// never synced (a scroll depends on the window) and never sent anywhere; ids and numbers only, never content.
const KEY = "sagebrush-view-state";
/** At most this many documents' views (the least recently kept dropped first), each's JSON at most `chars` long. */
export const VIEW_LIMITS = { docs: 200, chars: 512 };
export type ViewKey = { kind: "notebook" | "board" | "tex"; id: string };
export type View = Record<string, unknown>;
type Kept = Record<string, { t: number; v: View }>;

const name = (k: ViewKey) => k.kind + ":" + k.id;
function all(): Kept {
  try {
    const m = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return m && typeof m === "object" && !Array.isArray(m) ? m : {};
  } catch { return {}; }
}

/** The view kept for `key`, or null (none, or unreadable). */
export function savedView(key: ViewKey): View | null {
  const e = all()[name(key)];
  return e && e.v && typeof e.v === "object" && !Array.isArray(e.v) ? e.v : null;
}

/** Keeps `v` as `key`'s view (read, changed and written back at once, so other documents' views, another tab's
 *  too, are kept); one longer than VIEW_LIMITS.chars isn't kept. */
export function saveView(key: ViewKey, v: View) {
  const s = JSON.stringify(v);
  if (s === undefined || s.length > VIEW_LIMITS.chars) return;
  const m = all();
  m[name(key)] = { t: Date.now(), v: JSON.parse(s) };
  const names = Object.keys(m);
  if (names.length > VIEW_LIMITS.docs) {
    names.sort((a, b) => (m[b]?.t || 0) - (m[a]?.t || 0));
    for (const n of names.slice(VIEW_LIMITS.docs)) delete m[n];
  }
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch {}
}

/** Keeps `read()` as `key`'s view: half a second after changed() (the editor calls it on a scroll or a zoom), when
 *  the page is hidden or left, and at stop() (the editor closing the document). */
export function keepView(key: ViewKey, read: () => View | null) {
  let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
  const now = () => { clearTimeout(timer); timer = undefined; if (stopped) return; const v = read(); if (v) saveView(key, v); };
  const hidden = () => { if (document.visibilityState === "hidden") now(); };
  addEventListener("pagehide", now);
  document.addEventListener("visibilitychange", hidden);
  return {
    changed() { if (!stopped && timer === undefined) timer = setTimeout(now, 500); },
    stop() { now(); stopped = true; removeEventListener("pagehide", now); document.removeEventListener("visibilitychange", hidden); },
  };
}

/** For the editor to apply once, after its first layout of the document: `key`'s kept view, or null when there is
 *  none, when `skip` (a target in the URL wins), or when the person has already scrolled, typed or clicked in `el`
 *  since this was called (the person wins: the page never jumps under them). A field naming what's gone since (a
 *  deleted cell, a page) is the editor's to fall back from: to the top, never an error. */
export function viewToRestore(key: ViewKey, el: EventTarget, skip = false): () => View | null {
  let touched = skip;
  const evs = ["wheel", "keydown", "pointerdown", "touchstart"];
  const mark = () => { touched = true; };
  for (const e of evs) el.addEventListener(e, mark, { capture: true, passive: true });
  return () => {
    for (const e of evs) el.removeEventListener(e, mark, { capture: true });
    const v = touched ? null : savedView(key);
    touched = true;
    return v;
  };
}
