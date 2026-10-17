import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";

// json through the _json accelerator (src/runtime/json.ts), compared with
// CPython 3.14, whose json uses its C _json: dumps with every option,
// subclasses and default, notes on errors, loads of every value and every
// error with its position (astral strings counted in code points), hooks,
// and the module's own functions (test/json_accel_cases.py).
const TEST = __dirname + "/../../test/";
test("json.dumps and json.loads give CPython's output, errors, positions and notes", () => {
  const name = "json_accel_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8", maxBuffer: 1 << 26 });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `${name} line ${i + 1}`);
});

// sage2's benchmark (30000 small dicts, 2.19 M characters), timed against
// json's own pure-Python encoder and scanner in the same process, so that a
// loaded host slows both alike: 5 rounds, each timing the accelerator and
// the pure-Python path in turn (dumps, then loads), so that a stretch of
// load falls on both; the best of the 5 each, at least 3x faster both ways
// (about 7x and 8x on a quiet VM), the outputs identical every round; the
// pure-Python encoder switched on only around its own runs, in a finally,
// and checked off after
test("json.dumps and json.loads of 30000 small dicts are at least 3x json's pure-Python encoder and scanner", () => {
  const code = [
    "import json, time",
    "import json.encoder as E, json.scanner as S",
    "x = [{'a': i, 'b': [i, str(i), i / 2], 'c': {'d': None, 'e': True}} for i in range(30000)]",
    "ce, cs = E.c_make_encoder, S.make_scanner",
    "def pure(f):",
    "    try:",
    "        E.c_make_encoder = None",
    "        S.make_scanner = S.py_make_scanner",
    "        return f()",
    "    finally:",
    "        E.c_make_encoder, S.make_scanner = ce, cs",
    "def timed(f):",
    "    t = time.perf_counter(); v = f(); return time.perf_counter() - t, v",
    "pdec = pure(json.JSONDecoder)",
    "best = [None] * 4",
    "same = True",
    "for _ in range(5):",
    "    r = [timed(lambda: json.dumps(x)), pure(lambda: timed(lambda: json.dumps(x)))]",
    "    s = r[0][1]",
    "    r += [timed(lambda: json.loads(s)), timed(lambda: pdec.decode(s))]",
    "    same = same and r[1][1] == s and r[2][1] == x and r[3][1] == x",
    "    best = [d if b is None or d < b else b for b, (d, _) in zip(best, r)]",
    "fd, pd, fl, pl = best",
    "assert E.c_make_encoder is not None and S.make_scanner is S.c_make_scanner is not None and getattr(pdec.scan_once, '__module__', None) == 'json.scanner'",
    "print(round(pd / fd, 2), round(pl / fl, 2), same, round(fd, 3), round(fl, 3), round(pd, 3), round(pl, 3))",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" }).trim().split(" ");
  assert.equal(out[2], "True");
  assert.ok(Number(out[0]) >= 3 && Number(out[1]) >= 3, `dumps ${out[0]}x (${out[3]} s vs ${out[5]} s), loads ${out[1]}x (${out[4]} s vs ${out[6]} s)`);
});

// The nesting budget (HARD-C0E-1): 40000 levels, the empty innermost one
// counted, pass both ways and level 40001 is a RecursionError, for arrays
// and objects, 100000 too, with dumps' note. (CPython's own limit is its
// C stack, so its host's: 100000 levels fail on our VMs and pass on
// GitHub's runners. This boundary is Sagebrush's, the same on every host:
// the scanner and encoder keep their own stacks, so it holds under a JS
// stack far smaller than Node's default too.)
for (const stack of [null, 200])
test(`json nesting: 40000 levels pass, 40001 and 100000 are a RecursionError, loads and dumps${stack === null ? "" : `, under --stack-size=${stack}`}`, () => {
  const code = [
    "import json",
    "def t(f):",
    "    try:",
    "        f()",
    "        return 'ok'",
    "    except RecursionError as e:",
    "        return 'RecursionError'",
    "def lists(n):",
    "    d = []",
    "    for _ in range(n - 1): d = [d]",
    "    return d",
    "def dicts(n):",
    "    d = {}",
    "    for _ in range(n - 1): d = {'a': d}",
    "    return d",
    "for n in [40000, 40001, 100000]:",
    "    print(n, t(lambda: json.loads('[' * n + ']' * n)), t(lambda: json.loads('{\"a\":' * (n - 1) + '{}' + '}' * (n - 1))),",
    "          t(lambda: json.dumps(lists(n))), t(lambda: json.dumps(dicts(n))), t(lambda: json.dumps(lists(n), indent=0)))",
    "try: json.dumps(lists(100000))",
    "except RecursionError as e: print(e.__notes__[0], len(e.__notes__))",
  ].join("\n");
  const out = execFileSync(process.execPath, [...(stack === null ? [] : [`--stack-size=${stack}`]), __dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" }).trim();
  assert.equal(out, "40000 ok ok ok ok ok\n40001 RecursionError RecursionError RecursionError RecursionError RecursionError\n100000 RecursionError RecursionError RecursionError RecursionError RecursionError\nwhen serializing list item 0 40000");
});

// Stop (INTR[0]) reaches every long loop (HARD-C0E-2). Set before a call of
// the accelerator itself (no Python code runs first to take it), it stops a
// scan of a long string, of whitespace, of digits, a flat array, deep
// nesting, many escapes, a long string encoded and flat lists encoded, each with a
// KeyboardInterrupt and the flag cleared; unset, the same calls finish.
test("Stop interrupts each of the accelerator's long loops", () => {
  const code = [
    `const c = require(${JSON.stringify(__dirname + "/../src/compile.js")});`,
    `const O = require(${JSON.stringify(__dirname + "/../src/runtime/object.js")});`,
    `const { INTR } = require(${JSON.stringify(__dirname + "/../src/runtime/interrupt.js")});`,
    "Promise.resolve(c.initParser && c.initParser()).then(() => {",
    "  c.R.importModule('sys').path.push(c.libDir());",
    "  const m = c.execModule([",
    "    'import json, _json',",
    "    'N = 1_000_000',",
    "    'scan = json.scanner.c_make_scanner(json.decoder.JSONDecoder())',",
    "    'enc = _json.make_encoder(None, None, _json.encode_basestring_ascii, None, \": \", \", \", False, False, True)',",
    "    'enc2 = _json.make_encoder(None, None, _json.encode_basestring, None, \": \", \", \", False, False, True)',",
    "    'inputs = [\"\\\\\"\" + \"a\" * N + \"\\\\\"\", \"[\" + \" \" * N + \"1]\", \"0.\" + \"0\" * N, \"1e\" + \"0\" * N, \"[\" + \"0,\" * N + \"0]\", \"[\" * 30000 + \"]\" * 30000, \"\\\\\"\" + \"\\\\\\\\n\" * N + \"\\\\\"\"]',",
    "    'outputs = [\"a\" * N, [0] * N, [[\"x\"] * 5000] * 200]',",
    "  ].join('\\n'), '<setup>', 'jsetup');",
    "  const res = [];",
    "  const one = (f) => {",
    "    INTR[0] = 1;",
    "    let r;",
    "    try { f(); r = 'finished'; } catch (e) { r = c.R.formatException(O.toPyExc(e)).trim().split('\\n').pop(); }",
    "    r += INTR[0] ? ' flag kept' : '';",
    "    INTR[0] = 0;",
    "    try { f(); r += ' / finished'; } catch (e) { r += ' / ' + c.R.formatException(O.toPyExc(e)).trim().split('\\n').pop(); }",
    "    res.push(r);",
    "  };",
    "  for (const s of m.inputs) one(() => O.callObj(m.scan, [s, 0]));",
    "  for (const o of m.outputs) for (const e of [m.enc, m.enc2]) one(() => O.callObj(e, [o, 0]));",
    "  console.log(JSON.stringify(res));",
    "});",
  ].join("\n");
  const res = JSON.parse(execFileSync(process.execPath, ["-e", code], { encoding: "utf8", maxBuffer: 1 << 26 }).trim());
  assert.equal(res.length, 13);
  for (const r of res) assert.equal(r, "KeyboardInterrupt / finished");
});

// ... and, from another thread as the notebook's Stop, within a deadline:
// a huge flat loads and dumps, a huge object loads (its pairs made a dict),
// a huge sorted dict dumps (its entries copied), a dumps whose default()
// keeps extending the list being encoded, and list and dict subclasses
// whose __iter__ or items() never ends (HARD-A73-1)
function interruptAfter(setup: string, run: string, ms: number): Promise<string> {
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const c = require(workerData.dist + "/src/compile.js");
    const O = require(workerData.dist + "/src/runtime/object.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      c.R.importModule("sys").path.push(c.libDir());
      const m = c.execModule(workerData.setup, "<setup>", "jsetup");
      parentPort.postMessage({ intr: c.R.INTR.buffer });
      try {
        O.callObj(m[workerData.run], []);
        parentPort.postMessage({ done: "finished" });
      } catch (e) {
        parentPort.postMessage({ done: c.R.formatException(O.toPyExc(e)).trim().split("\\n").pop() });
      }
    });
    `,
    { eval: true, workerData: { dist: __dirname + "/..", setup, run } },
  );
  return new Promise((resolve, reject) => {
    let at = 0;
    const timer = setTimeout(() => (w.terminate(), resolve("not interrupted")), 60000);
    w.on("message", (m) => {
      if (m.intr) setTimeout(() => ((at = Date.now()), Atomics.store(new Int32Array(m.intr), 0, 1)), ms);
      if (m.done) {
        clearTimeout(timer);
        w.terminate();
        resolve(at === 0 ? `${m.done} before the interrupt` : Date.now() - at > 1000 ? `${m.done} after ${Date.now() - at} ms` : m.done);
      }
    });
    w.on("error", reject);
  });
}

test("Stop interrupts a huge flat loads and dumps, and a default() that keeps the traversal going", async () => {
  const setup = [
    "import json",
    "s = '[' + '0,' * 10_000_000 + '0]'",
    "x = ['ab'] * 10_000_000",
    "def loads(): json.loads(s)",
    "def dumps(): json.dumps(x)",
    "l = [object()]",
    "def more(o):",
    "    l.append(object())",
    "    return 1",
    "def forever(): json.dumps(l, default=more)",
    "import itertools",
    "o = '{' + ','.join(f'\"k{i}\": 0' for i in range(1_000_000)) + '}'",
    "def objects(): json.loads(o)",
    "d = {f'k{i}': 0 for i in range(1_000_000)}",
    "def sorted_dumps(): json.dumps(d, sort_keys=True)",
    "class L(list):",
    "    def __iter__(self): return itertools.count()",
    "class D(dict):",
    "    def items(self): return itertools.repeat(('a', 1))",
    "def endless_iter(): json.dumps(L([1]))",
    "def endless_items(): json.dumps(D(a=1))",
  ].join("\n");
  for (const run of ["loads", "dumps", "forever", "objects", "sorted_dumps", "endless_iter", "endless_items"]) assert.equal(await interruptAfter(setup, run, 20), "KeyboardInterrupt", run);
});
