import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeLimitsOption, utf8Bytes } from "../src/limits";

// The engine's limits (plan-ff-limits r3): lib/_limits.py's validator, the
// same under the engine as under CPython (test/limits_cases.out was written
// by CPython), and the CLI's gate (src/limits.ts): invalid limits, from
// --limits FILE or SAGEBRUSH_LIMITS=FILE, end the run with status 2 and the
// message before the program's first statement.  The launcher's own read,
// and its worker and in-process paths: web/test-cli-limits.mjs.
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
const dir = mkdtempSync(join(tmpdir(), "sb-limits-"));
const file = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};
const run = (args: string[], env: Record<string, string> = {}, input?: string) => {
  const e: Record<string, string | undefined> = { ...process.env, ...env };
  if (!("SAGEBRUSH_LIMITS" in env)) delete e.SAGEBRUSH_LIMITS;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: e, input, maxBuffer: 16 << 20 });
};

test("the limits validator answers as CPython's does, case by case (test/limits_cases.py)", () => {
  const got = execFileSync(process.execPath, [CLI, TEST + "limits_cases.py"], { encoding: "utf8" });
  assert.equal(got, readFileSync(TEST + "limits_cases.out", "utf8"));
});

test("invalid limits stop the run before its first statement, with status 2 and the reason", () => {
  const big = file("big.json", '{"ff.work": 100000' + " ".repeat(5000) + "}");
  const missing = join(dir, "missing.json");
  const cases: [string, string][] = [
    [missing, `sagebrush: limits: cannot read ${missing}: No such file or directory`],
    [dir, `sagebrush: limits: cannot read ${dir}: Is a directory`],
    [big, `sagebrush: limits: ${big} is larger than 4096 bytes`],
    [file("bad.json", "{"), "is not JSON: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"],
    [file("accent.json", '{"ff.w\u00e9rk": 1}'), "sagebrush: limits: ff.w\u00e9rk is not a limit of this engine"],
    [file("bom.json", "\ufeff{}"), "is not JSON: Unexpected UTF-8 BOM"],
    [file("array.json", "[1]"), "sagebrush: limits: the limits must be a JSON object, not an array"],
    [file("many.json", JSON.stringify(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])))), "sagebrush: limits: more than 16 entries"],
    [file("unknown.json", '{"ff.wrok": 1}'), "sagebrush: limits: ff.wrok is not a limit of this engine (its limits: ff.conway_work, ff.embed_max, ff.root_bits, ff.work)"],
    [file("bool.json", '{"ff.work": true}'), "sagebrush: limits: ff.work must be an integer, not true"],
    [file("float.json", '{"ff.work": 1e7}'), "sagebrush: limits: ff.work must be an integer, not 10000000.0"],
    [file("range.json", '{"ff.work": 5}'), "sagebrush: limits: ff.work = 5 is outside the range this engine allows, [100000, 100000000]"],
    [file("raise.json", '{"ff.embed_max": 2097152}'), "sagebrush: limits: ff.embed_max = 2097152 is outside the range this engine allows, [256, 1048576]"],
  ];
  // (bytes that are not UTF-8)
  writeFileSync(join(dir, "bytes.json"), Buffer.from([0x7b, 0xff, 0x7d]));
  cases.push([join(dir, "bytes.json"), "is not JSON: it is not UTF-8"]);
  for (const [path, want] of cases) {
    for (const [how, args, env] of [
      ["--limits", ["--limits", path, "-c", "print('MARKER')"], {}],
      ["SAGEBRUSH_LIMITS", ["-c", "print('MARKER')"], { SAGEBRUSH_LIMITS: path }],
      ["--magma", ["--limits", path, "--magma", "-c", 'print "MARKER";'], {}],
      ["--sage on stdin", ["--limits", path, "--sage"], {}],
    ] as [string, string[], Record<string, string>][]) {
      const r = run(args, env, how === "--sage on stdin" ? "print('MARKER')\n" : undefined);
      assert.equal(r.status, 2, `${how} ${path}: ${r.stderr}`);
      assert.ok(!r.stdout.includes("MARKER"), `${how} ${path}: the program ran`);
      assert.ok(r.stderr.includes(want), `${how} ${path}: ${r.stderr}`);
    }
  }
});

