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

// (astra CORR-2F0-2: a write through a made class's __classdict__ is
// refused: CPython's skips the type's attribute cache, so after a warmed
// lookup its class and dict disagree, which Sagebrush's caches would not
// reproduce)
test("a write through a made class's __classdict__ is refused", () => {
  const src = `
class E:
    value = 1
    def f(x: __classdict__): pass
def read(): return E.value
for _ in range(20): read()
d = E.f.__annotate__(1)['x']
for w in (lambda: d.__setitem__('value', 2), lambda: d.setdefault('added', 12), lambda: d.pop('value'), lambda: d.clear(), lambda: d.update(a=1)):
    try:
        w()
        print('written')
    except NotImplementedError as e:
        print(type(e).__name__, '__classdict__' in str(e))
print(read(), d['value'], vars(E)['value'], 'added' in d)
`;
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", src], { encoding: "utf8" }).trimEnd().split("\n");
  assert.deepEqual(out, [...Array(5).fill("NotImplementedError True"), "1 1 1 False"]);
});
