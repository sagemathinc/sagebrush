// D10 (design/sync-client.md): the shared reducer run over a stored index, a page at a time, on copy-on-write
// overlays over a partial base that loads its misses: every vector, at every page size, gives exactly what the
// in-memory reducer gives; a discarded overlay leaves the base untouched; a partial map can't be iterated.
//   bun web/workspace/test-sync-overlay.mjs
import { readFileSync } from "node:fs";
import { reduce, reduceAll, SyncIndex } from "./sync-reduce.ts";
import { Overlay, PartialIndex, runPage, runOp, rowsOf, OVERLAY, Halt } from "./sync-overlay.ts";
import { createHash } from "node:crypto";
import { parentOf } from "./paths.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const here = new URL(".", import.meta.url).pathname;
const keyOf = (p) => p.normalize("NFC");
const copy = (e) => ({ ...e, ...(e.trashed ? { trashed: { ...e.trashed } } : {}) });
const state = (ix) => JSON.stringify([ix.entries(), [...ix.byKey].sort(), [...ix.children].map(([k, v]) => [k, [...v].sort()]).sort(), [...ix.gone].sort()]);

/** The stored index, as a whole SyncIndex the store answers from (the "database" of these tests). */
function memStore(S, stats) {
  return {
    async byId(id) { stats.reads++; const e = S.byId.get(id); return e ? copy(e) : undefined; },
    async gone(id) { stats.reads++; return S.gone.get(id); },
    async folder(k) { stats.reads++; return [...(S.children.get(k) ?? [])].map((id) => copy(S.byId.get(id))); },
  };
}
function removeEntry(S, id) {
  const e = S.byId.get(id);
  if (!e) return;
  S.byId.delete(id);
  const k = keyOf(e.path), pk = keyOf(parentOf(e.path));
  if (S.byKey.get(k) === id) S.byKey.delete(k);
  const s = S.children.get(pk);
  if (s) { s.delete(id); if (!s.size) S.children.delete(pk); }
}
/** A page's rows written to the store, as sync-confirmed.ts writes them to IndexedDB. */
function flush(S, base, changed) {
  const { put, gone, drop } = rowsOf(base, changed);
  for (const e of put) removeEntry(S, e.id);
  for (const [id] of gone) removeEntry(S, id);
  for (const id of drop) { removeEntry(S, id); S.gone.delete(id); }
  for (const e of put) {
    S.byId.set(e.id, copy(e));
    S.byKey.set(keyOf(e.path), e.id);
    const pk = keyOf(parentOf(e.path));
    let s = S.children.get(pk);
    if (!s) S.children.set(pk, (s = new Set()));
    s.add(e.id);
    S.gone.delete(e.id);
  }
  for (const [id, p] of gone) S.gone.set(id, p);
}
async function paged(ops, size) {
  const S = new SyncIndex(), stats = { reads: 0 }, store = memStore(S, stats), skipped = [];
  let i = 0, carry = 0, pages = 0;
  while (i < ops.length) {
    const r = await runPage(store, ops.slice(i, i + size), carry);
    flush(S, r.base, r.changed);
    r.outcomes.forEach((o, j) => { if (o.skipped !== undefined) skipped.push(ops[i + j].seq); });
    i += r.taken;
    carry = r.carry;
    pages++;
  }
  return { S, skipped, pages, stats };
}

const { vectors } = JSON.parse(readFileSync(here + "sync-vectors.json", "utf8"));
for (const v of vectors) {
  const want = reduceAll(v.ops);
  for (const size of [1, 3, v.ops.length]) {
    const { S, skipped } = await paged(v.ops, size);
    check(state(S) === state(want), `${v.name}, pages of ${size}: the stored index equals the in-memory reducer's`);
    check(JSON.stringify(skipped) === JSON.stringify(v.skipped), `${v.name}, pages of ${size}: skipped ${JSON.stringify(skipped)}, not ${JSON.stringify(v.skipped)}`);
  }
}

