import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Python mode's search index (lib/_python_docsearch.py) and its examples
// (lib/_python_examples.py): each example, run in Sagebrush, prints exactly
// the output its documentation shows (scripts/python-doc-examples.py
// --cpython checks the same outputs against CPython with NumPy and SciPy).

const cli = (...args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8", maxBuffer: 64 * 2 ** 20 });

test("every Python search example prints exactly the output its documentation shows", () => {
  const data = JSON.parse(cli("-c", "import json, _python_examples as e\nprint(json.dumps([e.run_all(), e.OUTPUTS]))"));
  const [got, want] = data as [Record<string, string>, Record<string, string>];
  assert.ok(Object.keys(want).length >= 300, "examples: " + Object.keys(want).length);
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort());
  for (const code of Object.keys(want)) assert.equal(got[code], want[code], code);
});

test("the Python search index: every entry summarized, the examples after a Python prompt", () => {
  const index = JSON.parse(cli("-m", "_python_docsearch", "--index"));
  assert.ok(index.length >= 500, "entries: " + index.length);
  assert.ok(index.filter((e: any) => e.examples > 0).length >= 300);
  assert.deepEqual(index.filter((e: any) => !e.summary).map((e: any) => e.name), []);
  const by = (n: string) => index.find((e: any) => e.name === n);
  assert.equal(by("numpy.linalg.solve").signature, "(a, b)");
  assert.match(by("numpy.linalg.solve").doc, /\n\nExamples:\n\n>>> np\.linalg\.solve\(\[\[3, 1\], \[1, 2\]\], \[9, 8\]\)\narray\(\[2\., 3\.\]\)$/);
  assert.match(by("functools.lru_cache").doc, />>> @functools\.lru_cache\(maxsize=None\)\n\.\.\. def fib\(n\):\n\.\.\.     return .*\n\.\.\.\n>>> fib\(80\)\n23416728348467685$/);
  assert.equal(by("numpy.amax").summary, "Another name for numpy.max.");
  // (names other modules define, imported into these, are not theirs)
  assert.equal(by("scipy.integrate.bisect_left"), undefined);
  assert.equal(by("functools.RLock"), undefined);
});
