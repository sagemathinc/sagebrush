// The force-reload floor rows (plan p0-harness r2, PR 0b; revision 2: P0B-DATA-1, P0B-CODE-1/2): the REAL old front,
// 98a9f74fb's page (ws.js, built from a clean checkout of it and proved file by file: test-sync-client-ref.mjs,
// oldFront), against core's reference server with floors (PR 0), through the runner's front (CASES=floors).  Each row
// starts and ends with the floors reset (bound 0, served 1) and raises them to bound 1 only by an asserted step; each has
// a positive witness from the front's log, so no row passes because nothing happened.  A failed check is labelled with
// its kind: a "precondition" or a "witness" failing in an unmutated run is a STOP (grader N1).
//   P0-0    it is the old front: its checkout's HEAD is 98a9f74fb, and its own refusalOf maps stale_build to a final
//           `invalid` (the hazard D-1 avoids); the bundle the page loaded is the one built
//   P0-pos  no floor: the old front syncs as it always has
//   P0-a    a welcomed old front's op after a raise: refused by a push with no req, then a 4426 close; nothing lost or
//           final; its reconnects refused before welcome, on its backoff (not a loop)
//   P0-b    its upload after a raise: one PUT, refused 409 with retry_after 60000, before any op or close; its timer
//           kept as the server's; pending, not final
//   P0-c    its REAL document sync (98a9f74fb's DocSync, the notebook journal and its durable l rows): a persisted edit's
//           batch held across a raise, refused in the commit's own turn (a push, then 4426); after the close and a
//           refused reconnect its pending rows are the same rows (ids, cseqs, bytes, stored patches), the notebook not
//           stopped (not final), and nothing stored on the server
//   K-F1, K-F2  the row machinery's own controls (P0B-CODE-2): a row whose body outlives its limit is ended and drained,
//           its late calls refused; a cleanup that never ends fails the run (a stop), never the next row's start
// Every row gets its own context (its checks, what it opened, whether it has ended): no row writes another's.  A row
// that times out, or whose cleanup fails or doesn't end, STOPS the run: no later row runs on state not proved clean.
import * as W from "./ws.js";

const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rows = [];
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: J(body ?? {}) });
const all = (db, store) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const metaGet = (db, k) => new Promise((ok, no) => { const r = db.transaction("meta").objectStore("meta").get(k); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const rawGet = (db, store, key) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const nsOf = (c) => c.debug().ns ?? c.status.ns;
const sendable = (ops) => ops.filter((o) => "after" in o && o.after !== undefined && o.op !== "dropVersions" && o.origin !== "server");
const hashOf = async (x) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(J(x))))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A row's calls after it has ended are refused with this (its body, if it outlived its limit, stops at its next await) */
class RowEnded extends Error {}

/** A row's context: its id, its checks' failed kinds, what it opened, and whether it has ended.  Every helper takes it. */
function rowContext(id, limits) {
  const r = {
    id, kinds: new Set(), clients: [], ws: [], ended: false, lateCalls: 0, limits,
    check(ok, what, kind) {
      results.push([!!ok, `${id}: ${what}`]);
      if (!ok) r.kinds.add(kind);
      return !!ok;
    },
    /** A floor command, or any other of the runner's: its status and its body (refused once the row has ended) */
    async ctl(cmd, extra = {}) {
      if (r.ended) { r.lateCalls++; throw new RowEnded(`${id}: ctl ${cmd} after the row ended`); }
      const res = await fetch("/__ctl", { method: "POST", body: J({ cmd, ...extra }), signal: AbortSignal.timeout(10_000) });
      return { status: res.status, body: await res.json() };
    },
    /** f() true within ms (polled every 50 ms), else false; refused once the row has ended */
    async until(f, ms) {
      const end = Date.now() + ms;
      for (;;) {
        if (r.ended) { r.lateCalls++; throw new RowEnded(`${id}: a wait after the row ended`); }
        try { if (await f()) return true; } catch {}
        if (Date.now() > end) return false;
        await sleep(50);
      }
    },
  };
  return r;
}

