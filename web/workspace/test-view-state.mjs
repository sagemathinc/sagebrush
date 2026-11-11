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
const at = (n) => {
  const o = {}, len = (x) => JSON.stringify({ ...x, p: 0 }).length;
  for (let i = 0; len({ ...o, ["s" + i]: "x".repeat(64) }) <= n - 12; i++) o["s" + i] = "x".repeat(64);
  if (n - len(o) > 12) o.t = "x".repeat(n - len(o) - 6 - 6);
  const d = n - len(o);
  o.p = d ? Number("9".repeat(d + 1)) : 0;
  return o;
};
check(JSON.stringify(at(VIEW_LIMITS.chars)).length === VIEW_LIMITS.chars && JSON.stringify(at(VIEW_LIMITS.chars + 1)).length === VIEW_LIMITS.chars + 1, "the bound's fixtures are exact");
saveView(nb("c"), at(VIEW_LIMITS.chars));
check(same(savedView(nb("c")), at(VIEW_LIMITS.chars)), `a view of exactly ${VIEW_LIMITS.chars} characters: kept`);
saveView(nb("c"), at(VIEW_LIMITS.chars + 1));
check(same(savedView(nb("c")), at(VIEW_LIMITS.chars)), "one character over: not kept, the one before stays");

// (only the shape VIEW_LIMITS allows, written or read: ids and finite numbers, in objects of short-named fields)
const ok = [{ cell: "c-1.x:y_z", dy: -3.5 }, { pdf: { page: 3, zoom: 1.5 }, src: { line: 40 } }, { a: { b: { c: 1 } } }, { id: "x".repeat(64) },
  Object.fromEntries(Array.from({ length: VIEW_LIMITS.fields }, (_, i) => ["f" + i, i])), { ["a" + "b".repeat(31)]: 1 }, {}];
for (const v of ok) { store.clear(); saveView(nb("s"), v); check(same(savedView(nb("s")), v), `allowed, kept: ${JSON.stringify(v).slice(0, 60)}`); }
const bad = [["a boolean", { on: true }], ["null", { x: null }], ["NaN", { x: NaN }], ["Infinity", { x: Infinity }], ["an array", { x: [1] }],
  ["a string with a space", { x: "a b" }], ["an empty string", { x: "" }], ["a 65-character string", { x: "x".repeat(65) }], ["text", { x: "<b>hi</b>" }],
  ["four deep", { a: { b: { c: { d: 1 } } } }], [`${VIEW_LIMITS.fields + 1} fields`, Object.fromEntries(Array.from({ length: VIEW_LIMITS.fields + 1 }, (_, i) => ["f" + i, i]))],
  ["a field named 1a", { "1a": 1 }], ["a field named a-b", { "a-b": 1 }], ["a 33-character field name", { ["a" + "b".repeat(32)]: 1 }], ["a function", { f: () => 1 }],
  ["an array view", [1]], ["a number view", 5], ["a null view", null]];
for (const [what, v] of bad) {
  store.clear(); saveView(nb("s"), { y: 1 }); const before = store.get(KEY);
  saveView(nb("s"), v);
  check(store.get(KEY) === before, `${what}: not kept, nothing written`);
}
const badKeys = [["another kind", { kind: "pdf", id: "a" }], ["an empty id", nb("")], ["a 65-character id", nb("x".repeat(65))], ["an id with a slash", nb("a/b")], ["no key", null]];
for (const [what, k] of badKeys) {
  store.clear(); saveView(k, { y: 1 });
  check(!store.has(KEY) && savedView(k) === null, `${what}: nothing kept or read`);
}
check(savedView(nb("x".repeat(64))) === null && (saveView(nb("x".repeat(64)), { y: 1 }), same(savedView(nb("x".repeat(64))), { y: 1 })), "a 64-character id: kept");

// (what's there read with the same checks: malformed, oversize or misnamed entries dropped, never returned or kept)
store.set(KEY, JSON.stringify({
  "notebook:good": { t: 5, v: { y: 2 } },
  "evil": { t: 5, v: { y: 1 } }, "pdf:a": { t: 5, v: { y: 1 } }, "notebook:a b": { t: 5, v: { y: 1 } },
  "notebook:t": { t: "5", v: { y: 1 } }, "notebook:noT": { v: { y: 1 } }, "notebook:txt": { t: 5, v: { y: "<script>" } },
  "notebook:arr": { t: 5, v: [1] }, "notebook:flat": 7,
  "notebook:big": { t: 5, v: Object.fromEntries(Array.from({ length: 16 }, (_, i) => ["f" + i, "x".repeat(64)])) },
}));
check(same(savedView(nb("good")), { y: 2 }) && ["t", "noT", "txt", "arr", "flat", "big", "a b"].every((i) => savedView(nb(i)) === null), "foreign entries: only the well-formed one read back");
saveView(nb("new"), { y: 3 });
check(same(Object.keys(JSON.parse(store.get(KEY))).sort(), ["notebook:good", "notebook:new"]), `foreign entries not kept by a save (${Object.keys(JSON.parse(store.get(KEY))).join(", ")})`);

// (the least recently kept dropped past VIEW_LIMITS.docs)
store.clear();
const now = Date.now;
let t = 1000;
Date.now = () => t;
for (let i = 0; i < VIEW_LIMITS.docs; i++) { t++; saveView(nb("d" + i), { i }); }
check(Object.keys(JSON.parse(store.get(KEY))).length === VIEW_LIMITS.docs, `${VIEW_LIMITS.docs} documents: all kept`);
t++; saveView(nb("d0"), { i: 0, again: 1 });
t++; saveView(nb("new"), { i: -1 });
const kept = JSON.parse(store.get(KEY));
check(Object.keys(kept).length === VIEW_LIMITS.docs && !kept["notebook:d1"] && !!kept["notebook:d0"] && !!kept["notebook:new"], "one more: the least recently kept (d1) dropped; d0, kept again since, stays");
Date.now = now;

// (two tabs, one after the other: each save reads what's there first, so another tab's views are kept. Two saves at
//  the same moment aren't coordinated, and one can be lost: best effort, by design, so not tested here)
store.clear();
saveView(nb("tabA"), { a: 1 });
const other = JSON.parse(store.get(KEY));
other["board:tabB"] = { t: Date.now(), v: { b: 2 } };
store.set(KEY, JSON.stringify(other));
saveView(nb("tabA2"), { a: 2 });
check(same(savedView({ kind: "board", id: "tabB" }), { b: 2 }) && same(savedView(nb("tabA")), { a: 1 }), "another tab's view, written before this save, kept");

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
