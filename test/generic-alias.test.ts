import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// types.GenericAlias, compared with CPython 3.14 (test/generic_alias_cases.py):
// list[int] and the other builtin generics, their repr, __origin__, __args__
// and __parameters__, equality, hash, calls, pickling, the isinstance errors,
// and "type 'int' is not subscriptable" for a type that is not generic.
const TEST = __dirname + "/../../test/";
test("generic alias: CPython's types.GenericAlias", () => {
  const name = "generic_alias_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});

// (astra CORR-6C8-1: type.__getattribute__ and object.__getattribute__ take
// an exact str; a str subclass name is refused, not looked up by a payload
// its own __hash__ or __eq__ might disagree with: their full treatment is
// the str-subclass-attribute-names branch)
test("type.__getattribute__ and object.__getattribute__ refuse a str subclass name", () => {
  const src = `
class Name(str):
    def __str__(self): raise ValueError('override str')
    def __hash__(self): raise ValueError('override hash')
    def __eq__(self, other): raise ValueError('override eq')
class PlainName(str): pass
class C:
    value = 91
for n in (Name('value'), PlainName('value')):
    for f in (lambda: type.__getattribute__(C, n), lambda: object.__getattribute__(C, n), lambda: object.__getattribute__(C(), n)):
        try:
            print(f())
        except NotImplementedError as e:
            print(type(e).__name__, 'str subclasses' in str(e))
`;
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", src], { encoding: "utf8" }).trimEnd().split("\n");
  assert.deepEqual(out, Array(6).fill("NotImplementedError True"));
});