// ---- what a row opens: an account (the floor rows' own, in order), a workspace, the old front's client

let acct = 0;
async function account(row) {
  const id = window.ACCOUNTS[acct++];
  if (!id) throw new Error("out of floor-row accounts");
  if (row.ended) throw new RowEnded(`${row.id}: sign-in after the row ended`);
  const s = await post("/auth/dev", { token: "dev-token", account_id: id });
  if (!s.ok) throw new Error("sign-in: " + s.status);
  const e = await post("/api/sync/v1/enable", {});
  if (!e.ok) throw new Error("enable: " + e.status + " " + (await e.text()));
  return id;
}
async function workspace(row) {
  localStorage.clear();
  const tag = `${row.id}-${Math.random().toString(36).slice(2, 8)}`;
  const w = await W.Workspace.open({ name: `ws-floor-${tag}`, mainName: `main-floor-${tag}` });
  row.ws.push(w);
  return w;
}
function client(row, w, opts = {}) {
  const c = new W.SyncClient(w, { origin: location.origin, ...opts });
  c.run = c.start();
  row.clients.push(c);
  return c;
}

// ---- the floors: set, then asserted from the command's answer AND from GET /api/client-floor (never a cached copy)

async function setFloors(row, f, bound, what) {
  const r = await row.ctl("floors", { ...f, registry: [] });
  const cf = await (await fetch("/api/client-floor", { cache: "no-store" })).json();
  return row.check(r.status === 200 && r.body.bound === bound && cf.reload === f.reload && cf.compat === f.compat && cf.served === f.served,
    `${what}: the bound is ${bound}, and /api/client-floor says so: ${J({ answer: r.body, clientFloor: cf })}`, "precondition");
}
const reset = (row) => setFloors(row, { reload: 0, compat: 0, served: 1 }, 0, "the reset (bound 0)");
const raise = (row) => setFloors(row, { reload: 1, compat: 0, served: 1 }, 1, "the raise (bound 0 -> 1)");

// ---- the front's log: its length now, what came after an index, and a finite wait for an event (null at its end)

const mark = async (row) => (await row.ctl("flog", { from: 2 ** 31 - 1 })).body.length;
const eventsFrom = async (row, from) => (await row.ctl("flog", { from })).body.events;
async function waitFor(row, from, pred, ms) {
  let got = null;
  return (await row.until(async () => { const es = await eventsFrom(row, from); if (pred(es)) { got = es; return true; } return false; }, ms)) ? got : null;
}
const snapshot = async (row, id) => (await row.ctl("snapshot", { account: id })).body.snapshot;
/** Each hello after `from` refused before any welcome: answered by a stale_build push (no req), then a 4426 close
 * (the last hello may still be on its way if it is under 2 s old) */
function helloRefusals(es) {
  const hellos = [];
  es.forEach((e, i) => { if (e.k === "sent" && e.t === "hello") hellos.push(i); });
  const refused = hellos.filter((h, j) => {
    const next = hellos[j + 1] ?? es.length;
    const seg = es.slice(h + 1, next);
    const err = seg.findIndex((e) => e.k === "got" && e.t === "error" && e.code === "stale_build" && e.req === undefined);
    return err >= 0 && seg.slice(err + 1).some((e) => e.k === "close" && e.code === 4426);
  }).length;
  const last = hellos.length ? es[hellos.at(-1)] : null;
  const unanswered = hellos.length - refused;
  const welcomes = es.filter((e) => e.k === "got" && e.t === "welcome").length;
  return { hellos: hellos.map((i) => es[i].at), refused, ok: hellos.length > 0 && welcomes === 0 && (unanswered === 0 || (unanswered === 1 && Date.now() - last.at < 2000)), welcomes };
}
/** The op that made `path` still to go: its op kept, its record undecided (or the op past the scan's watermark) */
async function kept(w, ns, path) {
  const op = (await all(w.ws, "ops")).find((o) => o.path === path);
  const rec = (await all(w.ws, "outbox")).find((r) => r.op.path === path);
  const scanned = await metaGet(w.ws, `sync:${ns}:scanned`);
  return { ok: !!op && (rec ? rec.accepted === undefined : op.seq > scanned), record: !!rec, scanned, seq: op?.seq };
}

