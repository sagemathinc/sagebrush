// ci: web-runner order=161 runner=bun
// Where you were in a document (view-state.ts), without a page: what's kept, its bounds, two tabs writing, when
// keepView writes, and viewToRestore's rules (once; the person and a target in the URL win).
//   bun web/workspace/test-view-state.mjs
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => void store.set(k, String(v)) };
const win = new EventTarget();
globalThis.addEventListener = win.addEventListener.bind(win);
globalThis.removeEventListener = win.removeEventListener.bind(win);
globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
const { savedView, saveView, keepView, viewToRestore, VIEW_LIMITS } = await import("./view-state.ts");

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = "sagebrush-view-state";
const nb = (id) => ({ kind: "notebook", id });

// (kept and read back, per document and kind)
check(savedView(nb("a")) === null, "nothing kept: null");
saveView(nb("a"), { cell: "c1", dy: 12 });
saveView({ kind: "board", id: "a" }, { x: 1, y: 2, zoom: 1.5 });
check(same(savedView(nb("a")), { cell: "c1", dy: 12 }) && same(savedView({ kind: "board", id: "a" }), { x: 1, y: 2, zoom: 1.5 }), "kept per document and kind");
saveView(nb("a"), { cell: "c2", dy: 0 });
check(same(savedView(nb("a")), { cell: "c2", dy: 0 }), "kept again: the latest");

// (unreadable or foreign: treated as none, and a save starts afresh)
for (const bad of ["{not json", "[1,2]", "null", '"s"', JSON.stringify({ "notebook:a": { t: 1, v: [1] } })]) {
  store.set(KEY, bad);
  check(savedView(nb("a")) === null, `unreadable kept views (${bad.slice(0, 12)}): none`);
}
store.set(KEY, "{not json");
saveView(nb("b"), { frac: 0.5 });
check(same(savedView(nb("b")), { frac: 0.5 }), "after unreadable ones, a save is kept");

// (the length bound: at most VIEW_LIMITS.chars of JSON; a longer one isn't kept, and leaves the one before)
const at = (n) => ({ s: "x".repeat(n - 8) });
check(JSON.stringify(at(VIEW_LIMITS.chars)).length === VIEW_LIMITS.chars, "the bound's fixture is exact");
saveView(nb("c"), at(VIEW_LIMITS.chars));
check(same(savedView(nb("c")), at(VIEW_LIMITS.chars)), `a view of exactly ${VIEW_LIMITS.chars} characters: kept`);
saveView(nb("c"), at(VIEW_LIMITS.chars + 1));
check(same(savedView(nb("c")), at(VIEW_LIMITS.chars)), "one character over: not kept, the one before stays");
saveView(nb("c"), { f: () => 1 });
check(same(savedView(nb("c")), {}), "only data is kept (a function is dropped by JSON)");

// (the least recently kept dropped past VIEW_LIMITS.docs)
store.clear();
const now = Date.now;
let t = 1000;
Date.now = () => t;
for (let i = 0; i < VIEW_LIMITS.docs; i++) { t++; saveView(nb("d" + i), { i }); }
check(Object.keys(JSON.parse(store.get(KEY))).length === VIEW_LIMITS.docs, `${VIEW_LIMITS.docs} documents: all kept`);
t++; saveView(nb("d0"), { i: 0, again: true });
t++; saveView(nb("new"), { i: -1 });
const kept = JSON.parse(store.get(KEY));
check(Object.keys(kept).length === VIEW_LIMITS.docs && !kept["notebook:d1"] && !!kept["notebook:d0"] && !!kept["notebook:new"], "one more: the least recently kept (d1) dropped; d0, kept again since, stays");
Date.now = now;

// (two tabs: each save reads what's there first, so another tab's views are kept)
store.clear();
saveView(nb("tabA"), { a: 1 });
const other = JSON.parse(store.get(KEY));
other["board:tabB"] = { t: Date.now(), v: { b: 2 } };
store.set(KEY, JSON.stringify(other));
saveView(nb("tabA2"), { a: 2 });
check(same(savedView({ kind: "board", id: "tabB" }), { b: 2 }) && same(savedView(nb("tabA")), { a: 1 }), "another tab's view, written between, kept");

// (keepView: half a second after changed(), once; at pagehide and when hidden; at stop(); never after)
store.clear();
let view = { y: 1 }, reads = 0;
const k = keepView(nb("k"), () => { reads++; return view; });
k.changed(); k.changed(); k.changed();
check(savedView(nb("k")) === null, "changed(): not at once");
await sleep(650);
check(same(savedView(nb("k")), { y: 1 }) && reads === 1, `changed() three times: kept once, half a second later (${reads} reads)`);
view = { y: 2 };
win.dispatchEvent(new Event("pagehide"));
check(same(savedView(nb("k")), { y: 2 }), "pagehide: kept at once");
view = { y: 3 };
document.dispatchEvent(new Event("visibilitychange"));
check(same(savedView(nb("k")), { y: 2 }), "visible again: not kept");
document.visibilityState = "hidden";
document.dispatchEvent(new Event("visibilitychange"));
document.visibilityState = "visible";
check(same(savedView(nb("k")), { y: 3 }), "hidden: kept at once");
view = { y: 4 };
k.changed();
k.stop();
check(same(savedView(nb("k")), { y: 4 }), "stop(): kept at once");
view = { y: 5 };
win.dispatchEvent(new Event("pagehide"));
k.changed();
await sleep(650);
check(same(savedView(nb("k")), { y: 4 }), "after stop(): never kept again (pagehide, changed)");
const k2 = keepView(nb("k2"), () => null);
k2.stop();
check(savedView(nb("k2")) === null, "a read of null: nothing kept");

// (viewToRestore: once; the person's scroll, key or click before it, or a target in the URL, wins)
store.clear();
saveView(nb("r"), { cell: "c9" });
let get = viewToRestore(nb("r"), win);
check(same(get(), { cell: "c9" }), "untouched: the kept view");
check(get() === null, "asked again: null (applied once)");
for (const ev of ["wheel", "keydown", "pointerdown", "touchstart"]) {
  get = viewToRestore(nb("r"), win);
  win.dispatchEvent(new Event(ev));
  check(get() === null, `the person's ${ev} before it: null (no jump)`);
}
get = viewToRestore(nb("r"), win);
get();
win.dispatchEvent(new Event("wheel"));
check(same(viewToRestore(nb("r"), win)(), { cell: "c9" }), "after it's applied, a later scroll doesn't affect the next restore");
check(viewToRestore(nb("r"), win, true)() === null, "a target in the URL (skip): null");
// (its listeners on the editor's element gone once it's asked)
class Counted extends EventTarget {
  n = 0;
  addEventListener(...a) { this.n++; super.addEventListener(...a); }
  removeEventListener(...a) { this.n--; super.removeEventListener(...a); }
}
const el = new Counted();
get = viewToRestore(nb("r"), el);
const during = el.n;
get();
check(during === 4 && el.n === 0, `its listeners removed once it's asked (${during} while waiting, ${el.n} after)`);
check(viewToRestore(nb("none"), win)() === null, "nothing kept: null");

if (fails.length) { console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ")); process.exit(1); }
console.log(`ok: where you were in a document, ${checks} checks`);
