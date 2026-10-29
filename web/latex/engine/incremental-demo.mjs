// D4 incremental layer (D3 r4 §7.2-§7.3), r2.
// cold runs; edits mapped through a change set with carried (session-local) checkpoint ids; resume from
// the last checkpoint before the edit; convergence by the boundary comparison; on convergence, the reused
// suffix gets (a) every cumulative counter reconciled and (b) unread-but-changed counter-class keys
// propagated until the first later writer. The correctness oracle compares canonical STRUCTURE
// (names, tokens, delimiters, flags, register values, group save stacks, reader continuations), not only
// the fast hashes, against an independent cold run with its own fresh intern (astra4/daybreak2 D4 r1).
import { Machine, Intern, BoundError, StopError, setCurrentIntern } from "./demo-machine.mjs";
import { valueHash } from "../core/pmap.mjs";

let idSeq = 1;
const freshId = () => idSeq++;
class Converged extends Error { constructor(info) { super("converged"); this.info = info; } }

// ---------------------------------------------------------------- canonical forms
const ctok = (t, I) => (t >= 0 ? t : "\\" + I.name(t));
const ctoks = (a, I) => a.map((t) => ctok(t, I));
export function canonValue(v, I) {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return v;
  switch (v.type) {
    case "macro": return ["macro", ctoks(v.pre, I), v.delims.map((d) => ctoks(d, I)), ctoks(v.body, I), !!v.long, !!v.prot];
    case "lmacro": return ["lmacro", v.n, v.dflt ? ctoks(v.dflt, I) : null, ctoks(v.body, I), !!v.prot];
    case "char": return ["char", ctok(v.tok, I)];
    case "count": case "chardef": case "toksdef": return [v.type, v.n];
    case "prim": case "xprim": return [v.type, v.name];
    case "data": return ["data", JSON.parse(JSON.stringify(v.data, (k, x) => (typeof x === "number" && x < 0 ? "\\" + I.name(x) : x)))];
    default: return ["?", String(v.type)];
  }
}
const cstr = (v, I) => JSON.stringify(canonValue(v, I));
export function mapDeepDiff(m1, I1, m2, I2) {        // null if equal, else a description (raw, VM-only)
  if (m1.size !== m2.size) return "size " + m1.size + " vs " + m2.size;
  for (const [k, v] of m1.entries()) {
    const w = m2.get(k);
    if (w === undefined && v !== undefined) return "missing key";
    if (cstr(v, I1) !== cstr(w, I2)) return "value differs";
  }
  return null;
}
function canonGroups(gs, I) {
  return JSON.stringify(gs.map((g) => [g.kind, g.env ?? null, ctoks(g.after, I),
    [...g.saved].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, { inC, old }]) => [k, inC, canonValue(old, I)])]));
}
function canonReaders(rs) { return JSON.stringify(rs.map((r) => [r.path, r.pos, r.lineStart, r.li, r.st, r.partial, !!r.endinput])); }
const canonSeen = (m) => JSON.stringify([...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
// every cumulative / continuation field that restore() reads must agree (astra4/daybreak2 D4 r2)
const ckCounters = (c) => [c.work, c.srcTokens, c.filesRead, c.memBytes || 0, c.logN || 0, c.nCheckpoints || 0, canonSeen(c.srcSeen)].join("|");
function readersKey(ck, main) { return ck.readers.map((r) => r.path + "@" + (r.path === main ? "" : r.pos) + ":" + (r.partial ? "p" + r.li + "/" + r.st : "l")).join("|"); }
const unitDigest = (u) => u.out.h1 + ":" + u.out.h2 + ":" + u.out.n;

// ---------------------------------------------------------------- runs
export function coldRun(files, main, opts = {}) {
  const intern = opts.intern || new Intern();
  const m = new Machine({ files, main, known: opts.known, limits: opts.limits, intern, stopFlag: opts.stopFlag, Tmin: opts.Tmin });
  const t0 = process.hrtime.bigint();
  let outcome = "ok", err = null;
  if (!m.openFile(main)) return { m, intern, files, main, ms: 0, outcome: "NO-MAIN", err: null, checkpoints: [], units: [], final: "", unitDigests: [], opts, counters: {} };
  try { m.run(); }
  catch (e) {
    if (e instanceof BoundError) outcome = e.code; else if (e instanceof StopError) outcome = "STOPPED";
    else { outcome = "EXCEPTION"; err = String(e && e.stack || e).split("\n").slice(0, 3).join(" | "); }
    m.finishUnit(null);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  for (const ck of m.checkpoints) ck.id = freshId();
  return { m, intern, files, main, ms, outcome, err, checkpoints: m.checkpoints, units: m.units, finalA: m.A, finalC: m.C,
    final: m.stateKey(), unitDigests: m.units.map(unitDigest), opts,
    counters: { work: m.work, srcTokens: m.srcTokens, filesRead: m.filesRead, admittedBytes: m.admittedBytes, memBytes: m.memBytes, logN: m.logN || 0, nCheckpoints: m.checkpoints.length } };
}

export function applyEdit(prev, edit) {
  const old = prev.files.get(prev.main);
  const now = old.slice(0, edit.start) + edit.text + old.slice(edit.end);
  const files = new Map(prev.files); files.set(prev.main, now);
  return { files, delta: edit.text.length - (edit.end - edit.start) };
}

export function incremental(prev, edit) {
  const { files, delta } = applyEdit(prev, edit);
  const s = edit.start, e = edit.end;
  const oldMain = prev.files.get(prev.main);
  const mapped = prev.checkpoints.map((ck, i) => {
    // depends only on text before mainPos, and before the end of the main file's consumed source: when the main file
    // read itself, the outer reader's place is behind text the inner read already took in. srcSeen holds where the
    // last main token STARTS; lines are read whole and a checkpoint is at a line start, so the consumed source ends
    // with that token's line (astra4 POS-A4-2: an edit inside a control word read just before the checkpoint).
    // For any other document this is the same as mainPos <= s: the high-water line ends just before mainPos.
    const seen = ck.srcSeen.get(prev.main);
    const nl = seen === undefined ? -1 : oldMain.indexOf("\n", seen), seenEnd = seen === undefined ? -1 : nl < 0 ? oldMain.length : nl;
    if (ck.mainPos <= s && seenEnd < s) return { ck, i, pos: ck.mainPos, state: "before" };
    const mr = ck.readers.find((r) => r.path === prev.main);
    // a half-read main line depends on text from its line start: an edit touching or AT that start drops it
    const after = mr && mr.partial ? mr.lineStart > e : ck.mainKey >= e;
    return after ? { ck, i, pos: ck.mainPos + delta, state: "after" } : { ck, i, pos: -1, state: "dropped" };
  });
  let r = -1;
  for (const x of mapped) if (x.state === "before") r = x.i;
  const t0 = process.hrtime.bigint();
  if (r < 0) {
    const res = coldRun(files, prev.main, Object.assign({}, prev.opts, { intern: prev.intern }));
    return { res, stats: { mode: "full", ms: res.ms, reexpandedUnits: res.units.length, reusedUnits: 0, patchedKeys: 0 } };
  }
  const nU = prev.units.length;
  const after = new Array(nU + 1); after[nU] = new Set();
  for (let j = nU - 1; j >= 0; j--) { after[j] = new Set(after[j + 1]); for (const k of prev.units[j].R) after[j].add(k); }
  const declined = {};   // candidate checkpoints that matched semantically but were refused, by guard (fixtures assert the guard was REACHED)
  const decline = (why) => { declined[why] = (declined[why] || 0) + 1; };
  const byPos = new Map();
  for (const x of mapped) if (x.state === "after") byPos.set(x.pos, x);
  const base = prev.checkpoints[r];
  const m = new Machine({ files, main: prev.main, known: prev.opts.known, limits: prev.opts.limits, intern: prev.intern, Tmin: prev.opts.Tmin,
    onCheckpoint: (ck, mach) => {
      const cand = byPos.get(mach.mainPos());
      if (!cand) return;
      const old = cand.ck;
      if (readersKey(old, prev.main) !== readersKey(ck, prev.main)) return;
      if (!old.A.hashEquals(ck.A)) return;
      if (canonGroups(old.groups, prev.intern) !== canonGroups(ck.groups, prev.intern)) return;
      for (const k of after[cand.i + 1] || []) if (cstr(old.C.get(k), prev.intern) !== cstr(ck.C.get(k), prev.intern)) return;
      // the reused suffix keeps its own work, but the cumulative totals shift: they must stay within every
      // bound of the EDITED document, and an old bound failure is never inherited (re-expand instead)
      if (prev.outcome !== "ok") return decline("prevNotOk");
      // the distinct-source high-water marks are path-dependent: reuse only if they agree exactly at this
      // point (main-file offsets shifted by delta); otherwise the suffix's counting could differ from cold
      { const shifted = new Map(old.srcSeen); if (shifted.has(prev.main)) shifted.set(prev.main, shifted.get(prev.main) + delta);
        if (canonSeen(shifted) !== canonSeen(ck.srcSeen)) return decline("srcSeen"); }
      // EVERY enforced cumulative bound (astra4 D4 r3 R2 audit). All of these counters only grow, so the
      // shifted FINAL total is the suffix's maximum; per-unit, depth, group, conditional and token-list bounds
      // depend only on state, which is equal here, so the reused suffix meets them as it did before.
      const L = mach.limits, dW = ck.work - old.work;
      const finalWork = prev.counters.work + dW;
      const docBudget = Math.max(L.B0, L.k === Infinity ? Infinity : L.k * mach.admittedBytes);
      if (finalWork > docBudget || finalWork > L.safetyWork) return decline("work");
      const finalFiles = prev.counters.filesRead + (ck.filesRead - old.filesRead);
      if (finalFiles > L.inputFiles) return decline("inputFiles");
      const finalMem = (prev.counters.memBytes || 0) + ((ck.memBytes || 0) - (old.memBytes || 0));
      if (finalMem > L.memBytes) return decline("memBytes");
      const finalLog = (prev.counters.logN || 0) + ((ck.logN || 0) - (old.logN || 0));
      if (finalLog > 4 * 2 ** 20) return decline("log");
      const finalCk = prev.checkpoints.length + ((ck.nCheckpoints || 0) - (old.nCheckpoints || 0));
      if (finalCk >= 4096 || prev.checkpoints.length >= 4096) return decline("checkpoints");   // the coalescing cap could act differently
      // the state-size bound (A.size + C.size <= csCount) is checked at each definition: patching the suffix
      // with an ADDED counter-class key would make every later state one entry larger than in the old run,
      // and the old run's peak is not recorded, so a patched addition is never reused
      for (const [k] of ck.C.entries()) if (old.C.get(k) === undefined) return decline("csAdd");
      throw new Converged({ oldIndex: cand.i, newCk: ck });
    } });
  m.restore(base, files, 0);
  let outcome = "ok", conv = null, err = null;
  try { m.run(); }
  catch (x) {
    if (x instanceof Converged) conv = x.info;
    else { if (x instanceof BoundError) outcome = x.code; else if (x instanceof StopError) outcome = "STOPPED"; else { outcome = "EXCEPTION"; err = String(x && x.stack || x).split("\n").slice(0, 3).join(" | "); } m.finishUnit(null); }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const checkpoints = prev.checkpoints.slice(0, r + 1);
  for (const ck of m.checkpoints) { ck.id = freshId(); checkpoints.push(ck); }
  const units = prev.units.slice(0, r + 1).concat(m.units);
  let finalA = m.A, finalC = m.C, counters = { work: m.work, srcTokens: m.srcTokens, filesRead: m.filesRead, admittedBytes: m.admittedBytes, memBytes: m.memBytes, logN: m.logN || 0, nCheckpoints: checkpoints.length };
  let patchedKeys = 0;
  if (conv) {
    const oldCk = prev.checkpoints[conv.oldIndex], newCk = conv.newCk;
    checkpoints[checkpoints.length - 1].id = oldCk.id;                      // the carried id (§7.2)
    // (a) cumulative counters of the reused suffix shift by the prefix's difference
    const dW = newCk.work - oldCk.work, dS = newCk.srcTokens - oldCk.srcTokens, dF = newCk.filesRead - oldCk.filesRead;
    const dM = (newCk.memBytes || 0) - (oldCk.memBytes || 0), dL = (newCk.logN || 0) - (oldCk.logN || 0), dN = (newCk.nCheckpoints || 0) - (oldCk.nCheckpoints || 0);
    // (b) unread counter-class keys that differ: propagate until the first later writer
    const D = new Map();
    const keys = new Set([...[...oldCk.C.entries()].map(([k]) => k), ...[...newCk.C.entries()].map(([k]) => k)]);
    for (const k of keys) if (cstr(oldCk.C.get(k), prev.intern) !== cstr(newCk.C.get(k), prev.intern)) D.set(k, newCk.C.get(k));
    patchedKeys = D.size;
    const patch = (C) => { let c = C; for (const [k, v] of D) c = v === undefined ? c.delete(k) : c.set(k, v); return c; };
    // the distinct-source high-water map: main-file offsets shift by delta; other files take the larger of
    // the (unchanged-suffix) old mark and the new prefix's mark
    const reconcileSeen = (seen) => { const n = new Map(seen); if (n.has(prev.main)) n.set(prev.main, n.get(prev.main) + delta); return n; };   // maps agreed at convergence
    for (let j = conv.oldIndex + 1; j < prev.checkpoints.length; j++) {
      const o = prev.checkpoints[j];
      for (const k of prev.units[j].W) D.delete(k);
      checkpoints.push(Object.assign({}, o, {
        C: D.size ? patch(o.C) : o.C, mainPos: o.mainPos + delta, mainKey: o.mainKey + delta,
        readers: o.readers.map((rd) => rd.path === prev.main ? Object.assign({}, rd, { pos: rd.pos + delta, lineStart: rd.lineStart + delta }) : rd),
        work: o.work + dW, srcTokens: o.srcTokens + dS, filesRead: o.filesRead + dF, srcSeen: reconcileSeen(o.srcSeen),
        memBytes: (o.memBytes || 0) + dM, logN: (o.logN || 0) + dL, nCheckpoints: (o.nCheckpoints || 0) + dN,
      }));
    }
    for (let j = conv.oldIndex + 1; j < prev.units.length; j++) units.push(prev.units[j]);
    for (const k of prev.units[prev.units.length - 1].W) D.delete(k);
    finalA = prev.finalA; finalC = D.size ? patch(prev.finalC) : prev.finalC;
    counters = { work: prev.counters.work + dW, srcTokens: prev.counters.srcTokens + dS, filesRead: prev.counters.filesRead + dF, admittedBytes: m.admittedBytes,
      memBytes: (prev.counters.memBytes || 0) + dM, logN: (prev.counters.logN || 0) + dL, nCheckpoints: checkpoints.length };
    outcome = "ok";   // reuse is only accepted when prev was ok and every recomputed total is within the edited document's bounds
  }
  const res = { m, intern: prev.intern, files, main: prev.main, ms, outcome, err, checkpoints, units, finalA, finalC,
    final: finalA.hashString() + "/" + finalC.hashString(), unitDigests: units.map(unitDigest), opts: prev.opts, counters };
  return { res, stats: { declined, mode: conv ? "converged" : "to-end", ms, reexpandedUnits: m.units.length, reusedUnits: conv ? prev.units.length - conv.oldIndex - 1 : 0, resumedFrom: r, patchedKeys } };
}

// The oracle: an incremental (or replayed) result against a cold reference that may use a DIFFERENT intern.
// Every checkpoint: position, reader continuation (deep), group save stack (deep, canonical), state hashes
// (intern-independent), cumulative counters. Sampled checkpoints and the final state: entry-by-entry
// canonical comparison of A and C. Plus unit output digests, outcome and final counters.
export function sameAsCold(inc, ref, sampleN = 3) {
  const I1 = inc.intern, I2 = ref.intern;
  if (inc.outcome !== ref.outcome) return { ok: false, why: "outcome" };
  for (const f of ["work", "srcTokens", "filesRead", "admittedBytes", "memBytes", "logN", "nCheckpoints"]) if ((inc.counters[f] || 0) !== (ref.counters[f] || 0)) return { ok: false, why: "counters" };
  if (inc.checkpoints.length !== ref.checkpoints.length) return { ok: false, why: "checkpoint count" };
  const n = ref.checkpoints.length;
  const sample = new Set(n ? [0, Math.floor(n / 2), n - 1].slice(0, sampleN) : []);
  for (let i = 0; i < n; i++) {
    const a = inc.checkpoints[i], b = ref.checkpoints[i];
    if (a.mainPos !== b.mainPos) return { ok: false, why: "checkpoint position" };
    if (canonReaders(a.readers) !== canonReaders(b.readers)) return { ok: false, why: "checkpoint readers" };
    if (canonGroups(a.groups, I1) !== canonGroups(b.groups, I2)) return { ok: false, why: "checkpoint groups" };
    if (!a.A.hashEquals(b.A) || !a.C.hashEquals(b.C)) return { ok: false, why: "checkpoint state hash" };
    if (ckCounters(a) !== ckCounters(b)) return { ok: false, why: "checkpoint counters" };
    if (sample.has(i)) { if (mapDeepDiff(a.A, I1, b.A, I2) || mapDeepDiff(a.C, I1, b.C, I2)) return { ok: false, why: "checkpoint state (deep)" }; }
  }
  if (inc.unitDigests.length !== ref.unitDigests.length) return { ok: false, why: "unit count" };
  for (let i = 0; i < ref.unitDigests.length; i++) if (inc.unitDigests[i] !== ref.unitDigests[i]) return { ok: false, why: "unit output" };
  if (mapDeepDiff(inc.finalA, I1, ref.finalA, I2) || mapDeepDiff(inc.finalC, I1, ref.finalC, I2)) return { ok: false, why: "final state (deep)" };
  return { ok: true };
}

// replay = cold (§7.2): resume from checkpoint k-1 and expand to the next checkpoint; compare with cold's k
export function replayCheck(cold) {
  let checked = 0, bad = 0, firstBad = null, deepChecked = 0;
  const cks = cold.checkpoints, I = cold.intern;
  const deepAt = new Set([1, Math.floor(cks.length / 2), cks.length - 1]);
  for (let k = 1; k < cks.length; k++) {
    const base = cks[k - 1];
    let got = null;
    const m = new Machine({ files: cold.files, main: cold.main, known: cold.opts.known, limits: cold.opts.limits, intern: cold.intern, Tmin: cold.opts.Tmin,
      onCheckpoint: (ck) => { got = ck; throw new Converged({}); } });
    m.restore(base, cold.files, 0);
    try { m.run(); } catch (x) { if (!(x instanceof Converged)) { bad++; firstBad = firstBad ?? "exception"; continue; } }
    checked++;
    const want = cks[k], unit = m.units[0], wu = cold.units[k];
    let ok = got && got.mainPos === want.mainPos && canonReaders(got.readers) === canonReaders(want.readers)
      && got.A.hashEquals(want.A) && got.C.hashEquals(want.C) && canonGroups(got.groups, I) === canonGroups(want.groups, I)
      && ckCounters(got) === ckCounters(want)
      && unit && unitDigest(unit) === unitDigest(wu);
    if (ok && deepAt.has(k)) { deepChecked++; ok = !mapDeepDiff(got.A, I, want.A, I) && !mapDeepDiff(got.C, I, want.C, I); }
    if (!ok) { bad++; firstBad = firstBad ?? "mismatch"; }
  }
  return { checked, bad, firstBad, deepChecked };
}
