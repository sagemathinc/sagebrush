import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// pypi-tests/run.py's gates (pypi-tests/README.md), on a made-up package
// "demo" run by stand-ins for CPython and Sagebrush: Python wrappers around
// the real harness that, on request, fail a test with a known error, exit
// nonzero or write to stderr after printing every record. A known
// difference passes only as exactly its recorded line, and a child's run
// counts only if it exits 0 with nothing on stderr (astra's TEST-DB4-1, -2).
const repo = join(__dirname, "..", "..");
const top = mkdtempSync(join(tmpdir(), "sb-pypi-runner-"));
const tests = join(top, "tests"), packages = join(top, "packages"), up = join(tests, "demo", "upstream");
mkdirSync(up, { recursive: true });
mkdirSync(join(packages, "pypi-demo", "py"), { recursive: true });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const upstream: Record<string, string> = {
  "__init__.py": "",
  "test_demo.py": [
    "import os",
    "def test_ok():",
    "    assert 1 + 1 == 2",
    "def test_known():",
    "    if os.environ.get('FAKE_SB'):",
    "        raise AttributeError(os.environ.get('FAKE_MESSAGE', \"module 'gc' has no attribute 'get_objects'\"))",
    "",
  ].join("\n"),
};
for (const [f, t] of Object.entries(upstream)) writeFileSync(join(up, f), t);
writeFileSync(join(tests, "demo", "SOURCE.json"), JSON.stringify({
  project: "demo", version: "1.0.0", archive: { url: "https://example.invalid/demo.tar.gz", sha256: "0".repeat(64), root: "demo-1.0.0/tests" },
  license: "MIT", files: Object.fromEntries(Object.entries(upstream).map(([f, t]) => [f, sha(t)])),
}));
// (a stand-in: runs the harness as given, then, as its environment asks,
// writes a fatal line to stderr and exits with that code)
const wrapper = (marker: string) => [
  "import os, runpy, sys",
  marker,
  "sys.argv = sys.argv[1:]",
  "runpy.run_path(sys.argv[0], run_name='__main__')",
  "sys.stdout.flush()",
  "p = os.environ.get('FAKE_' + WHO + '_STDERR')",
  "if p: sys.stderr.write(p + '\\n')",
  "os._exit(int(os.environ.get('FAKE_' + WHO + '_EXIT', '0')))",
  "",
].join("\n");
writeFileSync(join(top, "cp.py"), wrapper("WHO = 'CP'"));
writeFileSync(join(top, "sb.py"), wrapper("WHO = 'SB'; os.environ['FAKE_SB'] = '1'"));
const known = (message: string) =>
  writeFileSync(join(packages, "pypi-demo", "known.json"), JSON.stringify({ tests: [{ test: "test_demo.test_known", error: "AttributeError", message, reason: "a stand-in for a test no Sagebrush could pass" }] }));
function runner(args: string[], env: Record<string, string> = {}): { status: number | null; out: string } {
  const r = spawnSync("python3", [join(repo, "pypi-tests", "run.py"), ...args], {
    encoding: "utf8",
    env: { ...process.env, PYPI_TESTS_DIR: tests, PYPI_TESTS_PACKAGES: packages, PYPI_TESTS_CPYTHON: JSON.stringify(["python3", join(top, "cp.py")]), PYPI_TESTS_SAGEBRUSH: JSON.stringify(["python3", join(top, "sb.py")]), ...env },
  });
  return { status: r.status, out: r.stdout + r.stderr };
}
const expected = join(tests, "demo", "expected.out");

test("pypi-tests/run.py: --refresh writes CPython's records, and only from a clean exit", () => {
  const bad = runner(["--refresh", "demo"], { FAKE_CP_EXIT: "23", FAKE_CP_STDERR: "Fatal Python error: simulated" });
  assert.equal(bad.status, 1, bad.out);
  assert.match(bad.out, /CPython exited with 23: Fatal Python error: simulated/);
  const ok = runner(["--refresh", "demo"]);
  assert.equal(ok.status, 0, ok.out);
  assert.equal(readFileSync(expected, "utf8"), "test_demo.test_known: ok\ntest_demo.test_ok: ok\n");
  const noisy = runner(["--refresh", "demo"], { FAKE_CP_STDERR: "Fatal: simulated" });
  assert.equal(noisy.status, 1, noisy.out);
  assert.match(noisy.out, /CPython wrote to stderr: Fatal: simulated/);
  assert.equal(readFileSync(expected, "utf8"), "test_demo.test_known: ok\ntest_demo.test_ok: ok\n");
});

test("pypi-tests/run.py: a known difference passes only as exactly its recorded failure, type and message (TEST-DB4-1)", () => {
  writeFileSync(expected, "test_demo.test_known: ok\ntest_demo.test_ok: ok\n");
  known("module 'gc' has no attribute 'get_objects'");
  const ok = runner(["demo"]);
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /demo 1\.0\.0: 2 tests, CPython and Sagebrush identical; test_demo\.test_known fails here as known \(AttributeError\)/);
  // (the same type, another message: not the recorded failure)
  const other = runner(["demo"], { FAKE_MESSAGE: "SortedDict missing invented_bug" });
  assert.equal(other.status, 1, other.out);
  assert.match(other.out, /known\.json lists test_demo\.test_known as failing with AttributeError: module 'gc' has no attribute 'get_objects', but here: test_demo\.test_known: FAIL AttributeError: SortedDict missing invented_bug/);
  known("SortedDict missing invented_bug");
  const record = runner(["demo"]);
  assert.equal(record.status, 1, record.out);
  assert.match(record.out, /but here: test_demo\.test_known: FAIL AttributeError: module 'gc' has no attribute 'get_objects'/);
  known("module 'gc' has no attribute 'get_objects'");
});

test("pypi-tests/run.py: a child that exits nonzero, or writes to stderr, after every expected record fails the run (TEST-DB4-2)", () => {
  writeFileSync(expected, "test_demo.test_known: ok\ntest_demo.test_ok: ok\n");
  known("module 'gc' has no attribute 'get_objects'");
  for (const [env, why] of [
    [{ FAKE_SB_EXIT: "23", FAKE_SB_STDERR: "FATAL ERROR: simulated" }, /Sagebrush exited with 23: FATAL ERROR: simulated/],
    [{ FAKE_SB_EXIT: "23" }, /Sagebrush exited with 23/],
    [{ FAKE_SB_STDERR: "FATAL ERROR: simulated" }, /Sagebrush wrote to stderr: FATAL ERROR: simulated/],
    [{ FAKE_CP_EXIT: "23" }, /CPython exited with 23/],
    [{ FAKE_CP_STDERR: "Fatal Python error: simulated" }, /CPython wrote to stderr: Fatal Python error: simulated/],
  ] as const) {
    const r = runner(["demo"], env as Record<string, string>);
    assert.equal(r.status, 1, JSON.stringify(env) + r.out);
    assert.match(r.out, why);
  }
  assert.equal(runner(["demo"]).status, 0);
});
