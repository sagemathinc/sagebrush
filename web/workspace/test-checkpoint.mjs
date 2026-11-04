// ci: web-sync.1 order=55 runner=bun
// web/workspace/checkpoint.ts, BH-0b-2a (BH-0 server design r9 §5.2, §6.2, §7; the implementation map r2, a5cccbe9):
// the exact cut, the checkpoint record and its exact hash, an install's checks with the bytes they hold, the outcome of
// a registration from the server's answer, and the split of a batch to the rooms the server names.  Through the real
// codec: patchflow 0.16 with the notebook codec (history.js notebookCodec, exact merges).  Seeded fixtures print their
// seed; one is run alone with `bun web/workspace/test-checkpoint.mjs <seed>`.
//   bun web/workspace/test-checkpoint.mjs [seed]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PatchGraph, encodePatchId } from "patchflow";
import { notebookCodec as codec, createImmerDbCodec, SCHEMA } from "../notebook/history.js";
import { LIMITS } from "../sync-protocol/protocol.ts";
import { SYNC_DEBT } from "../journal/rows.js";
import {
  CHECKPOINT_BLOB_MAX, TAIL_ITEM_CAP, TAIL_PATCHES_CAP, REGISTER_ATTEMPTS, LOCAL_ROWS_MAX, LOCAL_BYTES_MAX, Ledger,
  acceptedBatch, exactCut, makeCheckpoint, checkRecord, checkCheckpoint, reconcile, splitPrefix, prefixCharge, itemBytesOf, utf8Length, sha256Hex, scratchGraph, heldValues, RETAINED_MAX_B,
} from "./checkpoint.ts";

const here = new URL(".", import.meta.url).pathname;
let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const J = JSON.stringify;

// ---- fixtures: notebook documents, patches by hand, batches as a verified page would give them

let clock = Date.UTC(2026, 10, 4, 12, 0, 0);
const docOf = (cells) => codec.fromString(cells.map((c, i) => J({ type: "cell", id: c.id ?? `c${i}`, input: c.input ?? c })).join("\n"));
const canon = (d) => codec.toString(d).split("\n").sort().join("\n");
/** a patch by `client` from the value `from` (the parents' merged value) to `to`, after `parents` */
const mk = (client, parents, from, to) => ({ time: encodePatchId(++clock, client), parents, patch: codec.makePatch(from, to), userId: 0, wall: clock });
const charge = (patches) => 400 + utf8Length(J(patches));
const batch = (seq, patches) => acceptedBatch(seq, patches, charge(patches));
const fullValue = (patches, time) => { const g = new PatchGraph({ codec }); g.add(patches); return g.value(time ? { time } : {}); };
const hashOf = (v) => new PatchGraph({ codec }).hashOf(v);

// a line A → B → C (one writer), each its own batch, and two concurrent edits after B
const v0 = docOf([]), v1 = docOf(["x = 1"]), v2 = docOf(["x = 1", "y = 2"]), v3 = docOf(["x = 1", "y = 2", "z = 3"]);
const A = mk("clientA", [], v0, v1), B = mk("clientA", [A.time], v1, v2), C = mk("clientA", [B.time], v2, v3);
const line = [batch(1, [A]), batch(2, [B]), batch(3, [C])];

// ---- exactCut (r9 §5.2)
{
  const r = exactCut(codec, line, 3, C.time);
  check(r.ok && canon(r.graph.value({ time: C.time })) === canon(v3), "exactCut: a line, cut at its last batch's last envelope: ok, its value the whole history's");
  // astra's probe: A/B/C, cut at patch1 (A), at_seq 3: refused, A isn't batch 3's last envelope
  const p = exactCut(codec, line, 3, A.time);
  check(!p.ok && p.why === "last", "exactCut: astra's A/B/C probe, cut at A with at_seq 3: refused (last): " + J(p.ok ? "ok" : p.why));
  // the last envelope of ANOTHER seq (batch 2's) named with at_seq 3
  const q = exactCut(codec, line, 3, B.time);
  check(!q.ok && q.why === "last", "exactCut: batch 2's last envelope named with at_seq 3: refused (last)");
  // a missing batch of the prefix
  const m = exactCut(codec, [line[0], line[2]], 3, C.time);
  check(!m.ok && m.why === "missing", "exactCut: a batch of the prefix missing: refused (missing)");
  // (the grader's T3) a duplicated seq where one is missing (1, 2, 2, 4 at at_seq 4): the count is right, the order isn't
  const D0 = mk("clientA", [C.time], v3, docOf(["x = 1", "y = 2", "z = 3", "d"]));
  const dup = exactCut(codec, [line[0], line[1], batch(2, [C]), batch(4, [D0])], 4, D0.time);
  check(!dup.ok && dup.why === "missing", "exactCut: seqs 1, 2, 2, 4 at at_seq 4: refused (missing): " + J(dup.ok ? "ok" : dup.why));
  // a multi-patch batch whose cut is an early envelope: refused (last)
  const D = mk("clientA", [C.time], v3, docOf(["x = 1", "y = 2", "z = 3", "w"])), E = mk("clientA", [D.time], docOf(["x = 1", "y = 2", "z = 3", "w"]), docOf(["x = 1", "y = 2", "z = 3", "w", "v"]));
  const multi = [...line, batch(4, [D, E])];
  const e = exactCut(codec, multi, 4, D.time);
  check(!e.ok && e.why === "last", "exactCut: a multi-patch batch, its early envelope named: refused (last)");
  check(exactCut(codec, multi, 4, E.time).ok, "exactCut: …its last envelope: ok");
  // two heads, one of them the cut: divergent (no registration until patchflow's own merge)
  const vx = docOf(["x = 1", "y = 2", "X"]), vy = docOf(["Y", "x = 1", "y = 2"]);
  const X = mk("clientA", [B.time], v2, vx), Y = mk("clientB", [B.time], v2, vy);
  const div = [line[0], line[1], batch(3, [X, Y])];
  const dv = exactCut(codec, div, 3, Y.time);
  check(!dv.ok && dv.why === "divergent", "exactCut: two heads, one of them the cut (batch 3's last envelope): refused (divergent): " + J(dv.ok ? "ok" : dv.why));
  // …then the merge commit (patchflow's merged value, two parents) makes a cut
  const g = new PatchGraph({ codec });
  g.add([A, B, X, Y]);
  const merged = g.value();
  const M = mk("clientA", [X.time, Y.time], merged, merged);
  const mm = exactCut(codec, [...div, batch(4, [M])], 4, M.time);
  check(mm.ok && canon(mm.graph.value({ time: M.time })) === canon(fullValue([A, B, X, Y, M], M.time)), "exactCut: after the merge commit, a cut at it: ok, the full history's value at it");
  // the stale candidate racing another writer's batch: at_seq the earlier batch, the cut its last envelope: allowed
  // (its residual is the server's to bound, §6.1(a)), and its value excludes the later batch
  const s = exactCut(codec, [...line, batch(4, [D])], 3, C.time);
  check(s.ok && canon(s.graph.value({ time: C.time })) === canon(v3), "exactCut: a stale cut (batch 3) while batch 4 exists: ok, its value without batch 4");
  // from a previous checkpoint: its record + the span after it
  const r2 = exactCut(codec, line, 2, B.time);
  const ck = await makeCheckpoint(codec, r2.graph, B.time);
  const fromBase = exactCut(codec, [line[2], batch(4, [D])], 4, D.time, { at_seq: 2, record: ck.record });
  check(fromBase.ok && canon(fromBase.graph.value({ time: D.time })) === canon(fullValue([A, B, C, D], D.time)), "exactCut: from a previous checkpoint's record and its span: ok, the whole history's value");
  // …but a span holding a late pre-cut patch (its parent A, below that checkpoint), merged so the cut is the one head:
  // the value can't be exact from the record and the span: refused (incomplete), never a best-effort value
  const L0 = mk("clientC", [A.time], v1, docOf(["x = 1", "late"]));
  const gm = new PatchGraph({ codec });
  gm.add([A, B, C, L0]);
  const M2 = mk("clientA", [C.time, L0.time], gm.value(), gm.value());
  const inc = exactCut(codec, [line[2], batch(4, [L0, M2])], 4, M2.time, { at_seq: 2, record: ck.record });
  check(!inc.ok && inc.why === "incomplete", "exactCut: from a previous checkpoint, a late pre-cut patch merged in its span: refused (incomplete): " + J(inc.ok ? "ok" : inc.why));
  check(exactCut(codec, [...line, batch(4, [L0, M2])], 4, M2.time).ok, "exactCut: …the same from the start of the history: ok (exact)");
}

