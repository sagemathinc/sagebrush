// The force-reload floor rows (plan p0-harness r2, PR 0b): the REAL old front, 98a9f74fb's page (ws.js, built from a
// clean checkout of it and proved file by file: test-sync-client-ref.mjs, oldFront), against core's reference server
// with floors (PR 0), through the runner's front (CASES=floors).  Each row starts and ends with the floors reset (bound
// 0, served 1) and raises them to bound 1 only by an asserted step; each has a positive witness from the front's log, so
// no row passes because nothing happened.  A failed check is labelled with its kind: a "precondition" or a "witness"
// failing in an unmutated run is a STOP (grader N1).
//   P0-0    it is the old front: its checkout's HEAD is 98a9f74fb, and its own refusalOf maps stale_build to a final
//           `invalid` (the hazard D-1 avoids); the bundle the page loaded is the one built
//   P0-pos  no floor: the old front syncs as it always has
//   P0-a    a welcomed old front's op after a raise: refused by a push with no req, then a 4426 close; nothing lost or
//           final; its reconnects refused before welcome, on its backoff (not a loop)
//   P0-b    its upload after a raise: one PUT, refused 409 with retry_after 60000, before any op or close; its timer
//           kept as the server's; pending, not final
//   P0-c    its doc batch held across a raise: refused in the commit's own turn (a push, then 4426); the request
//           answered busy by the teardown, never final; nothing stored
import * as W from "./ws.js";

