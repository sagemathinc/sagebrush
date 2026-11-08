import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A class attribute found by an implicit special-method call (next(), for, len(), x[i], x(), repr(), +, with,
// isinstance, a descriptor's __set__, a metaclass's __call__, ...) is bound to the instance only when it is a
// descriptor, as CPython's vectorcall_method: a bound method, a builtin function or a type is called without self
// (xml.etree's iterparse: `__next__ = gen.__next__`). test/special_binding_cases.py; its .out is CPython 3.14.10's.
const CLI = join(__dirname, "..", "src", "cli.js");
const TEST = join(__dirname, "..", "..", "test") + "/";

test("special methods that are not descriptors are called without self, at every implicit call site, as CPython 3.14.10", () => {
  const want = readFileSync(TEST + "special_binding_cases.out", "utf8").split("\n");
  const got = execFileSync(process.execPath, [CLI, TEST + "special_binding_cases.py"], { encoding: "utf8" }).split("\n");
  assert.ok(want.length > 120, "the recording has every case");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `special_binding_cases.py line ${i + 1}`);
});

// (the recording's provenance: CI's CPython, when it is 3.14.10, prints the committed .out)
test("special_binding_cases.out is what CPython 3.14.10 prints", (t) => {
  const v = execFileSync("python3", ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], { encoding: "utf8" }).trim();
  if (v !== "3.14.10") return t.skip(`python3 is ${v}, not the recording's 3.14.10`);
  const live = execFileSync("python3", ["-I", TEST + "special_binding_cases.py"], { encoding: "utf8" });
  assert.equal(live, readFileSync(TEST + "special_binding_cases.out", "utf8"));
});
