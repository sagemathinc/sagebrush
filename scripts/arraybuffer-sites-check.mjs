// The js-arraybuffer gate's checks (plan-d0-2-gate r3): the census
// (scripts/arraybuffer-sites.mjs) against the classifications in
// test/arraybuffer-sites.json and the frozen base census in
// test/arraybuffer-sites.base.json.
//
//   node scripts/arraybuffer-sites-check.mjs [--check] [--update] [--report] [--seeds]
//
// --check (the default) prints the problems and exits 1 if there are any.
// --update rewrites only the table's derived section (the per-declaration
// entries, section 5), never a reviewed entry.
// --report counts the records by kind and class; --seeds prints the hashes
// of the reviewed seed sections and of the derived section, and the edges.
//
// What is classified where:
//   lib     every lib member a call or read reaches, by its key ("lib:… :: Iface.member");
//           its class is reviewed, or "per-site" (each record needs a site entry);
//   sites   reviewed entries for single records (code sinks always), keyed by the
//           record's key, bound to its declaration's fingerprint;
//   derived the per-declaration entries: whether calling a scanned declaration may
//           make a new backing store (section 5), computed from the reference
//           graph and the reviewed lib and site classes, committed, and checked.
// A delegating record is classified by itself (section 3.2): its target is dynamic,
// and it says so; it is never no-new-store.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { census, censusText, ROOT } from "./arraybuffer-sites.mjs";

export const TABLE = "test/arraybuffer-sites.json";
export const BASE = "test/arraybuffer-sites.base.json";
const sha = (s) => createHash("sha256").update(s).digest("hex");

// the classes (section 2), and where each may stand
export const CLASSES = {
  allocates: "creates a new ArrayBuffer or SharedArrayBuffer backing store, or copies into one",
  view: "a new ArrayBufferView or DataView over an existing backing store; no new backing store",
  "no-new-store": "no new ArrayBuffer/SharedArrayBuffer/ArrayBufferView backing-store allocation or copy (body-local: excluding any dynamic target it invokes)",
  reserved: "an inbound transfer or clone: r5 1.5's reservation route",
  "wasm-domain": "a WebAssembly.Memory store: the wasm-engine's or wasm-instance's domain, not js-arraybuffer's",
  "not-a-store": "the type mentions a store but the value is never one",
  test: "test-only code",
  "unproved-generated": "a code sink: it can run code whose allocations the census doesn't see (blocks domains until D0-2g)",
  "per-site": "(lib only) each call or read needs its own site entry",
};
const RETURNS = new Set(["existing-store-possible", "no-store"]);
// the edges the derivation follows (scripts/arraybuffer-sites.mjs builds them):
// a reviewer can check the derived section from the seeds and these
export const EDGE_KINDS = [
  "a call or new whose target resolves to a scanned declaration (through const and destructuring bindings, overload implementations)",
  "a reference to a scanned function or class as a value (passed, stored, returned)",
  "a class to its constructor and to its base class (a lib base: that lib member)",
  "a class's field initializers (their sites belong to the class)",
  "a method to every same-named member of its subclasses (overrides; an abstract member to its implementations)",
  "a getter or setter, by the reference its property access resolves to",
  "implicit invocations (iteration, coercion, await, JSON) to iterator, toString, valueOf, then and toJSON members, if any of those may allocate",
];
const canon = (o) => JSON.stringify(Object.fromEntries(Object.entries(o ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : 1))));
export const seeds = (t) => ({ lib: sha(canon(t.lib)), sites: sha(canon(t.sites)), lib_entries: Object.keys(t.lib ?? {}).length, site_entries: Object.keys(t.sites ?? {}).length, derived: sha(canon(t.derived)), derived_entries: Object.keys(t.derived ?? {}).length });

// the names a scanned declaration can have that implicit invocations reach
// (iteration, coercion, awaiting, JSON): section 5's over-approximation
const IMPLICIT_NAME = /(^|\.)(\[Symbol\.(iterator|asyncIterator|toPrimitive)\]|next|return|throw|toString|valueOf|then|toJSON)$/;

export function readTable(root = ROOT) {
  return JSON.parse(readFileSync(join(root, TABLE), "utf8"));
}