// ---- the record and its exact hash (map r2 C)
{
  const r = exactCut(codec, line, 3, C.time);
  const ck = await makeCheckpoint(codec, r.graph, C.time);
  check(ck.record.time === C.time && J(ck.record.parents) === J(C.parents) && ck.record.isSnapshot === true && ck.record.patch === undefined, "makeCheckpoint: the record is at cut_patch, its parents kept, a snapshot, no patch");
  check(canon(codec.fromString(ck.record.snapshot)) === canon(v3), "makeCheckpoint: its snapshot is the value at the cut");
  check(ck.bytes === ck.blob.length && ck.sha256 === (await sha256Hex(ck.blob)) && J(JSON.parse(new TextDecoder().decode(ck.blob))) === J(ck.record), "makeCheckpoint: the blob is the record's JSON, its sha256 and bytes");
  check(checkRecord(codec, ck.record), "checkRecord: the record made: accepted");
  const { hash: _h, ...hashless } = ck.record;
  check(!checkRecord(codec, hashless), "checkRecord: no hash: refused (patchflow 0.16 would use it)");
  check(!checkRecord(codec, { ...ck.record, hash: "zz:" + ck.record.hash.slice(3) }), "checkRecord: another hash format: refused");
  const other = new PatchGraph({ codec }).hashOf(v2);
  check(other !== ck.record.hash && !checkRecord(codec, { ...ck.record, hash: other }), "checkRecord: the right format, another value's hash: refused");
  check(!checkRecord(codec, { ...ck.record, snapshot: "{not json" }), "checkRecord: text that doesn't decode: refused");
  check(!checkRecord(codec, { ...ck.record, isSnapshot: false }), "checkRecord: not a snapshot: refused");
  // the recompute before upload: a graph whose hash isn't its value's makes no checkpoint (a record whose stored hash
  // isn't its value's is never uploaded)
  const liar = Object.create(r.graph);
  liar.hashOf = () => other;
  let threw = false;
  try { await makeCheckpoint(codec, liar, C.time); } catch { threw = true; }
  check(threw, "makeCheckpoint: a record whose hash isn't its value's isn't made (checked again before it is returned)");
  // (the grader's T2) the blob's maximum, exactly: a record of exactly CHECKPOINT_BLOB_MAX bytes is made, one byte more
  // isn't (the record's bytes = a fixed part + the cell's input, measured here)
  const one = (n) => { const g = new PatchGraph({ codec }), tt = encodePatchId(++clock, "clientM"); g.add([{ time: tt, parents: [], patch: codec.makePatch(codec.fromString(""), codec.fromString(J({ type: "cell", id: "c0", input: "x".repeat(n) }))), userId: 0, wall: clock }]); return { g, tt }; };
  const s0 = one(10), fixed = (await makeCheckpoint(codec, s0.g, s0.tt)).bytes - 10;
  const at = one(CHECKPOINT_BLOB_MAX - fixed), over = one(CHECKPOINT_BLOB_MAX - fixed + 1);
  const made = await makeCheckpoint(codec, at.g, at.tt).catch((e) => ({ bytes: String(e) }));
  check(made.bytes === CHECKPOINT_BLOB_MAX, `makeCheckpoint: a record of exactly ${CHECKPOINT_BLOB_MAX} bytes: made: ${made.bytes}`);
  let overThrew = false;
  try { await makeCheckpoint(codec, over.g, over.tt); } catch (e) { overThrew = /maximum/.test(String(e)); }
  check(overThrew, "makeCheckpoint: one byte over the blob's maximum: not made");
}

