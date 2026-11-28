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
