// Where you were in a document (H7): kept when you go to another and back, reload, or open it in a new tab. One
// mechanism for every editor (design/view-state.md): the shell keeps each document's view; the editor says what its
// view is (its own fields: a notebook's top cell, a board's position and zoom, a PDF's page) and applies it again.
// Opening another document is a new page, so the view is kept in localStorage: per browser, never synced (a scroll
// depends on the window) and never sent anywhere. Only what VIEW_LIMITS allows is kept or read back: ids and finite
// numbers, bounded; anything else there (another version's, or written by hand) is dropped, never returned.
const KEY = "sagebrush-view-state";
/** At most `docs` documents' views (the least recently kept dropped first). A view: an object of at most `fields`
 *  fields, each a finite number, an id (`ID`) or such an object again, at most `depth` deep; its JSON at most
 *  `chars` long. A field's name is a short word (`FIELD`). */
export const VIEW_LIMITS = { docs: 200, chars: 512, fields: 16, depth: 3 };
const ID = /^[\w.:-]{1,64}$/, FIELD = /^[A-Za-z][A-Za-z0-9_]{0,31}$/, KINDS = ["notebook", "board", "tex", "code"];
export type ViewKey = { kind: "notebook" | "board" | "tex" | "code"; id: string };
export type View = { [field: string]: number | string | View };
type Kept = Record<string, { t: number; v: View }>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function shaped(v: unknown, depth: number): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return ID.test(v);
  if (!isObj(v) || depth > VIEW_LIMITS.depth) return false;
  const ks = Object.keys(v);
  return ks.length <= VIEW_LIMITS.fields && ks.every((k) => FIELD.test(k) && shaped(v[k], depth + 1));
}
/** `v` as a view to keep or give back, or null: an object of the shape VIEW_LIMITS allows, its JSON short enough. */
const asView = (v: unknown): View | null => (isObj(v) && shaped(v, 1) && JSON.stringify(v).length <= VIEW_LIMITS.chars ? (v as View) : null);
const name = (k: ViewKey) => (KINDS.includes(k?.kind) && typeof k.id === "string" && ID.test(k.id) ? k.kind + ":" + k.id : null);
/** The kept views, each checked: a malformed or oversize entry, or one with a name no key makes, is dropped. */
function all(): Kept {
  const out: Kept = {};
  try {
    const m = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!isObj(m)) return out;
    for (const [n, e] of Object.entries(m)) {
      const i = n.indexOf(":");
      if (i < 0 || name({ kind: n.slice(0, i) as ViewKey["kind"], id: n.slice(i + 1) }) !== n || !isObj(e) || typeof e.t !== "number" || !Number.isFinite(e.t)) continue;
      const v = asView(e.v);
      if (v) out[n] = { t: e.t, v };
    }
  } catch {}
  return out;
}

/** The view kept for `key`, or null (none, or not a view VIEW_LIMITS allows). */
export function savedView(key: ViewKey): View | null {
  const n = name(key);
  return (n && all()[n]?.v) || null;
}

/** Keeps `v` as `key`'s view, if VIEW_LIMITS allows it (else nothing changes). What's kept is read, changed and
 *  written back, so other documents' views stay; but two tabs writing at the same moment aren't coordinated, so one
 *  of their changes can be lost (a view not kept, never a wrong one: best effort, as a scroll position can be). */
export function saveView(key: ViewKey, v: View) {
  const n = name(key), view = asView(v);
  if (!n || !view) return;
  const m = all();
  m[n] = { t: Date.now(), v: JSON.parse(JSON.stringify(view)) };
  const names = Object.keys(m);
  if (names.length > VIEW_LIMITS.docs) {
    names.sort((a, b) => m[b].t - m[a].t);
    for (const x of names.slice(VIEW_LIMITS.docs)) delete m[x];
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
