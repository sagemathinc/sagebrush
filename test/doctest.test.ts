// Every example in the docstrings of Sagebrush's Sage library runs and
// prints what it says (lib/_pyjs_doctest.py), and the share of the public
// API with examples never goes down: test/doctest-coverage.json holds the
// counts reached so far (raise them when you add examples).
//
// The examples are also checked against real Sage, separately (Sage is an
// oracle): python3 scripts/doctest-oracle.py lib/<module>.py
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const cli = (...args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8", maxBuffer: 1 << 26 });
const floor: Record<string, number> = JSON.parse(readFileSync(__dirname + "/../../test/doctest-coverage.json", "utf8"));
const modules = Object.keys(floor);

for (const m of modules) {
  test(`doctests of ${m}`, () => {
    let out: string;
    try {
      out = cli("-m", "_pyjs_doctest", m);
    } catch (e: any) {
      out = String(e.stdout ?? "") + String(e.stderr ?? "");
    }
    assert.match(out, new RegExp(`^${m}: \\d+ examples, 0 failed$`, "m"), out.slice(-4000));
  });
}

test("doctest coverage does not go down", () => {
  const out = cli("-m", "_pyjs_doctest", "--coverage", ...modules);
  for (const m of modules) {
    const r = new RegExp(`^${m}: (\\d+) of (\\d+) have examples`, "m").exec(out);
    assert.ok(r, `no coverage line for ${m}:\n${out}`);
    assert.ok(Number(r[1]) >= floor[m], `${m}: ${r[1]} of ${r[2]} functions have examples, fewer than the ${floor[m]} recorded in test/doctest-coverage.json`);
  }
});
