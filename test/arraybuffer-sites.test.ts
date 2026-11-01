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
      if (text.startsWith("\0symlink:")) symlinkSync(text.slice(9), join(dir, p));
      else writeFileSync(join(dir, p), text);
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

// (train-16, r9, r10) the tracked tree only: each kind of reference into build/, built and not
const GEN = "scripts/build-cli.mjs";
const LM = "build/cli/lib-meta.gen.js";
const GEN_INPUTS: { path: string; text: string }[] = ["scripts/build-cli.mjs", "scripts/build-id.mjs", "scripts/packages.mjs"].map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") }));
const GEN_FILES = Object.fromEntries(GEN_INPUTS.map((i) => [i.path, i.text]));
const LIB_META = 'globalThis.__SAGEBRUSH_BUILD_ID__ = "b";\nglobalThis.__SAGEBRUSH_VERSION__ = "v";\nglobalThis.__SAGEBRUSH_NOTICES__ = [];\n';
const FX_OPTS = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")).compilerOptions;
const fxConfig = (extra: object, more: object = {}) => JSON.stringify({ compilerOptions: { ...FX_OPTS, ...extra }, include: ["src/**/*.ts", "pyparse/src/**/*.ts", "web/**/*.ts"], ...more });
const STORE = "export const a = new Uint8Array(3);\n";
const link = (target: string) => `\0symlink:${target}`;
const REFERENCE_CASES: [string, Record<string, string>, Record<string, string>, string[]][] = [
  // [name, tracked files, the build's files, the generated problems' paths]
  ["the reviewed generated module", { "web/worker.ts": 'import "../build/cli/lib-meta.gen.js";\nimport { u } from "./util";\nexport const w = [u, new Uint8Array(2)];\n', "web/util.ts": "export const u = 1;\n", ...GEN_FILES }, { [LM]: LIB_META }, []],
  ["a triple-slash .ts reference", { "web/worker.ts": '/// <reference path="../build/hidden.ts" />\nexport const w = 1;\n' }, { "build/hidden.ts": "const hiddenStore = new Uint8Array(1);\n" }, ["build/hidden.ts"]],
  ["a triple-slash .d.ts reference (it would change the checker)", { "web/worker.ts": '/// <reference path="../build/types.d.ts" />\nexport const m = mk();\n' }, { "build/types.d.ts": "declare function mk(): ArrayBuffer;\n" }, ["build/types.d.ts"]],
  ["a tracked declaration file's reference", { "web/worker.ts": '/// <reference path="./types.d.ts" />\nexport const m = mk2();\n', "web/types.d.ts": '/// <reference path="../build/t2.d.ts" />\n' }, { "build/t2.d.ts": "declare function mk2(): ArrayBuffer;\n" }, ["build/t2.d.ts"]],
  ["a relative types reference", { "web/worker.ts": '/// <reference types="../build/tref" />\nexport const t = tr();\n' }, { "build/tref/index.d.ts": "declare function tr(): ArrayBuffer;\n" }, ["build/tref"]],
  ["a tsconfig path alias", { "tsconfig.json": fxConfig({ paths: { "gen/*": ["build/*"] } }), "web/worker.ts": 'import { a } from "gen/alias";\nexport const x = a;\n' }, { "build/alias.ts": STORE }, ["build", "build/alias"]],
  ["a tsconfig typeRoots entry", { "tsconfig.json": fxConfig({ typeRoots: ["./build/types", "./node_modules/@types"] }), "web/worker.ts": "export const w = 1;\n" }, { "build/types/x/index.d.ts": "declare function tx(): ArrayBuffer;\n" }, ["build/types"]],
  ["a tracked symlink to a built file", { "web/link.ts": link("../build/real.ts"), "web/worker.ts": 'import { a } from "./link";\nexport const y = a;\n' }, { "build/real.ts": STORE }, ["web/link.ts"]],
  ["a tracked symlink outside the include directories, by its stem", { "lib/link.ts": link("../build/real.ts"), "web/worker.ts": 'import { a } from "../lib/link";\nexport const y = a;\n' }, { "build/real.ts": STORE }, ["lib/link.ts"]],
  ["a tracked symlink to the build directory", { "web/gen": link("../build/gendir"), "web/worker.ts": 'import { a } from "./gen/mod";\nexport const y = a;\n' }, { "build/gendir/mod.ts": STORE }, ["web/gen", "web/gen/mod"]],
  ["a tracked symlink in an include directory, nothing importing it (the roots' src/runtime/**)", { "src/runtime/gen": link("../../build/rt"), "web/worker.ts": "export const w = 1;\n" }, { "build/rt/a.ts": STORE }, ["src/runtime/gen"]],
  ["a path through a hidden link back out of build/", { "web/d": link("../build"), "web/visible/v.ts": STORE, "web/worker.ts": 'import { a } from "./d/back/v";\nexport const y = a;\n' }, { "build/back": link("../web/visible") }, ["web/d", "web/d/back/v"]],
  ["a tsconfig include into build/", { "tsconfig.json": JSON.stringify({ compilerOptions: FX_OPTS, include: ["src/**/*.ts", "web/**/*.ts", "build/**/*.ts"] }), "web/worker.ts": "export const w = 1;\n" }, { "build/inc.ts": STORE }, ["build"]],
  // (r11, astra2 P1) the tsconfig's explicit and inherited files roots
  ["an explicit files root that is a symlink into build/", { "tsconfig.json": JSON.stringify({ compilerOptions: FX_OPTS, files: ["src/runtime/link.ts", "web/worker.ts"], include: [] }), "src/runtime/link.ts": link("../../build/hidden.ts"), "web/worker.ts": "export const w = 1;\n" }, { "build/hidden.ts": STORE }, ["src/runtime/link.ts"]],
  ["an explicit files root in build/", { "tsconfig.json": JSON.stringify({ compilerOptions: FX_OPTS, files: ["build/hidden.ts", "web/worker.ts"], include: [] }), "web/worker.ts": "export const w = 1;\n" }, { "build/hidden.ts": STORE }, ["build/hidden.ts"]],
  ["an inherited files root", { "tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json", include: [] }), "tsconfig.base.json": JSON.stringify({ compilerOptions: FX_OPTS, files: ["src/runtime/link.ts", "web/worker.ts"] }), "src/runtime/link.ts": link("../../build/hidden.ts"), "web/worker.ts": "export const w = 1;\n" }, { "build/hidden.ts": STORE }, ["src/runtime/link.ts"]],
  ["an import", { "web/worker.ts": 'import "../build/other.gen.js";\n' }, { "build/other.gen.js": "export {};\n" }, ["build/other.gen.js"]],
  ["an export from", { "web/worker.ts": 'export * from "../build/x/other.gen.js";\n' }, { "build/x/other.gen.js": "export {};\n" }, ["build/x/other.gen.js"]],
  ["an import()", { "web/worker.ts": 'export const p = () => import("../build/other.gen.js");\n' }, { "build/other.gen.js": "export {};\n" }, ["build/other.gen.js"]],
  ["a require", { "web/worker.ts": 'declare const require: (s: string) => unknown;\nexport const r = require("../build/other.gen.js");\n' }, { "build/other.gen.js": "export {};\n" }, ["build/other.gen.js"]],
  ["an import-equals", { "web/worker.ts": 'import o = require("../build/other.gen");\nexport const r = o;\n' }, { "build/other.gen.ts": "export const z = new Uint8Array(1);\n" }, ["build/other.gen"]],
  ["an import type", { "web/worker.ts": 'export type T = typeof import("../build/other.gen");\n' }, { "build/other.gen.ts": "export const z = new Uint8Array(1);\n" }, ["build/other.gen"]],
  ["a chain of 40 links (the most the OS follows) into build/", { ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`web/l${i}.ts`, link(i === 39 ? "../build/t.ts" : `l${i + 1}.ts`)])), "web/worker.ts": 'import { a } from "./l0";\nexport const y = a;\n' }, { "build/t.ts": STORE }, Array.from({ length: 40 }, (_, i) => `web/l${i}.ts`)],
];
const generatedKeys = (c: any) => G.gate(null, { table: {}, cur: c }).problems.filter((p: any) => p.problem === "generated");
test("train-16: the census reads the tracked tree only: whatever references build/, a build changes nothing, and only a reviewed generated module passes the gate", () => {
  for (const [name, tracked, built, want] of REFERENCE_CASES) {
    const without = fixture(tracked);
    const withBuild = fixture({ ...tracked, ...built });
    assert.deepEqual(withBuild.header, without.header, `${name}: the header, built or not`);
    assert.deepEqual(withBuild.records, without.records, `${name}: the records, built or not`);
    assert.deepEqual(withBuild.programFiles, without.programFiles, `${name}: the program's files, built or not`);
    for (const c of [without, withBuild]) {
      assert.ok(!c.programFiles.some((f: string) => f.startsWith("build/") || f === "web/link.ts" || f === "lib/link.ts" || /^web\/(gen|d)\/|^src\/runtime\/gen\/|^web\/l\d+\.ts$/.test(f)), `${name}: ${c.programFiles.join(" ")}`);
      const ps = generatedKeys(c);
      assert.deepEqual([...new Set(ps.map((p: any) => p.key))].sort(), [...want].sort(), `${name}: ${JSON.stringify(c.header.generated)}`);
      for (const p of ps) assert.match(p.detail, /in the excluded build output, with no reviewed generator$/, name);
    }
  }
  const reviewed = fixture(REFERENCE_CASES[0][1]);
  assert.deepEqual(reviewed.header.generated, [{ path: LM, from: ["web/worker.ts"], generator: GEN, inputs: GEN_INPUTS.map((i) => i.path), generator_sha256: S.GENERATED[LM].generator_sha256, contract: null }]);
  // its generator, or one of the generator's inputs, missing from the tree: it fails, never passes by name
  for (const gone of [GEN, "scripts/build-id.mjs"]) {
    const { [gone]: _, ...rest } = REFERENCE_CASES[0][1];
    const ps = G.generatedProblems(fixture(rest));
    assert.equal(ps.length, 1, gone);
    assert.match(ps[0].detail, new RegExp(`breaks the contract \\(its generator's inputs are missing: ${gone.replace(/[.]/g, "\\.")}\\)`), gone);
  }
});