test("valid limits are the session's, read once and locked before the program runs", () => {
  const ok = file("ok.json", '{"ff.work": 123456, "ff.root_bits": 100}');
  const show = "import sys, _sage_ffsub as S; print(S.WORK, S.ROOT_BITS, S.EMBED_MAX, sys._sagebrush_limits['ff.work'])";
  for (const [args, env] of [
    [["--limits", ok, "-c", show], {}],
    [["-c", show], { SAGEBRUSH_LIMITS: ok }],
  ] as [string[], Record<string, string>][]) {
    const r = run(args, env);
    assert.equal(r.stdout, "123456 100 1048576 123456\n", r.stderr);
  }
  // none: the defaults, today's constants
  assert.equal(run(["-c", show]).stdout, "10000000 1024 1048576 10000000\n");
  // --limits FILE wins over SAGEBRUSH_LIMITS; one that can't be read is never replaced by it
  assert.equal(run(["--limits", ok, "-c", show], { SAGEBRUSH_LIMITS: file("other.json", '{"ff.work": 200000}') }).stdout, "123456 100 1048576 123456\n");
  const r = run(["--limits", join(dir, "nope.json"), "-c", show], { SAGEBRUSH_LIMITS: ok });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  // user code can't set them again: they were locked at startup
  const again = run(["-c", "import _limits\ntry:\n    _limits.propose(_limits.validate({'ff.work': 100000000}))\nexcept RuntimeError as e:\n    print(e)"]);
  assert.equal(again.stdout, "sagebrush limits are read once, at the first use: set them before it\n");
  // after -c (or a script), --limits is the program's argument
  assert.equal(run(["-c", "import sys; print(sys.argv[1:])", "--limits", "x"]).stdout, "['--limits', 'x']\n");
  const twice = run(["--limits", ok, "--limits", ok, "-c", "print(1)"]);
  assert.equal(twice.status, 2);
  assert.ok(twice.stderr.startsWith("sagebrush: --limits is given more than once\n"));
  const none = run(["--limits"]);
  assert.equal(none.status, 2);
  assert.ok(none.stderr.startsWith("sagebrush: --limits takes a file\n"));
});

test("--limits is taken only among the interpreter's own options", () => {
  const take = (a: string[]) => {
    const r = takeLimitsOption(a);
    return [r, a];
  };
  assert.deepEqual(take(["--limits", "f", "-c", "x"]), ["f", ["-c", "x"]]);
  assert.deepEqual(take(["--sage", "--limits", "f", "p.sage", "--limits", "g"]), ["f", ["--sage", "p.sage", "--limits", "g"]]);
  assert.deepEqual(take(["-c", "x", "--limits", "f"]), [null, ["-c", "x", "--limits", "f"]]);
  assert.deepEqual(take(["-m", "mod", "--limits", "f"]), [null, ["-m", "mod", "--limits", "f"]]);
  assert.deepEqual(take(["--", "--limits", "f"]), [null, ["--", "--limits", "f"]]);
  assert.deepEqual(take(["--figures", "--limits", "p.py"]), [null, ["--figures", "--limits", "p.py"]]);
  assert.deepEqual(take(["--limits", "f", "notebook", "--port", "1"]), ["f", ["notebook", "--port", "1"]]);
  assert.deepEqual(take(["--limits"]), [{ error: "--limits takes a file" }, ["--limits"]]);
});

test("the browser init's text is counted in UTF-8 bytes, without a copy", () => {
  assert.equal(utf8Bytes("abc"), 3);
  assert.equal(utf8Bytes("\u00e9"), 2);
  assert.equal(utf8Bytes("\u20ac"), 3);
  assert.equal(utf8Bytes("\ud83d\ude00"), 4);
  assert.equal(utf8Bytes("\ud83d"), 3); // (a lone surrogate, as Python's surrogatepass)
  assert.equal(utf8Bytes("\u00e9".repeat(2048)), 4096);
  assert.equal(utf8Bytes("\u00e9".repeat(2049)), 4097);
  assert.equal(utf8Bytes("x".repeat(1e6)), 4097); // (stops past the cap)
});
