import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// A figure's width and height, one at a time (set_figwidth, set_figheight, their getters and get_size_inches), as
// matplotlib's: the values below are what CPython with matplotlib 3.11 prints for the same program. And interact's
// sliders given a parameter whose own default is not a number: as ipywidgets, that default is ignored and the slider
// keeps its own starting value; a number is held within the slider's range.
const py = (code: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });

test("Figure.set_figwidth / set_figheight and their getters, as matplotlib's", () => {
  const out = py(`
import matplotlib.pyplot as plt
f = plt.figure()
print(f.get_figwidth(), f.get_figheight(), f.get_size_inches())
print(f.set_figheight(6), f.get_size_inches())
f.set_figwidth(5.5, forward=False)
print(f.get_size_inches(), type(f.get_figwidth()).__name__)
f.set_size_inches(3, 4)
print(f.get_figwidth(), f.get_figheight())
for bad in (-1, float("nan")):
    try:
        f.set_figheight(bad)
    except ValueError as e:
        print("ValueError", e)
fig, ax = plt.subplots(1)
fig.set_figheight(4.5)
fig.set_figwidth(5)
print(fig.get_size_inches())
`);
  assert.equal(out, [
    "6.4 4.8 [6.4 4.8]",
    "None [6.4 6. ]",
    "[5.5 6. ] float64",
    "3.0 4.0",
    "ValueError figure size must be positive finite not [ 3. -1.]",
    "ValueError figure size must be positive finite not [ 3. nan]",
    "[5.  4.5]",
    "",
  ].join("\n"));
});

test("a figure's size set this way is the size it is drawn at", () => {
  const out = py(`
import matplotlib.pyplot as plt
fig = plt.figure()
fig.set_figwidth(3)
fig.set_figheight(2)
s = fig._svg()
import re
print(re.search(r'<svg[^>]* width="([0-9.]+)[a-z]*" height="([0-9.]+)', s).groups())
`);
  assert.equal(out, "('300', '200')\n");
});

test("interact: a parameter's own default that is not a number leaves the slider's start; a number is held in range", () => {
  const out = py(`
from ipywidgets import interact
def f(r=(0.3, 0.6, 0.01)):
    print("r", r)
interact(f, r=(0.3, 0.6, 0.01))
def g(n=7):
    print("n", n)
interact(g, n=(0, 5))
interact(g, n=(0, 10))
def h(s="text"):
    print("s", s)
interact(h, s=(0, 10))
`);
  const lines = out.split("\n").filter((l) => /^[rnsh] /.test(l));
  assert.equal(lines.length, 4, out);
  assert.match(lines[0], /^r 0\.4\d*$/); // (a number in the slider's range, never the tuple)
  assert.equal(lines[1], "n 5");
  assert.equal(lines[2], "n 7");
  assert.equal(lines[3], "s 5");
});
