import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The function catalog (catalog/SCHEMA.md, lib/_catalog.py): the gates.
// 1. Every file is valid, and a (name, signature) occurs once per mode.
// 2. Every public name of a mode has an entry or is in its missing.txt.
// 3. Every example prints exactly its `expected` (here on Node; Deno and Bun:
//    scripts/catalog-run.py in ci.yml).
// And Python mode's search index, made from the catalog.

const cli = (args: string[], cwd?: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8", maxBuffer: 64 * 2 ** 20, cwd });

test("catalog gate 1: every entry is valid, and a (name, signature) occurs once per mode", () => {
  const out = cli(["-m", "_catalog", "--check"]);
  assert.match(out, /^catalog: 0 problems$/m, out);
});

test("catalog gate 1: the validator refuses what catalog/schema.json refuses", () => {
  const code = [
    "import json, _catalog as c",
    "ok = {'name': 'f', 'kind': 'function', 'signature': '(x)', 'summary': 'S.', 'examples': [{'code': 'f(1)', 'expected': '1\\n'}], 'differs': [], 'status': 'full'}",
    "bad = [dict(ok, kind='func'), dict(ok, summary='x' * 151), dict(ok, examples=[]), dict(ok, status='absent'), dict(ok, status='partial'),",
    "       dict(ok, examples=[{'code': 'f(1)', 'expected': '1'}]), dict(ok, extra=1), {k: v for k, v in ok.items() if k != 'differs'},",
    "       dict(ok, examples=[{'code': 'f(1)', 'expected': '1\\n', 'runtimes': ['jvm']}]), dict(ok, name='two words'), dict(ok, aliases=['a b']), dict(ok, aliases='g')]",
    "print(json.dumps([c.validate(ok), [len(c.validate(b)) > 0 for b in bad],",
    "  c.validate(dict(ok, status='absent', examples=[], alternative='use g')) + c.validate(dict(ok, aliases=['g', 'h.k']))]))",
  ].join("\n");
  const [okErrs, refused, absent] = JSON.parse(cli(["-c", code]));
  assert.deepEqual(okErrs, []);
  assert.deepEqual(refused, refused.map(() => true));
  assert.deepEqual(absent, []);
});

// (the modes that list their public names, and that run their examples:
// lib/_catalog.py PUBLIC and RUNNERS, where a mode registers)
const [publicModes, runnerModes] = JSON.parse(cli(["-c", "import json, _catalog as c\nprint(json.dumps([sorted(c.PUBLIC), sorted(c.RUNNERS)]))"]));

for (const mode of publicModes) {
  test(`catalog gate 2: every public name of ${mode} mode has an entry or is in missing.txt`, () => {
    const [unlisted, stale] = JSON.parse(cli(["-m", "_catalog", "--uncovered", "--mode", mode]));
    assert.deepEqual(unlisted, [], `public names with no entry: add entries (or list them in catalog/${mode}/missing.txt)`);
    assert.deepEqual(stale, [], `names in catalog/${mode}/missing.txt that are no public name`);
  });
}

for (const mode of runnerModes) {
  test(`catalog gate 3: every ${mode} example prints exactly its expected output (Node)`, () => {
    // (in a directory of its own: examples write files)
    const dir = mkdtempSync(join(tmpdir(), "sagebrush-catalog-"));
    try {
      // (lib/_catalog.py compare: exactly one result per example, each its expected)
      const code = `import json, _catalog as c\nes = [e for _, e in c.load(${JSON.stringify(mode)})]\nprint(json.dumps(c.compare(es, c.run_all(${JSON.stringify(mode)}, es, 'node'), 'node')))`;
      assert.deepEqual(JSON.parse(cli(["-c", code], dir).trim().split("\n").pop()!), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("Python mode runs its examples and lists its public names", () => {
  assert.ok(publicModes.includes("python") && runnerModes.includes("python"));
});

test("catalog gate 3 refuses a missing, an extra or a repeated result, as a wrong one", () => {
  const code = [
    "import json, _catalog as c",
    "es = [{'name': 'f', 'signature': '', 'examples': [{'code': 'a', 'expected': '1\\n'}, {'code': 'b', 'expected': '2\\n'}, {'code': 'c', 'expected': '', 'runtimes': ['deno']}]}]",
    "r = lambda i, got: {'name': 'f', 'signature': '', 'index': i, 'got': got}",
    "good = [r(0, '1\\n'), r(1, '2\\n')]",
    "print(json.dumps([c.compare(es, good, 'node'), [len(c.compare(es, x, 'node')) for x in",
    "  ([], good[:1], good + [r(1, '2\\n')], good + [r(2, '')], [r(0, '1\\n'), r(1, '3\\n')])], len(c.compare(es, good, 'deno'))]))",
  ].join("\n");
  const [ok, counts, deno] = JSON.parse(cli(["-c", code]));
  assert.deepEqual(ok, []);
  assert.deepEqual(counts, [2, 1, 1, 1, 1]);
  assert.equal(deno, 1);
});

test("catalog gate 1: a file must be a JSON array of entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "sagebrush-catalog-"));
  try {
    const code = [
      "import json, os, sys, _catalog as c",
      "d = sys.argv[1]",
      "os.makedirs(d + '/python')",
      "open(d + '/schema.json', 'w').write('{}')",
      "open(d + '/python/one.json', 'w').write(json.dumps({'name': 'f'}))",
      "open(d + '/python/two.json', 'w').write('[1,')",
      "print(json.dumps(c.check(['python'], d)))",
    ].join("\n");
    const probs = JSON.parse(cli(["-c", code, dir]));
    assert.deepEqual(probs.map((p: string) => p.split(":")[0]), ["python/one.json", "python/two.json"]);
    assert.match(probs[0], /must be a JSON array/);
    assert.match(probs[1], /not JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog coverage is reported per mode", () => {
  const cov = JSON.parse(cli(["-m", "_catalog", "--coverage"]));
  assert.deepEqual(Object.keys(cov), ["python", "sage", "magma", "matlab"]);
  assert.ok(cov.python.entries >= 380 && cov.python.with_examples === cov.python.entries - cov.python.absent);
  console.log("catalog coverage: " + JSON.stringify(cov));
});

test("Python mode's search index: the catalog's entries whole, then every other public name", () => {
  const index = JSON.parse(cli(["-m", "_python_docsearch", "--index"]));
  assert.ok(index.length >= 500, "entries: " + index.length);
  const cataloged = index.filter((e: any) => e.catalog !== false);
  assert.ok(cataloged.length >= 380);
  assert.deepEqual(index.filter((e: any) => !e.summary).map((e: any) => e.name), []);
  const by = (n: string) => index.find((e: any) => e.name === n);
  const solve = by("numpy.linalg.solve");
  assert.equal(solve.signature, "(a, b)");
  assert.equal(solve.status, "partial");
  assert.ok(solve.differs.length > 0);
  assert.deepEqual(solve.examples[0], { code: "np.linalg.solve([[3, 1], [1, 2]], [9, 8])", expected: "array([2., 3.])\n" });
  assert.match(solve.doc, /\n\nExamples:\n\n>>> np\.linalg\.solve\(\[\[3, 1\], \[1, 2\]\], \[9, 8\]\)\narray\(\[2\., 3\.\]\)$/);
  assert.match(by("functools.lru_cache").doc, />>> @functools\.lru_cache\(maxsize=None\)\n\.\.\. def fib\(n\):\n\.\.\.     return .*\n\.\.\.\n>>> fib\(80\)\n23416728348467685$/);
  assert.equal(by("numpy.amax").summary, "Another name for numpy.max.");
  assert.equal(by("numpy.amax").catalog, false);
  // (names other modules define, imported into these, are not theirs)
  assert.equal(by("scipy.integrate.bisect_left"), undefined);
  assert.equal(by("functools.RLock"), undefined);
});

test("the CPython package searches Python mode's index it ships (docs-index-python.json), as made by the CLI", () => {
  // (only the package's own files, CPython isolated from the environment; it
  // cannot build the index itself: there numpy is NumPy, not Sagebrush's)
  const lib = __dirname + "/../../engine/py/python/sagebrush/_sagelib";
  const code = [
    "import sys, json",
    "sys.path.insert(0, sys.argv[1])",
    "import _pyjs_docsearch as d",
    "print(json.dumps([d.index_for('python') == json.load(open(sys.argv[1] + '/docs-index-python.json')),",
    "  [e['name'] for _, e in d.search('linear system', 3, 'python')], 'numpy' in sys.modules]))",
  ].join("\n");
  const [same, names, numpy] = JSON.parse(execFileSync("python3", ["-I", "-c", code, lib], { encoding: "utf8" }));
  assert.equal(same, true);
  assert.equal(names[0], "numpy.linalg.solve");
  assert.equal(numpy, false);
  assert.deepEqual(JSON.parse(cli(["-m", "_python_docsearch", "--index"])), JSON.parse(readFileSync(lib + "/docs-index-python.json", "utf8")));
});