// ---- the rows

async function p00(row) {
  const prov = (await row.ctl("provenance")).body;
  row.check(prov.head === window.OLD_SHA, `(i) the old front's checkout is at ${window.OLD_SHA}: ${prov.head} (${prov.mode} mode)`, "provenance");
  let e = null;
  try { e = W.refusalOf({ code: "stale_build", message: "Sagebrush was updated: reload this page" }); } catch (x) { e = { threw: String(x) }; }
  row.check(e?.code === "invalid" && e?.detail?.final === true, `(ii) the page's own refusalOf maps stale_build to invalid, final (the old build's mapping, protocol.ts:118 at 98a9f74fb): ${J({ code: e?.code, detail: e?.detail })}`, "old-mapping");
  row.check(typeof prov.built === "string" && prov.served.length >= 1 && prov.served.every((h) => h === prov.built), `the bundle the page loaded is the one built: ${J({ built: prov.built, served: prov.served })}`, "provenance-bundle");
}

async function p0pos(row) {
  if (!(await reset(row))) return;
  const id = await account(row);
  const w = await workspace(row);
  const c = client(row, w);
  row.check(await row.until(() => c.status.state === "synced", 15_000), "witness: the old front connected and synced under bound 0: " + J(c.status), "witness");
  const m = await mark(row);
  await w.mkdir("/pos");
  // (the op's own ack first, from the front's log; then the outbox drained)
  const acked = await waitFor(row, m, (es) => es.some((e) => e.k === "got" && e.t === "ack"), 15_000);
  const drained = await row.until(async () => c.status.state === "synced" && (await all(w.ws, "outbox")).length === 0, 15_000);
  const es = acked ?? (await eventsFrom(row, m));
  const snap = await snapshot(row, id);
  row.check(drained && es.some((e) => e.k === "sent" && e.t === "ops") && es.some((e) => e.k === "got" && e.t === "ack"), "witness: its op sent and acked, its outbox drained to 0: " + J({ drained, mark: m, events: es.map((e) => e.t ?? e.k) }), "witness");
  row.check(typeof snap === "string" && snap.includes('"path":"/pos"'), "the server's log has the op", "data");
  row.check(!es.some((e) => e.code === "stale_build" || e.k === "close"), "nothing refused or closed: " + J(es.filter((e) => e.code || e.k === "close")), "data");
}

