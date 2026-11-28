import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Descriptor, slot, class-creation, context-manager and generator protocols as CPython 3.14's (the Codex audit
// P01b): each case of test/object_protocols_cases.py is compared with what CPython prints.
const TEST = __dirname + "/../../test/";
const cli = __dirname + "/../src/cli.js";

test("Python's object and control-flow protocols (descriptors, slots, __init_subclass__, with, generators): as CPython's", () => {
  const name = "object_protocols_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [cli, TEST + name], { encoding: "utf8" });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `${name} line ${i + 1}`);
});
