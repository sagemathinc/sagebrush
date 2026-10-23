// The cases of web/workspace/test-workspace-sync-client.mjs (sync client step 3, design/sync-client.md §3, C1,
// L2, L3, L4): the sender against the sync service in Miniflare, through the test's front (/__ctl), which can
// drop acks, fake the server's errors, close sockets and hold uploads.
import * as W from "./ws.js";

const results = [];
const check = (ok, what) => results.push([!!ok, what]);
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0, acct = 0;
const names = () => { n++; return { name: `ws-sc-${n}-${Math.random().toString(36).slice(2, 8)}`, mainName: `main-sc-${n}` }; };
const fresh = async (nm = names()) => { localStorage.clear(); const w = await W.Workspace.open(nm); used.push(w); return w; };
const used = [];
const ctl = async (cmd, extra = {}) => (await fetch("/__ctl", { method: "POST", body: J({ cmd, ...extra }) })).json();
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: J(body ?? {}) });
/** A new account, signed in, sync on: its own log. */
async function account(id = window.ACCOUNTS[acct++]) {
  const s = await post("/auth/dev", { token: "dev-token", account_id: id });
  if (!s.ok) throw new Error("sign-in: " + s.status);
  const e = await post("/api/sync/v1/enable", {});
  if (!e.ok) throw new Error("enable: " + e.status + " " + (await e.text()));
  await ctl("reset");
  return id;
}
async function until(f, ms = 10_000) {
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
  if (!ns || c.status.state !== "synced" || (await outbox(w)) !== 0) return false;
  const scanned = await metaGet(w.ws, `sync:${ns}:scanned`);
  return scanned >= (await w.lastSeq()) && c.debug().inflight === 0;
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
  return c;
}
async function stop(c) {
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
  const p = await ctl("probe");
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
  check(puts.length === 0 && refused.length === 1 && refused[0].code === "missing" && refused[0].path === "/f.txt", "refusal: no bytes to upload, the op sent anyway, refused `missing`, listed with its code and path: " + J(refused));
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

async function storm() {
  await account();
  const w = await fresh();
  await ctl("set", { set: { closeOnOpen: 6 } });
  const clock = fakeClock();
  const c = client(w, { clock });
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

const CASES = { basics, lostAckReconnect, lostAckReload, refusal, rateProlonged, reloadHonorsTimer, invalidRebuild, busyOrder, storm, twoTabs, generation, diverged, storageFull, tooLarge, reservation, pace };

export async function run(only = "") {
  for (const [name, f] of Object.entries(CASES)) {
    if (only && !only.split(",").includes(name)) continue;
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
