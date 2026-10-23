// D10 (design/sync-client.md): the shared reducer run over a stored index, a page at a time, on copy-on-write
// overlays over a partial base that loads its misses: every vector, at every page size, gives exactly what the
// in-memory reducer gives; a discarded overlay leaves the base untouched; a partial map can't be iterated.
//   bun web/workspace/test-sync-overlay.mjs
import { readFileSync } from "node:fs";
import { reduce, reduceAll, SyncIndex } from "./sync-reduce.ts";
import { Overlay, PartialIndex, runPage, rowsOf, OVERLAY } from "./sync-overlay.ts";
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

console.log(`${checks - fails.length}/${checks} passed`);
for (const f of fails.slice(0, 20)) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
