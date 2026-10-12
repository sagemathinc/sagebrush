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

// and an error the value raises comes before one its target raises: a name
// not defined at all, before a local the target uses that is not yet bound
// (REACT-156C-3; NameError's subclass UnboundLocalError would be the target's)
test("an assignment's value raises before its target", () => {
  assert.equal(cli("-c", "def f():\n    try:\n        a[i] = missing\n    except NameError as e:\n        print(type(e).__name__)\n    a = [0]; i = 0\nf()\ndef g():\n    try:\n        a[0]: int = missing\n    except NameError as e:\n        print(type(e).__name__)\n    a = [0]\ng()\ndef h():\n    try:\n        o.v = missing\n    except NameError as e:\n        print(type(e).__name__)\n    o = 0\nh()\ndef k():\n    a = [5]\n    a[0] = a[0] + 1\n    b = {}\n    b[\"x\"] = a\n    print(a, b)\nk()\n"), "NameError\nNameError\nNameError\n[6] {'x': [6]}\n");
});

// Strings compare by code point, as in Python, not by UTF-16 unit as in
// JavaScript: U+10000 (a surrogate pair) is after U+E000, in comparisons,
// sorted, min and max, sequences, str.__lt__ (REACT-DEEF-1; CPython's output)
test("strings compare by code point", () => {
  assert.equal(cli("-c", "print('\\U00010000' < '\ue000', '\\U00010000' > '\ue000', '\ue000' < '\\U00010000', '\\U00010000' == '\ue000')\nprint('\\U00010000' <= '\ue000', '\\U00010000' >= '\ue000', 'a\\U00010000' < 'a\ue000', 'ab' < 'a\\U00010000')\nprint([ord(c) for c in sorted(['\\U00010000', '\ue000', 'z', '\uffff', '\\U0001F600'])])\nprint([ord(c) for c in sorted(['\\U00010000', '\ue000', 1 and 'q'])], ord(min('\\U00010000', '\ue000')), ord(max('\\U00010000', '\ue000')))\nprint(sorted([('\\U00010000', 1), ('\ue000', 2)])[0][1], '\\U00010000'.__lt__('\ue000'), ['\\U00010000'] < ['\ue000'])\nx = 1\nx += ((x:=10) if '\\U00010000' < '\ue000' else 0) + x\nprint(x)\n"), "False True True False\nFalse True False True\n[122, 57344, 65535, 65536, 128512]\n[113, 57344, 65536] 57344 65536\n2 False False\n2\n");
});