// ---- an install's checks (r9 §8; map r2 A, B, C, G)
{
  const r = exactCut(codec, line, 2, B.time);
  const ck = await makeCheckpoint(codec, r.graph, B.time);
  const d = { epoch: 1, at_seq: 2, recv_at: 0, chain_at: "0".repeat(64), cut_patch: B.time, sha256: ck.sha256, bytes: ck.bytes };
  const tail = [line[2]];
  const ok = await checkCheckpoint(codec, d, ck.blob, tail);
  check(ok.ok && ok.head === hashOf(v3), "checkCheckpoint: the record + the tail: a usable base, the whole history's value (its hash)");
  check(ok.ok && ok.ledger.total() === ck.blob.length, `checkCheckpoint: on return the decoded record is the caller's and counted (its blob's ${ck.blob.length} bytes), nothing else held: ${ok.ledger?.total()}`);
  const no = async (dd, blob, t, why, what, local) => {
    const x = await checkCheckpoint(codec, dd, blob, t, local);
    check(!x.ok && x.why === why && x.ledger.total() === 0, `checkCheckpoint: ${what}: refused (${why}), nothing held after: ` + J({ why: x.why, held: x.ledger.total(), B: x.B }));
    return x;
  };
  const b1 = await no({ ...d, bytes: d.bytes + 1 }, ck.blob, tail, "bounds", "bytes not the descriptor's");
  check(b1.ledger.maxHeld === 0, "checkCheckpoint: (a bounds refusal holds nothing: refused before anything is decoded)");
  const many = Array.from({ length: TAIL_PATCHES_CAP + 1 }, (_, i) => acceptedBatch(3 + i, [C], 1));
  const b2 = await no(d, ck.blob, many, "bounds", `${TAIL_PATCHES_CAP + 1} tail batches`);
  check(b2.ledger.maxHeld === 0, "checkCheckpoint: (count + 1: refused before any graph)");
  const atCount = Array.from({ length: TAIL_PATCHES_CAP }, (_, i) => acceptedBatch(3 + i, [C], 1));
  const ac = await checkCheckpoint(codec, d, ck.blob, atCount);
  check(ac.ok || ac.why !== "bounds", `checkCheckpoint: exactly ${TAIL_PATCHES_CAP} tail batches: within the bound (not "bounds")`);
  const b3 = await no(d, ck.blob, [acceptedBatch(3, [C], TAIL_ITEM_CAP + 1)], "bounds", "the tail's charge one byte over TAIL_ITEM_CAP");
  check(b3.ledger.maxHeld === 0, "checkCheckpoint: (bytes + 1: refused before any graph)");
  const atBytes = await checkCheckpoint(codec, d, ck.blob, [acceptedBatch(3, [C], TAIL_ITEM_CAP)]);
  check(atBytes.ok, "checkCheckpoint: the tail's charge exactly TAIL_ITEM_CAP: within the bound");
  await no({ ...d, sha256: "0".repeat(64) }, ck.blob, tail, "digest", "another sha256");
  await no({ ...d, cut_patch: A.time }, ck.blob, tail, "cut", "the record not at the descriptor's cut");
  await no(d, ck.blob, [batch(4, [C])], "tail", "a tail not from at_seq + 1");
  const hashless = new TextEncoder().encode(J({ ...ck.record, hash: undefined }));
  await no({ ...d, sha256: await sha256Hex(hashless), bytes: hashless.length }, hashless, tail, "record", "a hash-less record (its own digest right)");
  const wrong = new TextEncoder().encode(J({ ...ck.record, hash: new PatchGraph({ codec }).hashOf(v1) }));
  await no({ ...d, sha256: await sha256Hex(wrong), bytes: wrong.length }, wrong, tail, "record", "a record whose hash is another value's");
  // the late pre-cut patch (r9 §5.2): made before the cut by an offline device (its parent A, below the cut), accepted
  // after it: needsMoreHistory, so the checkpoint is unusable for this open (valueUnavailable alone doesn't say so)
  const L = mk("clientC", [A.time], v1, docOf(["x = 1", "late"]));
  const lateTail = [line[2], batch(4, [L])];
  const late = await no(d, ck.blob, lateTail, "needs_more_history", "a late pre-cut patch in the tail");
  const probe = new PatchGraph({ codec });
  probe.add([ck.record, C, L]);
  check(probe.needsMoreHistory() === true, "(the late pre-cut fixture: patchflow says needsMoreHistory)");
  // the actual combined graph (astra): the device's own rows are part of what is checked
  const O = mk("clientD", [A.time], v1, docOf(["mine", "x = 1"]));
  await no(d, ck.blob, tail, "needs_more_history", "the device's own pre-cut row in the combined graph", [O]);
  // (astra's CK-M1) the tail's bound counts PATCHES (the server's unit), not batches: 1000 patches in one batch are
  // within it, 1001 aren't (a batch may hold 2000), refused before any graph; the same split across two batches
  const chainOf = (n, from, client) => { const out = []; let prev = from; for (let i = 0; i < n; i++) { const p = { time: encodePatchId(++clock, client), parents: [prev], patch: codec.makePatch(v3, v3), userId: 0, wall: clock }; out.push(p); prev = p.time; } return out; };
  const k1000 = chainOf(1000, C.time, "clientK"), k1001 = chainOf(1001, C.time, "clientL");
  const one1000 = await checkCheckpoint(codec, d, ck.blob, [acceptedBatch(3, [C, ...k1000.slice(1)], 1)]);
  check(one1000.ok || one1000.why !== "bounds", "checkCheckpoint: 1000 patches in ONE tail batch: within the bound: " + J(one1000.ok ? "ok" : one1000.why));
  const one1001 = await checkCheckpoint(codec, d, ck.blob, [acceptedBatch(3, [C, ...k1001.slice(1)], 1)]);
  check(!one1001.ok && one1001.why === "bounds" && one1001.ledger.maxHeld === 0, "checkCheckpoint: 1001 patches in ONE tail batch: refused (bounds) before any graph");
  const two1001 = await checkCheckpoint(codec, d, ck.blob, [acceptedBatch(3, [C, ...k1001.slice(1, 500)], 1), acceptedBatch(4, k1001.slice(500), 1)]);
  check(!two1001.ok && two1001.why === "bounds" && two1001.ledger.maxHeld === 0, "checkCheckpoint: 500 + 501 patches across two batches: refused (bounds) before any graph");
  const two1000 = await checkCheckpoint(codec, d, ck.blob, [acceptedBatch(3, [C, ...k1000.slice(1, 500)], 1), acceptedBatch(4, k1000.slice(500), 1)]);
  check(two1000.ok || two1000.why !== "bounds", "checkCheckpoint: 500 + 500 across two batches: within the bound");
  // (astra's CK-M3; the grader's T7) a record whose causal fields aren't a list of distinct patch ids is refused as
  // a record, never an exception, and nothing is held after; so is a tail the graph throws on
  const nine = Array.from({ length: 9 }, (_, i) => encodePatchId(clock - 100 - i, "clientN"));
  for (const [what, change] of [["parents 42", { parents: 42 }], ["parents {}", { parents: {} }], ["a non-string parent", { parents: [1] }], ["a parent that isn't a patch id", { parents: ["x"] }],
    ["a repeated parent", { parents: [A.time, A.time] }], ["9 parents", { parents: nine }], ["itself as a parent", { parents: [ck.record.time] }], ["a nested-array parent", { parents: [[A.time]] }],
    ["a change (patch)", { patch: [] }], ["a mergePatch", { mergePatch: [] }], ["a mergeParent", { mergeParent: A.time }], ["a time that isn't a patch id", { time: "x" }]]) {
    const bad = new TextEncoder().encode(J({ ...ck.record, ...change }));
    const dd = { ...d, sha256: await sha256Hex(bad), bytes: bad.length };
    let r, threw = null;
    try { r = await checkCheckpoint(codec, dd, bad, tail); } catch (e) { threw = String(e); }
    check(!threw && r && !r.ok && r.why === "record" && r.ledger.total() === 0, `checkCheckpoint: a record with ${what} (its hash right): refused (record), nothing held: ` + J(threw ?? { why: r.why, held: r.ledger.total() }));
  }
  const odd = acceptedBatch(3, [{ ...C, parents: 42 }], 1);
  let oddR, oddThrew = null;
  try { oddR = await checkCheckpoint(codec, d, ck.blob, [odd]); } catch (e) { oddThrew = String(e); }
  check(!oddThrew && oddR && !oddR.ok && oddR.why === "tail" && oddR.ledger.total() === 0, "checkCheckpoint: a tail patch the graph throws on: refused (tail), nothing held: " + J(oddThrew ?? { why: oddR.why, held: oddR.ledger.total() }));
  // (astra's CK-M2; the grader's T8) the bytes held are counted as taken, the device's own rows included: B = the blob
  // + the tail's charge + the local rows' JSON bytes; a 1 MiB local edit makes B over 1 MiB, the graph's copy is
  // exactly those bytes
  const N0 = mk("clientD", [C.time], v3, docOf(["x = 1", "y = 2", "z = 3", "n0"]));
  const big = mk("clientD", [C.time], v3, docOf(["x = 1", "y = 2", "z = 3", "w".repeat(1 << 20)]));
  const bigBytes = Buffer.byteLength(J(big));
  const withBig = await checkCheckpoint(codec, d, ck.blob, tail, [big]);
  const held = ck.blob.length + tail[0].charge + bigBytes;
  check(withBig.ok && withBig.B === held && withBig.ledger.total() === ck.blob.length, "checkCheckpoint: a 1 MiB local edit: B is the record + the tail + its " + bigBytes + " bytes; on return only the record is held: " + J({ B: withBig.B, held: withBig.ledger.total(), want: held }));
  class Work extends Ledger { constructor() { super(); this.work = 0; } set(n, b) { if (n === "work") this.work = Math.max(this.work, b); super.set(n, b); } }
  const wl = new Work();
  await checkCheckpoint(codec, d, ck.blob, tail, [big], wl);
  check(wl.work === held && wl.maxHeld >= 2 * held, "checkCheckpoint: …its working copy grew by every row it added, the local edit's included, to exactly B (" + held + "): " + J({ work: wl.work, maxHeld: wl.maxHeld }));
  // (the grader's T13) the local rows are charged in UTF-8 bytes, not UTF-16 units: a non-ASCII edit
  const wide = mk("clientD", [C.time], v3, docOf(["x = 1", "y = 2", "z = 3", "é€𝄞".repeat(50000)]));
  const wideBytes = Buffer.byteLength(J(wide));
  check(wideBytes !== J(wide).length, "(the non-ASCII fixture: its UTF-8 bytes aren't its UTF-16 length)");
  const withWide = await checkCheckpoint(codec, d, ck.blob, tail, [wide]);
  check(withWide.ok && withWide.B === ck.blob.length + tail[0].charge + wideBytes, "checkCheckpoint: a non-ASCII local edit is charged its UTF-8 bytes: " + J({ B: withWide.B, want: ck.blob.length + tail[0].charge + wideBytes }));
  // (the grader's T10) exactly the local bounds are within them
  const atRows = await checkCheckpoint(codec, d, ck.blob, tail, Array.from({ length: LOCAL_ROWS_MAX }, () => C));
  check(atRows.ok || atRows.why !== "bounds", `checkCheckpoint: exactly ${LOCAL_ROWS_MAX} local rows: within the bound: ` + J(atRows.ok ? "ok" : atRows.why));
  const padded = (pad) => ({ ...N0, pad });
  const base0 = Buffer.byteLength(J(padded("")));
  const atLocalBytes = padded("p".repeat(LOCAL_BYTES_MAX - base0));
  check(Buffer.byteLength(J(atLocalBytes)) === LOCAL_BYTES_MAX, "(a local row of exactly LOCAL_BYTES_MAX bytes)");
  const ab = await checkCheckpoint(codec, d, ck.blob, tail, [atLocalBytes]);
  check(ab.ok || ab.why !== "bounds", "checkCheckpoint: local rows of exactly LOCAL_BYTES_MAX bytes: within the bound: " + J(ab.ok ? "ok" : ab.why));
  const ob = await checkCheckpoint(codec, d, ck.blob, tail, [padded("p".repeat(LOCAL_BYTES_MAX - base0 + 1))]);
  check(!ob.ok && ob.why === "bounds" && ob.ledger.maxHeld === 0, "checkCheckpoint: one byte more: refused (bounds) before any graph");
  // (the grader's T12, astra's narrow item) a local row that can't be measured (a BigInt): refused (local), never a
  // rejection, nothing held; and a throw inside the decision (a codec whose merge3 throws): refused, nothing held
  let bigintR, bigintThrew = null;
  try { bigintR = await checkCheckpoint(codec, d, ck.blob, tail, [{ ...N0, meta: { big: 1n } }]); } catch (e) { bigintThrew = String(e); }
  check(!bigintThrew && bigintR && !bigintR.ok && bigintR.why === "local" && bigintR.ledger.total() === 0, "checkCheckpoint: a local row with a BigInt: refused (local), nothing held: " + J(bigintThrew ?? { why: bigintR.why, held: bigintR.ledger.total() }));
  const throwing = { ...codec, merge3: () => { throw new Error("merge3 fails"); } };
  const X1 = mk("clientA", [C.time], v3, docOf(["x = 1", "y = 2", "z = 3", "p"])), Y1 = mk("clientB", [C.time], v3, docOf(["q", "x = 1", "y = 2", "z = 3"]));
  let thr, thrThrew = null;
  try { thr = await checkCheckpoint(throwing, d, ck.blob, [line[2], acceptedBatch(4, [X1, Y1], 1)]); } catch (e) { thrThrew = String(e); }
  check(!thrThrew && thr && !thr.ok && thr.ledger.total() === 0, "checkCheckpoint: a codec that throws during the decision: refused, nothing held: " + J(thrThrew ?? { why: thr.why, held: thr.ledger.total() }));
  check(LOCAL_ROWS_MAX === SYNC_DEBT.docCount && LOCAL_BYTES_MAX === SYNC_DEBT.docBytes, "the local bounds are the journal's per-document debt bounds (SYNC_DEBT)");
  const manyLocal = Array.from({ length: LOCAL_ROWS_MAX + 1 }, () => C);
  const lr = await checkCheckpoint(codec, d, ck.blob, tail, manyLocal);
  check(!lr.ok && lr.why === "bounds" && lr.ledger.maxHeld === 0, `checkCheckpoint: ${LOCAL_ROWS_MAX + 1} local rows: refused (bounds) before any graph`);
  const hugeLocal = mk("clientD", [C.time], v3, docOf(["x = 1", "y = 2", "z = 3", "w".repeat(LOCAL_BYTES_MAX)]));
  const lb = await checkCheckpoint(codec, d, ck.blob, tail, [hugeLocal]);
  check(!lb.ok && lb.why === "bounds" && lb.ledger.maxHeld === 0, "checkCheckpoint: local rows over LOCAL_BYTES_MAX: refused (bounds) before any graph");
  const N = mk("clientD", [C.time], v3, docOf(["x = 1", "y = 2", "z = 3", "mine"]));
  const withLocal = await checkCheckpoint(codec, d, ck.blob, tail, [N]);
  check(withLocal.ok && withLocal.head === hashOf(fullValue([A, B, C, N])), "checkCheckpoint: the device's own row after the tail: usable, the combined value");
}

