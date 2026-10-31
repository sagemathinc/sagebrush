// The cases of sync client step 3 (design/sync-client.md §3, C1, L2, L3, L4): the sender against a sync server,
// through a test's front (/__ctl), which can drop acks, fake the server's errors, close sockets and hold uploads.  Two
// runners, with the same front: core's web/workspace/test-sync-client-ref.mjs, against core's reference server
// (web/sync-protocol/reference-server.ts), and the cloud repository's web/sync/test-workspace-sync-client.mjs, against
// the cloud's server in Miniflare.
import * as W from "./ws.js";

const results = [];
const check = (ok, what) => results.push([!!ok, what]);
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0, acct = 0;
const names = () => { n++; return { name: `ws-sc-${n}-${Math.random().toString(36).slice(2, 8)}`, mainName: `main-sc-${n}` }; };
const fresh = async (nm = names()) => { if (D) return freshD(nm); localStorage.clear(); const w = await W.Workspace.open(nm); used.push(w); return w; };
const used = [];
const ctl = async (cmd, extra = {}) => (D ? ctlD(cmd, extra) : (await fetch("/__ctl", { method: "POST", body: J({ cmd, ...extra }) })).json());
const post = (path, body) => (D ? postD(path, body) : fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: J(body ?? {}) }));

// ---- 3b's diagnostic mode (plan csp3b-accountswitch-diag r2-r8).  Only when the page has window.__budgets AND the
// front answers its proof route's quiet with the registry's shape; otherwise (the cloud's runner: no budgets, a front
// with no /__proof route) every helper here behaves exactly as before, and run() is the old loop.  In diagnostic mode:
// every awaited helper is a labelled, bounded step; a case's clients, workspaces and timed-out work are registered; after
// each case a bounded cleanup proves the page and the front quiet before the next one, else the run fail-stops.

/** the diagnostic run's state; null in legacy mode (and outside a run) */
let D = null;
const now = () => performance.now();
class StepTimeout extends Error {
  constructor(step, ms) { super(`step timed out: ${step} (${Math.round(ms)} ms)`); this.name = "StepTimeout"; this.step = step; }
}
/** A label for a predicate's until() steps (legacy until ignores it) */
const named = (label, f) => Object.assign(f, { label });
/** One awaited step, labelled and bounded: the label and the deadline are set before `thunk(ms)` runs; a synchronous
 * throw is a rejection; a rejection passes through unchanged; past the bound, StepTimeout, and the losing promise stays
 * in the pending set until it settles (a late settlement is recorded).  The bound: min(ms, STEP_MS), cut by the
 * cleanup's deadline in cleanup, else by the case's only when enforceCase. */
function step(label, thunk, ms) {
  const d = D, b = d.budgets;
  let lim = Math.min(ms ?? b.STEP_MS, b.STEP_MS);
  if (d.cleanupDeadline !== null) lim = Math.min(lim, d.cleanupDeadline - now());
  else if (b.enforceCase && d.caseDeadline !== null) lim = Math.min(lim, d.caseDeadline - now());
  const rec = { label, startMs: Math.round(now()) };
  d.steps.push(rec);
  const done = () => { const i = d.steps.indexOf(rec); if (i >= 0) d.steps.splice(i, 1); };
  if (lim <= 0) { done(); return Promise.reject(new StepTimeout(label, 0)); }
  let p;
  try { p = Promise.resolve(thunk(lim)); } catch (e) { p = Promise.reject(e); }
  let timer;
  const expired = new Promise((_, no) => { timer = setTimeout(() => {
    const pend = { label, since: now() };
    d.pending.add(pend);
    p.then(() => {}, () => {}).then(() => { d.pending.delete(pend); d.late.push(`late: ${label} settled after ${((now() - pend.since) / 1000).toFixed(1)} s past its bound`); });
    no(new StepTimeout(label, lim));
  }, lim); });
  return Promise.race([p, expired]).finally(() => { clearTimeout(timer); done(); });
}
/** A step at a case's own call site (accountSwitch's A-rows); legacy: the thunk, as written */
const S = (label, thunk, ms) => (D ? step(label, thunk, ms) : thunk());
const ctlD = (cmd, extra = {}, ms) => step(`ctl ${cmd}`, (lim) => fetch("/__ctl", { method: "POST", body: J({ cmd, ...extra }), signal: AbortSignal.timeout(lim + 100) }).then((r) => r.json()), ms);
const postD = (path, body) => step(`post ${path}`, (lim) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: J(body ?? {}), signal: AbortSignal.timeout(lim + 100) }));
/** fresh() in diagnostic mode: the workspace is registered (in `used`, closed when the run ends however it ends) inside
 * the open's own fulfilment, so an open that ends after its step timed out is still kept, and said (late) */
const freshD = (nm) => {
  localStorage.clear();
  const d = D;
  let timedOut = false;
  const delay = d.openDelayMs;
  const opened = (delay ? sleep(delay) : Promise.resolve()).then(() => W.Workspace.open(nm)).then((w) => {
    used.push(w);
    d.names.set(w, nm.name);
    if (timedOut) d.lateOpened.push(nm.name);
    // (an open that ends after the run's own end, a fail-stop's: closed at once, never left open)
    if (d.over) try { w.close(); } catch {}
    return w;
  });
  return step("fresh: Workspace.open", () => opened).catch((e) => { if (e instanceof StepTimeout) timedOut = true; throw e; });
};
/** A proof command (GET /__proof/<cmd>), bounded */
const proofD = (cmd, n, phase) => step(`proof ${cmd}`, (lim) => fetch(`/__proof/${cmd}${n === undefined ? "" : `?n=${n}${phase ? `&phase=${phase}` : ""}`}`, { signal: AbortSignal.timeout(lim + 100) }).then((r) => r.json()));
/** until() in diagnostic mode (r3 §3.2): the window is checked between calls and its expiry is false, as before; each
 * call is one step, whose StepTimeout (a call that hangs past its own bound) is the only one; a predicate that throws
 * is false, as before */
async function untilD(f, ms) {
  const label = `until: ${f.label ?? (f.name || "predicate")}`;
  const w0 = now();
  for (;;) {
    if (now() - w0 >= ms) return false;
    let r = false;
    try { r = await step(label, () => f()); } catch (e) { if (e instanceof StepTimeout) throw e; }
    if (r) return true;
    await sleep(20);
  }
}
async function stopD(c) {
  await step("stop: c.stop()", () => c.stop());
  await step("stop: c.run", () => c.run);
}
const wellFormedBudgets = (b) => !!b && typeof b === "object" && [b.STEP_MS, b.CLEANUP_MS, b.CASE_FLOOR_MS].every((x) => Number.isFinite(x) && x > 0) && typeof b.CASE_MS === "object" && b.CASE_MS !== null && typeof b.enforceCase === "boolean";
const quietShape = (q) => !!q && Array.isArray(q.inflight) && Array.isArray(q.pendingLate) && Array.isArray(q.late) && [q.closers, q.held, q.closeFailures, q.untrackedReads, q.ups].every(Number.isInteger) && typeof q.epoch === "string";
/** Diagnostic, or why not: the budgets are read FIRST, and only with them is the front asked (one quiet, 5 s) */
async function diagnosticMode() {
  const b = window.__budgets;
  if (b === undefined) return { on: false, why: "no window.__budgets" };
  if (!wellFormedBudgets(b)) return { on: false, why: "window.__budgets malformed" };
  let q;
  try { q = await (await fetch("/__proof/quiet", { signal: AbortSignal.timeout(5000) })).json(); } catch (e) { return { on: false, why: `quiet: ${e?.name ?? e}` }; }
  if (!quietShape(q)) return { on: false, why: `quiet answered ${J(q).slice(0, 200)}` };
  return { on: true, budgets: b };
}
/** A new account, signed in, sync on: its own log. */
async function account(given) {
  const id = given ?? window.ACCOUNTS[acct++];
  if (!given && (id === window.FULL || id === window.SMALL)) throw new Error("out of test accounts");
  const s = await post("/auth/dev", { token: "dev-token", account_id: id });
  if (!s.ok) throw new Error("sign-in: " + s.status);
  const e = await post("/api/sync/v1/enable", {});
  if (!e.ok) throw new Error("enable: " + e.status + " " + (await e.text()));
  await ctl("reset");
  return id;
}
async function until(f, ms = 10_000) {
  if (D) return untilD(f, ms);
  const t = Date.now();
  for (;;) {
    try { if (await f()) return true; } catch {}
    if (Date.now() - t > ms) return false;
    await sleep(20);
  }
}
const all = (db, store) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const keys = (db, store) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).getAllKeys(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const metaGet = (db, k) => new Promise((ok, no) => { const r = db.transaction("meta").objectStore("meta").get(k); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const outbox = async (w) => (await all(w.ws, "outbox")).length;
const opsMessages = (log) => log.sent.filter((m) => m.t === "ops");
const sendable = (ops) => ops.filter((o) => "after" in o && o.after !== undefined && o.op !== "dropVersions" && o.origin !== "server");
const wire = (o) => (o.op === "emptyTrash" || o.op === "discard" ? "forget" : o.op);
const nsOf = (c) => c.debug().ns ?? c.status.ns;
const bytes = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255; return b; };

/** Everything logged here decided: scanned to the latest op, no record left, the sender idle and saying so. */
async function settled(w, c) {
  const ns = nsOf(c);
  if (!ns || c.status.state !== "synced") return false;
  // (the watermark read first: the scan writes it with its records, so an outbox read after it that is empty means
  // decided, never "not scanned yet" (two reads in two transactions: the other order raced a scan between them))
  const scanned = await metaGet(w.ws, `sync:${ns}:scanned`);
  if (!(scanned >= (await w.lastSeq()))) return false;
  return (await outbox(w)) === 0 && c.debug().inflight === 0;
}

/** The op that made `path` is still to go: an undecided record, or past the scan's watermark. */
async function unlost(w, ns, path, what) {
  const op = (await all(w.ws, "ops")).find((o) => o.path === path);
  const rec = (await all(w.ws, "outbox")).find((r) => r.op.path === path);
  const scanned = await metaGet(w.ws, `sync:${ns}:scanned`);
  check(op && (rec ? rec.accepted === undefined : op.seq > scanned), `${what}: the op for ${path} kept, to be sent (a record: ${!!rec}; watermark ${scanned}, op ${op?.seq})`);
}

/** A clock that moves only when told (no jitter: random() is 0.5). */
function fakeClock(t0 = 1_900_000_000_000) {
  let t = t0, id = 0;
  const q = [];
  return {
    now: () => t,
    after(ms, f) {
      const e = { at: t + ms, f, id: ++id };
      q.push(e);
      return () => { const i = q.indexOf(e); if (i >= 0) q.splice(i, 1); };
    },
    random: () => 0.5,
    nextAt: () => (q.length ? Math.min(...q.map((e) => e.at)) : null),
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at || a.id - b.id);
        const e = q[0];
        if (!e || e.at > end) break;
        q.shift();
        t = e.at;
        e.f();
        await sleep(30);
      }
      t = end;
      await sleep(30);
    },
  };
}

function client(w, opts = {}) {
  const c = new W.SyncClient(w, { origin: location.origin, ...opts });
  c.run = c.start();
  if (D) D.clients.push(c);
  return c;
}
async function stop(c) {
  if (D) return stopD(c);
  await c.stop();
  await c.run;
}

/** D2 and D3: in step 3 nothing keeps a cursor, nothing is in the confirmed index, nothing from the server is applied. */
async function nothingApplied(w, what) {
  const meta = await keys(w.ws, "meta");
  const cursors = meta.filter((k) => typeof k === "string" && /^sync:.*:cursor$/.test(k));
  const idx = (await all(w.ws, "syncIndex")).length;
  const server = (await all(w.ws, "ops")).filter((o) => o.origin === "server" || o.device !== w.device).length;
  check(cursors.length === 0 && idx === 0 && server === 0, `${what}: no cursor kept (${J(cursors)}), nothing in the confirmed index (${idx}), no op of the server's applied (${server})`);
}

/** The server's log as another device reads it, and this device's ops in it. */
async function serverOps(w) {
  const p = await S("serverOps: ctl probe", () => ctl("probe"));
  return { all: p.index, mine: p.index.filter((o) => o.device === w.device) };
}

/** Every op this device logged since `from` is in the server's log once, in order, or was refused (listed). */
async function everyOnce(w, from, refusedCount, what, c) {
  const listed = c ? ((await metaGet(w.ws, `sync:${nsOf(c)}:refused`)) ?? []) : [];
  const local = sendable((await w.ops()).filter((o) => o.seq > from));
  const { mine } = await serverOps(w);
  const dseqs = mine.map((o) => o.dseq);
  const once = new Set(dseqs).size === dseqs.length && dseqs.every((d, i) => i === 0 || d > dseqs[i - 1]);
  const paths = local.filter((o, i) => i < local.length).map((o) => wire(o) + " " + o.path);
  const got = mine.map((o) => o.op + " " + o.path);
  const covered = got.every((g) => paths.includes(g));
  check(once && covered && mine.length + refusedCount === local.length, `${what}: every local op in the server's log once, in dseq order, or refused (${mine.length} + ${refusedCount} of ${local.length}): ${J(got).slice(0, 300)}; refused here: ${J(listed).slice(0, 300)}`);
}

// ---- the cases

async function basics() {
  await account();
  const w = await fresh();
  const pages = [];
  const c = client(w, { name: "test", onIndex: async (p) => { pages.push(p.ops.map((o) => o.seq)); } });
  check(await until(() => c.status.state === "synced"), "basics: connected and synced with nothing waiting " + J(c.status));
  const from = await w.lastSeq();
  await w.mkdir("/d");
  await w.create("/d/a.txt", { content: "hello" });
  await w.create("/b.txt", { content: "hello" });
  await w.create("/d/c.txt", { content: "world" });
  await w.rename("/d/a.txt", "/d/a2.txt");
  await w.write("/b.txt", "hello again");
  const t = await w.remove("/d/c.txt");
  await w.restore(t.path);
  check(await until(() => settled(w, c)), "basics: every record sent, accepted, its echo seen, and removed " + J(c.status));
  await everyOnce(w, from, 0, "basics", c);
  const log = await ctl("log");
  const puts = log.http.filter((h) => h.method === "PUT");
  check(puts.length === 3 && puts.every((p) => p.status === 201 || p.status === 200), "basics: each new file's bytes PUT once, the same bytes (two files) once: " + J(puts.map((p) => [p.path.slice(-8), p.status])));
  const checks = log.http.filter((h) => h.check !== undefined);
  check(checks.length >= 1 && checks.every((h) => h.check <= 1000) && checks.every((h) => h.status === 200), "basics: blobs/check asked, at most 1,000 hashes each: " + J(checks.map((h) => h.check)));
  const ops = opsMessages(log);
  const sentDseqs = ops.flatMap((m) => m.dseqs);
  check(ops.every((m) => m.dseqs.length <= 500) && new Set(sentDseqs).size === sentDseqs.length, "basics: each op sent once (no loss, no resend without a cause), at most 500 a message: " + J(ops.map((m) => m.dseqs)));
  const firstPut = log.http.findIndex((h) => h.method === "PUT");
  check(firstPut >= 0, "basics: the upload came first (an op naming bytes the server lacks would be refused)");
  check(log.sent[0]?.t === "hello" && log.sent[0].index_after === 0, "basics: hello reads the log from its start (no cursor kept): " + J(log.sent[0]));
  // (another device's op: read (the cursor moves, in memory), given to onIndex, never applied here)
  const remote = await ctl("probe", { ops: [{ dseq: 1, t: Date.now(), by: "person", op: "mkdir", path: "/remote", kind: "folder", fid: "00000000000000aa" }] });
  const rseq = remote.ack?.ops?.[0]?.seq;
  check(Number.isSafeInteger(rseq), "basics: another device's op accepted " + J(remote.ack));
  await w.mkdir("/x2");
  check(await until(() => c.debug().cursor >= rseq && c.status.state === "synced"), "basics: the client read past another device's op (after its next ack, a pull): cursor " + c.debug().cursor + " ≥ " + rseq);
  check(!(await w.stat("/remote")), "basics: …and didn't apply it (step 3 applies nothing from the server)");
  const flat = pages.flat();
  check(flat.includes(rseq) && flat.every((s, i) => i === 0 || s > flat[i - 1]), "basics: onIndex given every page, in seq order, the other device's op among them: " + J(pages).slice(0, 200));
  await nothingApplied(w, "basics");
  // (a reload: the log read again from its start, as nothing kept a cursor)
  await stop(c);
  await ctl("log", { reset: true });
  const c2 = client(w);
  check(await until(() => c2.status.state === "synced"), "basics: a second client (a reload) syncs");
  const l2 = await ctl("log");
  check(l2.sent[0]?.t === "hello" && l2.sent[0].index_after === 0 && opsMessages(l2).length === 0, "basics: after a reload, hello from 0 again, and nothing resent (every record was decided): " + J(l2.sent.slice(0, 3)));
  await nothingApplied(w, "basics, after a reload");
  await stop(c2);
}

async function lostAckReconnect() {
  await account();
  const w = await fresh();
  const c = client(w);
  check(await until(() => c.status.state === "synced"), "lost ack: synced");
  const from = await w.lastSeq();
  // (and the next connection's first index, so the record is resent rather than confirmed by its echo first)
  await ctl("set", { set: { dropAcks: 1, closeAfterDrop: true, dropIndex: 1 } });
  await w.create("/l.txt", { content: "lost" });
  check(await until(() => settled(w, c), 15_000), "lost ack, then the socket closed: the record decided after the reconnect " + J(c.status));
  const log = await ctl("log");
  const sends = opsMessages(log);
  const dropped = log.got.filter((g) => g.dropped && g.t === "ack");
  const same = sends.length === 2 && J(sends[0].json) === J(sends[1].json);
  check(dropped.length === 1 && same && c.stats.connects === 2, "lost ack: the same dseq resent unchanged on the new connection, the server's stored decision taken: " + J(sends.map((s) => s.dseqs)));
  await everyOnce(w, from, 0, "lost ack");
  await nothingApplied(w, "lost ack");
  await stop(c);
}

async function lostAckReload() {
  await account();
  const w = await fresh();
  const c = client(w);
  check(await until(() => c.status.state === "synced"), "lost ack, reload: synced");
  const from = await w.lastSeq();
  await ctl("set", { set: { dropAcks: 1, dropIndex: 1 } });
  await w.create("/r.txt", { content: "reload" });
  check(await until(async () => (await ctl("log")).got.some((g) => g.dropped)), "lost ack, reload: the ack dropped");
  await stop(c);
  const kept = await all(w.ws, "outbox");
  check(kept.length === 1 && kept[0].accepted === undefined, "lost ack, reload: the record kept, undecided, across the stop: " + J(kept.map((r) => [r.dseq, r.accepted])));
  const c2 = client(w);
  check(await until(() => settled(w, c2)), "lost ack, reload: decided by the next page's client " + J(c2.status));
  const sends = opsMessages(await ctl("log"));
  check(sends.length === 2 && J(sends[0].json) === J(sends[1].json) && sends[0].dseqs[0] === kept[0].dseq, "lost ack, reload: the same dseq, the same payload: " + J(sends.map((s) => s.dseqs)));
  await everyOnce(w, from, 0, "lost ack, reload");
  await nothingApplied(w, "lost ack, reload");
  await stop(c2);
}

