// The cases of web/workspace/test-workspace-sync-outbox.mjs (sync client step 2b-1, design/sync-client.md C1):
// the outbox made by one scan from a durable watermark, in one transaction a page; its bounds; decisions; the
// fenced lease of a namespace; the one sender; dropOps held at the watermark.
import * as W from "./ws.js";

const results = [];
const check = (ok, what) => results.push([!!ok, what]);
let n = 0;
const names = () => { n++; return { name: `ws-out-${n}-${Math.random().toString(36).slice(2, 8)}`, mainName: `main-out-${n}` }; };
const fresh = async () => { localStorage.clear(); return W.Workspace.open(names()); };
const J = (x) => JSON.stringify(x);
const NS_A = "a".repeat(32) + ":1:" + "0123456789abcdef", NS_B = "b".repeat(32) + ":1:" + "0123456789abcdef", NS_A2 = "a".repeat(32) + ":2:" + "0123456789abcdef";
const all = (db, store) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const fails = async (p) => { try { await p; return null; } catch (e) { return e; } };
// (the ops a scan sends: those with what they left, not dropVersions, not the server's)
const sendable = (ops) => ops.filter((o) => "after" in o && o.after !== undefined && o.op !== "dropVersions" && o.origin !== "server");

async function scanning() {
  const w = await fresh();
  const lease = await W.switchTo(w, NS_A), ob = new W.Outbox(w, lease);
  await ob.begin(await w.lastSeq());
  const f = await w.create("/d/x.txt", { content: "abc" });
  await w.write("/d/x.txt", "abcd");
  await w.rename("/d/x.txt", "/d/y.txt");
  const t = await w.remove("/d/y.txt");
  await w.restore(t.path);
  await w.dropVersions("/d/y.txt");
  const t2 = await w.remove("/d/y.txt");
  await w.emptyTrash([t2.path]);
  const nb = await w.create("/n.ipynb");
  await w.forget("/n.ipynb");
  const ops = (await w.ops()).filter((o) => o.seq > 0);
  const r = await ob.scan();
  const recs = await ob.records();
  const st = await ob.status();
  const want = sendable(ops);
  const sameOps = recs.length === want.length && recs.every((x, i) => {
    const o = want[i];
    return x.dseq === i + 1 && x.lseq === o.seq && x.id === (o.after?.id ?? o.fid ?? o.ref) && x.op.dseq === i + 1 && x.op.op === (o.op === "emptyTrash" || o.op === "discard" ? "forget" : o.op) && x.op.path === o.path && x.op.kind === o.kind && x.op.fid === o.fid && x.op.ref === o.ref && x.op.sha256 === o.sha256 && x.op.base === o.base && x.op.parent === o.parent;
  });
  check(r.made === want.length && !r.full && sameOps, "a scan: one record per op sent, in order, dseq 1, 2, …, each op as the server takes it: " + J(recs.map((x) => [x.dseq, x.op.op, x.op.path])));
  check(recs.some((x) => x.op.op === "forget" && x.op.fid === f.fid) && !recs.some((x) => x.op.op === "dropVersions" || x.op.op === "emptyTrash") && recs.some((x) => x.op.op === "forget" && x.op.ref === nb.ref), "…emptying Trash goes as forget; dropVersions isn't sent");
  const bytes = recs.reduce((s, x) => s + 2 * JSON.stringify(x).length, 0);
  check(st.scanned === ops.at(-1).seq && st.nextDseq === recs.length + 1 && st.count === recs.length && st.bytes === bytes && !st.full, "…the watermark past every op looked at, the next dseq, the totals (each record its JSON as written, two bytes a character): " + J(st));
  // (an op applied from the server: never sent back)
  await new Promise((ok, no) => { const tx = w.ws.transaction("ops", "readwrite"); tx.objectStore("ops").add({ t: 1, device: "f".repeat(16), by: "person", op: "create", path: "/s.txt", kind: "file", fid: "5".repeat(16), after: { id: "5".repeat(16), parent: null, name: "s.txt", kind: "file", trashed: false }, origin: "server" }); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  const r2 = await ob.scan();
  check(r2.made === 0 && (await ob.status()).scanned === (await w.lastSeq()), "an op applied from the server: passed over, never sent, the watermark past it");
  w.close();
}

async function cuts() {
  // (a page cut at each point it awaits, as a tab closed or killed there: all of it or none)
  const w = await fresh();
  const ob = new W.Outbox(w, await W.switchTo(w, NS_A));
  await ob.begin(await w.lastSeq());
  for (let i = 0; i < 3; i++) await w.create(`/c${i}.txt`, { content: "x" + i });
  const before = J({ st: await ob.status(), recs: await ob.records() });
  let points = 0, intact = true;
  for (let at = 0; ; at++) {
    W.OUTBOX.cut = (p) => { if (p === at) throw new Error("cut at " + p); };
    const e = await fails(ob.scanPage());
    W.OUTBOX.cut = null;
    if (!e) break;
    points++;
    intact &&= J({ st: await ob.status(), recs: await ob.records() }) === before;
  }
  const after = await ob.records();
  check(points === 6 && intact, "a scan page cut at each of its 6 points (each await, and at its end before commit): nothing of it kept, the watermark, the next dseq and the outbox as they were: " + J({ points }));
  check(after.length === 3 && after.map((x) => x.dseq).join() === "1,2,3", "…then a page made whole: each op once, dseq 1, 2, 3");
  w.close();
}

async function pages() {
  // (a page: at most OUTBOX.page ops looked at, all of them made into records or passed over)
  const w = await fresh();
  const ob = new W.Outbox(w, await W.switchTo(w, NS_A));
  await ob.begin(await w.lastSeq());
  const was = W.OUTBOX.page;
  try {
    W.OUTBOX.page = 3;
    for (let i = 0; i < 7; i++) await w.create(`/p${i}.txt`, { content: "p" });
    const sizes = [];
    for (let i = 0; i < 10; i++) { const r = await ob.scanPage(); sizes.push(r.made); if (!r.more) break; }
    check(sizes.every((m) => m <= 3) && sizes.reduce((a, b) => a + b, 0) === 7 && (await ob.records()).length === 7, "a scan page looks at most OUTBOX.page ops, and the pages together send each op once: " + J(sizes));
  } finally {
    W.OUTBOX.page = was;
  }
  w.close();
}

async function fillDrain() {
  // the outbox full, more edits, a reload, and drained: every op sent exactly once
  const nm = names();
  localStorage.clear();
  let w = await W.Workspace.open(nm);
  const lease = await W.switchTo(w, NS_A);
  let ob = new W.Outbox(w, lease);
  await ob.begin(await w.lastSeq());
  const was = { ...W.OUTBOX };
  const seen = new Map();
  try {
    W.OUTBOX.maxRecords = 6;
    for (let i = 0; i < 10; i++) await w.create(`/f${i}.txt`, { content: "f" + i });
    let r = await ob.scan();
    const fullFirst = r.full && (await ob.status()).full;
    for (let i = 0; i < 5; i++) await w.write(`/f${i}.txt`, "g" + i);
    w.close();
    w = await W.Workspace.open(nm);
    ob = new W.Outbox(w, lease);
    for (let round = 0; round < 20; round++) {
      r = await ob.scan();
      const recs = await ob.records();
      for (const x of recs) { if (!seen.has(x.dseq)) seen.set(x.dseq, x.lseq); }
      if (!recs.length) break;
      await ob.acked(recs.map((x) => ({ dseq: x.dseq, seq: 1000 + x.dseq })));
      await ob.confirmed(recs.map((x) => x.dseq));
    }
    const want = sendable((await w.ops()).filter((o) => o.seq > 0)).map((o) => o.seq);
    const got = [...seen.entries()].sort((a, b) => a[0] - b[0]);
    const contiguous = got.every(([d], i) => d === i + 1);
    const once = J(got.map(([, l]) => l)) === J(want);
    const st = await ob.status();
    check(fullFirst && contiguous && once && st.count === 0 && st.bytes === 0 && !st.full, "the outbox full, more edits, a reload, then drained: every op sent exactly once, in order, dseqs with no gap, the outbox empty and no longer full: " + J({ sent: got.length, want: want.length }));
    // (by bytes: full before a record would pass maxBytes, the bytes held never more)
    W.OUTBOX.maxRecords = 10_000;
    const one = (await ob.status()).nextDseq;
    for (let i = 0; i < 6; i++) await w.create(`/b${i}.txt`, { content: "b" });
    await ob.scan();
    const each = (await ob.records())[0] ? 2 * JSON.stringify((await ob.records())[0]).length : 0;
    await ob.confirmed((await ob.records()).map((x) => x.dseq));
    for (let i = 0; i < 6; i++) await w.write(`/b${i}.txt`, "bb");
    W.OUTBOX.maxBytes = each * 3 + 10;
    const rb = await ob.scan();
    const sb = await ob.status();
    check(one > 0 && rb.full && sb.count >= 1 && sb.count < 6 && sb.bytes <= W.OUTBOX.maxBytes && sb.full && sb.bytes === (await ob.records()).reduce((t, x) => t + 2 * JSON.stringify(x).length, 0), "the outbox full by bytes: the records' bytes never past maxBytes, and status says it is full: " + J({ count: sb.count, bytes: sb.bytes, max: W.OUTBOX.maxBytes }));
  } finally {
    Object.assign(W.OUTBOX, was);
  }
  w.close();
}

async function decisions() {
  const nm = names();
  localStorage.clear();
  let w = await W.Workspace.open(nm);
  const lease = await W.switchTo(w, NS_A);
  let ob = new W.Outbox(w, lease);
  await ob.begin(await w.lastSeq());
  for (let i = 0; i < 5; i++) await w.create(`/d${i}.txt`, { content: "d" });
  await ob.scan();
  const before = await ob.records();
  await ob.acked([{ dseq: 1, seq: 41 }, { dseq: 2, code: "missing" }]);
  let recs = await ob.records(), st = await ob.status();
  check(recs.find((x) => x.dseq === 1)?.accepted === 41 && !recs.some((x) => x.dseq === 2) && st.count === 4 && st.bytes === recs.reduce((s, x) => s + 2 * JSON.stringify(x).length, 0), "an ack: accepted kept (awaiting its echo), refused removed at once, the totals kept: " + J(recs.map((x) => [x.dseq, x.accepted ?? null])));
  await ob.confirmed([1]);
  await ob.confirmed([3]);
  await ob.acked([{ dseq: 3, seq: 43 }]);
  recs = await ob.records();
  check(!recs.some((x) => x.dseq === 1) && !recs.some((x) => x.dseq === 3), "confirmed (its echo): removed, whether its ack came first or after");
  // (a lost ack, then a reload: the same records, the same ops, resent unchanged)
  const pending = J(recs);
  w.close();
  w = await W.Workspace.open(nm);
  ob = new W.Outbox(w, lease);
  const again = await ob.records();
  check(J(again) === pending && J(again.map((x) => x.op)) === J(before.filter((x) => [4, 5].includes(x.dseq)).map((x) => x.op)), "a lost ack, then a reload: the undecided records the same, their ops unchanged, to be resent as they were");
  w.close();
}

async function acceptBound() {
  // (an outbox filled near maxBytes, every record then accepted with the largest seq there is: what it holds
  // never past the bound, the totals what it holds (daybreak2's LIMIT-855-1)); and seqs out of range refused
  const w = await fresh();
  const ob = new W.Outbox(w, await W.switchTo(w, NS_A));
  await ob.begin(await w.lastSeq());
  const was = { ...W.OUTBOX };
  try {
    for (let i = 0; i < 12; i++) await w.create(`/m${i}.txt`, { content: "m" });
    W.OUTBOX.maxBytes = 4000;
    const r = await ob.scan();
    const before = await ob.records();
    await ob.acked(before.map((x) => ({ dseq: x.dseq, seq: Number.MAX_SAFE_INTEGER })));
    const recs = await ob.records(), st = await ob.status();
    const held = recs.reduce((t, x) => t + 2 * JSON.stringify(x).length, 0);
    check(r.full && recs.length === before.length && recs.every((x) => x.accepted === Number.MAX_SAFE_INTEGER) && held === st.bytes && st.bytes <= W.OUTBOX.maxBytes && st.charged <= W.OUTBOX.maxBytes && st.bytes <= st.charged, "filled near the bound, every record accepted with the largest seq: what is held never past it, the totals what is held: " + J({ n: recs.length, bytes: st.bytes, charged: st.charged, max: W.OUTBOX.maxBytes }));
    // (a reload: the totals still exactly what the records hold and may come to hold; then every record confirmed:
    // all of it back to nothing)
    const nm = { name: w.ws.name, mainName: w.main?.name };
    const v = await W.Workspace.open(nm);
    const ov = new W.Outbox(v, ob.lease), rv = await ov.records(1, 10000), sv = await ov.status();
    const exact = sv.bytes === rv.reduce((t, x) => t + W.recordBytes(x), 0) && sv.charged === rv.reduce((t, x) => t + W.chargeOf(x), 0) && sv.count === rv.length;
    await ov.confirmed(rv.slice(0, 3).map((x) => x.dseq));
    const sp = await ov.status(), rp = await ov.records(1, 10000);
    const partial = sp.bytes === rp.reduce((t, x) => t + W.recordBytes(x), 0) && sp.charged === rp.reduce((t, x) => t + W.chargeOf(x), 0) && sp.count === rp.length;
    v.close();
    check(exact && partial, "…after a reload, and after some are confirmed, the totals exactly what the records hold and are charged: " + J({ bytes: sv.bytes, charged: sv.charged, count: sv.count, afterConfirm: sp }));
    const snapshot = J({ st: await ob.status(), recs: await ob.records() });
    const bad = [];
    for (const d of [{ dseq: 1, seq: Number.MAX_SAFE_INTEGER + 1 }, { dseq: 1, seq: -1 }, { dseq: 1, seq: 1.5 }, { dseq: 1, seq: "3" }, { dseq: 0, seq: 1 }, { dseq: 1, code: "x".repeat(65) }]) bad.push(!!(await fails(ob.acked([d]))));
    check(bad.every(Boolean) && J({ st: await ob.status(), recs: await ob.records() }) === snapshot, "a seq or dseq out of range (past sixteen digits, negative, fractional, a string), or a code too long: refused, nothing changed: " + J(bad));
  } finally {
    Object.assign(W.OUTBOX, was);
  }
  w.close();
}

async function fencing() {
  const w = await fresh();
  const la = await W.switchTo(w, NS_A), a = new W.Outbox(w, la);
  await a.begin(await w.lastSeq());
  for (let i = 0; i < 3; i++) await w.create(`/e${i}.txt`, { content: "e" });
  await a.scan();
  const inFlight = await a.records();
  // (another account, or another generation after "Delete my synced data": a new namespace, mid-flight)
  const lb = await W.switchTo(w, NS_A2), b = new W.Outbox(w, lb);
  const r1 = await fails(a.records()), r2 = await fails(a.acked([{ dseq: 1, seq: 9 }])), r3 = await fails(a.confirmed([2])), r4 = await fails(a.scanPage()), r5 = await fails(a.begin(0));
  const stA = await a.status();
  check([r1, r2, r3, r4, r5].every((e) => e instanceof W.Fenced) && stA.count === 3 && inFlight.length === 3, "the namespace switched while a send was in flight: the old lease reads nothing more to send, and its ack, its echo and its scan change nothing (Fenced): " + J({ count: stA.count }));
  await b.begin(await w.lastSeq());
  await w.create("/after.txt", { content: "z" });
  await b.scan();
  const bRecs = await b.records();
  check(bRecs.length === 1 && bRecs[0].op.path === "/after.txt" && bRecs[0].dseq === 1 && bRecs.every((x) => x.ns === NS_A2), "the new namespace: its own records, from its own dseq 1; none of the old one's in it");
  // (back to the first: its state kept, resumed)
  const la2 = await W.switchTo(w, NS_A), a2 = new W.Outbox(w, la2);
  const back = await a2.records();
  check(J(back) === J(inFlight) && la2.gen > lb.gen && (await fails(b.records())) instanceof W.Fenced, "back to the first namespace: its outbox as it was, resumed under a new generation; the other's lease fenced in turn");
  // (a new connection for the same namespace (a reconnect): a new generation too, so the old connection's lease,
  // its ack still in flight, changes nothing)
  const la3 = await W.switchTo(w, NS_A), a3 = new W.Outbox(w, la3);
  const late = await fails(a2.acked([{ dseq: 1, seq: 7 }]));
  check(la3.gen > la2.gen && late instanceof W.Fenced && !(await a3.records()).some((x) => x.accepted === 7), "a reconnect to the same namespace: a new generation, the previous connection's late ack fenced");
  let bad = null;
  try { new W.Outbox(w, { ns: "../x", gen: 1 }); } catch (e) { bad = e; }
  check(bad && !(await fails(W.switchTo(w, NS_B))), "a namespace not of welcome's form is refused");
  w.close();
}

async function senders() {
  // (two tabs of one device: one sender; the lock handed over when it ends)
  let release;
  const first = W.sender(NS_A, async (held) => { await new Promise((r) => (release = r)); return held; });
  await new Promise((r) => setTimeout(r, 50));
  const second = await W.sender(NS_A, async (held) => held, { ifAvailable: true });
  const other = await W.sender(NS_B, async (held) => held, { ifAvailable: true });
  release();
  const firstHeld = await first;
  const later = await W.sender(NS_A, async (held) => held, { ifAvailable: true });
  check(firstHeld && second === false && other === true && later === true, "one sender per namespace: a second tab doesn't get it while the first holds it, another namespace's is its own, and it passes on when the first ends: " + J({ firstHeld, second, other, later }));
}

async function dropping() {
  const w = await fresh();
  const ob = new W.Outbox(w, await W.switchTo(w, NS_A));
  for (let i = 0; i < 3; i++) await w.create(`/k${i}.txt`, { content: "k" });
  const mark = await w.lastSeq();
  await ob.begin(mark);
  for (let i = 0; i < 3; i++) await w.create(`/l${i}.txt`, { content: "l" });
  const last = await w.lastSeq();
  await w.dropOps(last);
  const left = (await w.ops()).map((o) => o.seq);
  check(left.length === last - mark && left[0] === mark + 1, "dropOps never past the scan watermark: the ops not yet scanned kept: " + J({ mark, last, left }));
  await ob.scan();
  await w.dropOps(last);
  check((await w.ops()).length === 0, "…once scanned, they may go");
  w.close();
}

export async function run() {
  for (const f of [scanning, cuts, pages, fillDrain, decisions, acceptBound, fencing, senders, dropping]) {
    try { await f(); } catch (e) { check(false, `${f.name} threw: ${e?.stack ?? e}`); }
  }
  return results;
}
