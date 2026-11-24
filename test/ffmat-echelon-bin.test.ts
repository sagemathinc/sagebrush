import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { binCall } from "../src/runtime/engine";
import { SLOW } from "./slow-tests";

// GF(p) echelon on the binary route (nmod_echelon over SBW1) in pyjs: the cases of test/ffmat_echelon_bin.py (shared with CPython,
// engine/py/test_ech_bin.py), in a 1 GiB heap so that the cases' operands
// are admitted by the figure in force.
const CLI = join(__dirname, "..", "src", "cli.js");
const CASES = join(__dirname, "..", "..", "test", "ffmat_echelon_bin.py");
const HEAP = ["--max-old-space-size=1024", "--expose-gc"];
// (the memory case builds 2^16- and 1.2 * 2^20-entry operands over a 63-bit
// prime: CI's long tier only, with the slow tests and the JSON route's own
// memory cases, test/ffmat-echelon-admission.test.ts; SAGEBRUSH_FULL=1
// runs it anywhere)
const FULL = SLOW || process.env.SAGEBRUSH_FULL === "1";

function run(c: string, timeout = 900000) {
  return spawnSync(process.execPath, [...HEAP, CLI, "--sage", CASES, c], { encoding: "utf8", timeout, maxBuffer: 1 << 24 });
}

// (an engine build without the binary echelon answers its frame with an
// unknown-op error record)
function binaryEchelon(): boolean {
  const name = new TextEncoder().encode("nmod_echelon");
  const u641 = (w: bigint[]) => {
    const b = new Uint8Array(12 + 8 * w.length);
    const v = new DataView(b.buffer);
    b.set(new TextEncoder().encode("U641"));
    v.setBigUint64(4, BigInt(w.length), true);
    w.forEach((x, i) => v.setBigUint64(12 + 8 * i, x, true));
    return b;
  };
  const mat = new Uint8Array(12 + 20);
  mat.set(new TextEncoder().encode("MAT1"));
  new DataView(mat.buffer).setUint32(4, 1, true);
  new DataView(mat.buffer).setUint32(8, 1, true);
  mat.set(u641([1n]), 12);
  const args = [u641([7n]), mat, u641([0n])];
  const len = 4 + 4 + name.length + 4 + args.reduce((n, a) => n + 4 + a.length, 0);
  const req = new Uint8Array(len);
  const dv = new DataView(req.buffer);
  req.set(new TextEncoder().encode("SBW1"));
  dv.setUint32(4, name.length, true);
  req.set(name, 8);
  let at = 8 + name.length;
  dv.setUint32(at, args.length, true);
  at += 4;
  for (const a of args) {
    dv.setUint32(at, a.length, true);
    req.set(a, at + 4);
    at += 4 + a.length;
  }
  const r = binCall(req);
  return r !== null && new TextDecoder().decode(r.subarray(4, 6)) === "ok";
}

for (const [c, full] of [
  ["route", false], ["correct", false], ["json", false], ["probe", false], ["preflight", false],
  ["frame", false], ["outcomes", false], ["kernel", false], ["kernelmem", false], ["mem", true], ["cops", true],
] as const) {
  test(`GF(p) echelon, the binary route in pyjs: ${c}`, (t) => {
    if (!binaryEchelon()) return t.skip("this engine build predates the binary nmod_echelon");
    if (full && !FULL) return t.skip("the full tier's (SAGEBRUSH_FULL=1)");
    const r = run(c);
    assert.ifError(r.error);
    assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-2000));
    assert.match(r.stdout, new RegExp(`^ok ${c} `, "m"));
    if (c === "mem" || c === "cops") console.log(r.stdout.trim());
  });
}

// (in a worker of this process, as test/ffmat-echelon-admission.test.ts: the
// test sets the interrupt word's Ctrl-C bit itself, once the request is
// built)
test("Ctrl-C during a binary elimination at 2048 x 2048 raises KeyboardInterrupt, not a fallback", async (t) => {
  if (!binaryEchelon()) return t.skip("this engine build predates the binary nmod_echelon");
  const dir = mkdtempSync(join(tmpdir(), "ffmat-bin-intr-"));
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
    const timer = setTimeout(() => (w.terminate(), resolve({ done: "timed out" })), 900000);
    const poll = setInterval(() => {
      if (intr && existsSync(join(dir, "ready"))) {
        clearInterval(poll);
        setTimeout(() => Atomics.or(intr!, 0, 1), 300);
      }
    }, 20);
    w.on("message", (m) => {
      if (m.intr) intr = new Int32Array(m.intr);
      if (m.done) (clearTimeout(timer), clearInterval(poll), w.terminate(), resolve(m));
    });
    w.on("error", (e) => (clearTimeout(timer), clearInterval(poll), reject(e)));
  });
  assert.equal(r.done, "ok", JSON.stringify(r));
  assert.equal(readFileSync(join(dir, "result"), "utf8"), "interrupted [(2048, 2048, True)]");
});
