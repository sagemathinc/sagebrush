// The cases of web/workspace/test-workspace-sync-old.mjs: EXACT-ONLY's old-sync detector (sync-old.ts; plan-exact-only
// §5A r2, OLD1-OLD10, with astra3's and the grader's additions).  Fixtures are written by the functions that write them
// where there are any (the journal's t1Write and askMerge, keepBundle, switchTo, syncOffIf), else with sync-rows' own
// key builders.  Each case starts with both history databases deleted (they are the origin's, not the workspace's).
import * as W from "./ws.js";

const results = [];
const check = (ok, what) => results.push([!!ok, what]);
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const names = () => { n++; return { name: `ws-old-${n}-${Math.random().toString(36).slice(2, 8)}`, mainName: `main-old-${n}` }; };
const opened = [];
const fresh = async (nm = names()) => { localStorage.clear(); const w = await W.Workspace.open(nm); opened.push(w); return Object.assign(w, { nm }); };
const until = async (f, ms = 5000) => { const t = Date.now(); for (;;) { try { if (await f()) return true; } catch {} if (Date.now() - t > ms) return false; await sleep(20); } };
const rq = (r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const done = (tx) => new Promise((ok, no) => { tx.oncomplete = () => ok(); tx.onerror = tx.onabort = () => no(tx.error ?? new Error("aborted")); });
const HIST = { nb: "sagebrush-history", board: "sagebrush-board-history" };
const NS = (w, lead = "a") => `${lead.repeat(64)}:1:${w.device}`;
const ID = (k) => `0b0e${String(k).padStart(4, "0")}-1111-4222-8333-444455556666`;

// (both history databases deleted: every handle the page holds closes on versionchange (stores.js); bounded)
async function dropHistory() {
  for (const name of Object.values(HIST)) {
    const r = indexedDB.deleteDatabase(name);
    const ok = await Promise.race([new Promise((ok) => { r.onsuccess = () => ok(true); r.onerror = () => ok(false); }), sleep(5000).then(() => false)]);
    if (!ok) throw new Error(`${name} couldn't be deleted`);
  }
}
// (a history database opened, made if absent, as stores.js makes it)
const hist = (which) => (which === "board" ? W.openBoardHistoryDb() : W.openHistoryDb());
async function inHist(which, f) {
  const db = await hist(which);
  try {
    const tx = db.transaction("history", "readwrite"), st = tx.objectStore("history"), end = done(tx);
    let failed = null;
    const out = await f(st).catch((e) => { failed = e; try { tx.abort(); } catch {} });
    await end.catch((e) => { throw failed ?? e; });
    return out;
  } finally {
    db.close();
  }
}
// (a journaled save of document `id`, as a save without sync writes it: the registry, n, j, its intent, budgets)
const localSave = (which, id, k = 1) => inHist(which, (st) => W.t1Write(st, id, { row: { nb: id, time: `${String(k).padStart(11, "0")}_loc`, env: { k } }, intent: { srev: null, value: "v" + k }, noun: which === "board" ? "board" : "notebook" }));
// (a document's synced history started, with its root patch, as sync's first save writes it: m, s, l, the debt, the synced key)
const syncedSave = (which, id) => inHist(which, (st) => W.t1Write(st, id, { row: { nb: W.syncedKey(id, 1), time: "0000000000a_cl1", env: { root: true } }, start: { n: 1, client: "cl1" }, noun: which === "board" ? "board" : "notebook" }));
// (the handle the registry gave document `id`)
const handleOf = (which, id) => inHist(which, async (st) => (await rq(st.get(W.registryKey(W.JOURNAL_NS, id))))?.v?.h);
const putRow = (which, row) => inHist(which, async (st) => { st.put(row); });
const meta = (w, k) => rq(w.ws.transaction("meta").objectStore("meta").get(k));
const putMeta = (w, k, v) => { const tx = w.ws.transaction("meta", "readwrite"); tx.objectStore("meta").put(v, k); return done(tx); };
const putStore = (w, s, v) => { const tx = w.ws.transaction(s, "readwrite"); tx.objectStore(s).put(v); return done(tx); };
// (one record of each sync-only store, by its key path)
const STORE_ROW = { outbox: { ns: "x", dseq: 1 }, syncIndex: { ns: "x", id: "f" }, adoptJournal: { ns: "x", id: "f", parent: "p" }, pins: { id: "f", seq: 1 }, pending: { id: "f" }, syncLedger: { ns: "x", lseq: 1, d: 0 } };

// ---- the page's views of a workspace: the owner's, the sidebar's line, the panel's

function fakeServer(status) {
  const s = { posts: [], next: [] };
  s.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path === "/api/share/me") return Response.json({ account_id: "acct-old" });
    if (path === "/api/sync/v1/status") return Response.json({ ...status, account: await hashOf("acct-old") });
    if (init.method === "POST") {
      s.posts.push(path);
      const a = s.next.shift() ?? { status: 200, body: { generation: 1 } };
      return new Response(J(a.body ?? {}), { status: a.status, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  return s;
}
const hashOf = async (id) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("sagebrush-account\n" + id)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const hostOf = (w) => ({ say: () => {}, fail: () => {}, usage: () => w.usage(), confirm: () => true, prompt: () => "delete" });
const buttons = (el) => [...el.querySelectorAll("button")].map((b) => (b.disabled ? "[x] " : "") + b.textContent);

/** What the page shows for workspace `w`: the owner reconciled, its view, a client or none, the sidebar's line, and the
 * panel's buttons and text (status: sync off for the account). */
async function shown(w, srv = fakeServer({ available: true, state: "off" })) {
  const owner = W.SyncOwner.of(w, { fetch: srv.fetch, origin: location.origin });
  await owner.reconcile();
  const s = owner.view().s;
  const el = document.body.appendChild(document.createElement("div"));
  const sec = W.syncSection(w, el, hostOf(w), { fetch: srv.fetch });
  try {
    await until(() => buttons(el).some((b) => /Turn on sync/.test(b)), 3000);
    return { s, client: owner.client !== null, line: W.sidebarLine(s), buttons: buttons(el), text: el.textContent, owner, el, sec, srv };
  } finally {
    sec.dispose();
    el.remove();
  }
}
const isOld = (v) => v.s.state === "off" && v.s.reason === W.OLD_SYNC_REASON && !v.client && v.line === "Sync off: " + W.OLD_SYNC_REASON && J(v.buttons) === J(["[x] Turn on sync…"]) && v.text.includes(W.OLD_SYNC_MESSAGE);
const isClean = (v) => v.s.reason !== W.OLD_SYNC_REASON && J(v.buttons) === J(["Turn on sync…"]) && !v.text.includes(W.OLD_SYNC_MESSAGE);
// (R-DET-1: a read that failed, or an unexpected schema: off and refused the same, said without any clear-data advice)
const isUnreadable = (v) => v.s.state === "off" && v.s.reason === W.UNREADABLE_REASON && !v.client && v.line === "Sync off: " + W.UNREADABLE_REASON && J(v.buttons) === J(["[x] Turn on sync…"]) && v.text.includes(W.UNREADABLE_MESSAGE) && !v.text.includes(W.OLD_SYNC_MESSAGE) && !/clear this site|site data|deletes/i.test(v.text);
const brief = (v) => J({ s: v.s, client: v.client, line: v.line, buttons: v.buttons });
// (the panel's enable, through its button, against `srv` (enable answers generation 1): whether a lease was written)
async function enableVia(w, srv = fakeServer({ available: true, state: "off" })) {
  W.SyncOwner.of(w, { fetch: srv.fetch, origin: location.origin });
  const el = document.body.appendChild(document.createElement("div"));
  const sec = W.syncSection(w, el, hostOf(w), { fetch: srv.fetch });
  try {
    await until(() => buttons(el).includes("Turn on sync…"), 3000);
    const b = [...el.querySelectorAll("button")].find((x) => x.textContent === "Turn on sync…" && !x.disabled);
    b?.click();
    const saidAny = () => el.textContent.includes(W.OLD_SYNC_MESSAGE) || el.textContent.includes(W.UNREADABLE_MESSAGE);
    await until(async () => srv.posts.length > 0 || (await meta(w, "sync:current")) || saidAny(), 3000);
    await until(async () => !!(await meta(w, "sync:current")) || saidAny(), 1500);
    return { clicked: !!b, posts: [...srv.posts], lease: await meta(w, "sync:current"), proto: await meta(w, W.PROTO_KEY), said: el.textContent.includes(W.OLD_SYNC_MESSAGE), saidUnreadable: el.textContent.includes(W.UNREADABLE_MESSAGE) };
  } finally {
    sec.dispose();
    el.remove();
  }
}

// ---- the cases

async function union() {
  // (the classification is complete and disjoint: SIGNAL ∪ LOCAL = FAMILIES ∪ RETIRED; `a` local (sync-docs' ruling))
  const p = W.classificationProblems();
  check(p.length === 0, "union: every family classified once: " + J(p));
  check(J(W.classificationProblems([...Object.values(W.FAMILIES), "q"])) === J(["unclassified q"]), "union: an unclassified letter is found");
  check(W.LOCAL_FAMILIES.includes("a") && !W.SIGNAL_FAMILIES.includes("a") && W.RETIRED_FAMILIES.includes("a"), "union: `a` is local and retired");
}

// (OLD1's signals, the test's own copies of the agreed lists (sync-docs' classification, `a` local by its ruling), so a
// signal dropped from the detector's constants fails its case instead of dropping it)
const SIGNALS = { families: ["l", "m", "s", "k", "c", "o", "x", "z"], meta: ["b:d:"], stores: ["outbox", "syncIndex", "adoptJournal", "pins", "pending", "syncLedger"] };

/** OLD1: each signal alone fires it (one case per entry of the agreed lists), seen by the owner, the sidebar and the
 * panel. */
async function old1() {
  check(J(SIGNALS.families) === J([...W.SIGNAL_FAMILIES]) && J(SIGNALS.meta) === J([...W.SIGNAL_META]) && J(SIGNALS.stores) === J([...W.SYNC_ONLY_STORES]), "OLD1: the detector's lists are the agreed ones: " + J([W.SIGNAL_FAMILIES, W.SIGNAL_META, W.SYNC_ONLY_STORES]));
  const signals = [
    ["meta: the lease", (w) => putMeta(w, "sync:current", { ns: NS(w), gen: 1 })],
    ["meta: a lease turned off", (w) => putMeta(w, "sync:current", { ns: NS(w), gen: 1, off: true })],
    ["meta: sync:<ns>:cursor", (w) => putMeta(w, `sync:${NS(w)}:cursor`, 3)],
    ["meta: sync:epoch", (w) => putMeta(w, "sync:epoch", 1)],
    ...SIGNALS.stores.map((s) => [`store: ${s}`, (w) => putStore(w, s, STORE_ROW[s])]),
  ];
  for (const which of ["nb", "board"]) {
    for (const L of SIGNALS.families) signals.push([`${which} history: family ${L}`, async () => {
      const id = ID(1);
      await localSave(which, id);
      const h = await handleOf(which, id);
      await putRow(which, { nb: W.SYNC_NB + h, time: L === "l" || L === "o" ? W.seqKey(h, L, 1)[1] : L, v: { x: 1 } });
    }]);
    for (const p of SIGNALS.meta) signals.push([`${which} history: ${p}`, () => putRow(which, { nb: W.SYNC_NB, time: p + "local", v: { count: 1, bytes: 9 } })]);
    signals.push([`${which} history: a synced key`, () => putRow(which, { nb: W.syncedKey(ID(2), 1), time: "0000000000a_cl1", env: {} })]);
  }
  for (const [name, write] of signals) {
    await dropHistory();
    const w = await fresh();
    await write(w);
    const d = await W.detectOldSync(w), v = await shown(w);
    check(d.old && isOld(v), `OLD1 ${name}: detected (${J(d)}), sync off with the message: ${brief(v)}`);
  }
}

/** OLD2: a device that never synced, with journaled saves (registry, n, j, p, budgets) in both databases, files, a
 * board, an own-key history, a real keepBundle restore (its `a` row) is not flagged, and turning on proceeds. */
async function old2() {
  await dropHistory();
  const w = await fresh();
  await w.create("/a.txt", { content: "a" });
  await w.write("/a.txt", "a2");
  for (let k = 1; k <= 3; k++) { await localSave("nb", ID(10), k); await localSave("board", ID(11), k); }
  await putRow("nb", { nb: ID(12), time: "00000000001_x", env: {} });
  const restored = ID(13);
  const hdb = await hist("nb");
  try { await W.keepBundle({ history: [{ time: "00000000001_r", parents: [] }], blobs: {} }, restored, { hdb, bdb: null }); } finally { hdb.close(); }
  const rows = await inHist("nb", (st) => rq(st.getAll(IDBKeyRange.bound([W.SYNC_NB, ""], [W.SYNC_NB + "￿", "￿"]))));
  const times = rows.map((r) => (r.nb === W.SYNC_NB ? r.time.replace(/:.*/, ":") : r.time[0]));
  // (the restore's `a` row only while this tree still writes one: sync-docs' exact-only branch removes askMerge)
  const premise = ["d:", "n", "b:", "j", "p", ...("asked" in W.FAMILIES ? ["a"] : [])].every((t) => times.includes(t));
  check(premise, "OLD2 premise: journaled saves and a restore write the registry, n, budgets, j, p (and a, while written) rows: " + J([...new Set(times)]));
  const d = await W.detectOldSync(w), v = await shown(w);
  check(!d.old && isClean(v), `OLD2: never synced, journal rows and a restore's a row: not flagged (${J(d)}), Turn on offered: ${brief(v)}`);
  const e = await enableVia(w);
  check(e.lease?.ns === `${await hashOf("acct-old")}:1:${w.device}` && e.proto === W.PROTO && !e.said, "OLD2: turning on proceeds, the lease and the marker written: " + J(e));
}

/** The `a` rows (sync-docs' ruling): a real keepBundle `a` row alone reads clean; `a` with a real `m` row reads old. */
async function asked() {
  // (the `a` row as master 78cf5353's keepBundle writes it: by that build itself when its tree is given (OLD_TREES), and
  // checked the same as the row written here otherwise; this tree's keepBundle only while it still writes one)
  const OLD = (window.OLD_BUILDS ?? []).includes("78cf") ? await import("./old-78cf.js") : null;
  const ROW_A = { asked: "legacy" };
  await dropHistory();
  const w = await fresh(), id = ID(20), bundle = { history: [{ time: "00000000001_r", parents: [] }], blobs: {} };
  const hdb = OLD ? await OLD.openHistoryDb() : await hist("nb");
  try { await (OLD ?? W).keepBundle(bundle, id, { hdb, bdb: null }); } finally { hdb.close(); }
  let h = await handleOf("nb", id), a = h === undefined ? undefined : await inHist("nb", (st) => rq(st.get([W.SYNC_NB + h, "a"])));
  const by = OLD ? "78cf5353's keepBundle" : a ? "this tree's keepBundle" : "written as 78cf5353 writes it";
  if (!OLD && !a) {
    await localSave("nb", id);
    h = await handleOf("nb", id);
    await putRow("nb", { nb: W.SYNC_NB + h, time: "a", v: ROW_A });
    a = await inHist("nb", (st) => rq(st.get([W.SYNC_NB + h, "a"])));
  }
  check(J(a?.v) === J(ROW_A), `asked: the a row (${by}): ` + J(a));
  const d1 = await W.detectOldSync(w);
  check(!d1.old, "asked: an a row alone is clean: " + J(d1));
  // (the a row and a start row m alone, m as the journal writes it: old, by m)
  await putRow("nb", { nb: W.SYNC_NB + h, time: "m", v: { n: 1, from_j: 1, asked: "legacy" } });
  const dm = await W.detectOldSync(w);
  check(dm.old && dm.why === "sagebrush-history:family:m", "asked: a with an m row alone is old, by m: " + J(dm));
  await inHist("nb", async (st) => { st.delete([W.SYNC_NB + h, "m"]); });
  await syncedSave("nb", id);
  const m = await inHist("nb", (st) => rq(st.get([W.SYNC_NB + h, "m"])));
  const d2 = await W.detectOldSync(w), v = await shown(w);
  check(m?.v?.n === 1 && d2.old && isOld(v), `asked: a with a real m row is old (${J(d2)}): ${brief(v)}`);
}

/** OLD3: a device turned on by this build (the marker with its lease) and off again is not flagged; its line "Sync off". */
async function old3() {
  await dropHistory();
  const w = await fresh();
  await W.switchToIf(w, NS(w));
  await syncedSave("nb", ID(30));
  await W.syncOffIf(w);
  const d = await W.detectOldSync(w), v = await shown(w);
  check((await meta(w, W.PROTO_KEY)) === 2 && !d.old && v.line === "Sync off" && isClean(v), `OLD3: this build's own state, off: not flagged (${J(d)}): ${brief(v)}`);
}

/** OLD4: nothing deleted or changed: every store of the workspace and both history databases, compared before and after
 * detection, the owner's reconcile, the panel, and a refused enable. */
async function old4() {
  await dropHistory();
  const w = await fresh();
  await w.create("/k.txt", { content: "keep" });
  await putMeta(w, "sync:current", { ns: NS(w), gen: 4, off: true });
  await putStore(w, "outbox", STORE_ROW.outbox);
  await localSave("nb", ID(40));
  await syncedSave("board", ID(41));
  const dump = async () => {
    const out = {};
    for (const s of [...w.ws.objectStoreNames]) out["ws:" + s] = J([await rq(w.ws.transaction(s).objectStore(s).getAllKeys()), await rq(w.ws.transaction(s).objectStore(s).getAll())]);
    for (const which of ["nb", "board"]) out[which] = J(await inHist(which, (st) => rq(st.getAll())));
    return out;
  };
  const before = await dump();
  const v = await shown(w), e = await enableVia(w), after = await dump();
  const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
  check(isOld(v) && e.said && changed.length === 0, `OLD4: nothing changed (${J(changed)}), refused enable said: ${J(e)}`);
}

/** OLD5: fail closed: a read that throws, at each step, leaves sync off with the message; not kept: once readable, clean. */
async function old5() {
  for (const step of ["meta", ...W.SYNC_ONLY_STORES.map((s) => "store:" + s), ...W.HISTORY_DBS.map((d) => "history:" + d)]) {
    await dropHistory();
    const w = await fresh();
    W.OLD_SYNC_HOOK.fault = (s) => { if (s === step) throw new Error("injected " + s); };
    let d, v, e;
    try {
      d = await W.detectOldSync(w);
      v = await shown(w);
      e = await enableVia(w);
    } finally {
      W.OLD_SYNC_HOOK.fault = undefined;
    }
    const v2 = await shown(w);
    check(d.old && d.unreadable && /^unreadable/.test(d.why) && isUnreadable(v) && !e.lease && !e.proto && e.saidUnreadable && !e.said && isClean(v2), `OLD5 ${step}: a throw is unreadable (${J(d)}), said without clear-data advice: ${brief(v)}; enable refused (${J(e)}); read again once readable: ${brief(v2)}`);
  }
}

/** OLD6: admission rechecks: clean when the page reconciled; a signal written after; turning on refuses, nothing written. */
async function old6() {
  for (const [name, write] of [["history family m", () => syncedSave("nb", ID(60))], ["a sync store", (w) => putStore(w, "pins", STORE_ROW.pins)], ["sync meta", (w) => putMeta(w, `sync:${NS(w)}:cursor`, 1)]]) {
    await dropHistory();
    const w = await fresh();
    const v1 = await shown(w);
    await write(w);
    const e = await enableVia(w);
    check(isClean(v1) && e.clicked && e.posts.length === 0 && !e.lease && e.proto === undefined && e.said, `OLD6 ${name}: clean at load, refused at turn-on before asking the server: ${J(e)}`);
    // (switchToIf's own read, without the panel's: refused, nothing written)
    let threw = null;
    try { await W.switchToIf(w, NS(w)); } catch (x) { threw = x; }
    check(threw instanceof W.OldSyncError && (await meta(w, W.PROTO_KEY)) === undefined, `OLD6 ${name}: switchToIf refuses afresh: ${threw?.name}`);
  }
  // (a signal written between switchToIf's detection and its transaction: the meta read in the transaction refuses)
  await dropHistory();
  const w = await fresh();
  W.OLD_SYNC_HOOK.between = () => putMeta(w, `sync:${NS(w, "b")}:cursor`, 1);
  let threw = null;
  try { await W.switchToIf(w, NS(w)); } catch (x) { threw = x; } finally { W.OLD_SYNC_HOOK.between = undefined; }
  check(threw instanceof W.OldSyncError && (await meta(w, "sync:current")) === undefined && (await meta(w, W.PROTO_KEY)) === undefined, "OLD6 late: sync meta written after the detection is refused in the lease's transaction: " + threw?.name);
}

/** OLD7: local editing untouched in the detected state: a file, a notebook's and a board's journaled saves, reopened. */
async function old7() {
  await dropHistory();
  const nm = names();
  let w = await fresh(nm);
  await putMeta(w, "sync:current", { ns: NS(w), gen: 1 });
  const v = await shown(w);
  await w.create("/e.txt", { content: "one" });
  await w.write("/e.txt", "two");
  await localSave("nb", ID(70), 1);
  await localSave("nb", ID(70), 2);
  await localSave("board", ID(71), 1);
  W.SyncOwner.of(w).destroy();
  w.close();
  w = await fresh(nm);
  const text = await w.read("/e.txt").then((r) => (typeof r === "string" ? r : new TextDecoder().decode(r?.bytes ?? r?.content ?? r))).catch((e) => "error " + e);
  const nbRows = await inHist("nb", (st) => rq(st.getAll(IDBKeyRange.bound([ID(70), ""], [ID(70), "￿"]))));
  const bRows = await inHist("board", (st) => rq(st.getAll(IDBKeyRange.bound([ID(71), ""], [ID(71), "￿"]))));
  check(isOld(v) && /two/.test(J(text)) && nbRows.length === 2 && bRows.length === 1 && (await W.detectOldSync(w)).old, `OLD7: detected, and the edits are there after reopening: ${J(text).slice(0, 80)}, ${nbRows.length} + ${bRows.length} patches`);
}

/** OLD9: absence is clean: no history databases at all; no board history database. */
async function old9() {
  await dropHistory();
  const w = await fresh();
  // (Workspace.open made neither; the detector opens them as they are, never made)
  await dropHistory();
  const d1 = await W.detectOldSync(w);
  const dbs = (await indexedDB.databases()).map((d) => d.name);
  check(!d1.old && !dbs.includes(HIST.nb) && !dbs.includes(HIST.board), `OLD9: no history databases: clean (${J(d1)}), none made: ${J(dbs.filter((x) => /history/.test(x)))}`);
  await localSave("nb", ID(90));
  const d2 = await W.detectOldSync(w), v = await shown(w);
  const dbs2 = (await indexedDB.databases()).map((d) => d.name);
  check(!d2.old && isClean(v) && !dbs2.includes(HIST.board), `OLD9: no board history database: clean (${J(d2)}): ${brief(v)}`);
}

/** The schema (astra3's note, @sagebrush's ruling): a history database that exists without the history store, or with
 * one keyed otherwise, reads as old (fail closed), in each database; an empty one made as stores.js makes it, clean. */
async function schema() {
  const make = (name, store, keyPath) => new Promise((ok, no) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => { if (store) r.result.createObjectStore(store, keyPath ? { keyPath } : undefined); };
    r.onsuccess = () => { r.result.close(); ok(); };
    r.onerror = () => no(r.error);
  });
  for (const [which, name] of Object.entries(HIST)) {
    for (const [what, store, keyPath] of [["no store at all", null], ["another store only", "other"], ["history keyed otherwise", "history", "id"]]) {
      await dropHistory();
      const w = await fresh();
      await dropHistory();
      await make(name, store, keyPath);
      const d = await W.detectOldSync(w), v = await shown(w);
      check(d.old && d.unreadable && /^schema:/.test(d.why) && isUnreadable(v), `schema ${which} ${what}: unreadable, sync refused without clear-data advice (${J(d)}): ${brief(v)}`);
    }
    await dropHistory();
    const w = await fresh();
    await dropHistory();
    await make(name, "history", ["nb", "time"]);
    const d = await W.detectOldSync(w);
    check(!d.old, `schema ${which}: as stores.js makes it, empty: clean (${J(d)})`);
  }
}

/** N-DET-1 (accepted by @sagebrush, pinned): a never-synced notebook whose history key ends like a synced one
 * ("file:/draft:s2") reads as old: a false positive that fails closed. */
async function falsePositive() {
  await dropHistory();
  const w = await fresh();
  await putRow("nb", { nb: "file:/draft:s2", time: "00000000001_loc", env: {} });
  const d = await W.detectOldSync(w);
  check(d.old && !d.unreadable && d.why === "sagebrush-history:synced:file:/draft:s2", "N-DET-1 pinned: a never-synced file named like a synced key reads old (accepted false positive): " + J(d));
}

/** OLD10: the marker's edges.  Malformed markers; a failed lease transaction; a stale one; an enable that committed and
 * failed after; a refused enable writes neither; the marker with old rows (the accepted risk) pinned as not flagged. */
async function old10() {
  for (const bad of ["2", 1, 3, null, { v: 2 }, [2], 2.5]) {
    await dropHistory();
    const w = await fresh();
    await putMeta(w, W.PROTO_KEY, bad);
    // (not this build's marker: itself sync meta that isn't the marker, so old (fail closed); a lease beside it, old)
    const alone = await W.detectOldSync(w);
    await putMeta(w, "sync:current", { ns: NS(w), gen: 1 });
    const d = await W.detectOldSync(w);
    let threw = null;
    try { await W.switchToIf(w, NS(w)); } catch (x) { threw = x; }
    check(alone.old && d.old && threw instanceof W.OldSyncError && J(await meta(w, W.PROTO_KEY)) === J(bad), `OLD10 malformed marker ${J(bad)}: old alone (${J(alone)}) and with a lease, enable refused, the marker left as it was`);
  }
  // (the lease's transaction failing after the marker is written: neither kept, and the next enable works)
  await dropHistory();
  let w = await fresh();
  W.OLD_SYNC_HOOK.fault = (s) => { if (s === "lease") throw new Error("injected lease"); };
  let threw = null;
  try { await W.switchToIf(w, NS(w)); } catch (x) { threw = x; } finally { W.OLD_SYNC_HOOK.fault = undefined; }
  const after = [await meta(w, W.PROTO_KEY), await meta(w, "sync:current")];
  const again = await W.switchToIf(w, NS(w));
  check(/injected lease/.test(threw?.message) && J(after) === J([null, null].map(() => undefined)) && again?.gen === 1 && (await meta(w, W.PROTO_KEY)) === 2, `OLD10 aborted lease transaction: nothing kept (${J(after)}), then on: ${J(again)}`);
  // (a stale compare-and-set: nothing written)
  await dropHistory();
  w = await fresh();
  const mark = await W.readLife(w);
  await W.switchToIf(w, NS(w, "c"));
  await W.syncOffIf(w);
  const stale = await W.switchToIf(w, NS(w, "d"), mark);
  check(stale === null && (await meta(w, "sync:current"))?.ns === NS(w, "c"), "OLD10 stale: a late enable writes nothing: " + J(await meta(w, "sync:current")));
  // (committed, then the enable's flow failing after it: reopened, not flagged)
  await dropHistory();
  const nm = names();
  w = await fresh(nm);
  await W.switchToIf(w, NS(w));
  await syncedSave("nb", ID(100));
  w.close();
  w = await fresh(nm);
  const d1 = await W.detectOldSync(w);
  check(!d1.old, "OLD10 committed then failed after: not flagged on reopening: " + J(d1));
  // (a refused enable writes neither the marker nor the lease)
  await dropHistory();
  w = await fresh();
  await syncedSave("board", ID(101));
  const e = await enableVia(w);
  let t2 = null;
  try { await W.switchToIf(w, NS(w)); } catch (x) { t2 = x; }
  check(e.said && t2 instanceof W.OldSyncError && (await meta(w, W.PROTO_KEY)) === undefined && (await meta(w, "sync:current")) === undefined, "OLD10 refused: neither the marker nor the lease: " + J(e));
  // (the accepted risk, pinned: the marker present and old-family rows written after: not flagged)
  await dropHistory();
  w = await fresh();
  await W.switchToIf(w, NS(w));
  await W.syncOffIf(w);
  await putStore(w, "syncLedger", STORE_ROW.syncLedger);
  await syncedSave("nb", ID(102));
  const d3 = await W.detectOldSync(w);
  check(!d3.old, "OLD10 accepted risk: the marker with old rows is not flagged (documented): " + J(d3));
}

/** The scan's bound: a large clean history (500 notebooks × 50 versions, 50 boards × 50) read in time; the same with one
 * synced key at the end found. */
async function large() {
  await dropHistory();
  const w = await fresh();
  for (const [which, docs] of [["nb", 500], ["board", 50]]) {
    await inHist(which, async (st) => {
      for (let d = 0; d < docs; d++) {
        const id = ID(1000 + d);
        for (let k = 1; k <= 50; k++) st.put({ nb: id, time: `${String(k).padStart(11, "0")}_loc`, env: { k } });
        await W.t1Write(st, id, { intent: { srev: null, value: "v" }, noun: which === "board" ? "board" : "notebook" });
      }
    });
  }
  const t0 = performance.now(), d = await W.detectOldSync(w), ms = performance.now() - t0;
  await putRow("nb", { nb: W.syncedKey(ID(1499), 1), time: "0000000000a_cl1", env: {} });
  const t1 = performance.now(), d2 = await W.detectOldSync(w), ms2 = performance.now() - t1;
  check(!d.old && d2.old, `large: clean (${J(d)}), then a synced key at the end found (${J(d2)})`);
  check(true, `measure: the detector on 500 notebooks × 50 versions and 50 boards × 50: ${ms.toFixed(0)} ms clean, ${ms2.toFixed(0)} ms to a synced key at the end`);
}

/** OLD8: the premise through real old builds, in this same profile: the builds DEV and PROD run (core ff191c49) and the
 * plan's (master 78cf5353), each bundled from its own tree (the runner's OLD_TREES; their workspace, journal and
 * bundle modules), writing with their own functions; then this build reads.  (a) sync used: the old build's lease, an
 * outbox, saves while on (pending, pins), a notebook's and a board's synced history started with a local patch, then
 * sync off: flagged.  (b) never synced, normal use (files written, versions, Trash, a notebook's and a board's journaled
 * saves, a .sbreplay restore, usage read): not flagged, and turning on proceeds. */
async function old8() {
  // (the old trees are given locally (OLD_TREES); without them, CI's run, said as skipped in the log)
  const builds = window.OLD_BUILDS ?? [];
  if (!builds.length) return void check(true, "skipped: OLD8, no old builds given (OLD_TREES)");
  for (const tag of builds) {
    const O = await import(`./old-${tag}.js`);
    const oh = (which) => (which === "board" ? O.openBoardHistoryDb() : O.openHistoryDb());
    const oInHist = async (which, f) => {
      const db = await oh(which);
      try {
        const tx = db.transaction("history", "readwrite"), st = tx.objectStore("history"), end = done(tx);
        let failed = null;
        const out = await f(st).catch((e) => { failed = e; try { tx.abort(); } catch {} });
        await end.catch((e) => { throw failed ?? e; });
        return out;
      } finally { db.close(); }
    };
    // (a) sync used by the old build
    await dropHistory();
    let nm = names(), steps = [];
    let ow = await O.Workspace.open(nm);
    try {
      const ns = NS(ow);
      const lease = await O.switchTo(ow, ns);
      steps.push("lease");
      const ob = new O.Outbox(ow, lease);
      await ob.begin(await ow.lastSeq());
      steps.push("outbox");
      await ow.create("/s.txt", { content: "one" });
      await ow.write("/s.txt", "two");
      steps.push("saves");
      for (const which of ["nb", "board"]) {
        const id = ID(which === "nb" ? 80 : 81), noun = which === "board" ? "board" : "notebook";
        await oInHist(which, (st) => O.t1Write(st, id, { row: { nb: id, time: "00000000001_loc", env: {} }, intent: { srev: null, value: "v" }, noun }));
        await oInHist(which, (st) => O.t1Write(st, id, { row: { nb: O.syncedKey(id, 1), time: "0000000000a_cl1", env: { root: true } }, start: { n: 1, client: "cl1" }, noun }));
      }
      steps.push("histories");
      await O.syncOffIf(ow);
      steps.push("off");
    } catch (e) {
      steps.push("threw " + (e?.message ?? e));
    } finally {
      try { O.SyncOwner?.of?.(ow)?.destroy?.(); } catch {}
      ow.close();
    }
    let w = await fresh(nm);
    const what = { stores: {}, meta: [] };
    for (const s of W.SYNC_ONLY_STORES) what.stores[s] = await rq(w.ws.transaction(s).objectStore(s).count());
    what.meta = (await rq(w.ws.transaction("meta").objectStore("meta").getAllKeys(IDBKeyRange.bound("sync:", "sync;", false, true)))).slice(0, 8);
    const da = await W.detectOldSync(w), va = await shown(w);
    check(J(steps) === J(["lease", "outbox", "saves", "histories", "off"]) && da.old && isOld(va), `OLD8 ${tag} (a) synced by the old build (${J(steps)}; ${J(what)}): flagged (${J(da)}): ${brief(va)}`);
    // (b) never synced, normal use by the old build
    await dropHistory();
    nm = names();
    steps = [];
    ow = await O.Workspace.open(nm);
    try {
      await ow.create("/n.txt", { content: "a" });
      await ow.write("/n.txt", "b");
      await ow.write("/n.txt", "c");
      await ow.create("/gone.txt", { content: "x" });
      await (ow.trash ? ow.trash("/gone.txt") : ow.remove("/gone.txt"));
      steps.push("files");
      for (const which of ["nb", "board"]) {
        const id = ID(which === "nb" ? 82 : 83), noun = which === "board" ? "board" : "notebook";
        for (let k = 1; k <= 3; k++) await oInHist(which, (st) => O.t1Write(st, id, { row: { nb: id, time: `${String(k).padStart(11, "0")}_loc`, env: { k } }, intent: { srev: null, value: "v" + k }, noun }));
      }
      steps.push("journal");
      const hdb = await oh("nb");
      try { await O.keepBundle({ history: [{ time: "00000000001_r", parents: [] }], blobs: {} }, ID(84), { hdb, bdb: null }); } finally { hdb.close(); }
      steps.push("restore");
      await ow.usage();
      steps.push("usage");
    } catch (e) {
      steps.push("threw " + (e?.message ?? e));
    } finally {
      ow.close();
    }
    w = await fresh(nm);
    const db = await W.detectOldSync(w), vb = await shown(w);
    const e = await enableVia(w);
    check(J(steps) === J(["files", "journal", "restore", "usage"]) && !db.old && isClean(vb) && !!e.lease && e.proto === W.PROTO, `OLD8 ${tag} (b) never synced, normal use by the old build (${J(steps)}): not flagged (${J(db)}), turned on: ${J(e)}`);
  }
}

const CASES = { union, old1, old2, asked, old3, old4, old5, old6, old7, old8, old9, schema, falsePositive, old10, large };
export async function run(only = "") {
  const pick = only ? only.split(",").filter(Boolean) : Object.keys(CASES);
  for (const name of pick) {
    try { await CASES[name](); } catch (e) { check(false, `${name} threw: ${e?.stack ?? e}`); }
    finally {
      W.OLD_SYNC_HOOK.fault = undefined;
      W.OLD_SYNC_HOOK.between = undefined;
      for (const w of opened.splice(0)) { try { W.SyncOwner.of(w).destroy(); } catch {} try { w.close(); } catch {} }
    }
  }
  return results;
}