// every vector's log run as one long log (identities and paths shared across vectors), pages of 7
{
  let seq = 0;
  const all = vectors.flatMap((v) => v.ops.map((o) => ({ ...o, seq: ++seq })));
  const want = reduceAll(all);
  const { S } = await paged(all, 7);
  check(state(S) === state(want), `all vectors as one log (${all.length} ops), pages of 7`);
}

// a partial map can't answer a whole-map question
{
  const ov = new Overlay(new PartialIndex());
  let threw = 0;
  for (const f of [() => ov.index.byId.size, () => [...ov.index.byKey], () => ov.index.children.forEach(() => {}), () => ov.index.gone.keys(), () => ov.index.entries()]) {
    try { f(); } catch { threw++; }
  }
  check(threw === 5, `iteration and size on the overlay's maps throw: ${threw} of 5`);
}

// astra's probe: a mkdir whose gone check misses after it has already changed the overlay: the overlay discarded,
// the base untouched, and the op run again succeeds (no "already there")
{
  const S = new SyncIndex(), stats = { reads: 0 };
  const op = { seq: 1, device: "aaaaaaaaaaaaaaaa", dseq: 1, t: 1, by: "person", op: "mkdir", path: "/d", kind: "folder", fid: "f000000000000009" };
  const base = new PartialIndex();
  // (the folder "/" and the id known, gone not: the put happens, then gone.get misses)
  base.putFolder(keyOf("/"), []);
  base.byId.set("f000000000000009", Symbol.for("x") && undefined);
  base.byId.delete("f000000000000009");
  const ov = new Overlay(base);
  reduce(ov.index, op);
  check(ov.dirty && base.byId.size === 0, "a miss after a change: the overlay dirty, the base unchanged");
  const r = await runPage(memStore(S, stats), [op]);
  check(r.outcomes[0].skipped === undefined && r.changed.has("f000000000000009"), "…run again, it completes: " + JSON.stringify(r.outcomes[0]));
}

// ---- D10 r2/r3: the meter, the rounds and the ceilings

const DEV = "aaaaaaaaaaaaaaaa";
const derive = (...parts) => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
/** The reducer's derived-identity series for a folder made by op (`device`, `dseq`), its `made`-th: candidate n. */
const candidate = (dseq, made, n) => (n === 0 ? derive("folder", DEV, dseq, made) : derive("folder", DEV, dseq, made, "again", n));
const fileOp = (seq, path, fid, more = {}) => ({ seq, device: DEV, dseq: seq, t: seq, by: "person", op: "create", path, kind: "file", fid, sha256: "a".repeat(64), size: 1, ...more });
const hex16 = (lead, i) => lead + i.toString(16).padStart(15, "0");

// a derived-identity series that collides k times: its folder made at candidate k, in k + 1 rounds or fewer, its
// probes counted (each round reruns the op: sum over i of i candidates)
for (const k of [20, 999]) {
  const S = new SyncIndex(), stats = { reads: 0 };
  for (let n = 0; n < k; n++) S.gone.set(candidate(1, 1, n), "/was" + n);
  const op = { seq: 1, device: DEV, dseq: 1, t: 1, by: "person", op: "create", path: "/made/x.txt", kind: "file", fid: "f".repeat(16), sha256: "a".repeat(64), size: 1 };
  const want = reduceAll([op], (() => { const ix = new SyncIndex(); for (const [id, p] of S.gone) ix.gone.set(id, p); return ix; })());
  const base = new PartialIndex();
  let r, halted = null;
  try { r = await runOp(base, memStore(S, stats), op, { alone: true }); } catch (e) { halted = e; }
  const made = r && [...base.byId.values()].find((e) => e && e.path === "/made");
  check(!halted && made?.id === candidate(1, 1, k) && made.id === want.at("/made")?.id, `a series colliding ${k} times completes at candidate ${k}: ` + JSON.stringify({ halted: String(halted ?? ""), made: made?.id }));
  check(r && r.rounds <= k + 3, `…in about ${k} + 1 rounds (one stored row per candidate): ${r?.rounds}`);
  const probes = (k * (k + 1)) / 2;
  if (k === 999) check(r && r.units >= probes && r.units <= OVERLAY.opUnits, `the 1,000-candidate series counts its replayed probes (${probes} at least) within the per-op ceiling: ${r?.units}`);
}

