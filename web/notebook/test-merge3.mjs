// web/notebook/merge3.js's mergeRecords3 (plan-sync-slice2-client r4 §2.1; the ruling of Oct 26): the shared
// vectors (merge3-vectors.json's records), symmetry in the two sides, random edits (a change made on one side only
// is always taken; a clash's value is a's), the one ledger (records, fields and text work, each "too-large" past
// it), and malformed input refused.
//   bun web/notebook/test-merge3.mjs
import { readFileSync } from "node:fs";
import { mergeRecords3, MERGE3_WORK } from "./merge3.js";

const here = new URL(".", import.meta.url).pathname;
const V = JSON.parse(readFileSync(here + "merge3-vectors.json", "utf8")).records;
let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const canon = (v) => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}");
const S = V.schema;
const clashSet = (cs) => cs.map((c) => `${c.key}|${c.field ?? ""}|${c.kind}`).sort().join(";");
const guard = (name, f) => { try { f(); } catch (e) { check(false, `${name}: threw ${e?.stack ?? e}`); } };

// ---- the shared vectors, both orders
for (const v of V.cases) guard(v.name, () => {
  const r = mergeRecords3(S, v.base, v.a, v.b);
  check(canon(r.value) === canon(v.value) && canon(r.clashes) === canon(v.clashes), `${v.name}: ${canon(r)}`);
  const s = mergeRecords3(S, v.base, v.b, v.a);
  check(clashSet(s.clashes) === clashSet(r.clashes), `${v.name}: the same clashes with a and b swapped`);
  if (!r.clashes.length) check(canon(s.value) === canon(r.value), `${v.name}: no clash, the same value with a and b swapped`);
});
check(/keeps the whole of a/.test(V.contract) && /copy/.test(V.contract) && /never writes value/.test(V.contract), "the vectors state the clash contract");

// ---- random edits: a one-sided change always wins, a clash's value is a's, the output is in key order
{
  let seed = 11;
  const rnd = (k) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % k);
  const ids = ["a", "b", "c", "d", "e"];
  const text = () => Array.from({ length: rnd(4) }, () => "pqrst"[rnd(5)] + "\n").join("");
  const doc = () => ids.filter(() => rnd(3) > 0).map((id, i) => ({ type: "cell", id, pos: i, input: text(), cell_type: rnd(4) ? "code" : "markdown" }));
  const edit = (d) => {
    const x = d.map((r) => ({ ...r }));
    for (let k = rnd(3); k >= 0; k--) {
      const op = rnd(5), i = rnd(x.length + 1);
      if (op === 0 && i < x.length) x.splice(i, 1);
      else if (op === 1) { const id = ids[rnd(ids.length)]; if (!x.some((r) => r.id === id)) x.push({ type: "cell", id, pos: rnd(9), input: text(), cell_type: "code" }); }
      else if (op === 2 && i < x.length) x[i].input = text();
      else if (op === 3 && i < x.length) x[i].pos = rnd(9);
      else if (i < x.length) x[i].cell_type = x[i].cell_type === "code" ? "raw" : "code";
    }
    return x;
  };
  let bad = 0, order = 0, asym = 0;
  const key = (r) => JSON.stringify([r.type, r.id]);
  for (let t = 0; t < 3000; t++) {
    const base = doc(), a = edit(base), b = edit(base);
    const r = mergeRecords3(S, base, a, b), s = mergeRecords3(S, base, b, a);
    if (clashSet(r.clashes) !== clashSet(s.clashes)) asym++;
    const ks = r.value.map(key);
    if (ks.join() !== [...ks].sort().join()) order++;
    const B = new Map(base.map((x) => [key(x), x])), A = new Map(a.map((x) => [key(x), x])), C = new Map(b.map((x) => [key(x), x])), R = new Map(r.value.map((x) => [key(x), x]));
    const clashed = new Set(r.clashes.map((c) => c.key));
    for (const k of new Set([...B.keys(), ...A.keys(), ...C.keys()])) {
      const x0 = canon(B.get(k)), xa = canon(A.get(k)), xb = canon(C.get(k)), xr = canon(R.get(k));
      if (clashed.has(k)) continue;
      if (xa === x0 && xr !== xb) bad++;
      else if (xb === x0 && xr !== xa) bad++;
    }
    for (const c of r.clashes) if (c.field && R.get(c.key) && canon(R.get(c.key)[c.field]) !== canon(A.get(c.key)?.[c.field])) bad++;
  }
  check(bad === 0, `3,000 random merges: a one-sided change taken, a clash's value a's (${bad} not)`);
  check(order === 0, `…the value in key order (${order} not)`);
  check(asym === 0, `…the same clashes either way round (${asym} not)`);
}

