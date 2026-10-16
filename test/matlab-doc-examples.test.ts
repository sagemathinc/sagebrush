import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// The search box's MATLAB examples (lib/_matlab_examples.py): each one,
// run in Sagebrush, prints exactly the output its documentation shows
// (their values are compared with GNU Octave's by
// matlab-tests/test_doc_examples.m).

const cli = (...args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8", maxBuffer: 64 * 2 ** 20 });

test("every MATLAB search example prints exactly the output its documentation shows", () => {
  const data: [string, string, string][] = JSON.parse(cli("-c", "import json, _matlab_examples as e\nprint(json.dumps([[n, c, e.OUTPUTS[c]] for n, c in e.CODES]))"));
  assert.ok(data.length >= 100, "examples: " + data.length);
  // (one session, each example after clear, its output delimited by a marker)
  const program = data.map(([, code], k) => `clear\nfprintf('@@example ${k}@@\\n');\n${code}`).join("\n") + "\n";
  const out = cli("--matlab", "-c", program);
  const parts = out.split(/@@example (\d+)@@\n/);
  assert.equal(parts[0], "");
  const got = new Map<number, string>();
  for (let i = 1; i < parts.length; i += 2) got.set(Number(parts[i]), parts[i + 1]);
  for (const [k, [name, code, expected]] of data.entries()) assert.equal(got.get(k), expected, `${name}: ${code}`);
});

test("the MATLAB search index shows a function's examples, after the prompt >>: a catalog entry's, and the others'", () => {
  const index = JSON.parse(cli("-m", "_matlab_docsearch", "--index"));
  // (a catalog entry, catalog/matlab: all its fields, its examples a list)
  const max = index.find((e: any) => e.name === "max");
  assert.equal(max.status, "partial");
  assert.ok(max.examples.length >= 3);
  assert.match(max.doc, /\n\nExamples:\n\n>> \[m, k\] = max\(\[3 9 4\]\)\n\nm =\n\n     9\n\n\nk =\n\n     2\n\n/);
  // (a built-in with no entry yet: its docstring and lib/_matlab_examples.py's examples, counted)
  const hypot = index.find((e: any) => e.name === "hypot");
  assert.equal(hypot.examples, 1);
  assert.match(hypot.doc, /\n\nExamples:\n\n>> hypot\(3, 4\)\n\nans =\n\n     5$/);
  assert.ok(index.filter((e: any) => Array.isArray(e.examples) ? e.examples.length : e.examples > 0).length >= 300);
});
