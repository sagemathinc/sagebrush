import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// float.from_number and complex.from_number, fromhex of a bytes or bytearray subclass, and BaseException's args,
// chaining attributes and add_note, as CPython 3.14's (the Codex audit P01): each case of
// test/runtime_core_cases.py is compared with what CPython prints.
const TEST = __dirname + "/../../test/";
const cli = __dirname + "/../src/cli.js";

test("Python's runtime core (from_number, fromhex of a subclass, exception attributes): as CPython's", () => {
  const name = "runtime_core_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [cli, TEST + name], { encoding: "utf8" });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `${name} line ${i + 1}`);
});

// (Sagebrush's one deliberate difference here: a KeyboardInterrupt from a buffer exporter's __release_buffer__, as
// a Stop pressed while it runs arrives, goes on, so the Stop is never lost; CPython reports it as unraisable and
// keeps the result. Every other exception from it lets the result stand, as CPython's: the cases above.)
test("fromhex: a KeyboardInterrupt from __release_buffer__ goes on (a Stop is never lost)", () => {
  const src = [
    "class R:",
    "    def __buffer__(self, flags): return memoryview(b'41')",
    "    def __release_buffer__(self, view): raise KeyboardInterrupt",
    "try:",
    "    bytes.fromhex(R())",
    "    print('swallowed')",
    "except KeyboardInterrupt:",
    "    print('KeyboardInterrupt')",
  ].join("\n");
  assert.equal(execFileSync(process.execPath, [cli, "-c", src], { encoding: "utf8" }), "KeyboardInterrupt\n");
});