async function p0a(row) {
  if (!(await reset(row))) return;
  const id = await account(row);
  const w = await workspace(row);
  const c = client(row, w);
  const m0 = await mark(row);
  const welcomed = await row.until(() => c.status.state === "synced", 15_000);
  row.check(welcomed && (await eventsFrom(row, m0)).some((e) => e.k === "got" && e.t === "welcome"), "witness: the page was welcomed under bound 0", "witness");
  const ns = nsOf(c);
  if (!(await raise(row))) return;
  const snap0 = await snapshot(row, id);
  const m1 = await mark(row);
  const from = await w.lastSeq();
  // (the edit is made only now, after the welcome and the raise: its op goes on an already-welcomed socket)
  await w.mkdir("/a");
  const opsAt = await hashOf(sendable((await w.ops()).filter((o) => o.seq > from)));
  const es = (await waitFor(row, m1, (es) => es.some((e) => e.k === "close"), 10_000)) ?? (await eventsFrom(row, m1));
  const iOps = es.findIndex((e) => e.k === "sent" && e.t === "ops");
  const iErr = es.findIndex((e) => e.k === "got" && e.t === "error" && e.code === "stale_build");
  const iClose = es.findIndex((e) => e.k === "close");
  row.check(iOps >= 0, "witness: an ops frame from the page received after the raise: " + J(es.map((e) => e.t ?? e.k)), "witness");
  row.check(iErr > iOps && es[iErr].req === undefined && iClose > iErr && es[iClose].code === 4426,
    "envelope: stale_build pushed with no req, then the socket closed 4426: " + J({ error: es[iErr], close: es[iClose] }), "envelope");
  // (the backoff, observed from the close: retry:connect's n read every 100 ms, the hellos counted from the log)
  const seen = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 33_000) {
    if (row.ended) throw new RowEnded(`${row.id}: the backoff watch after the row ended`);
    const t = await metaGet(w.ws, `sync:${ns}:retry:connect`);
    if (t?.n !== undefined && seen.at(-1) !== t.n) seen.push(t.n);
    await sleep(100);
  }
  const after = (await eventsFrom(row, m1)).slice(Math.max(0, iClose + 1));
  const h = helloRefusals(after);
  const inWindow = h.hellos.filter((at) => at < h.hellos[0] + 30_000).length;
  row.check(h.ok && h.refused >= 2, "its reconnects refused before any welcome (a stale_build push, no req, then 4426, for each): " + J({ hellos: h.hellos.length, refused: h.refused, welcomes: h.welcomes }), "witness");
  row.check(seen.length >= 2 && seen.every((n, i) => i === 0 || n > seen[i - 1]), "backoff: the persisted retry:connect's n strictly increasing (98a9f74fb sync-client.ts:1720, 1726): " + J(seen), "backoff");
  row.check(inWindow >= 2 && inWindow <= 6, "backoff, not a loop: the hellos in the 30 s from the first, at most 6 (the declared regression guard, from sync-client.ts:59 and 1726-1731 at 98a9f74fb): " + inWindow, "backoff");
  const opsNow = await hashOf(sendable((await w.ops()).filter((o) => o.seq > from)));
  const k = await kept(w, ns, "/a");
  const refused = (await metaGet(w.ws, `sync:${ns}:refused`)) ?? [];
  row.check(opsNow === opsAt && k.ok && refused.length === 0, "data: the op kept, unchanged and undecided; nothing refused or final in the ledger: " + J({ unchanged: opsNow === opsAt, kept: k, refused }), "data");
  row.check((await snapshot(row, id)) === snap0, "data: the server's account unchanged since the raise", "data");
}

