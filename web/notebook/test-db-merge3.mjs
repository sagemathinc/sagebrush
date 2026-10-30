// web/notebook/db-merge3.ts (P1 of the merge-alignment plan, Oct 30 2026: cocalc-ai's merge3.ts, copied) against the
// oracle db-merge3-vectors.json: 406 merges made by cocalc-ai's own built mergeDbStrings at the commit the copy is of
// (gen-db-merge3-vectors.mjs; 6 pinned cases like its jupyter-core-merge's, 400 seeded random notebook edits).
//   - mergeDbStrings gives each vector's merged records exactly (the same records, fields and order);
//   - patchflow parity: every text merged on both sides (an input changed differently on both) is, through this
//     Sagebrush's patchflow mergeStrings3, the text the source's patchflow gave (the vector's merged input);
//   - dbMerge3 on patchflow's immer db documents (the codec Sagebrush's notebook history uses, history.js SCHEMA) gives
//     the same records as mergeDbStrings: its fast path (only records changed on both sides merged) and the strings
//     path agree; and one side unchanged returns the other side's document itself.
// Nothing in Sagebrush uses db-merge3.ts yet (P1 enables nothing).
//   bun web/notebook/test-db-merge3.mjs
import { readFileSync } from "node:fs";
import { createImmerDbCodec, mergeStrings3 } from "patchflow";
import { dbMerge3, mergeDbStrings, splitLinesKeepingNewlines } from "./db-merge3.ts";

const here = new URL(".", import.meta.url).pathname;
const V = JSON.parse(readFileSync(here + "db-merge3-vectors.json", "utf8"));
const OPTS = V.producer.options;
let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok && fails.length < 20) fails.push(what); else if (!ok) fails.push("…"); };
const J = JSON.stringify;
const str = (recs) => recs.map((r) => J(r)).join("\n");
const parse = (s) => s.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
// (records compared whatever their order and their fields' order: an immer document's text orders them its own way)
const canon = (v) => (v === null || typeof v !== "object" ? J(v) : Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : "{" + Object.keys(v).sort().map((k) => J(k) + ":" + canon(v[k])).join(",") + "}");
const set = (recs) => recs.map(canon).sort().join("\n");

check(V.vectors.length === 406 && V.producer.cocalcCommit === "0b8b754708fdc8c393f4580eaeced4d0f9ebb4e5" && J(OPTS) === J({ primaryKeys: ["type", "id"], stringCols: ["input"] }), "the oracle: 406 vectors from cocalc-ai@0b8b7547, the notebook schema: " + J({ n: V.vectors.length, producer: V.producer }));

// ---- mergeDbStrings: each vector exactly
let exact = 0;
for (const v of V.vectors) {
  const got = parse(mergeDbStrings({ ...OPTS, base: str(v.base), a: str(v.a), b: str(v.b) }));
  const ok = J(got) === J(v.merged);
  if (ok) exact++;
  check(ok, `${v.name}: mergeDbStrings gives the source's merge: ` + J({ got, want: v.merged }));
}

// ---- patchflow parity on text: Sagebrush's mergeStrings3 gives the source's merged input
let textCases = 0;
for (const v of V.vectors) {
  const key = (r) => r.type + "/" + r.id;
  const A = new Map(v.a.map((r) => [key(r), r])), B = new Map(v.b.map((r) => [key(r), r])), M = new Map(v.merged.map((r) => [key(r), r]));
  for (const r0 of v.base) {
    const ra = A.get(key(r0)), rb = B.get(key(r0));
    if (!ra || !rb || typeof r0.input !== "string" || ra.input === rb.input || ra.input === r0.input || rb.input === r0.input) continue;
    textCases++;
    const got = mergeStrings3({ base: r0.input, a: ra.input, b: rb.input }), want = M.get(key(r0))?.input;
    check(got === want, `${v.name} ${key(r0)}: mergeStrings3 here gives the source's text: ` + J({ base: r0.input, a: ra.input, b: rb.input, got, want }));
  }
}
check(textCases === V.patchflowParity.textCases && textCases === 101, `the text cases: ${textCases} (the producer's ${V.patchflowParity.textCases})`);

// ---- dbMerge3 on patchflow's immer db documents: the fast path and the strings path agree
const codec = createImmerDbCodec(OPTS);
// (fromStr is called only by the strings path: counted, so the fast path is known to be the one tested)
let viaStrings = 0;
const merge = dbMerge3((s) => (viaStrings++, codec.fromString(s)), (d) => codec.toString(d), OPTS);
let fastSame = 0;
for (const v of V.vectors) {
  // (a and b made from base by the edit, as a session does: unchanged records shared, so `changes` finds the edit)
  const base = codec.fromString(str(v.base));
  const edit = (to) => {
    let d = base;
    const want = new Map(to.map((r) => [J([r.type, r.id]), r]));
    for (const r of v.base) if (!want.has(J([r.type, r.id]))) d = d.delete({ type: r.type, id: r.id });
    for (const r of to) {
      const old = v.base.find((x) => x.type === r.type && x.id === r.id);
      if (old && canon(old) === canon(r)) continue;
      if (old) d = d.delete({ type: r.type, id: r.id });
      d = d.set(r);
    }
    return d;
  };
  const a = edit(v.a), b = edit(v.b);
  const got = parse(codec.toString(merge(base, a, b)));
  const ok = set(got) === set(v.merged);
  if (ok) fastSame++;
  check(ok, `${v.name}: dbMerge3 on immer documents gives the same records: ` + J({ got, want: v.merged }));
}
check(viaStrings === 0, `dbMerge3 took its fast path on every vector (the strings path ${viaStrings} times)`);
{
  const base = codec.fromString(str([{ type: "cell", id: "a", pos: 0, input: "x" }]));
  const a = base.set({ type: "cell", id: "a", pos: 0, input: "y" });
  check(merge(base, a, base) === a && merge(base, base, a) === a, "one side unchanged: the other side's document itself");
}

// ---- the copy's own helper (the source's, without a lookbehind)
for (const s of ["", "a", "a\n", "a\nb", "a\n\nb\n"]) check(J(splitLinesKeepingNewlines(s)) === J(s === "" ? [""] : s.split(/(?<=\n)/)), `splitLinesKeepingNewlines(${J(s)})`);

console.log(fails.length
  ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ")
  : `ok: db-merge3 (cocalc-ai@0b8b7547's merge3.ts): ${exact}/${V.vectors.length} vectors exact, ${textCases} text merges as the source's patchflow, dbMerge3 on immer documents ${fastSame}/${V.vectors.length}; ${checks} checks`);
process.exit(fails.length ? 1 : 0);