const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rows = [];
/** the row running: its id, the kinds of its failed checks, and what it opened (closed in its finally) */
let row = null;
const check = (ok, what, kind) => {
  results.push([!!ok, `${row.id}: ${what}`]);
  if (!ok) row.kinds.add(kind);
  return !!ok;
};
/** A floor command, or any other of the runner's: its status and its body */
const ctl = async (cmd, extra = {}) => {
  const r = await fetch("/__ctl", { method: "POST", body: J({ cmd, ...extra }), signal: AbortSignal.timeout(10_000) });
  return { status: r.status, body: await r.json() };
};
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: J(body ?? {}) });
/** f() true within ms (polled every 50 ms), else false: never a throw */
async function until(f, ms) {
  const end = Date.now() + ms;
  for (;;) {
    try { if (await f()) return true; } catch {}
    if (Date.now() > end) return false;
    await sleep(50);
  }
}
const all = (db, store) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const metaGet = (db, k) => new Promise((ok, no) => { const r = db.transaction("meta").objectStore("meta").get(k); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const nsOf = (c) => c.debug().ns ?? c.status.ns;
const sendable = (ops) => ops.filter((o) => "after" in o && o.after !== undefined && o.op !== "dropVersions" && o.origin !== "server");
const hashOf = async (x) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(J(x))))].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---- what a row opens: an account (the floor rows' own, in order), a workspace, the old front's client

let acct = 0;
async function account() {
  const id = window.ACCOUNTS[acct++];
  if (!id) throw new Error("out of floor-row accounts");
  const s = await post("/auth/dev", { token: "dev-token", account_id: id });
  if (!s.ok) throw new Error("sign-in: " + s.status);
  const e = await post("/api/sync/v1/enable", {});
  if (!e.ok) throw new Error("enable: " + e.status + " " + (await e.text()));
  return id;
}
async function workspace() {
  localStorage.clear();
  const w = await W.Workspace.open(`ws-floor-${row.id}-${Math.random().toString(36).slice(2, 8)}`);
  row.ws.push(w);
  return w;
}
function client(w, opts = {}) {
  const c = new W.SyncClient(w, { origin: location.origin, ...opts });
  c.run = c.start();
  row.clients.push(c);
  return c;
}

// ---- the floors: set, then asserted from the command's answer AND from GET /api/client-floor (never a cached copy)

async function setFloors(f, bound, what) {
  const r = await ctl("floors", { ...f, registry: [] });
  const cf = await (await fetch("/api/client-floor", { cache: "no-store" })).json();
  return check(r.status === 200 && r.body.bound === bound && cf.reload === f.reload && cf.compat === f.compat && cf.served === f.served,
    `${what}: the bound is ${bound}, and /api/client-floor says so: ${J({ answer: r.body, clientFloor: cf })}`, "precondition");
}
const reset = () => setFloors({ reload: 0, compat: 0, served: 1 }, 0, "the reset (bound 0)");
const raise = () => setFloors({ reload: 1, compat: 0, served: 1 }, 1, "the raise (bound 0 -> 1)");

// ---- the front's log: its length now, what came after an index, and a finite wait for an event (null at its end)

const mark = async () => (await ctl("flog", { from: 2 ** 31 - 1 })).body.length;
const eventsFrom = async (from) => (await ctl("flog", { from })).body.events;
async function waitFor(from, pred, ms) {
  let got = null;
  return (await until(async () => { const es = await eventsFrom(from); if (pred(es)) { got = es; return true; } return false; }, ms)) ? got : null;
}
const snapshot = async (id) => (await ctl("snapshot", { account: id })).body.snapshot;
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

async function p00() {
  const prov = (await ctl("provenance")).body;
  check(prov.head === window.OLD_SHA, `(i) the old front's checkout is at ${window.OLD_SHA}: ${prov.head} (${prov.mode} mode)`, "provenance");
  let e = null;
  try { e = W.refusalOf({ code: "stale_build", message: "Sagebrush was updated: reload this page" }); } catch (x) { e = { threw: String(x) }; }
  check(e?.code === "invalid" && e?.detail?.final === true, `(ii) the page's own refusalOf maps stale_build to invalid, final (the old build's mapping, protocol.ts:118 at 98a9f74fb): ${J({ code: e?.code, detail: e?.detail })}`, "old-mapping");
  check(typeof prov.built === "string" && prov.served.length >= 1 && prov.served.every((h) => h === prov.built), `the bundle the page loaded is the one built: ${J({ built: prov.built, served: prov.served })}`, "provenance-bundle");
}

async function p0pos() {
  if (!(await reset())) return;
  const id = await account();
  const w = await workspace();
  const c = client(w);
  check(await until(() => c.status.state === "synced", 15_000), "witness: the old front connected and synced under bound 0: " + J(c.status), "witness");
  const m = await mark();
  await w.mkdir("/pos");
  const ns = nsOf(c);
  // (the op's own ack first, from the front's log; then the outbox drained)
  const acked = await waitFor(m, (es) => es.some((e) => e.k === "got" && e.t === "ack"), 15_000);
  const drained = await until(async () => c.status.state === "synced" && (await all(w.ws, "outbox")).length === 0, 15_000);
  const es = acked ?? (await eventsFrom(m));
  const snap = await snapshot(id);
  check(drained && es.some((e) => e.k === "sent" && e.t === "ops") && es.some((e) => e.k === "got" && e.t === "ack"), "witness: its op sent and acked, its outbox drained to 0: " + J({ drained, mark: m, events: es.map((e) => e.t ?? e.k) }), "witness");
  check(typeof snap === "string" && snap.includes('"path":"/pos"'), "the server's log has the op", "data");
  check(!es.some((e) => e.code === "stale_build" || e.k === "close"), "nothing refused or closed: " + J(es.filter((e) => e.code || e.k === "close")), "data");
}

async function p0a() {
  if (!(await reset())) return;
  const id = await account();
  const w = await workspace();
  const c = client(w);
  const m0 = await mark();
  const welcomed = await until(() => c.status.state === "synced", 15_000);
  check(welcomed && (await eventsFrom(m0)).some((e) => e.k === "got" && e.t === "welcome"), "witness: the page was welcomed under bound 0", "witness");
  const ns = nsOf(c);
  if (!(await raise())) return;
  const snap0 = await snapshot(id);
  const m1 = await mark();
  const from = await w.lastSeq();
  // (the edit is made only now, after the welcome and the raise: its op goes on an already-welcomed socket)
  await w.mkdir("/a");
  const opsAt = await hashOf(sendable((await w.ops()).filter((o) => o.seq > from)));
  const es = (await waitFor(m1, (es) => es.some((e) => e.k === "close"), 10_000)) ?? (await eventsFrom(m1));
  const iOps = es.findIndex((e) => e.k === "sent" && e.t === "ops");
  const iErr = es.findIndex((e) => e.k === "got" && e.t === "error" && e.code === "stale_build");
  const iClose = es.findIndex((e) => e.k === "close");
  check(iOps >= 0, "witness: an ops frame from the page received after the raise: " + J(es.map((e) => e.t ?? e.k)), "witness");
  check(iErr > iOps && es[iErr].req === undefined && iClose > iErr && es[iClose].code === 4426,
    "envelope: stale_build pushed with no req, then the socket closed 4426: " + J({ error: es[iErr], close: es[iClose] }), "envelope");
  // (the backoff, observed from the close: retry:connect's n read every 100 ms, the hellos counted from the log)
  const seen = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 33_000) {
    const t = await metaGet(w.ws, `sync:${ns}:retry:connect`);
    if (t?.n !== undefined && seen.at(-1) !== t.n) seen.push(t.n);
    await sleep(100);
  }
  const after = (await eventsFrom(m1)).slice(Math.max(0, iClose + 1));
  const h = helloRefusals(after);
  const inWindow = h.hellos.filter((at) => at < h.hellos[0] + 30_000).length;
  check(h.ok && h.refused >= 2, "its reconnects refused before any welcome (a stale_build push, no req, then 4426, for each): " + J({ hellos: h.hellos.length, refused: h.refused, welcomes: h.welcomes }), "witness");
  check(seen.length >= 2 && seen.every((n, i) => i === 0 || n > seen[i - 1]), "backoff: the persisted retry:connect's n strictly increasing (98a9f74fb sync-client.ts:1720, 1726): " + J(seen), "backoff");
  check(inWindow >= 2 && inWindow <= 6, "backoff, not a loop: the hellos in the 30 s from the first, at most 6 (the declared regression guard, from sync-client.ts:59 and 1726-1731 at 98a9f74fb): " + inWindow, "backoff");
  const opsNow = await hashOf(sendable((await w.ops()).filter((o) => o.seq > from)));
  const k = await kept(w, ns, "/a");
  const refused = (await metaGet(w.ws, `sync:${ns}:refused`)) ?? [];
  check(opsNow === opsAt && k.ok && refused.length === 0, "data: the op kept, unchanged and undecided; nothing refused or final in the ledger: " + J({ unchanged: opsNow === opsAt, kept: k, refused }), "data");
  check((await snapshot(id)) === snap0, "data: the server's account unchanged since the raise", "data");
}

