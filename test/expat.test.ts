import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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
//   - test/expat_rules.py, what is Sagebrush's own: the allocation tracker and its admission, the trackers' boundaries,
//     the two ledgers, the work (every pattern and string scan under a spy), the window, no I/O, the stated refusals;
//   - Stop during a long parse and a large expansion (test/expat_stop.py);
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

// (test/expat_rules.py, once: raw numbers, the bounds stated here)
let rulesOut: any = null;
const rules = () => (rulesOut ??= JSON.parse(cli([T("expat_rules.py")])));
const W = 1 << 20;

test("expat_rules.py: the allocation tracker refuses past its limits, before the growth, and releases everything after", () => {
  const r = rules();
  assert.deepEqual(r.tracker_deep, [1, 12, 0]);
  assert.deepEqual(r.tracker_deep_chunked, [1, true, 0]);
  assert.deepEqual(r.tracker_flat_under, [null, 201, 0]);
  assert.deepEqual(r.tracker_wide_tag, [1, ["r"]]);
  assert.deepEqual(r.tracker_zero, [1, 0]);
  // (admission, astra's X1: an expanded attribute value, an entity value, many and fallback attributes: refused at
  // the charge; no start event with what it would have paid for. The declaration of an entity whose value was
  // refused is reported with the value stored so far before the error, as expat's doProlog does)
  assert.deepEqual(r.admission, {
    "attribute expansion": [1, [["ED", "e", 300]], 0],
    "entity value": [1, [["ED", "e", 0]], 0],
    "many pieces": [1, [["ED", "e", 1]], 0],
    "many character references": [1, [], 0],
    "many attributes": [1, [], 0],
    "fallback attributes": [1, [], 0],
    // (grader's L5: getAtts's ten span entries charged one after another, before each is added; at a threshold equal
    // to the total at the fifth: refused there, four admitted; one byte over: the fifth admitted, the sixth refused)
    "getAtts entries": [true, [1, 4], [1, 5]],
  });
});

test("expat_rules.py: the trackers' boundaries, each at, just under and just over (grader's A4, A5, A6)", () => {
  const b = rules().boundaries;
  const [total, direct] = b.tracker_first;
  assert.ok(total > 0 && direct > 0, JSON.stringify(b.tracker_first));
  // (the allocation tracker: refused at a total equal to the activation threshold, admitted one byte under it; at
  // the maximum factor exactly admitted, just under it refused: the first charge's outcome is what differs)
  assert.deepEqual([b["tracker act at"][2], b["tracker act over"][2], b["tracker amp at"][2], b["tracker amp under"][2]], [0, 1, 1, 0]);
  // (the amplification check: the output at the threshold checked, one byte under not; the factor at the maximum
  // tolerated, just over it not)
  assert.deepEqual(b.amplification_point, [75, 40]);
  assert.deepEqual(b["amplification act at"], [43, ["r"], b["amplification act at"][2]]);
  assert.deepEqual(b["amplification act over"].slice(0, 2), [43, ["r", 40]]);
  assert.deepEqual(b["amplification amp at"].slice(0, 2), [43, ["r", 40]]);
  assert.deepEqual(b["amplification amp under"].slice(0, 2), [43, ["r"]]);
  // (no direct bytes yet: the accounting's factor is expat's (22 + indirect) / 22, the tracker's is infinite)
  assert.deepEqual(b["zero direct"], ["ok", 43, 1]);
});