// ---- the one ledger: records, fields and text work; past it, "too-large", nothing guessed
{
  const keep = MERGE3_WORK.total;
  try {
    const base = [{ type: "cell", id: "a", pos: 0, input: "p\nq\n", cell_type: "code" }];
    const a = [{ ...base[0], input: "P\nq\n" }], b = [{ ...base[0], input: "p\nQ\n" }];
    MERGE3_WORK.total = keep;
    const full = mergeRecords3(S, base, a, b);
    check(full.clashes.length === 0 && full.value[0].input === "P\nQ\n", "with work enough, separate lines merge");
    MERGE3_WORK.total = 0;
    const r0 = mergeRecords3(S, base, a, b);
    check(r0.clashes.length === 1 && r0.clashes[0].kind === "too-large" && !r0.clashes[0].field && r0.value[0].input === "P\nq\n", "no work at all: the record is too large, a's kept: " + canon(r0));
    MERGE3_WORK.total = 1;
    const r1 = mergeRecords3(S, base, a, b);
    check(r1.clashes.every((c) => c.kind === "too-large" && c.field) && r1.clashes.length === 5, "work for the record only: each field too large: " + canon(r1.clashes));
    // (the walk is in field order, cell_type, id, input, pos, type: 1 for the record, 1 a field, and input's two one-line
    // diffs 1 each: 8 in all)
    MERGE3_WORK.total = 5;
    const r5 = mergeRecords3(S, base, a, b), in5 = r5.clashes.find((c) => c.field === "input");
    check(in5?.kind === "too-large" && r5.value[0].input === "P\nq\n", "work for one of input's two diffs: the input too large, a's kept: " + canon(r5.clashes));
    MERGE3_WORK.total = 8;
    const r8 = mergeRecords3(S, base, a, b);
    check(r8.clashes.length === 0 && r8.value[0].input === "P\nQ\n", "work for the whole merge (8): merged");
    MERGE3_WORK.total = 7;
    const r7 = mergeRecords3(S, base, a, b);
    check(r7.clashes.length === 1 && r7.clashes[0].field === "type" && r7.clashes[0].kind === "too-large" && r7.value[0].input === "P\nQ\n", "one unit less (7): the last field walked too large, the rest merged: " + canon(r7.clashes));
    MERGE3_WORK.total = 0;
    const same = mergeRecords3(S, base, base, base);
    check(same.clashes.length === 1 && same.clashes[0].kind === "too-large", "even an unchanged record is charged its unit");
  } finally {
    MERGE3_WORK.total = keep;
  }
}

// ---- a field named "__proto__" is the record's own data (astra's and daybreak3's HOLD on #199): kept through the field
// merge, the record's prototype untouched, the JSON the same after a round trip
{
  const P = (j) => JSON.parse(j);
  const base = [P('{"type":"cell","id":"a","pos":0,"input":"x\\n","cell_type":"code","__proto__":{"keep":"old"}}')];
  const a = [P('{"type":"cell","id":"a","pos":0,"input":"x\\n","cell_type":"code","__proto__":{"keep":"new"}}')];
  const b = [P('{"type":"cell","id":"a","pos":1,"input":"x\\n","cell_type":"code","__proto__":{"keep":"old"}}')];
  const r = mergeRecords3(S, base, a, b), rec = r.value[0];
  check(r.clashes.length === 0 && Object.prototype.hasOwnProperty.call(rec, "__proto__") && Object.getPrototypeOf(rec) === Object.prototype && rec.pos === 1, "an own __proto__ field kept as data, the prototype untouched: " + JSON.stringify(rec));
  check(JSON.stringify(JSON.parse(JSON.stringify(rec))) === JSON.stringify(rec) && JSON.stringify(rec).includes('"__proto__":{"keep":"new"}'), "…and it survives a JSON round trip");
  // (the names Object.prototype holds, as boardMerge3's regression has them (astra2's CORR-PR121-1), each set to an
  // object, null, a string and a number on a, another field changed on b: each kept as own data, the prototype untouched)
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    for (const v of [{ x: 1 }, null, "s", 7]) {
      const mk = (pos, val) => P(`{"type":"cell","id":"a","pos":${pos},"input":"x\\n","cell_type":"code",${JSON.stringify(name)}:${JSON.stringify(val)}}`);
      const rr = mergeRecords3(S, [mk(0, "old")], [mk(0, v)], [mk(2, "old")]);
      const rec2 = rr.value[0];
      check(rr.clashes.length === 0 && own(rec2, name) && JSON.stringify(rec2[name]) === JSON.stringify(v) && rec2.pos === 2 && Object.getPrototypeOf(rec2) === Object.prototype, `an own ${name} field set to ${JSON.stringify(v)} on a, pos on b: both kept: ` + JSON.stringify(rec2));
    }
  }
}

// ---- malformed input refused
for (const [name, args] of [
  ["a base that isn't a list", [{}, [], []]],
  ["an entry that isn't a record", [[], [1], []]],
  ["an array as a record", [[], [], [[]]]],
  ["two records with one key", [[], [{ type: "cell", id: "a" }, { type: "cell", id: "a" }], []]],
]) {
  let threw = false;
  try { mergeRecords3(S, ...args); } catch (e) { threw = e instanceof TypeError; }
  check(threw, `refused: ${name}`);
}

console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `${checks}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