// the same series on a 100,000-entry move passes the per-op ceiling: it halts, person-told, and nothing is written
{
  const S = new SyncIndex(), stats = { reads: 0 };
  const big = hex16("b", 0);
  reduce(S, { seq: 1, device: DEV, dseq: 1, t: 1, by: "person", op: "mkdir", path: "/big", kind: "folder", fid: big });
  let seq = 1;
  for (let d = 0; d < 10; d++) {
    const fid = hex16("c", d);
    reduce(S, { seq: ++seq, device: DEV, dseq: seq, t: seq, by: "person", op: "mkdir", path: `/big/d${d}`, kind: "folder", fid, parent: big });
    for (let i = 0; i < 9_999; i++) reduce(S, fileOp(++seq, `/big/d${d}/f${i}`, hex16("e", d * 10_000 + i), { parent: fid }));
  }
  const mv = { seq: ++seq, device: DEV, dseq: seq, t: seq, by: "person", op: "rename", path: "/big", to: "/new/big", kind: "folder", fid: big };
  for (let n = 0; n < 999; n++) S.gone.set(candidate(mv.dseq, 1, n), "/was" + n);
  // (D10 r3 expected each round to replay the move and so pass the ceiling; this reducer makes the missing folder
  // before it moves anything, so a round that misses a candidate costs little: the op either completes within the
  // ceiling, equal to the in-memory reducer, or halts with nothing written.  Both are bounded; which one is reported)
  const want = reduceAll([mv], S.clone());
  const before = state(S);
  let halted = null, r = null;
  const base = new PartialIndex();
  try { r = await runOp(base, memStore(S, stats), mv, { alone: true }); } catch (e) { halted = e; }
  if (halted) check(halted instanceof Halt && state(S) === before, "a 100,000-entry move with the 1,000-collision series: halted, person-told, nothing written: " + String(halted).slice(0, 120));
  else {
    const page = await runPage(memStore(S, stats), [mv]);
    flush(S, page.base, page.changed);
    check(state(S) === state(want) && r.units <= OVERLAY.opUnits, `a 100,000-entry move with the 1,000-collision series: completed within the per-op ceiling (${r.units} units, ${r.rounds} rounds), equal to the in-memory reducer`);
  }
}

// 1,000 ops into one 10,000-name folder: the pages cut by the meter, none over its budget (plus one trial's units),
// each op probing up to 10,000 names; an over-budget trial starts the next page with its units carried
{
  const S = new SyncIndex(), stats = { reads: 0 };
  let seq = 0;
  reduce(S, { seq: ++seq, device: DEV, dseq: seq, t: seq, by: "person", op: "mkdir", path: "/full", kind: "folder", fid: hex16("d", 0) });
  for (let i = 1; i <= 9_998; i++) reduce(S, fileOp(++seq, i === 1 ? "/full/a.txt" : `/full/a (${i}).txt`, hex16("1", i), { parent: hex16("d", 0) }));
  const ops = [];
  for (let i = 0; i < 1000; i++) ops.push(fileOp(++seq, "/full/a.txt", hex16("2", i), { parent: hex16("d", 0) }));
  const want = reduceAll(ops, (() => { const c = S.clone(); return c; })());
  const store = memStore(S, stats);
  let i = 0, carry = 0, pages = 0, maxUnits = 0, carried = 0;
  while (i < ops.length) {
    const r = await runPage(store, ops.slice(i, i + 1000), carry);
    flush(S, r.base, r.changed);
    maxUnits = Math.max(maxUnits, r.units);
    if (r.carry) carried++;
    i += r.taken;
    carry = r.carry;
    pages++;
  }
  check(state(S) === state(want), "1,000 ops into a 10,000-name folder: the result equals the in-memory reducer's");
  check(pages >= 10 && maxUnits <= OVERLAY.pageUnits * 1.1, `…cut by the meter into ${pages} pages, the largest ${maxUnits} units`);
  check(carried >= 1, `…an over-budget trial carried to the next page (${carried} times)`);
}

console.log(`${checks - fails.length}/${checks} passed`);
for (const f of fails.slice(0, 20)) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