// section 5: may calling this declaration make a new store?  The least fixpoint
// over the reference graph: a declaration may allocate if a lib member it calls
// or reads is `allocates`, a record in its body has a site entry of class
// `allocates` or `unproved-generated` (a code sink), or a declaration or class
// it references may allocate.  Dynamic targets are excluded (they are
// delegating records of their own).  Implicit invocations: if any scanned
// declaration an implicit invocation can reach may allocate, every declaration
// with implicit-invocation syntax references all of them.
export function derive(c, table) {
  const libClass = (k) => table.lib?.[k]?.class;
  const siteClass = new Map();
  for (const r of c.records) {
    const e = table.sites?.[r.key];
    if (e) siteClass.set(r.key, e.class);
  }
  const why = new Map(); // fp -> a witness: the allocating lib member, site, or declaration
  const byFp = c.decls;
  for (const [fp, d] of byFp) {
    for (const k of d.libs) {
      if (libClass(k) === "allocates" || libClass(k) === "unproved-generated") {
        why.set(fp, k);
        break;
      }
    }
  }
  for (const r of c.records) {
    const k = siteClass.get(r.key);
    if ((k === "allocates" || k === "unproved-generated") && !why.has(r.decl)) why.set(r.decl, r.key);
    if (r.target?.lib && libClass(r.target.lib) === "per-site" && k === "allocates" && !why.has(r.decl)) why.set(r.decl, r.key);
  }
  const rev = new Map(); // fp -> the declarations that reference it
  const addEdge = (from, to) => (rev.get(to) ?? rev.set(to, new Set()).get(to)).add(from);
  for (const [fp, d] of byFp) for (const t of d.refs) addEdge(fp, t);
  const run = () => {
    const work = [...why.keys()];
    while (work.length) {
      const t = work.pop();
      for (const f of rev.get(t) ?? []) {
        if (!why.has(f)) {
          why.set(f, t);
          work.push(f);
        }
      }
    }
  };
  run();
  const implicitTargets = [...byFp.values()].filter((d) => IMPLICIT_NAME.test(d.name)).map((d) => d.fp);
  const implicitAlloc = implicitTargets.filter((fp) => why.has(fp));
  if (implicitAlloc.length) {
    for (const [fp, d] of byFp) if (d.implicit) for (const t of implicitAlloc) addEdge(fp, t);
    for (const [fp, d] of byFp) if (d.implicit && !why.has(fp)) {
      why.set(fp, "implicit:" + implicitAlloc[0]);
    }
    run();
  }
  return { why, implicitTargets, implicitAlloc };
}

// the derived section: one entry per declaration some record calls or constructs
export function derivedEntries(c, d) {
  const out = {};
  const name = (fp) => {
    const x = c.decls.get(fp);
    return x ? `${x.file} :: ${x.name}` : fp;
  };
  for (const r of c.records) {
    const fp = r.target?.fp;
    if (!fp || out[fp]) continue;
    const w = d.why.get(fp);
    out[fp] = { decl: `${r.target.decl} :: ${r.target.name}`, class: w ? "allocates" : "no-new-store", ...(w ? { via: c.decls.has(w) ? name(w) : w } : {}) };
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => (a[1].decl < b[1].decl ? -1 : a[1].decl > b[1].decl ? 1 : a[0] < b[0] ? -1 : 1)));
}

