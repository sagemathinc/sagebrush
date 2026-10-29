import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// type(name, bases, ns, **kw): the keywords reach the winning metaclass's
// __new__ and __init__, or __init_subclass__ (Enum's functional API and its
// convert_class call type() this way); the argument errors as CPython's.
const CASES = __dirname + "/../../test/type_keywords_cases.py";
const cli = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("type() with keywords makes the class as CPython does", () => {
  const want = execFileSync("python3", [CASES], { encoding: "utf8" });
  assert.equal(cli([CASES]), want);
});
