import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

// The reviewed incompatible changes of the Core API (core-api-changes.json, scripts/core-api-surface.mjs):
// exactly a listed change is recorded, nothing broader; an entry the surface no longer needs is an error.
const ROOT = join(__dirname, "..", "..");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const C = require(join(ROOT, "scripts/core-api-surface.mjs"));

const P = (name: string, kind = "pos", dflt = true, since = 1) => ({ name, kind, default: dflt, since });
const surface = (params: object[], other: object[] = [P("x", "pos", false)]) => ({
  format: "sagebrush-core-api", api: 1, level: 5, prefixes: [],
  modules: { m: { since: 1, names: { f: { kind: "function", since: 1, params }, g: { kind: "function", since: 1, params: other } } } },
});
const OLD = [P("a", "pos", false), P("skiprows")];
const NEW = [P("a", "pos", false), P("skip_header"), P("ndmin", "kwonly")];
const entry = (over: object = {}) => ({ name: "m.f", old: C.signature(OLD), new: C.signature(NEW), reason: "r", pr: 1, ...over });

test("signature: one line per parameter list", () => {
  assert.equal(C.signature(OLD), "(a, skiprows=)");
  assert.equal(C.signature(NEW), "(a, skip_header=, *, ndmin=)");
  assert.equal(C.signature([P("a", "posonly", false), P("b"), P("c", "varargs", false), P("d", "kwonly"), P("e", "varkw", false)]), "(a, /, b=, *c, d=, **e)");
  assert.equal(C.signature("opaque"), "opaque");
});

test("the listed change is recorded exactly; without it, the same change is incompatible", () => {
  const r = C.merge(surface(OLD), surface(NEW), 6, [entry()]);
  assert.deepEqual(r.problems, []);
  assert.equal(r.added, 1);
  assert.deepEqual(r.api.modules.m.names.f.params.map((p: any) => [p.name, p.since]), [["a", 6], ["skip_header", 6], ["ndmin", 6]]);
  assert.match(C.merge(surface(OLD), surface(NEW), 6, []).problems.join(), /m\.f: parameter skiprows changed or removed/);
});

test("nothing broader: another function, another new or old signature, are still incompatible", () => {
  // (an unlisted function changed the same way)
  const other = C.merge(surface(OLD, OLD), surface(NEW, NEW), 6, [entry()]);
  assert.deepEqual(other.problems, ["m.g: parameter skiprows changed or removed (an incompatible signature change)"]);
  // (the listed function, to a new signature the entry doesn't name)
  const NEW2 = [P("a", "pos", false), P("skip_header"), P("ndmin", "kwonly"), P("extra", "kwonly", false)];
  assert.notDeepEqual(C.merge(surface(OLD), surface(NEW2), 6, [entry()]).problems, []);
  // (the listed function from an old signature the entry doesn't name)
  const OLD2 = [P("a", "pos", false), P("skiprows"), P("usecols")];
  assert.notDeepEqual(C.merge(surface(OLD2), surface(NEW), 6, [entry()]).problems, []);
});

test("an entry the surface no longer needs is an error; a needed one isn't", () => {
  assert.deepEqual(C.staleChanges(surface(NEW), [entry()]), []);
  // (not applied yet: the recorded signature is the old one)
  assert.match(C.staleChanges(surface(OLD), [entry()]).join(), /m\.f is not needed by the surface \(recorded \(a, skiprows=\)/);
  // (changed again since, or gone)
  assert.equal(C.staleChanges(surface([P("a", "pos", false)]), [entry()]).length, 1);
  assert.match(C.staleChanges(surface(NEW), [entry({ name: "m.h" })]).join(), /m\.h is not needed by the surface \(recorded \(absent\)/);
});

test("the changes file's shape: every field, old != new, one entry per name", () => {
  const doc = (changes: object[]) => JSON.stringify({ format: "sagebrush-core-api-changes", changes });
  assert.equal(C.readChanges(doc([entry()])).length, 1);
  for (const bad of [{ reason: "" }, { pr: "1" }, { new: C.signature(OLD) }, { name: 3 }]) assert.throws(() => C.readChanges(doc([entry(bad)])), /a bad entry/);
  assert.throws(() => C.readChanges(doc([entry(), entry()])), /two entries for one name/);
  assert.throws(() => C.readChanges(JSON.stringify({ changes: [] })), /not \{format/);
});