// each record's class: {class, returns?, by} or {problem}
export function classify(c, table, derived) {
  const out = new Map();
  const problems = [];
  const usedLib = new Set();
  const usedSites = new Set();
  for (const r of c.records) {
    const site = table.sites?.[r.key];
    if (site) {
      usedSites.add(r.key);
      // a code sink's entry is bound to its local producer fingerprint, any other to its declaration's
      const bound = r.kind === "code-sink" ? r.producer : r.decl;
      if ((r.kind === "code-sink" ? site.producer : site.decl) !== bound) {
        problems.push({ problem: "stale", what: "site entry", key: r.key, detail: `its ${r.kind === "code-sink" ? "producer" : "declaration"} changed (${site.producer ?? site.decl} -> ${bound})` });
        continue;
      }
      if (!CLASSES[site.class] || site.class === "per-site") problems.push({ problem: "invalid", key: r.key, detail: `class ${site.class}` });
      if (r.kind === "delegating" || r.kind === "code-sink") {
        // a site entry can't make a dynamic call no-new-store (section 3.2), nor make a
        // sink safe without a reviewed reading of constant text (section 7.1)
        if (r.kind === "delegating") problems.push({ problem: "invalid", key: r.key, detail: "a delegating record is classified by itself; a site entry for it is refused" });
        if (r.kind === "code-sink" && site.class !== "unproved-generated" && !(r.origin === "constant" && site.class === "no-new-store" && site.text_reviewed)) {
          problems.push({ problem: "invalid", key: r.key, detail: "a code sink is unproved-generated unless its constant text has a reviewed no-new-store reason" });
        }
      }
      if (!site.reason) problems.push({ problem: "invalid", key: r.key, detail: "a site entry needs a reason" });
      out.set(r.key, { class: site.class, returns: site.returns, by: "site" });
      if (r.target?.lib) usedLib.add(r.target.lib);
      continue;
    }
    if (r.kind === "delegating") {
      out.set(r.key, { class: "delegating", by: "self" });
      continue;
    }
    if (r.kind === "code-sink") {
      problems.push({ problem: "unclassified", key: r.key, detail: "a code sink needs a site entry" });
      continue;
    }
    if (r.target?.lib) {
      usedLib.add(r.target.lib);
      const e = table.lib?.[r.target.lib];
      if (!e) problems.push({ problem: "unclassified", key: r.key, detail: `lib member ${r.target.lib}` });
      else if (e.class === "per-site") problems.push({ problem: "unclassified", key: r.key, detail: `lib member ${r.target.lib} is per-site: this record needs a site entry` });
      else out.set(r.key, { class: e.class, returns: e.returns, by: "lib" });
      continue;
    }
    if (r.target?.fp) {
      const e = derived[r.target.fp];
      out.set(r.key, { class: e?.class ?? "?", returns: "existing-store-possible", by: "declaration" });
      continue;
    }
    problems.push({ problem: "unclassified", key: r.key, detail: "no target" });
  }
  // every lib member reached (a call or read anywhere, record or not) is classified
  for (const k of c.libs.keys()) {
    usedLib.add(k);
    const e = table.lib?.[k];
    if (!e) problems.push({ problem: "unclassified", what: "lib member", key: k, detail: JSON.stringify(c.libs.get(k)) });
    else {
      if (!CLASSES[e.class]) problems.push({ problem: "invalid", key: k, detail: `class ${e.class}` });
      if (!e.reason) problems.push({ problem: "invalid", key: k, detail: "a lib entry needs a reason" });
      if (e.returns && !RETURNS.has(e.returns)) problems.push({ problem: "invalid", key: k, detail: `returns ${e.returns}` });
      // a per-site member at a call that isn't a record has no record to classify
      if (e.class === "per-site" && (c.libs.get(k).kinds.clean ?? 0) > 0) problems.push({ problem: "invalid", key: k, detail: "per-site, but some of its calls are clean (not records)" });
    }
  }
  for (const k of Object.keys(table.lib ?? {})) if (!usedLib.has(k)) problems.push({ problem: "stale", what: "lib entry", key: k, detail: "no call or read reaches it" });
  for (const k of Object.keys(table.sites ?? {})) if (!usedSites.has(k)) problems.push({ problem: "stale", what: "site entry", key: k, detail: "no record has this key" });
  return { classes: out, problems };
}

// section 4: pyparse's closure.  Every declaration pyparse/src references is
// in pyparse/src or a lib member (rules 1 and 2: the closure is closed; a
// reference outside fails the rule).  A dynamic edge (rule 2) fails the rule
// for its own site: that site is a delegating or code-sink record, classified
// by itself, never by the group (returned as `excluded`).  Typed store sites
// stay classified one by one (rule 3), like any record.
export function pyparseRule(c) {
  const problems = [];
  const excluded = [];
  const inP = (f) => f.startsWith("pyparse/src/");
  for (const r of c.records) {
    if (!inP(r.file)) continue;
    if (r.kind === "delegating" || r.kind === "code-sink") excluded.push(r.key);
  }
  for (const d of c.decls.values()) {
    if (!inP(d.file)) continue;
    for (const t of d.refs) {
      const x = c.decls.get(t);
      if (x && !inP(x.file)) problems.push({ problem: "pyparse", key: `${d.file} :: ${d.name}`, detail: `references ${x.file} :: ${x.name}, outside pyparse/src` });
    }
  }
  return { problems, excluded };
}

