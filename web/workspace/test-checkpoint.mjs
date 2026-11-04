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
import { notebookCodec as codec } from "../notebook/history.js";
import { LIMITS } from "../sync-protocol/protocol.ts";
import {
  CHECKPOINT_BLOB_MAX, TAIL_ITEM_CAP, TAIL_PATCHES_CAP, REGISTER_ATTEMPTS, Ledger,
  acceptedBatch, exactCut, makeCheckpoint, checkRecord, checkCheckpoint, reconcile, splitPrefix, prefixCharge, itemBytesOf, utf8Length, sha256Hex,
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
}

// ---- an install's checks (r9 §8; map r2 A, B, C, G)
{
  const r = exactCut(codec, line, 2, B.time);
  const ck = await makeCheckpoint(codec, r.graph, B.time);
  const d = { epoch: 1, at_seq: 2, recv_at: 0, chain_at: "0".repeat(64), cut_patch: B.time, sha256: ck.sha256, bytes: ck.bytes };
  const tail = [line[2]];
  const ok = await checkCheckpoint(codec, d, ck.blob, tail);
  check(ok.ok && canon(ok.graph.value()) === canon(v3), "checkCheckpoint: the record + the tail: a usable base, the whole history's value");
  check(ok.ok && ok.ledger.peak <= 2 * ok.B && ok.ledger.total() <= ok.B, `checkCheckpoint: peak <= 2B and retained <= B (B ${ok.B}, peak ${ok.ledger?.peak}, retained ${ok.ledger?.total()})`);
  const no = async (dd, blob, t, why, what, local) => {
    const x = await checkCheckpoint(codec, dd, blob, t, local);
    check(!x.ok && x.why === why && x.ledger.total() <= x.B, `checkCheckpoint: ${what}: refused (${why}), retained <= B: ` + J({ why: x.why, held: x.ledger.total(), B: x.B }));
    return x;
  };
  const b1 = await no({ ...d, bytes: d.bytes + 1 }, ck.blob, tail, "bounds", "bytes not the descriptor's");
  check(b1.ledger.peak === 0, "checkCheckpoint: (a bounds refusal holds nothing: refused before anything is decoded)");
  const many = Array.from({ length: TAIL_PATCHES_CAP + 1 }, (_, i) => acceptedBatch(3 + i, [C], 1));
  const b2 = await no(d, ck.blob, many, "bounds", `${TAIL_PATCHES_CAP + 1} tail batches`);
  check(b2.ledger.peak === 0, "checkCheckpoint: (count + 1: refused before any graph)");
  const atCount = Array.from({ length: TAIL_PATCHES_CAP }, (_, i) => acceptedBatch(3 + i, [C], 1));
  const ac = await checkCheckpoint(codec, d, ck.blob, atCount);
  check(ac.ok || ac.why !== "bounds", `checkCheckpoint: exactly ${TAIL_PATCHES_CAP} tail batches: within the bound (not "bounds")`);
  const b3 = await no(d, ck.blob, [acceptedBatch(3, [C], TAIL_ITEM_CAP + 1)], "bounds", "the tail's charge one byte over TAIL_ITEM_CAP");
  check(b3.ledger.peak === 0, "checkCheckpoint: (bytes + 1: refused before any graph)");
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
  check(late.ledger.peak <= 2 * late.B, "checkCheckpoint: (the late pre-cut refusal: peak <= 2B)");
  const probe = new PatchGraph({ codec });
  probe.add([ck.record, C, L]);
  check(probe.needsMoreHistory() === true, "(the late pre-cut fixture: patchflow says needsMoreHistory)");
  // the actual combined graph (astra): the device's own rows are part of what is checked
  const O = mk("clientD", [A.time], v1, docOf(["mine", "x = 1"]));
  await no(d, ck.blob, tail, "needs_more_history", "the device's own pre-cut row in the combined graph", [O]);
  const N = mk("clientD", [C.time], v3, docOf(["x = 1", "y = 2", "z = 3", "mine"]));
  const withLocal = await checkCheckpoint(codec, d, ck.blob, tail, [N]);
  check(withLocal.ok && canon(withLocal.graph.value()) === canon(fullValue([A, B, C, N])), "checkCheckpoint: the device's own row after the tail: usable, the combined value");
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
        check(canon(inst.graph.value()) === canon(fullValue(all)), `seed ${seed}: installed from the checkpoint at ${at}, the value equals a full-history client's`);
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
