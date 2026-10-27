// A three-way merge of a document's records (plan-sync-slice2-client r4 §2.1; r9 §3.1a, §3.5): what the journal
// computes when another tab committed since this one's base (merge3(base, P, mine)), when it reconciles an
// unjournaled entry (merge3(base, H, v)), and when a rebase meets the server's value (merge3(B, S, L)).
//
// The records are decoded (LRE's, doc-protocol.ts, already undone) and keyed by the schema's primary keys.  Every
// change is kept or reported, never dropped quietly (the ruling of Oct 26: astra, daybreak3, board):
//   - a record the same on both sides, or changed on one side only: that side's;
//   - changed on both sides (or added on both, differently): merged field by field, by the same rule;
//   - a string column (a cell's input) changed on both sides: both sides' lines applied to the base when they
//     changed separate lines (text-overlap.ts's lineMerge3, the boards' merge's too); the same lines: a clash;
//   - any other field changed differently on both sides (a cell's pos and type, the kernel), or a record deleted
//     on one side and changed on the other: a clash.  (pos too: a notebook has no other place to keep the other
//     tab's order, so a reorder on both sides keeps both, as content does.)
//
// THE CONTRACT ON A CLASH (astra, Oct 26): the caller keeps the whole of `a` as the document, durably keeps the
// whole of `b` as one copy (one per document per merge), and never commits `value`.  `value` is still
// deterministic (`a`'s field; a changed record kept over its deletion), but it is a hybrid: it is for a caller's
// inspection, not to be written.  A refusal (a copy that can't be made) keeps every draft.
//
// The work is one ledger for the whole merge (daybreak3): a unit for each record and each field walked, and each
// line diff's work (text-overlap.ts), each charged before it is done.  What the ledger can't cover isn't done:
// that record, field or text is a clash ("too-large"), so the outcome never depends on how long anything takes.
import { lineMerge3 } from "./text-overlap.ts";

/** One merge's work, all of it (text-overlap.ts caps one line diff at TEXT_DIFF_PRODUCT on its own). */
export const MERGE3_WORK = { total: 32_000_000 };

const ABSENT = Symbol("absent");

/** `mergeRecords3(schema, base, a, b)`: `{value, clashes}`, `value` the merged records (in their keys' order),
 * `clashes` [{key, field?, kind}] in the same order, kind one of "deleted-changed", "changed", "text-overlap" and
 * "too-large".  On any clash, see the contract above: keep `a`, copy `b`, don't write `value`.  `schema` is
 * {primaryKeys, stringCols}; `base`, `a` and `b` are arrays of records, plain JSON data, each key at most once. */
export function mergeRecords3(schema, base, a, b) {
  const ledger = { left: MERGE3_WORK.total };
  const B = byKey(schema, base, "base"), A = byKey(schema, a, "a"), C = byKey(schema, b, "b");
  const keys = [...new Set([...B.keys(), ...A.keys(), ...C.keys()])].sort();
  const value = [], clashes = [];
  for (const key of keys) {
    const r0 = B.get(key) ?? ABSENT, ra = A.get(key) ?? ABSENT, rb = C.get(key) ?? ABSENT;
    if (!spend(ledger, 1)) {
      clashes.push({ key, kind: "too-large" });
      value.push(ra === ABSENT ? rb : ra);
      continue;
    }
    if (same(ra, rb) || same(r0, rb)) { if (ra !== ABSENT) value.push(ra); continue; }
    if (same(r0, ra)) { if (rb !== ABSENT) value.push(rb); continue; }
    // (changed on both sides, differently)
    if (ra === ABSENT || rb === ABSENT) {
      clashes.push({ key, kind: "deleted-changed" });
      value.push(ra === ABSENT ? rb : ra);
      continue;
    }
    value.push(mergeFields(schema, key, r0 === ABSENT ? {} : r0, ra, rb, clashes, ledger));
  }
  return { value, clashes };
}

function mergeFields(schema, key, r0, ra, rb, clashes, ledger) {
  const out = {};
  const fields = [...new Set([...Object.keys(r0), ...Object.keys(ra), ...Object.keys(rb)])].sort();
  for (const f of fields) {
    const v0 = has(r0, f) ? r0[f] : ABSENT, va = has(ra, f) ? ra[f] : ABSENT, vb = has(rb, f) ? rb[f] : ABSENT;
    let v;
    if (!spend(ledger, 1)) {
      clashes.push({ key, field: f, kind: "too-large" });
      v = va === ABSENT ? vb : va;
    } else if (same(va, vb) || same(v0, vb)) v = va;
    else if (same(v0, va)) v = vb;
    else if (schema.stringCols?.includes(f) && typeof va === "string" && typeof vb === "string" && (v0 === ABSENT || typeof v0 === "string")) {
      const m = lineMerge3(v0 === ABSENT ? "" : v0, va, vb, ledger);
      if ("text" in m) v = m.text;
      else {
        clashes.push({ key, field: f, kind: "exhausted" in m ? "too-large" : "text-overlap" });
        v = va;
      }
    } else {
      clashes.push({ key, field: f, kind: "changed" });
      v = va;
    }
    if (v !== ABSENT) putOwn(out, f, v);
  }
  return out;
}

// (a field set as the record's own data, whatever its name: `out[f] = v` would run Object.prototype's __proto__
// setter for a field named "__proto__", losing the field and changing the record's prototype (astra's HOLD on #199))
function putOwn(o, k, v) {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

// (the ledger charged `n`, if it has that much left; nothing charged otherwise)
function spend(ledger, n) {
  if (n > ledger.left) return false;
  ledger.left -= n;
  return true;
}

// (each record by its key: the primary keys' values, absent ones as null, which no primary key holds)
function byKey(schema, records, which) {
  if (!Array.isArray(records)) throw new TypeError(`mergeRecords3: ${which} isn't a list of records`);
  const m = new Map();
  for (const r of records) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) throw new TypeError(`mergeRecords3: ${which} has an entry that isn't a record`);
    const key = JSON.stringify(schema.primaryKeys.map((k) => (has(r, k) ? r[k] : null)));
    if (m.has(key)) throw new TypeError(`mergeRecords3: ${which} has two records with the key ${key}`);
    m.set(key, r);
  }
  return m;
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const same = (x, y) => x === y || (x !== ABSENT && y !== ABSENT && canon(x) === canon(y));
// (canonical JSON: object keys sorted, so key order never makes two equal values differ)
function canon(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
}
