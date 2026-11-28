// ci: web-sync.1 order=62 runner=bun
// The sealed index's document key declarations as every device keeps them (web/workspace/sync-dockeys.ts; design notes
// e2e-doc-key-declarations r2): the first eligible declaration of a document in an epoch is its current one, by log
// order, within a page and across pages; a later one of the same (document, epoch, cekId) changes nothing, whatever
// wrap it carries; one its row's verification found ineligible, or with no verdict, declares nothing (counted); a new
// epoch has no current declaration until one is made in it, while the old ones are still found exactly; another index
// generation's ledger is never read; and the verdict is never stored.
//   bun web/workspace/test-sync-dockeys.mjs
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const D = await import(join(here, "sync-dockeys.ts"));

let failures = 0, count = 0;
const check = (c, msg, detail) => { count++; console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 400) : "")); if (!c) failures++; };
const J = JSON.stringify;

/** An object store's requests over a Map, answered as IndexedDB answers them (after the handler is set). */
function fakeMeta() {
  const m = new Map();
  const reqOf = (f) => {
    const r = { onsuccess: null, onerror: null, result: undefined, error: null };
    queueMicrotask(() => {
      try { r.result = f(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); }
    });
    return r;
  };
  return {
    map: m,
    get: (k) => reqOf(() => m.get(k)),
    put: (v, k) => { m.set(k, v); return reqOf(() => k); },
    delete: (k) => { m.delete(k); return reqOf(() => undefined); },
  };
}

const GEN = "ns#0", DOC = "0123456789ab", DOC2 = "ba9876543210";
const cek = (c) => c.repeat(32);
const wrap = (fill) => D.b64urlOf(new Uint8Array(60).fill(fill));
let seq = 0;
const decl = (o) => ({ seq: ++seq, dseq: seq, device: "d1d1d1d1d1d1d1d1", t: 1000 + seq, by: "person", op: "doc-key", path: "/", kind: "folder", document: DOC, cekId: cek("a"), keyEpoch: 1, wrappedCek: wrap(1), ...o });
const HEAD = "h".repeat(43);
/** A device's ledger: apply(page, verdicts) as the confirmed index applies a page (each op's verdict by its seq). */
function device(gen = GEN) {
  const meta = fakeMeta(), verdicts = new Map();
  return {
    meta,
    async apply(page, eligible = () => true) {
      for (const op of page) if (op.op === "doc-key") verdicts.set(op.seq, { eligible: eligible(op), head: HEAD });
      await D.docKeyPage(meta, gen, page, (s) => verdicts.get(s));
    },
    current: (doc, epoch) => D.currentDecl(meta, gen, doc, epoch),
    exact: (doc, id, epoch) => D.exactDecl(meta, gen, doc, id, epoch),
    voided: () => D.voidCount(meta, gen),
  };
}
const idOf = (d) => d && `${d.cekId[0]}:${d.keyEpoch}:${d.wrappedCek[0]}`;

// ---- first wins: within one page, by log order
{
  seq = 0;
  const x = device(), y = device();
  const A = decl({ cekId: cek("a") }), B = decl({ cekId: cek("b"), wrappedCek: wrap(2) });
  await x.apply([A, B]);
  await y.apply([{ ...B, seq: 1 }, { ...A, seq: 2 }]);
  const got = { x: idOf(await x.current(DOC, 1)), y: idOf(await y.current(DOC, 1)), xa: !!(await x.exact(DOC, cek("a"), 1)), xb: !!(await x.exact(DOC, cek("b"), 1)) };
  check(got.x === "a:1:1" && got.y === "b:1:2" && got.xa && got.xb, "a page [A, B] makes A current and [B, A] makes B: the first in log order; both are found exactly", got);
}

// ---- first wins across pages
{
  seq = 0;
  const x = device();
  await x.apply([decl({ cekId: cek("a") })]);
  await x.apply([decl({ cekId: cek("b") })]);
  check(idOf(await x.current(DOC, 1)) === "a:1:1", "A in one page, B in a later one: A stays current (the ledger's first, not a page's)", await x.current(DOC, 1));
}

// ---- a same-triple declaration again changes nothing, whatever it wraps
{
  seq = 0;
  const x = device();
  await x.apply([decl({ wrappedCek: wrap(1) })]);
  const before = J([...x.meta.map]);
  await x.apply([decl({ wrappedCek: wrap(9) })]);
  const e = await x.exact(DOC, cek("a"), 1);
  check(J([...x.meta.map]) === before && e && e.wrappedCek.every((b) => b === 1) && e.wrappedCek.length === 60, "the same (document, epoch, cekId) declared again with another wrap: nothing changes; the first's 60 bytes are answered", { e: e && Array.from(e.wrappedCek.slice(0, 4)) });
}

