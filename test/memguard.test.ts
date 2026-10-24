// The memory guards' one message and error type (item D, D1; plan
// plan-d-memory-message r3): lib's _memguard.memory_guard, its TypeScript
// twin, the D1 sites (dense finite-field matrices, general matrices, dense
// polynomial conversion, Magma's collection bound) at their unchanged
// predicates, and the reports of Magma and MATLAB.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { libDir } from "../src/compile";
import { R } from "../src/runtime/index";
import { importModule, memoryGuard } from "../src/runtime/modules";
import { getattr, callObj, isinstance } from "../src/runtime/object";

void R;
const cli = join(__dirname, "..", "src", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "sb-memguard-"));
const WALL = (ms: number) => ms * (Number(process.env.SAGEBRUSH_TIME_SCALE) || 1);

function run(mode: string, code: string, ext: string) {
  const f = join(dir, "t" + Math.random().toString(36).slice(2) + ext);
  writeFileSync(f, code);
  return spawnSync(process.execPath, [cli, mode, f], { encoding: "utf8", timeout: WALL(120000) });
}

test("the TypeScript twin raises lib's class with lib's text and exact sizes, a bigint past 2^53 too", () => {
  const path = importModule("sys").path;
  if (!path.includes(libDir())) path.push(libDir());
  const G = importModule("_memguard");
  const cases: [string, number | bigint, number | bigint, string][] = [
    ["A 20000 x 20000 matrix over GF(7)", 3_200_000_001, 1_000_000_000, "one matrix"],
    ["This list of 10^20 elements", 10n ** 21n, 2n ** 33n, "one list"],
    ["A string", 5, 0, "one string"],
  ];
  for (const [what, need, limit, allowance] of cases) {
    let caught: any = null;
    try {
      memoryGuard(what, need, limit, allowance);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught && isinstance(caught, getattr(G, "SagebrushMemoryError")));
    assert.ok(isinstance(caught, importModule("builtins").MemoryError));
    const norm = (x: any) => (typeof x === "bigint" ? x : BigInt(x));
    assert.equal(norm(getattr(caught, "need_bytes")), norm(need));
    assert.equal(norm(getattr(caught, "limit_bytes")), norm(limit));
    assert.equal(getattr(caught, "what"), what);
    for (const k of ["record", "partial", "checkpoint"]) assert.equal(getattr(caught, k), null);
    const want = callObj(getattr(G, "message"), [what, need, limit, allowance]);
    assert.equal(R.str(caught), want);
  }
});

test("each D1 site raises SagebrushMemoryError past its unchanged predicate, before anything is built (limit - 1, limit, limit + 1)", () => {
  const r = run("--sage", [
    "import _memguard, _sage_matrix as SM, _sage_ffmat as FM",
    "E = _memguard.SagebrushMemoryError",
    "def guard(f):",
    "    try:",
    "        f()",
    "        return 'admitted'",
    "    except MemoryError as e:",
    "        assert type(e) is E and type(e).__bases__ == (MemoryError,)",
    "        assert (e.record, e.partial, e.checkpoint) == (None, None, None)",
    "        return '%s | %d %d %s' % (str(e).splitlines()[1], e.need_bytes, e.limit_bytes, e.allowance_for)",
    // general matrices: the count predicate, at a limit of 100 slots
    "for m, n in [(9, 11), (10, 10), (10, 11), (101, 0)]:",
    "    print(guard(lambda: SM._shape(m, n, 100)))",
    // finite-field matrices: the heap share, with a spy on the constructor
    "made = []",
    "init = FM.FFMatrix.__init__",
    "def spy(self, *a, **k):",
    "    made.append(1)",
    "    return init(self, *a, **k)",
    "FM.FFMatrix.__init__ = spy",
    "F = GF(7)",
    "c = FM._entry_cost(F)",
    "FM._heap_limit = lambda: FM._HEAP_SHARE * c * 1000",
    "for m, n in [(10, 99), (10, 100), (10, 101)]:",
    "    del made[:]",
    "    print(guard(lambda: matrix(F, m, n)), len(made))",
    "print(guard(lambda: FM._admit_size(F, 10, 50, 3)))",
    // dense conversion: degree 2^20 - 1 converts, 2^20 is refused
    "S = PolynomialRing(QQ, 't,w'); R = QQ['t']",
    "print(guard(lambda: R(S.gen(0)^(2^20 - 1))))",
    "print(guard(lambda: R(S.gen(0)^(2^20))))",
  ].join("\n") + "\n", ".sage");
  assert.equal(r.stderr, "");
  const lines = r.stdout.split("\n");
  assert.deepEqual(lines.slice(0, 6), [
    "admitted",
    "admitted",
    "A 10 x 11 matrix needs about 880 bytes, but Sagebrush allows about 800 bytes for one matrix here. | 880 800 one matrix",
    "A 101 x 0 matrix needs about 808 bytes, but Sagebrush allows about 800 bytes for one matrix here. | 808 800 one matrix",
    "admitted 1",
    "admitted 1",
  ], r.stdout);
  const rest = r.stdout.split("\n").slice(6);
  assert.match(rest[0], /^A 10 x 101 matrix over Finite Field of size 7 needs about .*, but Sagebrush allows about .* for one matrix here\. \| \d+ \d+ one matrix 0$/);
  const [need, limit] = rest[0].split(" | ")[1].split(" ").map(Number);
  assert.ok(need > limit, rest[0]);
  assert.match(rest[1], /^A 10 x 50 matrix over Finite Field of size 7 with its working space needs about /);
  assert.equal(rest[2], "admitted");
  assert.equal(rest[3], "Converting this polynomial of degree 1048576 to a dense one needs about 8.4 MB, but Sagebrush allows about 8.3 MB for this conversion here. | 8388616 8388608 this conversion");
});

