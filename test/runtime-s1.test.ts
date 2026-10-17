import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// The runtime differences from CPython 3.14 that html's and importlib's
// cases found (S1 of the stdlib the curated PyPI packages need), compared
// with CPython: unpacking's count, `in` without __contains__, slice indices
// (_PyEval_SliceIndex) in slicing and in str's and bytes' find, count,
// index, startswith and endswith, re's subject (a str subclass by its
// payload), ImportError's keywords and attributes, keywords to an
// exception's constructor, and None in sys.modules.
const TEST = __dirname + "/../../test/";
test("runtime_s1_cases.py: CPython's output", () => {
  const want = execFileSync("python3", [TEST + "runtime_s1_cases.py"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + "runtime_s1_cases.py"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `runtime_s1_cases.py line ${i + 1}`);
});

// (an other-kind template is parsed once per sub() call, not per match:
// 10000 matches of a 100000-character template, with its one group never
// taking part, take far under a second; parsed per match they would be
// some 10**9 character steps, daybreak2's RE-LIMIT-C0D-1)
test("re.sub parses an other-kind template once per call, not once per match", () => {
  const code = [
    "import re, time",
    "t = time.perf_counter()",
    "try:",
    "    re.sub('(x)?a', b'\\\\1' + b'y' * 100000, 'a' * 10000)",
    "except TypeError as e:",
    "    print(e)",
    "print(time.perf_counter() - t < 3)",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(out, ["sequence item 0: expected str instance, bytes found", "True"]);
});

// (astra's CORR-C0F-1: __import__'s fromlist through the iterator
// protocol, each item imported before the next is asked for, in the
// __all__ walk too; each in a fresh process, compared with CPython)
const fromlistSnippets: Record<string, string[]> = {
  "a generator fromlist, each child imported before the next item": [
    "import importlib, sys",
    "seen = []",
    "def items():",
    "    yield 'metadata'",
    "    seen.append('importlib.metadata' in sys.modules)",
    "    raise RuntimeError('stop')",
    "try: __import__('importlib', fromlist=items())",
    "except RuntimeError as e: print('raised', e)",
    "print(seen, 'importlib.metadata' in sys.modules)",
  ],
  "a generator __all__ for '*'": [
    "import importlib, sys",
    "seen = []",
    "def names():",
    "    yield 'metadata'",
    "    seen.append('importlib.metadata' in sys.modules)",
    "importlib.__all__ = names()",
    "__import__('importlib', fromlist=['*'])",
    "print(seen, 'importlib.metadata' in sys.modules)",
  ],
  "a list subclass's __iter__, not its payload": [
    "import importlib, sys",
    "class Names(list):",
    "    def __iter__(self):",
    "        yield 'metadata'",
    "__import__('importlib', fromlist=Names(['no_such_child']))",
    "print('importlib.metadata' in sys.modules, 'importlib.no_such_child' in sys.modules)",
  ],
};
for (const [name, lines] of Object.entries(fromlistSnippets))
  test(`__import__: ${name}, as CPython`, () => {
    const code = lines.join("\n");
    const want = execFileSync("python3", ["-c", code], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    assert.equal(execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }), want);
  });