// ---- what a decision's graph holds between calls (map r2 G as amended for 0b-2a, astra's DESIGN OK 56082e29): measured
// after each public call, capped at RETAINED_MAX_B x B.  Not what a call allocates while it runs (TRANSIENT-BUDGET).
{
  const doc1 = (s) => codec.fromString(J({ type: "cell", id: "c", input: s }));
  const cells = (xs) => codec.fromString(xs.map((s, i) => J({ type: "cell", id: "c" + i, input: s })).join("\n"));
  // records the largest value-holding measured at a call's end
  class Measured extends Ledger { constructor() { super(); this.values = 0; } set(n, b) { if (n === "values") this.values = Math.max(this.values, b); super.set(n, b); } }
  const install = async (rootV, kids, chargeOf = (ps) => charge(ps), local = []) => {
    const root = { time: encodePatchId(++clock, "clientZ"), parents: [], patch: codec.makePatch(codec.fromString(""), rootV), userId: 0 };
    const ck = await makeCheckpoint(codec, exactCut(codec, [acceptedBatch(1, [root], 1)], 1, root.time).graph, root.time);
    const d = { epoch: 1, at_seq: 1, recv_at: 0, chain_at: "0".repeat(64), cut_patch: root.time, sha256: ck.sha256, bytes: ck.bytes };
    const ps = kids(root);
    const l = new Measured();
    const r = await checkCheckpoint(codec, d, ck.blob, [acceptedBatch(2, ps, chargeOf(ps))], local, l);
    return { r, l, ck, ps, root };
  };
  // (astra's chain: a 100,000-character value and 50 one-character edits)
  let text = "A".repeat(100000);
  const chain = (root) => { const out = []; let parent = root.time, val = doc1(text), t2 = text; for (let i = 0; i < 50; i++) { t2 += "X"; const next = doc1(t2); const p = { time: encodePatchId(++clock, "clientZ"), parents: [parent], patch: codec.makePatch(val, next) }; out.push(p); parent = p.time; val = next; } return out; };
  const c = await install(doc1(text), chain);
  check(c.r.ok && c.l.values <= RETAINED_MAX_B * c.r.B && c.l.values > 0, `checkCheckpoint (the grader's Z7: its own graph): astra's chain, 50 edits on 100,000 characters: accepted, the values it held between calls ${c.l.values} B <= ${RETAINED_MAX_B}B (B ${c.r.B})`);
  // (the same graph built as checkCheckpoint's would have been with patchflow's default caches: what it would have held)
  const plain = new PatchGraph({ codec });
  plain.add([c.r.record, ...c.ps]);
  plain.needsMoreHistory(); plain.valueUnavailable(); plain.value();
  check(heldValues(codec, plain).count >= 50 && heldValues(codec, plain).bytes > RETAINED_MAX_B * c.r.B, "(with patchflow's default caches the same work holds " + heldValues(codec, plain).count + " values, past the cap: so the cap above sees checkCheckpoint's own graph)");
  // exactCut's own graph (the grader's Z8): after its decision, one value held, not one per edit
  const prefix = [acceptedBatch(1, [c.root], 1), acceptedBatch(2, c.ps, 1)];
  const ec = exactCut(codec, prefix, 2, c.ps.at(-1).time);
  check(ec.ok && heldValues(codec, ec.graph).count <= 1, "exactCut (the grader's Z8: its own graph): after its decision over the chain, values held: " + (ec.ok ? heldValues(codec, ec.graph).count : ec.why));
  // the grader's Z6c: the valueCache is one of the stores; patchflow fills it on its apply-all path (a codec without
  // merge3: the notebook codec's own base, history.js createImmerDbCodec(SCHEMA)), one value per version; the scratch
  // graphs keep none, patchflow's defaults keep them
  const applyAll = createImmerDbCodec(SCHEMA);
  const sv = scratchGraph(applyAll), dv = new PatchGraph({ codec: applyAll });
  for (const g of [sv, dv]) { g.add([c.root, ...c.ps]); for (const p of c.ps.slice(0, 10)) g.version(p.time); g.value(); }
  check(sv.valueCache.size === 0 && dv.valueCache.size >= 10, `scratchGraph: patchflow's valueCache after 10 versions: ${sv.valueCache.size} (its defaults: ${dv.valueCache.size})`);
  // (astra's eight concurrent heads, children of the cut: their merge holds many values between calls) refused, nothing held
  const heads = (root) => Array.from({ length: 8 }, (_, i) => ({ time: encodePatchId(++clock, "clientH" + i), parents: [root.time], patch: codec.makePatch(doc1(text), doc1(text + "h" + i)) }));
  const h8 = await install(doc1(text), heads);
  check(!h8.r.ok && h8.r.why === "bounds" && h8.r.ledger.total() === 0 && h8.l.values > RETAINED_MAX_B * h8.r.B, `checkCheckpoint: astra's eight concurrent heads (quiescent holding ${h8.l.values} B > ${RETAINED_MAX_B}B, B ${h8.r.B}): refused (bounds), nothing held`);
  // a merge of two heads whose holding is between B and 2B: accepted
  const two = (root) => [0, 1].map((i) => ({ time: encodePatchId(++clock, "clientT" + i), parents: [root.time], patch: codec.makePatch(cells(["s".repeat(10)]), cells(["s".repeat(10), (i ? "b" : "a").repeat(30000)])) }));
  const m2 = await install(cells(["s".repeat(10)]), two);
  check(m2.r.ok && m2.l.values > m2.r.B && m2.l.values <= RETAINED_MAX_B * m2.r.B && m2.r.ledger.total() === m2.ck.blob.length, `checkCheckpoint: a two-head merge holding between B and 2B (${m2.l.values} B, B ${m2.r.B}): accepted, the record counted on return`);
  // the cap exactly: a chain whose holding is one value, the tail's declared charge chosen so 2B equals it; and one less
  const exact = async (minus) => {
    for (let n = 1000; n < 1004; n++) {
      const kid = (root) => [{ time: encodePatchId(++clock, "clientE"), parents: [root.time], patch: codec.makePatch(doc1("e"), doc1("e" + "x".repeat(n))) }];
      const probe = await install(doc1("e"), kid, () => 1 << 20);
      if (!probe.r.ok || probe.l.values % 2) continue;
      const chargeAt = probe.l.values / 2 - probe.ck.blob.length;
      return install(doc1("e"), kid, () => chargeAt - minus);
    }
    return null;
  };
  const atCap = await exact(0), underCap = await exact(1);
  check(atCap && atCap.r.ok && atCap.l.values === RETAINED_MAX_B * atCap.r.B, "checkCheckpoint: values held exactly RETAINED_MAX_B x B: accepted: " + J(atCap && { ok: atCap.r.ok, values: atCap.l.values, B: atCap.r.B }));
  check(underCap && !underCap.r.ok && underCap.r.why === "bounds" && underCap.r.ledger.total() === 0, "checkCheckpoint: B one byte smaller (the same values now past the cap): refused (bounds), nothing held");
  // the grader's Z11: the values are charged in UTF-8 bytes
  const wide = cells(["é€𝄞".repeat(20000)]);
  const g = scratchGraph(codec);
  const wroot = { time: encodePatchId(++clock, "clientW"), parents: [], patch: codec.makePatch(codec.fromString(""), wide), userId: 0 };
  g.add([wroot]); g.value();
  const hv = heldValues(codec, g);
  check(hv.count === 1 && hv.bytes === Buffer.byteLength(codec.toString(wide)) && hv.bytes !== codec.toString(wide).length, `heldValues: a non-ASCII value is charged its UTF-8 bytes (${hv.bytes}), not its UTF-16 length`);
  // the reader fails closed: a graph without one of patchflow 0.16's stores, or a store holding something not a document
  let missing = null, odd = null;
  try { heldValues(codec, { ...g, recentMerged: undefined, recentExact: g.recentExact, exactCache: g.exactCache, exactMergeCache: g.exactMergeCache, mergeCache: g.mergeCache, valueCache: g.valueCache, legacyCheckpoints: g.legacyCheckpoints }); } catch (e) { missing = String(e); }
  try { heldValues(codec, Object.assign(Object.create(Object.getPrototypeOf(g)), g, { recentExact: new Map([["x", 42]]) })); } catch (e) { odd = String(e); }
  check(missing && /recentMerged/.test(missing) && odd && /isn't a document/.test(odd), "heldValues: a missing store, or a value that isn't a document: refused (it throws): " + J({ missing, odd }));
  // every store is read: a graph shaped as patchflow 0.16's, one Doc in exactly one store (as each holds it: the Doc,
  // {doc}, or {key, doc, last}), is counted, store by store
  const one = cells(["store"]), oneBytes = Buffer.byteLength(codec.toString(one));
  const empty = () => ({ recentExact: new Map(), recentMerged: new Map(), exactCache: new Map(), exactMergeCache: new Map(), mergeCache: new Map(), valueCache: new Map(), legacyCheckpoints: new Map(), pinnedExact: undefined, pinnedMerged: undefined, recentCheckpoint: undefined });
  for (const [store, value] of [["recentExact", one], ["recentMerged", one], ["exactCache", { doc: one }], ["exactMergeCache", { doc: one }], ["mergeCache", one], ["valueCache", { doc: one, count: 1 }], ["legacyCheckpoints", { doc: one, last: 1 }], ["pinnedExact", one], ["pinnedMerged", one], ["recentCheckpoint", { key: "k", doc: one, last: 1 }]]) {
    const fake = empty();
    fake[store] = store === "recentCheckpoint" ? value : new Map([["k", value]]);
    const r = heldValues(codec, fake);
    check(r.count === 1 && r.bytes === oneBytes, `heldValues: a Doc held in ${store} is counted: ${J(r)}`);
  }
}

// ---- reconcile (r9 §6.2): the full identity only
{
  const id = { epoch: 2, at_seq: 1500, sha256: "a".repeat(64), bytes: 4096 };
  const kept = (k) => ({ t: "error", code: "conflict", detail: { kept: [k] } });
  check(reconcile(id, { t: "ack" }) === "registered", "reconcile: an ack (its exact-retry answer included): registered");
  check(reconcile(id, kept({ at_seq: 1500, sha256: "a".repeat(64), bytes: 4096 })) === "registered", "reconcile: conflict, kept holds the full identity: registered");
  check(reconcile(id, kept({ at_seq: 1501, sha256: "a".repeat(64), bytes: 4096 })) === "not_registered", "reconcile: at_seq alone differs: not registered");
  check(reconcile(id, kept({ at_seq: 1500, sha256: "b".repeat(64), bytes: 4096 })) === "not_registered", "reconcile: sha256 alone differs: not registered");
  check(reconcile(id, kept({ at_seq: 1500, sha256: "a".repeat(64), bytes: 4097 })) === "not_registered", "reconcile: bytes alone differs: not registered");
  check(reconcile(id, kept({ epoch: 3, at_seq: 1500, sha256: "a".repeat(64), bytes: 4096 })) === "not_registered", "reconcile: epoch alone differs (where kept names it): not registered");
  check(reconcile(id, { t: "error", code: "conflict", detail: { latest_at_seq: 1600, kept: [] } }) === "not_registered", "reconcile: a newer cut won, ours not kept: not registered");
  check(reconcile(id, { t: "error", code: "epoch", detail: { epoch: 3 } }) === "void", "reconcile: an epoch clear raced: void");
  check(reconcile(id, null) === "unknown" && reconcile(id, { t: "error", code: "busy" }) === "unknown", "reconcile: no answer, or busy: unknown");
  check(reconcile(id, { t: "error", code: "invalid", detail: { why: "cut" } }) === "not_registered", "reconcile: a final refusal: not registered");
  check(REGISTER_ATTEMPTS === 3, "the identical attempts at most: 3 (r9 §6.2)");
}

// ---- splitPrefix (r9 §7): the charge, the rooms, required and stop
{
  const who = { author: "person", writer: "session:" + "d".repeat(32), device: "d".repeat(32) };
  const rows = Array.from({ length: 50 }, (_, i) => ({ cseq: i + 1, id: encodePatchId(clock + i, "clientS"), parents: i ? [encodePatchId(clock + i - 1, "clientS")] : [], size: 1000 + i }));
  // the charge is the real item's UTF-8 JSON length (the widest seq, recv and chain)
  for (const k of [1, 2, 17, 50]) {
    const envs = rows.slice(0, k).map((r) => ({ cseq: r.cseq, id: r.id, parents: r.parents, size: r.size }));
    const body = Buffer.alloc(rows.slice(0, k).reduce((n, r) => n + r.size, 0), 7).toString("base64");
    const item = { seq: Number.MAX_SAFE_INTEGER, author: who.author, writer: who.writer, device: who.device, recv: Number.MAX_SAFE_INTEGER, chain: "f".repeat(64), patches: envs, body };
    check(prefixCharge(rows, k, who) === Buffer.byteLength(J(item)), `prefixCharge(${k}): exactly the item's JSON bytes`);
  }
  const at = prefixCharge(rows, 20, who);
  const s1 = splitPrefix(rows, 1000, at, who);
  check(s1.kind === "fit" && s1.n === 20, "splitPrefix: room_bytes exactly 20 rows' charge: 20 fit: " + J(s1));
  const s2 = splitPrefix(rows, 1000, at - 1, who);
  check(s2.kind === "fit" && s2.n === 19, "splitPrefix: one byte less: 19: " + J(s2));
  const s3 = splitPrefix(rows, 20, 1 << 30, who);
  check(s3.kind === "fit" && s3.n === 20, "splitPrefix: room_patches 20 the binding one: 20");
  const s4 = splitPrefix(rows, 19, 1 << 30, who);
  check(s4.kind === "fit" && s4.n === 19, "splitPrefix: room_patches 19: 19");
  check(splitPrefix(rows, 0, 1 << 30, who).kind === "required" && splitPrefix(rows, 1000, prefixCharge(rows, 1, who) - 1, who).kind === "required", "splitPrefix: no patch fits a room: required");
  const huge = [{ cseq: 1, id: rows[0].id, parents: [], size: TAIL_ITEM_CAP }];
  check(splitPrefix(huge, 1000, 10, who).kind === "stop", "splitPrefix: one patch that can't fit an empty tail: stop (never retried forever)");
  // (the grader's T1) a patch whose charge is exactly TAIL_ITEM_CAP fits an empty tail: required (a checkpoint makes
  // room); one byte more never fits: stop.  The patch is found exactly: its client's length moves the charge by a byte
  const exactly = (target) => {
    for (let L = 1; L <= 64; L++) {
      const id = encodePatchId(clock, "c".repeat(L)), base = prefixCharge([{ cseq: 1, id, parents: [], size: 0 }], 1, who);
      const est = Math.floor(((target - base) / 4) * 3);
      for (let s = est - 30; s <= est + 30; s++) if (prefixCharge([{ cseq: 1, id, parents: [], size: s }], 1, who) === target) return [{ cseq: 1, id, parents: [], size: s }];
    }
    return null;
  };
  const atCap = exactly(TAIL_ITEM_CAP), overCap = exactly(TAIL_ITEM_CAP + 1);
  check(atCap && prefixCharge(atCap, 1, who) === TAIL_ITEM_CAP && splitPrefix(atCap, 1000, 10, who).kind === "required", "splitPrefix: one patch charging exactly TAIL_ITEM_CAP, no room now: required");
  check(overCap && prefixCharge(overCap, 1, who) === TAIL_ITEM_CAP + 1 && splitPrefix(overCap, 1000, 10, who).kind === "stop", "splitPrefix: one byte over TAIL_ITEM_CAP: stop");
  const big = Array.from({ length: 2000 }, (_, i) => ({ cseq: i + 1, id: encodePatchId(clock + i, "clientT"), parents: [], size: 500 }));
  const t0 = performance.now(), sb = splitPrefix(big, 1000, TAIL_ITEM_CAP, who), ms = performance.now() - t0;
  check(sb.kind === "fit" && sb.n === 1000 && ms < 200, `splitPrefix: 2,000 rows (the batch's maximum) in one pass: ${ms.toFixed(1)} ms`);
}

// ---- the constants and the shared charge vectors
{
  check(TAIL_ITEM_CAP === LIMITS.pullBytes - 8192 && TAIL_ITEM_CAP === 4_186_112, "TAIL_ITEM_CAP: LIMITS.pullBytes less 8 KiB (r9 §3)");
  check(CHECKPOINT_BLOB_MAX === 32 << 20 && TAIL_PATCHES_CAP === 1000, "CHECKPOINT_BLOB_MAX 32 MiB, TAIL_PATCHES_CAP 1000 (r9 §0, §6.4)");
  const V = JSON.parse(readFileSync(here + "../sync-protocol/doc-vectors.json", "utf8")).checkpoint?.charges ?? [];
  check(V.length >= 6, `the charge vectors (doc-vectors.json checkpoint.charges): ${V.length}`);
  for (const v of V) check(itemBytesOf(v.fields, v.envs_bytes, v.body_length) === v.charge, "the charge vector: " + v.when);
}

// ---- seeded random multi-writer fixtures: the checkpoint's value is the full history's
{
  const FIRST = Number(process.argv[2] ?? 20261104), SEEDS = process.argv[2] ? 1 : 50;
  const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let cuts = 0, installs = 0;
  for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
    const r = rng(seed), all = [], batches = [];
    const heads = new Map();
    const value = (parents) => { if (!parents.length) return docOf([]); const g = new PatchGraph({ codec }); g.add(all); return g.value({ time: parents.length === 1 ? parents[0] : undefined }); };
    const writers = ["clientP", "clientQ", "clientR"].slice(0, 2 + Math.floor(r() * 2));
    let seq = 0;
    for (let step = 0; step < 12; step++) {
      const page = [];
      for (const w of writers) {
        if (r() < 0.4) continue;
        // a writer edits from the graph's current single head when there is one, else merges all heads
        const g = new PatchGraph({ codec });
        g.add([...all, ...page]);
        const hs = all.length + page.length ? g.getHeads() : [];
        const base = hs.length ? g.value() : docOf([]);
        const cells = codec.toString(base).split("\n").filter(Boolean).map((l) => JSON.parse(l));
        const next = docOf([...cells.map((c) => c.input), `${w}:${seed}:${step}`]);
        const p = mk(w, hs, base, next);
        page.push(p);
        heads.set(w, p.time);
      }
      if (!page.length) continue;
      all.push(...page);
      batches.push(batch(++seq, page));
    }
    // a cut at the newest batch whose last envelope is the prefix's one head
    for (let at = batches.length; at >= 1; at--) {
      const cut = batches[at - 1].patches.at(-1).time;
      const ec = exactCut(codec, batches, at, cut);
      if (!ec.ok) continue;
      cuts++;
      const ck = await makeCheckpoint(codec, ec.graph, cut);
      const prefix = batches.slice(0, at).flatMap((b) => b.patches);
      check(canon(codec.fromString(ck.record.snapshot)) === canon(fullValue(prefix, cut)), `seed ${seed}: the checkpoint's value is the full prefix's (at_seq ${at})`);
      const d = { epoch: 1, at_seq: at, recv_at: 0, chain_at: "0".repeat(64), cut_patch: cut, sha256: ck.sha256, bytes: ck.bytes };
      const inst = await checkCheckpoint(codec, d, ck.blob, batches.slice(at));
      if (inst.ok) {
        installs++;
        check(inst.head === hashOf(fullValue(all)), `seed ${seed}: installed from the checkpoint at ${at}, the value equals a full-history client's`);
      } else check(inst.why === "needs_more_history", `seed ${seed}: an install refused only for needsMoreHistory: ${inst.why}`);
      break;
    }
  }
  console.log(`seeded fixtures: seeds ${FIRST}..${FIRST + SEEDS - 1}, ${cuts} cuts, ${installs} installs`);
  check(cuts >= SEEDS * 0.6, `seeded fixtures: most seeds have an exact cut (${cuts} of ${SEEDS})`);
}