// ---- ineligible, or no verdict: declares nothing, counted
{
  seq = 0;
  const x = device();
  const before = J([...x.meta.map]);
  await x.apply([decl({ cekId: cek("a") })], () => false);
  const noVerdict = decl({ cekId: cek("b") });
  await D.docKeyPage(x.meta, GEN, [noVerdict], () => undefined);
  check(J([...x.meta.map].filter(([k]) => !k.endsWith(":dk:void"))) === before && (await x.current(DOC, 1)) === null && (await x.exact(DOC, cek("a"), 1)) === null && (await x.voided()) === 2,
    "a declaration its row's verification found ineligible, or one with no verdict: nothing written, none current, both counted void");
  // (and an ineligible first doesn't hold the place: the next eligible one is current)
  await x.apply([decl({ cekId: cek("c") })]);
  check(idOf(await x.current(DOC, 1)) === "c:1:1", "after an ineligible first, the next eligible declaration becomes current", await x.current(DOC, 1));
}

// ---- a new epoch: none current until one is made in it; the old found exactly
{
  seq = 0;
  const x = device();
  await x.apply([decl({ cekId: cek("a"), keyEpoch: 1 })]);
  const at2 = await x.current(DOC, 2);
  await x.apply([decl({ cekId: cek("b"), keyEpoch: 2 })]);
  const got = { at2, now2: idOf(await x.current(DOC, 2)), still1: idOf(await x.current(DOC, 1)), old: !!(await x.exact(DOC, cek("a"), 1)), other: await x.current(DOC2, 2) };
  check(got.at2 === null && got.now2 === "b:2:1" && got.still1 === "a:1:1" && got.old && got.other === null, "a new epoch has no current declaration until one is made in it, which becomes current; the old epoch's is still found exactly; another document has none", got);
}

// ---- another index generation's ledger is never read; nothing else of an op is stored
{
  seq = 0;
  const x = device("ns#0");
  await x.apply([decl({})]);
  const y = { current: (doc, e) => D.currentDecl(x.meta, "ns#1", doc, e), exact: (doc, id, e) => D.exactDecl(x.meta, "ns#1", doc, id, e) };
  const stored = [...x.meta.map].map(([k, v]) => [k, v]);
  check((await y.current(DOC, 1)) === null && (await y.exact(DOC, cek("a"), 1)) === null, "another index generation (a new namespace's) reads none of this one's declarations");
  check(stored.every(([k, v]) => k.startsWith("sync:ns#0:dk:")) && !J(stored).includes("eligible"), "every key under the generation's prefix; no verdict stored", stored);
}

// ---- the form (isDocKeyForm) and the edge (docKeyOp, isDeclaration)
{
  const good = { dseq: 1, t: 1, by: "person", op: "doc-key", path: "/", kind: "folder", document: DOC, cekId: cek("a"), keyEpoch: 1, wrappedCek: wrap(1) };
  const bad = {
    eligible: { ...good, eligible: true }, head: { ...good, head: HEAD }, "no wrap": (({ wrappedCek, ...r }) => r)(good),
    "a short wrap": { ...good, wrappedCek: wrap(1).slice(0, 79) }, "a wrap not base64url": { ...good, wrappedCek: "+".repeat(80) },
    "a cekId of 31": { ...good, cekId: "a".repeat(31) }, "a path id": { ...good, document: "/n.ipynb" }, "keyEpoch -1": { ...good, keyEpoch: -1 },
    "a kind": { ...good, kind: "file" },
  };
  const refused = Object.entries(bad).filter(([, o]) => D.isDocKeyForm(o)).map(([k]) => k);
  check(D.isDocKeyForm(good) && refused.length === 0, "the form: exactly its fields; an `eligible` or a `head`, a field missing, a wrap, cekId, document, keyEpoch or kind that isn't one: refused", refused);
  const d = { document: DOC, cekId: cek("a"), keyEpoch: 3, wrappedCek: new Uint8Array(60).fill(7), head: HEAD };
  const op = D.docKeyOp(5, 9, "person", d);
  check(D.isDocKeyForm(op) && op.keyEpoch === 3 && D.bytesOf(op.wrappedCek).every((b) => b === 7) && !D.isDeclaration({ ...d, wrappedCek: new Uint8Array(59) }) && !D.isDeclaration({ ...d, wrappedCek: "x" }),
    "a declaration made into an op: base64url at the edge, a 60-byte Uint8Array in; anything else isn't a declaration");
}

console.log(failures ? `${failures} of ${count} FAILED` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
