import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// The match statement, compared with CPython 3.14 (test/match_cases.py):
// every pattern kind, the binding and guard rules, the runtime TypeErrors and
// ValueErrors, and the compile-time SyntaxErrors with their positions.
const TEST = __dirname + "/../../test/";
for (const name of ["match_cases.py", "match_review_overflow_probe.py", "match_review_delta_probe.py", "match_review_probe.py", "match_review_order_probe.py", "match_review_snapshot_probe.py", "match_review_or_probe.py"])
test(`match: CPython's results, errors and SyntaxErrors (${name})`, () => {
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});

// Cost (daybreak2): the cases are a flat chain, each case's test linear in
// its pattern, so 5000 cases compile and run, and a pattern nested 80 deep
// matches, in well under the bounds here; the subject is evaluated once and
// each case's test only until one matches
test("match: 5000 cases and an 80-deep pattern compile and run quickly", () => {
  const code = [
    "import time",
    "t = time.perf_counter()",
    "src = 'def f(v):\\n match v:\\n' + ''.join(f'  case {i}: return {i}\\n' for i in range(5000)) + '  case _: return -1\\n'",
    "ns = {}",
    "exec(src, ns)",
    "compiled = time.perf_counter() - t",
    "t = time.perf_counter()",
    "total = sum(ns['f'](i) for i in range(0, 5000, 50)) + ns['f'](9999)",
    "ran = time.perf_counter() - t",
    "d = 80",
    "ns2 = {}",
    "exec('def g(v):\\n match v:\\n  case ' + '[' * d + 'x' + ']' * d + ': return x\\n  case _: return None\\n', ns2)",
    "v = 7",
    "for _ in range(d): v = [v]",
    "print(total, ns2['g'](v), ns2['g']([[1, 2]]), compiled < 10, ran < 5)",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" }).trim();
  assert.equal(out, "247499 7 None True True");
});

// ... and wide patterns (daybreak2, 23329bff): 3000 keyword attributes in a
// class pattern, and an or-pattern of 3000 alternatives after 3000 captures,
// compile and match linearly, well under the bounds here
test("match: wide class keywords and or-patterns after many captures compile and run quickly", () => {
  const code = [
    "import time",
    "n = 3000",
    "class O: pass",
    "o = O()",
    "for i in range(n): setattr(o, f'a{i}', i)",
    "t = time.perf_counter()",
    "ns = {'O': O}",
    "exec('def f(v):\\n match v:\\n  case O(' + ', '.join(f'a{i}=x{i}' for i in range(n)) + '): return x0 + x' + str(n - 1) + '\\n', ns)",
    "caps = ', '.join(f'c{i}' for i in range(n))",
    "alts = ' | '.join(f'[{i}, z]' for i in range(n))",
    "exec('def g(v):\\n match v:\\n  case [' + caps + ', (' + alts + ')]: return z + c0\\n', ns)",
    "compiled = time.perf_counter() - t",
    "t = time.perf_counter()",
    "r = (ns['f'](o), ns['g'](list(range(n)) + [[n - 1, 5]]), ns['g'](list(range(n)) + [[n, 5]]))",
    "ran = time.perf_counter() - t",
    "print(r, compiled < 10, ran < 5)",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" }).trim();
  assert.equal(out, "(2999, 5, None) True True");
});
