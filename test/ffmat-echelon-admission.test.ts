import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { engineCall } from "../src/runtime/engine";

// GF(p) echelon admission by shape (plan F4 r4, d5c6c1cd) in pyjs: the
// cases of test/ffmat_echelon_admission.py (shared with CPython,
// engine/py/test_ffmat_echelon.py), run in a 1 GiB heap so that the
// envelope's operands are admitted by the figure in force; and
// engineCall's request copy, through the runtime itself.
const CLI = join(__dirname, "..", "src", "cli.js");
const CASES = join(__dirname, "..", "..", "test", "ffmat_echelon_admission.py");
const HEAP = ["--max-old-space-size=1024", "--expose-gc"];
// (the memory measurements build four 2^20-entry operands over a 63-bit
// prime each: the full tier's, as the plan has them; SAGEBRUSH_FULL=1 runs
// them anywhere)
const FULL = ["workflow_dispatch", "schedule"].includes(process.env.GITHUB_EVENT_NAME ?? "") || process.env.GITHUB_REF === "refs/heads/master" || process.env.SAGEBRUSH_FULL === "1";

function run(c: string, timeout = 600000) {
  return spawnSync(process.execPath, [...HEAP, CLI, "--sage", CASES, c], { encoding: "utf8", timeout, maxBuffer: 1 << 24 });
}

// (an engine build from before the 1024 x 1024 envelope refuses 401 x 401)
function envelope(): boolean {
  const zeros = Array(401).fill(Array(401).fill("0").join(",")).join(";");
  return engineCall(`{"fn":"nmod_echelon","p":"7","rows":401,"cols":401,"m":"${zeros}"}`).startsWith('{"ok":');
}

for (const [c, needsEnvelope, full] of [
  ["bridge", false, false], ["correct", false, false],
  // (route in four parts: each crosses into pyjs's Python elimination, about
  // ten minutes together on CI's runners, so one process each)
  ["route-ech", true, false], ["route-solve", true, false], ["route-solvek", true, false], ["route-inv", true, false],
  ["preflight", true, false],
  ["integration", true, false], ["mem-T", true, true], ["mem-Tp", true, true], ["mem-W", true, true], ["negctl", false, true],
] as const) {
  test(`GF(p) echelon admission in pyjs: ${c}`, (t) => {
    if (needsEnvelope && !envelope()) return t.skip("this engine build predates the 1024 x 1024 envelope");
    if (full && !FULL) return t.skip("the full tier's (SAGEBRUSH_FULL=1)");
    const r = run(c);
    assert.ifError(r.error);
    assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-2000));
    assert.match(r.stdout, new RegExp(`^ok ${c} `, "m"));
    if (c.startsWith("mem") || c === "negctl") console.log(r.stdout.trim());
  });
}

