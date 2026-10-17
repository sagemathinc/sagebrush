import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

// @sagebrush-astra's review probes of the lazy annotations (CORR-881-1..4):
// annotation scopes (exec's globals, __class__, locals()), deletion and
// the providers, `from __future__ import annotations` as strings, the
// SyntaxErrors, conditional annotations, caches and timing; each compared
// with CPython 3.14 (test/annotations_review/*.py; code objects'
// co_freevars, which Sagebrush has not, left out)
const DIR = __dirname + "/../../test/annotations_review/";
for (const name of readdirSync(DIR).filter((f) => f.endsWith(".py")).sort()) {
  test(`annotations review: ${name}`, () => {
    const strip = (s: string) => s.replace(/ at 0x[0-9a-f]+/g, "").split("\n");
    const want = strip(execFileSync("python3", [DIR + name], { encoding: "utf8" }));
    const got = strip(execFileSync(process.execPath, [__dirname + "/../src/cli.js", DIR + name], { encoding: "utf8" }));
    for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
  });
}
