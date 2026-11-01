// The Storage panel's lookalike report (plan L2b, lookalike-plan-l2b PLAN-r2 + PLAN-r3): api.ts lookalikeGroups reads
// the entries' byNfc index by VALUES in fixed pages of 500 (no key getter), each full page's trailing group by
// count() and a value cursor advanced past its rows in hand.  In headless Chromium against the built site, on each
// fixture (written straight into IndexedDB, the store first put back to its root and Trash rows only, so the index
// holds exactly one row outside the fixture, B = 1, /Trash):
//   - the report usage() gives the Storage panel (its real transaction; captured by the function's test-only hook) is
//     field for field the old key walk's, run in the test page on the same rows (kept here as the reference);
//   - the values delivered and the getAll, count and cursor requests are exactly what this test's own model of the
//     walk (written here, nothing imported from api.ts) gives for the fixture's rows; no path is delivered twice; no
//     page is over 500;
//   - the concurrent-write fixture: a readwrite transaction started inside the walk waits until it ends (the report is
//     the pre-write one); the early-EOF fixture: a count one too high makes the walk reject.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/workspace/test-workspace-lookalike.mjs            ONLY=a,b runs those fixtures
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const ONLY = new Set((process.env.ONLY ?? "").split(",").filter(Boolean));
const runs = (name) => !ONLY.size || ONLY.has(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-lookalike-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };

const PAGE = 500, GROUPS = 100, MEMBERS = 10;
/** The entries store, raw: `f` given the store. */
const IDB = `((f) => new Promise((ok, no) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => { const d = r.result, tx = d.transaction("entries", "readwrite"), q = f(tx.objectStore("entries")); tx.oncomplete = () => { d.close(); ok(q?.result ?? null); }; tx.onerror = () => no(tx.error); }; r.onerror = () => no(r.error); }))`;
const nkeyOf = (p) => p.slice(0, p.lastIndexOf("/") || 1) + "\u0000" + p.slice(p.lastIndexOf("/") + 1).normalize("NFC");
const row = (path, extra = {}) => ({ path, kind: "folder", ref: null, created: 1761900000000, updated: 1761900000000, fid: "lk" + path.length, nkey: nkeyOf(path), ...extra });
/** k rows sharing one synthetic nkey (more lookalikes than a name has forms), under `dir`, named name-00000... */
const group = (dir, name, k) => Array.from({ length: k }, (_, i) => row(`${dir}/${name}-${String(i).padStart(5, "0")}`, { nkey: dir + "\u0000" + name }));
/** f single rows under /lk, named a00000..., sorting before any group named from b on */
const fillers = (f) => Array.from({ length: f }, (_, i) => row("/lk/a" + String(i).padStart(5, "0")));
/** The index rows before /lk's children: /lk itself (the store starts empty in a fresh profile: B = 0) */
const BEFORE = 1;

/** The old walk (api.ts before L2), the reference: a KEY cursor over byNfc; `map` a path's logical form. */
const REF = (map) => `new Promise((ok, no) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => { const d = r.result, tx = d.transaction("entries", "readonly");
  const out = [], more = { groups: 0, members: 0 }; let key = null, cur = [], n = 0;
  const flush = () => { if (n > 1) { if (out.length < ${GROUPS}) { out.push(cur); more.members += n - cur.length; } else { more.groups++; more.members += n; } } };
  const map = ${map ?? "(p) => p"};
  const c = tx.objectStore("entries").index("byNfc").openKeyCursor();
  c.onsuccess = () => { const x = c.result; if (!x) { flush(); d.close(); return ok({ lookalikes: out, lookalikesMore: more }); } if (x.key !== key) { flush(); key = x.key; cur = []; n = 0; } n++; if (cur.length < ${MEMBERS}) cur.push(map(x.primaryKey)); x.continue(); };
  c.onerror = () => no(c.error); }; r.onerror = () => no(r.error); })`;