// (in a worker of this process, as test/engine-stop-reclaim.test.ts: the
// CLI takes Ctrl-C only through its launcher's thread; here the test sets
// the interrupt word's Ctrl-C bit itself, once the request is built)
test("Ctrl-C during an engine elimination at 1024 x 1024 raises KeyboardInterrupt, not a fallback", async (t) => {
  if (!envelope()) return t.skip("this engine build predates the 1024 x 1024 envelope");
  const dir = mkdtempSync(join(tmpdir(), "ffmat-intr-"));
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const fs = require("node:fs");
    const c = require(workerData.dist + "/src/compile.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      c.R.importModule("sys").path.push(c.libDir());
      parentPort.postMessage({ intr: c.R.INTR.buffer });
      try {
        c.execModule("import sys\\nsys.argv = " + JSON.stringify([workerData.cases, "interrupt", workerData.dir]), "<argv>", "__main__");
        c.execModule(fs.readFileSync(workerData.cases, "utf8"), workerData.cases, "__main__");
        parentPort.postMessage({ done: "ok" });
      } catch (e) {
        parentPort.postMessage({ done: c.R.formatException(e).trim().split("\\n").pop() });
      }
    });
    `,
    { eval: true, workerData: { dist: join(__dirname, ".."), cases: CASES, dir } },
  );
  const r: any = await new Promise((resolve, reject) => {
    let intr: Int32Array | null = null;
    const timer = setTimeout(() => (w.terminate(), resolve({ done: "timed out" })), 600000);
    const poll = setInterval(() => {
      if (intr && existsSync(join(dir, "ready"))) {
        clearInterval(poll);
        setTimeout(() => Atomics.or(intr!, 0, 1), 200);
      }
    }, 20);
    w.on("message", (m) => {
      if (m.intr) intr = new Int32Array(m.intr);
      if (m.done) (clearTimeout(timer), clearInterval(poll), w.terminate(), resolve(m));
    });
    w.on("error", (e) => (clearTimeout(timer), clearInterval(poll), reject(e)));
  });
  assert.equal(r.done, "ok", JSON.stringify(r));
  assert.equal(readFileSync(join(dir, "result"), "utf8"), "interrupted [(1024, 1024)]");
});

// engineCall writes an ASCII request straight into the engine's memory
// (plan F4 r4 §2a(a)): no request-sized copy outside it.  The same request
// with one non-ASCII character takes the encoder path, whose 20 MiB copy
// the measurement sees (the negative control: today's bridge did this for
// every request).
test("engineCall: an ASCII request makes no copy outside wasm memory; a non-ASCII one takes the encoder path", (t) => {
  if (!envelope()) return t.skip("this engine build predates the 1024 x 1024 envelope");
  const P = 9223372036854775783n;
  const row = Array.from({ length: 1024 }, (_, j) => String(P - 1n - BigInt(j % 1000))).join(",");
  const m = Array(1024).fill(row).join(";");
  const req = (note: string) => `{"fn":"nmod_echelon","p":"${P}","rows":1024,"cols":1024,"note":"${note}","m":"${m}","reduced":false,"want_rows":false}`;
  const ascii = req("a"), other = req("é\u{1F600}");
  assert.ok(ascii.length > 20_000_000);
  const encode = TextEncoder.prototype.encode;
  let encodes = 0;
  TextEncoder.prototype.encode = function (this: TextEncoder, s?: string) {
    encodes++;
    return encode.call(this, s);
  };
  try {
    // (the first call grows the engine's memory to this request's peak;
    // the measured ones then grow nothing in wasm)
    const first = engineCall(ascii);
    // (rank 1: pivot 0 only; det is the pivot product, the determinant only
    // of a full-rank square matrix)
    assert.match(first, /^\{"ok":\{"pivots":"0","det":"\d+"\}\}$/);
    (globalThis as any).gc?.();
    let before = process.memoryUsage();
    assert.equal(engineCall(ascii), first);
    let after = process.memoryUsage();
    const asciiExternal = after.external - before.external;
    assert.equal(encodes, 0, "the ASCII requests were not encoded");
    (globalThis as any).gc?.();
    before = process.memoryUsage();
    assert.equal(engineCall(other), first);
    after = process.memoryUsage();
    const otherExternal = after.external - before.external;
    assert.equal(encodes, 1, "the non-ASCII request took the encoder path");
    console.log(`engineCall 1024 x 1024 (${ascii.length} bytes): external growth ${asciiExternal} (ASCII), ${otherExternal} (non-ASCII)`);
    assert.ok(asciiExternal <= 1 << 20, `ASCII: external grew by ${asciiExternal}`);
    // (the encoder's copy is the request's UTF-8, ascii.length + 5 bytes;
    // process.memoryUsage().external moves by a few bytes besides (CI saw
    // 20971623 for a 20971642-byte request, a local run 20971647), so the
    // copy is asked within 64 KiB of its size: the copy is about 320x that
    // tolerance, and the bound it proves, about 20 MB, is about 20x the 1 MiB
    // ASCII ceiling above)
    assert.ok(otherExternal >= ascii.length - 65536, `non-ASCII: external grew by ${otherExternal}, less than the ${ascii.length}-byte copy less 64 KiB (the copy unseen?)`);
  } finally {
    TextEncoder.prototype.encode = encode;
  }
});

// the bytes engineCall writes are the request's UTF-8: the replies match a
// direct call through the ABI with TextEncoder.encode, for ASCII and for
// characters past U+007F and U+FFFF (a surrogate pair)
test("engineCall's bytes are the request's UTF-8, ASCII or not", () => {
  const bytes = readFileSync(join(__dirname, "..", "..", "wasm", "sagebrush-engine.wasm"));
  const e = new WebAssembly.Instance(new WebAssembly.Module(bytes), { sagebrush: { interrupted: () => 0 } }).exports as any;
  const direct = (request: string) => {
    const b = new TextEncoder().encode(request);
    const p = e.sb_alloc(b.length);
    new Uint8Array(e.memory.buffer, p, b.length).set(b);
    const r = e.sb_call(p, b.length);
    const out = new TextDecoder().decode(new Uint8Array(e.memory.buffer, r, e.sb_reply_len()));
    e.sb_free(p, b.length);
    return out;
  };
  for (const req of [
    '{"fn":"nmod_echelon","p":"7","rows":2,"cols":2,"m":"1,2;3,4","reduced":true,"want_rows":true}',
    '{"fn":"nmod_echelon","p":"7","rows":2,"cols":2,"note":"été \u{1F600}","m":"1,2;3,4","reduced":true,"want_rows":true}',
    '{"fn":"no such fn é \u{1F600}"}',
  ]) assert.equal(engineCall(req), direct(req), req);
});
