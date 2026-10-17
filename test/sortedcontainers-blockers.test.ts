import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Runtime gaps that blocked sortedcontainers (sage2's report), compared with
// CPython 3.14: type.__call__ initializing a __new__ result by
// type(obj).__init__ (test/new_init_cases.py), and traceback.format_exc()
// formatting the exception being handled (test/traceback_exc_cases.py;
// CPython's caret lines under a traceback's source line, ^^^ and ~~~, are not
// printed here, so they are left out of the comparison).
const TEST = __dirname + "/../../test/";
const carets = (s: string) => s.split("\n").filter((l) => !/^\s+[~^]+\s*$/.test(l));
for (const name of ["new_init_cases.py", "traceback_exc_cases.py", "traceback_late_import_cases.py", "traceback_suspend_cases.py"])
  test(`${name}: CPython's output`, () => {
    const want = carets(execFileSync("python3", [TEST + name], { encoding: "utf8" }));
    const got = carets(execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }));
    for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
  });

// (format_exc's limit=, print_exc and the other keyword arguments:
// test/stdlib-string-traceback.test.ts)

// Deeper than the JS frames kept, which frame caught an exception is
// unknown: format_exc refuses, never printing its callers as its traceback
// (CORR-6AF-2); shallower, the handler's two frames, as CPython's
test("traceback.format_exc past the JS stack limit is refused, not guessed", () => {
  const code = [
    "import traceback",
    "def leaf(): raise ValueError('leaf')",
    "def handler():",
    "    try: leaf()",
    "    except ValueError: return traceback.format_exc()",
    "def descend(n):",
    "    if n: return descend(n - 1)",
    "    return handler()",
    "for n in [5, 400]:",
    "    try: print(n, [l.split(', in ')[-1] for l in descend(n).splitlines() if l.startswith('  File ')])",
    "    except NotImplementedError as e: print(n, 'refused:', e)",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" }).trim().split("\n");
  assert.equal(out[0], "5 ['handler', 'leaf']");
  assert.match(out[1], /^400 refused: which frame caught this exception is unknown: its traceback is deeper than the 200 JavaScript frames kept/);
});

// Recursion through the handler: the function that caught it is more than
// one of the frames it was raised through, and which caught it is unknown,
// so format_exc refuses (CORR-6AF-2)
test("traceback.format_exc refuses when the handler's function recurses through the raise", () => {
  const code = [
    "import traceback",
    "def f(n):",
    "    try:",
    "        if n: return f(n - 1)",
    "        raise KeyError(n)",
    "    except KeyError:",
    "        if n == 1:",
    "            try: return traceback.format_exc()",
    "            except NotImplementedError as e: return 'refused: ' + str(e)",
    "        raise",
    "print(f(2))",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" }).trim();
  assert.equal(out, "refused: which frame caught this exception is unknown: f, which caught it, is 3 of the frames it was raised through (recursion through the handler)");
});

// A bare raise records the frames the exception now has, kept to the 200
// the JS stack keeps (HARD-96A-1): a generator that caught it 150 frames
// above the raise, resumed 120 frames deep, re-raises it past that, and so
// does a second one resumed as deep after it; the record stays at most 200
// frames, cut, and format_exc refuses
test("re-raised tracebacks stay within the stack limit, cut and refused past it", () => {
  const code = [
    `const c = require(${JSON.stringify(__dirname + "/../src/compile.js")});`,
    "Promise.resolve(c.initParser && c.initParser()).then(() => {",
    "  const m = c.execModule([",
    "    'import traceback',",
    "    'def deep(n):',",
    "    '    if n: return deep(n - 1)',",
    "    '    raise KeyError(n)',",
    "    'def holder(f):',",
    "    '    try: f()',",
    "    '    except KeyError:',",
    "    '        yield',",
    "    '        raise',",
    "    'def resume_at(n, g):',",
    "    '    return resume_at(n - 1, g) if n else next(g)',",
    "    'g1 = holder(lambda: deep(150)); next(g1)',",
    "    'g2 = holder(lambda: resume_at(120, g1)); next(g2)',",
    "    'try: resume_at(120, g2)',",
    "    'except KeyError as e:',",
    "    '    err = e',",
    "    '    try: traceback.format_exc(); refused = None',",
    "    '    except NotImplementedError as x: refused = str(x)',",
    "  ].join('\\n'), '<reraise>', 'reraise_test');",
    "  const r = m.err.$reraised;",
    "  console.log(JSON.stringify({ frames: r.frames.length, cut: r.cut, refused: m.refused }));",
    "});",
  ].join("\n");
  const r = JSON.parse(execFileSync(process.execPath, ["-e", code], { encoding: "utf8" }).trim());
  assert.ok(r.frames <= 200, `${r.frames} frames kept`);
  assert.equal(r.cut, true);
  assert.equal(r.refused, "which frame caught this exception is unknown: its traceback is deeper than the 200 JavaScript frames kept");
});

// Refused where the frames aren't known, never empty or stale: an exception
// raised by Python code but caught only by the runtime (next's default,
// hasattr: CORR-581-1), and one thrown into a generator (its yield's line
// isn't kept); a cause never raised has none, as CPython's
test("traceback.format_exc refuses frames it can't know: caught by the runtime, thrown into a generator", () => {
  const code = [
    "import traceback",
    "def show(label):",
    "    try: print(label, traceback.format_exc().splitlines()[-1])",
    "    except NotImplementedError as e: print(label, 'refused:', e)",
    "stop = StopIteration('remembered')",
    "class I:",
    "    def __next__(self): raise stop",
    "next(I(), 'default')",
    "try: raise ValueError('later') from stop",
    "except ValueError: show('next default')",
    "missing = AttributeError('missing')",
    "class C:",
    "    @property",
    "    def value(self): raise missing",
    "hasattr(C(), 'value')",
    "try: raise ValueError('later') from missing",
    "except ValueError: show('hasattr')",
    "def gen():",
    "    try: yield 1",
    "    except KeyError: yield traceback.format_exc()",
    "g = gen(); next(g)",
    "try: g.throw(KeyError('thrown'))",
    "except NotImplementedError as e: print('throw refused:', e)",
    "try: raise ValueError('later') from ValueError('never raised')",
    "except ValueError: show('never raised')",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" }).trim().split("\n");
  const runtime = "refused: which frame caught this exception is unknown: it was caught by the runtime (as hasattr, or a default of getattr or next, does), which keeps no record of where";
  assert.deepEqual(out, [
    `next default ${runtime}`,
    `hasattr ${runtime}`,
    "throw refused: which frame caught this exception is unknown: it was thrown into a generator, at a yield whose line is not kept",
    "never raised ValueError: later",
  ]);
});

// The runtime's remaining direct raises are marked raised too (astra's sweep
// on acc13bfb): a built-in iterator's __next__, sys.exit, PEP 479's
// RuntimeError, a filesystem error, numpy.linalg's LinAlgError, a throw()
// into a generator; and a cause made by Python code and never raised isn't
test("the runtime's direct raises tested here (an iterator's __next__, sys.exit, PEP 479, open, linalg, a throw) are marked raised; a never-raised exception isn't", () => {
  const code = [
    `const c = require(${JSON.stringify(__dirname + "/../src/compile.js")});`,
    "Promise.resolve(c.initParser && c.initParser()).then(() => {",
    "  c.R.importModule('sys').path.push(c.libDir());",
    "  const m = c.execModule([",
    "    'import sys, numpy as np',",
    "    'out = {}',",
    "    'def keep(name, f):',",
    "    '    try: f()',",
    "    '    except BaseException as e: out[name] = e',",
    "    'keep(\"list_iterator\", lambda: iter([]).__next__())',",
    "    'keep(\"sys.exit\", lambda: sys.exit(3))',",
    "    'def g():',",
    "    '    yield 1',",
    "    '    next(iter([]))',",
    "    'keep(\"pep479\", lambda: list(g()))',",
    "    'keep(\"open\", lambda: open(\"/nonexistent/x\"))',",
    "    'keep(\"linalg\", lambda: np.linalg.inv(np.zeros((2, 2))))',",
    "    'def h():',",
    "    '    yield 1',",
    "    'gen = h(); next(gen)',",
    "    'keep(\"throw\", lambda: gen.throw(KeyError(\"k\")))',",
    "    'never = ValueError(\"never\")',",
    "  ].join('\\n'), '<marks>', 'marks_test');",
    "  const r = {};",
    "  for (const [k, v] of m.out.$m) r[k] = v.$raised === true;",
    "  r.never = m.never.$raised === true;",
    "  console.log(JSON.stringify(r));",
    "});",
  ].join("\n");
  const r = JSON.parse(execFileSync(process.execPath, ["-e", code], { encoding: "utf8" }).trim());
  assert.deepEqual(r, { list_iterator: true, "sys.exit": true, pep479: true, open: true, linalg: true, throw: true, never: false });
});
