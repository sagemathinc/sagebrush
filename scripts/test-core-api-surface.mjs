// ci: checks.5 order=10
// The Core API contract's signature rule (scripts/core-api-surface.mjs widenParams): a widening
// is compatible exactly when every recorded call stays valid with the same binding.
//   node scripts/test-core-api-surface.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseErrors, merge, widenParams } from "./core-api-surface.mjs";

let failures = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else {
    failures++;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

// Parameters as core-api-surface.mjs records them, from a compact spec:
// "obj" (pos, required), "x=" (pos, default), "/a" (posonly), "*more", "kw:" (kwonly required),
// "kw:=" (kwonly default), "**o".
function sig(spec, since = 1) {
  return spec.map((s) => {
    if (s.startsWith("**")) return { name: s.slice(2), kind: "varkw", default: true, since };
    if (s.startsWith("*")) return { name: s.slice(1), kind: "varargs", default: true, since };
    if (s.includes(":")) return { name: s.split(":")[0], kind: "kwonly", default: s.endsWith("="), since };
    if (s.startsWith("/")) return { name: s.slice(1).replace("=", ""), kind: "posonly", default: s.endsWith("="), since };
    return { name: s.replace("=", ""), kind: "pos", default: s.endsWith("="), since };
  });
}
const strip = (ps) => ps.map(({ since, ...p }) => p);
function widen(from, to) {
  return widenParams("m.f", sig(from), strip(sig(to)), 2);
}
const compatible = (name, from, to, newSince) => {
  const w = widen(from, to);
  check(`compatible: ${name}`, w.problems.length === 0, w.problems.join("; "));
  if (newSince) {
    const got = w.params.filter((p) => p.since === 2).map((p) => p.name).join(",");
    check(`compatible: ${name} records only the new parameters at level 2`, got === newSince && w.added, got);
  }
};
const incompatible = (name, from, to) => {
  const w = widen(from, to);
  check(`incompatible: ${name}`, w.problems.length > 0 && !w.added && w.params.every((p) => p.since === 1), "accepted");
};

// the sage case
compatible("show(obj, **o) -> show(obj, *more, **o)", ["obj", "**options"], ["obj", "*more", "**options"], "more");
incompatible("show(obj, **o) -> show(*objs, **o): show(obj=x) would bind into **o", ["obj", "**options"], ["*objs", "**options"]);

// additions that keep every call valid
compatible("unchanged", ["a", "b="], ["a", "b="]);
compatible("append a positional parameter with a default", ["a", "b="], ["a", "b=", "c="], "c");
compatible("add *args", ["a"], ["a", "*rest"], "rest");
compatible("add a keyword-only parameter with a default", ["a", "*r", "k:="], ["a", "*r", "j:=", "k:="], "j");
compatible("reorder keyword-only parameters", ["a", "*r", "k:=", "j:="], ["a", "*r", "j:=", "k:="]);
compatible("add **kwargs", ["a"], ["a", "**kw"], "kw");
compatible("give a required parameter a default", ["a", "b"], ["a", "b="]);
compatible("give a required keyword-only parameter a default", ["a", "*r", "k:"], ["a", "*r", "k:="]);
compatible("add *args and **kwargs together", ["a="], ["a=", "*r", "**kw"], "r,kw");

// changes that break or rebind a call
incompatible("a new required positional parameter", ["a"], ["a", "b"]);
incompatible("a new positional parameter after *args (f(a, b) moves b out of *args)", ["a", "*r"], ["a", "b=", "*r"]);
incompatible("a removed parameter", ["a", "b="], ["a"]);
incompatible("a renamed parameter", ["a", "b="], ["a", "c="]);
incompatible("reordered positional parameters", ["a", "b"], ["b", "a"]);
incompatible("a default removed", ["a", "b="], ["a", "b"]);
incompatible("pos to posonly (f(a=1) stops working)", ["a"], ["/a"]);
incompatible("pos to keyword-only (f(1) stops working)", ["a"], ["a:"]);
incompatible("*args removed", ["a", "*r"], ["a"]);
incompatible("**kwargs removed", ["a", "**kw"], ["a"]);
incompatible("a new required keyword-only parameter", ["a", "*r"], ["a", "*r", "k:"]);
incompatible("a keyword-only default removed", ["a", "*r", "k:="], ["a", "*r", "k:"]);
incompatible("a keyword-only parameter removed", ["a", "*r", "k:="], ["a", "*r"]);

// a recorded **kwargs already receives every keyword, so a new name a keyword
// can address would take it over: f(1, b=2) moves b out of kw
incompatible("f(a, **kw) -> f(a, b=None, **kw)", ["a", "**kw"], ["a", "b=", "**kw"]);
incompatible("f(a, **kw) -> f(a, *, b=None, **kw)", ["a", "**kw"], ["a", "b:=", "**kw"]);
incompatible("f(a, *r, **kw) -> f(a, *r, k=None, **kw)", ["a", "*r", "**kw"], ["a", "*r", "k:=", "**kw"]);
incompatible("f(a, **kw) -> f(a, *more, b=None, **kw)", ["a", "**kw"], ["a", "*more", "b:=", "**kw"]);
compatible("f(a, /, **kw) -> f(a, b=None, /, **kw): positional-only, a keyword b still goes to kw", ["/a", "**kw"], ["/a", "/b=", "**kw"], "b");
compatible("a new keyword-only parameter with no recorded **kwargs, adding **kwargs too", ["a"], ["a", "k:=", "**kw"], "k,kw");
compatible("a recorded keyword-only parameter next to **kwargs", ["a", "*r", "k:=", "**kw"], ["a", "*r", "k:=", "**kw"]);
compatible("a default for a recorded parameter next to **kwargs", ["a", "b", "**kw"], ["a", "b=", "**kw"]);
{
  const w = widen(["a", "**kw"], ["a", "b=", "**kw"]);
  check("the **kwargs rebinding problem names the parameter", w.problems.some((p) => p.includes("new parameter b") && p.includes("**kw")), w.problems.join("; "));
}

// a default given to a recorded parameter is a widening that must be recorded:
// the shorter call enters the contract, and removing the default later fails
{
  const w = widen(["a", "b"], ["a", "b="]);
  check("default added: added", w.added === true);
  check("default added: since kept, default_since = newLevel", w.params[1].since === 1 && w.params[1].default_since === 2 && w.params[0].default_since === undefined, JSON.stringify(w.params));
}
function surface(params, level) {
  return { format: "sagebrush-core-api", api: 1, level, prefixes: [], modules: { m: { since: 1, names: { f: { kind: "function", since: 1, params } } } } };
}
const generated = (spec) => ({ prefixes: [], modules: { m: { names: { f: { kind: "function", params: strip(sig(spec)) } } } } });
function lifecycle(name, from, to, back, index) {
  const recorded = surface(sig(from), 3);
  // --check: merge at level + 1 must report something to record
  const c = merge(recorded, generated(to), 4);
  check(`${name}: --check asks for --update`, c.problems.length === 0 && c.added > 0, `added ${c.added}; ${c.problems.join("; ")}`);
  // --update: what it writes, read back
  const written = JSON.parse(JSON.stringify(c.api));
  const p = written.modules.m.names.f.params[index];
  check(`${name}: --update persists the default`, p.default === true && p.since === 1 && p.default_since === 4, JSON.stringify(p));
  const again = merge(written, generated(to), 5);
  check(`${name}: then --check is clean`, again.problems.length === 0 && again.added === 0, `added ${again.added}; ${again.problems.join("; ")}`);
  const removed = merge(written, generated(back), 5);
  check(`${name}: removing the default later fails`, removed.problems.length > 0, "accepted");
  // a later widening keeps default_since
  const later = merge(written, generated([...to, "**more_kw"]), 5);
  const lp = later.api.modules.m.names.f.params;
  check(`${name}: a later widening keeps since and default_since`, later.problems.length === 0 && lp[index].since === 1 && lp[index].default_since === 4 && lp.at(-1).since === 5, JSON.stringify(lp));
}
lifecycle("positional default", ["a"], ["a="], ["a"], 0);
lifecycle("keyword-only default", ["a", "*r", "k:"], ["a", "*r", "k:="], ["a", "*r", "k:"], 2);
{
  const recorded = surface(sig(["a="]), 3);
  const c = merge(recorded, generated(["a="]), 4);
  check("an unchanged surface records nothing", c.problems.length === 0 && c.added === 0, `added ${c.added}`);
}

// recorded `since` values survive a widening
{
  const rp = sig(["obj", "**options"], 1).map((p, i) => ({ ...p, since: i + 1 }));
  const w = widenParams("m.show", rp, strip(sig(["obj", "*more", "**options"])), 5);
  check("since: kept for recorded parameters, newLevel for new ones", w.params.map((p) => `${p.name}@${p.since}`).join(",") === "obj@1,more@5,options@2", w.params.map((p) => `${p.name}@${p.since}`).join(","));
}

// the base branch's surface (baseErrors): nothing recorded at a level the base has reported unless the base has it
{
  const api = (level, names) => ({ api: 1, level, modules: { m: { since: 1, names } } });
  const f = (params) => ({ kind: "function", since: 1, params });
  const base = api(61, { f: f(sig(["a"], 1)), g: { kind: "class", since: 61, members: { h: f(sig(["x"], 61)) } } });
  check("the base's own surface passes", baseErrors(base, base).length === 0, baseErrors(base, base).join("; "));
  // a branch's parameter recorded at the base's level, kept by a clean text merge
  const merged = api(61, { f: f([...sig(["a"], 1), ...sig(["grow="], 61)]), g: base.modules.m.names.g });
  const e1 = baseErrors(merged, base);
  check("an entry at the base's level the base lacks fails", e1.length === 1 && e1[0].startsWith("m:f(grow) is recorded at level 61"), e1.join("; "));
  // the same addition moved to the next level passes
  const moved = api(62, { f: f([...sig(["a"], 1), ...sig(["grow="], 62)]), g: base.modules.m.names.g });
  check("the same addition at the next level passes", baseErrors(moved, base).length === 0, baseErrors(moved, base).join("; "));
  // a new module and a new member at the base's level
  const mod = { ...moved, modules: { ...moved.modules, n: { since: 61, names: {} } } };
  check("a module at the base's level the base lacks fails", baseErrors(mod, base).some((e) => e.startsWith("module n is recorded at level 61")), baseErrors(mod, base).join("; "));
  const mem = api(62, { f: base.modules.m.names.f, g: { ...base.modules.m.names.g, members: { ...base.modules.m.names.g.members, k: { ...f([]), since: 60 } } } });
  check("a member at a level below the base's the base lacks fails", baseErrors(mem, base).some((e) => e.startsWith("m:g.k is recorded at level 60")), baseErrors(mem, base).join("; "));
  // an entry whose level differs from the base's
  const relevel = api(61, { f: { ...base.modules.m.names.f, since: 2 }, g: base.modules.m.names.g });
  check("an entry re-leveled from the base's fails", baseErrors(relevel, base).some((e) => e.includes("the base branch's surface has it at level 1")), baseErrors(relevel, base).join("; "));
  // a default given at the base's level the base lacks
  const dflt = api(61, { f: f([{ ...sig(["a"], 1)[0], default: true, default_since: 61 }]), g: base.modules.m.names.g });
  check("a default_since at the base's level the base lacks fails", baseErrors(dflt, base).some((e) => e.startsWith("m:f(a)= is recorded at level 61")), baseErrors(dflt, base).join("; "));
  // a reviewed removal recorded at the base's level, which the base doesn't record
  const gone = { ...base, removed: { "m.old": { kind: "function", level: 61 } } };
  check("a removal at the base's level the base lacks fails", baseErrors(gone, base).some((e) => e.startsWith("removed m.old (function) is recorded at level 61")), baseErrors(gone, base).join("; "));
  check("a removal the base records at the same level passes", baseErrors(gone, gone).length === 0, baseErrors(gone, gone).join("; "));
  // a dotted module and a module's name of the same dotted spelling are two entries
  const dotted = { api: 1, level: 61, modules: { a: { since: 1, names: { b: { kind: "function", since: 61, params: "opaque" } } } } };
  const both = { ...dotted, modules: { ...dotted.modules, "a.b": { since: 61, names: {} } } };
  check("module a.b at the base's level fails beside name b of module a", baseErrors(both, dotted).some((e) => e.startsWith("module a.b is recorded at level 61")), baseErrors(both, dotted).join("; "));
  // the level can't fall below the base's
  check("a level below the base's fails", baseErrors(api(60, base.modules.m.names), base).some((e) => e.includes("below the base branch's 61")));
}

// The command line, end to end, on a fixture repository (CORE_API_ROOT, and CORE_API_GENERATED in place of the built
// CLI): a clean text merge that records a branch's parameter at the base's level passes --check alone, fails
// --check --base with the base's ref and the restoring command, and the command the message gives fixes it.
{
  const dir = mkdtempSync(join(tmpdir(), "sb-core-api-base-"));
  const script = join(dirname(fileURLToPath(import.meta.url)), "core-api-surface.mjs");
  const env = { ...process.env, CORE_API_ROOT: dir, CORE_API_GENERATED: join(dir, "generated.json") };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, env, encoding: "utf8" });
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const write = (level, params) => {
    writeFileSync(join(dir, "core-api-surface.json"), JSON.stringify({ format: "sagebrush-core-api", api: 1, level, prefixes: [], modules: { m: { since: 1, names: { f: { kind: "function", since: 1, params } } } }, removed: {} }));
    writeFileSync(join(dir, "src", "pkgset.ts"), `export const CORE_API = 1;\nexport const CORE_API_LEVEL = ${level};\n`);
  };
  try {
    mkdirSync(join(dir, "src"));
    // the base: level 61, f(a)
    write(61, sig(["a"], 1));
    git("init", "-q");
    git("add", "core-api-surface.json", "src/pkgset.ts");
    git("commit", "-q", "-m", "base");
    // the merge: level 61, f(a, grow=) with grow at 61, and the generated surface agreeing
    write(61, [...sig(["a"], 1), ...sig(["grow="], 61)]);
    writeFileSync(env.CORE_API_GENERATED, JSON.stringify({ ...generated(["a", "grow="]), failed: {} }));
    const plain = run("--check");
    check("CLI: the merged surface passes --check alone", plain.status === 0, plain.stderr);
    const guarded = run("--check", "--base", "HEAD");
    check("CLI: --check --base fails on it", guarded.status === 1, `status ${guarded.status}`);
    check("CLI: the message names the entry and the base's level", guarded.stderr.includes("m:f(grow) is recorded at level 61, but the base branch's level 61 surface doesn't have it"), guarded.stderr);
    check("CLI: the message gives the restoring command with the ref", guarded.stderr.includes("git checkout HEAD -- core-api-surface.json && node scripts/core-api-surface.mjs --update"), guarded.stderr);
    // --update on the merged file moves nothing (why the message restores the base's file first)
    const stuck = run("--update");
    check("CLI: --update on the merged file records nothing", stuck.status === 0 && stuck.stdout.includes("is current (level 61)"), stuck.stdout + stuck.stderr);
    // the message's command: the base's file, then --update, then CORE_API_LEVEL
    git("checkout", "HEAD", "--", "core-api-surface.json");
    const up = run("--update");
    check("CLI: --update on the base's file records the parameter at 62", up.status === 0 && up.stdout.includes("level 62"), up.stdout + up.stderr);
    writeFileSync(join(dir, "src", "pkgset.ts"), "export const CORE_API = 1;\nexport const CORE_API_LEVEL = 62;\n");
    const fixed = run("--check", "--base", "HEAD");
    check("CLI: after the fix --check --base passes", fixed.status === 0, fixed.stderr);
    const rec = JSON.parse(readFileSync(join(dir, "core-api-surface.json"), "utf8"));
    check("CLI: grow is recorded at 62", rec.modules.m.names.f.params.find((p) => p.name === "grow")?.since === 62, JSON.stringify(rec.modules.m.names.f.params));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`test-core-api-surface: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
