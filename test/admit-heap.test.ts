import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// admitHeap (src/runtime/heap.ts, #956): a large allocation is admitted against the heap free now, not only the
// session's whole heap, so a conversion that would exhaust a partly full heap raises MemoryError before it starts
// instead of the host aborting. The decision is tested through heapProbe (the heap in use, one full collection),
// replaced here, so no row depends on the host's figures or timing; the repro rows run the real thing.
const ROOT = join(__dirname, "../..");
const CLI = join(__dirname, "../src/cli.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const R = require(join(__dirname, "../src/runtime/index.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const H = require(join(__dirname, "../src/runtime/heap.js"));

const L: number = H.heapLimit();
const MiB = 2 ** 20;
const mb = (n: number) => Math.ceil(n / MiB);
function admit(need: number, used: number | null, freed: number | null = null) {
  const calls = { used: 0, collect: 0 };
  let collected = false;
  const saved = { ...H.heapProbe };
  H.heapProbe.used = () => (calls.used++, collected && freed !== null ? freed : used);
  H.heapProbe.collect = () => (calls.collect++, (collected = freed !== null));
  try {
    H.admitHeap(need, "doing it");
    return { ok: true, msg: "", calls };
  } catch (e) {
    return { ok: false, msg: R.formatException(e).trim(), calls };
  } finally {
    Object.assign(H.heapProbe, saved);
  }
}

test("admitHeap: a small request never reads the host's figures or collects; past the whole limit, refused at once", () => {
  for (const need of [0, 1, L / 64 - 1]) assert.deepEqual(admit(need, L).calls, { used: 0, collect: 0 }, `need ${need}`);
  const r = admit(L + 1, 0);
  assert.equal(r.ok, false);
  assert.deepEqual(r.calls, { used: 0, collect: 0 });
  assert.equal(r.msg, `MemoryError: doing it needs about ${mb(L + 1)} MiB, more than this session's ${mb(L)} MiB`);
});

test("admitHeap: a large request against the heap free now; one full collection when it doesn't fit, then refused or admitted", () => {
  const need = L / 4;
  // (fits as the heap stands: no collection)
  assert.deepEqual(admit(need, L - need), { ok: true, msg: "", calls: { used: 1, collect: 0 } });
  // (doesn't fit; the collection frees enough: admitted)
  assert.deepEqual(admit(need, L - need + 1, L / 2), { ok: true, msg: "", calls: { used: 2, collect: 1 } });
  // (doesn't fit, before or after the collection: refused, naming what is free)
  const r = admit(need, L - need + MiB, L - need + MiB);
  assert.equal(r.ok, false);
  assert.deepEqual(r.calls, { used: 2, collect: 1 });
  assert.equal(r.msg, `MemoryError: doing it needs about ${mb(need)} MiB, more than the about ${mb(need - MiB)} MiB this session's heap has free (of ${mb(L)} MiB)`);
  // (no collection here, as in a browser: refused on the first figure)
  const saved = { ...H.heapProbe };
  let collects = 0;
  H.heapProbe.used = () => L - need + MiB;
  H.heapProbe.collect = () => (collects++, false);
  try {
    assert.throws(() => H.admitHeap(need, "doing it"));
    assert.equal(collects, 1);
  } finally {
    Object.assign(H.heapProbe, saved);
  }
});

test("admitHeap: where the host gives no figure, a large request is admitted up to a quarter of the limit", () => {
  assert.equal(admit(L / 4, null).ok, true);
  const r = admit(L / 4 + MiB, null);
  assert.equal(r.ok, false);
  assert.equal(r.msg, `MemoryError: doing it needs about ${mb(L / 4 + MiB)} MiB, more than a quarter of this session's ${mb(L)} MiB (this host doesn't say how much of it is free)`);
  assert.deepEqual(r.calls, { used: 1, collect: 0 });
});

// (#956's repro, in a 256 MiB heap: master converts with up to 14 ballast ints of 8 MiB and aborts the host from 16
// on; here a heap that can't hold the conversion is refused before it starts, the session goes on, and once the
// ballast is gone the same conversion runs)
const lowheap = (...args: string[]) =>
  spawnSync(process.execPath, ["--max-old-space-size=256", CLI, join(ROOT, "test/intstr_lowheap.py"), ...args], { encoding: "utf8", timeout: 120000 });

// (the refusal is before any digit is made, so this row is quick; the session's reuse is shown with a smaller int,
// 2^24 bits, still on the large path in this heap)
test("#956's repro: a partly full heap refuses the conversion with MemoryError, and the session goes on to convert again", () => {
  const r = lowheap("134217728", "67108864", "20", "16777216");
  assert.equal(r.status, 0, r.stderr.slice(-500));
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines[0], "ballast: 20 ints of 67108864 bits; converting an int of 134217728 bits");
  assert.match(lines[1], /^MemoryError: converting an int of about 40403562 digits needs about 142 MiB, more than the about \d+ MiB this session's heap has free \(of 256 MiB\)$/);
  assert.equal(lines[2], "session still usable: 45");
  assert.equal(lines[3], "after clearing: 5050446 digits");
});

test("without ballast, a conversion on the large path (2^24 bits in a 256 MiB heap) is admitted and runs", () => {
  const r = lowheap("16777216", "1048576", "0");
  assert.equal(r.status, 0, r.stderr.slice(-500));
  assert.deepEqual(r.stdout.trim().split("\n").slice(1), ["converted: 5050446 digits", "session still usable: 45"]);
});

test("Stop interrupts a conversion admitted on the large path (a 256 MiB heap)", () => {
  // (13,000,000 bits: about 14 MiB at its peak, past 256/64, so admitHeap reads the heap, counted here; the
  // conversion takes seconds, and Stop, the interrupt flag, lands in it, as in int-digit-limits.test.ts)
  const code = "import sys\nsys.set_int_max_str_digits(0)\nx = (1 << 13_000_000) - 1\nwhile True:\n    s = str(x)\n";
  const worker = [
    "const { parentPort, workerData } = require('node:worker_threads');",
    "const c = require(workerData.dist + '/src/compile.js');",
    "const H = require(workerData.dist + '/src/runtime/heap.js');",
    "let reads = 0;",
    "const used = H.heapProbe.used;",
    "H.heapProbe.used = () => (reads++, used());",
    "Promise.resolve(c.initParser && c.initParser()).then(() => {",
    "  parentPort.postMessage({ intr: c.R.INTR.buffer });",
    "  let last = 'finished';",
    "  try { c.execModule(workerData.code, '<test>', '__main__'); } catch (e) { last = c.R.formatException(e).trim().split('\\n').pop(); }",
    "  parentPort.postMessage({ done: last, reads });",
    "});",
  ].join("\n");
  const js = [
    "const { Worker } = require('node:worker_threads');",
    `const w = new Worker(${JSON.stringify(worker)}, { eval: true, workerData: { dist: ${JSON.stringify(join(__dirname, ".."))}, code: ${JSON.stringify(code)} } });`,
    "const timer = setTimeout(() => (console.log(JSON.stringify({ done: 'not interrupted' })), process.exit(0)), 30000);",
    "w.on('message', (m) => {",
    "  if (m.intr) setTimeout(() => Atomics.store(new Int32Array(m.intr), 0, 1), 1500);",
    "  if (m.done) (clearTimeout(timer), console.log(JSON.stringify(m)), process.exit(0));",
    "});",
  ].join("\n");
  const r = spawnSync(process.execPath, ["--max-old-space-size=256", "-e", js], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr.slice(-500));
  const m = JSON.parse(r.stdout.trim().split("\n").pop()!);
  assert.equal(m.done, "KeyboardInterrupt");
  assert.ok(m.reads >= 1, "the conversion was admitted on the large path");
});