async function p0b(row) {
  if (!(await reset(row))) return;
  const id = await account(row);
  const w = await workspace(row);
  const c = client(row, w);
  row.check(await row.until(() => c.status.state === "synced", 15_000), "witness: the page was welcomed under bound 0: " + J(c.status), "witness");
  const ns = nsOf(c);
  if (!(await raise(row))) return;
  const snap0 = await snapshot(row, id);
  const m1 = await mark(row);
  // (a data file: the old client sends no op whose bytes the server doesn't hold, so its PUT comes first, blobsFor
  // at sync-client.ts:1076-1078; the check before it, POST /blobs/check, isn't floored)
  await w.create("/b.txt", { content: "p0-b " + crypto.randomUUID() });
  await waitFor(row, m1, (es) => es.some((e) => e.k === "http" && e.method === "PUT"), 10_000);
  // (no second PUT for 5 s: counted here; the 60 s boundary is read from the timer record, not waited out)
  await row.until(() => false, 5000);
  const es = await eventsFrom(row, m1);
  const puts = es.filter((e) => e.k === "http" && e.method === "PUT");
  let body = null;
  try { body = JSON.parse(puts[0]?.body ?? "null"); } catch {}
  row.check(puts.length === 1, "witness: exactly 1 PUT received after the raise, and none again within 5 s: " + puts.length, "witness");
  row.check(puts[0]?.status === 409 && body?.error === "stale_build" && body?.bound === 1 && body?.why === "below" && body?.retry_after === 60_000,
    "refusal: 409 {error: stale_build, bound: 1, why: below, retry_after: 60000}: " + J({ status: puts[0]?.status, body }), "refusal");
  const iPut = es.indexOf(puts[0]);
  row.check(iPut >= 0 && !es.slice(0, iPut).some((e) => (e.k === "sent" && e.t === "ops") || e.k === "close"), "order: the 409 before any ops frame and any close: " + J(es.map((e) => e.t ?? e.k)), "order");
  const t = await metaGet(w.ws, `sync:${ns}:retry:upload`);
  row.check(t?.server === true && t?.n === 1 && puts[0] && Math.abs(t.at - (puts[0].at + 60_000)) <= 1000,
    "data: retry:upload is the server's, {at: PUT + 60000 (±1000), n: 1, server: true} (timerFail(c.ns, \"upload\", res.retryAfter), sync-client.ts:1239 at 98a9f74fb): " + J({ timer: t, put: puts[0]?.at }), "data");
  const k = await kept(w, ns, "/b.txt");
  row.check(!es.some((e) => e.k === "sent" && e.t === "ops") && k.ok, "data: the upload pending, not final (no op sent, its record undecided; 400/413's final, :1223, not taken): " + J(k), "data");
  row.check((await snapshot(row, id)) === snap0, "data: the server's account unchanged since the raise", "data");
}

/** A notebook's durable doc outbox, as 98a9f74fb's document sync keeps it (journal/rows.js): its pending l rows (each
 * row's j, gen, client, cseq and bytes, never its `sent` mark, which a resend rewrites), the stored patch each carries
 * (its envelope in the synced history), and the journal's count and slot */
async function docOutbox(hdb, id) {
  const js = await W.JR.readJournal(hdb, id);
  const lrows = await W.JR.unsent(hdb, id, { max: 1000, maxBytes: 2 ** 30 });
  const key = js.start ? W.JR.syncedKey(id, js.start.n) : null;
  const patches = [];
  for (const r of lrows) patches.push(key ? (await rawGet(hdb, "history", [key, r.time]))?.env ?? null : null);
  return {
    rows: lrows.map((r) => ({ j: r.j, time: r.time, gen: r.gen, client: r.client, cseq: r.cseq, bytes: r.bytes })),
    patches: await hashOf(patches),
    stored: patches.every((p) => p !== null),
    lrows: js.lrows,
    slot: js.slot ? { gen: js.slot.gen, client: js.slot.client, fgen: js.slot.fgen, claimed: js.slot.claimed ?? null } : null,
  };
}

