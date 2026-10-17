import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// The namespace a class body runs in is the one its metaclass is given,
// not a copy: a function metaclass, a type subclass and __classdict__,
// compared with CPython 3.14 (test/metaclass_namespace_cases.py)
const TEST = __dirname + "/../../test/";
test("a metaclass is given the class body's own namespace, as CPython's", () => {
  const name = "metaclass_namespace_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});

// A class namespace's dict takes str keys only, and refuses any other
// before its __hash__ or __eq__ runs or the dict's own state changes
// (daybreak2's HARD-E4A-1)
test("a class namespace's dict refuses a non-str key before touching it", () => {
  const code = [
    "calls = []",
    "class Hook:",
    "    def __hash__(self): calls.append('hash'); raise RuntimeError('hashed')",
    "    def __eq__(self, o): calls.append('eq'); raise RuntimeError('compared')",
    "class Deep:",
    "    def __hash__(self): return hash(Deep())",
    "class M(type):",
    "    def __new__(m, name, bases, ns):",
    "        for k in (Hook(), Deep(), object(), 1, 2.5, (1,), b'x'):",
    "            for op in (lambda: ns.__setitem__(k, 1), lambda: ns[k], lambda: k in ns, lambda: ns.get(k), lambda: ns.pop(k, None), lambda: ns.__delitem__(k), lambda: ns.setdefault(k, 1)):",
    "                try:",
    "                    op()",
    "                    print('accepted', type(k).__name__)",
    "                except NotImplementedError as e:",
    "                    pass",
    "        print(sorted(k for k in ns if not k.startswith('__')), calls)",
    "        return super().__new__(m, name, bases, ns)",
    "class C(metaclass=M):",
    "    a = 1",
  ].join("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });
  assert.equal(got, "['a'] []\n");
  // (and many refused writes leave no state behind)
  require(__dirname + "/../src/compile.js");
  const Ty = require(__dirname + "/../src/runtime/types.js");
  const Obj = require(__dirname + "/../src/runtime/object.js");
  const d = Ty.classDictHooks.view(new Map([["a", 1]]));
  for (let i = 0; i < 1000; i++) {
    for (const k of [Obj.T.object(), 1, 2.5, null]) {
      assert.throws(() => Obj.dictSet(d, k, i), (e: any) => Obj.typeName(e) === "NotImplementedError");
      assert.throws(() => Obj.dictGet(d, k), (e: any) => Obj.typeName(e) === "NotImplementedError");
      assert.throws(() => Obj.dictDelete(d, k), (e: any) => Obj.typeName(e) === "NotImplementedError");
    }
  }
  assert.equal(d.$buckets, null);
  assert.equal(d.$orig, null);
  assert.equal(d.$hasNum, false);
  assert.deepEqual([...d.$m.keys()], ["a"]);
});