test("expat_rules.py: the two ledgers: flushes leave the same state, parts are charged whole, cleanup clears the objects", () => {
  const l = rules().ledger;
  // (X2: four buffered feeds of text and references, each flushed at its Parse's end: identical states)
  assert.deepEqual(l.flushes, Array(4).fill([484, 0, [0, 0, 0, 0, 0]]));
  // (X1: 100 one-byte parts waiting, 24 of them not yet joined: each a string and a list entry, 2 + 64 + 96)
  assert.deepEqual(l.parts, [24, [484, 4112, [24 * 162, 0, 224, 0, 0]]]);
  assert.deepEqual(l.parts_end, [[0, 0, [0, 0, 0, 0, 0]], 0, 0, 0]);
  // (grader's B2: the buffered fragments "ab", "&", "cd", each a string and an entry, as each token is accounted;
  // and each token's own copies, four strings of its length: <r>, ab, &amp;, cd, </r>)
  assert.deepEqual(l.fragments, [[0, 280], [0, 272], [164, 296], [326, 272], [490, 288]]);
  // (every Parse's return, fed in pieces: the buffers ledger is exactly its slots, never more than four times what
  // waits plus its parts' overhead, and both ledgers are empty at the end)
  for (const [i, x] of l.invariants.entries()) {
    assert.equal(x[0], 0, `fixture ${i}: buffers = its slots`);
    assert.ok(x[1] <= 0, `fixture ${i}: buffers linear in what waits (${x[1]})`);
    assert.deepEqual(x[3], [0, 0, [0, 0, 0, 0, 0]], `fixture ${i}: empty at the end`);
  }
  // (an error: the objects gone, the span kept for the positions charged; an exception in a handler: all gone)
  assert.deepEqual(l.error, [7, [0, 90, [0, 0, 90, 0, 0]], [], "", [], 13]);
  assert.deepEqual(l.exception, [[0, 0, [0, 0, 0, 0, 0]], [], "", []]);
  // (r2.1, astra's X1b and X2b: isfinal raising leaves nothing charged; an exception in the end-of-call flush stops
  // the parser, its objects and both ledgers released)
  assert.deepEqual(l.bad_isfinal, [0, 0, [0, 0, 0, 0, 0]]);
  assert.deepEqual(l.end_flush_exception, [[0, 0, [0, 0, 0, 0, 0]], [], "", [], true]);
});

test("expat_rules.py: no pattern or string scan examines more than the window, at the shipped 1 MiB and at 7 characters", () => {
  const r = rules();
  assert.equal(r.window, W, "the shipped window (grader's W1)");
  assert.deepEqual(r.spy_unwrapped, [], "every compiled pattern of the module is under the spy");
  // (a 3 MiB attribute the fast path leaves to getAtts: every call bounded, the largest exactly the window)
  assert.equal(r.span_default.err, null);
  assert.equal(r.span_default.unbounded, 0);
  assert.equal(r.span_default.max, W);
  // (the corpus's whole documents with every window 7 characters: CPython's results, and no call over 7)
  const [cases, mismatches, first, same, other, spy] = r.window_7;
  assert.equal(mismatches, 0, JSON.stringify(first));
  assert.ok(cases > 400);
  assert.deepEqual([same, other], [[], []]);
  assert.equal(spy.unbounded, 0);
  assert.equal(spy.max, 7);
  // (r2.1, astra's X3b and daybreak3's E3: a str's encoding error is CPython's, built from windows, never the whole
  // string encoded again; a comment's and a PI's line ends normalized a window at a time, every seam right)
  const [encSame, enc, seams, wholeEncodes, replacedWhole] = r.window_7_extras;
  assert.ok(encSame, JSON.stringify(enc));
  assert.equal(seams, true);
  assert.deepEqual(wholeEncodes, [], "no encode of the whole string");
  assert.equal(replacedWhole, true, "the line ends replaced a window at a time, every call seen");
});

// (grader's span bound, P3c-1's optional note: _run_to never reads past its end, whatever the callers stop on; a run
// longer than end, at ends inside and on the 7-character windows' seams)
test("pyexpat._run_to stops at its end bound, never past it, across window seams", () => {
  const src = `import re, pyexpat
r = re.compile("a*")
pyexpat._WINDOW = 7
print([pyexpat._run_to(r, "a" * 20, 0, e) for e in (0, 3, 7, 8, 14, 15, 20)], pyexpat._run_to(r, "aaab", 0, 20))`;
  assert.equal(cli(["-c", src]), "[0, 3, 7, 8, 14, 15, 20] 3\n");
});