async function p0c(row) {
  if (!(await reset(row))) return;
  const id = await account(row);
  const w = await workspace(row);
  // (98a9f74fb's document sync, set up as its own test sets up a device (test-doc-sync.page.js T.init): the journal
  // active, docsync on, the notebook store classes, and its DocSync, here handed to its own SyncClient as `docs`)
  W.registerJournalWriter("notebooks");
  W.registerJournalWriter("boards");
  await w.activateJournal();
  const hdb = await W.openHistoryDb();
  W.N.DOC_SYNC.on = true;
  const kit = W.N.journalClasses({ IdbStore: W.IdbStore, IdbPatchStore: W.IdbPatchStore });
  const ds = new W.DS.DocSync({ retryMs: 200, askMs: 5000 });
  let linked = 0;
  const docs = { connected(l) { linked++; return ds.connected(l); }, disconnected() { ds.disconnected(); }, changed(m) { ds.changed(m); } };
  const c = client(row, w, { docs });
  row.check(await row.until(() => c.status.state === "synced" && linked >= 1, 15_000), "witness: welcomed under bound 0, document sync handed the connection: " + J({ state: c.status.state, linked }), "witness");
  // (a new notebook: made, kicked, claimed and its first batch acked, all under bound 0)
  const nb = crypto.randomUUID();
  const st = new kit.JournalStore(w.main, hdb, nb, { name: "t", mode: "python", cells: [{ id: "a", code: "A1" }] }, W.H);
  await st.load();
  ds.kick(nb);
  const first = await row.until(async () => { await ds.idle(); return ds.events.some((e) => e.t === "ack" && e.doc === nb) && (await W.JR.readJournal(hdb, nb)).lrows === 0; }, 15_000);
  const js0 = await W.JR.readJournal(hdb, nb);
  row.check(first && js0.slot?.claimed?.client === js0.slot?.client, "witness: the notebook claimed and its first batch acked under bound 0, its l rows released: " + J({ events: ds.events.map((e) => e.t), lrows: js0.lrows }), "witness");
  if (!first) return;
  // (the hold, on the notebook's own client, then a persisted edit: its l rows written, its batch sent and held)
  const hold = await row.ctl("holdForward", { doc: nb, client: js0.slot.client });
  row.check(hold.status === 200 && typeof hold.body.handle === "string", "the hold armed: " + J(hold), "harness");
  const rec = await rawGet(w.main, "notebooks", nb);
  const saved = await st.save({ name: rec.name, mode: rec.mode, id: nb, cells: [{ id: "a", code: "A2-pending" }], baseRev: rec.rev });
  ds.kick(nb);
  const entered = await row.until(async () => (await row.ctl("held")).body.holding === 1, 5000);
  const wrote = typeof saved === "object" && saved !== null ? !!saved.saved : saved === true;
  row.check(wrote && entered, "witness: a persisted edit's batch entered the hold (held 1) while the floor was 0: " + J({ saved: typeof saved === "object" ? !!saved?.saved : saved, entered }), "witness");
  const before = await docOutbox(hdb, nb);
  row.check(before.rows.length >= 1 && before.stored && before.lrows === before.rows.length, "witness: the doc outbox holds the pending edit (its l rows and their stored patches): " + J({ rows: before.rows.length, lrows: before.lrows, stored: before.stored }), "witness");
  const snap0 = await snapshot(row, id);
  if (!(await raise(row))) return;
  const atRaise = (await row.ctl("held")).body.holding;
  row.check(atRaise === 1, "witness: the hold in effect at the raise (held 1): " + atRaise, "witness");
  const m1 = await mark(row);
  const rel = await row.ctl("releaseForward", { handle: hold.body.handle });
  row.check(rel.status === 200, "the hold released, once: " + J(rel), "harness");
  row.check(await row.until(async () => (await row.ctl("held")).body.holding === 0, 5000), "witness: released after the raise (held 0)", "witness");
  const again = await row.ctl("releaseForward", { handle: hold.body.handle });
  row.check(again.status === 409, "a second release of the same handle is refused (409): " + J(again), "harness");
  const es = (await waitFor(row, m1, (es) => es.some((e) => e.k === "close"), 10_000)) ?? (await eventsFrom(row, m1));
  const iErr = es.findIndex((e) => e.k === "got" && e.t === "error" && e.code === "stale_build");
  const iClose = es.findIndex((e) => e.k === "close");
  row.check(iErr >= 0 && es[iErr].req === undefined && iClose > iErr && es[iClose].code === 4426, "envelope: the commit turn's stale_build pushed with no req, then 4426: " + J({ error: es[iErr], close: es[iClose] }), "envelope");
  const later = (await waitFor(row, m1, (es) => helloRefusals(es.slice(iClose + 1)).refused >= 1, 10_000)) ?? (await eventsFrom(row, m1));
  const h = helloRefusals(later.slice(iClose + 1));
  row.check(h.refused >= 1 && h.welcomes === 0, "its reconnect refused at hello: " + J({ hellos: h.hellos.length, refused: h.refused, welcomes: h.welcomes }), "witness");
  await Promise.race([ds.idle(), sleep(5000)]);
  // (MP10's site: the mutant script puts a teardown that drops the pending rows here, which the checks below must catch)
  const after = await docOutbox(hdb, nb);
  const stopped = Object.fromEntries(ds.stopped);
  row.check(J(after.rows) === J(before.rows) && after.patches === before.patches && after.stored && after.lrows === before.lrows && J(after.slot) === J(before.slot),
    "data: the doc outbox unchanged across the refusal, the close and the refused reconnect (the same l rows: j, time, gen, client, cseq, bytes; the same stored patches; the same slot): " + J({ before: before.rows.length, after: after.rows.length, patches: after.patches === before.patches, lrows: [before.lrows, after.lrows] }), "data");
  row.check(!(nb in stopped) && !ds.events.some((e) => e.t === "stopped" && e.doc === nb), "data: the notebook not stopped, not final (DocSync.stopped, 98a9f74fb doc-sync.ts:123-128, 219-230): " + J(stopped), "data");
  row.check((await snapshot(row, id)) === snap0, "data: the server's document and account unchanged since the raise (nothing stored)", "data");
}

