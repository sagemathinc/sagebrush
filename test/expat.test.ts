import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// pyexpat and xml.parsers.expat (P3c-1; the design note r3 all five lanes cleared): lib/pyexpat.py is a Python port of
// expat 2.9.0, the expat CPython 3.14.10 bundles, and its pyexpat glue. The oracle is CPython 3.14.10 (CI's "3.14"):
// test/gen_expat_corpus.py, run there, recorded test/expat_corpus.json, every case's handler events, errors, codes and
// positions, whole and in chunks, through test/expat_trace.py. Here:
//   - the corpus's provenance: the generator and the tracer it was recorded with are the committed ones;
//   - CPython's own pyexpat replays the recording (python3: the recording is the oracle's, not a memory of it);
//   - the CLI gives every case CPython's result, except the cases test/expat_divergences.json states, which must give
//     the result stated there and still differ (the codecs Sagebrush doesn't have);
//   - test/expat_api_cases.py, the module's interface, prints what CPython prints, line for line;
//   - test/expat_rules.py, what is Sagebrush's own: the allocation tracker, the work bounds, the scan window, no I/O,
//     the stated interface refusals;
//   - lib/pyexpat.py imports re, types and sys (sys.modules alone) and calls nothing that reaches a file or runs code.
// (The browser worker: web/test-expat-worker.mjs, the whole-document cases and the interface lines.)
const ROOT = join(__dirname, "..", "..");
const CLI = join(__dirname, "..", "src", "cli.js");
const T = (f: string) => join(ROOT, "test", f);
const sha256 = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const corpus = JSON.parse(readFileSync(T("expat_corpus.json"), "utf8"));
const cli = (args: string[]) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 1 << 26 });
const py = (args: string[]) => execFileSync("python3", args, { encoding: "utf8", maxBuffer: 1 << 26 });

test("expat_corpus.json: recorded on CPython 3.14.10's expat 2.9.0 by the committed generator and tracer", () => {
  const p = corpus.provenance;
  assert.ok(p.python.startsWith("3.14.10 "), p.python);
  assert.equal(p.expat, "expat_2.9.0");
  assert.equal(p.generator_sha256, sha256(T("gen_expat_corpus.py")), "regenerate: python3.14.10 test/gen_expat_corpus.py");
  assert.equal(p.trace_sha256, sha256(T("expat_trace.py")), "regenerate: python3.14.10 test/gen_expat_corpus.py");
  assert.ok(corpus.cases.length > 2000);
  const groups = new Set(corpus.cases.map((c: { group: string }) => c.group));
  for (const g of ["well-formed", "line-ends", "malformed", "encoded", "protocol", "handlers", "namespaces", "amplification", "amplification-defaults", "long"]) assert.ok(groups.has(g), g);
});

test("CPython's own pyexpat replays the recording, every case", () => {
  const v = py(["-c", "import sys, pyexpat; print(sys.version.split()[0], pyexpat.EXPAT_VERSION)"]).trim();
  assert.equal(v.split(" ")[1], corpus.provenance.expat, `python3 ${v}: the oracle is CPython 3.14.10 (expat 2.9.0)`);
  const r = JSON.parse(py([T("expat_run.py")]));
  assert.deepEqual(r.mismatches, []);
  assert.deepEqual([r.cases, r.mismatch_count, r.tables_equal], [corpus.cases.length, 0, true]);
});

test("the CLI's pyexpat gives every case CPython's events, errors and positions, the stated divergences excepted", () => {
  const r = JSON.parse(cli([T("expat_run.py"), "--sagebrush"]));
  const divergences = JSON.parse(readFileSync(T("expat_divergences.json"), "utf8"));
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.mismatch_count, 0);
  assert.deepEqual(r.stated_but_same, [], "a stated divergence that now gives CPython's result: remove it");
  assert.deepEqual(r.stated_but_other, [], "a stated divergence that gives neither");
  assert.equal(r.diverged, divergences.cases.length);
  assert.equal(r.cases, corpus.cases.length);
  assert.equal(r.tables_equal, true, "the error codes and messages, version_info and features");
  // (each divergence is a codec Sagebrush doesn't have, named by its declaration, and the error says so)
  for (const d of divergences.cases) {
    assert.equal(d.sagebrush.error.type, "LookupError", d.key);
    assert.match(d.sagebrush.error.msg, /^unknown encoding: (koi8-r|shift_jis)$/, d.key);
  }
});