// ---- the type-level pins (checkpoint-types.ts): an accepted batch only from acceptedBatch
{
  const tsc = join(here, "../../node_modules/.bin/tsc");
  const flags = ["--ignoreConfig", "--noEmit", "--skipLibCheck", "--target", "es2023", "--module", "esnext", "--moduleResolution", "bundler", "--allowImportingTsExtensions", "--types", "node"];
  const run = (file) => { try { execFileSync(tsc, [...flags, file], { encoding: "utf8", stdio: "pipe" }); return { code: 0, out: "" }; } catch (e) { return { code: e.status, out: String(e.stdout) }; } };
  const pinned = run(join(here, "checkpoint-types.ts"));
  check(pinned.code === 0, "checkpoint-types.ts: each @ts-expect-error holds (a local row, a look-alike, an install's tail): " + pinned.out.slice(0, 300));
  // (the control: without the directives, the same three lines are errors)
  // (in this checkout, so `patchflow` resolves as for the real file; removed after)
  const dir = mkdtempSync(join(here, ".ck-types-"));
  const bare = readFileSync(join(here, "checkpoint-types.ts"), "utf8").replace(/^\/\/ @ts-expect-error.*\n/gm, "").replace(/"\.\/checkpoint\.ts"/, J(join(here, "checkpoint.ts")));
  writeFileSync(join(dir, "bare.ts"), bare);
  const control = run(join(dir, "bare.ts"));
  rmSync(dir, { recursive: true, force: true });
  check(control.code !== 0 && (control.out.match(/error TS/g) ?? []).length === 3, "the control: without the directives, exactly those three lines fail: " + control.out.slice(0, 300));
}

console.log(fails.length ? `FAIL\n${fails.join("\n")}` : "ok");
console.log(`${checks - fails.length}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