// ---- the row machinery's own controls (P0B-CODE-2), run before the rows in every run, on limits of their own

/** K-F1: a body that outlives its limit is ended, its late calls refused (RowEnded), and it is drained (settles) */
async function kf1(row) {
  await sleep(600);
  await row.ctl("held");
  row.lateBodyReached = true;
}
/** K-F2: a client whose stop never ends: the cleanup times out, which is a STOP */
async function kf2(row) {
  row.clients.push({ stop: () => new Promise(() => {}), run: Promise.resolve() });
}

const ROWS = [["P0-0", p00], ["P0-pos", p0pos], ["P0-a", p0a], ["P0-b", p0b], ["P0-c", p0c]];
/** each row's wall limit (plan r2 §3.2), its drain after an end, its cleanup's bound, and the hold's finite wait */
const LIMITS = { rowMs: 60_000, drainMs: 10_000, cleanupMs: 10_000, holdingMs: 5000 };

/**
 * One row: its body raced against its limit; at its end (normal or not) the context is ended, so a body still running
 * stops at its next call, and the body is drained (awaited, bounded); then its cleanup: its clients stopped and their
 * loops ended, its workspaces closed, its holds released and the floors reset, and `holding` 0 within a finite wait.
 * Answers {stop: why} when the run can't go on: the body outlived its limit, or didn't drain, or the cleanup threw,
 * didn't end, or left a hold.
 */
