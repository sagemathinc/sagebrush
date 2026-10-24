// The Core API contract's signature rule (scripts/core-api-surface.mjs widenParams): a widening
// is compatible exactly when every recorded call stays valid with the same binding.
//   node scripts/test-core-api-surface.mjs

import { widenParams } from "./core-api-surface.mjs";

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

// recorded `since` values survive a widening
{
  const rp = sig(["obj", "**options"], 1).map((p, i) => ({ ...p, since: i + 1 }));
  const w = widenParams("m.show", rp, strip(sig(["obj", "*more", "**options"])), 5);
  check("since: kept for recorded parameters, newLevel for new ones", w.params.map((p) => `${p.name}@${p.since}`).join(",") === "obj@1,more@5,options@2", w.params.map((p) => `${p.name}@${p.since}`).join(","));
}

console.log(`test-core-api-surface: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