async function p0b() {
  if (!(await reset())) return;
  const id = await account();
  const w = await workspace();
  const c = client(w);
  check(await until(() => c.status.state === "synced", 15_000), "witness: the page was welcomed under bound 0: " + J(c.status), "witness");
  const ns = nsOf(c);
  if (!(await raise())) return;
  const snap0 = await snapshot(id);
  const m1 = await mark();
  // (a data file: the old client sends no op whose bytes the server doesn't hold, so its PUT comes first, blobsFor
  // at sync-client.ts:1076-1078; the check before it, POST /blobs/check, isn't floored)
  await w.create("/b.txt", { content: "p0-b " + crypto.randomUUID() });
  await waitFor(m1, (es) => es.some((e) => e.k === "http" && e.method === "PUT"), 10_000);
  // (no second PUT for 5 s: counted here; the 60 s boundary is read from the timer record, not waited out)
  await sleep(5000);
  const es = await eventsFrom(m1);
  const puts = es.filter((e) => e.k === "http" && e.method === "PUT");
  let body = null;
  try { body = JSON.parse(puts[0]?.body ?? "null"); } catch {}
  check(puts.length === 1, "witness: exactly 1 PUT received after the raise, and none again within 5 s: " + puts.length, "witness");
  check(puts[0]?.status === 409 && body?.error === "stale_build" && body?.bound === 1 && body?.why === "below" && body?.retry_after === 60_000,
    "refusal: 409 {error: stale_build, bound: 1, why: below, retry_after: 60000}: " + J({ status: puts[0]?.status, body }), "refusal");
  const iPut = es.indexOf(puts[0]);
  check(iPut >= 0 && !es.slice(0, iPut).some((e) => (e.k === "sent" && e.t === "ops") || e.k === "close"), "order: the 409 before any ops frame and any close: " + J(es.map((e) => e.t ?? e.k)), "order");
  const t = await metaGet(w.ws, `sync:${ns}:retry:upload`);
  check(t?.server === true && t?.n === 1 && puts[0] && Math.abs(t.at - (puts[0].at + 60_000)) <= 1000,
    "data: retry:upload is the server's, {at: PUT + 60000 (±1000), n: 1, server: true} (timerFail(c.ns, \"upload\", res.retryAfter), sync-client.ts:1239 at 98a9f74fb): " + J({ timer: t, put: puts[0]?.at }), "data");
  const k = await kept(w, ns, "/b.txt");
  check(!es.some((e) => e.k === "sent" && e.t === "ops") && k.ok, "data: the upload pending, not final (no op sent, its record undecided; 400/413's final, :1223, not taken): " + J(k), "data");
  check((await snapshot(id)) === snap0, "data: the server's account unchanged since the raise", "data");
}

