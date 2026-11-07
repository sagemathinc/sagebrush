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

test("--check reports a stale entry (checkErrors, what the CLI's --check runs): a surface already at the entry's new signature passes, one elsewhere fails", () => {
  const consts = { api: 1, level: 5 };
  // (applied: the recorded surface has the new signature, the generated one too)
  assert.deepEqual(C.checkErrors(surface(NEW), surface(NEW), [entry()], consts, 100), []);
  // (stale: the function moved on since; nothing else differs)
  const LATER = [P("a", "pos", false), P("skip_header"), P("ndmin", "kwonly"), P("like", "kwonly")];
  const errs = C.checkErrors(surface(LATER), surface(LATER), [entry()], consts, 100);
  assert.deepEqual(errs, ["core-api-changes.json: m.f is not needed by the surface (recorded (a, skip_header=, *, ndmin=, like=), the entry's new (a, skip_header=, *, ndmin=)): remove the entry"]);
  // (an entry for a name the surface doesn't have)
  assert.equal(C.checkErrors(surface(NEW), surface(NEW), [entry(), entry({ name: "m.zz" })], consts, 100).length, 1);
  // (and the rest of --check: a listed change not yet recorded, the level, the caps)
  assert.match(C.checkErrors(surface(OLD), surface(NEW), [entry()], consts, 100).join("|"), /1 addition\(s\) or widening\(s\)/);
  assert.match(C.checkErrors(surface(NEW), surface(NEW), [entry()], { api: 1, level: 4 }, 100).join(), /src\/pkgset\.ts has CORE_API 1 level 4/);
  assert.match(C.checkErrors(surface(NEW), surface(NEW), [entry()], consts, 10 * 1024 * 1024).join(), /over its caps/);
});

// (reviewed REMOVALS, upstream's: @sagebrush's ruling on P3b-1, Nov 7. CPython 3.14.10's pathlib no longer has
// PureWindowsPath.ntpath, a class attribute 3.14.4's class body made with `import ntpath`)
const withMember = (members: object) => ({
  format: "sagebrush-core-api", api: 1, level: 5, prefixes: [],
  modules: { m: { since: 1, names: { C: { kind: "class", since: 1, members }, k: { kind: "module", since: 1 } } } },
});
const removal = (over: object = {}) => ({ name: "m.C.ntpath", old: "(module)", new: "(absent)", upstream: "CPython 3.14.10", reason: "r", pr: 1, ...over });

test("a listed removal is recorded exactly (the member goes, the level rises); unlisted removals still fail", () => {
  const before = withMember({ ntpath: { kind: "module", since: 1 }, keep: { kind: "module", since: 1 } });
  const after = withMember({ keep: { kind: "module", since: 1 } });
  const r = C.merge(before, after, 6, [removal()]);
  assert.deepEqual(r.problems, []);
  assert.equal(r.added, 1);
  assert.equal("ntpath" in r.api.modules.m.names.C.members, false);
  // (without the entry, the same removal fails)
  assert.deepEqual(C.merge(before, after, 6, []).problems, ["m.C.ntpath: removed"]);
  // (an unlisted member removed beside the listed one: still a problem, the listed one isn't)
  assert.deepEqual(C.merge(before, withMember({}), 6, [removal()]).problems, ["m.C.keep: removed"]);
  // (a module-level name, listed and unlisted)
  const noK = { ...after, modules: { m: { since: 1, names: { C: after.modules.m.names.C } } } };
  assert.deepEqual(C.merge(after, noK, 6, [removal({ name: "m.k" })]).problems, []);
  assert.deepEqual(C.merge(after, noK, 6, [removal()]).problems, ["m.k: removed"]);
});

test("a removal entry applies only to its exact name and kind", () => {
  const before = withMember({ ntpath: { kind: "module", since: 1 } });
  const after = withMember({});
  // (another kind: the recorded member is a module, the entry says function)
  assert.deepEqual(C.merge(before, after, 6, [removal({ old: "(function)" })]).problems, ["m.C.ntpath: removed"]);
  // (another name)
  assert.deepEqual(C.merge(before, after, 6, [removal({ name: "m.C.other" })]).problems, ["m.C.ntpath: removed"]);
  // (a signature entry for the name, not a removal, doesn't remove it)
  assert.deepEqual(C.merge(before, after, 6, [entry({ name: "m.C.ntpath" })]).problems, ["m.C.ntpath: removed"]);
  // (nor one with the removal's own old string but another new: only new "(absent)" removes; grader's U5)
  assert.deepEqual(C.merge(before, after, 6, [removal({ new: "(module2)" })]).problems, ["m.C.ntpath: removed"]);
  // (a prefix of the name, a class or a shorter member name, excuses nothing longer; grader's U4)
  for (const name of ["m.C", "m.C.nt", "m"]) assert.deepEqual(C.merge(before, after, 6, [removal({ name })]).problems, ["m.C.ntpath: removed"], name);
});

test("a removal entry's shape: the kind in parentheses and the upstream release that removed it", () => {
  const doc = (changes: object[]) => JSON.stringify({ format: "sagebrush-core-api-changes", changes });
  assert.equal(C.readChanges(doc([removal()])).length, 1);
  for (const bad of [{ upstream: undefined }, { upstream: "" }, { upstream: 3 }, { old: "module" }, { old: "(m o)" }, { old: "()" }, { reason: "" }, { pr: "1" }, { pr: undefined }]) assert.throws(() => C.readChanges(doc([removal(bad)])), /a bad entry/, JSON.stringify(bad));
  // (one already applied is not stale; one whose member is still recorded is)
  assert.deepEqual(C.staleChanges(withMember({}), [removal()]), []);
  assert.equal(C.staleChanges(withMember({ ntpath: { kind: "module", since: 1 } }), [removal()]).length, 1);
});
