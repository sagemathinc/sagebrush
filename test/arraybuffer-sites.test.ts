import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The js-arraybuffer gate (plan-d0-2-gate r3; plan-d0-browser-capacity r5
// section 2.1, errata E1 and E1r2): the census of every call, `new` and lib
// read in the browser worker's sources, its classifications, the frozen base
// census, and the controls the plan names, each against a small fixture.
const ROOT = join(__dirname, "..", "..");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const S = require(join(ROOT, "scripts/arraybuffer-sites.mjs"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const G = require(join(ROOT, "scripts/arraybuffer-sites-check.mjs"));

// a fixture project: the repository's compiler options, the given files, and
// the repository's node_modules (for @types/node)
function fixture(files: Record<string, string>): any {
  const dir = mkdtempSync(join(tmpdir(), "ab-sites-"));
  try {
    const opts = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")).compilerOptions;
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: opts, include: ["src/**/*.ts", "pyparse/src/**/*.ts", "web/**/*.ts"] }));
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    for (const [p, text] of Object.entries({ "web/worker.ts": "export {};\n", ...files })) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    return S.census(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const at = (c: any, text: string) => c.records.filter((r: any) => r.key.includes(text));
const one = (c: any, text: string) => {
  const rs = at(c, text);
  assert.equal(rs.length, 1, `one record for ${text}: ${rs.map((r: any) => r.key).join(" | ")}`);
  return rs[0];
};

test("the gate passes on this tree: every record classified, nothing stale, the derived section current, the base matched", () => {
  const base = JSON.parse(readFileSync(join(ROOT, G.BASE), "utf8"));
  const g = G.gate(ROOT, { base });
  assert.deepEqual(g.problems.slice(0, 20), []);
  // r5 5b: the inventory's counts, per class
  const by: Record<string, number> = {};
  for (const v of g.classes.values()) by[v.class] = (by[v.class] ?? 0) + 1;
  for (const k of ["allocates", "view", "no-new-store", "delegating", "unproved-generated"]) assert.ok(by[k] > 0, k);
  assert.equal(g.classes.size, g.cur.records.length);
});

test("the base census is the census recomputed at its commit, byte for byte", () => {
  const text = readFileSync(join(ROOT, G.BASE), "utf8");
  const base = JSON.parse(text);
  const B: string = base.header.commit;
  assert.match(B, /^[0-9a-f]{40}$/);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("cat-file", "-e", B + "^{commit}");
  } catch {
    git("fetch", "--quiet", "--depth=1", "origin", B);
  }
  const dir = mkdtempSync(join(tmpdir(), "ab-base-"));
  try {
    const tar = execFileSync("git", ["archive", B, "tsconfig.json", ...base.header.dirs], { cwd: ROOT, maxBuffer: 1 << 30 });
    execFileSync("tar", ["-x", "-C", dir], { input: tar });
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    const now: string = S.censusText(S.census(dir, { commit: B }));
    if (now !== text) {
      const a = now.split("\n");
      const b = text.split("\n");
      const i = a.findIndex((l, j) => l !== b[j]);
      assert.fail(`the base census drifted at line ${i + 1}: renew it (section 1.6)\n  now:  ${a[i]?.slice(0, 300)}\n  base: ${b[i]?.slice(0, 300)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E1r2.1: an any or unknown anywhere in the type graph is flagged, not only at the top", () => {
  const c = fixture({
    "src/runtime/v.ts": `
declare const anyv: any;
function factory(): Promise<{ items: { data: any }[] }> { return null as any; }
export function vectors() {
  const x: { data: any } = { data: anyv };
  const y: { data: unknown } = { data: 1 };
  structuredClone(x);
  structuredClone(y);
  factory();
  new Map();
  return [x, y];
}
`,
  });
  assert.equal(one(c, "structuredClone ( x )").kind, "opaque");
  assert.equal(one(c, "structuredClone ( y )").kind, "opaque");
  assert.equal(one(c, "factory ( )").kind, "opaque");
  assert.equal(one(c, "new Map ( )").kind, "opaque");
});

test("the walk gap tsc 7's parity found: index signatures and type parameters are walked, not passed", () => {
  const c = fixture({
    "src/runtime/g.ts": `
function rec(): Record<string, Uint8Array> { return {}; }
function idx(): { [k: string]: any } { return {}; }
function num(): { [i: number]: ArrayBuffer } { return {}; }
function plain(): Record<string, number> { return {}; }
function id<T>(x: T): T { return x; }
function bounded<T extends { n: number }>(x: T): T { return x; }
export function f<U>(u: U) {
  rec();
  idx();
  num();
  plain();
  id(u);
  bounded({ n: 1 });
  return u;
}
export function g<T>(x: T): T { return id(x); }
`,
  });
  assert.equal(one(c, "rec ( )").kind, "store", "a Record of stores");
  assert.equal(one(c, "idx ( )").kind, "opaque", "an index signature of any");
  assert.equal(one(c, "num ( )").kind, "store", "a numeric index signature");
  assert.equal(at(c, "plain ( )").length, 0, "a Record of numbers is clean");
  assert.equal(one(c, "id ( u )").kind, "opaque", "an unconstrained type parameter could be anything");
  assert.equal(at(c, "bounded ( {").length, 0, "an instantiated call is its instantiation");
  assert.equal(one(c, "g :: id ( x )").kind, "opaque", "a generic body's own type parameter");
});

test("r5 5a: a depth-4 store, a recursive type holding one, a top-level any; an overflowing graph is unresolved", () => {
  const c = fixture({
    "src/runtime/d.ts": `
type T = { next: T; buf?: ArrayBuffer };
function deep(): Promise<{ a: { b: { c: { data: Uint8Array } } } }> { return null as any; }
function rec(): T { return null as any; }
function top(): any { return 1; }
function clean(): { a: number; b: string[] } { return { a: 1, b: [] }; }
export function f() {
  deep();
  rec();
  top();
  clean();
}
`,
  });
  assert.equal(one(c, "deep ( )").kind, "store");
  assert.equal(one(c, "rec ( )").kind, "store");
  assert.equal(one(c, "top ( )").kind, "opaque");
  assert.equal(at(c, "clean ( )").length, 0, "a clean call through a static target is not a record");
  // the visit budget fails closed: a graph larger than the budget is unresolved, not passed
  const k = S.kindOf(null, { flags: S.ts.TypeFlags.Object, objectFlags: 0 }, undefined, 0);
  assert.equal(k.kind, "unresolved");
  assert.equal(S.kindOf(null, undefined, undefined).kind, "unresolved", "a type the checker can't resolve");
});

test("section 7.4: code sinks by resolved capability, aliases included; same-name non-sinks are not sinks", () => {
  const c = fixture({
    "src/runtime/alias.ts": `export const G = Function;\n`,
    "src/runtime/s.ts": `
import * as vm from "vm";
import { G } from "./alias";
const { runInThisContext: rtc } = vm;
export function controls(t: string) {
  const F = Function;
  new F("return 1");
  (globalThis as any)["Fun" + "ction"]("return 1")();
  (0, eval)(t);
  rtc(t);
  Reflect.construct(Function, [t]);
  Function.prototype.constructor(t)();
  new G(t);
  Function.call(null, t);
}
export function nonSinks() {
  const o = { eval(x: string) { return x.length; }, Function: (x: string) => x.length };
  o.eval("x");
  o.Function("x");
  return Function.prototype.toString.call(nonSinks).length;
}
`,
  });
  const sinks = c.records.filter((r: any) => r.kind === "code-sink");
  const has = (text: string) => assert.ok(sinks.some((r: any) => r.key.includes(text)), `a sink at ${text}: ${sinks.map((r: any) => r.key).join(" | ")}`);
  has("value Function #0"); // const F = Function, and the re-export's source
  has("new F ( \"return 1\" )");
  has("( globalThis as any ) [ \"Fun\" + \"ction\" ] ( \"return 1\" ) #0"); // an unresolved callee whose result is called
  has("( 0 , eval ) ( t )");
  has("controls :: value eval #0"); // eval as a value, inside the comma
  has("rtc ( t )");
  // the capability as a value: the alias (const F = Function), the argument (Reflect.construct(Function, ...)),
  // the receiver of call (Function.call(...))
  assert.equal(sinks.filter((r: any) => r.key.startsWith("src/runtime/s.ts :: controls :: value Function #")).length, 3);
  has("Function . prototype . constructor ( t )"); // a Function-typed callee
  has("new G ( t )");
  assert.ok(sinks.some((r: any) => r.file === "src/runtime/alias.ts"), "the alias's own definition");
  for (const t of ["o . eval ( \"x\" )", "o . Function ( \"x\" )", "toString . call ( nonSinks )"]) assert.ok(!sinks.some((r: any) => r.key.includes(t)), `not a sink: ${t}`);
});

test("section 7.2: an unresolved call outside sink position is still a delegating record, never safe", () => {
  const c = fixture({ "src/runtime/u.ts": `declare const h: any;\nexport function f() { return h.run(1); }\n` });
  const r = one(c, "h . run ( 1 )");
  assert.equal(r.kind, "delegating");
  const table = { lib: {}, sites: { [r.key]: { decl: r.decl, class: "no-new-store", reason: "claimed" } }, deltas: [], derived: {} };
  const { problems } = G.classify(c, table, {});
  assert.ok(problems.some((p: any) => p.key === r.key && /delegating record is classified by itself/.test(p.detail)));
});

test("section 7.1: constant text is only eligible for a reviewed reason; without one a constant sink stays unclassified", () => {
  const c = fixture({ "src/runtime/k.ts": `export function f() { return new Function("return new Uint8Array(4)"); }\n` });
  const r = c.records.find((x: any) => x.kind === "code-sink" && x.capability === "Function");
  assert.equal(r.origin, "constant");
  const libs = Object.fromEntries([...c.libs.keys()].map((k) => [k, { class: "no-new-store", reason: "fixture" }]));
  const bare = G.classify(c, { lib: libs, sites: {}, deltas: [], derived: {} }, {});
  assert.ok(bare.problems.some((p: any) => p.key === r.key && p.problem === "unclassified"));
  const unreviewed = G.classify(c, { lib: libs, sites: { [r.key]: { producer: r.producer, class: "no-new-store", reason: "constant" } }, deltas: [], derived: {} }, {});
  assert.ok(unreviewed.problems.some((p: any) => p.key === r.key && /reviewed no-new-store reason/.test(p.detail)));
  const reviewed = G.classify(c, { lib: libs, sites: { [r.key]: { producer: r.producer, class: "unproved-generated", reason: "its text allocates" } }, deltas: [], derived: {} }, {});
  assert.deepEqual(reviewed.problems.filter((p: any) => p.key === r.key), []);
});

test("section 3.1: a same-file producer change stales a sink; every non-constant sink is local-incomplete and unproved", () => {
  const src = (expr: string) => `const TABLE: Record<string, string> = { add: "${expr}" };\nexport function k(op: string) { const e = TABLE[op]; return new Function("a", "b", "return " + e); }\n`;
  const a = fixture({ "src/runtime/t.ts": src("a + b") });
  const b = fixture({ "src/runtime/t.ts": src("new Uint8Array(a)") });
  const ra = a.records.find((r: any) => r.kind === "code-sink" && r.capability === "Function");
  const rb = b.records.find((r: any) => r.kind === "code-sink" && r.capability === "Function");
  assert.equal(ra.key, rb.key, "the sink itself is unchanged");
  assert.equal(ra.decl, rb.decl, "and so is its enclosing declaration");
  assert.notEqual(ra.producer, rb.producer, "the table's change stales its producer fingerprint");
  assert.equal(ra.fingerprint, "local-incomplete");
  // over this tree: every non-constant sink says so, and is unproved-generated
  const table = G.readTable(ROOT);
  const cur = S.census(ROOT);
  for (const r of cur.records.filter((x: any) => x.kind === "code-sink" && x.origin !== "constant")) {
    assert.equal(r.fingerprint, "local-incomplete", r.key);
    assert.equal(table.sites[r.key]?.class, "unproved-generated", r.key);
  }
});

// section 1: synthetic censuses for the delta and lifecycle rules
const rec = (key: string, kind: string, decl = "d1", extra: any = {}) => ({ key, kind, decl, ...extra });
const cen = (records: any[], clean: string[] = [], decls: string[] = []) => ({
  records,
  allSites: new Map([...records.map((r) => [r.key, r.kind] as [string, string]), ...clean.map((k) => [k, "clean"] as [string, string])]),
  decls: new Map(decls.map((d) => [d, {}])),
});
const K = (file: string, decl: string, text: string, n = 0) => `${file} :: ${decl} :: ${text} #${n}`;

test("section 1: a silent disappearance, an unrecorded change, a wrong delta and a store made clean all fail", () => {
  const a = K("src/runtime/a.ts", "f", "g ( )");
  const s = K("src/runtime/a.ts", "f", "new Uint8Array ( 4 )");
  const base = { records: [rec(a, "opaque"), rec(s, "store")] };
  const ok = G.compareBase(base, cen([rec(a, "opaque"), rec(s, "store")], [], ["d1"]), []);
  assert.deepEqual(ok, []);
  assert.ok(G.compareBase(base, cen([rec(s, "store")], [], ["d2"]), []).some((p: any) => p.problem === "disappeared"));
  assert.ok(G.compareBase(base, cen([rec(s, "store")], [a], ["d1"]), []).some((p: any) => p.problem === "changed"));
  const ann = { key: a, before: "opaque", after: "clean", decl: "src/runtime/a.ts :: g", annotation: "(): number" };
  assert.deepEqual(G.compareBase(base, cen([rec(s, "store")], [a], ["d1"]), [ann]), []);
  assert.ok(G.compareBase(base, cen([rec(s, "store")], [a], ["d1"]), [{ ...ann, before: "store" }]).some((p: any) => p.problem === "delta"));
  assert.ok(G.compareBase(base, cen([rec(a, "opaque"), rec(s, "store")], [], ["d1"]), [ann]).some((p: any) => /after is clean/.test(p.detail)));
  assert.ok(G.compareBase(base, cen([rec(a, "opaque")], [s], ["d1"]), [{ key: s, before: "store", after: "clean", decl: "x", annotation: "y" }]).some((p: any) => /never a delta to clean/.test(p.detail)));
  assert.ok(G.compareBase(base, cen([rec(a, "opaque"), rec(s, "store")], [], ["d1"]), [{ key: "nope", before: "opaque", after: "clean", decl: "x", annotation: "y" }]).some((p: any) => /key the base doesn't have/.test(p.detail)));
});

test("section 1.5: absent and moved are reviewed states; their four mutants fail", () => {
  const a = K("src/runtime/a.ts", "f", "g ( )");
  const base = { records: [rec(a, "opaque", "old")] };
  // a deletion with no entry
  assert.ok(G.compareBase(base, cen([], [], ["new"]), []).some((p: any) => p.problem === "disappeared"));
  // absent while its declaration is unchanged
  assert.ok(G.compareBase(base, cen([], [], ["old"]), [{ key: a, before: "opaque", after: "absent", replacement: "none" }]).some((p: any) => /declaration is unchanged/.test(p.detail)));
  // absent with replacement none while a same-text site is new
  const b = K("src/runtime/a.ts", "f2", "g ( )");
  assert.ok(G.compareBase(base, cen([rec(b, "opaque", "new")], [], ["new"]), [{ key: a, before: "opaque", after: "absent", replacement: "none" }]).some((p: any) => /looks like one/.test(p.detail)));
  assert.deepEqual(G.compareBase(base, cen([rec(b, "opaque", "new")], [], ["new"]), [{ key: a, before: "opaque", after: "absent", replacement: [b] }]), []);
  assert.deepEqual(G.compareBase(base, cen([], [], ["new"]), [{ key: a, before: "opaque", after: "absent", replacement: "none" }]), []);
  // moved to a key with other text, or another kind
  assert.deepEqual(G.compareBase(base, cen([rec(b, "opaque", "new")], [], ["new"]), [{ key: a, before: "opaque", after: "moved", to: b }]), []);
  const c2 = K("src/runtime/a.ts", "f2", "h ( )");
  assert.ok(G.compareBase(base, cen([rec(c2, "opaque", "new")], [], ["new"]), [{ key: a, before: "opaque", after: "moved", to: c2 }]).some((p: any) => /different text/.test(p.detail)));
  assert.ok(G.compareBase(base, cen([rec(b, "store", "new")], [], ["new"]), [{ key: a, before: "opaque", after: "moved", to: b }]).some((p: any) => /kind changed/.test(p.detail)));
});

test("section 1.6: renewal is a checked fold with N computed; its seven mutants fail", () => {
  const a = K("f.ts", "f", "a ( )");
  const b = K("f.ts", "f", "b ( )");
  const m = K("f.ts", "f2", "b ( )");
  const n = K("f.ts", "f", "n ( )");
  const u = K("f.ts", "f", "u ( )");
  const old = { records: [rec(a, "opaque"), rec(b, "opaque"), rec(u, "delegating")] };
  const entries = [{ key: b, before: "opaque", after: "moved", to: m }];
  const cur = { records: [rec(a, "opaque"), rec(m, "opaque"), rec(n, "store"), rec(u, "delegating")] };
  const good = G.renewal(old, entries, cur, []);
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.N, [n], "N is current minus the transformed base, computed");
  // 1: dropping an entry
  assert.ok(G.renewal(old, [], cur, []).problems.length > 0);
  // 2: a record added that isn't in N: an authored base with an extra key
  assert.ok(G.renewal({ records: [...old.records, rec(K("f.ts", "f", "x ( )"), "opaque")] }, entries, cur, []).problems.length > 0);
  // 3: N lacking a record of current(B'): the base claims n with another kind
  assert.ok(G.renewal({ records: [...old.records, rec(n, "opaque")] }, entries, cur, []).problems.length > 0);
  // 4: an N record with no current reviewed classification: the gate at B' has a problem
  assert.ok(G.renewal(old, entries, cur, [{ problem: "unclassified", key: n }]).problems.length > 0);
  // 5: a kind changed
  assert.ok(G.renewal(old, entries, { records: [rec(a, "store"), rec(m, "opaque"), rec(n, "store"), rec(u, "delegating")] }, []).problems.length > 0);
  // 6: over a stale classification
  assert.ok(G.renewal(old, entries, cur, [{ problem: "stale", key: a }]).problems.length > 0);
  // 7: discharging an unproved record (the delegating record gone from B')
  assert.ok(G.renewal(old, entries, { records: [rec(a, "opaque"), rec(m, "opaque"), rec(n, "store")] }, []).problems.length > 0);
});

test("section 4: pyparse's closure stays in pyparse/src; a dynamic edge leaves the group for its own record", () => {
  const c = fixture({
    "src/runtime/r.ts": `export function helper(): any { return 1; }\n`,
    "pyparse/src/p.ts": `import { helper } from "../../src/runtime/r";\ndeclare const dyn: any;\nexport function parse() { dyn.go(); return helper(); }\n`,
    "web/worker.ts": `import { parse } from "../pyparse/src/p";\nexport const w = parse;\n`,
  });
  const pp = G.pyparseRule(c);
  assert.ok(pp.problems.some((p: any) => /outside pyparse\/src/.test(p.detail)), "an external reference fails the rule");
  assert.ok(pp.excluded.some((k: string) => k.includes("dyn . go ( )")), "a dynamic edge is its own record");
  assert.equal(one(c, "dyn . go ( )").kind, "delegating");
});

test("section 5: the derivation follows calls, values, classes, overrides and abstract members; a changed body stales its entry", () => {
  const files = (alloc: string) => ({
    "src/runtime/x.ts": `
export function mk(): any { return ${alloc}; }
export function viaCall(): any { return mk(); }
export function viaValue(): any { return [1].map(mk); }
export function pure(): any { return 1; }
export function callsPure(): any { return pure(); }
export abstract class Base { abstract run(): any; go(): any { return this.run(); } plain(): any { return 0; } }
export class Sub extends Base { run(): any { return mk(); } plain(): any { return mk(); } }
export function viaOverride(b: Base): any { return b.plain(); }
export function viaAbstract(b: Base): any { return b.run(); }
export class Holder { buf = new Uint8Array(8); }
export function viaClass(): any { return new Holder(); }
export class Lazy { get v(): any { return mk(); } }
export class Made { b: any; constructor() { this.b = new Uint8Array(2); } }
export class MadeToo extends Made {}
export function viaCtor(): any { return new Made(); }
export function viaBase(): any { return new MadeToo(); }
export function typeOnly(m: Made, l: Lazy, s: Sub): any { return [m, l, s].length; }
export function viaGetter(l: Lazy): any { return l.v; }
`,
  });
  const c = fixture(files("new Uint8Array(4)"));
  const libs = Object.fromEntries([...c.libs.keys()].map((k) => [k, { class: /Uint8ArrayConstructor\.new/.test(k) ? "allocates" : "no-new-store", reason: "fixture" }]));
  const table = { lib: libs, sites: {}, deltas: [], derived: {} };
  const d = G.derive(c, table);
  const derived = G.derivedEntries(c, d);
  const cls = (text: string) => G.classify(c, table, derived).classes.get(one(c, text).key).class;
  assert.equal(cls("viaCall :: mk ( )"), "allocates", "a record calling an allocating declaration");
  const call = (name: string) => [...c.decls.values()].find((x: any) => x.name === name);
  assert.ok(d.why.has(call("viaCall").fp), "a call");
  assert.ok(d.why.has(call("viaValue").fp), "a function passed as a value");
  assert.ok(!d.why.has(call("callsPure").fp), "a pure callee");
  assert.ok(d.why.has(call("viaOverride").fp), "an override in a subclass");
  assert.ok(d.why.has(call("viaAbstract").fp), "an abstract member's implementation");
  const abs = one(c, "viaAbstract :: b . run ( )");
  assert.ok(abs.target.fp && abs.kind === "opaque", "a call of an abstract member has a static target, not a dynamic one");
  assert.equal(cls("viaAbstract :: b . run ( )"), "allocates");
  assert.ok(d.why.has(call("viaClass").fp), "a class's field initializer");
  assert.ok(d.why.has(call("viaGetter").fp), "a getter, by its property access");
  assert.ok(d.why.has(call("viaCtor").fp), "a constructor");
  assert.ok(d.why.has(call("viaBase").fp), "a base class's constructor");
  assert.ok(!d.why.has(call("typeOnly").fp), "a type annotation runs no code: no edge");
  assert.equal(cls("pure ( )"), "no-new-store");
  // a changed body changes the declaration's fingerprint: a site entry bound to the old one is stale
  const c2 = fixture(files("new Uint8Array(5)"));
  const r1 = one(c, "new Uint8Array ( 4 )");
  const r2 = one(c2, "new Uint8Array ( 5 )");
  assert.notEqual(r1.decl, r2.decl);
  const t2 = { lib: libs, sites: { [r2.key]: { decl: r1.decl, class: "allocates", reason: "old" } }, deltas: [], derived: {} };
  assert.ok(G.classify(c2, t2, {}).problems.some((p: any) => p.problem === "stale" && p.key === r2.key));
});

// the derivation's verdict for named declarations of a fixture: may each make a new store?
function mayAlloc(files: Record<string, string>, names: string[]): Record<string, boolean> {
  const c = fixture(files);
  const libs = Object.fromEntries([...c.libs.keys()].map((k) => [k, { class: /ArrayConstructor\.new|ArrayBufferConstructor/.test(k) && !/^lib:lib\.es5\.d\.ts :: ArrayConstructor/.test(k) ? "allocates" : "no-new-store", reason: "fixture" }]));
  const d = G.derive(c, { lib: libs, sites: {}, deltas: [], derived: {} });
  const out: Record<string, boolean> = {};
  for (const n of names) {
    const x = [...c.decls.values()].find((v: any) => v.name === n);
    assert.ok(x, `declaration ${n}`);
    out[n] = d.why.has(x.fp);
  }
  return out;
}

test("accessors reached by element access, destructuring and untyped receivers are edges (astra2 C1)", () => {
  const r = mayAlloc({
    "src/runtime/acc.ts": `
export class Maker {
  x: any = null;
  get bytes(): any { return new Uint8Array(8); }
  set sink(v: any) { this.x = new Uint8Array(4); }
  get plain(): number { return 1; }
}
export function getBracket(m: Maker): any { return m["bytes"]; }
export function getIt(m: Maker): any { return getBracket(m); }
export function setBracket(m: Maker): void { m["sink"] = 1; }
export function setDot(m: Maker): void { m.sink = 1; }
export function computed(m: Maker, k: string): any { return (m as any)[k]; }
export function destructure(m: Maker): any { let { bytes } = m; return bytes; }
export function untyped(o: any): any { return o.bytes; }
export function plainOnly(m: Maker): any { return m["plain"]; }
export class B0 { x: any = 0; }
export class B1 extends B0 { get x(): any { return new Uint8Array(1); } }
export function viaField(b: B0): any { return b.x; }
export function typedComputed(m: Maker, k: string): any { return m[k as "plain"]; }
export function unrelated(o: { bytes: number }): any { return o.bytes; }
export function assignPat(m: Maker): any { let b; ({ bytes: b } = m); return b; }
export function objSpread(o: any): any { return { ...o }; }
export function oassign(o: any): any { return Object.assign({}, o); }
export function jsonAll(o: any): string { return JSON.stringify(o); }
`,
  }, ["getBracket", "getIt", "setBracket", "setDot", "computed", "destructure", "untyped", "plainOnly", "viaField", "typedComputed", "unrelated", "assignPat", "objSpread", "oassign", "jsonAll"]);
  assert.deepEqual(r, { getBracket: true, getIt: true, setBracket: true, setDot: true, computed: true, destructure: true, untyped: true, plainOnly: false, viaField: true, typedComputed: true, unrelated: false, assignPat: true, objSpread: true, oassign: true, jsonAll: true });
});

test("implicit invocations: JSON, coercions, iteration and awaiting reach the scanned members they run (astra2 C2)", () => {
  const r = mayAlloc({
    "src/runtime/imp.ts": `
export class J { toJSON(): any { return new Uint8Array(2); } }
export class V { valueOf(): number { const b = new Uint8Array(1); return b.length; } }
export class S { toString(): string { return String(new Uint8Array(1).length); } }
export class P { [Symbol.toPrimitive](): number { return new Uint8Array(1).length; } }
export class It { *[Symbol.iterator]() { yield new Uint8Array(1); } }
export class Th { then(f: any) { f(new Uint8Array(1)); } }
export function json(x: any): string { return JSON.stringify(x); }
export function unaryPlus(x: object): number { return +x; }
export function unaryMinus(x: object): number { return -(x as any); }
export function bitNot(x: object): number { return ~(x as any); }
export function bitOr(x: object): number { return (x as any) | 0; }
export function shift(x: object): number { return (x as any) << 1; }
export function rel(x: object, y: object): boolean { return x < y; }
export function plusStr(x: object): string { return "" + x; }
export function tmpl(x: object): string { return \`\${x}\`; }
export function strCall(x: object): string { return String(x); }
export function inc(x: any): any { x++; return x; }
export function key(o: any, x: object): any { return o[x as any]; }
export function forOf(x: any): number { let n = 0; for (const _ of x) n++; return n; }
export function spread(x: any): any[] { return [...x]; }
export function arrDestr(x: any): any { const [a] = x; return a; }
export async function aw(x: any): Promise<any> { return await x; }
export function arrAssign(x: any): any { let a; [a] = x; return a; }
export function inOp(x: object, o: object): boolean { return (x as any) in o; }
export async function awaitOnly(x: any): Promise<number> { const y = await x; return y === 1 ? 1 : 0; }
export function* ystar(x: any) { yield* x; }
export async function asyncRet(x: any): Promise<any> { return x; }
export function arrFrom(x: object): any[] { return Array.from(x as Iterable<any>); }
export function pres(x: object): Promise<any> { return Promise.resolve(x); }
export function numbers(a: number, b: number): number { return +a + (b | 0) + -a; }
export function strings(a: string): string { return \`\${a}\` + a; }
`,
  }, ["json", "unaryPlus", "unaryMinus", "bitNot", "bitOr", "shift", "rel", "plusStr", "tmpl", "strCall", "inc", "key", "forOf", "spread", "arrDestr", "aw", "arrAssign", "inOp", "awaitOnly", "ystar", "asyncRet", "arrFrom", "pres", "numbers", "strings"]);
  const want: Record<string, boolean> = {};
  for (const k of Object.keys(r)) want[k] = !["numbers", "strings"].includes(k);
  assert.deepEqual(r, want);
});

test("JSON.stringify runs toJSON: an edge to every scanned toJSON, apart from coercion (astra2 C2)", () => {
  const r = mayAlloc({
    "src/runtime/js.ts": `
export class J { toJSON(): any { return new Uint8Array(2); } }
export class V { valueOf(): number { return 1; } }
export function json(x: object): string { return JSON.stringify(x); }
export function plain(x: object): string { return String(x); }
`,
  }, ["json", "plain"]);
  assert.deepEqual(r, { json: true, plain: false });
});

test("for await awaits each value: an edge to every scanned then, apart from iteration (astra2 C2)", () => {
  const r = mayAlloc({
    "src/runtime/fa.ts": `
export class Th { then(f: any) { f(new Uint8Array(1)); } }
export class It { *[Symbol.iterator]() { yield 1; } }
export async function forAwait(x: any): Promise<number> { let n = 0; for await (const _ of x) n++; return n; }
export function forPlain(x: any): number { let n = 0; for (const _ of x) n++; return n; }
`,
  }, ["forAwait", "forPlain"]);
  assert.deepEqual(r, { forAwait: true, forPlain: false });
});

test("E1.1: typescript-api is named only by the gate's script and its test; it has no install scripts", () => {
  const out = execFileSync("git", ["grep", "-l", "typescript-api", "--", ":!pnpm-lock.yaml", ":!package.json"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(out, ["scripts/arraybuffer-sites.mjs", "test/arraybuffer-sites.test.ts"]);
  const pkg = JSON.parse(readFileSync(join(ROOT, "node_modules/typescript-api/package.json"), "utf8"));
  assert.equal(pkg.version, "5.9.3");
  for (const k of ["preinstall", "install", "postinstall", "prepare"]) assert.equal(pkg.scripts?.[k], undefined, k);
  const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
  assert.match(lock, /typescript@5\.9\.3:\n {4}resolution: \{integrity: sha512-jl1vZzPDinLr9eUt3J\/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==\}/);
  assert.doesNotMatch(lock.slice(lock.indexOf("  typescript@5.9.3:")).split("\n\n")[0], /requiresBuild/);
});