async function p0c() {
  if (!(await reset())) return;
  const id = await account();
  const w = await workspace();
  let link = null;
  const c = client(w, { docs: { connected(l) { link = l; }, disconnected() {}, changed() {} } });
  check(await until(() => c.status.state === "synced" && link, 15_000), "witness: welcomed under bound 0, document sync handed the connection", "witness");
  const ask = (r, m, ms) => Promise.race([link.ask(r, m), sleep(ms).then(() => null)]);
  const doc = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const cl = "p0cclient1";
  const claim = await ask(link.reserve(), { t: "doc_claim", owner: link.owner, doc, epoch: 1, client: cl }, 5000);
  check(claim?.t === "ack" && Number.isSafeInteger(claim.claim?.fgen) && Number.isSafeInteger(claim.claim?.next_cseq), "witness: the doc claimed: " + J(claim).slice(0, 200), "witness");
  if (claim?.t !== "ack") return;
  const hold = await ctl("holdForward", { doc, client: cl });
  check(hold.status === 200 && typeof hold.body.handle === "string", "the hold armed: " + J(hold), "harness");
  const body = new TextEncoder().encode(J({ v: 1 }));
  const pid = Date.now().toString(36).padStart(11, "0") + "_" + cl;
  const pending = ask(link.reserve(), { t: "batch", owner: link.owner, doc, epoch: 1, kind: "notebook", fgen: { [cl]: claim.claim.fgen }, patches: [{ cseq: claim.claim.next_cseq, id: pid, parents: [], size: body.length }], body: btoa(String.fromCharCode(...body)) }, 20_000);
  const entered = await until(async () => (await ctl("held")).body.holding === 1, 5000);
  check(entered, "witness: the page's batch entered the hold (held 1) while the floor was 0", "witness");
  const snap0 = await snapshot(id);
  if (!(await raise())) return;
  const atRaise = (await ctl("held")).body.holding;
  check(atRaise === 1, "witness: the hold in effect at the raise (held 1): " + atRaise, "witness");
  const m1 = await mark();
  const rel = await ctl("releaseForward", { handle: hold.body.handle });
  check(rel.status === 200, "the hold released, once: " + J(rel), "harness");
  check(await until(async () => (await ctl("held")).body.holding === 0, 5000), "witness: released after the raise (held 0)", "witness");
  const again = await ctl("releaseForward", { handle: hold.body.handle });
  check(again.status === 409, "a second release of the same handle is refused (409): " + J(again), "harness");
  const ans = await pending;
  const es = (await waitFor(m1, (es) => es.some((e) => e.k === "close"), 10_000)) ?? (await eventsFrom(m1));
  const iErr = es.findIndex((e) => e.k === "got" && e.t === "error" && e.code === "stale_build");
  const iClose = es.findIndex((e) => e.k === "close");
  check(iErr >= 0 && es[iErr].req === undefined && iClose > iErr && es[iClose].code === 4426, "envelope: the commit turn's stale_build pushed with no req, then 4426: " + J({ error: es[iErr], close: es[iClose] }), "envelope");
  let fin = null;
  if (ans?.t === "error") try { fin = W.refusalOf({ code: ans.code, message: ans.detail?.message, detail: ans.detail }); } catch {}
  check(ans?.t === "error" && ans.code === "busy" && fin?.code === "busy" && fin?.detail?.final !== true,
    "data: the pending doc request answered by the teardown, busy (transient), and not final by the page's own refusalOf (sync-client.ts:494 at 98a9f74fb): " + J(ans).slice(0, 200), "data");
  const later = (await waitFor(m1, (es) => helloRefusals(es.slice(iClose + 1)).refused >= 1, 10_000)) ?? (await eventsFrom(m1));
  const h = helloRefusals(later.slice(iClose + 1));
  check(h.refused >= 1 && h.welcomes === 0, "its reconnect refused at hello: " + J({ hellos: h.hellos.length, refused: h.refused, welcomes: h.welcomes }), "witness");
  check((await snapshot(id)) === snap0, "data: the server's document and account unchanged since the raise (nothing stored)", "data");
}

const ROWS = [["P0-0", p00], ["P0-pos", p0pos], ["P0-a", p0a], ["P0-b", p0b], ["P0-c", p0c]];
/** each row's wall limit (plan r2 §3.2): past it the row fails, and its finally still runs */
const ROW_MS = 60_000;

async function runRow(id, f) {
  row = { id, kinds: new Set(), clients: [], ws: [] };
  window.progress = { name: id, checks: results.length };
  try {
    const r = await Promise.race([f().then(() => "done"), sleep(ROW_MS).then(() => "timeout")]);
    if (r === "timeout") check(false, `the row didn't end within ${ROW_MS / 1000} s`, "timeout");
  } catch (e) {
    check(false, `threw ${e?.stack ?? e}`, "threw");
  } finally {
    for (const c of row.clients) await Promise.race([(async () => { await c.stop(); await c.run; })().catch(() => {}), sleep(10_000)]);
    for (const w of row.ws) try { w.close(); } catch {}
    const end = await ctl("floorsRowEnd").catch((e) => ({ status: 0, body: String(e) }));
    check(end.status === 200 && end.body.refHolds === 0 && end.body.holding === 0 && end.body.bound === 0, "the row's end: its holds released, none waiting, the floors reset (bound 0): " + J(end.body), "cleanup");
  }
  rows.push({ id, ok: row.kinds.size === 0, kinds: [...row.kinds] });
}

/** The floor rows, in order (`only`: one row's id, the pr-head control's "P0-0"); window.__report says when it's done */
export async function runFloors(only = "") {
  window.__report = { mode: "floors", done: false };
  for (const [id, f] of ROWS) if (!only || only === id) await runRow(id, f);
  window.__report = { mode: "floors", done: true, rows };
  return { results, rows };
}