test("expat_rules.py: the work is linear: examined characters and steps, calls and copies, against their lower controls", () => {
  const w = rules().work;
  for (const [label, [a, b]] of Object.entries(w) as [string, any[]][]) {
    if (label.startsWith("control")) continue;
    const work = (x: any) => x.examined + x.bt;
    for (const x of [a, b]) {
      assert.equal(x.err, null, label);
      assert.equal(x.unbounded, 0, label);
      // (every byte is decoded, and examined and copied at least once; every character scanned (n counts bytes, at most
      // four a character): the counters see the work)
      assert.ok(work(x) >= x.n && x.copied >= x.n && x.decoded >= x.n && 4 * x.scanned >= x.n, `${label}: lower controls ${JSON.stringify(x)}`);
      assert.ok(work(x) <= 20 * x.n, `${label}: examined + steps <= 20n (${work(x)} for n = ${x.n})`);
      assert.ok(x.copied <= 10 * x.n, `${label}: copied <= 10n (${x.copied} for n = ${x.n})`);
      assert.ok(x.calls <= 4 * x.n + 64, `${label}: calls <= 4n + 64 (${x.calls})`);
    }
    // (four times the input: at most 4.6 times the work and the copies)
    assert.ok(work(b) <= 4.6 * work(a) && b.copied <= 4.6 * a.copied, `${label}: scaling ${work(a)} -> ${work(b)}`);
  }
  // (the old attribute path made a call per tab or space; now a run of them is one call, whatever its length)
  for (const label of ["tabs attribute", "fallback attribute"]) assert.ok(w[label][1].calls <= 64 && w[label][1].calls === w[label][0].calls, `${label}: calls ${w[label].map((x: any) => x.calls)}`);
  // (the positive control: expat's own rescans with reparse deferral off are quadratic, and the counters show it)
  const [c1, c4] = w["control: no deferral, 1-byte feeds"];
  for (const x of [c1, c4]) assert.ok(x.examined + x.bt >= (x.n * x.n) / 8 && x.copied >= (x.n * x.n) / 8, JSON.stringify(x));
  assert.ok((c4.examined + c4.bt) >= 12 * (c1.examined + c1.bt));
});

test("expat_rules.py: no I/O for any external identifier, and the stated refusals", () => {
  const r = rules();
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

// Stop (#849 r2; design note r3 section 4a): Ctrl-C during one long Parse call (28 MB of elements) and during a large
// expansion (references expanding to 50 MB of text), the program run as the launcher runs it (packages/sagebrush/
// bin/sagebrush.cjs: a Worker, the launcher's thread setting the interrupt flag on SIGINT), here on dist/src/cli.js.
// The child prints "begun" from a handler once the parse is well under way; SIGINT follows. What is pinned is the
// outcome, never a time: KeyboardInterrupt out of Parse, the parse far from its end, no event after it, both ledgers
// and everything the parser held released, and a later Parse "parsing finished" (36). (The work between two checks
// for the flag is bounded by the window: the spy's test above.)
const stopBoot = (mode: string) => `
const { Worker } = require("node:worker_threads");
let intr = null;
process.on("SIGINT", () => { if (intr) { Atomics.or(intr, 0, 1); Atomics.notify(intr, 0); } });
const w = new Worker(${JSON.stringify(`require(${JSON.stringify(CLI)});`)}, { eval: true, stdout: true, stderr: true,
  workerData: { sagebrushCli: { argv: ${JSON.stringify([T("expat_stop.py"), mode])}, limits: null, entry: ${JSON.stringify(CLI)} } } });
w.on("message", (m) => { if (m && m.interrupt) intr = new Int32Array(m.interrupt); });
w.on("exit", (c) => { process.exitCode = c; });`;

for (const mode of ["parse", "expansion"]) {
  test(`Stop during a long ${mode === "parse" ? "parse" : "expansion"}: KeyboardInterrupt, nothing after it, everything released`, async () => {
    const p = spawn(process.execPath, ["-e", stopBoot(mode)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let sent = false;
    // (a guard against a hang, not a bound: the parse runs about a minute uninterrupted)
    const guard = setTimeout(() => p.kill("SIGKILL"), 600000);
    p.stdout.on("data", (d) => {
      out += d;
      if (!sent && out.includes("begun\n")) {
        sent = true;
        p.kill("SIGINT");
      }
    });
    p.stderr.on("data", (d) => (err += d));
    const [code, signal] = await new Promise<[number | null, string | null]>((res) => p.on("close", (c, s) => res([c, s])));
    clearTimeout(guard);
    assert.deepEqual([code, signal, err], [0, null, ""], out);
    const lines = out.trim().split("\n");
    assert.equal(lines[0], "begun");
    const r = JSON.parse(lines[lines.length - 1]);
    assert.equal(r.outcome, "KeyboardInterrupt");
    assert.ok(r.events >= 1000 && r.events < r.total / 10, `stopped early: ${r.events} of ${r.total} events`);
    assert.deepEqual([r.events_after, r.owned, r.buffers, r.held, r.again], [0, 0, 0, [0, 0, 0, 0], 36]);
  });
}

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