test("expat_api_cases.py: the module, ParserCreate, the parser's attributes and methods, as CPython 3.14.10 prints them", () => {
  const want = py([T("expat_api_cases.py")]).split("\n");
  const got = cli([T("expat_api_cases.py")]).split("\n");
  assert.ok(want.length > 50, "the cases ran under CPython");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `expat_api_cases.py line ${i + 1}`);
});

test("expat_rules.py: the allocation tracker, linear work, the scan window, no I/O, the stated refusals", () => {
  const r = JSON.parse(cli([T("expat_rules.py")]));
  // expat's out of memory (1) once the tracker's limits are passed, raised before the growth: no event after it, and
  // nothing held after the end; a flat document under the factor parses whole
  assert.deepEqual(r.tracker_deep, [1, 3, 0]);
  assert.deepEqual(r.tracker_deep_chunked, [1, true, 0]);
  assert.deepEqual(r.tracker_flat_under, [null, 201, 0]);
  assert.deepEqual(r.tracker_wide_tag, [1, []]);
  assert.deepEqual(r.tracker_zero, [1, 0]);
  // one-byte feeds with reparse deferral: scanned at most 6n characters, copied at most 7n, one attempt per feed;
  // without deferral, expat's own quadratic rescans (stated, as CPython's are)
  for (const k of ["comment", "attribute", "tokens"]) assert.deepEqual(r.work[k], [null, true, true, true], k);
  assert.deepEqual(r.work["no deferral (expat's quadratic, stated)"], [null, true, true]);
  // every whole-document case again with each windowed scan cut at 7 characters
  assert.equal(r.window_7[1], 0, JSON.stringify(r.window_7[2]));
  assert.ok(r.window_7[0] > 400);
  assert.deepEqual(r.window_7.slice(3), [[], []]);
  // external DTDs and entities, SYSTEM and PUBLIC, parameter and unparsed: nothing opened, listed or stat-ed;
  // (16: expat's reference to an external entity in an attribute value)
  assert.deepEqual(r.no_io, [[], ["ok", "ok", "ok", "ok", "ok", "ok", 16, "ok"]]);
  assert.deepEqual(r.interface, [
    ["ExternalEntityRefHandler", "NotImplementedError", "pyexpat.xmlparser.ExternalEntityRefHandler is not supported in Sagebrush: the parser reads no external entity, and builds no element content model"],
    ["ElementDeclHandler", "NotImplementedError", "pyexpat.xmlparser.ElementDeclHandler is not supported in Sagebrush: the parser reads no external entity, and builds no element content model"],
    ["SetParamEntityParsing(1)", "NotImplementedError", "parameter entity parsing is not supported in Sagebrush: the parser reads no external DTD or parameter entity"],
    ["SetParamEntityParsing(0)", "returned", 1],
    ["UseForeignDTD()", "NotImplementedError", "UseForeignDTD is not supported in Sagebrush: the parser reads no external DTD"],
    ["ExternalEntityParserCreate", "NotImplementedError", "external entity parsers are not supported in Sagebrush: the parser reads no external entity"],
    ["expat_CAPI", false],
  ]);
});

test("lib/pyexpat.py imports re, types and sys (for sys.modules alone), and names nothing that reaches a file or runs code", () => {
  const census = JSON.parse(py(["-c", [
    "import ast, json, sys",
    "tree = ast.parse(open(sys.argv[1], encoding='utf-8').read())",
    "imports = sorted({a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names} | {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)})",
    "bad = {'open', 'exec', 'eval', 'compile', '__import__', 'globals', 'vars', 'breakpoint', 'input', 'importlib', 'io', 'os', 'sys', 'urllib', 'socket'}",
    // (names only: the modules it can reach are its two imports; re's compile and an entity's open flag are attributes)
    "named = sorted({n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and n.id in bad})",
    // (sys for sys.modules alone: the submodules registered by name, as the C module does)
    "uses_sys = sorted({n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == '_sys'})",
    "print(json.dumps([imports, named, uses_sys]))",
  ].join("\n"), join(ROOT, "lib", "pyexpat.py")]));
  assert.deepEqual(census, [["re", "sys", "types"], [], ["modules"]]);
});
