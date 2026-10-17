import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { execFileSync, spawnSync } from "node:child_process";

// HARD-978-1 and -2: str.translate, str.maketrans, the re loops textwrap
// uses, and translate's output size.  Each input is built first; only then
// is the interrupt word handed over, so Stop lands in the operation itself.
const DIST = __dirname + "/..";
const CLI = DIST + "/src/cli.js";

function stopDuring(setup: string, op: string, ms = 100): Promise<{ last: string; late: number }> {
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const c = require(workerData.dist + "/src/compile.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      try {
        // (the library on sys.path, as the CLI puts it)
        c.R.importModule("sys").path.push(c.libDir());
        const m = c.execModule(workerData.setup, "<setup>", "__main__");
        parentPort.postMessage({ intr: c.R.INTR.buffer });
        c.R.loader.exec(workerData.op, m, "exec", "<op>");
        parentPort.postMessage({ done: "finished" });
      } catch (e) {
        parentPort.postMessage({ done: c.R.formatException(e).trim().split("\\n").pop() });
      }
    });
    `,
    { eval: true, workerData: { dist: DIST, setup, op } },
  );
  return new Promise((resolve, reject) => {
    let stoppedAt = 0;
    const timer = setTimeout(() => (w.terminate(), resolve({ last: "not interrupted", late: Infinity })), 60000);
    w.on("message", (m) => {
      if (m.intr) setTimeout(() => ((stoppedAt = Date.now()), Atomics.store(new Int32Array(m.intr), 0, 1)), ms);
      if (m.done) (clearTimeout(timer), w.terminate(), resolve({ last: m.done, late: Date.now() - stoppedAt }));
    });
    w.on("error", reject);
  });
}

test("Stop interrupts str.translate, str.maketrans, re.split and textwrap.fill on large inputs (HARD-978-1)", async () => {
  const cases: [string, string][] = [
    ["s = 'ab c' * 5_000_000\nt = {97: 'x', 99: None}", "while True:\n    s.translate(t)"],
    ["d = {i: i + 1 for i in range(500_000)}", "while True:\n    str.maketrans(d)"],
    ["a = 'a' * 2_000_000\nb = 'b' * 2_000_000", "while True:\n    str.maketrans(a, b, a)"],
    ["import re\ns = 'ab ' * 2_000_000", "while True:\n    re.split(r'(\\s+)', s)"],
    ["import re\ns = 'ab ' * 2_000_000", "while True:\n    re.sub(r'b', 'c', s)"],
    ["import textwrap\ns = 'word ' * 800_000", "textwrap.fill(s, 40)"],
  ];
  for (const [setup, op] of cases) {
    const r = await stopDuring(setup, op);
    assert.equal(r.last, "KeyboardInterrupt", op);
    assert.ok(r.late < 1500, `${op}: stopped ${r.late} ms after Stop`);
  }
});

test("an output too long to make is a MemoryError, from translate before it is built, and from other strings (HARD-978-2)", () => {
  const code = [
    "for f in (lambda: ('a' * 100_000).translate({97: 'x' * 10_000}), lambda: 'ab' * 10 ** 9, lambda: ''.join(['x' * 10_000] * 100_000)):",
    "    try:",
    "        f()",
    "        print('made')",
    "    except MemoryError as e:",
    "        print('MemoryError', repr(e))",
    "print(len(('a' * 1000).translate({97: 'xyz'})))",
  ].join("\n");
  const out = execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8", timeout: 60000 });
  assert.equal(out, "MemoryError MemoryError()\nMemoryError MemoryError()\nMemoryError MemoryError()\n3000\n");
});

// (each in a process of its own, with the whole 96 MB: in one process the
// first part's 20M-character strings stay alive into the second, held by
// strpos's cache of the last string indexed by code point, which left the
// two together about 4 MB under the limit; alone they need about 64 and
// 56 MB, and an entry per character would need hundreds)
test("translate and maketrans stream large strings: 20M characters in a 96 MB heap, without an entry per character (HARD-C56-1)", () => {
  const parts: [string[], string][] = [
    [
      [
        "import time",
        "s = 'abcdefgh' * 2_500_000",
        "t = time.perf_counter()",
        "r = s.translate({})",
        "print(r is s or r == s, len(r), time.perf_counter() - t < 10)",
        "r = s.translate({97: None, 98: 'BB'})",
        "print(len(r), r[:6])",
      ],
      "True 20000000 True\n20000000 BBcdef\n",
    ],
    [
      [
        "import time",
        "a = ''.join(chr(0x4e00 + i % 20000) for i in range(100_000)) * 100",
        "b = a[1:] + a[:1]",
        "t = time.perf_counter()",
        "m = str.maketrans(a, b)",
        "print(len(m), time.perf_counter() - t < 10)",
      ],
      "20000 True\n",
    ],
  ];
  for (const [code, want] of parts) {
    const r = spawnSync(process.execPath, ["--max-old-space-size=96", CLI, "-c", code.join("\n")], { encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, want);
  }
});