test("train-16: the census's links fail closed: more than 40, a cycle or a dangling cycle throws, built or not", () => {
  const chain = (n: number) => ({ ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`web/l${i}.ts`, link(i === n - 1 ? "../build/t.ts" : `l${i + 1}.ts`)])), "web/worker.ts": 'import { a } from "./l0";\nexport const y = a;\n' });
  const cases: [string, Record<string, string>, RegExp][] = [
    ["41 links", chain(41), /more than 40 symbolic links resolving .*web\/l0\.ts/],
    ["a cycle", { "web/c1.ts": link("c2.ts"), "web/c2.ts": link("c1.ts"), "web/worker.ts": 'import { a } from "./c1";\nexport const y = a;\n' }, /a cycle of symbolic links at .*web\/c[12]\.ts/],
    ["a dangling cycle (a link through itself)", { "web/dc.ts": link("dc.ts/x"), "web/worker.ts": 'import { a } from "./dc";\nexport const y = a;\n' }, /a cycle of symbolic links at .*web\/dc\.ts/],
  ];
  for (const [name, tracked, re] of cases) for (const extra of [{}, { "build/t.ts": STORE }] as Record<string, string>[]) assert.throws(() => fixture({ ...tracked, ...extra }), re, name);
  // the resolver itself: 40 hops resolve, 41 throw
  const dir = mkdtempSync(join(tmpdir(), "ab-links-"));
  try {
    writeFileSync(join(dir, "t"), "");
    for (let i = 0; i < 41; i++) symlinkSync(i === 40 ? "t" : `k${i + 1}`, join(dir, `k${i}`));
    assert.equal(S.resolveLinks(join(dir, "k1")), join(S.resolveLinks(dir), "t"));
    assert.throws(() => S.resolveLinks(join(dir, "k0")), /more than 40 symbolic links/);
    assert.equal(S.MAX_LINK_HOPS, 40);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("train-16: the census's tsconfig is read on the boundary: an extends into build/ (direct, nested, symlinked, in an array) is refused by name, built or not; no config diagnostic is dropped", () => {
  const base = (extra: object) => JSON.stringify({ compilerOptions: FX_OPTS, ...extra });
  const cases: [string, Record<string, string>, RegExp][] = [
    ["direct", { "tsconfig.json": fxConfig({}, { extends: "./build/options.json" }) }, /extends excluded configs: build\/options\.json \(extended by tsconfig\.json\)/],
    ["nested", { "tsconfig.json": fxConfig({}, { extends: "./tsconfig.base.json" }), "tsconfig.base.json": base({ extends: "./build/options" }) }, /extends excluded configs: build\/options\.json \(extended by tsconfig\.base\.json\)/],
    ["symlinked", { "tsconfig.json": fxConfig({}, { extends: "./linked.json" }), "linked.json": link("build/options.json") }, /extends excluded configs: linked\.json \(extended by tsconfig\.json\)/],
    ["in an array", { "tsconfig.json": fxConfig({}, { extends: ["./tsconfig.base.json", "./build/options.json"] }), "tsconfig.base.json": base({}) }, /extends excluded configs: build\/options\.json \(extended by tsconfig\.json\)/],
    ["a missing tracked config (a diagnostic)", { "tsconfig.json": fxConfig({}, { extends: "./missing.json" }) }, /the census's tsconfig: .*missing\.json/],
    ["an invalid option (a diagnostic)", { "tsconfig.json": fxConfig({ target: "es1999" }) }, /the census's tsconfig: .*target/],
  ];
  for (const [name, tracked, re] of cases) for (const extra of [{}, { "build/options.json": base({ compilerOptions: { strict: false } }) }] as Record<string, string>[]) assert.throws(() => fixture({ "web/worker.ts": "export const w = 1;\n", ...tracked, ...extra }), re, name);
  // a tracked root the program can't read is an error, never dropped (r11)
  assert.throws(() => fixture({ "tsconfig.json": JSON.stringify({ compilerOptions: FX_OPTS, files: ["src/runtime/gone.ts", "web/worker.ts"], include: [] }), "web/worker.ts": "export const w = 1;\n" }), /the census program lost roots: src\/runtime\/gone\.ts/);
  // the control: a tracked extends chain is read
  const ok = fixture({ "web/worker.ts": "export const w = new Uint8Array(1);\n", "tsconfig.json": fxConfig({}, { extends: "./tsconfig.base.json" }), "tsconfig.base.json": base({}) });
  assert.equal(one(ok, "new Uint8Array ( 1 )").kind, "store");
});

test("train-16: the census host answers every read of an excluded path as missing, symlinks resolved, a path through build/ included; a program holding one is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-host-"));
  try {
    for (const [p, t] of Object.entries({ "build/x.ts": "export {};\n", "web/a.ts": "export {};\n", "web/visible/v.d.ts": "export {};\n" })) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t);
    }
    symlinkSync("../build/x.ts", join(dir, "web/l.ts"));
    symlinkSync("../build", join(dir, "web/d"));
    symlinkSync("../build/never.ts", join(dir, "web/dangling.ts"));
    // a link out of build/ again: web/d/back is web/visible, reached through build/
    symlinkSync("../web/visible", join(dir, "build/back"));
    // `..` after a link is the OS's: web/up/../x.ts is build/x.ts when web/up is build/sub
    mkdirSync(join(dir, "build/sub"));
    symlinkSync("../build/sub", join(dir, "web/up"));
    assert.equal(S.hiddenPath(dir, `${dir}/web/up/../x.ts`), true, "(a raw path: join() would fold the ..)");
    assert.equal(S.hiddenPath(dir, `${dir}/web/visible/../a.ts`), false);
    // an absolute link
    symlinkSync(join(dir, "build/x.ts"), join(dir, "web/abs.ts"));
    assert.equal(S.hiddenPath(dir, join(dir, "web/abs.ts")), true);
    // the config parse's system, method by method
    const sys = S.trackedSys(dir);
    for (const p of ["web/a.ts", "web/visible/v.d.ts"]) assert.equal(sys.fileExists(join(dir, p)), true, p);
    for (const p of ["build/x.ts", "web/l.ts", "web/d/back/v.d.ts"]) {
      assert.equal(sys.fileExists(join(dir, p)), false, p);
      assert.equal(sys.readFile(join(dir, p)), undefined, p);
    }
    assert.equal(typeof sys.readFile(join(dir, "web/a.ts")), "string");
    assert.equal(sys.directoryExists(join(dir, "web")), true);
    for (const p of ["build", "web/d"]) assert.equal(sys.directoryExists(join(dir, p)), false, p);
    assert.deepEqual(sys.readDirectory(dir, [".ts"], undefined, ["**/*"]).map((f: string) => f.slice(dir.length + 1)).sort(), ["web/a.ts", "web/visible/v.d.ts"]);
    const h = S.trackedHost(dir, {});
    const at = (p: string) => join(dir, p);
    assert.equal(h.fileExists(at("web/a.ts")), true);
    assert.equal(h.fileExists(at("web/visible/v.d.ts")), true);
    for (const p of ["build/x.ts", "web/l.ts", "web/d/x.ts", "web/dangling.ts", "web/d/back/v.d.ts"]) assert.equal(h.fileExists(at(p)), false, p);
    assert.equal(typeof h.readFile(at("web/a.ts")), "string");
    for (const p of ["build/x.ts", "web/l.ts", "web/d/x.ts", "web/d/back/v.d.ts"]) assert.equal(h.readFile(at(p)), undefined, p);
    assert.ok(h.getSourceFile(at("web/a.ts"), 99));
    for (const p of ["build/x.ts", "web/l.ts", "web/d/x.ts", "web/d/back/v.d.ts"]) assert.equal(h.getSourceFile(at(p), 99), undefined, p);
    assert.equal(h.directoryExists(at("web")), true);
    for (const p of ["build", "web/d", "web/d/back", "build/back"]) assert.equal(h.directoryExists(at(p)), false, p);
    assert.deepEqual(h.getDirectories(dir).sort(), ["web"]);
    assert.deepEqual(h.getDirectories(at("web")), ["visible"]);
    for (const p of ["build", "web/d"]) assert.deepEqual(h.getDirectories(at(p)), [], p);
    S.assertTracked(dir, [at("web/a.ts"), at("web/visible/v.d.ts")]);
    for (const p of ["build/x.ts", "web/l.ts", "web/d/x.ts", "web/d/back/v.d.ts"]) assert.throws(() => S.assertTracked(dir, [at("web/a.ts"), at(p)]), /the census program holds excluded files: /, p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("train-16: a generated module is bound to its generator's whole input closure (sha256 pinned) and a contract checked without a build", () => {
  const want = S.GENERATED[LM].generator_sha256;
  assert.equal(S.closureSha(GEN_INPUTS), want, "the tracked closure is the reviewed one");
  assert.equal(S.generatorContract(GEN_INPUTS, GEN, LM), null, "the tracked generator holds the contract");
  const main = GEN_INPUTS[0].text;
  const frag = main.split("\n").find((l: string) => l.includes('"lib-meta.gen.js"'))!;
  const withText = (path: string, text: string) => GEN_INPUTS.map((i) => (i.path === path ? { path, text } : i));
  const edit = (from: string, to: string, path = GEN) => {
    const t = GEN_INPUTS.find((i) => i.path === path)!.text;
    assert.equal(t.split(from).length, 2, from);
    return withText(path, t.replace(from, to));
  };
  const fragEdit = (from: string, to: string) => edit(frag, frag.replace(from, to));
  const after = (code: string) => edit(frag, `${frag}\n${code}`);
  const contractFails: [string, any[], RegExp][] = [
    ["a value not through JSON.stringify", fragEdit("${JSON.stringify(version)}", "${version}"), /a value isn't JSON\.stringify\(\.\.\.\): version/],
    ["an allocation in the output", fragEdit("\\n`);", "\\nglobalThis.__X__ = new Uint8Array(4);\\n`);"), /its lines aren't each/],
    ["a call in the output", fragEdit("globalThis.__SAGEBRUSH_VERSION__ = ", "globalThis.f(); globalThis.__SAGEBRUSH_VERSION__ = "), /its lines aren't each/],
    ["not a template", fragEdit(/`.*`/.exec(frag)![0], "code"), /its text isn't a template/],
    ["two writes of it", after(frag), /2 writes of lib-meta\.gen\.js, not one/],
    ["no write of it", edit(frag, ""), /0 writes of lib-meta\.gen\.js, not one/],
    ["another directory", fragEdit("join(out, ", "join(root, "), /its directory isn't the generator's one `out`/],
    ["out moved", edit('const out = join(root, "build", "cli");', 'const out = join(root, "build", "other");'), /`out` isn't join\(root, "build", "cli"\)/],
    // outside the write: semantic changes (astra2's r9 controls)
    ["an appendFileSync to the output after the write", after('appendFileSync(join(out, "lib-meta.gen.js"), "globalThis.f = () => new Uint8Array(1);\\n");'), /lib-meta\.gen\.js is named 2 times in the closure's strings \(scripts\/build-cli\.mjs:\d+, scripts\/build-cli\.mjs:\d+\), not once/],
    ["a copyFileSync onto the output", after('copyFileSync(join(root, "x.js"), `${out}/lib-meta.gen.js`);'), /is named 2 times/],
    ["JSON.stringify reassigned before the write", edit(frag, `JSON.stringify = (v) => "new Uint8Array(1)";\n${frag}`), /scripts\/build-cli\.mjs assigns to JSON: JSON\.stringify = /],
    ["JSON reassigned on globalThis", edit(frag, `globalThis.JSON = { stringify: () => "f()" };\n${frag}`), /assigns to JSON: globalThis\.JSON = /],
    ["JSON.stringify redefined", edit(frag, `Object.defineProperty(JSON, "stringify", { value: () => "f()" });\n${frag}`), /redefines JSON: Object\.defineProperty\(JSON/],
    ["JSON reassigned in an imported module", edit('import { createHash } from "node:crypto";', 'import { createHash } from "node:crypto";\nJSON.stringify = () => "f()";', "scripts/build-id.mjs"), /scripts\/build-id\.mjs assigns to JSON/],
  ];
  for (const [name, inputs, re] of contractFails) {
    assert.match(S.generatorContract(inputs, GEN, LM) ?? "(holds)", re, name);
    assert.notEqual(S.closureSha(inputs), want, `${name}: the pin moves too`);
  }
  // a contract-preserving change anywhere in the closure moves the pin: review and renewal, never silent
  const holds: [string, any[]][] = [
    ["an aliased copy onto the output (no string names it)", after('copyFileSync(join(root, "x.js"), join(out, "lib-meta" + ".gen.js"));')],
    ["a renamed global", fragEdit("__SAGEBRUSH_NOTICES__", "__SAGEBRUSH_NOTICES2__")],
    ["out's declaration respaced", edit('const out = join(root, "build", "cli");', 'const out = join(root, "build", "cli" );')],
    ["a comment elsewhere in the generator", edit("// 1. The Python library, as a JS object.", "// 1. The Python library, as a JS object (edited).")],
    ["an edit in an imported module", edit('import { createHash } from "node:crypto";', 'import { createHash } from "node:crypto";\n// edited', "scripts/build-id.mjs")],
  ];
  for (const [name, inputs] of holds) {
    assert.equal(S.generatorContract(inputs, GEN, LM), null, name);
    assert.notEqual(S.closureSha(inputs), want, `${name}: the pin moves`);
  }
  // the closure: the generator's tracked imports, static and dynamic, transitively; a new one joins it
  const dir = mkdtempSync(join(tmpdir(), "ab-gen-"));
  try {
    for (const i of GEN_INPUTS) {
      mkdirSync(dirname(join(dir, i.path)), { recursive: true });
      writeFileSync(join(dir, i.path), i.text);
    }
    assert.deepEqual(S.generatorClosure(dir, GEN).inputs.map((i: any) => i.path), GEN_INPUTS.map((i) => i.path));
    writeFileSync(join(dir, GEN), `import "./extra.mjs";\n${main}`);
    writeFileSync(join(dir, "scripts/extra.mjs"), 'import "./deeper.mjs";\n');
    const c = S.generatorClosure(dir, GEN);
    assert.deepEqual(c.inputs.map((i: any) => i.path), ["scripts/build-cli.mjs", "scripts/build-id.mjs", "scripts/extra.mjs", "scripts/packages.mjs"]);
    assert.deepEqual(c.missing, ["scripts/deeper.mjs"]);
    // an input that's a link into build/ is missing, never read
    mkdirSync(join(dir, "build"));
    writeFileSync(join(dir, "build/deeper.mjs"), "JSON.stringify = () => 'f()';\n");
    symlinkSync("../build/deeper.mjs", join(dir, "scripts/deeper.mjs"));
    assert.deepEqual(S.generatorClosure(dir, GEN).missing, ["scripts/deeper.mjs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // the pin binds each input's path as well as its text
  assert.notEqual(S.closureSha([{ path: "a.mjs", text: "x" }]), S.closureSha([{ path: "b.mjs", text: "x" }]));
  // the gate: each way it fails, and the reviewed one passing
  const cur = (g: object) => ({ header: { generated: [{ path: LM, from: ["web/worker.ts"], generator: GEN, inputs: GEN_INPUTS.map((i) => i.path), generator_sha256: want, contract: null, ...g }] } });
  assert.deepEqual(G.generatedProblems(cur({})), []);
  assert.match(G.generatedProblems(cur({ generator_sha256: "0".repeat(64) }))[0].detail, /its generator changed \(closure scripts\/build-cli\.mjs, scripts\/build-id\.mjs, scripts\/packages\.mjs: sha256 0+, reviewed \w+\): review it and renew GENERATED/);
  assert.match(G.generatedProblems(cur({ contract: "x" }))[0].detail, /breaks the contract \(x\)/);
  assert.match(G.generatedProblems(cur({ generator: null }))[0].detail, /with no reviewed generator/);
  assert.match(G.generatedProblems({ header: { generated: [{ path: "build/cli/other.gen.js", from: ["web/worker.ts"], generator: GEN, inputs: [], generator_sha256: want, contract: null }] } })[0].detail, /with no reviewed generator/);
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
    // (the census's tracked inputs at B: its tsconfig, the directories it scans, and each reviewed generator's
    // input closure it checks a generated module's contract in; one missing at B fails the archive, loudly)
    const generators = [...new Set((base.header.generated ?? []).flatMap((g: any) => g.inputs ?? []))] as string[];
    const tar = execFileSync("git", ["archive", B, "tsconfig.json", ...base.header.dirs, ...generators], { cwd: ROOT, maxBuffer: 1 << 30 });
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
  // spread, Object.assign and JSON.stringify also make copy or protocol obligations of their own,
  // which allocate too: their accessor edge is checked as an edge, so no obligation can mask it
  const c = fixture({
    "src/runtime/acc2.ts": `export class Maker { get bytes(): any { return new Uint8Array(8); } }
export function objSpread(o: any): any { return { ...o }; }
export function oassign(o: any): any { return Object.assign({}, o); }
export function jsonAll(o: any): string { return JSON.stringify(o); }
`,
  });
  const getter = [...c.decls.values()].find((d: any) => d.name === "get Maker.bytes");
  for (const n of ["objSpread", "oassign", "jsonAll"]) {
    const d = [...c.decls.values()].find((x: any) => x.name === n);
    assert.ok(d.irefs.has(getter.fp), `${n} reaches every accessor`);
  }
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

test("an unknown key reaches inherited accessors too: the class's ancestors, itself and its descendants (astra2 C1b)", () => {
  const files = (alloc: string) => ({
    "src/runtime/inh.ts": `
export class Base { x: any = null; get bytes(): any { return ${alloc}; } set sink(v: any) { this.x = ${alloc}; } }
export class Derived extends Base {}
export class Other { get bytes(): any { return 1; } }
export function inherited(d: Derived, key: string): any { return d[key as "bytes"]; }
export function getInherited(d: Derived): any { return inherited(d, "bytes"); }
export function setInherited(d: Derived, key: string): void { (d as any as Derived)[key as "sink"] = 1; }
export function otherComputed(o: Other, key: string): any { return o[key as "bytes"]; }
`,
  });
  assert.deepEqual(mayAlloc(files("new Uint8Array(8)"), ["inherited", "getInherited", "setInherited", "otherComputed"]), { inherited: true, getInherited: true, setInherited: true, otherComputed: false });
  // the negative control: nothing allocates, nothing is reached
  assert.deepEqual(mayAlloc(files("8"), ["inherited", "setInherited"]), { inherited: false, setInherited: false });
});

// one protocol-member form per fixture, each with a non-allocating twin: nothing else in
// the fixture allocates, so no other member can mask the result (astra2 C2b)
const C2B: [string, (alloc: string) => string, string][] = [
  ["a class field arrow toJSON", (a) => `export class F { toJSON = () => ${a}; }`, "json"],
  ["a class field function-expression valueOf", (a) => `export class F { valueOf = function () { return ${a}; }; }`, "coerce"],
  ["a quoted method toJSON", (a) => `export class F { "toJSON"() { return ${a}; } }`, "json"],
  ["a computed literal toJSON", (a) => `export class F { ["toJSON"]() { return ${a}; } }`, "json"],
  ["a const-alias computed toJSON", (a) => `const K = "toJSON";\nexport class F { [K]() { return ${a}; } }`, "json"],
  ["a Symbol.iterator alias", (a) => `const IT = Symbol.iterator;\nexport class F { *[IT]() { yield ${a}; } }`, "iterate"],
  ["a Symbol.toPrimitive field", (a) => `export class F { [Symbol.toPrimitive] = () => { const b = ${a}; return 1; }; }`, "coerce"],
  ["a then field", (a) => `export class F { then = (f: any) => f(${a}); }`, "await"],
  ["an object-literal toJSON property", (a) => `export function mk(): any { return { toJSON: () => ${a} }; }`, "json"],
  ["an object-literal quoted toString", (a) => `export function mk(): any { return { "toString": function () { return String(${a}); } }; }`, "coerce"],
  ["an assigned toJSON", (a) => `export function mk(o: any): void { o.toJSON = () => ${a}; }`, "json"],
  ["an assigned quoted valueOf", (a) => `export function mk(o: any): void { o["valueOf"] = () => { const b = ${a}; return 1; }; }`, "coerce"],
];
const USE: Record<string, string> = {
  json: "export function use(x: object): string { return JSON.stringify(x); }",
  coerce: "export function use(x: object): number { return +x; }",
  iterate: "export function use(x: any): any[] { return [...x]; }",
  await: "export async function use(x: any): Promise<any> { await x; return 1; }",
};
for (const [what, src, kind] of C2B) {
  test(`a protocol member by its runtime property: ${what} (astra2 C2b)`, () => {
    const files = (alloc: string) => ({ "src/runtime/pm.ts": `${src(alloc)}\n${USE[kind]}\nexport function caller(x: any): any { return use(x); }\n` });
    assert.deepEqual(mayAlloc(files("new Uint8Array(32)"), ["use", "caller"]), { use: true, caller: true }, "the allocating member is reached");
    assert.deepEqual(mayAlloc(files("32"), ["use", "caller"]), { use: false, caller: false }, "its non-allocating twin: no witness");
  });
}

test("a resolved name is that protocol only: an aliased toJSON isn't a coercion member, an aliased Symbol.iterator isn't toJSON (astra2 C2b)", () => {
  const files = (member: string) => ({ "src/runtime/al.ts": `${member}\nexport function json(x: object): string { return JSON.stringify(x); }\nexport function coerce(x: object): number { return +x; }\nexport function spread(x: any): any[] { return [...x]; }\n` });
  assert.deepEqual(mayAlloc(files('const K = "toJSON";\nexport class F { [K]() { return new Uint8Array(1); } }'), ["json", "coerce", "spread"]), { json: true, coerce: false, spread: false });
  assert.deepEqual(mayAlloc(files("const IT = Symbol.iterator;\nexport class F { *[IT]() { yield new Uint8Array(1); } }"), ["json", "coerce", "spread"]), { json: false, coerce: false, spread: true });
  assert.deepEqual(mayAlloc(files('export class F { ["toJSON"]() { return new Uint8Array(1); } }'), ["json", "coerce", "spread"]), { json: true, coerce: false, spread: false });
  assert.deepEqual(mayAlloc(files("export class F { *[Symbol.iterator]() { yield new Uint8Array(1); } }"), ["json", "coerce", "spread"]), { json: false, coerce: false, spread: true });
});

test("a protocol member the census can't resolve is a fail-closed obligation, reported (astra2 C2b)", () => {
  const files = (src: string) => ({ "src/runtime/ob.ts": `${src}\nexport function use(x: object): string { return JSON.stringify(x); }\nexport function coerce(x: object): number { return +x; }\n` });
  // a method with a name the census can't resolve is registered under every protocol: its body decides
  assert.deepEqual(mayAlloc(files("declare function k(): string;\nexport class F { [k()]() { return new Uint8Array(1); } }"), ["use", "coerce"]), { use: true, coerce: true });
  assert.deepEqual(mayAlloc(files("declare function k(): string;\nexport class F { [k()]() { return 1; } }"), ["use", "coerce"]), { use: false, coerce: false });
  // a property under an unknown name holding a function that can't be resolved: an obligation, every protocol
  const unk = fixture(files("declare function k(): string;\ndeclare function mkFn(): any;\nexport class F { [k()] = mkFn(); }"));
  assert.ok(unk.obligations.length === 1 && /can't be resolved/.test(unk.obligations[0].reason), "reported, with its reason");
  assert.deepEqual(mayAlloc(files("declare function k(): string;\ndeclare function mkFn(): any;\nexport class F { [k()] = mkFn(); }"), ["use", "coerce"]), { use: true, coerce: true });
  // a protocol-named field whose function can't be resolved
  assert.deepEqual(mayAlloc(files("declare function mkFn(): any;\nexport class F { toJSON = mkFn(); }"), ["use", "coerce"]), { use: true, coerce: false });
  // an accessor under a name the census can't resolve: every by-name access reaches it
  assert.deepEqual(mayAlloc({ "src/runtime/ua.ts": "declare function k(): string;\nexport class F { get [k()](): any { return new Uint8Array(1); } }\nexport function rd(o: any): any { return o.whatever; }\n" }, ["rd"]), { rd: true });
  assert.deepEqual(mayAlloc({ "src/runtime/ua.ts": "declare function k(): string;\nexport class F { get [k()](): any { return 1; } }\nexport function rd(o: any): any { return o.whatever; }\n" }, ["rd"]), { rd: false });
  // Object.defineProperty: a value under a protocol name, and a getter under a name
  assert.deepEqual(mayAlloc(files("export function def(o: object): void { Object.defineProperty(o, \"toJSON\", { value: () => new Uint8Array(1) }); }"), ["use", "coerce"]), { use: true, coerce: false });
  assert.deepEqual(mayAlloc({ "src/runtime/dp.ts": "export function def(o: object): void { Object.defineProperty(o, \"bytes\", { get() { return new Uint8Array(1); } }); }\nexport function rd(o: any): any { return o.bytes; }\nexport function rd2(o: any): any { return o.other; }\n" }, ["rd", "rd2"]), { rd: true, rd2: false });
  // a numeric key, or a union of literal keys without protocol names, can't install a member: no obligation
  const keyed = fixture(files("declare function mkFn(): any;\nexport function put(o: any, i: number, k: \"a\" | \"b\"): void { o[i] = mkFn(); o[k] = mkFn(); }"));
  assert.deepEqual(keyed.obligations, []);
  // a string key could: an obligation
  const sk = fixture(files("declare function mkFn(): any;\nexport function put(o: any, k: string): void { o[k] = mkFn(); }"));
  assert.equal(sk.obligations.length, 1);
  // only literals are exempt by syntax: lib calls typed any and new-expressions are obligations (astra2 X1)
  const plain = fixture(files("declare const src: any;\nexport function put(o: any, k: string): void {\n  o[k] = { a: 1 };\n  o[k] = [src];\n  o[k] = Object.create(null);\n  o[k] = JSON.parse(\"{}\");\n  o[k] = new Map();\n}"));
  assert.deepEqual(plain.obligations.map((o: any) => o.line).sort(), [5, 6, 7], "Object.create, JSON.parse and new Map; not the two literals");
  // known, non-callable or non-protocol names: no obligation
  const none = fixture(files("export class F { toJSON = 3; data = () => 1; [\"x\"]() { return 1; } }"));
  assert.deepEqual(none.obligations, []);
});

test("descriptor accessors with named or unresolved functions, getter and setter (astra2 R1)", () => {
  const f = (desc: string) => ({ "src/runtime/d.ts": `export function make(): any { return new Uint8Array(1); }\nexport function quiet(): any { return 1; }\ndeclare const anyFn: any;\nexport function install(o: object): void { Object.defineProperty(o, "bytes", ${desc}); }\nexport function read(o: any): any { return o.bytes; }\nexport function write(o: any): void { o.bytes = 1; }\nexport function caller(o: any): any { return read(o); }\n` });
  assert.deepEqual(mayAlloc(f("{ get: make }"), ["read", "caller"]), { read: true, caller: true }, "a named getter");
  assert.deepEqual(mayAlloc(f("{ set: make }"), ["write"]), { write: true }, "a named setter");
  assert.deepEqual(mayAlloc(f("{ get: anyFn }"), ["read", "caller"]), { read: true, caller: true }, "an unresolved getter: an accessor obligation");
  assert.deepEqual(mayAlloc(f("{ set: anyFn }"), ["write"]), { write: true }, "an unresolved setter");
  assert.deepEqual(mayAlloc(f("{ get: quiet, set: quiet }"), ["read", "write"]), { read: false, write: false }, "a named non-allocating twin");
});

test("a value whose type may be callable without a call signature is an obligation: generics and structural types (astra2 R2)", () => {
  const f = (install: string) => ({ "src/runtime/g.ts": `${install}\nexport function json(o: object): string { return JSON.stringify(o); }\n` });
  assert.deepEqual(mayAlloc(f("export function install<T>(o: any, fn: T): void { o.toJSON = fn; }"), ["json"]), { json: true }, "an unconstrained type parameter");
  assert.deepEqual(mayAlloc(f("export function install<T extends { a: number }>(o: any, fn: T): void { o.toJSON = fn; }"), ["json"]), { json: true }, "a type parameter constrained to an object type");
  assert.deepEqual(mayAlloc(f("export function install(o: any, fn: { a: number }): void { o.toJSON = fn; }"), ["json"]), { json: true }, "a structural object type");
  assert.deepEqual(mayAlloc(f("export function install<T extends number>(o: any, fn: T): void { o.toJSON = fn; }"), ["json"]), { json: false }, "a type parameter constrained to a primitive");
  assert.deepEqual(mayAlloc(f("export function install(o: any, fn: number[]): void { o.toJSON = fn; }"), ["json"]), { json: true }, "an array type may be a function (Object.assign(fn, []))");
  assert.deepEqual(mayAlloc(f("export function install(o: any): void { o.toJSON = { a: 1 }; }"), ["json"]), { json: false }, "an object literal: provably not a function");
});

test("X1 and X2, isolated: a constructor returning a function, and an array-constrained parameter holding one, are obligations (astra2)", () => {
  const x1 = fixture({ "src/runtime/x1.ts": "export class Factory { constructor() { return (() => new Uint8Array(8)) as any; } }\nexport function install(o: any): void { o.toJSON = new Factory(); }\nexport function json(o: object): string { return JSON.stringify(o); }\n" });
  assert.deepEqual(x1.obligations.map((o: any) => [o.line, o.kinds.join()]), [[2, "json"]]);
  const x2 = fixture({ "src/runtime/x2.ts": "export function install<T extends unknown[]>(o: any, f: T): void { o.toJSON = f; }\nexport function make(): any { return Object.assign(() => new Uint8Array(8), []); }\nexport function json(o: object): string { return JSON.stringify(o); }\n" });
  assert.deepEqual(x2.obligations.map((o: any) => [o.line, o.kinds.join()]), [[1, "json"]]);
  assert.deepEqual(mayAlloc({ "src/runtime/x1.ts": "export class Factory { constructor() { return (() => new Uint8Array(8)) as any; } }\nexport function install(o: any): void { o.toJSON = new Factory(); }\nexport function json(o: object): string { return JSON.stringify(o); }\n" }, ["json"]), { json: true });
});

test("an array literal copied by Object.assign or spread installs no protocol member, even holding a function: its own keys are indexes, never protocol names", () => {
  const c = fixture({ "src/runtime/al.ts": "export function f(): any { return new Uint8Array(1); }\nexport function a1(o: any): void { Object.assign(o, [f]); }\nexport function a2(o: any, g: () => any): void { Object.assign(o, [g, () => 1]); }\nexport function s1(): any { return { ...[f] }; }\nexport function json(o: object): string { return JSON.stringify(o); }\n" });
  assert.deepEqual(c.obligations, [], "no obligation");
  for (const k of Object.keys(c.protocol)) assert.deepEqual([...c.protocol[k]].map((fp: string) => c.decls.get(fp)?.name), [], `no ${k} member`);
  // the twin: an object literal copied with a function under a protocol name does install it
  const t = fixture({ "src/runtime/ol.ts": "export function f(): any { return new Uint8Array(1); }\nexport function a1(o: any): void { Object.assign(o, { toJSON: f }); }\n" });
  assert.deepEqual([...t.protocol.json].map((fp: string) => t.decls.get(fp)?.name), ["f"]);
});

test("V1, isolated: a () => void function that returns a function installs an obligation (astra2)", () => {
  const src = "const get: () => void = () => () => new Uint8Array(8);\nexport function install(o: any): void { o.toJSON = get(); }\nexport function json(o: object): any { return JSON.stringify(o); }\nexport function caller(o: object): any { return json(o); }\n";
  const c = fixture({ "src/runtime/v1.ts": src });
  assert.deepEqual(c.obligations.map((o: any) => [o.line, o.kinds.join()]), [[2, "json"]], "the only obligation, at the install");
  assert.deepEqual(mayAlloc({ "src/runtime/v1.ts": src }, ["json", "caller"]), { json: true, caller: true });
  // void-typed and void-constrained values, each alone
  const v = fixture({ "src/runtime/v2.ts": "declare const vd: void;\nexport function a(o: any): void { o.toJSON = vd; }\nexport function b<T extends void>(o: any, t: T): void { o.valueOf = t; }\nexport function c(o: any, x: number | void): void { o.then = x; }\nexport function d(o: any): void { o.toJSON = void 0; }\n" });
  assert.deepEqual(v.obligations.map((o: any) => o.line).sort(), [2, 3, 4], "void, T extends void, number | void; not void 0 (undefined)");
});

test("E1.1: typescript-api is named only by the gates' scripts and their tests (arraybuffer-sites; line 3 of the site asset budget); it has no install scripts", () => {
  const out = execFileSync("git", ["grep", "-l", "typescript-api", "--", ":!pnpm-lock.yaml", ":!package.json"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(out, ["scripts/arraybuffer-sites.mjs", "scripts/site-asset-budget.mjs", "scripts/test-line3-measure.mjs", "scripts/test-line3-size.mjs", "test/arraybuffer-sites.test.ts"]);
  const pkg = JSON.parse(readFileSync(join(ROOT, "node_modules/typescript-api/package.json"), "utf8"));
  assert.equal(pkg.version, "5.9.3");
  for (const k of ["preinstall", "install", "postinstall", "prepare"]) assert.equal(pkg.scripts?.[k], undefined, k);
  const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
  assert.match(lock, /typescript@5\.9\.3:\n {4}resolution: \{integrity: sha512-jl1vZzPDinLr9eUt3J\/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==\}/);
  assert.doesNotMatch(lock.slice(lock.indexOf("  typescript@5.9.3:")).split("\n\n")[0], /requiresBuild/);
});
