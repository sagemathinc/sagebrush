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
  check((await ctl("log")).http.filter((h) => h.method === "PUT" && h.status === 201).length === 3, "byte mismatch: …uploaded once each");
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
  const A = await account(), B = await account();
  await signInOnly(A);
  await ctl("reset");
  const w = await fresh();
  const c0 = client(w);
  check(await until(() => settled(w, c0)), "account switch: synced as A");
  const nsA = nsOf(c0);
  const from = await w.lastSeq();
  await stop(c0);
  await w.mkdir("/a-only");
  // (B signs in just before the socket opens: discovery said A, the socket is B's)
  await ctl("set", { set: { switchOnUpgrade: B } });
  const c = client(w);
  const hB = await hashOf(B), hA = await hashOf(A);
  check(await until(() => (nsOf(c) ?? "").startsWith(hB) && c.status.state === "synced", 15_000), "account switch: the socket opened under B's session is refused (its hello names A), and the client goes on as B: " + J({ ns: (nsOf(c) ?? "").slice(0, 8), state: c.status.state }));
  const l1 = await ctl("log");
  const refusedHello = l1.got.some((g) => g.t === "error" && g.code === "forbidden");
  check(l1.switchedUpgrade === 1 && refusedHello && !l1.bindings.some((b) => b.hello === hA), "account switch: nothing of A's namespace sent on B's socket: " + J(l1.bindings));
  await unlost(w, nsA, "/a-only", "account switch");
  await stop(c);
  // (back to A; then B signs in during one of A's PUTs: refused by its binding)
  await signInOnly(A);
  const c2 = client(w);
  check(await until(async () => nsOf(c2) === nsA && (await settledIn(w, c2, nsA))), "account switch: A signed in again: A's namespace resumes and its records are decided");
  await ctl("set", { set: { switchOnPut: B } });
  const f = await w.create("/a-file.bin", { content: bytes(2000, 41) });
  check(await until(async () => (await ctl("log")).http.some((h) => h.switched)), "account switch: B signed in during A's PUT");
  check(await until(() => (nsOf(c2) ?? "").startsWith(hB), 15_000), "account switch: the PUT refused (A's binding, B's session), and the client goes on as B");
  const put = (await ctl("log")).http.find((h) => h.switched);
  check(put.status === 403 && put.bind === hA && put.session === hB, "account switch: …refused 403, before anything was stored: " + J({ status: put.status }));
  await stop(c2);
  // (explicitly back to A: A's file goes to A)
  await signInOnly(A);
  const c3 = client(w);
  check(await until(async () => nsOf(c3) === nsA && (await settledIn(w, c3, nsA)), 15_000), "account switch: back as A, every record of A's decided");
  const { mine: inA } = await serverOps(w);
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
  if ((await all(w.ws, "outbox")).some((r) => r.ns === ns)) return false;
  return (await metaGet(w.ws, `sync:${ns}:scanned`)) >= (await w.lastSeq()) && c.debug().inflight === 0;
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
  check(await until(async () => (await settledIn(w, c, nsOf(c))) && (await ctl("log")).http.some((h) => h.method === "PUT" && h.status === 201)), "late answer: B uploads and syncs as usual");
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
  W.PINS.cutAfterRead = () => { cuts++; W.PINS.cutAfterRead = null; throw new Error("cut (test)"); };
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
    const q = await all(b.ws, "meta");
    check(!q.some((v) => v && typeof v === "object" && "sha256" in v && "rev" in v && v.fid === e.fid), "download: its queue item gone");
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
    await new Promise((res, no) => { const tx = b.ws.transaction("meta", "readwrite"); tx.objectStore("meta").put(big, `sync:${ns}:fetch:${big.fid}`); tx.oncomplete = res; tx.onerror = () => no(tx.error); });
    const urls = cb.stats.urls;
    await ctl("notice", { head: (await serverOps(b)).all.at(-1).seq + 1 });
    check(await until(async () => (await metaGet(b.ws, `sync:${ns}:fetchFinal:${big.fid}`))?.why === "too large to sync"), "download checks: a size past 95 MiB set apart, too large to sync");
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
  const c2 = viewClient(w);
  try {
    check(await until(async () => (await ctl("log")).rebuilt.length === 2 && (await settled(w, c2)), 15_000), "rebuild crash: the next start sends rebuilt again, with the same through, and converges: " + J((await ctl("log")).rebuilt.map((r) => r.through)));
    const r = (await ctl("log")).rebuilt;
    check(r[0].through === r[1].through, "rebuild crash: …the same through");
  } finally {
    await ctl("release");
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
      // (the failed pass's done has run: the next pass is at its log)
      if (fired && phase === "log" && before && !after && (await metaGet(w.ws, `sync:${ns}:clean`))?.length !== undefined) after = await liveState(w, ns);
    };
    const c = viewClient(w);
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

const CASES = { basics, lostAckReconnect, lostAckReload, refusal, rateProlonged, reloadHonorsTimer, invalidRebuild, busyOrder, storm, twoTabs, generation, diverged, storageFull, tooLarge, reservation, pace, wakesBounded, byteMismatch, replayPaced, replayCapped, echoAcrossReload, accountSwitch, restoredCheckTimer, restoredPause, indexThrottled, corruptConcurrent, manyMismatches, lateAnswer, cutRead, restUnderAcks, refusalAtomic, echoNoCopy, liveNotice, noticeFlood, idleDiscovery, downloadBasic, downloadChecks, downloadStale, downloadBudget, rebuildAfterRefusal, rebuildRate, rebuildCrashAfterAnnounce, rebuildCounter, rebuildFailedPass };

export async function run(only = "") {
  for (const [name, f] of Object.entries(CASES)) {
    if (only && !only.split(",").includes(name)) continue;
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
