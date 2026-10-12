import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const cli = (...args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

// An assignment evaluates its value before its target's container, index or
// object, as CPython does: `a[setx()] = x` reads the old x, `a[x - 1] =
// setx()` indexes with the new one (sagebrush-codex's REACT-75A8-4; the
// expected output is CPython 3.14's).  Augmented, tuple and chained
// assignments are checked too.
test("an assignment's value is evaluated before its target", () => {
  assert.equal(cli("-c", "x = 1\ndef setx():\n    global x\n    x = 2\n    return 0\na = [0]\na[setx()] = x\nprint(a, x)\nx = 1\na = [11, 22]\na[x-1] = setx()\nprint(a, x)\nx = 1\nd = {}\nd[setx()] = x\nprint(d, x)\nx = 1\nb = [0]\nb[setx()]: int = x\nprint(b, x)\nclass O: pass\ndef geto():\n    global x\n    x = 5\n    return o\no = O()\nx = 1\ngeto().v = x\nprint(o.v, x)\nlog = []\ndef f(n):\n    log.append(n)\n    return n\nc = [0, 0, 0]\nc[f(1)] += f(2)\nprint(log, c)\nlog.clear()\nc[f(0)], c[f(1)] = f(3), f(4)\nprint(log, c)\nlog.clear()\nc[f(2)] = c[f(0)] = f(9)\nprint(log, c)\n"), "[1] 2\n[11, 0] 2\n{0: 1} 2\n[1] 2\n1 5\n[1, 2] [0, 2, 0]\n[3, 4, 0, 1] [3, 4, 0]\n[9, 2, 0] [9, 4, 9]\n");
});