async function runRow(id, f, limits = LIMITS) {
  const row = rowContext(id, limits);
  window.progress = { name: id, checks: results.length };
  let stop = null;
  const body = Promise.resolve().then(() => f(row));
  const settled = body.then(() => "done", (e) => (e instanceof RowEnded ? "ended" : { threw: e }));
  const first = await Promise.race([settled, sleep(limits.rowMs).then(() => "timeout")]);
  row.ended = true;
  if (first === "timeout") {
    row.check(false, `the row didn't end within ${limits.rowMs / 1000} s`, "timeout");
    stop = `${id}: timed out`;
    const drained = await Promise.race([settled, sleep(limits.drainMs).then(() => "undrained")]);
    row.drained = drained;
    if (drained === "undrained") row.check(false, `the row's body didn't stop within ${limits.drainMs / 1000} s of its end`, "drain");
  } else if (typeof first === "object") row.check(false, `threw ${first.threw?.stack ?? first.threw}`, "threw");
  // (the cleanup: every step bounded; a step that throws or doesn't end is a stop)
  const step = async (what, p) => {
    const r = await Promise.race([Promise.resolve(p).then(() => "ok", (e) => `threw ${e?.message ?? e}`), sleep(limits.cleanupMs).then(() => "timeout")]);
    if (r !== "ok") { row.check(false, `cleanup: ${what}: ${r}`, "cleanup"); stop ??= `${id}: cleanup ${what} ${r}`; }
  };
  for (const c of row.clients) await step("a client's stop and loop", (async () => { await c.stop(); await c.run; })());
  for (const w of row.ws) await step("a workspace's close", (async () => w.close())());
  let end = null;
  await step("floorsRowEnd", (async () => { const res = await fetch("/__ctl", { method: "POST", body: J({ cmd: "floorsRowEnd" }), signal: AbortSignal.timeout(10_000) }); end = { status: res.status, body: await res.json() }; })());
  const quiet = await (async () => {
    const t = Date.now() + limits.holdingMs;
    for (;;) {
      const h = await fetch("/__ctl", { method: "POST", body: J({ cmd: "held" }) }).then((r) => r.json()).catch(() => null);
      if (h && h.holding === 0 && h.refHolds === 0 && h.handles === 0) return h;
      if (Date.now() > t) return h;
      await sleep(50);
    }
  })();
  const clean = end?.status === 200 && end.body.refHolds === 0 && end.body.bound === 0 && quiet?.holding === 0 && quiet?.refHolds === 0 && quiet?.handles === 0;
  row.check(clean, "the row's end: its holds released, none waiting (holding 0 within a finite wait), the floors reset (bound 0): " + J({ end: end?.body, held: quiet }), "cleanup");
  if (!clean) stop ??= `${id}: holds or floors not clean at its end`;
  rows.push({ id, ok: row.kinds.size === 0, kinds: [...row.kinds] });
  return { row, stop };
}

/** The row machinery's controls, each on short limits and outside the run's stop: K-F1 and K-F2 must each come out as
 * stated, or the run stops before any row */
async function controls() {
  const k1 = await runRow("K-F1", kf1, { rowMs: 200, drainMs: 3000, cleanupMs: 1000, holdingMs: 1000 });
  const ok1 = k1.stop === "K-F1: timed out" && k1.row.drained === "ended" && k1.row.lateCalls === 1 && !k1.row.lateBodyReached;
  rows.pop();
  const k2 = await runRow("K-F2", kf2, { rowMs: 5000, drainMs: 1000, cleanupMs: 300, holdingMs: 1000 });
  const ok2 = typeof k2.stop === "string" && /cleanup a client's stop and loop timeout/.test(k2.stop) && k2.row.kinds.has("cleanup");
  rows.pop();
  // (the controls' own failures are expected: replaced by one verdict line each)
  for (const id of ["K-F1", "K-F2"]) for (let i = results.length - 1; i >= 0; i--) if (results[i][1].startsWith(id + ": ")) results.splice(i, 1);
  results.push([ok1, `K-F1: a body past its limit is ended, its late call refused (RowEnded), and drained; the run told to stop: ${J({ stop: k1.stop, drained: k1.row.drained, lateCalls: k1.row.lateCalls, reached: !!k1.row.lateBodyReached })}`]);
  results.push([ok2, `K-F2: a client whose stop never ends: its cleanup step times out, which is a stop: ${J({ stop: k2.stop })}`]);
  rows.push({ id: "K-F1", ok: ok1, kinds: ok1 ? [] : ["control"] }, { id: "K-F2", ok: ok2, kinds: ok2 ? [] : ["control"] });
  return ok1 && ok2;
}

/** The floor rows, in order (`only`: one row's id, the pr-head control's "P0-0"); window.__report says when it's done.
 * The machinery's controls first; then each row, and a stop ends the run there (no later row runs). */
export async function runFloors(only = "") {
  window.__report = { mode: "floors", done: false };
  let stopped = null;
  if (!(await controls())) stopped = "the row machinery's controls failed";
  for (const [id, f] of ROWS) {
    if (stopped) break;
    if (only && only !== id) continue;
    const r = await runRow(id, f);
    if (r.stop) stopped = r.stop;
  }
  window.__report = { mode: "floors", done: true, rows, stopped };
  return { results, rows, stopped };
}