// section 1: the base census against the current one, through the deltas and
// lifecycle entries.  Every base record still present with its kind needs
// nothing; any other base record needs exactly one entry, and every entry must
// match.  current.allSites knows the kind of every site, clean ones too.
const textOf = (key) => key.split(" :: ").slice(2).join(" :: ").replace(/ #\d+$/, "");
const fileOf = (key) => key.split(" :: ")[0];
export function compareBase(base, cur, deltas) {
  const problems = [];
  const bmap = new Map(base.records.map((r) => [r.key, r]));
  const cmap = new Map(cur.records.map((r) => [r.key, r]));
  const byKey = new Map();
  for (const e of deltas ?? []) {
    if (byKey.has(e.key)) problems.push({ problem: "delta", key: e.key, detail: "more than one entry" });
    byKey.set(e.key, e);
  }
  const curFps = new Set(cur.decls.keys());
  for (const [k, b] of bmap) {
    const e = byKey.get(k);
    const now = cur.allSites.get(k);
    if (!e) {
      if (now === undefined) problems.push({ problem: "disappeared", key: k, detail: "a base record is gone with no delta or lifecycle entry" });
      else if (now !== b.kind) problems.push({ problem: "changed", key: k, detail: `${b.kind} -> ${now} with no delta` });
      continue;
    }
    if (e.before !== b.kind) problems.push({ problem: "delta", key: k, detail: `before is ${e.before}, the base says ${b.kind}` });
    if (e.after === "absent") {
      if (now !== undefined) problems.push({ problem: "delta", key: k, detail: "absent, but the site is still there" });
      if (curFps.has(b.decl)) problems.push({ problem: "delta", key: k, detail: "absent, but its declaration is unchanged" });
      const cands = cur.records.filter((r) => !bmap.has(r.key) && (textOf(r.key) === textOf(k) || (b.target?.name && r.target?.name === b.target.name && fileOf(r.key) === fileOf(k))));
      const named = e.replacement === "none" ? [] : e.replacement ?? [];
      if (e.replacement === "none" && cands.length) problems.push({ problem: "delta", key: k, detail: `replacement none, but ${cands[0].key} looks like one` });
      for (const n of named) if (!cmap.has(n) || bmap.has(n)) problems.push({ problem: "delta", key: k, detail: `replacement ${n} is not a new record` });
      if (e.replacement === undefined) problems.push({ problem: "delta", key: k, detail: "absent needs replacement: none or [keys]" });
    } else if (e.after === "moved") {
      const to = cmap.get(e.to);
      if (curFps.has(b.decl)) problems.push({ problem: "delta", key: k, detail: "moved, but its declaration is unchanged" });
      if (now !== undefined) problems.push({ problem: "delta", key: k, detail: "moved, but the old key is still a site" });
      if (!to || bmap.has(e.to)) problems.push({ problem: "delta", key: k, detail: `moved to ${e.to}, not a new record` });
      else {
        if (textOf(e.to) !== textOf(k)) problems.push({ problem: "delta", key: k, detail: "moved to a key with different text" });
        if (to.kind !== b.kind) problems.push({ problem: "delta", key: k, detail: `moved, but the kind changed (${b.kind} -> ${to.kind})` });
      }
    } else {
      if (now !== e.after) problems.push({ problem: "delta", key: k, detail: `after is ${e.after}, the site is now ${now ?? "gone"}` });
      if (b.kind === "store" && e.after === "clean") problems.push({ problem: "delta", key: k, detail: "a store record is never a delta to clean" });
      if (!e.annotation || !e.decl) problems.push({ problem: "delta", key: k, detail: "a delta names the declaration annotated and the annotation text" });
    }
  }
  for (const k of byKey.keys()) if (!bmap.has(k)) problems.push({ problem: "delta", key: k, detail: "an entry for a key the base doesn't have" });
  return problems;
}

// section 1.6: a renewal.  T is the old base transformed by its entries; N is
// computed, never authored: current(B') minus T.  The fold holds when T's keys
// are all current with their kinds, and T ∪ N is the whole current census;
// the precondition is a clean gate at B' (no stale or unclassified entry).
export function renewal(oldBase, deltas, cur, problemsAtB) {
  const problems = [];
  if (problemsAtB.length) problems.push({ problem: "renewal", detail: `the gate at B' has ${problemsAtB.length} problems; renew only over a clean gate` });
  const T = new Map(oldBase.records.map((r) => [r.key, r.kind]));
  for (const e of deltas ?? []) {
    if (!T.has(e.key)) {
      problems.push({ problem: "renewal", key: e.key, detail: "an entry for a key the old base doesn't have" });
      continue;
    }
    if (e.after === "absent" || e.after === "clean") T.delete(e.key);
    else if (e.after === "moved") {
      const k = T.get(e.key);
      T.delete(e.key);
      T.set(e.to, k);
    } else T.set(e.key, e.after);
  }
  const C = new Map(cur.records.map((r) => [r.key, r.kind]));
  for (const [k, kind] of T) {
    if (!C.has(k)) problems.push({ problem: "renewal", key: k, detail: "in the transformed base, not in the census at B'" });
    else if (C.get(k) !== kind) problems.push({ problem: "renewal", key: k, detail: `kind ${kind} in the transformed base, ${C.get(k)} at B'` });
  }
  const N = [...C.keys()].filter((k) => !T.has(k)).sort();
  return { problems, N, T };
}

// the whole gate, for the test and the command line
export function gate(root = ROOT, { table = readTable(root), base = null, cur = census(root) } = {}) {
  const d = derive(cur, table);
  const derived = derivedEntries(cur, d);
  const { classes, problems } = classify(cur, table, derived);
  const want = JSON.stringify(table.derived ?? {});
  if (want !== JSON.stringify(derived)) problems.push({ problem: "stale", what: "derived", detail: "the derived section is out of date: run --update and review the diff" });
  const pp = pyparseRule(cur);
  problems.push(...pp.problems);
  if (base) problems.push(...compareBase(base, cur, table.deltas));
  return { cur, derived, classes, problems, derivation: d, pyparseExcluded: pp.excluded };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const t0 = Date.now();
  const table = readTable();
  const g = gate(ROOT, { table, base: JSON.parse(readFileSync(join(ROOT, BASE), "utf8")) });
  if (process.argv.includes("--update")) {
    table.derived = g.derived;
    writeFileSync(join(ROOT, TABLE), tableText(table));
    console.log(`derived: ${Object.keys(g.derived).length} declarations written`);
  }
  if (process.argv.includes("--seeds")) {
    console.log(JSON.stringify(seeds(table), null, 1));
    for (const e of EDGE_KINDS) console.log("edge:", e);
  }
  if (process.argv.includes("--report")) {
    const by = new Map();
    for (const [k, v] of g.classes) {
      const r = g.cur.records.find((x) => x.key === k);
      const label = `${r.kind}${r.access ? " (read)" : ""} -> ${v.class} by ${v.by}`;
      by.set(label, (by.get(label) ?? 0) + 1);
    }
    console.log(JSON.stringify(Object.fromEntries([...by].sort()), null, 1));
    console.log(`implicit targets ${g.derivation.implicitTargets.length}, allocating ${g.derivation.implicitAlloc.length}`);
  }
  const shown = g.problems.filter((p) => !(process.argv.includes("--update") && p.what === "derived"));
  for (const p of shown.slice(0, 200)) console.log(JSON.stringify(p));
  console.log(`${shown.length} problems; ${g.cur.records.length} records; ${Date.now() - t0} ms`);
  process.exitCode = shown.length ? 1 : 0;
}

// the table as committed: sections in order, one entry per line
export function tableText(t) {
  const sec = (o) => `{\n${Object.entries(o ?? {}).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n")}\n }`;
  return `{"version": 1,\n"lib": ${sec(t.lib)},\n"sites": ${sec(t.sites)},\n"deltas": [\n${(t.deltas ?? []).map((e) => "  " + JSON.stringify(e)).join(",\n")}\n],\n"parity": ${sec(t.parity)},\n"derived": ${sec(t.derived)}\n}\n`;
}
