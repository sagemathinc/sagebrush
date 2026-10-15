import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// __class__ and zero-argument super(): CPython's class cell (set by
// type.__new__ from __classcell__), its error types and messages, in plain
// methods, static and class methods, nested functions, lambdas,
// comprehensions, generator expressions, exec'd and local classes.
const CASES = __dirname + "/../../test/class_cell_cases.py";
const cli = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("__class__ and super() behave as in CPython", () => {
  const want = execFileSync("python3", [CASES], { encoding: "utf8" });
  assert.equal(cli([CASES]), want);
});

test("super without arguments, called other than directly, is refused", () => {
  // CPython finds the method's class and first argument from the calling
  // frame; Sagebrush compiles a direct super() call to them, so an alias
  // cannot work and must not guess.
  const out = cli(["-c", `
class A:
    def v(self): return 1
class B(A):
    def m(self):
        s = super
        return s().v()
try:
    B().m()
except NotImplementedError as e:
    print("NotImplementedError", e)
print(B().m.__func__ is not None, super(B, B()).v())
`]);
  assert.equal(out, "NotImplementedError super() without arguments works in Sagebrush only when called directly as super()\nTrue 1\n");
});