async function refusal() {
  await account();
  const w = await fresh();
  const c0 = client(w);
  check(await until(() => c0.status.state === "synced"), "refusal: synced");
  const from = await w.lastSeq();
  await stop(c0);
  // (a file whose bytes this device no longer has: its record is sent all the same (C1), the server refuses it
  // `missing`, a per-op decision; the op after it is decided as usual)
  const f = await w.create("/f.txt", { content: "bytes gone" });
  await w.mkdir("/after");
  await new Promise((ok, no) => { const tx = w.ws.transaction("fileBytes", "readwrite"); tx.objectStore("fileBytes").delete(f.fid); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  const c = client(w);
  check(await until(() => settled(w, c)), "refusal: every record decided " + J(c.status));
  const ns = nsOf(c);
  const refused = (await metaGet(w.ws, `sync:${ns}:refused`)) ?? [];
  const rb = await metaGet(w.ws, `sync:${ns}:rebuild`);
  const puts = (await ctl("log")).http.filter((h) => h.method === "PUT");
  check(puts.length === 0 && refused.length === 1 && refused[0].code === "missing" && refused[0].path === "/f.txt" && refused[0].n === 1, "refusal: no bytes to upload, the op sent anyway, refused `missing`, listed with its code and path, numbered 1: " + J(refused));
  check(rb?.why === "refused", "refusal: the rebuild asked for (done in step 4): " + J(rb));
  const { mine } = await serverOps(w);
  check(mine.some((o) => o.op === "mkdir" && o.path === "/after"), "refusal: the op after the refused one accepted");
  await everyOnce(w, from, 1, "refusal", c);
  await nothingApplied(w, "refusal");
  await stop(c);
}

async function rateProlonged() {
  await account();
  const w = await fresh();
  const c0 = client(w);
  check(await until(() => c0.status.state === "synced"), "rate: synced");
  const from = await w.lastSeq();
  await stop(c0);
  for (const p of ["/r1", "/r2", "/r3"]) await w.mkdir(p);
  await ctl("log", { reset: true });
  await ctl("set", { set: { fakeOps: [1, 2, 3].map(() => ({ code: "rate", detail: { message: "too many ops", retry_after: 30_000 } })) } });
  const clock = fakeClock();
  const c = client(w, { clock });
  check(await until(async () => opsMessages(await ctl("log")).length === 1), "rate: the first message sent, and refused whole (rate)");
  await sleep(200);
  const ns = nsOf(c);
  const timer = await metaGet(w.ws, `sync:${ns}:retry:ops`);
  check((await outbox(w)) === 3 && timer?.at === clock.now() + 30_000, "rate: no record removed; the ops timer set to retry_after and kept in meta: " + J(timer));
  await clock.advance(29_000);
  await sleep(300);
  check(opsMessages(await ctl("log")).length === 1, "rate: nothing resent before its timer");
  await clock.advance(1_000);
  check(await until(async () => opsMessages(await ctl("log")).length === 2), "rate: resent at its timer (refused again)");
  await clock.advance(30_000);
  check(await until(async () => opsMessages(await ctl("log")).length === 3), "rate: resent at its next timer (refused again)");
  await clock.advance(30_000);
  check(await until(() => settled(w, c)), "rate: then accepted: every record decided " + J(c.status));
  const sends = opsMessages(await ctl("log"));
  check(sends.length === 4 && sends.every((s) => J(s.json) === J(sends[0].json)), "rate: 4 messages in 90 s, each the same 3 records unchanged: " + J(sends.map((s) => s.dseqs)));
  check((await metaGet(w.ws, `sync:${ns}:retry:ops`)) === undefined, "rate: the timer cleared once a message went through");
  await everyOnce(w, from, 0, "rate");
  await nothingApplied(w, "rate");
  await stop(c);
}

async function reloadHonorsTimer() {
  await account();
  const w = await fresh();
  const c0 = client(w);
  check(await until(() => c0.status.state === "synced"), "timer across a reload: synced");
  const from = await w.lastSeq();
  await stop(c0);
  await w.mkdir("/t1");
  await ctl("log", { reset: true });
  await ctl("set", { set: { fakeOps: [{ code: "rate", detail: { retry_after: 60_000 } }] } });
  const clock = fakeClock();
  const c1 = client(w, { clock });
  check(await until(async () => opsMessages(await ctl("log")).length === 1), "timer across a reload: refused (rate, 60 s)");
  await sleep(200);
  await stop(c1);
  const persisted = await metaGet(w.ws, `sync:${nsOf(c1)}:retry:ops`);
  check(persisted?.at === clock.now() + 60_000, "timer across a reload: the timer persisted: " + J(persisted) + " now " + clock.now());
  const clock2 = fakeClock(clock.now() + 5_000);
  const c2 = client(w, { clock: clock2 });
  check(await until(() => c2.debug().writable === true), "timer across a reload: the next page's client connected");
  await sleep(500);
  const lt = await ctl("log");
  check(opsMessages(lt).length === 1, "timer across a reload: nothing sent before the persisted timer ends: " + J(lt.sent.map((m) => m.t)) + " " + J(c2.debug()));
  await clock2.advance(55_000);
  check(await until(async () => (await outbox(w)) === 0), "timer across a reload: sent, and decided, when it ends");
  await everyOnce(w, from, 0, "timer across a reload");
  await stop(c2);
}

async function invalidRebuild() {
  await account();
  const w = await fresh();
  const c0 = client(w);
  check(await until(() => c0.status.state === "synced"), "invalid rebuild: synced");
  await stop(c0);
  await w.mkdir("/i1");
  await ctl("log", { reset: true });
  await ctl("set", { set: { fakeOps: [{ code: "invalid", detail: { message: "too many refused ops: rebuild from the server's log" } }] } });
  const c = client(w);
  check(await until(() => c.debug().halted === "invalid"), "invalid rebuild: sending halted " + J(c.debug()));
  // (the halt is in memory first, so nothing more is sent while its durable flag is written: wait for the flag)
  await until(async () => (await metaGet(w.ws, `sync:${nsOf(c)}:rebuild`))?.why === "invalid");
  const rb = await metaGet(w.ws, `sync:${nsOf(c)}:rebuild`);
  check(rb?.why === "invalid" && (await outbox(w)) === 1, "invalid rebuild: the rebuild asked for, the undecided record kept: " + J(rb));
  await w.mkdir("/i2");
  await sleep(1500);
  check(opsMessages(await ctl("log")).length === 1 && c.status.state === "paused", "invalid rebuild: nothing more sent until the rebuild (step 4); the foot says paused: " + J(c.status));
  await stop(c);
  // (a reload: still halted, from the durable flag)
  await ctl("log", { reset: true });
  const c2 = client(w);
  check(await until(() => c2.debug().halted === "invalid"), "invalid rebuild: still halted after a reload");
  await sleep(500);
  check(opsMessages(await ctl("log")).length === 0 && (await outbox(w)) === 1, "invalid rebuild: …nothing sent, the record kept");
  await unlost(w, nsOf(c2), "/i2", "invalid rebuild");
  await nothingApplied(w, "invalid rebuild");
  await stop(c2);
}

async function busyOrder() {
  await account();
  const w = await fresh();
  const c0 = client(w);
  check(await until(() => c0.status.state === "synced"), "busy and order: synced");
  const from = await w.lastSeq();
  await stop(c0);
  await w.mkdir("/b1");
  await w.mkdir("/b2");
  // (the records' dseqs: the scan makes them on the next connection)
  await ctl("log", { reset: true });
  await ctl("set", { set: { fakeOps: [{ code: "busy", detail: { retry_after: 300 } }, { code: "order", detail: { next_dseq: 1 } }] } });
  const c = client(w);
  check(await until(() => settled(w, c)), "busy and order: decided after both " + J(c.status));
  const sends = opsMessages(await ctl("log"));
  check(sends.length === 3 && sends.every((s) => J(s.json) === J(sends[0].json)), "busy and order: resent unchanged, from the lowest undecided, each time: " + J(sends.map((s) => s.dseqs)));
  await everyOnce(w, from, 0, "busy and order");
  await stop(c);
}

// (a network for the client (P0 #3): online or not, and its return told to whoever listens)
function fakeNet(on) {
  const fs = new Set();
  return { on, online() { return this.on; }, onBack(f) { fs.add(f); return () => fs.delete(f); }, back() { for (const f of [...fs]) f(); }, listeners: () => fs.size };
}

async function storm() {
  await account();
  const w = await fresh();
  await ctl("set", { set: { closeOnOpen: 6 } });
  const clock = fakeClock();
  // (the browser offline: the backoff's whole range, uncapped (P0 #3 caps it while online: netWake))
  const c = client(w, { clock, net: fakeNet(false) });
  const times = [];
  for (let k = 0; k < 7; k++) {
    if (!(await until(() => c.stats.connects === k + 1))) break;
    times.push(clock.now());
    if (k < 6) {
      await until(() => c.status.state === "offline" && clock.nextAt() !== null);
      await clock.advance(clock.nextAt() - clock.now());
    }
  }
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  check(J(gaps) === J([1000, 2000, 4000, 8000, 16000, 32000]), "reconnect storm: each reconnect after its timer, 1 s doubling (no jitter at random() = 0.5): " + J(gaps));
  check(await until(() => c.status.state === "synced"), "reconnect storm: then connected " + J(c.status));
  check((await metaGet(w.ws, `sync:${nsOf(c)}:retry:connect`)) === undefined, "reconnect storm: the timer cleared by a welcome");
  // (the timer persisted while it ran: a reload would have honored it)
  await stop(c);
}

async function netWake() {
  // (P0 #3, William's ~1 minute: the connection's own backoff, which grows to 60 s while the network is gone, ends when
  // the network comes back (or the page is shown again); while the browser says it is online the backoff stops at 15
  // s; a wait the server asked for (retry_after) is kept)
  await account();
  const w = await fresh();
  await ctl("set", { set: { closeOnOpen: 4 } });
  const clock = fakeClock(), net = fakeNet(false);
  const c = client(w, { clock, net });
  for (let k = 0; k < 4; k++) {
    await until(() => c.stats.connects === k + 1);
    await until(() => c.status.state === "offline" && clock.nextAt() !== null);
    if (k < 3) await clock.advance(clock.nextAt() - clock.now());
  }
  const t0 = clock.now(), ns = nsOf(c), pending = await metaGet(w.ws, `sync:${ns}:retry:connect`);
  net.on = true;
  net.back();
  const woke = await until(() => c.stats.connects === 5, 3000);
  check(woke && clock.now() === t0 && pending?.n === 4 && pending.at - t0 >= 7000 && !pending.server, "net wake: offline, four drops (8 s to wait): the network back, a connection at once, no time passed: " + J({ woke, connects: c.stats.connects, pending, waited: clock.now() - t0 }));
  // (the step kept across a wake (sync-docs' RW-1): its timer due now, not dropped, so a failed try would go on
  // doubling; a welcome clears it)
  const due = await metaGet(w.ws, `sync:${ns}:retry:connect`);
  check(due === undefined || (due.n === 4 && due.at === t0), "net wake: the wake keeps the step (n 4), due now, until a welcome clears it: " + J(due));
  check(await until(() => c.status.state === "synced") && (await until(async () => (await metaGet(w.ws, `sync:${ns}:retry:connect`)) === undefined)), "net wake: …then synced, its timer gone from meta");
  await stop(c);
  check(net.listeners() === 0, "net wake: stop() removes the network listener");
  // (a server down, the page shown again and again: each wake ends the wait, and each failure goes on doubling from
  // the step it was at, never from 1 s (sync-docs' RW-1))
  await ctl("set", { set: { closeOnOpen: 5 } });
  // (each part its own workspace: a client stopped mid-backoff leaves its timer in meta, which the next would honor)
  const wR = await fresh();
  const clockR = fakeClock(), netR = fakeNet(false), cR = client(wR, { clock: clockR, net: netR }), gapsR = [];
  await until(() => cR.stats.connects === 1);
  for (let k = 0; k < 4; k++) {
    await until(() => cR.status.state === "offline" && clockR.nextAt() !== null);
    const at = cR.stats.connects, t1 = clockR.now();
    if (k === 1 || k === 2) netR.back();
    else await clockR.advance(clockR.nextAt() - clockR.now());
    await until(() => cR.stats.connects === at + 1, 3000);
    gapsR.push(clockR.now() - t1);
  }
  await until(() => cR.status.state === "offline" && clockR.nextAt() !== null);
  const stepR = await metaGet(wR.ws, `sync:${nsOf(cR)}:retry:connect`);
  check(J(gapsR) === J([1000, 0, 0, 8000]) && stepR?.n === 5, "net wake: two wakes while the server keeps closing: the waits end at once, the step goes on (the 4th gap 8 s, then n 5), never back to 1 s: " + J({ gapsR, stepR }));
  await stop(cR);
  // (online: the backoff stops at 15 s)
  await ctl("set", { set: { closeOnOpen: 0 } });
  await ctl("set", { set: { closeOnOpen: 6 } });
  const w2 = await fresh();
  const clock2 = fakeClock(), c2 = client(w2, { clock: clock2, net: fakeNet(true) }), times = [];
  for (let k = 0; k < 7; k++) {
    if (!(await until(() => c2.stats.connects === k + 1))) break;
    times.push(clock2.now());
    if (k < 6) {
      await until(() => c2.status.state === "offline" && clock2.nextAt() !== null);
      await clock2.advance(clock2.nextAt() - clock2.now());
    }
  }
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  check(J(gaps) === J([1000, 2000, 4000, 8000, 15000, 15000]), "net wake: online, the connection's backoff stops at 15 s: " + J(gaps));
  await stop(c2);
  // (a wait the server asked for: kept when the network comes back, ended by its own time)
  await ctl("set", { set: { closeOnOpen: 0 } });
  await ctl("set", { set: { fakeHttp: [{ method: "GET", path: "/api/sync/v1/status", status: 503, body: { error: "busy", retry_after: 30_000 }, times: 1 }] } });
  const w3 = await fresh();
  const clock3 = fakeClock(), net3 = fakeNet(true), c3 = client(w3, { clock: clock3, net: net3 });
  await until(() => c3.status.state === "offline" && clock3.nextAt() !== null);
  const before = c3.stats.connects;
  net3.back();
  await sleep(300);
  const kept = c3.stats.connects === before && c3.status.state === "offline";
  await clock3.advance(30_000);
  check(kept && (await until(() => c3.status.state === "synced")), "net wake: the server's retry_after (30 s) kept when the network comes back, then connected at its time: " + J({ kept, before, status: c3.status }));
  await stop(c3);
}

async function twoTabs() {
  await account();
  const nm = names();
  const w1 = await fresh(nm), w2 = await fresh(nm);
  const c1 = client(w1);
  check(await until(() => c1.status.state === "synced"), "two tabs: the first syncs");
  const from = await w1.lastSeq();
  const c2 = client(w2);
  await sleep(500);
  const l = await ctl("log");
  check(c2.status.state === "waiting" && l.sockets === 1, "two tabs: the second waits for the lock; one socket: " + J({ s: c2.status.state, open: l.open, sockets: l.sockets }));
  await w2.mkdir("/from-tab-2");
  check(await until(() => settled(w1, c1)), "two tabs: a change in the waiting tab sent by the one holding the lock");
  await stop(c1);
  check(await until(() => c2.status.state === "synced"), "two tabs: the lock passed on; the second connects " + J(c2.status));
  await w2.mkdir("/after-handover");
  check(await until(() => settled(w2, c2)), "two tabs: …and sends, from the durable state");
  await everyOnce(w2, from, 0, "two tabs");
  await nothingApplied(w2, "two tabs");
  await stop(c2);
}

async function generation() {
  await account();
  const w = await fresh();
  const c0 = client(w);
  check(await until(() => c0.status.state === "synced"), "generation: synced");
  const from = await w.lastSeq();
  const g = Number(nsOf(c0).split(":")[1]);
  await stop(c0);
  await w.mkdir("/g1");
  await ctl("log", { reset: true });
  await ctl("set", { set: { rewriteWelcome: { generation: g + 1 } } });
  const c = client(w);
  check(await until(() => settled(w, c)), "generation: decided " + J(c.status));
  const l = await ctl("log");
  const order = l.sent.map((m) => m.t);
  check(c.stats.connects === 2 && order[0] === "hello" && order[1] === "hello" && opsMessages(l).length === 1, "generation: a welcome for another generation than the status's: closed, nothing sent on it, the namespace read again: " + J(order));
  await everyOnce(w, from, 0, "generation");
  await stop(c);
}

async function diverged() {
  await account();
  const w = await fresh();
  const c0 = client(w);
  check(await until(() => c0.status.state === "synced"), "diverged: synced");
  await stop(c0);
  await w.mkdir("/v1");
  await ctl("log", { reset: true });
  await ctl("set", { set: { rewriteWelcome: { next_dseq: 1000 } } });
  const c = client(w);
  check(await until(() => c.debug().halted === "diverged"), "diverged: the server has decided dseqs this device never made: halted " + J(c.debug()));
  await until(async () => (await metaGet(w.ws, `sync:${nsOf(c)}:rebuild`))?.why === "diverged");
  await sleep(300);
  const rb = await metaGet(w.ws, `sync:${nsOf(c)}:rebuild`);
  check(rb?.why === "diverged" && opsMessages(await ctl("log")).length === 0, "diverged: nothing sent, the rebuild asked for: " + J(rb));
  await unlost(w, nsOf(c), "/v1", "diverged");
  await stop(c);
}

async function storageFull() {
  await account(window.FULL);
  const w = await fresh();
  const c = client(w);
  check(await until(() => c.status.state === "synced"), "storage full: synced");
  await w.create("/big.bin", { content: bytes(12_000, 1) });
  await w.mkdir("/after-full");
  check(await until(() => c.status.state === "paused" && c.status.reason === "storage full"), "storage full: uploads paused, said: " + J(c.status));
  await sleep(300);
  const l = await ctl("log");
  const puts = l.http.filter((h) => h.method === "PUT");
  const refused = (await metaGet(w.ws, `sync:${nsOf(c)}:refused`)) ?? [];
  check(puts.length === 1 && puts[0].status === 507 && opsMessages(l).length === 0 && (await outbox(w)) === 2 && refused.length === 0, "storage full: the op naming the bytes isn't sent (a `missing` would be final), nor any after it; both kept: " + J({ puts: puts.map((p) => p.status), ops: opsMessages(l).length }));
  check((await metaGet(w.ws, `sync:${nsOf(c)}:paused`))?.why === "storage_full", "storage full: the pause kept in meta");
  await c.resume();
  check(await until(async () => (await ctl("log")).http.filter((h) => h.method === "PUT").length === 2), "storage full: the person's resume() tries again");
  await nothingApplied(w, "storage full");
  await stop(c);
}

async function tooLarge() {
  await account(window.SMALL);
  const w = await fresh();
  const c = client(w);
  check(await until(() => c.status.state === "synced"), "too large: synced");
  const from = await w.lastSeq();
  await w.create("/large.bin", { content: bytes(6_000, 2) });
  await w.mkdir("/after-large");
  check(await until(() => settled(w, c)), "too large: decided " + J(c.status));
  const refused = (await metaGet(w.ws, `sync:${nsOf(c)}:refused`)) ?? [];
  const puts = (await ctl("log")).http.filter((h) => h.method === "PUT");
  check(puts.length === 1 && puts[0].status === 413 && refused.length === 1 && refused[0].code === "missing" && refused[0].path === "/large.bin", "too large: the upload refused for good (413), the op sent all the same and refused `missing`, listed: " + J({ puts: puts.map((p) => p.status), refused }));
  await everyOnce(w, from, 1, "too large");
  await stop(c);
}

async function reservation() {
  await account();
  const w = await fresh();
  const c0 = client(w);
  check(await until(() => c0.status.state === "synced"), "reservation: synced");
  const from = await w.lastSeq();
  await stop(c0);
  // (made while stopped, so one scan makes them one message's records, uploaded side by side)
  const size = 30_000;
  for (let i = 0; i < 4; i++) await w.create(`/u${i}.bin`, { content: bytes(size, 10 + i) });
  await ctl("set", { set: { holdPut: true } });
  const c = client(w);
  check(await until(async () => (await ctl("log")).putsNow === 2), "reservation: two uploads at once");
  await sleep(400);
  const l = await ctl("log");
  const r = W.reserved();
  check(l.putsNow === 2 && l.maxPuts === 2 && r.held >= 2 * size * W.COPIES, "reservation: no third while two run; each holds size × COPIES of the page's reservation while its bytes are out: " + J({ now: l.putsNow, held: r.held }));
  await ctl("set", { set: { holdPut: false } });
  await ctl("release");
  check(await until(() => settled(w, c)), "reservation: then all decided");
  check(W.reserved().held === 0 && (await ctl("log")).maxPuts <= 2 && c.stats.maxPutsAtOnce <= 2, "reservation: every reservation released; never more than 2 PUTs at once");
  await everyOnce(w, from, 0, "reservation");
  await stop(c);
}

async function pace() {
  await account();
  const w = await fresh();
  const c0 = client(w);
  check(await until(() => c0.status.state === "synced"), "pace: synced");
  const from = await w.lastSeq();
  await stop(c0);
  for (let i = 0; i < 1200; i++) await w.mkdir(`/p${i}`);
  await ctl("log", { reset: true });
  const clock = fakeClock();
  const c = client(w, { clock });
  check(await until(async () => c.stats.opsSent === 500 && (await outbox(w)) === 700, 20_000), "pace: 500 ops at once (the bucket's burst), then waits " + J(c.stats));
  await clock.advance(19_000);
  await sleep(300);
  check(c.stats.opsSent === 500, "pace: nothing more for 20 s (25 a second): " + c.stats.opsSent);
  await clock.advance(1_000);
  check(await until(() => c.stats.opsSent === 1000), "pace: 500 more at 20 s: " + c.stats.opsSent);
  await clock.advance(8_000);
  check(await until(async () => c.stats.opsSent === 1200 && (await outbox(w)) === 0, 20_000), "pace: the last 200 at 28 s, all decided: " + c.stats.opsSent);
  check(c.stats.maxOps <= 500 && c.stats.maxInflight <= 8, "pace: at most 500 ops a message, 8 requests unanswered: " + J({ ops: c.stats.maxOps, inflight: c.stats.maxInflight }));
  await everyOnce(w, from, 0, "pace");
  await stop(c);
}


// ---- daybreak3's LIMIT-PR58-1 to 3

async function wakesBounded() {
  // (LIMIT-PR58-1: tens of thousands of changes while ops and uploads are both backed off: at most one wake-up a
  // kind pending, and as few fired when they end)
  await account();
  const w = await fresh();
  const c0 = client(w);
  check(await until(() => c0.status.state === "synced"), "wakes: synced");
  await stop(c0);
  await w.mkdir("/k0");
  await w.create("/k.bin", { content: bytes(1000, 7) });
  await ctl("log", { reset: true });
  await ctl("set", { set: { fakeOps: [{ code: "rate", detail: { retry_after: 60_000 } }], fakeHttp: [{ method: "PUT", status: 503, body: { error: "busy", retry_after: 60_000 }, times: 1000 }] } });
  const clock = fakeClock();
  const c = client(w, { clock });
  check(await until(async () => { const l = await ctl("log"); return opsMessages(l).length === 1 && l.http.some((h) => h.method === "PUT"); }), "wakes: the ops refused (rate, 60 s) and the upload refused (busy, 60 s)");
  await sleep(200);
  for (let i = 0; i < 50_000; i++) {
    c.kick();
    if (i % 500 === 0) await sleep(1);
  }
  for (let i = 1; i <= 200; i++) await w.mkdir(`/k${i}`);
  await sleep(300);
  const d = c.debug();
  check(d.wakes <= 8 && c.stats.maxWakes <= 8, "wakes: 50,000 kicks and 200 edits during both backoffs leave at most one wake-up a kind: " + J({ now: d.wakes, max: c.stats.maxWakes }));
  const fired = c.stats.wakesFired;
  await clock.advance(60_000);
  await sleep(500);
  check(c.stats.wakesFired - fired <= 8, "wakes: …and at most one a kind fires when they end: " + (c.stats.wakesFired - fired));
  await stop(c);
  check(c.debug().wakes === 0, "wakes: none left after stop()");
}

/** `f(value)` -> new value, on the first record of `store` that `match`es (a cursor, in one transaction). */
const patch = (db, store, match, f) => new Promise((ok, no) => {
  const tx = db.transaction(store, "readwrite");
  const r = tx.objectStore(store).openCursor();
  let done = false;
  r.onsuccess = () => {
    const cur = r.result;
    if (!cur || done) return;
    if (match(cur.value)) { cur.update(f(cur.value)); done = true; return; }
    cur.continue();
  };
  tx.oncomplete = () => ok(done);
  tx.onerror = () => no(tx.error);
});

async function byteMismatch() {
  // (LIMIT-PR58-2: an entry whose stored size isn't its record's; stored bytes longer than their metadata; a record
  // whose size is less than its bytes: none read beyond its reservation's cover by its metadata, hashed or PUT; each
  // read at most once, across a resend; then the files converge by their next writes)
  await account();
  const w = await fresh();
  const c0 = client(w);
  check(await until(() => c0.status.state === "synced"), "byte mismatch: synced");
  const from = await w.lastSeq();
  await stop(c0);
  const m1 = await w.create("/m1.bin", { content: bytes(1000, 21) });
  const m2 = await w.create("/m2.bin", { content: bytes(1000, 22) });
  await w.create("/m3.bin", { content: bytes(1000, 23) });
  check(await patch(w.ws, "entries", (e) => e.fid === m1.fid, (e) => ({ ...e, size: 10 })), "(m1's entry says 10 bytes)");
  await new Promise((ok, no) => { const tx = w.ws.transaction("fileBytes", "readwrite"); tx.objectStore("fileBytes").put(bytes(5000, 22), m2.fid); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  check(await patch(w.ws, "ops", (o) => o.path === "/m3.bin" && o.op === "create", (o) => ({ ...o, size: 10 })), "(m3's op says 10 bytes)");
  await ctl("log", { reset: true });
  // (the first ack lost and the socket closed: the records are sent again on the next connection)
  await ctl("set", { set: { dropAcks: 1, closeAfterDrop: true, dropIndex: 1 } });
  const c = client(w);
  check(await until(() => settled(w, c), 15_000), "byte mismatch: decided " + J(c.status));
  const l = await ctl("log");
  const puts = l.http.filter((h) => h.method === "PUT");
  const refused = (await metaGet(w.ws, `sync:${nsOf(c)}:refused`)) ?? [];
  check((await metaGet(w.ws, "sync:bytes-untrusted"))?.dseq !== undefined && c.stats.maxReadsAtOnce === 1, "byte mismatch: bytes longer than their metadata mark the workspace's stored bytes untrusted, durably; reads one at a time: " + J({ reads: c.stats.maxReadsAtOnce }));
  check(puts.length === 0 && c.stats.mismatches === 3 && c.stats.connects === 2, "byte mismatch: no PUT; each mismatch found once, though the records went twice: " + J({ puts: puts.length, mismatches: c.stats.mismatches, connects: c.stats.connects }));
  check(refused.length === 3 && refused.every((r) => r.code === "missing"), "byte mismatch: each sent all the same and refused `missing` by the server, listed: " + J(refused.map((r) => [r.path, r.code])));
  // (convergence: each file's next write goes as usual)
  for (const [p, seed] of [["/m1.bin", 31], ["/m2.bin", 32], ["/m3.bin", 33]]) await w.write(p, bytes(1200, seed));
  check(await until(() => settled(w, c)), "byte mismatch: the next writes decided");
  const { mine } = await serverOps(w);
  check(["/m1.bin", "/m2.bin", "/m3.bin"].every((p) => mine.some((o) => o.op === "write" && o.path === p && o.size === 1200)), "byte mismatch: …each file's present bytes now on the server");
  check((await ctl("log")).http.filter((h) => h.method === "PUT" && (h.status === 201 || h.status === 200)).length === 3, "byte mismatch: …uploaded once each");
  check(c.stats.wideReads >= 3, "byte mismatch: …each read, once the bytes are untrusted, under the largest reservation (the page's to itself): " + c.stats.wideReads);
  await everyOnce(w, from, 3, "byte mismatch", c);
  await stop(c);
}

/** Another device's `n` mkdirs, from dseq `d0` + 1, in messages of at most 450. */
async function otherOps(n, d0 = 0, tag = "o") {
  for (let i = 0; i < n; i += 450) {
    const ops = [];
    for (let j = i; j < Math.min(n, i + 450); j++) ops.push({ dseq: d0 + j + 1, t: Date.now(), by: "person", op: "mkdir", path: `/${tag}${d0 + j}`, kind: "folder", fid: (d0 + j + 1).toString(16).padStart(16, "0") });
    const r = await ctl("probe", { ops });
    if (!r.ack?.ops?.every((o) => o.seq)) throw new Error("another device's ops refused: " + J(r.ack).slice(0, 200));
  }
}

async function replayPaced() {
  // (LIMIT-PR58-3: the log read only to its target, the newest accepted record awaiting its echo; pulls paced)
  await account();
  const w = await fresh();
  const keep = { ...W.CLIENT };
  Object.assign(W.CLIENT, { pullBurst: 1, pullsPerSecond: 0.1 });
  const clock = fakeClock();
  const c = client(w, { clock });
  try {
    check(await until(() => settled(w, c)), "replay paced: synced");
    check(c.stats.pages === 1 && c.stats.pulls === 0, "replay paced: nothing awaiting an echo: hello's one page, no pull: " + J({ pages: c.stats.pages, pulls: c.stats.pulls }));
    await w.mkdir("/a");
    check(await until(async () => (await settled(w, c)) && c.stats.pulls === 1), "replay paced: an accepted record: one pull, to its echo");
    await otherOps(1800);
    await w.mkdir("/b");
    check(await until(async () => (await all(w.ws, "outbox")).some((r) => r.accepted !== undefined)), "replay paced: /b accepted, its echo 1,800 ops on");
    await sleep(500);
    check(c.stats.pulls === 1, "replay paced: the next pull waits for the pace (a token each 10 s): " + c.stats.pulls);
    await clock.advance(10_000);
    check(await until(() => c.stats.pulls === 2), "replay paced: a pull at 10 s: " + c.stats.pulls);
    await sleep(300);
    check(c.stats.pulls === 2, "replay paced: …then waits again (more to read): " + c.stats.pulls);
    await clock.advance(10_000);
    check(await until(() => c.stats.pulls === 3 && settled(w, c)), "replay paced: the next at 20 s reaches the echo; confirmed: " + J({ pulls: c.stats.pulls, cursor: c.debug().cursor }));
    // (others' ops after the target: not read, however many)
    await otherOps(100, 1800);
    await sleep(500);
    check(c.stats.pulls === 3, "replay paced: ops past the target aren't pulled: " + c.stats.pulls);
  } finally {
    Object.assign(W.CLIENT, keep);
    await stop(c);
  }
}

async function replayCapped() {
  // (daybreak3's LIMIT-PR58-3, and their question 2: at most CLIENT.replayPages pages a slice; then a rest, and the
  // rest of the way on the same connection, never a stall)
  await account();
  const w = await fresh();
  const keep = { ...W.CLIENT };
  Object.assign(W.CLIENT, { replayPages: 1, replayRestMs: 1_500 });
  const c = client(w);
  try {
    check(await until(() => settled(w, c)), "replay capped: synced");
    await otherOps(1800);
    await w.mkdir("/far");
    check(await until(async () => (await all(w.ws, "outbox")).some((r) => r.accepted !== undefined)), "replay capped: /far accepted, its echo two pages on");
    await sleep(600);
    check(c.stats.pulls === 0 && c.debug().wakes >= 1, "replay capped: 1 page a slice (hello's), then a rest, scheduled: " + J({ pages: c.stats.pages, pulls: c.stats.pulls, wakes: c.debug().wakes }));
    check(await until(() => c.stats.pulls === 1, 5_000), "replay capped: a slice after the first rest (one pull)");
    await sleep(600);
    check(c.stats.pulls === 1, "replay capped: …then a second rest");
    check(await until(() => settled(w, c), 10_000), "replay capped: after the second rest, the next slice reaches the echo; confirmed, never stalled");
    check(c.stats.pulls === 2 && c.stats.connects === 1, "replay capped: two boundaries crossed on the same connection, no stop: " + J({ pulls: c.stats.pulls, connects: c.stats.connects }));
    // (a page that says more and moves nothing: refused, not asked again)
    await ctl("set", { set: { emptyMore: 1, dropIndex: 0 } });
    const before = c.stats.connects;
    await w.mkdir("/again");
    check(await until(async () => c.stats.connects === before + 1 && (await settled(w, c)), 15_000), "replay capped: a `more` page that moves nothing ends the connection (no loop of pulls); the next one confirms: " + J({ connects: c.stats.connects, pulls: c.stats.pulls }));
    check(c.stats.pulls <= 4, "replay capped: …pulls stay few: " + c.stats.pulls);
  } finally {
    Object.assign(W.CLIENT, keep);
    await stop(c);
  }
}

async function echoAcrossReload() {
  // (an accepted record whose echo was lost: the next page's client reads from just before its seq, not from 0)
  await account();
  const w = await fresh();
  const c = client(w);
  check(await until(() => settled(w, c)), "echo across a reload: synced");
  await otherOps(1200);
  await ctl("set", { set: { dropPulled: 1 } });
  await w.mkdir("/e");
  check(await until(async () => (await ctl("log")).got.some((g) => g.dropped)), "echo across a reload: the pull's answer lost");
  await stop(c);
  const rec = (await all(w.ws, "outbox"))[0];
  await ctl("log", { reset: true });
  const c2 = client(w);
  check(await until(() => settled(w, c2)), "echo across a reload: confirmed by the next page's client");
  const l = await ctl("log");
  check(rec?.accepted && l.sent[0]?.index_after === rec.accepted - 1 && c2.stats.pages === 1 && c2.stats.pulls === 0, "echo across a reload: hello from just before the record's seq (not 0, not the 1,200 others): " + J({ after: l.sent[0]?.index_after, seq: rec?.accepted }));
  await stop(c2);
}


// ---- astra's CORR-PR58-1 to 3

const signInOnly = (id) => post("/auth/dev", { token: "dev-token", account_id: id });
const hashOf = async (id) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("sagebrush-account\n" + id)))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function accountSwitch() {
  // (CORR-PR58-1: two accounts, both at generation 1; the session switched to B between discovery and the socket,
  // and during a PUT.  The invariant, checked on every message and request the proxy saw: nothing is sent on a
  // socket, or PUT, under one account's session for another account's namespace; A's records stay A's, and go to A
  // once A is signed in again.  (B's own namespace syncing this same local workspace is C1's rule, not a leak.))
  // (3b: each await at its call site is a labelled step in diagnostic mode (plan r2 §2's A-rows); in legacy, S runs
  // the thunk and named() only labels the predicate, so this case runs as before)
  const A = await S("accountSwitch A1: account() A", () => account()), B = await S("accountSwitch A1: account() B", () => account());
  await S("accountSwitch A2: signInOnly(A)", () => signInOnly(A));
  await ctl("reset");
  const w = await fresh();
  const c0 = client(w);
  check(await until(named("accountSwitch A5: settled(w, c0)", () => settled(w, c0))), "account switch: synced as A");
  const nsA = nsOf(c0);
  const from = await S("accountSwitch A6: w.lastSeq()", () => w.lastSeq());
  await stop(c0);
  await S("accountSwitch A8: w.mkdir", () => w.mkdir("/a-only"));
  // (B signs in just before the socket opens: discovery said A, the socket is B's)
  await ctl("set", { set: { switchOnUpgrade: B } });
  const c = client(w);
  const hB = await S("accountSwitch A9: hashOf(B)", () => hashOf(B)), hA = await S("accountSwitch A9: hashOf(A)", () => hashOf(A));
  check(await until(named("accountSwitch A10: ns is B's, synced", () => (nsOf(c) ?? "").startsWith(hB) && c.status.state === "synced"), 15_000), "account switch: the socket opened under B's session is refused (its hello names A), and the client goes on as B: " + J({ ns: (nsOf(c) ?? "").slice(0, 8), state: c.status.state }));
  const l1 = await ctl("log");
  const refusedHello = l1.got.some((g) => g.t === "error" && g.code === "forbidden");
  check(l1.switchedUpgrade === 1 && refusedHello && !l1.bindings.some((b) => b.hello === hA), "account switch: nothing of A's namespace sent on B's socket: " + J(l1.bindings));
  await S("accountSwitch A11: unlost", () => unlost(w, nsA, "/a-only", "account switch"));
  await stop(c);
  // (back to A; then B signs in during one of A's PUTs: refused by its binding)
  await S("accountSwitch A2: signInOnly(A) again", () => signInOnly(A));
  const c2 = client(w);
  check(await until(named("accountSwitch A12: settledIn(w, c2, nsA)", async () => nsOf(c2) === nsA && (await settledIn(w, c2, nsA)))), "account switch: A signed in again: A's namespace resumes and its records are decided");
  await ctl("set", { set: { switchOnPut: B } });
  const f = await S("accountSwitch A8: w.create", () => w.create("/a-file.bin", { content: bytes(2000, 41) }));
  check(await until(named("accountSwitch A13: ctl log, switched", async () => (await ctl("log")).http.some((h) => h.switched))), "account switch: B signed in during A's PUT");
  check(await until(named("accountSwitch A10: ns is B's", () => (nsOf(c2) ?? "").startsWith(hB)), 15_000), "account switch: the PUT refused (A's binding, B's session), and the client goes on as B");
  const put = (await ctl("log")).http.find((h) => h.switched);
  check(put.status === 403 && put.bind === hA && put.session === hB, "account switch: …refused 403, before anything was stored: " + J({ status: put.status }));
  await stop(c2);
  // (explicitly back to A: A's file goes to A)
  await S("accountSwitch A2: signInOnly(A) once more", () => signInOnly(A));
  const c3 = client(w);
  check(await until(named("accountSwitch A12: settledIn(w, c3, nsA)", async () => nsOf(c3) === nsA && (await settledIn(w, c3, nsA))), 15_000), "account switch: back as A, every record of A's decided");
  const { mine: inA } = await S("accountSwitch A14: serverOps", () => serverOps(w));
  check(inA.some((o) => o.path === "/a-only") && inA.some((o) => o.path === "/a-file.bin" && o.sha256 === f.sha256), "account switch: A's log has A's ops: " + J(inA.map((o) => o.path)));
  const l = await ctl("log");
  const opsOk = l.bindings.every((b) => b.session === b.hello);
  const putsOk = l.http.filter((h) => (h.method === "PUT" || h.check !== undefined) && h.status >= 200 && h.status < 300).every((h) => h.bind === h.session);
  check(opsOk && putsOk && l.bindings.length > 0, "account switch: every ops message went on a socket of the account its hello named, every blob request that succeeded under its own account's session: " + J({ ops: l.bindings.map((b) => [b.session?.slice(0, 6), b.hello?.slice(0, 6)]) }));
  await stop(c3);
}

/** As settled(), for one namespace's records only (another namespace's may wait for its own account). */
async function settledIn(w, c, ns) {
  if (c.status.state !== "synced" || nsOf(c) !== ns) return false;
  // (the watermark first, as settled's)
  if (!((await metaGet(w.ws, `sync:${ns}:scanned`)) >= (await w.lastSeq()))) return false;
  return !(await all(w.ws, "outbox")).some((r) => r.ns === ns) && c.debug().inflight === 0;
}

async function restoredCheckTimer() {
  // (CORR-PR58-2: a blobs/check retry_after, persisted; reloads during the wait; the page idle: nothing early,
  // and the file goes when it is due)
  await account();
  const w = await fresh();
  const clock = fakeClock();
  const c1 = client(w, { clock });
  check(await until(() => settled(w, c1)), "check timer: synced");
  await ctl("set", { set: { fakeHttp: [{ method: "POST", path: "/blobs/check", status: 429, body: { error: "rate", retry_after: 30_000 }, times: 1 }] } });
  await w.create("/ct.bin", { content: bytes(500, 51) });
  check(await until(async () => (await ctl("log")).http.some((h) => h.faked)), "check timer: the check refused (30 s)");
  await sleep(200);
  await stop(c1);
  const checks = async () => (await ctl("log")).http.filter((h) => h.check !== undefined).length;
  const clock2 = fakeClock(clock.now() + 5_000);
  const c2 = client(w, { clock: clock2 });
  check(await until(() => c2.debug().writable === true), "check timer: reloaded (5 s in)");
  await sleep(400);
  check((await checks()) === 1, "check timer: idle after the reload, nothing asked early");
  await clock2.advance(10_000);
  await sleep(300);
  await stop(c2);
  const clock3 = fakeClock(clock2.now());
  const c3 = client(w, { clock: clock3 });
  check(await until(() => c3.debug().writable === true), "check timer: reloaded again (15 s in)");
  await sleep(400);
  check((await checks()) === 1, "check timer: …still nothing early");
  await clock3.advance(15_000);
  check(await until(() => settled(w, c3)), "check timer: at its end, with the page idle, the file goes: " + J(c3.status));
  check((await checks()) === 2, "check timer: one check after the wait");
  await stop(c3);
}

async function restoredPause() {
  // (CORR-PR58-2: storage_full with retry_after, persisted; a reload just before it ends: woken at its end, idle)
  await account();
  const w = await fresh();
  const clock = fakeClock();
  const c1 = client(w, { clock });
  check(await until(() => settled(w, c1)), "pause: synced");
  await ctl("set", { set: { fakeHttp: [{ method: "PUT", status: 507, body: { error: "storage_full", retry_after: 30_000 }, times: 1 }] } });
  await w.create("/sp.bin", { content: bytes(500, 61) });
  check(await until(() => c1.status.reason === "storage full"), "pause: storage full (30 s)");
  const paused = await metaGet(w.ws, `sync:${nsOf(c1)}:paused`);
  await stop(c1);
  const puts = async () => (await ctl("log")).http.filter((h) => h.method === "PUT").length;
  const clock2 = fakeClock(paused.until - 1_000);
  const c2 = client(w, { clock: clock2 });
  check(await until(() => c2.debug().writable === true), "pause: reloaded 1 s before it ends");
  await sleep(400);
  check((await puts()) === 1 && (await outbox(w)) === 1, "pause: nothing sent early; the record kept");
  await clock2.advance(1_000);
  check(await until(() => settled(w, c2)), "pause: at its end, with the page idle, the upload and its op go: " + J(c2.status));
  check((await puts()) === 2 && (await metaGet(w.ws, `sync:${nsOf(c2)}:paused`)) === undefined, "pause: one PUT after; the pause cleared durably");
  await stop(c2);
}

async function indexThrottled() {
  // (CORR-PR58-3: a pull refused with retry_after; ops accepted meanwhile pull nothing before it ends; a prolonged
  // timer waits on; then pages in order, every record confirmed)
  await account();
  const w = await fresh();
  const clock = fakeClock();
  const c = client(w, { clock });
  check(await until(() => settled(w, c)), "index throttled: synced");
  await ctl("set", { set: { fakePull: [{ code: "rate", detail: { retry_after: 60_000 } }, { code: "rate", detail: { retry_after: 60_000 } }] } });
  const pulls = async () => (await ctl("log")).sent.filter((m) => m.t === "pull_index").length;
  await w.mkdir("/i0");
  check(await until(async () => (await pulls()) === 1), "index throttled: the first pull refused (60 s)");
  for (let i = 1; i <= 3; i++) await w.mkdir(`/i${i}`);
  check(await until(async () => (await all(w.ws, "outbox")).filter((r) => r.accepted !== undefined).length === 4), "index throttled: four records accepted, awaiting echoes");
  await sleep(400);
  check((await pulls()) === 1, "index throttled: accepted acks pull nothing before the timer ends: " + (await pulls()));
  await clock.advance(60_000);
  check(await until(async () => (await pulls()) === 2), "index throttled: a pull at 60 s (refused again: prolonged)");
  await clock.advance(30_000);
  await sleep(300);
  check((await pulls()) === 2, "index throttled: nothing during the prolonged wait");
  await clock.advance(30_000);
  check(await until(() => settled(w, c)), "index throttled: then pulled, every echo seen, every record confirmed");
  check((await pulls()) === 3 && (await all(w.ws, "outbox")).length === 0, "index throttled: three pulls in all");
  await stop(c);
}


async function corruptConcurrent() {
  // (LIMIT-PR58-2: two values stored longer than their metadata, uploaded side by side: read one at a time; the
  // first found makes the second be read under the largest reservation; at most one is ever held past its cover)
  await account();
  const w = await fresh();
  const c0 = client(w);
  check(await until(() => settled(w, c0)), "corrupt values: synced");
  await stop(c0);
  const big = 4 << 20;
  const f1 = await w.create("/x1.bin", { content: bytes(1000, 71) });
  const f2 = await w.create("/x2.bin", { content: bytes(1000, 72) });
  await new Promise((ok, no) => { const tx = w.ws.transaction("fileBytes", "readwrite"); tx.objectStore("fileBytes").put(bytes(big, 1), f1.fid); tx.objectStore("fileBytes").put(bytes(big, 2), f2.fid); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  await ctl("log", { reset: true });
  const c = client(w);
  check(await until(() => settled(w, c), 15_000), "corrupt values: decided");
  const puts = (await ctl("log")).http.filter((h) => h.method === "PUT").length;
  check(c.stats.mismatches === 2 && puts === 0 && c.stats.maxReadsAtOnce === 1 && c.stats.wideReads === 1, "corrupt values: both found, neither sent; read one at a time; the second under the largest reservation: " + J({ mismatches: c.stats.mismatches, reads: c.stats.maxReadsAtOnce, wide: c.stats.wideReads, puts }));
  check(W.reserved().held === 0, "corrupt values: every reservation released");
  check((await metaGet(w.ws, "sync:bytes-reading")) === undefined, "corrupt values: no read-in-progress mark left");
  await stop(c);
}

async function manyMismatches() {
  // (LIMIT-PR58-2: more records with mismatched bytes than any FIFO would keep, all undecided across a resend: each
  // read once, by its own durable mark)
  await account();
  const w = await fresh();
  const c0 = client(w);
  check(await until(() => settled(w, c0)), "many mismatches: synced");
  await stop(c0);
  const n = 1100;
  const fids = [];
  // (each its own bytes: uploads are by hash, so equal bytes would be read once for all)
  const own = (i, len) => new TextEncoder().encode(`mm-${i}-`.padEnd(len, "x"));
  for (let i = 0; i < n; i++) fids.push((await w.create(`/mm/${i}.bin`, { content: own(i, 64) })).fid);
  await new Promise((ok, no) => { const tx = w.ws.transaction("fileBytes", "readwrite"); const st = tx.objectStore("fileBytes"); fids.forEach((f, i) => st.put(own(i, 80), f)); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  await ctl("log", { reset: true });
  // (the first ack lost and the socket closed: every record is sent again on the next connection)
  await ctl("set", { set: { dropAcks: 1, closeAfterDrop: true, dropIndex: 1 } });
  const c = client(w);
  check(await until(() => settled(w, c), 120_000), "many mismatches: all decided " + J(c.status));
  const marks = (await keys(w.ws, "meta")).filter((k) => typeof k === "string" && k.startsWith(`sync:${nsOf(c)}:mismatch:`)).length;
  check(c.stats.mismatches === n && c.stats.connects === 2, "many mismatches: each of 1,100 read once, though they went twice: " + J({ mismatches: c.stats.mismatches, connects: c.stats.connects }));
  check(marks <= n, "many mismatches: at most one mark a record (decided ones pruned as new ones come): " + marks);
  await stop(c);
}


async function lateAnswer() {
  // (astra's narrowed CORR-PR58-1: A's PUT answered late, storage_full with no end, after the client has gone on
  // as B: it pauses nothing, sets no timer or status of B's; B uploads as usual)
  const A = await account(), B = await account();
  await signInOnly(A);
  await ctl("reset");
  const w = await fresh();
  const c = client(w);
  check(await until(() => settled(w, c)), "late answer: synced as A");
  const nsA = nsOf(c), hB = await hashOf(B);
  await ctl("set", { set: { delayFakePut: { ms: 4000, status: 507, body: { error: "storage_full", message: "faked, late" } } } });
  await w.create("/late.bin", { content: bytes(700, 81) });
  check(await until(async () => (await ctl("log")).http.some((h) => h.method === "PUT")), "late answer: A's PUT on its way");
  await signInOnly(B);
  await ctl("closeAll");
  check(await until(() => (nsOf(c) ?? "").startsWith(hB) && c.status.state === "synced", 15_000), "late answer: the client went on as B");
  await sleep(4500);
  check(c.debug().paused === null && c.status.state === "synced" && (await metaGet(w.ws, `sync:${nsA}:paused`)) === undefined && (await metaGet(w.ws, `sync:${nsOf(c)}:paused`)) === undefined, "late answer: A's late storage_full paused nothing, of B's or of A's namespace: " + J({ paused: c.debug().paused, status: c.status.state }));
  await w.create("/b-file.bin", { content: bytes(900, 82) });
  check(await until(async () => (await settledIn(w, c, nsOf(c))) && (await ctl("log")).http.some((h) => h.method === "PUT" && (h.status === 201 || h.status === 200))), "late answer: B uploads and syncs as usual");
  await stop(c);
}


async function cutRead() {
  // (daybreak3's third round on LIMIT-PR58-2: a narrow read cut short (the page killed while it held the value)
  // leaves its mark; the next start takes the bytes as untrusted and reads wide; a read that ends clears its mark
  // in the transaction that read)
  await account();
  const w = await fresh();
  const c0 = client(w);
  check(await until(() => settled(w, c0)), "cut read: synced");
  await w.create("/ok.bin", { content: bytes(300, 91) });
  check(await until(() => settled(w, c0)), "cut read: an upload as usual");
  check((await metaGet(w.ws, "sync:bytes-reading")) === undefined && (await metaGet(w.ws, "sync:bytes-untrusted")) === undefined && c0.stats.wideReads === 0, "cut read: its read-in-progress mark cleared by the read's own transaction; bytes trusted");
  await stop(c0);
  // (the crash gate: bytes stored longer than their metadata, and the read's transaction cut right after the value
  // is read, before it marks or commits anything, as a page killed there would be)
  const f = await w.create("/after-cut.bin", { content: bytes(300, 92) });
  await new Promise((ok, no) => { const tx = w.ws.transaction("fileBytes", "readwrite"); tx.objectStore("fileBytes").put(bytes(3000, 93), f.fid); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  let cuts = 0;
  // (only this file's read: a client of an earlier case still finishing a read never takes the cut)
  W.PINS.cutAfterRead = (rec) => { if (rec.id !== f.fid) return; cuts++; W.PINS.cutAfterRead = null; throw new Error("cut (test)"); };
  const c = client(w);
  check(await until(() => cuts === 1), "cut read: the read cut after its value was materialized");
  await sleep(300);
  const reading = await metaGet(w.ws, "sync:bytes-reading");
  check(reading?.dseq !== undefined && (await metaGet(w.ws, `sync:${nsOf(c)}:mismatch:${String(reading?.dseq).padStart(16, "0")}`)) === undefined, "cut read: …its transaction aborted whole: nothing marked but the read-in-progress mark made before it: " + J(reading));
  await stop(c);
  // (the next page: the cut read's mark taken as untrusted bytes, durably, before any read)
  const c2 = client(w);
  check(await until(() => settled(w, c2), 15_000), "cut read: the next start decides it");
  check((await metaGet(w.ws, "sync:bytes-untrusted")) !== undefined && (await metaGet(w.ws, "sync:bytes-reading")) === undefined && c2.stats.wideReads >= 1 && c2.stats.mismatches === 1, "cut read: …the bytes untrusted, durably, and the value read again only under the largest reservation: " + J({ wide: c2.stats.wideReads, mismatches: c2.stats.mismatches }));
  await stop(c2);
}


async function restUnderAcks() {
  // (astra's narrowed CORR-PR58-4: acks keep coming during a replay's rest; the rest still ends when it first said)
  await account();
  const w = await fresh();
  const keep = { ...W.CLIENT };
  Object.assign(W.CLIENT, { replayPages: 1, replayRestMs: 60_000 });
  const clock = fakeClock();
  const c = client(w, { clock });
  try {
    check(await until(() => settled(w, c)), "rest under acks: synced");
    await otherOps(1800);
    await w.mkdir("/far");
    check(await until(async () => (await all(w.ws, "outbox")).some((r) => r.accepted !== undefined) && c.debug().wakes >= 1), "rest under acks: /far accepted, its echo past the slice: a rest");
    const t0 = clock.now();
    // (an edit, so an ack, every 10 s through the rest)
    for (let k = 1; k <= 5; k++) {
      await clock.advance(10_000);
      await w.mkdir(`/during${k}`);
      await until(async () => (await all(w.ws, "outbox")).filter((r) => r.accepted !== undefined).length === k + 1);
    }
    await sleep(300);
    check(c.stats.pulls === 0, "rest under acks: five acks during the rest pull nothing: " + c.stats.pulls);
    await clock.advance(t0 + 60_000 - clock.now());
    check(await until(() => c.stats.pulls === 1), "rest under acks: the slice resumes at the first rest's end (60 s), not pushed back: " + J({ pulls: c.stats.pulls, at: clock.now() - t0 }));
    // (then another rest (1 page a slice), and on to the echoes)
    await clock.advance(60_000);
    check(await until(() => c.stats.pulls === 2), "rest under acks: the next slice a rest later");
    for (let i = 0; i < 3 && !(await settled(w, c)); i++) await clock.advance(60_000);
    check(await until(() => settled(w, c)), "rest under acks: every echo seen, every record confirmed, on one connection: " + J({ pulls: c.stats.pulls, connects: c.stats.connects }));
    check(c.stats.connects === 1, "rest under acks: no restart");
  } finally {
    Object.assign(W.CLIENT, keep);
    await stop(c);
  }
}


// ---- step 4

async function refusalAtomic() {
  // (D7: a refusal removes its record and records the rebuild's obligation in one transaction: cut at each of
  // acked's points, a reload finds the record still undecided and no flag, or neither record nor missing flag)
  const w = await fresh();
  const NS = "c".repeat(64) + ":1:" + w.device;
  let points = 0, ok = true;
  for (let at = 100; at < 110; at++) {
    const lease = await W.switchTo(w, NS), ob = new W.Outbox(w, lease);
    if ((await ob.status()).scanned === undefined) await ob.begin(await w.lastSeq());
    await w.mkdir(`/r${at}`);
    await ob.scan();
    const rec = (await ob.records()).find((r) => r.accepted === undefined);
    await new Promise((res, no) => { const tx = w.ws.transaction("meta", "readwrite"); tx.objectStore("meta").delete(`sync:${NS}:rebuild`); tx.oncomplete = res; tx.onerror = () => no(tx.error); });
    let cut = false;
    W.OUTBOX.cut = (n) => { if (n === at) { cut = true; throw new Error("cut (test)"); } };
    try { await ob.acked([{ dseq: rec.dseq, code: "forbidden" }]); } catch {}
    W.OUTBOX.cut = null;
    const still = (await ob.records()).some((r) => r.dseq === rec.dseq);
    const flag = await metaGet(w.ws, `sync:${NS}:rebuild`);
    if (cut) points++;
    // (cut: nothing of it, the record kept, no flag; not cut (past the last point): both)
    if (cut ? !(still && flag === undefined) : !(!still && flag?.why === "refused")) ok = false;
    if (!cut) {
      // (once more without a cut: removed and flagged together; and the flag isn't lowered from a stronger reason)
      await new Promise((res, no) => { const tx = w.ws.transaction("meta", "readwrite"); tx.objectStore("meta").put({ why: "diverged" }, `sync:${NS}:rebuild`); tx.oncomplete = res; tx.onerror = () => no(tx.error); });
      await w.mkdir(`/r-strong`);
      await ob.scan();
      const r2 = (await ob.records()).find((r) => r.accepted === undefined);
      await ob.acked([{ dseq: r2.dseq, code: "forbidden" }]);
      if ((await metaGet(w.ws, `sync:${NS}:rebuild`))?.why !== "diverged") ok = false;
      break;
    }
  }
  check(ok && points >= 2, "refusal atomic (D7): cut at each of acked's " + points + " points, the record stays undecided with no flag; past them, it is removed and the rebuild flagged in one transaction; a stronger reason is kept");
}

// ---- step 4: the confirmed index and its view, live notices (D8), idle discovery (D8b)

/** A client with the confirmed index (step 4's onIndex). */
const viewClient = (w, opts = {}) => client(w, { onIndex: W.confirmedIndex(w), ...opts });

async function echoNoCopy() {
  // (C3's first test: a local create, then its echo: confirmed, applied to the index, and no `x (2)`)
  await account();
  const w = await fresh();
  const c = viewClient(w);
  try {
    check(await until(() => settled(w, c)), "echo, no copy: synced");
    const f = await w.create("/x.txt", { content: "x" });
    check(await until(async () => (await settled(w, c)) && (await W.cursorOf(w, nsOf(c))) > 0), "echo, no copy: decided, and the durable cursor past its echo");
    const list = await w.list("/");
    check(list.filter((e) => e.path.startsWith("/x")).length === 1 && (await w.stat("/x.txt"))?.fid === f.fid, "echo, no copy: one /x.txt, the same file: " + J(list.map((e) => e.path)));
    const conf = await W.confirmedEntry(w, nsOf(c), f.fid);
    check(conf?.path === "/x.txt" && conf.sha256 === f.sha256, "echo, no copy: in the confirmed index: " + J(conf));
    check((await w.ops()).filter((o) => o.origin === "server").length === 0, "echo, no copy: nothing logged from the server (the view had it already)");
  } finally {
    await stop(c);
  }
}

async function liveNotice() {
  // (D8, plan-sync-index-changed r1 test 7, the notice injected by the front: another device's create appears within
  // 1 s, with no reconnect and no edit here; without a notice, nothing is pulled)
  await account();
  const w = await fresh();
  const c = viewClient(w);
  try {
    check(await until(() => settled(w, c)), "live notice: synced");
    const pulls = c.stats.pulls;
    const r = await ctl("probe", { ops: [{ dseq: 1, t: Date.now(), by: "person", op: "mkdir", path: "/theirs", kind: "folder", fid: "00000000000000a1" }] });
    const head = r.ack.ops[0].seq;
    await sleep(500);
    check(!(await w.stat("/theirs")) && c.stats.pulls === pulls, "live notice: no notice, nothing pulled yet");
    const t0 = Date.now();
    await ctl("notice", { head });
    check(await until(async () => (await w.stat("/theirs"))?.fid === "00000000000000a1", 1_000), "live notice: the other device's folder here within 1 s: " + (Date.now() - t0) + " ms");
    check(c.stats.connects === 1 && c.stats.pulls === pulls + 1, "live notice: by one pull, on the same connection: " + J({ pulls: c.stats.pulls, connects: c.stats.connects }));
    // (a notice that isn't a safe integer, or isn't past the cursor: nothing)
    await ctl("notice", { head: "9" });
    await ctl("notice", { head });
    await sleep(300);
    check(c.stats.pulls === pulls + 1, "live notice: a malformed or old head moves nothing");
  } finally {
    await stop(c);
  }
}

async function noticeFlood() {
  // (plan-sync-index-changed r1 test 8: 1,000 notices in a second pull only at the bucket's pace, never two at once)
  await account();
  const w = await fresh();
  const keep = { ...W.CLIENT };
  Object.assign(W.CLIENT, { pullBurst: 1, pullsPerSecond: 0.1 });
  const clock = fakeClock();
  const c = viewClient(w, { clock });
  try {
    check(await until(() => settled(w, c)), "notice flood: synced");
    await otherOps(5, 0, "f");
    const head = (await serverOps(w)).all.at(-1).seq;
    const pulls = c.stats.pulls;
    await ctl("notice", { head, times: 1000 });
    await sleep(800);
    check(c.stats.pulls - pulls <= 1 && c.debug().inflight <= 1, "notice flood: at most one pull for 1,000 notices (a token each 10 s): " + J({ pulls: c.stats.pulls - pulls, inflight: c.debug().inflight }));
    check(await until(async () => !!(await w.stat("/f4"))), "notice flood: …and that pull brings the ops");
  } finally {
    Object.assign(W.CLIENT, keep);
    await stop(c);
  }
}

async function idleDiscovery() {
  // (D8b r2: the only notice dropped; the ops arrive at the 5-minute idle pull, every page of a log longer than one
  // page, with no edit and no reconnect, and no pull before it)
  await account();
  const w = await fresh();
  const clock = fakeClock();
  const c = viewClient(w, { clock });
  try {
    check(await until(() => settled(w, c)), "idle discovery: synced");
    await otherOps(1500, 0, "i");
    const pulls = c.stats.pulls;
    await clock.advance(W.CLIENT.idlePullMs - 1000);
    await sleep(300);
    check(c.stats.pulls === pulls && !(await w.stat("/i0")), "idle discovery: nothing pulled before the 5 minutes: " + (c.stats.pulls - pulls));
    await clock.advance(1000);
    check(await until(async () => !!(await w.stat("/i1499")), 20_000), "idle discovery: at 5 minutes, every op of a two-page log here");
    check(c.stats.pulls - pulls === 2 && c.stats.connects === 1, "idle discovery: two pulls (two pages), the same connection: " + J({ pulls: c.stats.pulls - pulls, connects: c.stats.connects }));
    const listed = (await w.list("/")).filter((e) => /^\/i\d+$/.test(e.path)).length;
    check(listed === 1500, "idle discovery: all 1,500 folders listed: " + listed);
    await sleep(300);
    check(c.stats.pulls - pulls === 2, "idle discovery: …then idle again (no further pull until the next 5 minutes)");
  } finally {
    await stop(c);
  }
}

// ---- step 4: downloads (C5, L1, L2, D9)

/** Two devices of one account in this page, each with its own workspace and the confirmed index. */
async function twoDevices(optsB = {}) {
  await account();
  const a = await fresh(), b = await fresh();
  const ca = viewClient(a), cb = viewClient(b, optsB);
  if (!(await until(() => settled(a, ca))) || !(await until(() => settled(b, cb)))) throw new Error("two devices: not synced");
  return { a, b, ca, cb };
}
const sameBytes = (x, y) => x && y && x.length === y.length && x.every((v, i) => v === y[i]);
/** B's entry for A's file `p` listed (remote), via a notice (no waiting for the idle pull). */
async function seen(b, cb, p) {
  for (let i = 0; i < 50 && !(await b.stat(p)); i++) {
    const head = (await serverOps(b)).all.at(-1)?.seq ?? 0;
    await ctl("notice", { head });
    await sleep(100);
  }
  return b.stat(p);
}

async function downloadBasic() {
  const { a, b, ca, cb } = await twoDevices();
  try {
    const data = bytes(70_000, 7);
    await a.create("/doc.bin", { content: data });
    check(await until(() => settled(a, ca)), "download: A's file up");
    const e = await seen(b, cb, "/doc.bin");
    check(e?.size === 70_000 && e.sha256 === (await a.stat("/doc.bin")).sha256, "download: B lists it (remote until fetched): " + J(e && { remote: e.remote, size: e.size }));
    check(await until(async () => { const x = await b.stat("/doc.bin"); return x && !x.remote; }), "download: …then has its bytes (installed)");
    check(sameBytes(await b.contents(await b.stat("/doc.bin")), data), "download: the same bytes as A's");
    check(cb.stats.urls === 1 && cb.stats.installed === 1, "download: one URL asked for, one install: " + J({ urls: cb.stats.urls, installed: cb.stats.installed }));
    check((await b.stat("/doc.bin")).fetch === undefined, "download: no longer queued (its fetch cleared)");
    // (then A writes it again: B's copy follows)
    const data2 = bytes(5_000, 9);
    await a.write("/doc.bin", data2);
    check(await until(() => settled(a, ca)), "download: A's write up");
    for (let i = 0; i < 50; i++) { const x = await b.stat("/doc.bin"); if (x && x.sha256 !== e.sha256 && !x.remote) break; await ctl("notice", { head: (await serverOps(b)).all.at(-1).seq }); await sleep(100); }
    check(sameBytes(await b.contents(await b.stat("/doc.bin")), data2), "download: a remote write's bytes installed in turn");
  } finally {
    await stop(ca);
    await stop(cb);
  }
}

async function downloadChecks() {
  // (D9: Content-Length missing, malformed, different; a body longer than declared; a size past the cap: each fails
  // its item under the retry timer and is never installed; then the real answer installs)
  let mode = null;
  const real = window.fetch.bind(window);
  const fakeFetch = async (url, init) => {
    const r = await real(url, init);
    const m = mode;
    if (!m || !r.ok || !String(r.url).includes("/__files/")) return r;
    mode = null;
    const body = new Uint8Array(await r.arrayBuffer());
    const headers = { "content-type": "application/octet-stream" };
    // (a made Response keeps the real one's url and redirected, as the browser's own would)
    const as = (x) => Object.defineProperties(x, { url: { value: r.url }, redirected: { value: r.redirected } });
    if (m === "missing") return as(new Response(body, { headers }));
    if (m === "malformed") return as(new Response(body, { headers: { ...headers, "content-length": "0" + body.length } }));
    if (m === "different") return as(new Response(body, { headers: { ...headers, "content-length": String(body.length + 1) } }));
    if (m === "longer") { const more = new Uint8Array(body.length + 1); more.set(body); return as(new Response(more, { headers: { ...headers, "content-length": String(body.length) } })); }
    return r;
  };
  // (the clock from now: a signed URL's expiry is the server's wall clock, 5 minutes on)
  const clock = fakeClock(Date.now());
  const { a, b, ca, cb } = await twoDevices({ fetch: fakeFetch, clock });
  try {
    for (const m of ["missing", "malformed", "different", "longer"]) {
      mode = m;
      const p = `/c-${m}.bin`;
      await a.create(p, { content: bytes(3000, m.length) });
      check(await until(() => settled(a, ca)), `download checks (${m}): up`);
      const failed = cb.stats.fetchFailed;
      await seen(b, cb, p);
      check(await until(() => cb.stats.fetchFailed === failed + 1), `download checks (${m}): the item failed: ` + cb.stats.fetchFailed);
      check((await b.stat(p))?.remote === true && cb.stats.installed === 0 + (["missing", "malformed", "different", "longer"].indexOf(m)), `download checks (${m}): not installed`);
      await clock.advance(70_000);
      check(await until(async () => (await b.stat(p))?.remote === undefined), `download checks (${m}): the retry, after its timer, installs the real bytes`);
    }
    check(cb.stats.urls === 4, "download checks: each item's signed URL asked for once, reused for its retry: " + cb.stats.urls);
    // (a size past the cap: never reserved or asked for; set apart, listed)
    const ns = nsOf(cb);
    const big = { fid: "00000000000000b1", sha256: "e".repeat(64), size: 95 * 2 ** 20 + 1, rev: 0 };
    await new Promise((res, no) => { const tx = b.ws.transaction("entries", "readwrite"); tx.objectStore("entries").put({ path: "/big.bin", kind: "file", ref: "/big.bin", created: 1, updated: 1, size: big.size, rev: 0, fid: big.fid, ident: big.fid, migrated: true, sha256: big.sha256, fetch: big.sha256, remote: true, nkey: "/\u0000big.bin" }); tx.oncomplete = res; tx.onerror = () => no(tx.error); });
    const urls = cb.stats.urls;
    await ctl("notice", { head: (await serverOps(b)).all.at(-1).seq + 1 });
    check(await until(async () => (await metaGet(b.ws, `sync:${ns}:fetchFinal:${big.fid}`))?.why === "too large to sync" && (await b.stat("/big.bin")).fetch === undefined && (await b.stat("/big.bin")).remote), "download checks: a size past 95 MiB set apart, too large to sync (listed, still remote)");
    check(cb.stats.urls === urls, "download checks: …with no URL asked for");
  } finally {
    await stop(ca);
    await stop(cb);
  }
}

async function downloadStale() {
  // (C5, a GET held open: a local overwrite meanwhile: the fetched bytes are discarded, the local ones kept; a rename
  // meanwhile: installed at the new path)
  const { a, b, ca, cb } = await twoDevices();
  try {
    await ctl("set", { set: { holdGet: true } });
    await a.create("/s.bin", { content: bytes(2000, 1) });
    await a.create("/r.bin", { content: bytes(2000, 2) });
    check(await until(() => settled(a, ca)), "download stale: up");
    await seen(b, cb, "/r.bin");
    check(await until(async () => (await ctl("log")).http.filter((h) => h.files).length >= 1), "download stale: a GET held");
    const mine = bytes(10, 3);
    await b.write("/s.bin", mine);
    await b.rename("/r.bin", "/r2.bin");
    await ctl("set", { set: { holdGet: false } });
    await ctl("release");
    check(await until(async () => cb.stats.installed + cb.stats.stale >= 2, 10_000), "download stale: both fetches answered: " + J({ installed: cb.stats.installed, stale: cb.stats.stale }));
    check(sameBytes(await b.contents(await b.stat("/s.bin")), mine) && !(await b.stat("/s.bin")).remote, "download stale: the local overwrite kept; the download discarded");
    check(cb.stats.stale === 1 && sameBytes(await b.contents(await b.stat("/r2.bin")), bytes(2000, 2)), "download stale: the renamed one installed at its new path");
  } finally {
    await ctl("set", { set: { holdGet: false } });
    await ctl("release");
    await stop(ca);
    await stop(cb);
  }
}

async function downloadBudget() {
  // (L1: a 429 on asking for a URL pauses the whole queue, durably, until retry_after; nothing asked meanwhile)
  const clock = fakeClock();
  const keep = { ...W.CLIENT };
  // (one lane: the 429 is the first URL asked for, nothing else in flight beside it)
  W.CLIENT.downloadsAtOnce = 1;
  const { a, b, ca, cb } = await twoDevices({ clock });
  try {
    await ctl("set", { set: { fakeHttp: [{ method: "GET", path: "/api/sync/v1/blob/", status: 429, body: { error: "rate", retry_after: 600_000 }, times: 1 }] } });
    await a.create("/q1.bin", { content: bytes(1000, 1) });
    await a.create("/q2.bin", { content: bytes(1000, 2) });
    check(await until(() => settled(a, ca)), "download budget: up");
    await seen(b, cb, "/q2.bin");
    const ns = nsOf(cb);
    check(await until(async () => (await metaGet(b.ws, `sync:${ns}:fetchPause`))?.until > clock.now()), "download budget: the queue paused, durably");
    const asked = cb.stats.urls;
    await clock.advance(300_000);
    await sleep(300);
    check(cb.stats.urls === asked && (await b.stat("/q1.bin")).remote && (await b.stat("/q2.bin")).remote, "download budget: nothing asked during the pause: " + J({ asked, urls: cb.stats.urls, installed: cb.stats.installed }));
    await clock.advance(300_001);
    check(await until(async () => !(await b.stat("/q1.bin")).remote && !(await b.stat("/q2.bin")).remote), "download budget: resumed at its end; both installed: " + J({ urls: cb.stats.urls, installed: cb.stats.installed, failed: cb.stats.fetchFailed, debug: cb.debug() }));
  } finally {
    Object.assign(W.CLIENT, keep);
    await stop(ca);
    await stop(cb);
  }
}

async function downloadStale2() {
  // (C5, the rest, each with the GET held open: a newer remote write (the older fetch discarded, the newer one
  // installed); Trash (installed into the trashed entry); a remove and a new file at the same path (the new one's
  // bytes its own, the removed one's installed in Trash))
  const { a, b, ca, cb } = await twoDevices();
  try {
    await ctl("set", { set: { holdGet: true } });
    await a.create("/n.bin", { content: bytes(1500, 1) });
    await a.create("/t.bin", { content: bytes(1500, 2) });
    await a.create("/p.bin", { content: bytes(1500, 3) });
    check(await until(() => settled(a, ca)), "download stale 2: up");
    await seen(b, cb, "/p.bin");
    check(await until(async () => (await ctl("log")).http.filter((h) => h.files).length >= 1), "download stale 2: a GET held");
    const newest = bytes(1600, 4);
    await a.write("/n.bin", newest);
    check(await until(() => settled(a, ca)), "download stale 2: A's newer write up");
    for (let i = 0; i < 30 && (await b.stat("/n.bin")).sha256 !== (await a.stat("/n.bin")).sha256; i++) { await ctl("notice", { head: (await serverOps(b)).all.at(-1).seq }); await sleep(100); }
    const tb = await b.remove("/t.bin");
    const pOld = await b.stat("/p.bin");
    const pTrash = await b.remove("/p.bin");
    const pNew = await b.create("/p.bin", { content: bytes(10, 5) });
    await ctl("set", { set: { holdGet: false } });
    await ctl("release");
    check(await until(async () => !(await b.stat("/n.bin")).remote && !(await b.stat(tb.path))?.remote && !(await b.stat(pTrash.path))?.remote, 20_000), "download stale 2: every fetch answered: " + J({ installed: cb.stats.installed, stale: cb.stats.stale }));
    check(sameBytes(await b.contents(await b.stat("/n.bin")), newest), "download stale 2: a newer remote write meanwhile: the newer bytes installed, never the older");
    check(sameBytes(await b.contents(await b.stat(tb.path)), bytes(1500, 2)) && (await b.stat(tb.path)).trashed, "download stale 2: put in Trash meanwhile: installed there");
    check(sameBytes(await b.contents(await b.stat("/p.bin")), bytes(10, 5)) && (await b.stat("/p.bin")).fid === pNew.fid, "download stale 2: a new file at the removed one's path keeps its own bytes");
    check((await b.stat(pTrash.path))?.fid === pOld.fid && sameBytes(await b.contents(await b.stat(pTrash.path)), bytes(1500, 3)), "download stale 2: the removed one's bytes installed in Trash, by its identity");
  } finally {
    await ctl("set", { set: { holdGet: false } });
    await ctl("release");
    await stop(ca);
    await stop(cb);
  }
}

// ---- step 4: the rebuild (D6, D7 r2; plan-sync-rebuilt r3 tests 14-19)

/** The live state a failed pass must leave exactly as it was (D6 r4): entries, outbox, pins, pending, and the
 * namespace's cursor, watermark, active generation, next dseq and outbox totals. */
async function liveState(w, ns) {
  const meta = {};
  for (const k of ["cursor", "scanned", "indexGen", "dseq", "outbox", "journal"]) meta[k] = await metaGet(w.ws, `sync:${ns}:${k}`);
  return J({ entries: await all(w.ws, "entries"), outbox: await all(w.ws, "outbox"), pins: await all(w.ws, "pins"), pending: await all(w.ws, "pending"), meta });
}
/** The prefixes of syncIndex's generations present (at most two, D6 r3). */
async function generations(w) {
  return [...new Set((await keys(w.ws, "syncIndex")).map((k) => k[0]))];
}

async function rebuildAfterRefusal() {
  // (test 14's shape, on a per-op refusal: the rebuild runs before anything else is sent, announces through =
  // server_next - 1, and resumes; later ops are accepted)
  await account();
  const w = await fresh();
  const c0 = viewClient(w);
  check(await until(() => settled(w, c0)), "rebuild: synced");
  await stop(c0);
  const f = await w.create("/gone.txt", { content: "bytes gone" });
  await new Promise((ok, no) => { const tx = w.ws.transaction("fileBytes", "readwrite"); tx.objectStore("fileBytes").delete(f.fid); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  await ctl("log", { reset: true });
  const c = viewClient(w);
  try {
    check(await until(() => c.stats.rebuildPasses >= 1 && !c.debug().halted && c.status.state === "synced", 20_000), "rebuild: refused, rebuilt and resumed: " + J({ passes: c.stats.rebuildPasses, phase: c.stats.rebuildPhase, status: c.status }));
    const ns = nsOf(c);
    const lg = await ctl("log");
    const welcome = lg.got.find((m) => m.t === "welcome");
    check(lg.rebuilt.length === 1 && lg.rebuilt[0].through >= 1, "rebuild: one announce, through = server_next - 1: " + J(lg.rebuilt));
    check(!(await metaGet(w.ws, `sync:${ns}:rebuild`)) && !(await metaGet(w.ws, `sync:${ns}:pass`)), "rebuild: the flag and the pass cleared");
    check((await metaGet(w.ws, `sync:${ns}:floor`)) === lg.rebuilt[0].through, "rebuild: the acknowledged floor recorded");
    check((await generations(w)).length <= 2 && (await metaGet(w.ws, `sync:${ns}:indexGen`)) >= 1, "rebuild: the new generation active, at most two present: " + J(await generations(w)));
    check(!!(await w.stat("/gone.txt")), "rebuild: the refused file kept here");
    await w.mkdir("/later");
    check(await until(async () => (await settled(w, c)) && (await serverOps(w)).mine.some((o) => o.path === "/later")), "rebuild: sending resumed, a later op accepted");
    void welcome;
  } finally {
    await stop(c);
  }
}

async function rebuildRate() {
  // (test 15: `rate` on rebuilt: halted and said; retried at retry_after; no op sent meanwhile)
  await account();
  const w = await fresh();
  const c0 = viewClient(w);
  check(await until(() => settled(w, c0)), "rebuild rate: synced");
  const ns = nsOf(c0);
  await stop(c0);
  await w.mkdir("/r1");
  await new Promise((ok, no) => { const tx = w.ws.transaction("meta", "readwrite"); W.obligate(tx.objectStore("meta"), ns, "refused").then(() => {}, no); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  await ctl("set", { set: { rebuilt: [{ code: "rate", detail: { message: "slow down", retry_after: 1500 } }] } });
  await ctl("log", { reset: true });
  const c = viewClient(w);
  try {
    check(await until(() => (c.status.reason ?? "").includes("wait")), "rebuild rate: halted, the foot says why: " + J(c.status));
    check(opsMessages(await ctl("log")).length === 0, "rebuild rate: no op sent while halted");
    check(await until(async () => (await ctl("log")).rebuilt.length === 2 && (await settled(w, c)), 15_000), "rebuild rate: retried after retry_after, acked, resumed: " + J((await ctl("log")).rebuilt));
  } finally {
    await stop(c);
  }
}

async function rebuildCrashAfterAnnounce() {
  // (test 16: a crash after announce is recorded, before the ack: the next start sends rebuilt again and converges)
  await account();
  const w = await fresh();
  const c0 = viewClient(w);
  check(await until(() => settled(w, c0)), "rebuild crash: synced");
  const ns = nsOf(c0);
  await stop(c0);
  await new Promise((ok, no) => { const tx = w.ws.transaction("meta", "readwrite"); W.obligate(tx.objectStore("meta"), ns, "refused").then(() => {}, no); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  await ctl("set", { set: { rebuilt: [{ hold: true }] } });
  await ctl("log", { reset: true });
  const c1 = viewClient(w);
  check(await until(async () => (await ctl("log")).rebuilt.length === 1), "rebuild crash: announced, the ack held");
  const pass = await metaGet(w.ws, `sync:${ns}:pass`);
  check(pass?.phase === "announce" && pass.through === (await ctl("log")).rebuilt[0].through, "rebuild crash: announce recorded with its through before it was sent: " + J(pass && { phase: pass.phase, through: pass.through }));
  await stop(c1);
  const t2 = Date.now();
  const c2 = viewClient(w);
  try {
    check(await until(async () => (await ctl("log")).rebuilt.length >= 2 && (await settled(w, c2)), 15_000), "rebuild crash: the next start sends rebuilt again, with the same through, and converges: " + J((await ctl("log")).rebuilt.map((r) => r.through)));
    // (exactly one more, from the next start, and none after it (r4: no second send while its answer is recorded))
    await sleep(500);
    const r = (await ctl("log")).rebuilt;
    check(r.length === 2 && r[1].at >= t2 && r[0].through === r[1].through, "rebuild crash: …exactly one send after the restart, with the same through " + J(r.map((x) => ({ through: x.through, afterRestart: x.at - t2 }))));
  } finally {
    await ctl("release");
    await stop(c2);
  }
}

/** An obligation to rebuild, recorded (as a refusal records it), and the log reset: a client started next rebuilds. */
async function rebuildReady(what) {
  await account();
  const w = await fresh();
  const c0 = viewClient(w);
  check(await until(() => settled(w, c0)), `${what}: synced`);
  const ns = nsOf(c0);
  await stop(c0);
  await new Promise((ok, no) => { const tx = w.ws.transaction("meta", "readwrite"); W.obligate(tx.objectStore("meta"), ns, "refused").then(() => {}, no); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  await ctl("log", { reset: true });
  return w;
}

async function rebuildAckWindow() {
  // (r4: the driver run again (twice) while the announce's answer is being recorded, as a page or a wake can: it finds
  // the announce still pending and sends nothing; one `rebuilt`, and the pass converges)
  const w = await rebuildReady("rebuild ack window");
  let ran = 0;
  W.REBUILD.before = async (phase, _ns, again) => { if (phase === "rebuilt-ack" && again && !ran++) { again(); again(); await sleep(200); } };
  const c = viewClient(w);
  try {
    check(await until(async () => (await ctl("log")).rebuilt.length >= 1 && (await settled(w, c)), 15_000), "rebuild ack window: announced and converged");
    await sleep(500);
    const r = (await ctl("log")).rebuilt;
    check(ran === 1 && r.length === 1 && c.debug().inflight === 0, `rebuild ack window: the driver run twice inside the answer, one rebuilt sent, nothing left pending (${J({ ran, sent: r.length, inflight: c.debug().inflight })})`);
  } finally {
    W.REBUILD.before = null;
    await stop(c);
  }
}

async function rebuildAckThrows() {
  // (r4, no wedge: recording the answer throws; the pending announce is cleared all the same, the connection ends, and
  // the next connection announces again and converges)
  const w = await rebuildReady("rebuild ack throws");
  let thrown = 0;
  W.REBUILD.before = async (phase) => { if (phase === "rebuilt-ack" && !thrown++) throw new Error("recording the answer fails (test)"); };
  const c = viewClient(w);
  try {
    check(await until(async () => (await ctl("log")).rebuilt.length >= 2 && (await settled(w, c)), 20_000), `rebuild ack throws: announced again on the next connection and converged (${J({ thrown, sent: (await ctl("log")).rebuilt.length, connects: c.stats.connects })})`);
    await sleep(500);
    const r = (await ctl("log")).rebuilt;
    check(thrown >= 1 && r.length === 2 && r[0].through === r[1].through && c.stats.connects >= 2 && c.debug().inflight === 0, `rebuild ack throws: two sends (one a connection), the same through, nothing left pending (${J({ thrown, sent: r.length, connects: c.stats.connects, inflight: c.debug().inflight })})`);
  } finally {
    W.REBUILD.before = null;
    await stop(c);
  }
}

async function rebuildExclusive() {
  // (r5, CORR-D11-R4-1: nothing else is sent on the connection while the announce's answer is held: an index_changed
  // notice, the idle wake (the pulls) and a local change (ops) wait; once it is answered, the waiting pull runs, once)
  for (const via of ["notice", "idle", "ops"]) {
    const what = `rebuild exclusive (${via})`;
    const w = await rebuildReady(what);
    const clock = via === "idle" ? fakeClock() : undefined;
    await ctl("set", { set: { rebuilt: [{ hold: true }] } });
    const c = viewClient(w, clock ? { clock } : {});
    try {
      check(await until(async () => (await ctl("log")).rebuilt.length === 1), `${what}: announced, its answer held`);
      const t1 = (await ctl("log")).rebuilt[0].at, d0 = c.stats.deferred, r0 = c.stats.resumed;
      if (via === "notice") {
        const r = await ctl("probe", { ops: [{ dseq: 1, t: Date.now(), by: "person", op: "mkdir", path: "/theirs", kind: "folder", fid: "00000000000000b1" }] });
        await ctl("notice", { head: r.ack.ops[0].seq });
      }
      if (via === "idle") await clock.advance(W.CLIENT.idlePullMs + 1000);
      if (via === "ops") await w.mkdir("/mine");
      await sleep(800);
      const during = (await ctl("log")).sent.filter((m) => m.at >= t1 && m.t !== "rebuilt").map((m) => m.t);
      const waited = via === "ops" || c.stats.deferred > d0;
      check(during.length === 0 && waited, `${what}: nothing else sent while the answer is held (${J({ sent: during, deferred: c.stats.deferred - d0 })})`);
      await ctl("release");
      check(await until(async () => settled(w, c), 15_000), `${what}: answered, and converged`);
      const after = (await ctl("log")).sent.filter((m) => m.at >= t1 && m.t !== "rebuilt").map((m) => m.t);
      const ran = via === "ops" ? after.includes("ops") && !!(await w.stat("/mine")) : c.stats.resumed - r0 === 1 && after.includes("pull_index");
      check(ran && (via !== "notice" || !!(await w.stat("/theirs"))), `${what}: what waited ran after the answer${via === "ops" ? "" : ", the pull resumed once"} (${J({ resumed: c.stats.resumed - r0, after })})`);
    } finally {
      await ctl("release");
      await stop(c);
    }
  }
}

async function rebuildInvalidCrash() {
  // (astra's qualification on #104: the page dies between halt() (in memory) and its flag's write.  The server's
  // invalid comes only once this device's refusals are at its cap, and each refusal acked here recorded the obligation
  // "refused" with its record's removal (refusalAtomic): so the crash loses the reason (invalid), never the rebuild.
  // Here the hook records that obligation, as those refusals have, then the page dies; restarted, the client rebuilds
  // before it sends anything, sends the record after, and converges)
  await account();
  const w = await fresh();
  const c0 = viewClient(w);
  check(await until(() => settled(w, c0)), "rebuild invalid crash: synced");
  const ns = nsOf(c0);
  await stop(c0);
  await w.mkdir("/k1");
  await ctl("log", { reset: true });
  await ctl("set", { set: { fakeOps: [{ code: "invalid", detail: { message: "too many refused ops: rebuild from the server's log" } }] } });
  let crashed = false;
  W.REBUILD.before = async (phase, at) => {
    if (phase !== "halt" || crashed) return;
    crashed = true;
    await new Promise((ok, no) => { const tx = w.ws.transaction("meta", "readwrite"); W.obligate(tx.objectStore("meta"), at, "refused").then(() => {}, no); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
    throw new Error("the page dies before the halt's flag is written (test)");
  };
  const c1 = viewClient(w);
  try {
    check(await until(() => crashed), "rebuild invalid crash: invalid answered, halted, and the page died before the flag");
  } finally {
    W.REBUILD.before = null;
    await stop(c1);
  }
  const rb = await metaGet(w.ws, `sync:${ns}:rebuild`);
  check(rb?.why === "refused" && (await outbox(w)) === 1, "rebuild invalid crash: the reason lost (\"refused\" kept, not \"invalid\"), the obligation and the undecided record kept: " + J(rb));
  await ctl("log", { reset: true });
  const c2 = viewClient(w);
  try {
    check(await until(async () => (await outbox(w)) === 0 && (await settled(w, c2)), 20_000), "rebuild invalid crash: restarted, converged, the record decided " + J(c2.status));
    // (the order the front received them in: log.sent is appended as each message arrives (astra2's CORR-PR111-1: not
    // their times, which can be equal))
    const log = await ctl("log"), sent = log.sent.map((m) => m.t);
    const iReb = sent.indexOf("rebuilt"), iOps = sent.indexOf("ops"), nReb = sent.filter((t) => t === "rebuilt").length;
    const left = await metaGet(w.ws, `sync:${ns}:rebuild`);
    check(nReb === 1 && log.rebuilt.length === 1 && iOps >= 0 && iReb >= 0 && iReb < iOps && !left, "rebuild invalid crash: rebuilt announced once, before any ops, and no obligation left " + J({ rebuilt: nReb, rebuiltAt: iReb, firstOpsAt: iOps, left }));
  } finally {
    await stop(c2);
  }
}

async function rebuildCounter() {
  // (test 19, CORR-REBUILT-1: done services n0; a refusal (n0 + 1) recorded during view, during retire, before the
  // announce, and during the held ack: the ack records the floor, the flag stays set, another pass runs, and its
  // announce is acked; n0 + 1 is never cleared unserviced)
  for (const at of ["view-page", "retire-page", "announce", "ack"]) {
    await account();
    const w = await fresh();
    const c0 = viewClient(w);
    check(await until(() => settled(w, c0)), `rebuild counter (${at}): synced`);
    const ns = nsOf(c0);
    await stop(c0);
    await w.mkdir("/x");
    const bump = () => new Promise((ok, no) => { const tx = w.ws.transaction("meta", "readwrite"); W.obligate(tx.objectStore("meta"), ns, "refused").then(() => {}, no); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
    await bump();
    const n0 = (await metaGet(w.ws, `sync:${ns}:rebuild`)).n;
    let fired = false;
    W.REBUILD.before = async (phase) => { if (!fired && phase === at) { fired = true; await bump(); } };
    await ctl("set", { set: { rebuilt: at === "ack" ? [{ hold: true }] : [] } });
    await ctl("log", { reset: true });
    const c = viewClient(w);
    try {
      if (at === "ack") {
        check(await until(async () => (await ctl("log")).rebuilt.length === 1), `rebuild counter (${at}): announced, ack held`);
        await bump();
        fired = true;
        await ctl("release");
      }
      check(await until(async () => (await settled(w, c)) && !(await metaGet(w.ws, `sync:${ns}:rebuild`)), 20_000), `rebuild counter (${at}): converged, the flag cleared only by the pass that serviced it: ` + J({ passes: c.stats.rebuildPasses, phase: c.stats.rebuildPhase, rebuilt: (await ctl("log")).rebuilt.length }));
      check(fired && c.stats.rebuildPasses >= 2 && (await ctl("log")).rebuilt.length >= 2, `rebuild counter (${at}): n0 = ${n0} serviced, then n0 + 1 by another pass and its own announce: ` + J({ passes: c.stats.rebuildPasses, rebuilt: (await ctl("log")).rebuilt.length }));
    } finally {
      W.REBUILD.before = null;
      await ctl("release");
      await stop(c);
    }
  }
}

async function rebuildFailedPass() {
  // (D6 r4: a mismatched n during log and during capture: no live entry, record, pin, watermark or cursor changed,
  // compared before and after; the pass's generations go to the cleanup list, and the next pass completes)
  for (const at of ["log", "capture"]) {
    await account();
    const w = await fresh();
    const c0 = viewClient(w);
    check(await until(() => settled(w, c0)), `failed pass (${at}): synced`);
    const ns = nsOf(c0);
    await stop(c0);
    await w.create("/keep.txt", { content: "k" });
    await w.mkdir("/kd");
    // (records made, undecided: the replaced prefix a capture would read)
    await new W.Outbox(w, await W.currentLease(w)).scan();
    const bump = () => new Promise((ok, no) => { const tx = w.ws.transaction("meta", "readwrite"); W.obligate(tx.objectStore("meta"), ns, "refused").then(() => {}, no); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
    await bump();
    let before = null, after = null, fired = false;
    W.REBUILD.before = async (phase) => {
      if (phase === "log" && !before) before = await liveState(w, ns);
      if (!fired && phase === at) { fired = true; await bump(); }
      // (the failed pass's done has run, its generations cleaned: the next pass is at its log)
      if (fired && phase === "log" && before && !after && c.stats.rebuildPasses >= 2) after = await liveState(w, ns);
    };
    // (assigned before the hook can run: the client's first phase comes after its connection)
    let c = null;
    c = viewClient(w);
    try {
      check(await until(() => !!after, 20_000), `failed pass (${at}): the pass failed its compare-and-swap, another began`);
      check(before === after, `failed pass (${at}): the live state exactly as it was`);
      check(await until(async () => (await settled(w, c)) && !(await metaGet(w.ws, `sync:${ns}:rebuild`)), 20_000), `failed pass (${at}): the next pass completes`);
      check((await generations(w)).length <= 2, `failed pass (${at}): at most two generations: ` + J(await generations(w)));
    } finally {
      W.REBUILD.before = null;
      await stop(c);
    }
  }
}

async function rebuildBehind() {
  // (D6: local behind the server, as a restored older copy: a second workspace with the first one's device, its own
  // edits at dseqs the server decided for other ops.  welcome's next_dseq is past them: halted, rebuilt; the
  // replaced records' identities reissued at fresh dseqs from server_next, each once; the server's tree listed here)
  await account();
  const w1 = await fresh();
  const c1 = viewClient(w1);
  check(await until(() => settled(w1, c1)), "behind: the first copy synced");
  for (let i = 1; i <= 5; i++) await w1.mkdir(`/a${i}`);
  check(await until(() => settled(w1, c1)), "behind: its five folders up");
  const ns = nsOf(c1);
  await stop(c1);
  const nm = names();
  let w2 = await W.Workspace.open(nm);
  w2.close();
  await new Promise((ok, no) => { const r = indexedDB.open(nm.name); r.onsuccess = () => { const db = r.result; const tx = db.transaction("meta", "readwrite"); tx.objectStore("meta").put(w1.device, "device"); tx.oncomplete = () => { db.close(); ok(); }; tx.onerror = () => no(tx.error); }; r.onerror = () => no(r.error); });
  w2 = await W.Workspace.open(nm);
  used.push(w2);
  check(w2.device === w1.device, "behind: the older copy has the same device");
  const ob = new W.Outbox(w2, await W.switchTo(w2, ns));
  await ob.begin(await w2.lastSeq());
  const f = await w2.create("/mine.txt", { content: "mine" });
  await w2.mkdir("/mine-d");
  await ob.scan();
  check((await ob.records()).map((r) => r.dseq).join() === "1,2", "behind: its own records at dseqs 1 and 2 (the server's are other ops)");
  await ctl("log", { reset: true });
  const c2 = viewClient(w2);
  try {
    check(await until(async () => (await settled(w2, c2)) && c2.stats.rebuildPasses >= 1, 30_000), "behind: halted, rebuilt, resumed: " + J({ passes: c2.stats.rebuildPasses, phase: c2.stats.rebuildPhase, error: c2.stats.rebuildError, status: c2.status }));
    const { mine } = await serverOps(w2);
    const adopts = mine.filter((o) => o.fid === f.fid), dirs = mine.filter((o) => o.path === "/mine-d" && o.op === "mkdir");
    check(adopts.length === 1 && adopts[0].op === "adopt" && adopts[0].dseq >= 6, "behind: the file reissued once, as an adopt from server_next: " + J(adopts.map((o) => [o.op, o.dseq])));
    check(dirs.length === 1 && dirs[0].dseq >= 6, "behind: the folder reissued once: " + J(dirs.map((o) => o.dseq)));
    const sent = (await ctl("log")).sent.filter((m) => m.t === "ops").flatMap((m) => m.dseqs);
    check(sent.every((d) => d >= 6) && new Set(sent).size === sent.length, "behind: nothing sent below server_next, no dseq twice: " + J(sent));
    const here = (await w2.list("/")).map((e) => e.path).sort();
    check(["/a1", "/a2", "/a3", "/a4", "/a5", "/mine-d", "/mine.txt"].every((p) => here.includes(p)) && !here.some((p) => / \(2\)/.test(p)), "behind: the server's folders listed here, its own kept, no copies: " + J(here));
    await w2.mkdir("/after");
    check(await until(async () => (await settled(w2, c2)) && (await serverOps(w2)).mine.some((o) => o.path === "/after")), "behind: a later edit accepted");
  } finally {
    await stop(c2);
  }
}

// ---- step 4: the first sync's adoption (C3)

async function firstSync() {
  // (a tree made before sync: each identity up once, adopted or made; one in Trash as adopt then remove; one inside a
  // folder in Trash not adopted; the folder before what is in it)
  await account();
  const w = await fresh();
  await w.mkdir("/p");
  const f = await w.create("/p/f.txt", { content: "ff" });
  const g = await w.create("/g.txt", { content: "gg" });
  const nb = await w.create("/n.ipynb");
  const t = await w.create("/t.txt", { content: "tt" });
  await w.remove("/t.txt");
  await w.mkdir("/q");
  const inq = await w.create("/q/in.txt", { content: "in" });
  await w.remove("/q");
  const c = viewClient(w);
  try {
    check(await until(() => settled(w, c), 20_000), "first sync: settled: " + J(c.status));
    const { mine } = await serverOps(w);
    const by = (id) => mine.filter((o) => o.fid === id || o.ref === id);
    const p = await w.stat("/p");
    check(by(p.fid).length === 1 && by(p.fid)[0].op === "mkdir", "first sync: the folder made once: " + J(by(p.fid).map((o) => o.op)));
    check(by(f.fid).length === 1 && by(f.fid)[0].op === "adopt" && by(f.fid)[0].parent === p.fid && by(f.fid)[0].dseq > by(p.fid)[0].dseq, "first sync: its file adopted once, into it by identity, after it");
    check(by(g.fid).length === 1 && by(nb.ref).length === 1, "first sync: a root file and a notebook adopted once each");
    check(J(by(t.fid).map((o) => o.op)) === J(["adopt", "remove"]), "first sync: one in Trash: adopted where it was, then removed: " + J(by(t.fid).map((o) => o.op)));
    check(by(inq.fid).length === 0, "first sync: inside a folder in Trash: not adopted");
    const puts = (await ctl("log")).http.filter((h) => h.method === "PUT" && (h.status === 201 || h.status === 200)).length;
    check(puts >= 3, "first sync: the files' bytes uploaded: " + puts);
    const ns = nsOf(c);
    check(!(await metaGet(w.ws, `sync:${ns}:journal`)) && !(await metaGet(w.ws, `sync:${ns}:adopt`)), "first sync: the journal drained and dropped");
    await w.mkdir("/later");
    check(await until(async () => (await settled(w, c)) && (await serverOps(w)).mine.some((o) => o.path === "/later")), "first sync: then the scanner goes on");
  } finally {
    await stop(c);
  }
}

async function firstSyncRace() {
  // (C3: a final local write racing the closing transaction: in the journal or sent by the scan, exactly once)
  await account();
  const w = await fresh();
  const f = await w.create("/r.txt", { content: "one" });
  let wrote = false;
  W.ADOPT.before = async (step) => { if (step === "close" && !wrote) { wrote = true; await w.write("/r.txt", "two"); } };
  const c = viewClient(w);
  try {
    check(await until(() => settled(w, c), 20_000), "first sync race: settled");
    const { mine } = await serverOps(w);
    const ops = mine.filter((o) => o.fid === f.fid);
    const last = ops[ops.length - 1], now = (await w.stat("/r.txt")).sha256;
    check(wrote && last?.sha256 === now, "first sync race: the server ends with the written bytes: " + J(ops.map((o) => [o.op, o.sha256?.slice(0, 6)])));
    check(ops.filter((o) => o.sha256 === now).length === 1, "first sync race: …sent exactly once");
  } finally {
    W.ADOPT.before = null;
    await stop(c);
  }
}

async function firstSyncCollision() {
  // (C3's last test: the cloud has /x; this device's first sync with its own /x: the cloud's is /x, this one /x (2),
  // here as on the server)
  await account();
  const r = await ctl("probe", { ops: [{ dseq: 1, t: Date.now(), by: "person", op: "mkdir", path: "/x", kind: "folder", fid: "00000000000000c1" }] });
  check(r.ack?.ops?.[0]?.seq, "first sync collision: the cloud has /x");
  const w = await fresh();
  const mine = await w.mkdir("/x");
  const c = viewClient(w);
  try {
    check(await until(() => settled(w, c), 20_000), "first sync collision: settled");
    const here = await w.stat("/x"), ours = (await w.list("/")).find((e) => e.fid === mine.fid);
    check(here?.fid === "00000000000000c1" && ours?.path === "/x (2)", "first sync collision: the cloud's /x here, this device's at /x (2): " + J({ x: here?.fid, ours: ours?.path }));
  } finally {
    await stop(c);
  }
}

async function rebuildKickAfterHalt() {
  // (web-sync's "cap, no reset" flake: the server's invalid "rebuild" refusal answered after the sender went idle, so
  // nothing but that answer can start the rebuild: it must start by itself, at once, not wait for a reconnect)
  await account();
  const w = await fresh();
  const c0 = viewClient(w);
  check(await until(() => settled(w, c0)), "rebuild after an idle refusal: synced");
  await stop(c0);
  await w.mkdir("/kicked");
  await ctl("log", { reset: true });
  await ctl("set", { set: { fakeOps: [{ code: "invalid", hold: true, detail: { message: "too many refused ops: rebuild from the server's log" } }] } });
  const c = viewClient(w);
  const prev = W.REBUILD.before, atHalt = [];
  try {
    // (the handshake, not a timing: the server holds the refusal; the test releases it only once it observes, all at
    // once, (1) the server's log holding exactly that one ops message, (2) the client's current connection still the
    // one that sent it, with that ops request pending (unanswered: the held refusal), and (3) the sender idle: its loop
    // not running and no further run queued (running and again both false).  The log is read first; then the client's
    // state is read synchronously, with no await between those reads and the release's request (astra3's snapshot
    // hole: state read before an await is stale after it).  No sleep gates the release: the polling only waits for
    // that state, and then the state itself is the condition)
    const conn = await (async () => { for (let i = 0; i < 400; i++) { const k = c.conn; if (k && [...k.pending.values()].some((p) => p.kind === "ops")) return k; await sleep(25); } return null; })();
    // (and at the refusal's handling itself, the halt, synchronously at its entry: the same connection, the sender
    // still idle; that covers the gap between the release and the answer's delivery)
    W.REBUILD.before = async (phase, ...rest) => {
      if (phase === "halt") atHalt.push({ same: c.conn === conn, running: c.running, again: c.again });
      if (prev) return prev(phase, ...rest);
    };
    let seen = null, idleSeen = false;
    for (let i = 0; i < 400; i++) {
      const lg = await ctl("log");
      seen = { conn: !!conn, same: c.conn === conn, pending: !!conn && [...conn.pending.values()].some((p) => p.kind === "ops"), running: c.running, again: c.again, ops: opsMessages(lg).length };
      idleSeen = seen.conn && seen.same && seen.pending && !seen.running && !seen.again && seen.ops === 1;
      if (idleSeen) break;
      await sleep(25);
    }
    check(idleSeen, "rebuild after an idle refusal: before the refusal, its ops request pending on the connection that sent it and the sender idle (not running, nothing queued): " + J(seen));
    const connects = c.stats.connects, wakes = c.stats.wakesFired, passes = c.stats.rebuildPasses;
    check((await ctl("release")).released === 1 && passes === 0, "rebuild after an idle refusal: the held refusal released, no rebuild before it");
    check(await until(() => c.stats.rebuildPasses >= 1, 6000) && c.conn === conn && c.stats.connects === connects && c.stats.wakesFired === wakes, "rebuild after an idle refusal: the rebuild starts by itself, on the same connection, with no timer's wake: " + J({ passes: c.stats.rebuildPasses, same: c.conn === conn, connects: [connects, c.stats.connects], wakes: [wakes, c.stats.wakesFired], status: c.status }));
    check(atHalt.length === 1 && atHalt[0].same && !atHalt[0].running && !atHalt[0].again, "rebuild after an idle refusal: at the refusal's handling (the halt), the same connection and the sender idle: " + J(atHalt));
    check(await until(() => settled(w, c), 20_000), "rebuild after an idle refusal: …and completes, synced: " + J(c.status));
  } finally {
    W.REBUILD.before = prev;
    await stop(c);
  }
}

async function rebuildCapUnsupported() {
  // (astra's CORR-PR65-IMPL-2: the server's refusal limit (its exact answer, `invalid` "too many refused ops"), then
  // the rebuild's announce to core's real server, which has no `rebuilt` ("unknown message"): no reset, so a stable,
  // said halt, never a fabricated ack; nothing sent, no rebuild again, across a reconnect too)
  await account();
  const w = await fresh();
  const c0 = viewClient(w);
  check(await until(() => settled(w, c0)), "cap, no reset: synced");
  await stop(c0);
  await w.mkdir("/capped");
  await ctl("log", { reset: true });
  await ctl("set", { set: { rebuiltReal: true, fakeOps: [{ code: "invalid", detail: { message: "too many refused ops: rebuild from the server's log" } }] } });
  const c = viewClient(w);
  try {
    check(await until(() => (c.status.reason ?? "").includes("can't reset"), 20_000), "cap, no reset: halted, said: " + J(c.status));
    const ns = nsOf(c);
    await sleep(3000);
    const lg = await ctl("log");
    check(opsMessages(lg).length === 1 && lg.rebuilt.length === 1 && c.stats.rebuildPasses === 1, "cap, no reset: one announce, no op sent after it, no second rebuild (no loop): " + J({ ops: opsMessages(lg).length, rebuilt: lg.rebuilt.length, passes: c.stats.rebuildPasses }));
    check((await metaGet(w.ws, `sync:${ns}:rebuild`))?.why === "invalid" && (await all(w.ws, "outbox")).length === 1, "cap, no reset: the obligation kept, the record kept (nothing cleared by a made-up ack)");
    await stop(c);
    await ctl("log", { reset: true });
    const c2 = viewClient(w);
    check(await until(() => (c2.status.reason ?? "").includes("can't reset"), 20_000), "cap, no reset: a reconnect finds it halted");
    await sleep(2500);
    const lg2 = await ctl("log");
    check(opsMessages(lg2).length === 0 && lg2.rebuilt.length === 0 && c2.stats.rebuildPasses === 0, "cap, no reset: …and neither rebuilds nor sends: " + J({ ops: opsMessages(lg2).length, rebuilt: lg2.rebuilt.length, passes: c2.stats.rebuildPasses }));
    await stop(c2);
  } finally {
    await ctl("set", { set: { rebuiltReal: false } });
  }
}

async function rebuildRefusalCoreServer() {
  // (astra: an ordinary local rebuild against core's server (no `rebuilt`): a plain refusal needs no reset, so the
  // pass completes on "unknown message" and sending resumes, once)
  await account();
  const w = await fresh();
  const c0 = viewClient(w);
  check(await until(() => settled(w, c0)), "core rebuild: synced");
  await stop(c0);
  const f = await w.create("/gone2.txt", { content: "bytes gone" });
  await new Promise((ok, no) => { const tx = w.ws.transaction("fileBytes", "readwrite"); tx.objectStore("fileBytes").delete(f.fid); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  await ctl("log", { reset: true });
  await ctl("set", { set: { rebuiltReal: true } });
  const c = viewClient(w);
  try {
    check(await until(() => c.stats.rebuildPasses >= 1 && c.status.state === "synced", 20_000), "core rebuild: refused, rebuilt, resumed: " + J({ passes: c.stats.rebuildPasses, status: c.status }));
    await sleep(2000);
    check(c.stats.rebuildPasses === 1 && (await ctl("log")).rebuilt.length === 1, "core rebuild: one pass, one announce (no loop)");
    await w.mkdir("/after-core");
    check(await until(async () => (await settled(w, c)) && (await serverOps(w)).mine.some((o) => o.path === "/after-core")), "core rebuild: a later op accepted");
  } finally {
    await ctl("set", { set: { rebuiltReal: false } });
    await stop(c);
  }
}

async function scanAtomic() {
  // (the scan writes its records and the watermark in one transaction: sampled in ONE transaction throughout a
  // create-and-send cycle, the watermark never passes an op whose record isn't there, or wasn't there before (decided).
  // The client's side of the lost-ack diagnosis: only a reader using two transactions could see otherwise)
  await account();
  const w = await fresh();
  const c = client(w);
  check(await until(() => c.status.state === "synced"), "scan atomic: synced");
  const ns = nsOf(c), seen = new Set(), bad = [];
  let samples = 0, halt = false;
  const sample = () => new Promise((ok, no) => {
    const tx = w.ws.transaction(["meta", "outbox", "ops"]);
    const m = tx.objectStore("meta").get(`sync:${ns}:scanned`), o = tx.objectStore("outbox").getAll(), ops = tx.objectStore("ops").getAll();
    tx.oncomplete = () => {
      const W = m.result ?? 0;
      for (const r of o.result) seen.add(r.lseq);
      for (const op of ops.result) if (op.seq <= W && sendable([op]).length && !seen.has(op.seq)) bad.push([op.seq, op.path, W]);
      samples++;
      ok();
    };
    tx.onerror = () => no(tx.error);
  });
  const sampler = (async () => { while (!halt) { await sample(); await sleep(1); } })();
  for (let i = 0; i < 5; i++) await w.create(`/atomic${i}.txt`, { content: "a" + i });
  await w.mkdir("/atomic-folder");
  const ok = await until(() => settled(w, c), 15_000);
  halt = true;
  await sampler;
  // (an op whose record came and went between two samples is decided: the server has it)
  const { mine } = await serverOps(w);
  const decided = new Set(mine.map((o) => o.path));
  const missed = bad.filter(([, path]) => !decided.has(path));
  check(ok && samples > 20 && missed.length === 0, `scan atomic: in ${samples} one-transaction samples, the watermark never passed an op without its record (${missed.length}: ${J(missed.slice(0, 3))})`);
  await stop(c);
}

const caught = async (p) => { try { await p; return null; } catch (e) { return e; } };

// ---- step 5: the page's sync owner, the Storage panel's Sync section, the foot and the rows' icons
// (plan-step5-sync-ui r4)

/** A fake server for the panel: answers by path, counts POSTs; `next` answers the next delete/enable. */
function fakeServer(status, account = "acct-x") {
  // (statusGates: each status read waits for the next gate, if any; statusReads counts the reads begun)
  // (meGates: each /me read takes the session's account first, then waits for the next gate, if any, before answering
  // (a response held while the session changes); meReads counts them)
  // (echo: the status names the account it was computed for, as the server does (PR #130); false, an old server's;
  // statusAs: the status computed for another session's account than /me answers (A, B, A))
  const s = { status, posts: [], deletes: [], next: [], me: account, statusGates: [], statusReads: 0, meGates: [], meReads: 0, echo: true, statusAs: null };
  s.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path === "/api/share/me") {
      s.meReads++;
      const id = s.me, g = s.meGates.shift();
      if (g) await g;
      return Response.json({ account_id: id });
    }
    if (path === "/api/sync/v1/status") {
      s.statusReads++;
      // (statusEarly: the answer computed when asked, then held (an answer already in flight); else when released)
      const val = async () => {
        const v = typeof s.status === "function" ? s.status() : s.status;
        return s.echo ? { ...v, account: await hashOf(s.statusAs ?? s.me) } : v;
      };
      const early = s.statusEarly ? await val() : undefined;
      const g = s.statusGates.shift();
      if (g) await g;
      return Response.json(early ?? (await val()));
    }
    if (init.method === "POST") {
      s.posts.push(path);
      if (path.endsWith("/delete")) s.deletes.push(JSON.parse(init.body));
      const a = s.next.shift() ?? { status: 202, body: { state: "deleting" } };
      if (a.gate) await a.gate;
      if (a.throw) throw new TypeError("lost");
      return new Response(JSON.stringify(a.body ?? {}), { status: a.status, headers: { "content-type": "application/json", ...(a.headers ?? {}) } });
    }
    return new Response("{}", { status: 404 });
  };
  return s;
}
const hostOf = (w, answers = {}) => ({ say: () => {}, fail: () => {}, usage: () => w.usage(), confirm: () => answers.confirm ?? true, prompt: () => answers.prompt ?? "delete" });
const buttons = (el) => [...el.querySelectorAll("button")].map((b) => (b.disabled ? "[x] " : "") + b.textContent);
const text = (el) => el.textContent;

async function s5Poll() {
  // (PanelPoll: one request in flight, one timer, the clamp, the backoff, and nothing after close)
  check(W.clampDelay(-1) === undefined && W.clampDelay(1.5) === undefined && W.clampDelay("5") === undefined && W.clampDelay(Infinity) === undefined && W.clampDelay(10) === 1000 && W.clampDelay(5e9) === 600_000 && W.clampDelay(30_000) === 30_000, "poll: the server's delay validated and clamped to [1 s, 600 s]");
  const clock = fakeClock();
  let calls = 0, release = [];
  const ask = () => { calls++; return new Promise((ok) => release.push(() => ok({ ok: false, why: "network" }))); };
  const answers = [];
  const p = new W.PanelPoll(ask, (a) => answers.push(a), () => 0.5, (ms, f) => clock.after(ms, f));
  p.request(); p.request(); p.request();
  check(calls === 1 && p.busy, "poll: single-flight (three asks, one request)");
  const waits = [];
  for (let i = 0; i < 7; i++) {
    release.shift()();
    await sleep(10);
    waits.push(p.later());
    await clock.advance(waits.at(-1));
  }
  check(J(waits) === J([2000, 4000, 8000, 16000, 32000, 60000, 60000]), "poll: the fallback backoff 2 s doubling to 60 s (jitter at its middle): " + J(waits));
  // (closed during a fetch: its answer dropped; closed during a wait: no request after)
  const n0 = answers.length;
  p.close();
  release.shift()?.();
  await sleep(10);
  await clock.advance(120_000);
  check(answers.length === n0 && calls === 8 && !p.armed && !p.busy && clock.nextAt() === null, "poll: closed during a fetch, the answer dropped; no timer, no request after: " + J({ calls, timers: clock.nextAt() }));
  const p2 = new W.PanelPoll(async () => ({ ok: false, why: "network" }), () => {}, () => 0.5, (ms, f) => clock.after(ms, f));
  p2.request(); p2.later(5000); p2.close();
  await clock.advance(10_000);
  check(p2.requests === 1 && clock.nextAt() === null, "poll: closed during its backoff, nothing more");
}

async function s5Section() {
  // (the switch's shapes, from status alone; delete only with the server's precondition)
  const w = await fresh();
  const shapes = [
    [{ available: false, reason: "not_allowlisted", state: "off" }, (el) => el.textContent === "", "not_allowlisted: hidden"],
    [{ available: false, reason: "plan_has_no_sync", state: "off" }, (el) => /\[x\] Turn on sync/.test(buttons(el).join()) && /isn't available/.test(text(el)), "plan_has_no_sync: disabled, the fallback words"],
    [{ available: false, reason: "cocalc_unreachable", state: "off", message: "CoCalc says no" }, (el) => /CoCalc says no/.test(text(el)), "cocalc_unreachable: the server's own words"],
    [{ available: true, state: "deleting", generation: 2 }, (el) => /\[x\] Deleting your synced data/.test(buttons(el).join()), "deleting: said, disabled"],
    [{ available: true, state: "active", generation: 2 }, (el) => !/Delete my synced data/.test(buttons(el).join()), "active, no limit_bytes (no server precondition): no delete"],
    [{ available: true, state: "active", generation: 2, limit_bytes: 2 ** 30, used_bytes: 2 ** 20 }, (el) => /Delete my synced data/.test(buttons(el).join()) && /1\.0 MB of 1\.00 GB used/.test(text(el)), "active with limit_bytes: delete offered, the limit shown"],
    [{ available: true, state: "off", limit_bytes: null, used_bytes: 0 }, (el) => /Turn on sync/.test(buttons(el).join()) && !/storage:/.test(text(el)), "off, limit_bytes null: no limit (shown after enabling)"],
  ];
  for (const [status, ok, what] of shapes) {
    const el = document.createElement("div"), srv = fakeServer(status);
    const s = W.syncSection(w, el, hostOf(w), { fetch: srv.fetch });
    await until(() => el.textContent !== "" || status.reason === "not_allowlisted", 3000);
    await sleep(50);
    check(ok(el), "section: " + what + ": " + J(buttons(el)) + " " + text(el).slice(0, 120));
    check(srv.posts.length === 0, "section: " + what + ": nothing POSTed without a click");
    s.dispose();
  }
  const el = document.createElement("div"), down = W.syncSection(w, el, hostOf(w), { fetch: async () => { throw new TypeError("down"); } });
  await until(() => /Can't check sync/.test(el.textContent), 3000);
  check(/Can't check sync right now/.test(el.textContent) && down.poll.armed, "section: status unreadable: unknown (neither off nor on), asked again later");
  down.dispose();
  check(!down.poll.armed && !down.poll.busy, "section: dispose (the panel closed) leaves no timer, no request");
}

async function s5Delete() {
  // (the delete's outcomes, bound to the account and generation shown; never a POST without a click)
  const w = await fresh();
  const status = { available: true, state: "active", generation: 3, limit_bytes: 1000, used_bytes: 10 };
  const run = async (answers, what, extra = {}) => {
    const el = document.createElement("div"), srv = fakeServer(extra.status ?? status), clock = fakeClock();
    srv.next = answers;
    const s = W.syncSection(w, el, hostOf(w, extra), { fetch: srv.fetch, random: () => 0.5, after: (ms, f) => clock.after(ms, f) });
    await until(() => /Delete my synced data/.test(buttons(el).join()), 3000);
    [...el.querySelectorAll("button")].find((b) => /Delete my synced data/.test(b.textContent)).click();
    await sleep(200);
    return { el, srv, clock, s, what };
  };
  // (409: nothing deleted, said; the body carried the account and the generation)
  let r = await run([{ status: 409, body: { error: "account_mismatch" } }]);
  check(r.srv.deletes.length === 1 && r.srv.deletes[0].generation === 3 && typeof r.srv.deletes[0].account === "string" && r.srv.deletes[0].confirm === "delete" && /another account: nothing was deleted/.test(text(r.el)), "delete: the POST carries confirm, generation and account; 409 account_mismatch said: " + J(r.srv.deletes));
  r.s.dispose();
  // (the confirmation not typed: no POST)
  r = await run([], "", { prompt: "nope" });
  check(r.srv.deletes.length === 0, "delete: not typed \"delete\": nothing sent");
  r.s.dispose();
  // (429: the button off for the clamped wait, then back; never a POST by itself)
  r = await run([{ status: 429, body: { retry_after: 5000 } }]);
  check(/\[x\] Try again in 5 s/.test(buttons(r.el).join()), "delete: 429: Retry disabled for the server's wait: " + J(buttons(r.el)));
  await r.clock.advance(60_000);
  await sleep(50);
  check(r.srv.deletes.length === 1 && /Delete my synced data/.test(buttons(r.el).join()) && !/\[x\] Delete/.test(buttons(r.el).join()), "delete: after the wait, enabled again, still one POST (no automatic retry): " + J(buttons(r.el)));
  r.s.dispose();
  check(r.clock.nextAt() === null, "delete: closed: no timer left");
  // (stale: a newer generation; nothing done here, a new confirmation needed)
  r = await run([{ status: 202, body: { state: "stale", generation: 4 } }]);
  check(/turned on again since; confirm again/.test(text(r.el)) && r.srv.deletes.length === 1, "delete: stale: said, nothing sent again");
  r.s.dispose();
  // (deleting: sync off here, followed until status says off for the same account)
  let st = { ...status };
  r = await run([{ status: 202, body: { state: "deleting", generation: 3 } }], "", { status: () => st });
  check(/\[x\] Deleting your synced data/.test(buttons(r.el).join()), "delete: deleting: said, and followed: " + J(buttons(r.el)));
  st = { available: true, state: "off" };
  await r.clock.advance(2000);
  await until(() => /was deleted/.test(text(r.el)), 3000);
  check(/was deleted/.test(text(r.el)), "delete: done only once status says off");
  r.s.dispose();
  // (a lost answer: one read-only status; same generation active: Retry by a click only)
  r = await run([{ throw: true }]);
  await sleep(200);
  check(r.srv.deletes.length === 1 && /Couldn't confirm the deletion/.test(text(r.el)), "delete: a lost answer: said, no POST again: " + text(r.el).slice(0, 100));
  r.s.dispose();
  // (a lost answer, and status shows a later generation: the stale branch)
  // (the first status read (the panel's draw) at generation 3; every later one (the lost answer's) at 5)
  let reads = 0;
  r = await run([{ throw: true }], "", { status: () => (reads++ === 0 ? status : { ...status, generation: 5 }) });
  await sleep(300);
  check(/turned on again since/.test(text(r.el)) && r.srv.deletes.length === 1, "delete: lost, then a later generation active: the stale branch");
  r.s.dispose();
}

async function s5Lifecycle() {
  // (turned on through the panel against the real server; the owner runs the client, renews its lease on a
  // reconnect (eligible throughout), and stops for good on off)
  await account();
  const w = await fresh();
  const owner = W.SyncOwner.of(w, { origin: location.origin });
  owner.start();
  const el = document.createElement("div");
  const s = W.syncSection(w, el, hostOf(w));
  await until(() => /Turn on sync/.test(buttons(el).join()), 5000);
  [...el.querySelectorAll("button")].find((b) => /Turn on sync/.test(b.textContent)).click();
  check(await until(() => owner.view().s.state === "synced", 15_000), "lifecycle: on through the panel: the owner's client synced: " + J(owner.view()));
  const c1 = owner.client, gen1 = (await metaGet(w.ws, "sync:current")).gen;
  await ctl("closeAll");
  check(await until(async () => owner.view().s.state === "synced" && (await metaGet(w.ws, "sync:current")).gen > gen1, 15_000), "lifecycle: a reconnect renews the lease (gen raised), the owner keeps its client");
  check(owner.client === c1, "lifecycle: the same client throughout (eligibility is the lifecycle, not gen)");
  const epoch = (await metaGet(w.ws, "sync:epoch")) ?? 0;
  await until(() => /Turn off sync here/.test(buttons(el).join()), 5000);
  [...el.querySelectorAll("button")].find((b) => /Turn off sync here/.test(b.textContent)).click();
  check(await until(() => owner.client === null, 10_000), "lifecycle: off: the client stopped");
  const cur = await metaGet(w.ws, "sync:current");
  check(cur.off === true && (await metaGet(w.ws, "sync:epoch")) === epoch + 1, "lifecycle: off is durable, the epoch moved on");
  // (a renewal can't bring it back: the compare-and-set refuses an off lease)
  const e = await caught(W.renewLease(w, cur.ns, epoch + 1));
  check(e instanceof W.Fenced, "lifecycle: renewLease refuses an off lease (only enable clears off)");
  s.dispose();
  owner.destroy();
}

async function s5Docs() {
  // (DEV's switch for notebooks' contents (doc-sync-switch.ts): the owner says whether its client runs, waiting up to a
  // bound; and a DocSync handed to it (setDocs) goes on its client's connection: a running client made again with it)
  await account();
  const w = await fresh();
  const owner = W.SyncOwner.of(w, { origin: location.origin });
  owner.start();
  const t0 = Date.now(), none = await owner.clientRunning(400);
  check(none === false && Date.now() - t0 >= 350, "docs: sync off here: clientRunning false, after its wait");
  const el = document.createElement("div");
  const s = W.syncSection(w, el, hostOf(w));
  await until(() => /Turn on sync/.test(buttons(el).join()), 5000);
  [...el.querySelectorAll("button")].find((b) => /Turn on sync/.test(b.textContent)).click();
  check((await owner.clientRunning(15_000)) === true, "docs: sync on: clientRunning true");
  await until(() => owner.view().s.state === "synced", 15_000);
  const calls = [];
  const docs = { connected(l) { calls.push("connected:" + typeof l.ask); }, disconnected() { calls.push("disconnected"); }, changed() {} };
  const c1 = owner.client;
  owner.setDocs(docs);
  check(await until(() => calls.includes("connected:function") && !!owner.client && owner.client !== c1, 15_000), "docs: setDocs: the client made again with it, and its welcome connects document sync: " + J(calls));
  check(!el.textContent.includes("Notebooks sync between your devices"), "docs: the Sync panel's notebooks note isn't shown on this test origin (DEV's only)");
  s.dispose();
  owner.destroy();
}

async function s5Tabs() {
  // (status across tabs: only the holder publishes; a follower opened later gets it at once; a flood of status? costs
  // one bit and at most one message a slot; an old holder's messages dropped; nothing echoed)
  await account();
  const nm = names();
  const w1 = await fresh(nm), w2 = await fresh(nm);
  const o1 = W.SyncOwner.of(w1, { origin: location.origin });
  o1.start();
  const el = document.createElement("div");
  const s = W.syncSection(w1, el, hostOf(w1));
  await until(() => /Turn on sync/.test(buttons(el).join()), 5000);
  [...el.querySelectorAll("button")].find((b) => /Turn on sync/.test(b.textContent)).click();
  check(await until(() => o1.view().s.state === "synced" && o1.isHolder(), 15_000), "tabs: the first tab holds and syncs");
  await sleep(1200);
  const o2 = W.SyncOwner.of(w2, { origin: location.origin });
  o2.start();
  check(await until(() => o2.view().from === "holder" && o2.view().s.state === "synced", 5000), "tabs: a follower opened after a steady second gets the holder's snapshot: " + J(o2.view()));
  // (a flood of requests: the holder's state is one boolean; publications at most one a slot)
  const p0 = o1.stats.published, t0 = Date.now();
  const ch = new BroadcastChannel(`sagebrush-sync-status:${w1.ws.name}:${(await metaGet(w1.ws, "sync:current")).ns}`);
  const epoch = (await metaGet(w1.ws, "sync:epoch")) ?? 0, ns = (await metaGet(w1.ws, "sync:current")).ns;
  for (let i = 0; i < 10_000; i++) ch.postMessage({ t: "status?", ns, epoch });
  await sleep(2000);
  const pubs = o1.stats.published - p0, secs = (Date.now() - t0) / 1000;
  check(pubs <= Math.ceil(secs / 0.5) + 1 && pubs >= 1, `tabs: 10,000 status? in a burst: ${pubs} publications in ${secs.toFixed(1)} s (at most one per 500 ms)`);
  // (an old holder's status: dropped by (gen, rev))
  const h0 = o2.holder;
  ch.postMessage({ t: "status", ns, epoch, gen: 1, rev: 99, snapshot: { state: "offline" } });
  await sleep(200);
  check(o2.view().s.state === "synced" && o2.holder.gen === h0.gen, "tabs: an old holder's message dropped");
  ch.close();
  s.dispose();
  o2.destroy();
  o1.destroy();
}

/** The front has dropped an ack since its log was last reset: the op was sent and its answer withheld. */
const ackDropped = async () => (await ctl("log")).got.some((g) => g.t === "ack" && g.dropped);

/** What s5Rows saw, said only when one of its checks fails: the rows' icons, each identity's outbox records and pending
 * state, the scan's watermark, the client, and what the front sent and answered since its log was reset */
async function rowsWhy(w, owner, ids) {
  const ns = (await metaGet(w.ws, "sync:current"))?.ns;
  const outbox = await all(w.ws, "outbox"), pending = await all(w.ws, "pending");
  return J({
    up: [...(await W.rowIcons(w, ids, [])).up].map((id) => ids.indexOf(id)),
    ids: ids.map((id) => ({ recs: outbox.filter((x) => x.id === id).map((x) => ({ dseq: x.dseq, lseq: x.lseq, op: x.op.op, accepted: x.accepted })), pending: pending.find((x) => x.id === id) })),
    scanned: await metaGet(w.ws, `sync:${ns}:scanned`), last: await w.lastSeq(), status: owner.view(),
    refused: await metaGet(w.ws, `sync:${ns}:refused`), rebuild: await metaGet(w.ws, `sync:${ns}:rebuild`),
    client: owner.client?.debug(), stats: owner.client && { connects: owner.client.stats.connects, opsMessages: owner.client.stats.opsMessages },
    front: await ctl("log").then((l) => ({ sockets: l.sockets, open: l.open, sent: l.sent.filter((m) => m.t === "ops" || m.t === "hello").map((m) => m.t === "ops" ? "ops:" + m.dseqs.join(",") : "hello"), acks: l.got.filter((g) => g.t === "ack" || g.t === "error").map((g) => g.t + (g.dropped ? "(dropped)" : "") + (g.code ? ":" + g.code : "") + (g.t === "ack" && Array.isArray(g.ops) ? "[" + g.ops.map((o) => o.dseq).join(",") + "]" : "")) })),
  });
}

async function s5Rows() {
  // (↑ for every op kind until its own ack; one transaction; at most ROWICON.max identities)
  await account();
  const w = await fresh();
  const owner = W.SyncOwner.of(w, { origin: location.origin });
  owner.start();
  const el = document.createElement("div");
  const s = W.syncSection(w, el, hostOf(w));
  await until(() => /Turn on sync/.test(buttons(el).join()), 5000);
  [...el.querySelectorAll("button")].find((b) => /Turn on sync/.test(b.textContent)).click();
  check(await until(() => owner.view().s.state === "synced", 15_000), "rows: synced");
  await ctl("log", { reset: true });
  // (the client may send the two ops in one message or in two: EVERY ack they go up in is withheld, as one acked
  // message would have the client pull the log, and the echo there decides both (the server decides in dseq order),
  // which would clear both ↑ before they are looked at; at most two, and the hold is lifted before the resend)
  await ctl("set", { set: { dropAcks: 2 } });
  const d = await w.mkdir("/r1");
  const f = await w.create("/r1/f.txt", { content: "x" });
  // (closed only once both ops were sent and every ack they went up in was dropped: an ↑ shows as soon as the op is
  // logged, before it is sent)
  const allWithheld = async () => {
    const l = await ctl("log");
    const sent = l.sent.filter((m) => m.t === "ops");
    return sent.flatMap((m) => m.dseqs).length >= 2 && l.got.filter((g) => g.t === "ack" && g.dropped).length === sent.length;
  };
  const withheld = await until(allWithheld, 10_000);
  check(withheld, "rows: the acks withheld by the front" + (withheld ? "" : " " + (await rowsWhy(w, owner, [d.ident, f.ident]))));
  const both = await until(async () => (await W.rowIcons(w, [d.ident, f.ident], [])).up.size === 2, 5000);
  check(both, "rows: a mkdir and a create waiting (scanned, sent, ack withheld): ↑ on both" + (both ? "" : " " + (await rowsWhy(w, owner, [d.ident, f.ident]))));
  // (the hold lifted (one ack of the two may be left, when they went in one message), then the resend)
  await ctl("set", { set: { dropAcks: 0 } });
  await ctl("closeAll");
  const resent = await until(async () => (await W.rowIcons(w, [d.ident, f.ident], [])).up.size === 0, 15_000);
  check(resent, "rows: after the resend and its ack: cleared" + (resent ? "" : " " + (await rowsWhy(w, owner, [d.ident, f.ident]))));
  await ctl("log", { reset: true });
  await ctl("set", { set: { dropAcks: 1 } });
  await w.rename("/r1", "/r2");
  const renameWithheld = await until(ackDropped, 10_000);
  check(renameWithheld, "rows: the rename sent, its ack withheld by the front" + (renameWithheld ? "" : " " + (await rowsWhy(w, owner, [d.ident]))));
  const renaming = await until(async () => (await W.rowIcons(w, [d.ident], [])).up.has(d.ident), 5000);
  check(renaming, "rows: an undecided rename on a folder whose mkdir was accepted: ↑" + (renaming ? "" : " " + (await rowsWhy(w, owner, [d.ident]))));
  await ctl("closeAll");
  const cleared = await until(async () => !(await W.rowIcons(w, [d.ident], [])).up.has(d.ident), 15_000);
  const why = cleared ? "" : await rowsWhy(w, owner, [d.ident]);
  check(cleared, "rows: …cleared at its own ack " + why);
  const many = Array.from({ length: 1100 }, (_, i) => "0123456789abcd" + String(i).padStart(4, "0"));
  check((await W.rowIcons(w, many, [])).up.size === 0 && W.ROWICON.max === 1005, "rows: 1,100 identities asked: read at most 1,005, one transaction");
  s.dispose();
  owner.destroy();
}

// ---- step 5, review round 1 (#130): astra3's CORR-PR130-1/2, daybreak3's CORR-PR130-1 and TEST-PR130-2

/** A gate: a promise and the function that opens it. */
function gate() { let open; const p = new Promise((ok) => (open = ok)); return { p, open }; }
/** A namespace of this device's shape: `lead` repeated as the account, then the generation. */
const nsFor = (w, lead, gen = 1) => `${lead.repeat(64)}:${gen}:${w.device}`;
const click = (el, re) => [...el.querySelectorAll("button")].find((b) => re.test(b.textContent)).click();

async function s5Races() {
  // (astra3's CORR-PR130-1: a late delete or enable answer is applied here only if this browser's lifecycle is still
  // the one the action saw; another tab's newer lifecycle is never turned off or replaced)
  const status = { available: true, state: "active", generation: 3, limit_bytes: 1000, used_bytes: 10 };
  const lease = (w) => metaGet(w.ws, "sync:current");
  const delCase = async (answer, what, change) => {
    const w = await fresh();
    await W.switchTo(w, nsFor(w, "a"));
    let st = { ...status };
    const el = document.createElement("div"), srv = fakeServer(() => st), g = gate();
    srv.next = [{ ...answer, gate: g.p }];
    const s = W.syncSection(w, el, hostOf(w), { fetch: srv.fetch });
    await until(() => /Delete my synced data/.test(buttons(el).join()), 3000);
    click(el, /Delete my synced data/);
    await until(() => srv.deletes.length === 1, 3000);
    // (meanwhile, another tab of this browser turns on B: a newer lifecycle in the shared workspace)
    const nsB = nsFor(w, "b");
    if (change) await W.switchTo(w, nsB);
    if (answer.throw) st = { ...status, state: "deleting" };
    g.open();
    await until(() => /changed meanwhile|Deleting your synced data|no synced data/.test(text(el) + buttons(el).join()), 3000);
    await sleep(100);
    const l = await lease(w);
    if (change) check(l.ns === nsB && !l.off && /changed meanwhile/.test(text(el)), `races: delete answered ${what} after another tab turned on B: B left on, and said: ` + J({ l, note: text(el).slice(0, 160) }));
    else check(l.off === true, `races: delete answered ${what}, nothing changed meanwhile: sync off here, as before: ` + J(l));
    s.dispose();
  };
  await delCase({ status: 202, body: { state: "deleting" } }, "deleting", true);
  await delCase({ status: 202, body: { state: "none" } }, "none", true);
  await delCase({ throw: true }, "lost (status then says deleting)", true);
  await delCase({ status: 202, body: { state: "deleting" } }, "deleting", false);
  // (a late enable, the panel closed meanwhile too: never replaces a newer lifecycle; with nothing changed, applied)
  for (const change of [true, false]) {
    const w = await fresh();
    const el = document.createElement("div"), srv = fakeServer({ available: true, state: "off", limit_bytes: null, used_bytes: 0 }), g = gate();
    srv.next = [{ status: 200, body: { state: "active", generation: 9 }, gate: g.p }];
    const s = W.syncSection(w, el, hostOf(w), { fetch: srv.fetch });
    await until(() => /Turn on sync/.test(buttons(el).join()), 3000);
    click(el, /Turn on sync/);
    await until(() => srv.posts.length === 1, 3000);
    const nsB = nsFor(w, "e");
    if (change) await W.switchTo(w, nsB);
    s.dispose();
    g.open();
    await sleep(300);
    const l = await lease(w);
    if (change) check(l.ns === nsB && !l.off, "races: an enable answered after another tab turned on B (the panel closed): B kept: " + J(l));
    else check(l && /:9:/.test(l.ns) && !l.off, "races: an enable answered with nothing changed meanwhile: applied: " + J(l));
  }
  // (astra3's CORR-PR130-3, their sequence: A's delete loses its answer; the follow-up status read is held after /me;
  // another tab switches this browser to B, whose limit is 2,000; A's "off, limit 1,000" status is then released.  It
  // is never applied: not to the lease, not to the plan's limit (what the holder publishes), not to the panel; the
  // status is asked afresh and B's applied)
  {
    const w = await fresh();
    const H = await hashOf("acct-x"), nsA = `${H}:3:${w.device}`, nsB = `${H}:4:${w.device}`;
    await W.switchTo(w, nsA);
    const owner = W.SyncOwner.of(w);
    let st = { ...status };
    const el = document.body.appendChild(document.createElement("div")), srv = fakeServer(() => st);
    srv.next = [{ throw: true }];
    const s = W.syncSection(w, el, hostOf(w), { fetch: srv.fetch });
    await until(() => /Delete my synced data/.test(buttons(el).join()), 3000);
    const held = gate(), after = gate();
    const r0 = srv.statusReads;
    srv.statusGates.push(held.p, after.p);
    click(el, /Delete my synced data/);
    check(await until(() => srv.deletes.length === 1 && srv.statusReads > r0, 3000), "races: the lost delete's status read begun, held");
    await W.switchTo(w, nsB);
    owner.limit = { limit_bytes: 2000, used_bytes: 5 };
    st = { available: true, state: "off", limit_bytes: 1000, used_bytes: 10 };
    held.open();
    await sleep(300);
    const l = await lease(w);
    check(l.ns === nsB && !l.off && owner.limit?.limit_bytes === 2000 && /Delete my synced data/.test(buttons(el).join()) && !/no synced data/.test(text(el)), "races: A's stale status after the switch to B: B left on, B's limit kept (the publication's source), the panel not drawn from it: " + J({ l, limit: owner.limit, buttons: buttons(el), text: text(el).slice(0, 160) }));
    st = { available: true, state: "active", generation: 4, limit_bytes: 2000, used_bytes: 5 };
    after.open();
    check(await until(() => /changed meanwhile/.test(text(el)) && /Delete my synced data/.test(buttons(el).join()) && owner.limit?.limit_bytes === 2000 && srv.statusReads >= r0 + 2, 3000), "races: …the status asked afresh, B's applied, the change said: " + J({ limit: owner.limit, reads: srv.statusReads - r0, text: text(el).slice(0, 200) }));
    s.dispose();
    el.remove();
  }
  // (a status is the account's: its limit is never taken for this browser's sync on another account's namespace)
  {
    const w = await fresh();
    await W.switchTo(w, nsFor(w, "c"));
    const owner = W.SyncOwner.of(w);
    owner.limit = null;
    const el = document.createElement("div"), srv = fakeServer({ ...status });
    const s = W.syncSection(w, el, hostOf(w), { fetch: srv.fetch });
    await until(() => /Delete my synced data/.test(buttons(el).join()), 3000);
    check(!owner.limit, "races: a status of account x while this browser syncs another account's namespace: its limit not taken: " + J(owner.limit));
    s.dispose();
  }
}

async function s5DetailsGap() {
  // (daybreak3's CORR-PR130-1-R2: the draw's generation checked after every await: a details read completing after its
  // draw went stale (the panel closed, or redrawn) starts nothing more, not even the second durable read)
  const w = await fresh();
  await W.switchTo(w, nsFor(w, "d"));
  const owner = W.SyncOwner.of(w), durable = owner.durable;
  let durables = 0;
  owner.durable = function () { durables++; return durable.call(this); };
  try {
    const reads = [];
    const readDetails = () => { const g = gate(); reads.push(g); return g.p; };
    const result = (n) => [{ count: n, paths: [["/g" + n, "conflict"]] }, []];
    const el = document.body.appendChild(document.createElement("div")), srv = fakeServer({ available: true, state: "active", generation: 2 });
    const s = W.syncSection(w, el, hostOf(w), { fetch: srv.fetch, readDetails });
    check(await until(() => reads.length === 1, 3000), "details gap: the draw's read begun");
    // (stale exactly in the gap: closed while the read is pending)
    s.dispose();
    const d0 = durables;
    reads[0].open(result(1));
    await sleep(200);
    check(durables === d0, `details gap: closed between the read and the second durable read: that read never begun (${durables - d0} begun)`);
    // (redrawn in the gap: the older draw's completion begins nothing; the newer one's runs and renders)
    const el2 = document.body.appendChild(document.createElement("div"));
    const s2 = W.syncSection(w, el2, hostOf(w), { fetch: srv.fetch, readDetails });
    await until(() => reads.length === 2, 3000);
    s2.refresh();
    await until(() => reads.length === 3, 3000);
    const d1 = durables;
    reads[1].open(result(2));
    await sleep(200);
    check(durables === d1, `details gap: redrawn between the read and the second durable read: the older draw began no read (${durables - d1} begun)`);
    reads[2].open(result(3));
    check(await until(() => /3 items sync kept aside/.test(text(el2)), 3000) && durables === d1 + 1 && !/2 items/.test(text(el2)), "details gap: …the newest draw's completion reads and renders: " + text(el2).slice(0, 120));
    s2.dispose();
    el.remove();
    el2.remove();
  } finally {
    owner.durable = durable;
  }
}

async function s5Refused() {
  // (sync-docs' follow-up, @sagebrush's calls: a change the server refused never leaves the foot at "Synced" alone.  The
  // foot counts the refusals nobody has looked at and points to their list; the list shows every one kept; opening it
  // marks them looked at by number (never by clock), the mark only moving on; the count goes, the list stays open)
  const now = Date.now();
  check(W.foot({ state: "synced" }, now, 1) === `Synced · 1 change couldn't sync (see "the server refused" below)` && W.foot({ state: "synced" }, now, 0) === "Synced" && W.foot({ state: "off" }, now, 3) === "Sync off" && /· 2 changes couldn't sync/.test(W.foot({ state: "offline", waiting: 1 }, now, 2)), "refused: the foot's words with and without unseen refusals, never when sync is off");
  const rs = [{ dseq: 1, code: "conflict", path: "/a.txt", at: 10, n: 1 }, { dseq: 2, code: "too_large", path: "/b.bin", at: 20, n: 2 }, { dseq: 3, code: "x", path: "", at: 20, n: 3 }];
  // (by number: two at the same time, or a clock that went back, still counted; one without a number (kept before
  // refusals were numbered) isn't new)
  check(W.unseenRefusals(rs, 0) === 3 && W.unseenRefusals(rs, 2) === 1 && W.unseenRefusals(rs, 3) === 0 && W.unseenRefusals(undefined, 0) === 0 && W.unseenRefusals([{ dseq: 9, code: "c", path: "", at: 99 }], 0) === 0 && W.unseenRefusals([{ ...rs[0], at: 5, n: 7 }], 6) === 1, "refused: unseenRefusals counts by number after the mark, ties and older clocks included");
  const w = await fresh();
  const ns = nsFor(w, "e");
  await W.switchTo(w, ns);
  // (this browser's sync on and synced, as the owner's view says, with no client of its own: the panel draws the foot)
  const owner = W.SyncOwner.of(w), view = owner.view;
  owner.view = () => ({ from: "own", s: { state: "synced" } });
  try {
    const marks = [];
    // (the mark as the meta would keep it: a redraw after opening reads the new one)
    const readDetails = async () => [undefined, rs, marks.length ? marks.at(-1)[1] : 1];
    const markSeen = async (n, m) => { marks.push([n, m]); };
    const el = document.body.appendChild(document.createElement("div")), srv = fakeServer({ available: true, state: "active", generation: 2 });
    const s = W.syncSection(w, el, hostOf(w), { fetch: srv.fetch, readDetails, markSeen });
    const seen = await until(() => /2 changes couldn't sync/.test(text(el)), 3000);
    const first = el.querySelector("details.sync-refused");
    check(seen && /Sync is on: Synced · 2 changes couldn't sync \(see "the server refused" below\)/.test(text(el)) && /3 changes the server refused \(3 shown of 3 kept, 2 new\)/.test(text(el)) && first?.querySelectorAll(".sync-refused-rows > div").length === 3 && !first.open, "refused: the foot counts the 2 after the mark and points to the list, which shows all 3 kept and says so: " + text(el).slice(0, 200));
    // (opened as a person would, the list as drawn now: a poll's redraw may have replaced the one found first)
    const opened = () => { const l = el.querySelector("details.sync-refused"); if (l && !l.open) l.open = true; return l; };
    const cleared = await until(() => { opened(); return marks.length > 0 && !/couldn't sync/.test(text(el)); }, 3000);
    const list = el.querySelector("details.sync-refused");
    check(cleared && J(marks) === J([[ns, 3]]) && !!list?.open && /Sync is on: Synced/.test(text(el)) && /3 changes the server refused \(3 shown of 3 kept\)/.test(text(el)) && !/new\)/.test(text(el)), "refused: opening the list marks up to the newest number (3), the foot's count goes, the list stays open with all 3: " + J(marks) + " " + text(el).slice(0, 200));
    s.dispose();
    // (nothing unseen: the foot as before, no mark written on opening)
    const el2 = document.body.appendChild(document.createElement("div"));
    const s2 = W.syncSection(w, el2, hostOf(w), { fetch: srv.fetch, readDetails: async () => [undefined, rs, 3], markSeen });
    await until(() => !!el2.querySelector("details.sync-refused"), 3000);
    for (let i = 0; i < 5; i++) { const l = el2.querySelector("details.sync-refused"); if (l) l.open = true; await sleep(100); }
    check(!/couldn't sync/.test(text(el2)) && marks.length === 1 && /Sync is on/.test(text(el2)), "refused: all seen: the foot without a count, opening writes no mark: " + text(el2).slice(0, 160));
    s2.dispose();
    // (the panel's own meta, no seams: the refusals and the mark as the client and the panel keep them; the mark raised
    // on opening, and never taken back by a panel that read an older list)
    const metaPut = (k, v) => new Promise((ok, no) => { const tx = w.ws.transaction("meta", "readwrite"); tx.objectStore("meta").put(v, k); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
    await metaPut(`sync:${ns}:refused`, rs);
    await metaPut(`sync:${ns}:refusedSeen`, 1);
    const el3 = document.body.appendChild(document.createElement("div"));
    const s3 = W.syncSection(w, el3, hostOf(w), { fetch: srv.fetch });
    const counted = await until(() => /2 changes couldn't sync/.test(text(el3)), 3000);
    const raised = await until(async () => { const l = el3.querySelector("details.sync-refused"); if (l && !l.open) l.open = true; return (await metaGet(w.ws, `sync:${ns}:refusedSeen`)) === 3; }, 3000);
    check(counted && raised && (await until(() => !/couldn't sync/.test(text(el3)), 3000)), "refused: the panel's own meta: counted from it, the mark raised to 3 in it on opening, the count gone");
    s3.dispose();
    // (raiseSeen, the panel's writer: raised, never lowered (a racing panel's older list), nothing else written)
    await metaPut(`sync:${ns}:refusedSeen`, 9);
    await W.raiseSeen(w.ws, ns, 6);
    const kept9 = await metaGet(w.ws, `sync:${ns}:refusedSeen`);
    await W.raiseSeen(w.ws, ns, 12);
    const now12 = await metaGet(w.ws, `sync:${ns}:refusedSeen`);
    await W.raiseSeen(w.ws, ns, NaN);
    check(kept9 === 9 && now12 === 12 && (await metaGet(w.ws, `sync:${ns}:refusedSeen`)) === 12, "refused: raiseSeen only moves the mark on: 9 stays 9 over 6, then 12; NaN ignored: " + J({ kept9, now12 }));
    for (const e of [el, el2, el3]) e.remove();
  } finally {
    owner.view = view;
  }
}

async function s5ConfirmFetched() {
  // (@sagebrush's ruling (b) on the backlog's item 3: turning sync on again where it was used before, the confirm says
  // the files may include ones fetched from other devices; a device that never used sync says nothing of it)
  const said = {};
  for (const [name, used, files] of [["used", true, 1], ["usedNoFiles", true, 0], ["never", false, 1]]) {
    const w = await fresh();
    for (let i = 0; i < files; i++) await w.create(`/f${i}.txt`, { content: "x" });
    const owner = W.SyncOwner.of(w), view = owner.view;
    owner.view = () => ({ from: "own", s: used ? { state: "off", used: true } : { state: "off" } });
    const srv = fakeServer({ available: true, state: "off", limit_bytes: null, used_bytes: 0 });
    let asked = null;
    const host = { ...hostOf(w), confirm: (t) => { asked = t; return false; } };
    const el = document.body.appendChild(document.createElement("div"));
    const sec = W.syncSection(w, el, host, { fetch: srv.fetch });
    try {
      await until(() => /Turn on sync/.test(buttons(el).join()), 5000);
      [...el.querySelectorAll("button")].find((b) => /Turn on sync/.test(b.textContent)).click();
      await until(() => asked !== null, 3000);
      said[name] = asked;
    } finally {
      sec.dispose();
      el.remove();
      owner.view = view;
    }
  }
  const phrase = "(files fetched from your other devices included)";
  check(typeof said.used === "string" && /^Turn on sync\?\n1 data file \(/.test(said.used) && said.used.includes("will be uploaded " + phrase + "."), "turn-on confirm: used here before, with files: the fetched files said: " + J(said.used));
  check(typeof said.usedNoFiles === "string" && /^Turn on sync\?\n0 data files/.test(said.usedNoFiles) && /will be uploaded\. /.test(said.usedNoFiles) && !said.usedNoFiles.includes(phrase), "turn-on confirm: used here before, no files: not beside \"0 data files\": " + J(said.usedNoFiles));
  check(typeof said.never === "string" && /will be uploaded\. /.test(said.never) && !said.never.includes(phrase), "turn-on confirm: never used: not said: " + J(said.never));
}

async function s5SidebarLine() {
  // (sync-docs' follow-up on #375: the Files sidebar's line says the notebooks too, as the panel's foot does: those this
  // page's document sync stopped, and, while offline or syncing, those with edits waiting (readNotebooks, shared))
  const now = Date.now();
  const line = W.sidebarLine({ state: "offline", waiting: 2 }, now, { waiting: 3, stopped: 1 });
  check(line === "Offline: 2 changes and edits in 3 notebooks wait · 1 notebook can't sync" && W.sidebarLine({ state: "off", used: true }, now, { waiting: 3, stopped: 1 }) === "Sync off", "sidebar line: the notebooks' words while on, none when off: " + J(line));
  let state = "offline", reads = 0, answer = { ids: ["n1", "n2", "n3"], over: false };
  const fake = { view: () => ({ s: { state } }), stoppedDocs: () => ["n3"] };
  const read = async () => { reads++; if (answer === "fail") throw new Error("x"); return answer; };
  const r = {};
  r.offline = await W.readNotebooks(fake, read);
  state = "synced"; const r0 = reads; r.synced = await W.readNotebooks(fake, read); r.syncedReads = reads - r0;
  state = "syncing"; answer = { ids: [], over: true }; r.over = await W.readNotebooks(fake, read);
  answer = "fail"; r.failed = await W.readNotebooks(fake, read);
  r.none = await W.readNotebooks({ view: () => ({ s: { state: "synced" } }), stoppedDocs: () => [] }, read);
  check(J(r.offline) === J({ waiting: 2, stopped: 1 }) && J(r.synced) === J({ waiting: 0, stopped: 1 }) && r.syncedReads === 0 && J(r.over) === J({ waiting: 0, stopped: 1, unknown: true }) && J(r.failed) === J({ waiting: 0, stopped: 1, unknown: true }) && r.none === undefined, "readNotebooks: offline counted less the stopped; synced reads nothing, the stopped said; over and failed unknown; nothing to say, none: " + J(r));
  // (the Files sidebar, mounted: its line reads the owner's view and the notebooks; a stopped notebook is said there)
  const w = await fresh();
  await W.switchTo(w, nsFor(w, "e"));
  const owner = W.SyncOwner.of(w), view = owner.view, stoppedDocs = owner.stoppedDocs;
  owner.view = () => ({ from: "own", s: { state: "offline", waiting: 2 } });
  owner.stoppedDocs = () => ["n3"];
  const el = document.body.appendChild(document.createElement("div"));
  let b = null;
  try {
    b = W.mountBrowser(el, { ws: w, open: () => {} });
    const fsync = () => el.querySelector(".fsync")?.textContent ?? "";
    const said = await until(() => /can't sync/.test(fsync()), 3000);
    check(said && /^Offline: 2 changes.* wait · 1 notebook can't sync$/.test(fsync()), "sidebar line, mounted: the stopped notebook said: " + J(fsync()));
  } finally {
    b?.destroy();
    el.remove();
    owner.view = view;
    owner.stoppedDocs = stoppedDocs;
  }
}

async function s5SidebarStale() {
  // (sync-docs' N-SC-1: a read begun for an older state never paints over a newer line: a read started while offline,
  // resolved after sync was turned off here, leaves "Sync off")
  const w = await fresh();
  await W.switchTo(w, nsFor(w, "e"));
  const owner = W.SyncOwner.of(w), view = owner.view, stoppedDocs = owner.stoppedDocs;
  let s = { state: "offline", waiting: 2 }, release = null, reads = 0;
  owner.view = () => ({ from: "own", s });
  owner.stoppedDocs = () => [];
  const readUnacked = () => { reads++; return new Promise((ok) => { release = ok; }); };
  const el = document.body.appendChild(document.createElement("div"));
  let b = null;
  try {
    b = W.mountBrowser(el, { ws: w, open: () => {}, readUnacked });
    const fsync = () => el.querySelector(".fsync")?.textContent ?? "";
    const pending = await until(() => !!release && /^Offline/.test(fsync()), 3000);
    // (sync turned off here meanwhile: the owner's view changes and the line is drawn again)
    s = { state: "off", used: true };
    owner.changed();
    const off = await until(() => fsync() === "Sync off", 3000);
    release({ ids: ["n1", "n2"], over: false });
    await sleep(200);
    check(pending && off && reads === 1 && fsync() === "Sync off", "sidebar line: a read begun while offline, resolved after sync went off, never paints over \"Sync off\": " + J({ pending, off, reads, line: fsync() }));
  } finally {
    release?.({ ids: [], over: false });
    b?.destroy();
    el.remove();
    owner.view = view;
    owner.stoppedDocs = stoppedDocs;
  }
}

async function s5Notebooks() {
  // (follow-up 3, @sagebrush's (C): the foot counts notebooks with edits waiting while offline or syncing, says those
  // this page's document sync stopped as "can't sync", says "notebook edits" when they can't be counted, and nothing for
  // none; never "patches")
  const now = Date.now();
  const words = {
    both: W.foot({ state: "offline", waiting: 2 }, now, 0, { waiting: 3, stopped: 0 }),
    one: W.foot({ state: "offline", waiting: 0 }, now, 0, { waiting: 1, stopped: 0 }),
    unknown: W.foot({ state: "offline", waiting: 2 }, now, 0, { waiting: 0, stopped: 0, unknown: true }),
    none: W.foot({ state: "offline", waiting: 0 }, now, 0, { waiting: 0, stopped: 0 }),
    syncing: W.foot({ state: "syncing", waiting: 1 }, now, 0, { waiting: 2, stopped: 0 }),
    stopped: W.foot({ state: "synced" }, now, 0, { waiting: 0, stopped: 1 }),
    all: W.foot({ state: "offline", waiting: 1 }, now, 2, { waiting: 1, stopped: 2 }),
    off: W.foot({ state: "off" }, now, 1, { waiting: 1, stopped: 1 }),
    before: W.foot({ state: "offline", waiting: 1 }, now),
  };
  check(words.both === "Offline: 2 changes and edits in 3 notebooks wait" && words.one === "Offline: edits in 1 notebook wait" && words.unknown === "Offline: 2 changes and notebook edits wait" && words.none === "Offline: 0 changes wait" && words.syncing === "Syncing 1 change and edits in 2 notebooks…" && words.stopped === "Synced · 1 notebook can't sync" && words.all === `Offline: 1 change and edits in 1 notebook wait · 2 notebooks can't sync · 2 changes couldn't sync (see "the server refused" below)` && words.off === "Sync off" && words.before === "Offline: 1 change wait" && !/patch/.test(J(words)), "notebooks: the foot's words: " + J(words));
  const w = await fresh();
  await W.switchTo(w, nsFor(w, "e"));
  const owner = W.SyncOwner.of(w), view = owner.view, stoppedDocs = owner.stoppedDocs;
  let state = "offline", reads = 0, answer = { ids: ["n1", "n2", "n3"], over: false };
  owner.view = () => ({ from: "own", s: { state, waiting: 2 } });
  owner.stoppedDocs = () => ["n3"];
  const readUnacked = async () => { reads++; if (answer === "fail") throw new Error("x"); return answer; };
  const srv = fakeServer({ available: true, state: "active", generation: 2 });
  const drawn = async (st) => {
    state = typeof st === "string" ? st : state;
    const el = document.body.appendChild(document.createElement("div"));
    const s = W.syncSection(w, el, hostOf(w), { fetch: srv.fetch, readDetails: async () => [undefined, [], 0], readUnacked });
    await until(() => !!el.querySelector(".sync-details") && /Sync is on/.test(text(el)), 3000);
    // (every draw here has a stopped notebook: the foot's final words, after the count, say it can't sync)
    await until(() => /can't sync/.test(el.querySelector(".sync-foot")?.textContent ?? ""), 3000);
    const t = el.querySelector(".sync-foot")?.textContent ?? "";
    s.dispose();
    el.remove();
    return t;
  };
  try {
    // (offline: the waiting ones less the stopped one, and the stopped one said apart)
    const off1 = await drawn("offline"), r1 = reads;
    // (synced: no count read at all; the stopped one still said)
    const syn = await drawn("synced"), r2 = reads;
    // (too many to count, or the read failing: "notebook edits", the foot drawn all the same)
    answer = { ids: [], over: true };
    const over = await drawn("offline");
    answer = "fail";
    const failed = await drawn("offline");
    check(off1 === "Sync is on: Offline: 2 changes and edits in 2 notebooks wait · 1 notebook can't sync" && r1 >= 1 && syn === "Sync is on: Synced · 1 notebook can't sync" && r2 === r1 && over === "Sync is on: Offline: 2 changes and notebook edits wait · 1 notebook can't sync" && failed === over, "notebooks: the panel's foot: offline counted less the stopped, synced read nothing, over and failed say \"notebook edits\": " + J({ off1, syn, over, failed, reads: [r1, r2] }));
  } finally {
    owner.view = view;
    owner.stoppedDocs = stoppedDocs;
  }
}

async function s5Wire() {
  // (daybreak3's TEST-PR130-2-R2: a status publication within STATUS_PUB.maxBytes, the whole serialized message
  // measured, UTF-8: a maximum-width namespace, the largest numbers, every optional field, and long reasons, of ASCII,
  // of 4-byte characters, mixed and random; the reason cut by code points to the longest that fits)
  const MAX = Number.MAX_SAFE_INTEGER;
  const ns = `${"f".repeat(64)}:${"9".repeat(15)}:${"e".repeat(16)}`;
  const bytes = (m) => new TextEncoder().encode(JSON.stringify(m)).length;
  const hexr = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n / 2)), (b) => b.toString(16).padStart(2, "0")).join("");
  const reasons = { ascii: "x".repeat(2000), astral: "\u{1F600}".repeat(600), mixed: Array.from({ length: 900 }, (_, i) => ["a", "\u00e9", "\u6f22", "\u{1F600}"][i % 4]).join(""), random: hexr(1500), quotes: '"\\'.repeat(400) };
  const out = {};
  for (const [k, reason] of Object.entries(reasons)) {
    const m = W.statusMessage(ns, MAX, MAX, MAX, { state: "offline", waiting: MAX, reason, lastSynced: MAX, resumesAt: MAX, full: true, limit: { limit_bytes: MAX, used_bytes: MAX } });
    const n = bytes(m), r = m.snapshot.reason ?? "";
    out[k] = n;
    check(n <= W.STATUS_PUB.maxBytes && n > W.STATUS_PUB.maxBytes - 16 && m.t === "status" && m.ns === ns && m.rev === MAX && reason.startsWith(r) && r.length > 0 && !/[\ud800-\udbff]$/.test(r), `wire: ${k} reason: the whole message ${n} UTF-8 bytes (at most ${W.STATUS_PUB.maxBytes}), its reason cut to ${Array.from(r).length} code points, whole ones`);
  }
  // (a short one untouched)
  const m = W.statusMessage(ns, 1, 2, 3, { state: "synced", reason: "ok" });
  check(m.snapshot.reason === "ok" && bytes(m) <= W.STATUS_PUB.maxBytes, "wire: a message that fits is sent as it is: " + J(out));
}

async function s5Takeover() {
  // (astra3's CORR-PR130-2: the holder's connection drops and another tab takes the lock while it rediscovers; the
  // former holder follows the new holder's foot and publishes nothing, even asked)
  await account();
  const nm = names();
  const w1 = await fresh(nm), w2 = await fresh(nm);
  const o1 = W.SyncOwner.of(w1, { origin: location.origin });
  o1.start();
  const el = document.createElement("div");
  const s = W.syncSection(w1, el, hostOf(w1));
  await until(() => /Turn on sync/.test(buttons(el).join()), 5000);
  click(el, /Turn on sync/);
  check(await until(() => o1.view().s.state === "synced" && o1.isHolder(), 15_000), "takeover: the first tab holds and syncs");
  const o2 = W.SyncOwner.of(w2, { origin: location.origin });
  o2.start();
  check(await until(() => o2.client !== null && !o2.isHolder(), 5000), "takeover: the second tab waits for the lock");
  await ctl("closeAll");
  check(await until(() => o2.isHolder() && !o1.isHolder() && o2.view().s.state === "synced", 20_000), "takeover: the second tab took the lock while the first rediscovered; the first no longer holds: " + J({ o1: o1.isHolder(), o2: o2.isHolder() }));
  check(await until(() => o1.view().from === "holder" && o1.view().s.state === "synced", 5000), "takeover: the former holder's foot follows the new holder: " + J(o1.view()));
  const p0 = o1.stats.published;
  const cur = await metaGet(w1.ws, "sync:current"), epoch = (await metaGet(w1.ws, "sync:epoch")) ?? 0;
  const ch = new BroadcastChannel(`sagebrush-sync-status:${w1.ws.name}:${cur.ns}`);
  ch.postMessage({ t: "status?", ns: cur.ns, epoch });
  await sleep(1500);
  ch.close();
  check(!o1.isHolder() && o1.stats.published === p0, "takeover: the former holder publishes nothing while it doesn't hold: " + J({ before: p0, after: o1.stats.published }));
  s.dispose();
  o2.destroy();
  o1.destroy();
}

async function s5Details() {
  // (daybreak3's CORR-PR130-1: details reads resolved out of order, across a lifecycle switch, after close: only the
  // newest draw's read renders, once, in its own container; nothing touches the panel after close; a failure is said)
  const w = await fresh();
  await W.switchTo(w, nsFor(w, "f"));
  const reads = [];
  const readDetails = () => { const g = gate(); reads.push(g); return g.p; };
  // (attached, as the panel is: a details box out of the document is never rendered into)
  const el = document.body.appendChild(document.createElement("div")), srv = fakeServer({ available: true, state: "active", generation: 2 });
  const s = W.syncSection(w, el, hostOf(w), { fetch: srv.fetch, readDetails });
  const result = (n) => [{ count: n, paths: [["/p" + n, "conflict"]] }, []];
  const blocks = () => [...el.querySelectorAll("details > summary")].map((d) => d.textContent);
  check(await until(() => reads.length >= 1, 3000), "details: the draw reads the details");
  const n1 = reads.length;
  s.refresh();
  await until(() => reads.length > n1, 3000);
  // (the newest first, then every older one: the older answers, resolved last, are dropped)
  reads.at(-1).open(result(2));
  await sleep(100);
  for (const r of reads.slice(0, -1)) r.open(result(1));
  await sleep(150);
  check(J(blocks()) === J(["2 items sync kept aside"]), "details: older reads resolved last never render; one block, the newest: " + J(blocks()));
  // (a read across a lifecycle switch: not rendered)
  const n2 = reads.length;
  s.refresh();
  await until(() => reads.length > n2, 3000);
  const across = reads.at(-1);
  await W.switchTo(w, nsFor(w, "9"));
  across.open(result(3));
  await sleep(150);
  check(!blocks().includes("3 items sync kept aside"), "details: a read across a lifecycle switch is not rendered: " + J(blocks()));
  // (a failed read: said in its own container, nothing unhandled)
  const n3 = reads.length;
  s.refresh();
  await until(() => reads.length > n3, 3000);
  for (const r of reads.slice(n3, -1)) r.open(result(4));
  reads.at(-1).open(Promise.reject(new Error("read failed")));
  await sleep(150);
  check(/sync details can't be read now/.test(text(el)) && blocks().length === 0, "details: a failed read is said in its container: " + text(el).slice(0, 160));
  // (closed with a read pending: nothing changes after)
  const n4 = reads.length;
  s.refresh();
  await until(() => reads.length > n4, 3000);
  const before = el.innerHTML;
  s.dispose();
  for (const r of reads.slice(n4)) r.open(result(9));
  await sleep(150);
  check(el.innerHTML === before, "details: reads resolved after close change nothing");
  el.remove();
}

async function s5Flood() {
  // (daybreak3's TEST-PR130-2, plan r4 §4: status? at 1,000 a second for 10 s; a follower opened during it answered by
  // the next slot; the holder killed during it and a waiting tab taking over; every publication within 512 UTF-8
  // bytes; at most one per STATUS_PUB.minGapMs per holder)
  await account();
  const nm = names();
  const w1 = await fresh(nm), w2 = await fresh(nm);
  // (the gap per holder is measured where the slot measures it: at each holder's send, on Date.now(), the clock its
  // lastAt uses.  An arrival on the tap is a delivery time: a page busy posting 100 status? a tick can hold one
  // publication back and deliver the next on time, so arrivals came closer than the slot sent them (TEST-PR130-2's
  // flake: 'the least gap per holder' under minGapMs - 50 with the slot intact).  Arrivals still give the count and
  // the bytes, the whole message as delivered)
  const sends = [];
  const sentBy = (o) => {
    const post = o.post.bind(o);
    o.post = (m) => {
      if (m?.t === "status") sends.push({ at: Date.now(), gen: m.gen });
      return post(m);
    };
    return o;
  };
  const o1 = sentBy(W.SyncOwner.of(w1, { origin: location.origin }));
  o1.start();
  const el = document.createElement("div");
  const s = W.syncSection(w1, el, hostOf(w1));
  await until(() => /Turn on sync/.test(buttons(el).join()), 5000);
  click(el, /Turn on sync/);
  check(await until(() => o1.view().s.state === "synced" && o1.isHolder(), 15_000), "flood: the first tab holds");
  const o2 = sentBy(W.SyncOwner.of(w2, { origin: location.origin }));
  o2.start();
  await until(() => o2.client !== null, 5000);
  const ns = (await metaGet(w1.ws, "sync:current")).ns, epoch = (await metaGet(w1.ws, "sync:epoch")) ?? 0;
  const name = `sagebrush-sync-status:${w1.ws.name}:${ns}`;
  const tap = new BroadcastChannel(name), flood = new BroadcastChannel(name);
  const pubs = [];
  tap.onmessage = (ev) => { if (ev.data?.t === "status") pubs.push({ at: performance.now(), gen: ev.data.gen, bytes: new TextEncoder().encode(JSON.stringify(ev.data)).length }); };
  const t0 = performance.now();
  let asked = 0, got = 0, o3 = null, killed = false, sent = 0;
  for (let tick = 0; tick < 100; tick++) {
    for (let i = 0; i < 100; i++) flood.postMessage({ t: "status?", ns, epoch });
    sent += 100;
    const now = performance.now() - t0;
    // (at 3 s a follower opens; at 6 s the holder dies)
    if (!o3 && now > 3000) {
      const w3 = await fresh(nm);
      o3 = sentBy(W.SyncOwner.of(w3, { origin: location.origin }));
      asked = performance.now();
      o3.start();
    }
    if (o3 && !got && o3.view().from === "holder") got = performance.now();
    if (!killed && now > 6000) { killed = true; o1.destroy(); }
    await sleep(Math.max(0, t0 + (tick + 1) * 100 - performance.now()));
  }
  const secs = (performance.now() - t0) / 1000;
  await sleep(1500);
  const leastGap = (xs) => {
    const by = {};
    for (const p of xs) (by[p.gen] ??= []).push(p.at);
    let g = Infinity;
    for (const ats of Object.values(by)) for (let i = 1; i < ats.length; i++) g = Math.min(g, ats[i] - ats[i - 1]);
    return g;
  };
  const byGen = {};
  for (const p of pubs) (byGen[p.gen] ??= []).push(p.at);
  // (the send gap allows Date.now()'s own millisecond: a send stamped just after the tick its lastAt was taken in)
  const gap = leastGap(sends), arrivalGap = leastGap(pubs);
  const maxBytes = Math.max(0, ...pubs.map((p) => p.bytes));
  check(sent === 10_000 && secs < 12 && pubs.length > 0 && sends.length > 0 && gap >= W.STATUS_PUB.minGapMs - 1 && maxBytes <= 512, `flood: ${sent} status? over ${secs.toFixed(1)} s: ${sends.length} publications sent (${pubs.length} arrived), the least gap per holder ${gap} ms at the sends (${W.STATUS_PUB.minGapMs}; ${Math.round(arrivalGap)} ms between arrivals), each at most ${maxBytes} UTF-8 bytes (512)`);
  check(got && got - asked <= 2000, `flood: the follower opened during it got the holder's snapshot ${Math.round(got - asked)} ms after starting (the next slot)`);
  const gens = Object.keys(byGen).map(Number), top = Math.max(...gens);
  check((o2.isHolder() || o3.isHolder()) && gens.length >= 2, "flood: the holder killed mid-flood: a waiting tab took over and published under a newer gen: " + J(gens));
  check(await until(() => [o2, o3].filter((o) => !o.isHolder()).every((o) => o.holder?.gen === top && o.view().from === "holder"), 3000), "flood: the followers follow the new holder");
  tap.close();
  flood.close();
  s.dispose();
  o3.destroy();
  o2.destroy();
}

async function s5Account() {
  // (astra3's CORR-PR130-4: the session's account and the status read together: the local lifecycle unchanged
  // (namespace A's), another tab signs in as B across the panel's read, (1) after /me answered A but before the status
  // is asked, (2) while A's status is in flight.  The answer is never taken as A's: B's limit never lands under A's
  // namespace, the status is asked again and is B's, and a delete then carries B's account with B's generation)
  const HA = await hashOf("acct-x"), HB = await hashOf("acct-y");
  for (const when of ["after /me", "status in flight"]) {
    const w = await fresh();
    await W.switchTo(w, `${HA}:3:${w.device}`);
    const owner = W.SyncOwner.of(w);
    const A = { available: true, state: "active", generation: 3, limit_bytes: 1000, used_bytes: 10 };
    const B = { available: true, state: "active", generation: 7, limit_bytes: 2000, used_bytes: 20 };
    const el = document.body.appendChild(document.createElement("div")), srv = fakeServer(() => (srv.me === "acct-x" ? A : B));
    const s = W.syncSection(w, el, hostOf(w), { fetch: srv.fetch });
    check(await until(() => owner.limit?.limit_bytes === 1000 && /Delete my synced data/.test(buttons(el).join()), 3000), `account (${when}): A's status applied first`);
    const g = gate(), m0 = srv.meReads, r0 = srv.statusReads;
    if (when === "after /me") srv.meGates.push(g.p);
    else {
      srv.statusEarly = true;
      srv.statusGates.push(g.p);
    }
    s.refresh();
    await until(() => (when === "after /me" ? srv.meReads > m0 : srv.statusReads > r0), 3000);
    srv.me = "acct-y";
    g.open();
    await sleep(300);
    srv.statusEarly = false;
    check(owner.limit?.limit_bytes === 1000 && srv.statusReads >= r0 + 2, `account (${when}): the session changed to B across the read: B's limit not taken under A's namespace, the status asked again: ` + J({ limit: owner.limit, statusReads: srv.statusReads - r0, meReads: srv.meReads - m0 }));
    await until(() => /Delete my synced data/.test(buttons(el).join()), 3000);
    click(el, /Delete my synced data/);
    await until(() => srv.deletes.length === 1, 3000);
    const d = srv.deletes[0];
    check(d && d.account === HB && d.generation === 7, `account (${when}): a delete then carries B's account with B's generation, never a mix: ` + J({ account: d?.account === HB ? "B" : d?.account === HA ? "A" : d?.account, generation: d?.generation }));
    s.dispose();
    el.remove();
  }
}

async function s5Echo() {
  // (astra3's CORR-PR130-4, A, B, A: /me answers A, the status is computed for B (its echo B's), /me answers A again.
  // The local lifecycle unchanged (A's).  The echo doesn't match: never applied, nothing taken, and asked again only
  // after the poll's backoff (no immediate retry); a matching echo applies (the control); an old server (no echo): the
  // answer shown, its limit not taken, no delete offered)
  const HA = await hashOf("acct-x");
  const w = await fresh();
  await W.switchTo(w, `${HA}:3:${w.device}`);
  const owner = W.SyncOwner.of(w);
  const A = { available: true, state: "active", generation: 3, limit_bytes: 1000, used_bytes: 10 };
  const B = { available: true, state: "active", generation: 7, limit_bytes: 2000, used_bytes: 20 };
  const el = document.body.appendChild(document.createElement("div")), srv = fakeServer(() => ((srv.statusAs ?? srv.me) === "acct-x" ? A : B));
  const s = W.syncSection(w, el, hostOf(w), { fetch: srv.fetch });
  check(await until(() => owner.limit?.limit_bytes === 1000 && /Delete my synced data/.test(buttons(el).join()), 3000), "echo: the control: A's status, its echo A's (the session's): applied, delete offered");
  const r0 = srv.statusReads;
  srv.statusAs = "acct-y";
  s.refresh();
  await until(() => srv.statusReads > r0, 3000);
  await sleep(600);
  check(owner.limit?.limit_bytes === 1000 && !/Delete my synced data/.test(buttons(el).join()) && srv.statusReads === r0 + 1, "echo: /me A, the status computed for B (echo B), /me A: not applied (B's limit not taken, no delete from it), and not asked again at once: " + J({ limit: owner.limit, reads: srv.statusReads - r0, text: text(el).slice(0, 120) }));
  srv.statusAs = null;
  check(await until(() => /Delete my synced data/.test(buttons(el).join()) && srv.statusReads >= r0 + 2, 8000) && owner.limit?.limit_bytes === 1000, "echo: …asked again after the backoff, A's status (echo A's) applied: " + J({ reads: srv.statusReads - r0 }));
  s.dispose();
  el.remove();
  // (an old server: no echo: the status shown, its limit not taken, no delete offered from it)
  const w2 = await fresh();
  await W.switchTo(w2, `${HA}:3:${w2.device}`);
  const owner2 = W.SyncOwner.of(w2);
  owner2.limit = null;
  const el2 = document.createElement("div"), srv2 = fakeServer({ ...A });
  srv2.echo = false;
  const s2 = W.syncSection(w2, el2, hostOf(w2), { fetch: srv2.fetch });
  check(await until(() => /Sync/.test(text(el2)) && srv2.statusReads >= 1, 3000) && (await sleep(200), true) && !owner2.limit && !/Delete my synced data/.test(buttons(el2).join()), "echo: an old server (no echo): shown, its limit not taken, no delete offered: " + J({ limit: owner2.limit, buttons: buttons(el2) }));
  s2.dispose();
}

async function s5Verified() {
  // (astra3's CORR-PR130-5: a verified delete of A whose answer is lost; the fallback status has no echo (an old,
  // mixed or rolled-back server), /me says A both times: nothing durable is done from it (A stays on, its epoch kept);
  // with A's echo it applies (the controls: off, and deleting followed); a followed deletion completes only on a
  // verified answer)
  const HA = await hashOf("acct-x");
  const A = { available: true, state: "active", generation: 3, limit_bytes: 1000, used_bytes: 10 };
  const one = async (echo, state) => {
    const w = await fresh();
    await W.switchTo(w, `${HA}:3:${w.device}`);
    let st = { ...A };
    const el = document.body.appendChild(document.createElement("div")), srv = fakeServer(() => st);
    const s = W.syncSection(w, el, hostOf(w), { fetch: srv.fetch });
    await until(() => /Delete my synced data/.test(buttons(el).join()), 3000);
    const e0 = (await metaGet(w.ws, "sync:epoch")) ?? 0;
    srv.next = [{ throw: true }];
    srv.echo = echo;
    st = { available: true, state, generation: 3 };
    click(el, /Delete my synced data/);
    await until(() => srv.deletes.length === 1, 3000);
    await sleep(500);
    const l = await metaGet(w.ws, "sync:current"), e1 = (await metaGet(w.ws, "sync:epoch")) ?? 0;
    return { w, el, s, srv, l, e0, e1, set: (v) => (st = v) };
  };
  for (const state of ["off", "deleting"]) {
    const r = await one(false, state);
    check(r.l && !r.l.off && r.e1 === r.e0 && /didn't say which account/.test(text(r.el)), `verified: a lost delete answer, the fallback status ${state} WITHOUT an echo (/me A twice): A left on, its epoch kept, said: ` + J({ off: r.l?.off, epoch: [r.e0, r.e1], text: text(r.el).slice(0, 160) }));
    r.s.dispose();
    r.el.remove();
  }
  for (const state of ["off", "deleting"]) {
    const r = await one(true, state);
    check(r.l?.off === true && r.e1 === r.e0 + 1 && (state === "off" || /Deleting your synced data/.test(buttons(r.el).join())), `verified: the control, the fallback status ${state} with A's echo: applied (sync off here, the epoch moved${state === "deleting" ? ", the deletion followed" : ""}): ` + J({ off: r.l?.off, epoch: [r.e0, r.e1], buttons: buttons(r.el) }));
    if (state === "deleting") {
      // (the followed deletion: an unverified "off" never completes it; a verified one does)
      const n0 = r.srv.statusReads;
      r.srv.echo = false;
      r.set({ available: true, state: "off" });
      await until(() => r.srv.statusReads > n0, 8000);
      await sleep(200);
      const notDone = !/was deleted/.test(text(r.el)) && /Deleting your synced data/.test(buttons(r.el).join());
      r.srv.echo = true;
      const done = await until(() => /was deleted/.test(text(r.el)), 10000);
      check(notDone && done, "verified: a followed deletion is not declared done on an unverified off, and is on a verified one: " + J({ notDone, done }));
    }
    r.s.dispose();
    r.el.remove();
  }
}

// ---- task #14: each op's sync state (plan-task14-is-op-confirmed r6, delta 1 r2): the ledger, syncState, waitSync,
// and the verbs' collectors

const signalOf = () => new AbortController().signal;
const settledYet = async (p, ms = 300) => Promise.race([p.then(() => true, () => true), sleep(ms).then(() => false)]);
const rawTx = (db, stores, f) => new Promise((ok, no) => { const tx = db.transaction(stores, "readwrite"); let out; Promise.resolve(f(tx)).then((v) => { out = v; }, (e) => { try { tx.abort(); } catch {} no(e); }); tx.oncomplete = () => ok(out); tx.onerror = () => no(tx.error); });
const rawPut = (db, store, v, k) => rawTx(db, [store], (tx) => { tx.objectStore(store).put(v, k); });
/** A namespace of this device's (the form welcome's has), its lease taken, its ledger seeded: no server needed. */
async function localNs(w, lead = "ab") {
  const ns = `${lead.padEnd(16, "0")}:1:${w.device}`;
  const lease = await W.switchTo(w, ns);
  const ob = new W.Outbox(w, lease);
  await ob.begin(await w.lastSeq());
  await W.seedLedger(w, ns, W.wireOf);
  return { ns, lease, ob };
}

async function t14Collect() {
  // (the six verbs' collectors: exactly the call's own commits, once, before it returns; sync on or off)
  const nm = names();
  const w = await fresh(nm);
  const seqsOf = async (col) => (await w.ops()).filter((o) => col.includes(o.seq)).map((o) => o.op + " " + o.path);
  const a = [], b = [], other = [];
  await Promise.all([w.create("/c1.txt", { content: "one", collect: a }), w.mkdir("/cm/x/y", { collect: b }), w.create("/c3.txt", { content: "three" }).then(() => w.mkdir("/c4")).then(() => other.push(1))]);
  check(J(await seqsOf(a)) === J(["create /c1.txt"]) && a.length === 1, "collect: a create collects its one op, while other calls run: " + J(await seqsOf(a)));
  check(J(await seqsOf(b)) === J(["mkdir /cm", "mkdir /cm/x", "mkdir /cm/x/y"]) && b.length === 3, "collect: a nested mkdir collects each folder it made, in order: " + J(await seqsOf(b)));
  const r = [], wr = [], d = [], rm = [];
  await w.rename("/c1.txt", "/c1b.txt", { collect: r });
  await w.write("/c1b.txt", "one again", { collect: wr });
  await w.duplicate("/c1b.txt", undefined, { collect: d });
  await w.remove("/c3.txt", undefined, undefined, { collect: rm });
  check(J(await seqsOf(r)) === J(["rename /c1.txt"]) && J(await seqsOf(wr)) === J(["write /c1b.txt"]) && d.length === 1 && J(await seqsOf(rm)) === J(["mkdir /Trash", "remove /c3.txt"]), "collect: rename, write, duplicate and remove each collect their own ops (remove's first Trash folder with it): " + J({ r: await seqsOf(r), wr: await seqsOf(wr), d: await seqsOf(d), rm: await seqsOf(rm) }));
  const all = [...a, ...b, ...r, ...wr, ...d, ...rm];
  check(new Set(all).size === all.length, "collect: no seq collected twice, nor by two calls");
  // (a call refused before it commits collects nothing; one refused after an earlier commit keeps that commit's)
  const none = [];
  check((await caught(w.create("/c1b.txt", { content: "taken", collect: none })))?.code === "exists" && none.length === 0, "collect: a refused create collects nothing");
  const bad = await caught(w.mkdir("/z", { collect: "no" }));
  check(bad?.code === "invalid", "collect: a collector that isn't a list is refused: " + bad?.code);
  // (an agent's verbs never take a collector)
  const g = [], ag = w.forAgent("agent:t14");
  await ag.mkdir("/ag", { collect: g });
  await ag.create("/ag/f.txt", { content: "a", collect: g });
  check(g.length === 0 && !!(await w.stat("/ag/f.txt")), "collect: forAgent's verbs drop it (the host's only): " + J(g));
  // (another tab's changes, told here by the channel, are never this call's)
  const w2 = await fresh(nm);
  const mine = [];
  await Promise.all([w.mkdir("/t1", { collect: mine }), w2.mkdir("/t2"), w2.mkdir("/t3")]);
  check(J(await seqsOf(mine)) === J(["mkdir /t1"]), "collect: another tab's commits, told here meanwhile, not collected: " + J(await seqsOf(mine)));
}

async function t14Typed() {
  // (refusals immediate and typed, before anything is allocated; sync off answers none at once)
  const w = await fresh();
  const s = signalOf();
  const big = Array.from({ length: 10_001 }, (_, i) => i + 1);
  const e1 = await caught(w.waitSync(big, { signal: s }));
  check(e1?.code === "limit" && e1.max === 10_000, "typed: 10,001 seqs is limit {max: 10000}: " + J({ code: e1?.code, max: e1?.max }));
  const e2 = await caught(w.syncState(big.slice(0, 1001)));
  check(e2?.code === "limit" && e2.max === 1000, "typed: syncState with 1,001 seqs is limit {max: 1000}");
  for (const [what, seqs] of [["empty", []], ["duplicate", [1, 1]], ["fractional", [1.5]], ["zero", [0]], ["not a list", "1"]]) {
    const e = await caught(w.waitSync(seqs, { signal: s }));
    check(e?.code === "invalid", `typed: ${what} seqs is invalid: ${e?.code}`);
  }
  for (const t of [0, -1, 1.5, NaN, Infinity, 2 ** 31, "5"]) {
    const e = await caught(w.waitSync([1], { signal: s, timeoutMs: t }));
    check(e?.code === "invalid", `typed: timeoutMs ${String(t)} is invalid: ${e?.code}`);
  }
  check((await caught(w.waitSync([1], {})))?.code === "invalid" && (await caught(w.waitSync([1], { level: "done", signal: s })))?.code === "invalid", "typed: no signal, or an unknown level, is invalid");
  const ab = new AbortController();
  ab.abort();
  check((await caught(w.waitSync([1], { signal: ab.signal })))?.name === "AbortError", "typed: an already aborted signal rejects at once");
  const off = await w.waitSync([1, 2], { signal: s });
  const offState = await w.syncState([1, 2]);
  check(off.sync === "none" && off.counts.none === 2 && offState.every((x) => x.sync === "none" && x.reason === "sync-off"), "typed: sync off: none at once, sync-off: " + J({ off, offState }));
  check(W.waitCount(w) === 0, "typed: nothing registered by any of these");
  // (sync on, the ops unsent: waits stay pending; the 17th is busy; abort and timeout release everything)
  const { ns } = await localNs(w, "a1");
  const col = [];
  await w.mkdir("/pending", { collect: col });
  const l0 = W.hubOf(w.ws).listeners;
  const acs = Array.from({ length: 16 }, () => new AbortController());
  const ps = acs.map((a, i) => w.waitSync(col, { signal: a.signal, ...(i === 0 ? { timeoutMs: 2 ** 31 - 1 } : {}) }).catch((e) => e));
  await sleep(100);
  const e17 = await caught(w.waitSync(col, { signal: s }));
  check(W.waitCount(w) === 16 && e17?.code === "busy" && e17.max === 16, "typed: 16 waits pending, the 17th busy {max: 16}: " + J({ n: W.waitCount(w), code: e17?.code }));
  for (const a of acs) a.abort();
  const outs = await Promise.all(ps);
  check(outs.every((e) => e?.name === "AbortError" && e.counts?.local === 1), "typed: aborted, each with its counts");
  const t1 = await caught(w.waitSync(col, { signal: s, timeoutMs: 1 }));
  check(t1?.timeout === true && t1.counts.local === 1, "typed: timeoutMs 1 times out, with the counts");
  check(W.waitCount(w) === 0 && W.hubOf(w.ws).listeners === l0, "typed: every exit released its slot and listener: " + J({ n: W.waitCount(w), l: W.hubOf(w.ws).listeners, l0 }));
  const st = await w.syncState(col);
  check(st[0].sync === "local" && !st[0].reason, "typed: an unscanned local op is local: " + J(st));
  void ns;
}

async function t14Ladder() {
  // (local, sent, accepted, confirmed against the real server; sent with its ack held back; a disconnect)
  await account();
  const w = await fresh();
  const c = client(w);
  check(await until(() => c.status.state === "synced"), "ladder: synced");
  const l0 = W.hubOf(w.ws).listeners;
  const col = [];
  await w.create("/l1.txt", { content: "one", collect: col });
  await w.mkdir("/ld", { collect: col });
  const r = await w.waitSync(col, { level: "confirmed", signal: signalOf(), timeoutMs: 20_000 });
  const st = await w.syncState(col);
  check(r.sync === "confirmed" && r.counts.confirmed === 2 && st.every((x) => x.sync === "confirmed"), "ladder: confirmed (the echo read back): " + J({ r, st }));
  // (sent: its ack dropped, the socket kept: it stays sent, never accepted, until the reconnect)
  await ctl("set", { set: { dropAcks: 1 } });
  const s1 = [];
  await w.mkdir("/s1", { collect: s1 });
  const sent = await w.waitSync(s1, { level: "sent", signal: signalOf(), timeoutMs: 15_000 });
  check(sent.sync === "sent" && sent.counts.sent === 1, "ladder: a sent wait resolves on the send, its ack held back: " + J(sent));
  check((await w.syncState(s1))[0].sync === "sent", "ladder: syncState says sent (this page sends)");
  const tm = await caught(w.waitSync(s1, { level: "accepted", signal: signalOf(), timeoutMs: 1500 }));
  check(tm?.timeout === true && tm.counts.sent === 1, "ladder: accepted not reached without its ack: " + J(tm?.counts));
  const p = w.waitSync(s1, { level: "accepted", signal: signalOf(), timeoutMs: 20_000 });
  await ctl("closeAll");
  const after = await p;
  check(after.sync === "accepted" || after.sync === "confirmed", "ladder: after a disconnect, resent, then accepted: " + J(after));
  check(W.waitCount(w) === 0 && W.hubOf(w.ws).listeners === l0, "ladder: nothing left registered");
  await stop(c);
}

async function t14Refused() {
  // (a refusal: refused with its code, ranked worst; the op after it accepted)
  await account();
  const w = await fresh();
  const c0 = client(w);
  check(await until(() => c0.status.state === "synced"), "refused: synced");
  await stop(c0);
  const fc = [], ac = [];
  const f = await w.create("/rf.txt", { content: "bytes gone", collect: fc });
  await w.mkdir("/rafter", { collect: ac });
  await rawTx(w.ws, ["fileBytes"], (tx) => tx.objectStore("fileBytes").delete(f.fid));
  const c = client(w);
  const r = await w.waitSync([...fc, ...ac], { signal: signalOf(), timeoutMs: 20_000 });
  const st = await w.syncState(fc);
  check(r.sync === "refused" && r.counts.refused === 1 && r.counts.accepted + r.counts.confirmed === 1, "refused: the wait resolves, refused ranked worst: " + J(r));
  check(st[0].sync === "refused" && st[0].code === "missing", "refused: its code kept: " + J(st));
  await stop(c);
}

async function t14Rebuild() {
  // (a refusal, then the rebuild: a refused or confirmed row is never relabelled)
  await account();
  const w = await fresh();
  const c0 = viewClient(w);
  check(await until(() => settled(w, c0)), "rebuild: synced");
  const kept = [];
  await w.mkdir("/kept", { collect: kept });
  check(await until(() => settled(w, c0)), "rebuild: an op confirmed first");
  await stop(c0);
  const gone = [];
  const f = await w.create("/rgone.txt", { content: "bytes gone", collect: gone });
  await rawTx(w.ws, ["fileBytes"], (tx) => tx.objectStore("fileBytes").delete(f.fid));
  const c = viewClient(w);
  try {
    check(await until(() => c.stats.rebuildPasses >= 1 && !c.debug().halted && c.status.state === "synced", 20_000), "rebuild: refused, rebuilt, resumed");
    const st = await w.syncState([...kept, ...gone]);
    check(st[0].sync === "confirmed" && st[1].sync === "refused", "rebuild: the confirmed and the refused rows unchanged by the rebuild: " + J(st));
  } finally {
    await stop(c);
  }
}

async function t14Lifecycle() {
  // (off ends the epoch's waits as none; a delayed lifecycle message of an older epoch ends no newer wait)
  const w = await fresh();
  const { ns } = await localNs(w, "a2");
  const col = [];
  await w.mkdir("/lc", { collect: col });
  const p = w.waitSync(col, { signal: signalOf() });
  check(!(await settledYet(p)), "lifecycle: pending while the op is unsent");
  await W.syncOff(w);
  const r = await p;
  check(r.sync === "none" && r.counts.none === 1, "lifecycle: sync off ends the wait, none: " + J(r));
  // (on again, same namespace: a new epoch; an old message for the epoch before is ignored)
  await W.switchTo(w, ns);
  const epoch = await metaGet(w.ws, "sync:epoch");
  const ab = new AbortController();
  const p2 = w.waitSync(col, { signal: ab.signal });
  W.hubOf(w.ws).post({ t: "lifecycle", ns, fromEpoch: epoch - 1, toEpoch: epoch, kind: "off" });
  check(!(await settledYet(p2)), "lifecycle: a delayed message for the epoch before ends no newer wait");
  W.hubOf(w.ws).post({ t: "lifecycle", ns, fromEpoch: epoch, toEpoch: epoch + 1, kind: "switch" });
  const r2 = await p2;
  check(r2.sync === "none", "lifecycle: …its own epoch's does: " + J(r2));
}

async function t14Fencing() {
  // (in-memory events fenced by the lease generation; durable ones only hints: a rev gap re-reads the rows)
  const w = await fresh();
  const { ns } = await localNs(w, "a3");
  const epoch = (await metaGet(w.ws, "sync:epoch")) ?? 0;
  const hub = W.hubOf(w.ws);
  const a = [], b = [];
  await w.mkdir("/fa", { collect: a });
  await w.mkdir("/fb", { collect: b });
  const pa = w.waitSync(a, { level: "sent", signal: signalOf(), timeoutMs: 5000 });
  await sleep(50);
  hub.post({ t: "sent", ns, epoch, gen: 50, seqs: a });
  check((await pa).sync === "sent", "fencing: a sent event of the current generation counts");
  const ab = new AbortController();
  const pb = w.waitSync(b, { level: "sent", signal: ab.signal });
  await sleep(50);
  hub.post({ t: "reset", ns, epoch, gen: 51 });
  hub.post({ t: "sent", ns, epoch, gen: 50, seqs: b });
  check(!(await settledYet(pb)), "fencing: an old holder's sent, after the new generation's reset, dropped");
  hub.post({ t: "sent", ns, epoch: epoch + 7, gen: 99, seqs: b });
  check(!(await settledYet(pb)), "fencing: a message of another epoch dropped");
  hub.post({ t: "inflight", ns, epoch, gen: 51, nonce: "not-mine", seqs: b });
  check(!(await settledYet(pb)), "fencing: a hello reply for another wait's nonce ignored");
  hub.post({ t: "sent", ns, epoch, gen: 51, seqs: b });
  check((await pb).sync === "sent", "fencing: the new generation's sent counts");
  // (a hint: the rows read again; what they say is the answer, whatever the event carried)
  const pc = w.waitSync(a, { level: "confirmed", signal: signalOf(), timeoutMs: 5000 });
  await sleep(50);
  const rev = (await metaGet(w.ws, `sync:${ns}:ledgerRev`)) ?? 0;
  await rawPut(w.ws, "syncLedger", { ns, lseq: a[0], s: "confirmed", d: 1, dseq: 1 });
  await rawPut(w.ws, "meta", rev + 2, `sync:${ns}:ledgerRev`);
  hub.post({ t: "rows", ns, epoch, rev: rev + 2, items: [] });
  check((await pc).sync === "confirmed", "fencing: a rev gap re-reads the rows, which answer");
}

async function t14Seed() {
  // (the upgrade's seeding: gated until done; a record owns its op only as its sole claimant with every field but
  // base the same; what can't be proven is before-ledger, never a guessed accepted)
  const w = await fresh();
  const ns = `${"a4".padEnd(16, "0")}:1:${w.device}`;
  const lease = await W.switchTo(w, ns);
  const ob = new W.Outbox(w, lease);
  await ob.begin(await w.lastSeq());
  await w.create("/s1.txt", { content: "one" });
  await w.mkdir("/s2");
  await w.create("/s3.txt", { content: "three" });
  await ob.scan();
  // (the state before the upgrade: records, no ledger)
  const recs = await ob.records();
  await rawTx(w.ws, ["syncLedger", "meta"], (tx) => {
    tx.objectStore("syncLedger").clear();
    for (const k of ["ledgerCount", "ledgerFloor", "ledgerFrom", "ledgerSeeded", "ledgerSkips", "ledgerRev"]) tx.objectStore("meta").delete(`sync:${ns}:${k}`);
  });
  const [r1, r2, r3] = recs;
  // (r1 accepted; r2's lseq claimed twice, by a successor-like record; r3's base not its op's: still its own)
  await rawTx(w.ws, ["outbox"], (tx) => {
    const out = tx.objectStore("outbox");
    out.put({ ...r1, accepted: 77 });
    out.put({ ns, dseq: 900, lseq: r2.lseq, id: r2.id, op: { ...r2.op, dseq: 900, op: "write", t: r2.op.t + 1 } });
    out.put({ ...r3, op: { ...r3.op, base: "f".repeat(64) } });
  });
  const busy = await caught(w.syncState([r1.lseq]));
  check(busy?.code === "busy" && busy.reason === "seeding", "seed: syncState is busy until the seed is done: " + J({ code: busy?.code, reason: busy?.reason }));
  const p = w.waitSync([r1.lseq], { signal: signalOf(), timeoutMs: 10_000 });
  check(!(await settledYet(p)), "seed: a wait makes no synthetic answer before the seed");
  await W.seedLedger(w, ns, W.wireOf);
  const r = await p;
  const st = await w.syncState([r1.lseq, r2.lseq, r3.lseq]);
  check(r.sync === "accepted" && st[0].sync === "accepted", "seed: the proven accepted record answers accepted, the waiting wait too: " + J({ r, st: st[0] }));
  check(st[1].sync === "none" && st[1].reason === "before-ledger", "seed: two claimants of one lseq: neither seeded, before-ledger: " + J(st[1]));
  check(st[2].sync === "local", "seed: a record whose base the scan set differently is still its op's (delta 1 r2, D3): " + J(st[2]));
}

async function t14Cap() {
  // (the decided rows' cap, exact: pruned in the deciding transaction, its own rows kept; the floor; expired)
  const w = await fresh();
  const { ns, ob } = await localNs(w, "a5");
  const col = [];
  for (let i = 0; i < 8; i++) await w.mkdir("/cap" + i, { collect: col });
  await ob.scan();
  const recs = await ob.records();
  await ob.acked(recs.map((r, i) => ({ dseq: r.dseq, seq: 100 + i })));
  const was = W.LEDGER.maxDecided;
  W.LEDGER.maxDecided = 5;
  try {
    for (const r of recs) await ob.confirmed([r.dseq]);
  } finally {
    W.LEDGER.maxDecided = was;
  }
  const count = await metaGet(w.ws, `sync:${ns}:ledgerCount`), floor = await metaGet(w.ws, `sync:${ns}:ledgerFloor`);
  const st = await w.syncState(col);
  check(count === 5 && floor === col[2], "cap: the count exact at the cap, the floor at the highest pruned: " + J({ count, floor, col }));
  check(st.slice(0, 3).every((x) => x.sync === "none" && x.reason === "expired") && st.slice(3).every((x) => x.sync === "confirmed"), "cap: the pruned answer expired, the rest confirmed: " + J(st.map((x) => x.sync + (x.reason ? "/" + x.reason : ""))));
  const r = await w.waitSync(col, { signal: signalOf() });
  check(r.counts.none === 3 && r.counts.confirmed === 5, "cap: a fresh wait over them resolves from the rows alone: " + J(r));
}

async function t14Skips() {
  // (delta 1 r2: a rebuild's watermark jump; only a retained local wire op is superseded; the floor first)
  const w = await fresh();
  const { ns } = await localNs(w, "a6");
  const s0 = await w.lastSeq();
  const lw = [];
  await w.create("/sk.txt", { content: "x", collect: lw });
  const srv = await rawTx(w.ws, ["ops"], (tx) => new Promise((ok) => { const q = tx.objectStore("ops").add({ t: Date.now(), device: "0f0f0f0f0f0f0f0f", by: "person", op: "mkdir", path: "/srv", kind: "folder", origin: "server" }); q.onsuccess = () => ok(q.result); }));
  const nw = await rawTx(w.ws, ["ops"], (tx) => new Promise((ok) => { const q = tx.objectStore("ops").add({ t: Date.now(), device: w.device, by: "person", op: "dropVersions", path: "/sk.txt", kind: "file" }); q.onsuccess = () => ok(q.result); }));
  const s1 = await w.lastSeq();
  await rawTx(w.ws, ["meta"], async (tx) => { tx.objectStore("meta").put(s1, `sync:${ns}:scanned`); await W.noteSkip(tx.objectStore("meta"), ns, s0, s1, "refused"); });
  const st = await w.syncState([lw[0], srv, nw]);
  check(st[0].sync === "superseded" && st[0].reason === "refused" && st[1].reason === "not-local" && st[2].reason === "not-synced", "skips: a local wire op superseded/refused; a server op not-local; a non-wire op not-synced: " + J(st));
  // (16 more jumps: the oldest goes, the floor over it: expired)
  await rawTx(w.ws, ["meta"], async (tx) => { for (let i = 0; i < 16; i++) await W.noteSkip(tx.objectStore("meta"), ns, s1 + 1000 + 2 * i, s1 + 1001 + 2 * i, "invalid"); });
  const skips = await metaGet(w.ws, `sync:${ns}:ledgerSkips`);
  const st2 = await w.syncState([lw[0]]);
  check(skips.length === 16 && skips.every((t) => Array.isArray(t) && t.length === 3) && st2[0].reason === "expired" && (await metaGet(w.ws, `sync:${ns}:ledgerFloor`)) >= s1, "skips: at most 16 triples; the oldest's range expired: " + J({ n: skips.length, st2 }));
  check(JSON.stringify(skips).length <= 609, "skips: within 609 JSON characters (delta 1 r2): " + JSON.stringify(skips).length);
  await rawPut(w.ws, "meta", [["bad"]], `sync:${ns}:ledgerSkips`);
  await rawPut(w.ws, "meta", 0, `sync:${ns}:ledgerFloor`);
  const st3 = await w.syncState([lw[0]]);
  check(st3[0].sync === "none" && st3[0].reason === "not-local", "skips: a malformed value read as none: " + J(st3));
}

async function t14TwoTabs() {
  // (a wait in a tab that doesn't send: answered by the sender's events, and its rows)
  await account();
  const nm = names();
  const w1 = await fresh(nm), w2 = await fresh(nm);
  const c1 = client(w1);
  check(await until(() => c1.status.state === "synced"), "two tabs (t14): synced");
  const col = [];
  await w2.mkdir("/tt", { collect: col });
  const r = await w2.waitSync(col, { level: "confirmed", signal: signalOf(), timeoutMs: 20_000 });
  check(r.sync === "confirmed", "two tabs (t14): the other tab's wait resolves: " + J(r));
  await stop(c1);
}

async function t14Obsolete() {
  // (other namespaces' ledgers: queued, at most two, deleted a page at a time; a namespace taken again is wiped)
  const w = await fresh();
  const n1 = await localNs(w, "b1");
  await w.mkdir("/o1");
  await n1.ob.scan();
  await localNs(w, "b2");
  await localNs(w, "b3");
  check(J(await metaGet(w.ws, W.OBSOLETE_KEY)) === J([n1.ns, `${"b2".padEnd(16, "0")}:1:${w.device}`]), "obsolete: two namespaces queued");
  await localNs(w, "b4");
  const q = await metaGet(w.ws, W.OBSOLETE_KEY);
  const left = (await all(w.ws, "syncLedger")).filter((r) => r.ns === n1.ns).length;
  check(q.length === 2 && !q.includes(n1.ns) && left === 0, "obsolete: a third switch cleaned the oldest first (the queue full): " + J({ q, left }));
  while (await W.cleanObsoleteStep(w));
  check(J(await metaGet(w.ws, W.OBSOLETE_KEY)) === "[]", "obsolete: drained");
}

async function t14HeldOnce(lead, renameOk, echoFirst) {
  const w = await fresh();
  const { ns, ob } = await localNs(w, lead);
  const f = await w.create("/h.txt", { content: "v1" });
  await ob.scan();
  const [r1] = await ob.records();
  // (its record unpinned: a write now is held, its state to go as a successor once that record is decided: C2)
  await rawTx(w.ws, ["pending"], (tx) => new Promise((ok) => { const ps = tx.objectStore("pending"), q = ps.get(f.fid); q.onsuccess = () => { const p = q.result; p.byNs[ns].allocated.pinned = false; ps.put(p); ok(); }; }));
  const b = [], r = [];
  await w.write("/h.txt", "v2", { collect: b });
  await w.rename("/h.txt", "/h2.txt", { collect: r });
  await ob.scan();
  const held = await w.syncState(b);
  const r2 = (await ob.records()).find((x) => x.lseq === r[0]);
  await ob.acked([{ dseq: r1.dseq, seq: 1 }]);
  await ob.scan();
  const r3 = (await ob.records()).find((x) => x.heldSeq === b[0]);
  const tag = `held (${renameOk ? "rename accepted, successor refused" : "rename refused, successor accepted"}${echoFirst ? ", echo first" : ""})`;
  check(held[0].sync === "local" && r2 && r3 && r3.lseq === r[0] && r3.dseq !== r2.dseq, `${tag}: the successor carries the held write (heldSeq), its bookkeeping lseq the rename's: ` + J({ held, r2: r2?.dseq, r3: r3 && { lseq: r3.lseq, heldSeq: r3.heldSeq } }));
  const okRec = renameOk ? r2 : r3, noRec = renameOk ? r3 : r2;
  if (echoFirst) await ob.confirmed([okRec.dseq]);
  await ob.acked([{ dseq: okRec.dseq, seq: 2 }, { dseq: noRec.dseq, code: "invalid" }]);
  const st = await w.syncState([b[0], r[0]]);
  const want = echoFirst ? "confirmed" : "accepted";
  const [wantB, wantR] = renameOk ? ["refused", want] : [want, "refused"];
  check(st[0].sync === wantB && st[1].sync === wantR, `${tag}: each record decides only the row it owns: ` + J(st));
}
async function t14Held() {
  await t14HeldOnce("a7", true, false);
  await t14HeldOnce("a8", false, false);
  await t14HeldOnce("a9", false, true);
}

async function t14Large() {
  // (a D11 large move collects its one publication op, not its rewrite's pages)
  const was = { ...W.D11 };
  W.configureD11({ ...W.D11, chunk: 10, page: 10, planPage: 100, validatePage: 10 });
  try {
    const w = await fresh();
    await w.mkdir("/lg");
    for (let i = 0; i < 14; i++) await w.create(`/lg/f${i}.txt`, { content: "x" + i });
    const col = [];
    const top = await w.rename("/lg", "/lg2", { collect: col });
    const ops = (await w.ops()).filter((o) => col.includes(o.seq));
    check(top.path === "/lg2" && col.length === 1 && ops[0]?.op === "rename" && ops[0].path === "/lg", "large move: one op collected, the top's rename: " + J(ops.map((o) => o.op + " " + o.path)));
    await w.rewriteSettled(60_000);
  } finally {
    W.configureD11(was);
  }
}

/** The committed planning allowance for a stored ledger row, bytes (daybreak3's storage ruling after the 996.2294
 * observation, Oct 25): A = max(960, 64 ceil(1.25 M / 64)), M the largest comparable isolated live-invariant peak of
 * this 10,000-row fixture: 996.2294 at 233aa3b3 (the predeclared ten-run series that followed peaked at 776.6629; 822
 * at e074d3a1), so 1280.  A planning envelope for this canary, not a physical bound and not the full-cap P (303.4): a
 * comparable measurement above it reopens the decision. */
const ROW_ALLOWANCE = 1280;

async function t14Figures() {
  // (LIMIT-PR128-1-R2: the widest row by construction (a refusal's code is ASCII [a-z0-9_], at most CODE.max); its
  // stored size measured in the live invariant's shape (daybreak3's ruling r3, option (i)): exactly three legal
  // maximum-width namespaces, each constant across its rows, every other field maximum-width and random; the peak of
  // the usage sampled right after each commit and once settled, held to the committed allowance ROW_ALLOWANCE)
  const w = await fresh();
  const MAX = Number.MAX_SAFE_INTEGER;
  const hexr = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n / 2)), (b) => b.toString(16).padStart(2, "0")).join("");
  const digits = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => String(b % 10)).join("");
  const alnum = "abcdefghijklmnopqrstuvwxyz0123456789_";
  const coder = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => alnum[b % alnum.length]).join("");
  const nsOf = () => `${hexr(64)}:${digits(15)}:${w.device}`;
  const nss = [nsOf(), nsOf(), nsOf()], ns = nss[0];
  await W.switchTo(w, ns);
  const kinds = {
    refused: { ns, lseq: MAX, s: "refused", d: 1, dseq: MAX, code: "z".repeat(W.CODE.max) },
    // (a rebuild's supersession carries its reason, never `by`; a local one carries `by`, its reason "local")
    supersededRebuild: { ns, lseq: MAX, s: "superseded", d: 1, dseq: MAX, reason: "diverged" },
    supersededLocal: { ns, lseq: MAX, s: "superseded", d: 1, dseq: MAX, reason: "local", by: MAX },
    none: { ns, lseq: MAX, s: "none", d: 1, reason: "before-ledger" },
    accepted: { ns, lseq: MAX, s: "accepted", d: 0, dseq: MAX },
  };
  const widths = Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, JSON.stringify(v).length]));
  const [widest, maxChars] = Object.entries(widths).sort((a, b) => b[1] - a[1])[0];
  check(nss.every((x) => x.length === 97) && maxChars === 216 && widths.refused === 216, "figures: the widest valid rows by construction (a refused one, a local supersession) are 216 JSON characters, ASCII only: " + J({ widths, widest }));
  const est = async () => (await navigator.storage.estimate()).usage ?? 0;
  await sleep(500);
  const u0 = await est();
  // (10,000 rows over the three namespaces, 3,334 / 3,333 / 3,333, in commits of at most 1,000; lseq distinct within a
  // namespace, every seq 16 digits)
  const N = 10_000, per = [3334, 3333, 3333];
  const rnd = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  const samples = [];
  for (let k = 0; k < 3; k++)
    for (let i0 = 0; i0 < per[k]; i0 += 1000)
      await rawTx(w.ws, ["syncLedger"], (tx) => {
        const st = tx.objectStore("syncLedger");
        for (let i = i0; i < Math.min(i0 + 1000, per[k]); i++) st.put({ ns: nss[k], lseq: MAX - i * 2 ** 20 - rnd(2 ** 20), s: "refused", d: 1, dseq: MAX - rnd(2 ** 30) * 2 ** 10 - rnd(2 ** 10), code: coder(W.CODE.max) });
      }).then(async () => samples.push((await est()) - u0));
  await sleep(1500);
  samples.push((await est()) - u0);
  const rows = await all(w.ws, "syncLedger");
  const dist = nss.map((x) => rows.filter((r) => r.ns === x).length);
  check(rows.length === N && J(dist) === J(per), `figures: exactly three namespaces, each constant within its rows: ${J(dist)} of ${rows.length}`);
  const measured = Math.round(Math.max(...samples) / N);
  const A = ROW_ALLOWANCE;
  const skips = JSON.stringify(Array.from({ length: 16 }, () => [MAX, MAX, 2]));
  const meta = { ledgerCount: 50_000, ledgerFloor: MAX, ledgerFrom: MAX, ledgerRev: MAX, ledgerSeeded: true, ledgerSeedAt: MAX, ledgerWipe: true };
  const metaChars = Object.entries(meta).reduce((a, [k, v]) => a + `sync:${ns}:${k}`.length + JSON.stringify(v).length, 0) + `sync:${ns}:ledgerSkips`.length + skips.length;
  check(skips.length <= 609 && measured > 0 && measured <= A, `figures (task #14): measured a peak of ${measured} B a stored row, ${measured > A ? "EXCEEDS" : "within"} the committed allowance A = ${A}: ` + J({ peakBytesPerRow: measured, samplesBytes: samples, namespaces: dist, committedAllowanceBytesPerRow: A, perNamespacePlanMiB: +(A * 70_000 / 2 ** 20).toFixed(1), globalPlanMiB: +(A * 210_000 / 2 ** 20).toFixed(1), rowJsonCharsMax: maxChars, skipsJsonChars: skips.length, metaKeysAndValuesCharsPerNs: metaChars, obsoleteQueueCharsMax: JSON.stringify([ns, ns]).length }));
}

async function t14Review() {
  // (regressions for astra3's review of #128)
  const w = await fresh();
  const { ns } = await localNs(w, "d1");
  const hub = W.hubOf(w.ws), epoch = (await metaGet(w.ws, "sync:epoch")) ?? 0, gen = (await metaGet(w.ws, "sync:current")).gen;
  const col = [];
  await w.mkdir("/rv1", { collect: col });
  // (CORR-PR128-1: an abort while the wait reads its first view: rejected, with its counts, nothing left registered)
  const ac = new AbortController();
  const p1 = w.waitSync(col, { signal: ac.signal });
  ac.abort();
  const e1 = await caught(p1);
  check(e1?.name === "AbortError" && e1.counts?.local === 1 && W.waitCount(w) === 0, "review 1: aborted during registration: rejected with counts, no wait left: " + J({ name: e1?.name, counts: e1?.counts, n: W.waitCount(w) }));
  // (CORR-PR128-2: a new wait knows the newest generation already seen; a delayed older sender's sent is dropped)
  hub.post({ t: "holder", ns, epoch, gen: gen + 10, rev: 0 });
  const ab2 = new AbortController();
  const p2 = w.waitSync(col, { level: "sent", signal: ab2.signal });
  await sleep(50);
  hub.post({ t: "sent", ns, epoch, gen: gen + 9, seqs: col });
  check(!(await settledYet(p2)), "review 2: a new wait drops a delayed sent from generation 9 after holder 10");
  hub.post({ t: "sent", ns, epoch, gen: gen + 10, seqs: col });
  check((await p2).sync === "sent", "review 2: …and takes generation 10's");
  // (CORR-PR128-3: a rebuild's skip, and a skip overflow's floor, wake waits that were already reading)
  const s0 = await w.lastSeq();
  const a = [];
  await w.create("/rv3.txt", { content: "x", collect: a });
  const s1 = await w.lastSeq();
  const pa = w.waitSync(a, { signal: new AbortController().signal });
  await sleep(100);
  check(!(await settledYet(pa)), "review 3: the wait reads local");
  await rawTx(w.ws, ["meta"], async (tx) => { tx.objectStore("meta").put(s1, `sync:${ns}:scanned`); await W.noteSkip(tx.objectStore("meta"), ns, s0, s1, "invalid"); });
  const ra = await Promise.race([pa, sleep(3000).then(() => null)]);
  check(ra?.sync === "superseded", "review 3: a skip committed: the waiting wait settles superseded, no other event: " + J(ra));
  // (its floor: a skip pushed out by 16 more; a wait over a seq in that range, local until then, settles expired)
  await rawTx(w.ws, ["meta"], (tx) => { tx.objectStore("meta").put([], `sync:${ns}:ledgerSkips`); });
  const b = [];
  await w.create("/rv4.txt", { content: "y", collect: b });
  const s2 = await w.lastSeq();
  const pb = w.waitSync(b, { level: "confirmed", signal: new AbortController().signal });
  await sleep(100);
  check(!(await settledYet(pb)), "review 3: the second wait reads local (past the watermark)");
  await rawTx(w.ws, ["meta"], async (tx) => { const m = tx.objectStore("meta"); m.put(s2, `sync:${ns}:scanned`); await W.noteSkip(m, ns, s1, s2, "invalid"); for (let i = 0; i < 16; i++) await W.noteSkip(m, ns, s2 + 100 + 2 * i, s2 + 101 + 2 * i, "invalid"); });
  const rb = await Promise.race([pb, sleep(3000).then(() => null)]);
  check(rb?.sync === "none" && rb.counts.none === 1 && (await w.syncState(b))[0].reason === "expired", "review 3: a skip pushed out raises the floor: the waiting wait settles, expired: " + J(rb));
  // (CORR-PR128-4: names inherited by every object are not levels)
  for (const lv of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
    const e = await caught(w.waitSync(col, { level: lv, signal: new AbortController().signal }));
    check(e?.code === "invalid", `review 4: level "${lv}" is invalid: ${e?.code}`);
  }
  // (CORR-PR128-5: the caller's array changed after the call: the wait and syncState keep the set they were given)
  const arr = [col[0]];
  const ab5 = new AbortController();
  const p5 = w.waitSync(arr, { level: "local", signal: ab5.signal });
  for (let i = 0; i < 10_000; i++) arr.push(1e9 + i);
  const r5 = await p5;
  const total = Object.values(r5.counts).reduce((x, y) => x + y, 0);
  const arr2 = [col[0]];
  const p6 = w.syncState(arr2);
  for (let i = 0; i < 2000; i++) arr2.push(1e9 + i);
  const r6 = await p6;
  check(total === 1 && r6.length === 1, "review 5: the caller's array grown after the call changes nothing (one slot, one answer): " + J({ total, answers: r6.length }));
  check(W.waitCount(w) <= 1, "review: nothing else left registered");
  ab2.abort();
}

async function t14Review2() {
  // (daybreak3's round 2: the refusal code bounded where a row takes it; the generation fence bounded and still a fence)
  const w = await fresh();
  const { ns, ob } = await localNs(w, "e1");
  const col = [];
  await w.mkdir("/rc1", { collect: col });
  await w.mkdir("/rc2", { collect: col });
  await ob.scan();
  const recs = await ob.records();
  await ob.acked([{ dseq: recs[0].dseq, code: "\u0000".repeat(64) }, { dseq: recs[1].dseq, code: "missing" }]);
  const st = await w.syncState(col);
  check(st[0].code === "other" && st[1].code === "missing", "review2: a code outside the protocol's vocabulary kept as other; a protocol code kept: " + J(st));
  const hub = W.hubOf(w.ws);
  for (let i = 0; i < 50; i++) {
    hub.post({ t: "holder", ns: `${String(i).padStart(16, "0")}:1:${w.device}`, epoch: i, gen: 5, rev: 0 });
    hub.post({ t: "lifecycle", ns, fromEpoch: 100 + i, toEpoch: 101 + i, kind: "off" });
  }
  check(hub.fences <= W.HUB.maxNamespaces, `review2: 50 namespaces and 50 epochs cycled: the fence holds ${hub.fences} (at most ${W.HUB.maxNamespaces})`);
  // (still a fence: the namespace moved to epoch 200 by a lifecycle change; its holder 10 seen, a delayed sent from 9
  // is stale)
  const epoch = 200;
  hub.post({ t: "lifecycle", ns, fromEpoch: epoch - 1, toEpoch: epoch, kind: "off" });
  hub.post({ t: "holder", ns, epoch, gen: 10, rev: 0 });
  let staleSeen = null;
  const off = hub.on((m, stale) => { if (m.t === "sent" && m.gen === 9) staleSeen = stale; });
  hub.post({ t: "sent", ns, epoch, gen: 9, seqs: [] });
  off();
  check(staleSeen === true, "review2: …and a delayed generation 9 after holder 10 is still stale");
  // (an older epoch's message is stale too)
  let olderStale = null;
  const off2 = hub.on((m, stale) => { if (m.t === "sent" && m.epoch === epoch - 1) olderStale = stale; });
  hub.post({ t: "sent", ns, epoch: epoch - 1, gen: 99, seqs: [] });
  off2();
  check(olderStale === true, "review2: a message of an older epoch is stale whatever its generation");
  // (a message claiming a newer epoch moves nothing: the current epoch's messages are not fenced by it (the hang found
  // in the full suite at 61872ea7))
  let fut = null, cur = null;
  const off3 = hub.on((m, stale) => { if (m.t === "sent" && m.epoch === epoch + 5) fut = stale; if (m.t === "sent" && m.epoch === epoch && m.gen === 10) cur = stale; });
  hub.post({ t: "sent", ns, epoch: epoch + 5, gen: 999, seqs: [] });
  hub.post({ t: "sent", ns, epoch, gen: 10, seqs: [] });
  off3();
  check(fut === false && cur === false, "review2: a future epoch's message neither applies nor fences the current epoch: " + J({ fut, cur }));
}

async function t14Review3() {
  // (astra3's CORR-PR128-6: a message claiming a future epoch can't anchor the fence of a namespace it has no entry for
  // (a fresh hub, or after eviction), so a real wait registered at the durable epoch still takes that epoch's progress)
  const w = await fresh();
  const { ns, lease } = await localNs(w, "e3");
  const epoch = (await metaGet(w.ws, "sync:epoch")) ?? 0;
  const hub = W.hubOf(w.ws);
  check(hub.fences === 0, "review3: a fresh hub: no fence yet");
  const a = [];
  await w.mkdir("/fh", { collect: a });
  hub.post({ t: "sent", ns, epoch: epoch + 1, gen: 999, seqs: [] });
  hub.post({ t: "holder", ns, epoch: epoch + 1, gen: 999, rev: 0 });
  check(hub.fences <= 1 && hub.seen(ns, epoch) === 0, "review3: ordinary messages of a future epoch set nothing for the current epoch (at most a tentative entry)");
  const pa = w.waitSync(a, { level: "sent", signal: signalOf(), timeoutMs: 5000 });
  await sleep(50);
  hub.post({ t: "sent", ns, epoch, gen: lease.gen, seqs: a });
  const ra = await caught(pa) ?? await pa;
  check(ra.sync === "sent", "review3: fresh hub, a future-epoch claim first: a real wait at the durable epoch takes its sent: " + J(ra.sync ?? String(ra)));
  // (after eviction: three other namespaces moved by lifecycle changes push this one out; a future claim again; a new
  // real wait re-anchors at the durable epoch and takes its progress)
  for (const lead of ["b", "c", "d"]) hub.post({ t: "lifecycle", ns: `${lead.repeat(16)}:1:${w.device}`, fromEpoch: 0, toEpoch: 1, kind: "switch" });
  check(hub.fences === W.HUB.maxNamespaces && hub.seen(ns, epoch) === 0, `review3: three other namespaces evicted this one (the fence holds ${hub.fences})`);
  hub.post({ t: "sent", ns, epoch: epoch + 1, gen: 999, seqs: [] });
  // (after an eviction a registration's generation is unknown (CORR-PR128-6-R5): the live sender's answer to the wait's
  // hello confirms it, as the real sender gives from the moment it holds)
  hub.holding(ns, epoch, lease.gen);
  const b = [];
  await w.mkdir("/fe", { collect: b });
  const pb = w.waitSync(b, { level: "sent", signal: signalOf(), timeoutMs: 5000 });
  await sleep(50);
  hub.post({ t: "sent", ns, epoch, gen: lease.gen, seqs: b });
  const rb = await caught(pb) ?? await pb;
  check(rb.sync === "sent", "review3: after eviction, a future-epoch claim first: a real wait at the durable epoch takes its sent: " + J(rb.sync ?? String(rb)));
  // (an ordinary message's generation, before any wait, is still kept for the next wait of its epoch (CORR-PR128-2,
  // after eviction): tentative, then confirmed by the wait's durable read)
  for (const lead of ["b", "c", "d"]) hub.post({ t: "lifecycle", ns: `${lead.repeat(16)}:2:${w.device}`, fromEpoch: 0, toEpoch: 1, kind: "switch" });
  hub.post({ t: "holder", ns, epoch, gen: lease.gen + 5, rev: 0 });
  hub.holding(ns, epoch, lease.gen + 5);
  const d = [];
  await w.mkdir("/ft", { collect: d });
  const pd = w.waitSync(d, { level: "sent", signal: new AbortController().signal });
  await sleep(50);
  hub.post({ t: "sent", ns, epoch, gen: lease.gen + 4, seqs: d });
  check(!(await settledYet(pd)) && hub.seen(ns, epoch) === lease.gen + 5, "review3: after eviction, a holder announced before the wait: its older generation's sent is dropped by a new wait");
  hub.post({ t: "sent", ns, epoch, gen: lease.gen + 5, seqs: d });
  check((await pd).sync === "sent", "review3: …and the announced generation's sent counts");
  // (and still a fence: re-anchored, an older generation's sent after a newer holder is dropped by a real wait)
  const c = [];
  await w.mkdir("/fg", { collect: c });
  const ab = new AbortController();
  const pc = w.waitSync(c, { level: "sent", signal: ab.signal });
  await sleep(50);
  hub.post({ t: "holder", ns, epoch, gen: lease.gen + 6, rev: 0 });
  hub.post({ t: "sent", ns, epoch, gen: lease.gen + 5, seqs: c });
  check(!(await settledYet(pc)) && hub.fences <= W.HUB.maxNamespaces, "review3: re-anchored, an older generation's sent after a newer holder is dropped; the bound kept");
  hub.post({ t: "sent", ns, epoch, gen: lease.gen + 6, seqs: c });
  check((await pc).sync === "sent", "review3: …and the newer generation's sent counts");
  // (astra3's CORR-PR128-6-R4: the announced holder and a future-epoch claim together, in both orders, on a fresh hub and
  // after eviction: the claim neither erases nor hides the durable epoch's announced generation; a real wait registered
  // after both drops the older generation's sent and takes the announced one's)
  for (const evicted of [false, true])
    for (const order of ["holder first", "claim first"]) {
      const w2 = await fresh();
      const { ns: n2, lease: l2 } = await localNs(w2, evicted ? "e5" : "e6");
      const e2 = (await metaGet(w2.ws, "sync:epoch")) ?? 0;
      const hub2 = W.hubOf(w2.ws);
      const what = `${evicted ? "after eviction" : "fresh hub"}, ${order}`;
      if (evicted) {
        hub2.fence(n2, e2, l2.gen, true);
        for (const lead of ["b", "c", "d"]) hub2.post({ t: "lifecycle", ns: `${lead.repeat(16)}:3:${w2.device}`, fromEpoch: 0, toEpoch: 1, kind: "switch" });
        check(hub2.seen(n2, e2) === 0 && hub2.fences === W.HUB.maxNamespaces, `review3: ${what}: evicted`);
      } else check(hub2.fences === 0, `review3: ${what}: a fresh hub`);
      const msgs = [{ t: "holder", ns: n2, epoch: e2, gen: l2.gen + 5, rev: 0 }, { t: "holder", ns: n2, epoch: e2 + 1, gen: 999, rev: 0 }];
      for (const m of order === "holder first" ? msgs : msgs.reverse()) hub2.post(m);
      if (evicted) hub2.holding(n2, e2, l2.gen + 5);
      const c2 = [];
      await w2.mkdir("/r4", { collect: c2 });
      const p2 = w2.waitSync(c2, { level: "sent", signal: new AbortController().signal });
      await sleep(50);
      hub2.post({ t: "sent", ns: n2, epoch: e2, gen: l2.gen + 4, seqs: c2 });
      check(!(await settledYet(p2)), `review3: ${what}: holder ${l2.gen + 5} announced, a claim of epoch ${e2 + 1}: a new wait drops generation ${l2.gen + 4}'s sent`);
      hub2.post({ t: "sent", ns: n2, epoch: e2, gen: l2.gen + 5, seqs: c2 });
      const r2 = await Promise.race([p2, sleep(3000).then(() => null)]);
      check(r2?.sync === "sent" && hub2.fences <= W.HUB.maxNamespaces, `review3: ${what}: …and takes generation ${l2.gen + 5}'s: ` + J(r2?.sync ?? null));
    }
  // (astra3's and daybreak3's CORR-PR128-6-R5: the tentative bound overflowed (the current epoch's announced holder,
  // then HUB.maxTentative other epochs, or those first and the holder last), on a fresh hub and after eviction: no
  // overflow can let an older generation's sent resolve a real wait; the wait takes nothing until the live sender's own
  // answer to its hello, then that generation's sent)
  const orders = { "holder, then 4 older epochs": (cur, older) => [cur, ...older], "4 older epochs, then the holder": (cur, older) => [...older, cur], "holder, then 4 future epochs": (cur, older, future) => [cur, ...future], "4 future epochs, then the holder": (cur, older, future) => [...future, cur] };
  for (const evicted of [false, true])
    for (const [order, seqOf] of Object.entries(orders)) {
      const w3 = await fresh();
      const { ns: n3, lease: l3 } = await localNs(w3, evicted ? "e7" : "e8");
      // (the current epoch made 5, so four older ones exist)
      await rawTx(w3.ws, ["meta"], (tx) => { tx.objectStore("meta").put(5, "sync:epoch"); });
      const e3 = 5, hub3 = W.hubOf(w3.ws), what = `${evicted ? "after eviction" : "fresh hub"}, ${order}`;
      if (evicted) for (const lead of ["b", "c", "d"]) hub3.post({ t: "lifecycle", ns: `${lead.repeat(16)}:4:${w3.device}`, fromEpoch: 0, toEpoch: 1, kind: "switch" });
      const cur = { t: "holder", ns: n3, epoch: e3, gen: l3.gen + 5, rev: 0 };
      const older = [1, 2, 3, 4].map((e) => ({ t: "holder", ns: n3, epoch: e, gen: 1, rev: 0 }));
      const future = [6, 7, 8, 9].map((e) => ({ t: "holder", ns: n3, epoch: e, gen: 999, rev: 0 }));
      for (const m of seqOf(cur, older, future)) hub3.post(m);
      const c3 = [];
      await w3.mkdir("/r5", { collect: c3 });
      let nonce = null;
      const off = hub3.on((m) => { if (m.t === "hello" && m.ns === n3) nonce = m.nonce; });
      const p3 = w3.waitSync(c3, { level: "sent", signal: new AbortController().signal });
      await sleep(50);
      hub3.post({ t: "sent", ns: n3, epoch: e3, gen: l3.gen + 4, seqs: c3 });
      check(!(await settledYet(p3)), `review3 R5: ${what}: generation ${l3.gen + 4}'s sent after holder ${l3.gen + 5} and the overflow: the wait stays pending`);
      // (fail closed: without the live sender's answer, not even the announced generation's sent counts)
      hub3.post({ t: "sent", ns: n3, epoch: e3, gen: l3.gen + 5, seqs: c3 });
      const early = await settledYet(p3);
      // (the live sender answers this wait's hello (its own nonce): the generation confirmed, then its sent counts; an
      // older one never)
      off();
      hub3.holding(n3, e3, l3.gen + 5);
      hub3.post({ t: "hello", ns: n3, epoch: e3, nonce });
      await sleep(20);
      hub3.post({ t: "sent", ns: n3, epoch: e3, gen: l3.gen + 4, seqs: c3 });
      const still = !(await settledYet(p3));
      hub3.post({ t: "sent", ns: n3, epoch: e3, gen: l3.gen + 5, seqs: c3 });
      const r3 = await Promise.race([p3, sleep(3000).then(() => null)]);
      check(nonce !== null && !early && still && r3?.sync === "sent" && hub3.unknown(n3, e3) === false && hub3.fences <= W.HUB.maxNamespaces, `review3 R5: ${what}: nothing counted before the live sender's answer, an older generation never, the answered one's sent counted: ` + J({ settledBeforeAnswer: early, olderStillPendingAfter: still, final: r3?.sync ?? null }));
    }
  // (astra3's CORR-PR128-6-R6: a registered unknown wait hears a newer generation (a holder, a sent or a reset of 6),
  // the namespace is then evicted (or not: the control), and a delayed answer to its own hello from an older sender
  // (5, its nonce) arrives: it never counts; the newer generation's own answer does.  Every generation-bearing hint
  // raises the wait's floor even while unknown, and none confirms it)
  for (const kind of ["holder", "sent", "reset"])
    for (const evicted of [false, true]) {
      const w4 = await fresh();
      const { ns: n4, lease: l4 } = await localNs(w4, evicted ? "e9" : "ea");
      await rawTx(w4.ws, ["meta"], (tx) => { tx.objectStore("meta").put(5, "sync:epoch"); });
      const e4 = 5, hub4 = W.hubOf(w4.ws), what = `${kind}, ${evicted ? "then evicted" : "no eviction (control)"}`;
      // (lossy before the wait: five other epochs' claims overflow the tentative map)
      for (const e of [1, 2, 3, 4, 6]) hub4.post({ t: "holder", ns: n4, epoch: e, gen: 1, rev: 0 });
      const c4 = [];
      await w4.mkdir("/r6", { collect: c4 });
      let nonce4 = null;
      const off4 = hub4.on((m) => { if (m.t === "hello" && m.ns === n4) nonce4 = m.nonce; });
      const p4 = w4.waitSync(c4, { level: "sent", signal: new AbortController().signal });
      await sleep(50);
      off4();
      const unknown = hub4.unknown(n4, e4);
      const newer = l4.gen + 5, older = l4.gen + 4;
      if (kind === "holder") hub4.post({ t: "holder", ns: n4, epoch: e4, gen: newer, rev: 0 });
      else if (kind === "sent") hub4.post({ t: "sent", ns: n4, epoch: e4, gen: newer, seqs: [] });
      else hub4.post({ t: "reset", ns: n4, epoch: e4, gen: newer });
      if (evicted) for (const lead of ["b", "c", "d"]) hub4.post({ t: "lifecycle", ns: `${lead.repeat(16)}:5:${w4.device}`, fromEpoch: 0, toEpoch: 1, kind: "switch" });
      const gone = evicted ? hub4.seen(n4, e4) === 0 : true;
      // (the delayed answer from the older sender, to this wait's own hello)
      hub4.post({ t: "inflight", ns: n4, epoch: e4, gen: older, nonce: nonce4, seqs: c4 });
      const pendingAfterOlder = !(await settledYet(p4));
      // (the newer generation's own answer)
      hub4.post({ t: "inflight", ns: n4, epoch: e4, gen: newer, nonce: nonce4, seqs: c4 });
      const r4 = await Promise.race([p4, sleep(3000).then(() => null)]);
      check(unknown && gone && nonce4 !== null && pendingAfterOlder && r4?.sync === "sent", `review3 R6: ${what}: a ${kind} of ${newer} heard while unknown, then the older sender's delayed answer (${older}, the wait's nonce): not counted; the ${newer} answer counts: ` + J({ unknown, evictedFromHub: evicted ? gone : null, pendingAfterOlder, final: r4?.sync ?? null }));
    }
}

// ---- 2c-3: the account connection carries document sync (doc-sync.ts) when given one: connected after a writable
// welcome with the binding's owner, its requests answered to it alone (an answer or a refusal, the ops' sender
// untouched), answered `busy` once the connection is gone, told of the end, connected again on the next welcome
async function docWire() {
  await account();
  const w = await fresh();
  const calls = [];
  let link = null;
  const docs = { connected(l) { calls.push("connected"); link = l; }, disconnected() { calls.push("disconnected"); }, changed(m) { calls.push("changed:" + m.doc); } };
  const c = client(w, { docs });
  check(await until(() => c.status.state === "synced" && link), "docWire: connected, and document sync handed the connection: " + J({ state: c.status.state, calls }));
  check(typeof link?.owner === "string" && link.owner === nsOf(c).split(":")[0], "docWire: …with the binding's account as `owner`: " + J({ owner: link?.owner, ns: nsOf(c) }));
  const id = crypto.randomUUID();
  const r1 = link.reserve(), a1 = await link.ask(r1, { t: "pull", owner: link.owner, doc: id, epoch: 1, after: 0, limit: 10 });
  check(a1.req === r1 && (a1.t === "batches" || a1.t === "error"), "docWire: a document request's answer comes back to it: " + J(a1).slice(0, 200));
  const r2 = link.reserve(), a2 = await link.ask(r2, { t: "pull", owner: link.owner, doc: "not a document", epoch: 1, after: 0 });
  check(r2 > r1 && a2.t === "error" && a2.req === r2, "docWire: a document request's refusal comes back to it too: " + J(a2).slice(0, 200));
  // (an `ack` too, as the protocol has it (§5.8): the client claimed first (doc_claim), then a new document's first
  // batch, one patch, with the claim's fgen and cseq; the ops' sender never sees it (its ack has no ops).  Core's own
  // test server predates claims: only its exact refusal of an unknown message takes the named fallback (the ack routing
  // not exercised), and never with SYNC_REQUIRE_CLAIM=1 (cloud's CI, window.REQUIRE_CLAIM); any other answer, no
  // answer, a malformed claim, or a claim followed by a refused batch fails.  The claim branch counts two checks, the
  // fallback one, so the total shows which branch ran)
  const askT = (r, m) => Promise.race([link.ask(r, m), sleep(5000).then(() => ({ t: "no answer in 5 s" }))]);
  const client1 = "docwire1", doc4 = crypto.randomUUID();
  const body = new TextEncoder().encode(J({ v: 1 })), pid = Date.now().toString(36).padStart(11, "0") + "_" + client1;
  const b64 = btoa(String.fromCharCode(...body));
  // (the control: a batch without fgen, through this page and the front, is refused (by the front's canonical check),
  // routed to its request, and never forwarded)
  const l0 = await ctl("log");
  const r0 = link.reserve(), a0 = await askT(r0, { t: "batch", owner: link.owner, doc: doc4, epoch: 1, kind: "notebook", patches: [{ cseq: 1, id: pid, parents: [], size: body.length }], body: b64 });
  await sleep(200);
  const l1 = await ctl("log");
  check(a0.t === "error" && a0.req === r0 && a0.code === "invalid" && /^batch fgen/.test(a0.detail?.message ?? "") && l1.fgenRefused === l0.fgenRefused + 1 && l1.batchesUp === l0.batchesUp,
    "docWire: a batch without fgen is refused (invalid, batch fgen), routed to its request, never forwarded (no batch went upstream): " + J({ a: a0, refused: l1.fgenRefused - l0.fgenRefused, up: l1.batchesUp - l0.batchesUp }).slice(0, 200));
  const rc = link.reserve(), ac = await askT(rc, { t: "doc_claim", owner: link.owner, doc: doc4, epoch: 1, client: client1 });
  const claimed = ac.t === "ack" && ac.req === rc && ac.claim?.client === client1 && Number.isSafeInteger(ac.claim?.fgen) && ac.claim.fgen >= 0 && Number.isSafeInteger(ac.claim?.next_cseq) && ac.claim.next_cseq >= 1;
  const legacy = ac.t === "error" && ac.req === rc && ac.code === "invalid" && ac.detail?.message === "unknown message";
  if (claimed || window.REQUIRE_CLAIM || !legacy) {
    check(claimed, "docWire: the client claimed (doc_claim answered with its client, fgen and next_cseq, to its request)" + (window.REQUIRE_CLAIM ? " (SYNC_REQUIRE_CLAIM)" : "") + ": " + J(ac).slice(0, 200));
    const u4 = (await ctl("log")).batchesUp;
    const r4 = link.reserve(), a4 = claimed
      ? await askT(r4, { t: "batch", owner: link.owner, doc: doc4, epoch: 1, kind: "notebook", fgen: { [client1]: ac.claim.fgen }, patches: [{ cseq: ac.claim.next_cseq, id: pid, parents: [], size: body.length }], body: b64 })
      : { t: "not sent: no claim" };
    const u5 = (await ctl("log")).batchesUp;
    check(a4.t === "ack" && a4.req === r4 && c.status.state === "synced" && u5 === u4 + 1, "docWire: …its batch (the claim's fgen and cseq), forwarded once: the document request's `ack` comes back to it (not to the ops' sender): " + J({ a: a4, state: c.status.state, up: u5 - u4 }).slice(0, 200));
  } else check(legacy, "docWire: ack routing not exercised: server has no claim protocol (doc_claim refused as an unknown message, code invalid, routed to its request)");
  const from = await w.lastSeq();
  await w.mkdir("/docwire");
  check(await until(() => settled(w, c)), "docWire: the ops' sender untouched by them: an op sent and decided after: " + J(c.status));
  await everyOnce(w, from, 0, "docWire", c);
  await ctl("closeAll");
  check(await until(() => calls.includes("disconnected")), "docWire: the connection's end told to document sync: " + J(calls));
  const gone = link;
  const a3 = await gone.ask(gone.reserve(), { t: "pull", owner: gone.owner, doc: id, epoch: 1, after: 0 });
  check(a3.t === "error" && a3.code === "busy", "docWire: a request on a connection that's gone is answered `busy` (transient), never sent: " + J(a3));
  check(await until(() => calls.filter((x) => x === "connected").length >= 2 && c.status.state === "synced"), "docWire: connected again on the next welcome: " + J(calls));
  // (CORR-2C3-4: the server's own readonly notice (no req, as cloud's server pushes it when a plan lapses): document
  // sync told the link is gone, and a request on it answered busy, never sent, until a writable welcome)
  const link2 = link, nDisc = calls.filter((x) => x === "disconnected").length;
  const before5 = (await ctl("log")).sent.length;
  await ctl("frame", { frame: { t: "error", code: "readonly", detail: { message: "this account's plan doesn't include sync: read-only", purge_after: Date.now() + 86_400_000 } } });
  check(await until(() => calls.filter((x) => x === "disconnected").length > nDisc, 3000), "docWire: an unasked readonly notice: document sync told the link is gone: " + J(calls));
  const a5 = await Promise.race([link2.ask(link2.reserve(), { t: "pull", owner: link2.owner, doc: id, epoch: 1, after: 0 }), sleep(3000).then(() => ({ t: "no answer in 3 s" }))]);
  await sleep(200);
  const sent5 = (await ctl("log")).sent.slice(before5).filter((m) => m.t === "pull" || m.t === "batch" || m.t === "doc_claim");
  check(a5.t === "error" && a5.code === "busy" && sent5.length === 0, "docWire: …and a document request after it answered busy, never sent: " + J({ a: a5, sent: sent5.map((m) => m.t) }));
  await stop(c);
}

/** what a client closed by another page's upgrade says (sync-client.ts CLOSED_ELSEWHERE) */
const CLOSED_REASON = "your files were upgraded by a newer Sagebrush page: reload this page to sync";
/** Another page (a newer build) upgrades `w`'s database: its version + 1, opened and closed from this page. */
const upgradeElsewhere = (w) => new Promise((ok, no) => { const r = indexedDB.open(w.ws.name, w.ws.version + 1); r.onsuccess = () => { r.result.close(); ok(); }; r.onerror = () => no(r.error); });
/** `p` settled within `ms`: "ended", "rejected: …", or "hung" */
const settledWithin = (p, ms) => Promise.race([p.then(() => "ended", (e) => "rejected: " + (e?.message ?? e)), sleep(ms).then(() => "hung")]);
const closedOff = (c) => c.status.state === "off" && c.status.reason === CLOSED_REASON;

/** A newer page upgrades the workspace's database while this page's client runs (another tab, a newer build): the
 * database closes here; the client stops itself (sync off, said), its loop ends, and nothing it was doing throws. */
async function closedByUpgrade() {
  await account();
  const w = await fresh();
  const c = client(w);
  check(await until(() => settled(w, c)), "closed by upgrade: synced first");
  await upgradeElsewhere(w);
  check(w.closed === true, "closed by upgrade: the workspace says it was closed by another page");
  // (the socket drops, as a network would: the client must not write to the closed database, nor hang)
  await ctl("closeAll");
  const ended = await settledWithin(c.run, 5000);
  check(ended === "ended" && closedOff(c), "closed by upgrade: the client stopped, its loop ended, the reload said: " + J({ ended, status: c.status }));
  await c.stop();
}
/** The database closed under a running client with no notice (no onClosed: a caller's close()): the socket then
 * drops, so the connection's end can't keep its timer.  Its end is still said and its loop settles (ended or
 * rejected, never waiting for good), and nothing throws unhandled (the runner fails on any page error). */
async function closedUnderClient() {
  await account();
  const w = await fresh();
  const c = client(w);
  check(await until(() => settled(w, c)), "closed under the client: synced first");
  // (settled or rejected, observed from now: its rejection is handled here, so only the client's own can be unhandled)
  const settledAs = c.run.then(() => "ended", (e) => "rejected: " + (e?.message ?? e));
  w.ws.close();
  await ctl("closeAll");
  const ended = await Promise.race([settledAs, sleep(10_000).then(() => "hung")]);
  check(ended !== "hung", "closed under the client: its loop settled, not waiting for good: " + J({ ended, status: c.status }));
  await c.stop();
}
/** The upgrade lands while the connection's end is keeping its retry timer (its write in flight, held here until
 * after the upgrade): the write then completes, and the reload stays the last thing said. */
async function closedDuringRetry() {
  await account();
  const w = await fresh();
  const c = client(w);
  check(await until(() => settled(w, c)), "closed during a retry: synced first");
  let hit, release;
  const inFlight = new Promise((ok) => { hit = ok; }), gate = new Promise((ok) => { release = ok; });
  const put0 = c["metaPut"];
  c["metaPut"] = function (k, v) {
    const p = put0.call(this, k, v);
    if (!/:retry:connect$/.test(k)) return p;
    p.catch(() => {});
    hit();
    return gate.then(() => p);
  };
  await ctl("closeAll");
  check(await settledWithin(inFlight, 5000) === "ended", "closed during a retry: the retry's write in flight, held");
  await upgradeElsewhere(w);
  check(w.closed === true && closedOff(c), "closed during a retry: the reload said at the upgrade: " + J(c.status));
  release();
  const ended = await settledWithin(c.run, 5000);
  check(ended === "ended" && closedOff(c), "closed during a retry: the held write completed after, and the reload is still the last thing said: " + J({ ended, status: c.status }));
  c["metaPut"] = put0;
  await c.stop();
}
/** The upgrade lands while the client is asking who is signed in (its namespace request held here until after the
 * upgrade, then answered 401): the late answer says nothing over the reload. */
async function closedDuringNamespace() {
  await account();
  const w = await fresh();
  let armed = false, hit, release;
  const asked = new Promise((ok) => { hit = ok; }), gate = new Promise((ok) => { release = ok; });
  const c = client(w, { fetch: async (u, init) => {
    if (armed && /\/api\/share\/me$/.test(String(u))) {
      armed = false;
      hit();
      await gate;
      return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
    }
    return fetch(u, init);
  } });
  check(await until(() => settled(w, c)), "closed during the namespace request: synced first");
  armed = true;
  await ctl("closeAll");
  check(await settledWithin(asked, 10_000) === "ended", "closed during the namespace request: the reconnect's request in flight, held");
  await upgradeElsewhere(w);
  check(w.closed === true && closedOff(c), "closed during the namespace request: the reload said at the upgrade: " + J(c.status));
  release();
  const ended = await settledWithin(c.run, 5000);
  check(ended === "ended" && closedOff(c), "closed during the namespace request: its late 401 said nothing over the reload: " + J({ ended, status: c.status }));
  await c.stop();
}

const CASES = { basics, scanAtomic, lostAckReconnect, lostAckReload, refusal, rateProlonged, reloadHonorsTimer, invalidRebuild, busyOrder, storm, netWake, twoTabs, generation, diverged, storageFull, tooLarge, reservation, pace, wakesBounded, byteMismatch, replayPaced, replayCapped, echoAcrossReload, accountSwitch, restoredCheckTimer, restoredPause, indexThrottled, corruptConcurrent, manyMismatches, lateAnswer, cutRead, restUnderAcks, refusalAtomic, echoNoCopy, liveNotice, noticeFlood, idleDiscovery, downloadBasic, downloadChecks, downloadStale, downloadStale2, downloadBudget, rebuildAfterRefusal, rebuildRate, rebuildCrashAfterAnnounce, rebuildAckWindow, rebuildAckThrows, rebuildExclusive, rebuildInvalidCrash, rebuildCounter, rebuildFailedPass, rebuildBehind, rebuildCapUnsupported, rebuildKickAfterHalt, rebuildRefusalCoreServer, firstSync, firstSyncRace, firstSyncCollision, t14Collect, t14Typed, t14Ladder, t14Refused, t14Rebuild, t14Lifecycle, t14Fencing, t14Seed, t14Cap, t14Skips, t14TwoTabs, t14Obsolete, t14Held, t14Large, t14Figures, t14Review, t14Review2, t14Review3, s5Poll, s5Section, s5Delete, s5Lifecycle, s5Tabs, s5Rows, s5Races, s5Takeover, s5Details, s5Flood, s5DetailsGap, s5Refused, s5Notebooks, s5ConfirmFetched, s5SidebarLine, s5SidebarStale, s5Wire, s5Account, s5Echo, s5Verified, docWire, s5Docs, closedByUpgrade, closedUnderClient, closedDuringRetry, closedDuringNamespace };

// ---- step 4: the rebuild at its maxima (D6 r6: the timed fixture), run only when named (minutes)

/** Puts in pages of `n` a transaction (seeding). */
async function seed(db, store, values, keyOf = null, n = 20_000) {
  for (let i = 0; i < values.length; i += n) {
    await new Promise((ok, no) => {
      const tx = db.transaction(store, "readwrite"), st = tx.objectStore(store);
      for (const v of values.slice(i, i + n)) keyOf ? st.put(v, keyOf(v)) : st.put(v);
      tx.oncomplete = ok;
      tx.onerror = () => no(tx.error);
    });
  }
}
const metaPutRaw = (db, k, v) => seed(db, "meta", [v], () => k);
const id16 = (lead, i) => lead + i.toString(16).padStart(15, "0");

/** IndexedDB requests counted per transaction, tagged with the phase running (`window.__phase`), while measuring. */
function countRequests() {
  const counts = new WeakMap(), out = [], undo = [];
  const txOf = (x) => x?.transaction ?? x?.objectStore?.transaction ?? x?.source?.transaction ?? x?.source?.objectStore?.transaction;
  const note = (self) => {
    const tx = txOf(self);
    if (!tx) return;
    if (!counts.has(tx)) {
      counts.set(tx, { n: 0, phase: window.__phase ?? "" });
      tx.addEventListener("complete", () => { const c = counts.get(tx); if (c.phase) out.push(c); });
    }
    counts.get(tx).n++;
  };
  const wrap = (proto, names) => { for (const name of names) { const f = proto[name]; undo.push(() => (proto[name] = f)); proto[name] = function (...a) { note(this); return f.apply(this, a); }; } };
  wrap(IDBObjectStore.prototype, ["get", "getAll", "getAllKeys", "getKey", "put", "add", "delete", "count", "openCursor", "openKeyCursor", "clear"]);
  wrap(IDBIndex.prototype, ["get", "getAll", "getAllKeys", "getKey", "count", "openCursor", "openKeyCursor"]);
  wrap(IDBCursor.prototype, ["continue", "advance"]);
  return { out, stop: () => undo.forEach((f) => f()) };
}

async function scaleRebuild() {
  await account();
  const w = await fresh();
  const c0 = viewClient(w);
  check(await until(() => settled(w, c0), 20_000), "scale: synced");
  const ns = nsOf(c0);
  await stop(c0);
  const t0 = Date.now();
  const gen = ((await metaGet(w.ws, `sync:${ns}:genNext`)) ?? (await metaGet(w.ws, `sync:${ns}:indexGen`)) ?? 0) + 1;
  const gp = W.genPrefix(ns, gen), jp = W.journalPrefix(ns, gen), J0 = `${ns}#reissue#old`;
  const now = Date.now(), SHA_A = "a".repeat(64), SHA_B = "b".repeat(64);
  // (the staging index: 100,000 identities, 20 folders of 4,999 files)
  const rows = [];
  for (let k = 0; k < 20; k++) rows.push({ ns: gp, id: id16("3", k), path: `/S${k}`, key: `/S${k}`, parentKey: "/", kind: "folder", fid: id16("3", k), created: now, updated: now, by: "person", seq: k + 1 });
  for (let i = 0; i < 99_980; i++) { const k = i % 20, p = `/S${k}/y${i}`; rows.push({ ns: gp, id: id16("1", i), path: p, key: p, parentKey: `/S${k}`, kind: "file", fid: id16("1", i), sha256: SHA_A, size: 1, created: now, updated: now, by: "person", seq: 100 + i }); }
  await seed(w.ws, "syncIndex", rows);
  rows.length = 0;
  // (100,000 other identities here: 20 folders of 4,999 files, disjoint from the index's)
  const ents = [];
  for (let k = 0; k < 20; k++) ents.push({ path: `/L${k}`, kind: "folder", ref: null, created: now, updated: now, fid: id16("4", k), ident: id16("4", k), nkey: `/\u0000L${k}` });
  for (let i = 0; i < 99_980; i++) { const k = i % 20, p = `/L${k}/x${i}`; ents.push({ path: p, kind: "file", ref: p, created: now, updated: now, size: 1, rev: 0, fid: id16("2", i), migrated: true, sha256: SHA_A, ident: id16("2", i), nkey: `/L${k}\u0000x${i}` }); }
  await seed(w.ws, "entries", ents);
  // (10,000 records below server_next, half of them with their echoes staged; an earlier committed journal's 100,000
  // undrained records)
  const recs = [];
  for (let d = 1; d <= 10_000; d++) { const e = ents[20 + d]; recs.push({ ns, dseq: d, lseq: 0, id: e.ident, op: { dseq: d, t: now, by: "person", op: "write", path: e.path, kind: "file", fid: e.fid, sha256: SHA_B, size: 1 } }); }
  await seed(w.ws, "outbox", recs);
  const jrows = [];
  for (let d = 1; d <= 5_000; d++) jrows.push({ ns: jp, id: "e:" + String(d).padStart(16, "0"), dseq: d, seq: d });
  for (const e of ents) jrows.push({ ns: J0, id: e.ident, parent: "", name: e.path.split("/").pop(), kind: e.kind, ...(e.kind === "file" ? { sha256: SHA_A, size: 1 } : {}), trashed: false });
  await seed(w.ws, "adoptJournal", jrows);
  ents.length = 0; jrows.length = 0; recs.length = 0;
  await metaPutRaw(w.ws, `sync:${ns}:dseq`, 10_001);
  await metaPutRaw(w.ws, `sync:${ns}:outbox`, { count: 10_000, bytes: 0, charged: 0 });
  await metaPutRaw(w.ws, `sync:${ns}:journal`, J0);
  await metaPutRaw(w.ws, `sync:${ns}:genNext`, gen);
  await new Promise((ok, no) => { const tx = w.ws.transaction("meta", "readwrite"); W.obligate(tx.objectStore("meta"), ns, "refused").then(() => {}, no); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  const n0 = (await metaGet(w.ws, `sync:${ns}:rebuild`)).n;
  await metaPutRaw(w.ws, `sync:${ns}:pass`, { phase: "log", gen, n0, serverNext: 10_001, pages: { log: 0, capture: 0, view: 0, retire: 0, clean: 0 } });
  await metaPutRaw(w.ws, `sync:${ns}:pass:cursor`, 1e12);
  check(true, `scale: seeded in ${Math.round((Date.now() - t0) / 1000)} s`);
  // (measured: requests per transaction, long tasks and heap, from done's commit to the announce)
  const reqs = countRequests();
  const longs = [];
  const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (window.__phase) longs.push(e.duration); });
  try { obs.observe({ type: "longtask" }); } catch {}
  globalThis.gc?.();
  let heap0 = performance.memory?.usedJSHeapSize ?? 0, heapMax = heap0, pages = null;
  const at = {};
  W.REBUILD.before = async (phase) => {
    at[phase] ??= Date.now();
    if (phase === "view-page" || phase === "retire-page") { window.__phase = phase; heapMax = Math.max(heapMax, performance.memory?.usedJSHeapSize ?? 0); }
    else if (phase === "announce") { window.__phase = ""; pages = (await W.passOf(w, ns))?.pages; }
    else window.__phase = "";
  };
  await ctl("log", { reset: true });
  const c = viewClient(w);
  try {
    check(await until(async () => opsMessages(await ctl("log")).length > 0, 900_000), "scale: the pass ran and sending resumed: " + J({ phase: c.stats.rebuildPhase, error: c.stats.rebuildError }));
    const firstOps = opsMessages(await ctl("log"))[0];
    const doneToResume = (firstOps.at - c.stats.rebuildDoneAt) / 1000;
    check(pages?.view === 2000 && pages?.retire === 1100, "scale: exactly 2,000 view pages and 1,100 retire pages: " + J(pages));
    const byPhase = (ph) => reqs.out.filter((x) => x.phase === ph).map((x) => x.n);
    const vmax = Math.max(...byPhase("view-page")), rmax = Math.max(...byPhase("retire-page"));
    check(vmax <= 400 && rmax <= 400, "scale: each transaction within 400 IndexedDB requests: " + J({ view: vmax, retire: rmax }));
    const longest = Math.max(0, ...longs);
    check(longest < 50, "scale: every long task under 50 ms: longest " + Math.round(longest) + " ms, " + longs.length + " over 50");
    check(doneToResume <= 300, `scale: done to resume (the first ops message) ${doneToResume.toFixed(1)} s (at most 300 s)`);
    const secs = (a, b) => (a && b ? +((b - a) / 1000).toFixed(1) : null);
    check(true, "scale: figures " + J({ doneToResumeS: +doneToResume.toFixed(1), viewS: secs(at["view-page"], at["retire-page"]), retireS: secs(at["retire-page"], at.announce), announceToOpsS: secs(at.announce, firstOps.at), viewMaxRequests: vmax, retireMaxRequests: rmax, longestTaskMs: Math.round(longest), heapGrowthMiB: +((heapMax - heap0) / 2 ** 20).toFixed(1) }));
  } finally {
    W.REBUILD.before = null;
    window.__phase = "";
    reqs.stop();
    obs.disconnect();
    await stop(c);
  }
}
const SCALE = { scaleRebuild };

export async function run(only = "", skip = "") {
  // (3b: diagnostic only when the page has budgets and the front answers the proof route's quiet; otherwise the loop
  // below, as it was, with only window.__report.mode added)
  const mode = await diagnosticMode();
  if (mode.on) return runDiagnostic({ ...CASES, ...(only ? SCALE : {}) }, only, skip, mode.budgets);
  window.__report = { mode: "legacy", why: mode.why };
  // (the scale cases run only when named; the cases named in `skip` never run: the runner says why, for each)
  const skipped = skip ? skip.split(",") : [];
  for (const [name, f] of Object.entries({ ...CASES, ...(only ? SCALE : {}) })) {
    if (only && !only.split(",").includes(name)) continue;
    if (skipped.includes(name)) continue;
    window.progress = { name, checks: results.length };
    try {
      await f();
    } catch (e) {
      check(false, `${name}: threw ${e?.stack ?? e}`);
    }
    await ctl("reset");
  }
  for (const w of used) try { w.close(); } catch {}
  return results;
}

// ---- 3b's diagnostic run (plan r2 §3, r3 §3, r4 §1): epochs, steps, a bounded cleanup after every case that proves the
// page and the front quiet (else fail-stop: nothing more runs on state that isn't proved clean), and window.__report kept
// current at every boundary, in memory, for the runner's polls

const caseBound = (b, name) => b.CASE_MS[name] ?? b.CASE_FLOOR_MS;
/** A quiet that answers with the registry's shape, else a rejection (never taken for quiescence) */
const quietD = async () => { const q = await proofD("quiet"); if (!quietShape(q)) throw new Error(`quiet answered ${J(q).slice(0, 200)}`); return q; };

/** After case n: C1-C6 within CLEANUP_MS from its start (r4 §1); ok, or where and why not.  `q0`: the quiet at the
 * case's start (its close failures and untracked reads must be unchanged at the end, r5 §2). */
async function cleanupCase(n, q0) {
  const d = D;
  d.cleanupDeadline = now() + d.budgets.CLEANUP_MS;
  const stages = [];
  let at = "C1";
  const fail = (why, quiet) => ({ ok: false, step: at, why, quiet, stages });
  const left = () => d.cleanupDeadline - now();
  try {
    // C1: each SyncOwner the case made destroyed, and its owned work (its client's stop and loop, its reconcile)
    // awaited; then each of the case's clients stopped, then its loop's end awaited.  A stop that rejects is a failure,
    // named (fail-stop); a loop (c.run) that rejected has ended: said, not a failure; anything that never ends is.
    for (const o of d.owners) {
      at = "cleanup: owner.destroy()";
      await step(at, () => o.destroy());
      stages.push(`${at} ok`);
      // (every piece of work the owner ever detached, kept by the wrapped stopClient, its destroy()'s own included: the
      // stopClient itself (a rejected stop is a failure, I-5), then its client's stop and loop)
      for (const x of d.detached.get(o) ?? []) {
        at = "cleanup: owner's detached stopClient";
        await step(at, () => x.p);
        stages.push(`${at} ok`);
        // (the client's stop is what stopClient itself awaited: not called again)
        if (x.run) {
          at = "cleanup: owner's client loop";
          try { await step(at, () => x.run); stages.push(`${at} ok`); } catch (e) { if (e instanceof StepTimeout) throw e; stages.push(`${at} rejected (${e?.message ?? e})`); }
        }
      }
      at = "cleanup: owner's reconcile";
      await step(at, () => o["reconciling"]);
      stages.push(`${at} ok`);
    }
    for (const c of d.clients) {
      at = "cleanup: c.stop()";
      await step(at, () => c.stop());
      stages.push(`${at} ok`);
      at = "cleanup: c.run";
      try { await step(at, () => c.run); stages.push(`${at} ok`); } catch (e) { if (e instanceof StepTimeout) throw e; stages.push(`${at} rejected (${e?.message ?? e})`); }
    }
    // C2, C3: the front's held waiters released, its proxied sockets closed (a rejection here is a failure)
    at = "cleanup: release";
    await ctlD("release");
    at = "cleanup: closeAll";
    const ca = await ctlD("closeAll");
    if (ca?.error) return fail(`closeAll answered ${J(ca)}`);
    // C4: drain: nothing in flight on the front (any tag), no proxied socket, no held waiter, nothing pending here
    at = "C4 drain";
    let q;
    for (;;) {
      q = await quietD();
      if (q.inflight.length === 0 && q.closers === 0 && q.held === 0 && d.pending.size === 0) break;
      if (left() <= 100) return fail(`not drained: ${J({ inflight: q.inflight, closers: q.closers, held: q.held, pending: [...d.pending].map((p) => p.label) })}`, q);
      await sleep(100);
    }
    at = "C4 drained(n)";
    await proofD("drained", n);
    // C5: the log's cross-check, read before the reset (tagged c<n> now)
    at = "C5 log";
    const l = await ctlD("log");
    if (!(l.open === 0 && l.putsNow === 0)) return fail(`log: open ${l.open}, putsNow ${l.putsNow}`);
    at = "C5 reset";
    await ctlD("reset");
    // C6: cleanup's own operations ended, c<n> drained, then nothing late or pending-late for n or c<n>, no new close
    // failure, no untracked read
    at = "C6 c(n) drain";
    for (;;) {
      q = await quietD();
      if (!q.inflight.some((e) => e.tag === `c${n}`)) break;
      if (left() <= 100) return fail(`cleanup's own operations still in flight: ${J(q.inflight)}`, q);
      await sleep(100);
    }
    at = "C6 drained(c(n))";
    await proofD("drained", n, "cleanup");
    at = "C6 final quiet";
    q = await quietD();
    const mine = (e) => e.tag === String(n) || e.tag === `c${n}`;
    const late = q.late.filter(mine), pendingLate = q.pendingLate.filter(mine);
    if (late.length || pendingLate.length) return fail(`late ${J(late)}, pending-late ${J(pendingLate)}`, q);
    if (q.closeFailures !== q0.closeFailures) return fail(`close failures ${q0.closeFailures} -> ${q.closeFailures}`, q);
    if (q.untrackedReads !== q0.untrackedReads) return fail(`untracked reads ${q0.untrackedReads} -> ${q.untrackedReads}`, q);
    return { ok: true, stages };
  } catch (e) {
    return fail(e instanceof StepTimeout ? `timed out: ${e.step}` : `rejected: ${e?.message ?? e}`);
  } finally {
    d.cleanupDeadline = null;
  }
}

/** The run in diagnostic mode: the same selection as run(), the same results array */
async function runDiagnostic(table, only, skip, budgets) {
  const d = (D = { budgets, clients: [], owners: [], pending: new Set(), steps: [], late: [], lateOpened: [], names: new Map(), detached: new Map(), openDelayMs: 0, caseDeadline: null, cleanupDeadline: null, epoch: 0, failStopNow: false });
  const rep = (window.__report = { mode: "diagnostic", why: null, startedMs: Math.round(now()), cases: [], steps: d.steps, late: d.late, lateOpened: d.lateOpened, closedAtEnd: [], stopped: null, notRun: [], progress: null, results, done: false });
  // (every SyncOwner a case makes registered for its cleanup: SyncOwner.of wrapped for this run only, restored after)
  const of0 = W.SyncOwner.of;
  // (each registered owner's stopClient wrapped on the instance, for this run: what it detaches (its client and that
  // client's loop) and its own promise are kept BEFORE the owner erases its fields, so C1 awaits work that an earlier
  // destroy(), suspend() or setDocs() left running; unwrapped in the finally)
  const wrapped = [];
  W.SyncOwner.of = function (w, opts) {
    const o = of0.call(this, w, opts);
    if (D === d && !d.owners.includes(o)) d.owners.push(o);
    if (D === d && !Object.hasOwn(o, "stopClient")) {
      const sc0 = o["stopClient"], work = [];
      d.detached.set(o, work);
      o["stopClient"] = function () { const c = this.client, run = this["run"]; const p = sc0.call(this); work.push({ c, run, p }); return p; };
      wrapped.push(o);
    }
    return o;
  };
  try {
    const skipped = skip ? skip.split(",") : [];
    const list = Object.entries(table).filter(([name]) => !(only && !only.split(",").includes(name)) && !skipped.includes(name));
    for (let i = 0; i < list.length; i++) {
      const [name, f] = list[i];
      const n = ++d.epoch;
      let q0;
      try { await proofD("epoch", n); q0 = await quietD(); } catch (e) { rep.stopped = { case: name, step: "epoch", why: e?.message ?? String(e) }; break; }
      const cs = { name, startMs: Math.round(now()), checks: results.length, outcome: null };
      rep.cases.push(cs);
      window.progress = rep.progress = { name, checks: results.length, startMs: cs.startMs };
      d.clients = [];
      d.owners = [];
      d.caseDeadline = now() + caseBound(budgets, name);
      try {
        await f();
        cs.outcome = "ok";
      } catch (e) {
        cs.outcome = e instanceof StepTimeout ? `timeout: ${e.step}` : `threw: ${e?.message ?? e}`;
        check(false, `${name}: threw ${e?.stack ?? e}`);
      }
      d.caseDeadline = null;
      cs.endMs = Math.round(now());
      const over = (cs.endMs - cs.startMs - caseBound(budgets, name)) / 1000;
      if (over > 0) cs.over = +over.toFixed(1);
      const cl = d.failStopNow ? { ok: false, step: "(control) failStopNow", why: "the page stops before its cleanup" } : await cleanupCase(n, q0);
      cs.cleanup = cl;
      cs.cleanupEndMs = Math.round(now());
      if (!cl.ok) {
        // FAIL-STOP: the epoch abandoned, what was still in flight named, every remaining case not run
        let q = null;
        try { await proofD("abandon", n); q = await quietD(); } catch {}
        rep.stopped = { case: name, step: cl.step, why: cl.why, pending: [...d.pending].map((p) => p.label), pendingLate: (q?.pendingLate ?? []).map((e) => `${e.label}@${e.tag}`), late: (q?.late ?? []).map((e) => `${e.label}@${e.tag}`) };
        for (const [rest] of list.slice(i + 1)) { rep.notRun.push(rest); check(false, `${rest}: not run (fail-stop after ${name})`); }
        break;
      }
    }
    return results;
  } finally {
    // (every workspace the run opened closed, however it ended, a late-opened one included; one that opens later still
    // is closed by its own fulfilment, d.over)
    d.over = true;
    // (a page that stops before its cleanup (K-RES1's failStopNow) leaves its workspaces open as well: closing one under
    // its still-running client would end that client, and its socket, before the runner's barrier can close it)
    if (!d.failStopNow) for (const w of used) try { w.close(); rep.closedAtEnd.push(d.names.get(w) ?? null); } catch {}
    W.SyncOwner.of = of0;
    for (const o of wrapped) delete o["stopClient"];
    rep.done = true;
    D = null;
  }
}

// ---- 3b's controls (plan r3 §4, r4 §3, r5 §1-§2, r6 §3): each would fail against 7777f20b's code.  The runner loads
// them on its control pages (each a fresh navigation, with small budgets) and requires every line ok.  They use their
// own accounts (ctl.html's window.ACCOUNTS).

const ctlWithin = (cmd, extra, ms) => ctlD(cmd, extra, ms);
const quietNow = () => quietD();
/** K-G's dependent work: never done after K-C's fail-stop */
let kGRuns = 0;
const CONTROL_CASES = {
  P1: {
    // K-R1: a quiet during a pending ctl sees that op, never itself
    async kR1() {
      const p = ctl("hang").catch(() => {});
      await sleep(200);
      const q = await quietNow();
      check(q.inflight.length === 1 && q.inflight[0].label === "ctl hang" && !q.inflight.some((e) => /proof|quiet/.test(e.label)), "K-R1: quiet sees the pending ctl hang and never itself: " + J(q.inflight));
      await ctl("release");
      await p;
    },
    // K-R2: a body read outside any operation is counted; then reset, the exact one only
    async kR2() {
      const q0 = await quietNow();
      const r = await S("K-R2: untracked read", (lim) => fetch("/__untracked", { method: "POST", body: "x", signal: AbortSignal.timeout(lim + 100) }).then((x) => x.json()));
      const q1 = await quietNow();
      check(q1.untrackedReads === q0.untrackedReads + 1 && r.untrackedReads === q1.untrackedReads, "K-R2: an untracked read is detected: " + J({ before: q0.untrackedReads, after: q1.untrackedReads }));
      const z = await ctl("untrackedReset", { to: q0.untrackedReads });
      const q2 = await quietNow();
      check(z.ok === true && q2.untrackedReads === q0.untrackedReads, "K-R2: …and reset, exactly that one: " + J({ reset: z, now: q2.untrackedReads }));
    },
    // K-L1: a healthy case: no late, no pending-late, c(n) closes (the runner checks its cleanup)
    async kL1() {
      await account();
      const w = await fresh();
      const c = client(w);
      const ok = await until(named("K-L1: settled", () => settled(w, c)), 3000);
      // (r6, evidence first: what the client was doing when the window ended, recorded whether it synced or not; the
      // window itself is unchanged)
      const at = { state: c.status.state, ns: (nsOf(c) ?? "").slice(0, 16), inflight: c.debug().inflight, outbox: await S("K-L1: the outbox at the window's end", () => outbox(w)) };
      check(ok, "K-L1: a client synced: at the window's end " + J(at));
      await ctl("log");
    },
    // K-B: a ctl that never answers: StepTimeout naming it; cleanup's release frees it
    async kB() { await ctl("hang"); },
    // K-D: a step that times out, then settles 1 s later: a late record, and the next case starts after it
    async kD() { await S("K-D: a slow page step", () => sleep(CONTROL_D_MS).then(() => { window.__kDSettled = now(); })); },
    // K-F: a rejection passes through as itself
    async kF() { await S("K-F: rejects at once", () => Promise.reject(new Error("K-F injected"))); },
    // K-H: until's window expiring is false, never a StepTimeout
    async kH() {
      const t0 = now();
      const r = await until(named("K-H: false after 300 ms", async () => { await sleep(300); return false; }), 1000);
      check(r === false && now() - t0 < 2000, "K-H: until's window expired: false, no StepTimeout: " + J({ r, ms: Math.round(now() - t0) }));
    },
    // K-I: a front op the page abandons at 0.5 s: cleanup waits for it (2 s), with no late
    async kI() { await ctlWithin("slow", { ms: 2000 }, 500); },
    // K-U1: probe failing after its socket is acquired: the error reaches the case; the socket closed; nothing kept
    async kU1() {
      await account();
      await ctl("set", { set: { probeFailAfterConnect: true } });
      const q0 = await quietNow();
      const r = await S("K-U1: ctl probe", (lim) => fetch("/__ctl", { method: "POST", body: J({ cmd: "probe" }), signal: AbortSignal.timeout(lim + 100) }).then(async (x) => ({ status: x.status, text: await x.text() })));
      let q1 = await quietNow();
      for (let i = 0; i < 20 && q1.unconfirmed; i++) { await sleep(20); q1 = await quietNow(); }
      check(r.status === 500 && r.text.includes("injected: probe failed after connect") && q1.armed.probeFailAfterConnect === false && q1.ups === q0.ups && q1.closeFailures === q0.closeFailures && q1.unconfirmed === 0, "K-U1: probe's error reaches the case; its socket closed and idle, nothing kept, the flag consumed: " + J({ status: r.status, text: r.text.slice(0, 80), armed: q1.armed, ups: [q0.ups, q1.ups], closeFailures: [q0.closeFailures, q1.closeFailures], unconfirmed: q1.unconfirmed }));
    },
    // K-W1: a workspace open that ends after its step timed out (2 s; it ends at 3 s): kept (registered in its own
    // fulfilment), said late, the cleanup waits for it, and the run's end closes it
    async kW1() {
      D.openDelayMs = 3000;
      try { await fresh(); } finally { D.openDelayMs = 0; }
    },
    // K-O1: a real owner, sync turned on through the panel, its client running; its client's stop made slow (1.5 s);
    // the case destroys the owner early (destroy() detaches the client and its loop, then erases its fields) and fails
    // at once: the cleanup must await that detached stop and loop (sentinels), then the owner's reconcile
    async kO1() {
      await account();
      const w = await fresh();
      const o = W.SyncOwner.of(w, { origin: location.origin });
      // (r6, evidence first: whether the Turn on button appeared, whether it was clicked, each clientRunning answer, the
      // owner's view and the durable sync:current, all recorded; no window is changed)
      const diag = { button: null, clicked: false, running: [], view: null, current: null };
      window.__kO1 = { o, stopDone: null, runDone: null, hadClient: false, diag };
      o.start();
      const el = document.createElement("div");
      const s = W.syncSection(w, el, hostOf(w));
      try {
        diag.button = await until(named("K-O1: the Turn on button", () => /Turn on sync/.test(buttons(el).join())), 3000);
        const btn = [...el.querySelectorAll("button")].find((b) => /Turn on sync/.test(b.textContent));
        // (a missing button is a failed control with its own reason, never a silent skip)
        if (!diag.button || !btn) check(false, "K-O1: the Turn on sync button didn't appear within 3 s, so nothing was clicked: the buttons were " + J(buttons(el)));
        else { btn.click(); diag.clicked = true; }
        // (each wait one step, inside STEP_MS; up to six of them; each answer kept)
        for (let i = 0; i < 6; i++) { const r = await S("K-O1: the owner's client running", () => o.clientRunning(1500)); diag.running.push(r); if (r) break; }
        diag.view = o.view();
        diag.current = (await S("K-O1: the durable sync:current", () => metaGet(w.ws, "sync:current"))) ?? null;
        const c = o.client, run = o["run"];
        window.__kO1.hadClient = !!c && !!run;
        if (c) {
          const stop0 = c.stop.bind(c);
          c.stop = async () => { await sleep(1500); await stop0(); window.__kO1.stopDone ??= now(); };
          run.then(() => { window.__kO1.runDone = now(); }, () => { window.__kO1.runDone = now(); });
        }
      } finally { s.dispose(); }
      o.destroy();
      throw new Error("K-O1 injected: the case failed right after an early destroy()");
    },
  },
  // K-S1: a client whose stop rejects at once, its loop already settled: a named fail-stop at cleanup: c.stop()
  P9: { async kS1() { D.clients.push({ stop: () => Promise.reject(new Error("K-S1 injected")), run: Promise.resolve() }); } },
  // K-A: a predicate that never settles: StepTimeout, the pending set never empties, fail-stop naming it
  P2: { async kA() { await until(named("K-A: never settles", () => new Promise(() => {})), 10_000); } },
  // K-C: a client whose stop never settles: fail-stop at cleanup's c.stop(); then K-G never runs
  P3: {
    async kC() { D.clients.push({ stop: () => new Promise(() => {}), run: Promise.resolve() }); },
    async kG() { kGRuns++; },
  },
  // K-E: closeAll rejects: a cleanup failure, fail-stop
  P4: { async kE() { await ctl("set", { set: { closeAllReject: true } }); } },
  // K-J: a front op longer than the cleanup: fail-stop, abandoned, pending-late; the runner's barrier sees it end late
  P5: { async kJ() { await ctlWithin("slow", { ms: 10_000 }, 500); } },
  // K-L2: an op tagged n that starts at drained(n) and ends 1 s later: late or pending-late for n, fail-stop
  P6: { async kL2() { await ctl("armLate"); } },
  // K-RES1: a proxied socket left open with nothing in flight: the page stops before its cleanup; the runner's barrier
  // must close it itself
  RES1: {
    async kRES1() {
      await account();
      const w = await fresh();
      client(w);
      check(await until(named("K-RES1: a proxied socket open", async () => (await quietNow()).closers === 1), 3000), "K-RES1: a proxied socket open");
      await ctl("set", { set: { refuseUpgrades: true } });
      D.failStopNow = true;
    },
  },
};
/** K-D's step settles this long after its start: past the step's 2 s, inside the cleanup's 5 s */
const CONTROL_D_MS = 3000;

/** What each control page's run must show (beyond its cases' own checks) */
function controlLines(page, rep) {
  const cs = (name) => rep.cases.find((c) => c.name === name);
  const lines = [];
  const add = (ok, what) => lines.push([!!ok, what]);
  const clean = (name) => cs(name)?.cleanup?.ok === true;
  const own = (name, re) => results.filter(([ok, what]) => what.startsWith(re)).every(([ok]) => ok) && results.some(([, what]) => what.startsWith(re));
  if (page === "P1") {
    add(!rep.stopped && rep.cases.length === 11, "P1 ran every control, with no fail-stop: " + J({ stopped: rep.stopped, cases: rep.cases.map((c) => c.name) }));
    add(cs("kR1")?.outcome === "ok" && clean("kR1") && own("kR1", "K-R1"), "K-R1: quiet never sees itself: " + J(cs("kR1")));
    add(cs("kR2")?.outcome === "ok" && clean("kR2") && own("kR2", "K-R2"), "K-R2: an untracked read is detected, then reset exactly: " + J(cs("kR2")));
    add(cs("kL1")?.outcome === "ok" && clean("kL1") && own("kL1", "K-L1"), "K-L1: a healthy case: c(n) closes, zero late, zero pending-late: " + J(cs("kL1")));
    add(cs("kB")?.outcome === "timeout: ctl hang" && clean("kB"), "K-B: a ctl that never answers times out, named; cleanup's release frees it: " + J(cs("kB")));
    add(cs("kD")?.outcome === "timeout: K-D: a slow page step" && clean("kD") && rep.late.some((l) => l.startsWith("late: K-D: a slow page step")) && window.__kDSettled !== undefined && cs("kF")?.startMs > window.__kDSettled, "K-D: a late page record, and the next case started after it settled: " + J({ kD: cs("kD"), late: rep.late, settled: window.__kDSettled, next: cs("kF")?.startMs }));
    add(cs("kF")?.outcome === "threw: K-F injected" && clean("kF"), "K-F: a rejection passes through as itself: " + J(cs("kF")));
    add(cs("kH")?.outcome === "ok" && clean("kH") && own("kH", "K-H"), "K-H: until's window expiring is false, no StepTimeout: " + J(cs("kH")));
    add(cs("kI")?.outcome === "timeout: ctl slow" && clean("kI"), "K-I: the front op outlives the page's 0.5 s; cleanup waits for it, no late: " + J(cs("kI")));
    add(cs("kU1")?.outcome === "ok" && clean("kU1") && own("kU1", "K-U1"), "K-U1: probe's failure after acquisition reaches the case, its socket closed: " + J(cs("kU1")));
    const wName = rep.lateOpened[0];
    add(cs("kW1")?.outcome === "timeout: fresh: Workspace.open" && clean("kW1") && rep.lateOpened.length === 1 && rep.closedAtEnd.includes(wName), "K-W1: a late open is kept, said, waited for, and closed at the run's end: " + J({ kW1: cs("kW1"), late: rep.lateOpened, closed: rep.closedAtEnd.includes(wName) }));
    const k = window.__kO1 ?? {}, o = k.o, ended = cs("kO1")?.cleanup?.stages ?? [];
    add(cs("kO1")?.outcome?.startsWith("threw: K-O1 injected") && clean("kO1") && k.hadClient && k.stopDone !== null && k.runDone !== null && ended.includes("cleanup: owner's detached stopClient ok") && ended.includes("cleanup: owner's client loop ok") && o?.["suspended"] === true && o?.client === null && rep.cases.every((c) => c.name !== "kO1" || c.cleanupEndMs >= Math.max(k.stopDone, k.runDone)), "K-O1: a running owner destroyed early by a failed case: the cleanup awaited its detached (slow) stop and its loop: " + J({ outcome: cs("kO1")?.outcome, hadClient: k.hadClient, stopDone: k.stopDone, runDone: k.runDone, stages: ended, diag: k.diag }));
  } else if (page === "P9") {
    add(rep.stopped?.case === "kS1" && rep.stopped.step === "cleanup: c.stop()" && /^rejected: K-S1 injected/.test(rep.stopped.why), "K-S1: a stop that rejects (its loop settled) is a named fail-stop: " + J(rep.stopped));
  } else if (page === "P2") {
    add(rep.stopped?.case === "kA" && rep.stopped.step === "C4 drain" && rep.stopped.pending.includes("until: K-A: never settles") && cs("kA")?.outcome === "timeout: until: K-A: never settles", "K-A: a predicate that never settles: StepTimeout, then fail-stop naming it: " + J(rep.stopped));
  } else if (page === "P3") {
    add(rep.stopped?.case === "kC" && rep.stopped.step === "cleanup: c.stop()", "K-C: a stop that never settles: fail-stop at cleanup: c.stop(): " + J(rep.stopped));
    add(rep.notRun.includes("kG") && kGRuns === 0 && !cs("kG"), "K-G: after the fail-stop, the next case never runs (its counter 0): " + J({ notRun: rep.notRun, kGRuns }));
  } else if (page === "P4") {
    add(rep.stopped?.case === "kE" && rep.stopped.step === "cleanup: closeAll", "K-E: closeAll rejects: a cleanup failure, fail-stop: " + J(rep.stopped));
  } else if (page === "P5") {
    add(rep.stopped?.case === "kJ" && rep.stopped.step === "C4 drain" && rep.stopped.pendingLate.some((x) => /^ctl slow@/.test(x)), "K-J: a front op past the cleanup: fail-stop, abandoned, pending-late ctl slow: " + J(rep.stopped));
  } else if (page === "P6") {
    add(rep.stopped?.case === "kL2" && rep.stopped.step === "C6 final quiet" && [...rep.stopped.pendingLate, ...rep.stopped.late].some((x) => /^armed late@/.test(x)), "K-L2: an op of epoch n ending after drained(n): late or pending-late, fail-stop: " + J(rep.stopped));
  } else if (page === "RES1") {
    add(rep.stopped?.case === "kRES1" && rep.stopped.step === "(control) failStopNow" && own("kRES1", "K-RES1"), "K-RES1: the page stopped with its proxied socket open: " + J(rep.stopped));
  }
  return lines;
}

/** A control page's run: diagnostic for every page but P7 (no budgets: legacy, the old loop over one real case) and P8
 * (budgets, but a front whose quiet is unknown: legacy, which the runner must refuse) */
export async function runControls(page) {
  if (page === "P7" || page === "P8") {
    const mode = await diagnosticMode();
    const out = [];
    if (page === "P7") {
      // (r6, a NAMED DEVIATION from plan r3/r4's "one trivial case", @sagebrush's (A): the empty selection, the legacy
      // loop with zero iterations. No case in CASES is code-bounded in legacy (account(), :19-28, makes bare fetches);
      // with a name no case has, every entry of the pinned loop continues before f() and before ctl("reset"). The
      // runner proves from its own count that this page made no request at all while it ran.)
      const res = await run("kM1-the-empty-selection");
      out.push([!mode.on && window.__report?.mode === "legacy" && Array.isArray(res) && res.every((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === "boolean" && typeof x[1] === "string") && window.progress === undefined, "K-M1: no budgets: legacy, the old loop with zero iterations (the empty selection), the results shape: " + J({ mode: window.__report?.mode, why: window.__report?.why, results: res?.length, progress: window.progress ?? null })]);
    } else out.push([!mode.on && /^quiet answered /.test(mode.why), "K-M2: budgets, but quiet unknown: legacy: " + mode.why]);
    window.__report = { mode: "legacy", why: mode.why, done: true };
    return out;
  }
  const mode = await diagnosticMode();
  if (!mode.on) { window.__report = { mode: "legacy", why: mode.why, done: true }; return [[false, `${page}: diagnostic mode not active: ${mode.why}`]]; }
  await runDiagnostic(CONTROL_CASES[page], "", "", mode.budgets);
  return controlLines(page, window.__report);
}