test("the message names the routes of where Sagebrush runs: the command line here", () => {
  const r = run("--sage", "import _memguard\nprint(_memguard.where())\ntry:\n    matrix(QQ, 10^5, 10^5)\nexcept MemoryError as e:\n    print(e)\n", ".sage");
  assert.equal(r.stderr, "");
  assert.equal(r.stdout, [
    "cli",
    "Not enough memory for this computation.",
    "A 100000 x 100000 matrix needs about 80 GB, but Sagebrush allows about 33 MB for one matrix here.",
    "To run it with more memory:",
    "- give this Sagebrush more memory with NODE_OPTIONS=--max-old-space-size=<MiB>",
    "  (the engines keep their 4 GB);",
    "- or use the Python package (pip install sagebrush): on your own computer, in",
    "  a cocalc.ai project, or on a dedicated machine with as much memory as it",
    "  needs, rented through cocalc.ai.",
    "",
  ].join("\n"));
});

test("Magma reports a memory guard's refusal as a runtime error in the guard's words, never as 'not supported yet', and its error keeps the six fields", () => {
  const r = spawnSync(process.execPath, [cli, "--magma"], {
    input: "T := [ <x, y> : x, y in [1..3000] ];\n\"end\";\n", encoding: "utf8", timeout: WALL(120000),
  });
  assert.equal(r.stderr, "");
  const out = r.stdout;
  assert.doesNotMatch(out, /not supported yet/);
  assert.match(out, /Runtime error: Not enough memory for this computation\.\nA collection of more than \d+ elements needs about [\d.]+ [kMG]?B, but Sagebrush\s+allows about [\d.]+ [kMG]?B for one collection here\.\nTo run it with more memory:\n- give this Sagebrush more memory with NODE_OPTIONS=--max-old-space-size=<MiB>\n  \(the engines keep their 4 GB\);\n/);
  assert.match(out, /\nend\n$/);
  const f = run("--sage", [
    "import _magma, _memguard",
    "e = _magma._collect_refusal()",
    "print(type(e).__name__, e.what, e.need_bytes == (_magma._COLLECT_MAX + 1) * 1024, e.limit_bytes == _magma._COLLECT_MAX * 1024, e.allowance_for, e.record, e.partial, e.checkpoint)",
    "p = object(); g = _magma._memory_error(_memguard.memory_guard('X', 2, 1, 'y', partial=p, checkpoint=p))",
    "print(g.partial is p, g.checkpoint is p)",
    // (a lib guard's own error, reached from Magma code: the guard's words
    // in Magma's layout, not \"not supported yet\")
    "_magma._src[2] = 'session'",
    "_magma._report(_memguard.memory_guard('A 100000 x 100000 matrix', 8 * 10**10, 2**25, 'one matrix'), 0, 0)",
  ].join("\n") + "\n", ".sage");
  assert.equal(f.stderr, "");
  assert.match(f.stdout, /^MagmaError A collection of more than \d+ elements True True one collection None None None\nTrue True\n\n>> \n  \^\nRuntime error: Not enough memory for this computation\.\nA 100000 x 100000 matrix needs about 80 GB, but Sagebrush allows about 33 MB for\s+one\s+matrix here\.\nTo run it with more memory:\n/);
  assert.doesNotMatch(f.stdout, /not supported yet/);
});

test("MATLAB's error report keeps a memory guard's words; other MemoryErrors stay MATLAB's 'Out of memory.'", () => {
  const r = run("--sage", [
    "import _matlab, _memguard",
    "print(_matlab._message(_memguard.memory_guard('A 10 x 11 matrix', 880, 800, 'one matrix')).splitlines()[:2])",
    "print(_matlab._message(MemoryError()))",
  ].join("\n") + "\n", ".sage");
  assert.equal(r.stderr, "");
  assert.equal(r.stdout, "['Not enough memory for this computation.', 'A 10 x 11 matrix needs about 880 bytes, but Sagebrush allows about 800 bytes for one matrix here.']\nOut of memory.\n");
});