/** The index's rows (values, read through the store and sorted as the index orders them: nkey, then path). */
const indexRows = async () => (await ev(`${IDB}((s) => s.getAll())`)).filter((e) => typeof e.nkey === "string").sort((a, b) => (a.nkey < b.nkey ? -1 : a.nkey > b.nkey ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
/** This test's model of plan L2b's walk over the index's rows: the values delivered and the requests made, and
 * whether it rejects (its cursor finding fewer rows than counted); `countFor` as the fixture's hook. */
function model(rows, countFor) {
  let delivered = 0, getAll = 0, count = 0, cursor = 0, at = 0;
  for (;;) {
    getAll++;
    const page = rows.slice(at, at + PAGE);
    delivered += page.length;
    if (page.length < PAGE) return { delivered, getAll, count, cursor, reject: false };
    const k = page[PAGE - 1].nkey;
    let j = PAGE - 1;
    while (j > 0 && page[j - 1].nkey === k) j--;
    const m = PAGE - j;
    count++;
    let last = at + PAGE;
    while (last < rows.length && rows[last].nkey === k) last++;
    const real = last - (at + j), total = countFor ? countFor(k, real) : real;
    const want = Math.min(MEMBERS, total) - m;
    if (want > 0) {
      cursor++;
      const avail = real - m;
      if (avail < want) return { delivered: delivered + avail, getAll, count, cursor, reject: true };
      delivered += want;
    }
    at = last;
  }
}

/** The store put back to the page's own root and Trash rows (read at the start) plus `rows`; the move record, if any. */
let BASE = [];
const reset = (rows, extra = []) => ev(`${IDB}((s) => { s.clear(); for (const e of ${JSON.stringify([...BASE, ...rows, ...extra])}) s.put(e); return null; })`);

/** The Storage panel opened (again): its usage() runs, and the hook gives its report, the values delivered (with their
 * paths, per page), the requests by kind, and the marks.  `extra` adds to the hook (the fixtures' afterCount and
 * countFor); `ms` how long to wait for a report. */
async function panelReport(extra = "", ms = 120000) {
  await ev(`(() => { window.__lk = { result: null, delivered: 0, paths: [], pages: [], req: { getAll: 0, count: 0, cursor: 0 }, marks: {} };
    window.__SB_LOOKALIKE_TEST__ = { deliver: (p) => { window.__lk.delivered++; window.__lk.paths.push(p); if (window.__lk.inPage) window.__lk.pages[window.__lk.pages.length - 1]++; },
      request: (k) => { window.__lk.req[k]++; }, mark: (k) => { window.__lk.marks[k] = (window.__lk.marks[k] ?? 0) + 1; window.__lk.inPage = k === "page"; if (k === "page") window.__lk.pages.push(0); },
      result: (r) => { window.__lk.result = JSON.parse(JSON.stringify(r)); window.__lk.resultAt = performance.now(); }${extra ? ", " + extra : ""} };
    return 1; })()`);
  await ev(`(() => { document.querySelector("#wssidebar .fmeter").click(); return 1; })()`);
  await until(`!!window.__lk.result`, ms);
  return ev(`window.__lk`);
}

/** One fixture: the store reset to it, B asserted, the report against the reference, the counts against the model. */
async function fixture(name, rows, { map, extra = [], hook = "", countFor, expectReject = false, after } = {}) {
  if (!runs(name)) return;
  try {
    await reset(rows, extra);
    const idx = await indexRows(), mine = new Set(rows.map((e) => e.path));
    const B = idx.filter((e) => !mine.has(e.path)).length;
    check(B === 0, `${name}: the index holds no row outside the fixture (B = ${B}: ${JSON.stringify(idx.filter((e) => !mine.has(e.path)).map((e) => e.path)).slice(0, 80)})`);
    const want = model(idx, countFor);
    const ref = expectReject ? null : await ev(REF(map));
    const errs = errors.length;
    const r = await panelReport(hook, expectReject ? 15000 : Number(process.env.LK_REPORT_MS ?? 120000));
    if (expectReject) {
      const rejected = !r.result && errors.slice(errs).some((e) => /fewer than counted/.test(e));
      check(rejected && want.reject, `${name}: the walk rejects (its cursor finds fewer rows than counted): ` + (r.result ? "a report came" : errors.slice(errs).join(" | ").slice(0, 160)));
      errors.splice(errs);
    } else {
      check(!!r.result && JSON.stringify(r.result) === JSON.stringify(ref), `${name}: usage()'s report is the old key walk's, field for field: ` + String(JSON.stringify(r.result ?? null)).slice(0, 160) + (r.result && JSON.stringify(r.result) !== JSON.stringify(ref) ? " | old: " + JSON.stringify(ref).slice(0, 160) : ""));
    }
    const got = { delivered: r.delivered, getAll: r.req.getAll, count: r.req.count, cursor: r.req.cursor };
    check(got.delivered === want.delivered && got.getAll === want.getAll && got.count === want.count && got.cursor === want.cursor, `${name}: delivered and requests exactly the model's (N = ${idx.length}): ` + JSON.stringify(got) + " model " + JSON.stringify({ delivered: want.delivered, getAll: want.getAll, count: want.count, cursor: want.cursor }));
    check(new Set(r.paths).size === r.paths.length && Math.max(0, ...r.pages) <= PAGE, `${name}: no path delivered twice (${r.paths.length} delivered), no page over ${PAGE} (largest ${Math.max(0, ...r.pages)})`);
    if (after) await after(r);
  } catch (e) {
    check(false, name + ": threw: " + String(e?.stack ?? e).slice(0, 400));
  }
}

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: base });
  check(await until(`!!window.sagebrush?.workspace`, 90000), "the page's workspace comes up");
  await until(`!!document.querySelector("#wsfilesbtn") && !document.querySelector("#wsfilesbtn").hidden`, 60000);
  if (await ev(`document.querySelector('#wssidebar').hidden`)) await ev(`(() => { document.querySelector("#wsfilesbtn").click(); return 1; })()`);
  check(await until(`!!document.querySelector("#wssidebar .fmeter")`, 60000), "the file browser's storage meter is there");
  // (the page's own first-visit writes (its Welcome notebook) landed before the fixtures take the store over)
  await until(`${IDB}((s) => s.get("/Welcome.ipynb")).then((e) => !!e)`, 30000);
  await sleep(1000);
  // (the page's own rows of / and /Trash, if it keeps any in the store: a fresh profile's has none, so B = 0)
  BASE = (await ev(`${IDB}((s) => s.getAll())`)).filter((e) => e.path === "/" || e.path === "/Trash");
  console.log("(the store's own / and /Trash rows kept for each fixture: " + JSON.stringify(BASE.map((e) => e.path)) + ")");
  const lk = row("/lk");
  // ---- single-page fixtures
  await fixture("none", [lk, row("/lk/a"), row("/lk/b"), row("/lk/c")]);
  await fixture("pair", [lk, row("/lk/a"), row("/lk/b"), row("/lk/a/café"), row("/lk/a/café"), row("/lk/b/café")]);
  await fixture("pair-between", [lk, row("/lk/a"), row("/lk/a/café"), row("/lk/a/caff"), row("/lk/a/café")]);
  await fixture("many-groups", [lk, ...Array.from({ length: GROUPS + 5 }, (_, i) => group("/lk", "g" + String(i).padStart(3, "0"), 2)).flat()]);
  await fixture("many-members", [lk, ...group("/lk", "twelve", MEMBERS + 2)]);
  await fixture("trash", [row("/Trash/lk"), row("/Trash/lk/café"), row("/Trash/lk/café")]);
  await fixture("move", [lk, row("/lk/src"), row("/lk/src/café"), row("/lk/src/café")], { extra: [{ path: "\u0001rw", rid: "lktest", kind: "local", published: true, rev: 1, maps: [{ i: 0, from: "/lk/src", to: "/lk/dst" }], n: 3, fails: 0, stuck: "a test's move, left as it is", at: 1761900000000 }], map: `(p) => (p.startsWith("/lk/src/") ? "/lk/dst/" + p.slice(8) : p)` });
  await fixture("eof", [row("/zzzz-lk"), ...group("/zzzz-lk", "last", 3)]);
  await fixture("absent-nkey", [lk, ...group("/lk", "q", 2), row("/lk/q-00000x", { nkey: undefined }), ...group("/lk", "r", 2)]);
  // ---- multi-page fixtures
  await fixture("unique", [lk, ...Array.from({ length: 1249 }, (_, i) => row("/lk/u" + String(i).padStart(5, "0")))]);
  await fixture("larger-than-page", [lk, ...group("/lk", "big", 600)]);
  await fixture("exactly-page", [lk, ...group("/lk", "p500", PAGE)]);
  await fixture("page-plus-one", [lk, ...group("/lk", "p501", PAGE + 1)]);
  await fixture("two-pages-plus-one", [lk, ...group("/lk", "p1001", 2 * PAGE + 1)]);
  await fixture("three-pages-then", [lk, ...group("/lk", "t", 1400), ...group("/lk", "v1", 2), ...group("/lk", "v2", 2), ...group("/lk", "v3", 2)]);
  await fixture("five-thousand", [lk, ...group("/lk", "huge", 5000)]);
  await fixture("boundary", [lk, ...fillers(PAGE - BEFORE - 3), ...group("/lk", "m-end", 3), ...group("/lk", "n-start", 3)]);
  await fixture("exact-end", [lk, ...fillers(PAGE - BEFORE - 4), ...group("/lk", "x", 4)]);
  await fixture("whole-page", [lk, ...fillers(PAGE - BEFORE), ...group("/lk", "w", PAGE)]);
  // (page 1's trailing group has m of its n rows)
  const straddle = (m, n) => [lk, ...fillers(PAGE - BEFORE - m), ...group("/lk", "s", n)];
  await fixture("straddle-m1", straddle(1, 2));
  await fixture("straddle-m9", straddle(9, 10));
  await fixture("straddle-m10", straddle(10, 11));
  await fixture("straddle-m11", straddle(11, 12));
  await fixture("straddle-m5-n15", straddle(5, 15));
  // (the concurrent write: at the trailing group's count, a readwrite transaction adds a row sorting first in it; it
  // must wait until the walk's read-only transaction ends: the report is the pre-write one)
  const added = row("/lk/s-!", { nkey: "/lk\u0000s" });
  await fixture("concurrent", straddle(5, 15), { hook: `afterCount: (k) => { if (k !== "/lk\\u0000s" || window.__lk.rw) return; window.__lk.rw = { fired: performance.now() };
      const q = indexedDB.open("sagebrush-workspace"); q.onsuccess = () => { const d = q.result, t = d.transaction("entries", "readwrite"); window.__lk.rw.created = performance.now(); t.objectStore("entries").put(${JSON.stringify(added)}); t.oncomplete = () => { window.__lk.rw.done = performance.now(); d.close(); }; }; }`,
    after: async (r) => {
      const t = await ev(`window.__lk.rw ?? null`), at = r.resultAt;
      await until(`!!window.__lk.rw?.done`, 10000);
      const t2 = await ev(`window.__lk.rw ?? null`);
      // (open() is asynchronous: "created" is when the readwrite transaction exists, which may be after the walk's
      // result if open() answers late; the write itself completes only after the read)
      check(!!t2 && t2.fired < at && t2.done > at, `concurrent: the readwrite transaction started inside the walk (hook at ${Math.round(t2?.fired)}) completed after the walk's result (${Math.round(at)} < ${Math.round(t2?.done)}): it waited`);
      const there = await ev(`${IDB}((s) => s.get(${JSON.stringify(added.path)}))`);
      check(!!there, "concurrent: the added row is there afterwards");
      const post = await ev(REF());
      const r2 = await panelReport();
      check(JSON.stringify(r2.result) === JSON.stringify(post) && post.lookalikes.some((g) => g[0] === added.path), "concurrent: a second report is the post-write one (the added row first in its group)");
      void t;
    } });
  // (the early EOF: a count one too high (the test-only countFor) on a group of 2 with 1 in hand: the cursor finds one
  // row where it wants two, and the walk rejects)
  await fixture("eof-reject", straddle(1, 2), { hook: `countFor: (k, n) => (k === "/lk\\u0000s" ? n + 1 : n)`, countFor: (k, n) => (k === "/lk\u0000s" ? n + 1 : n), expectReject: true });
  await ev(`${IDB}((s) => { s.clear(); for (const e of ${JSON.stringify(BASE)}) s.put(e); return null; })`);
  check(errors.length === 0, "no page errors: " + errors.slice(0, 3).join(" | "));
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  ws.close();
  chrome.kill();
  await sleep(1000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
console.log(`${checks - fails.length}/${checks} passed`);
for (const f of fails) console.log("FAIL " + f);
process.exit(fails.length ? 1 : 0);
