import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { binCall } from "../src/runtime/engine";
import { SLOW } from "./slow-tests";

// GF(p) matrix products on the binary route (nmod_mat_mul over SBW1) in pyjs: the cases of test/ffmat_mul_bin.py (shared
// with CPython, engine/py/test_mul_bin.py), in a 1 GiB heap so that the cases' operands are admitted by the figure in force.
const CLI = join(__dirname, "..", "src", "cli.js");
const CASES = join(__dirname, "..", "..", "test", "ffmat_mul_bin.py");
const HEAP = ["--max-old-space-size=1024", "--expose-gc"];
// (the memory case reads /proc/self/clear_refs and builds 2^16-entry operands over a 63-bit prime: CI's long tier only,
// as the echelon's; SAGEBRUSH_FULL=1 runs it anywhere it can)
const FULL = SLOW || process.env.SAGEBRUSH_FULL === "1";

function run(c: string, timeout = 900000) {
  return spawnSync(process.execPath, [...HEAP, CLI, "--sage", CASES, c], { encoding: "utf8", timeout, maxBuffer: 1 << 24 });
}

// (an engine build without the binary product answers its frame with an unknown-op error record)
function binaryProduct(): boolean {
  const enc = new TextEncoder();
  const name = enc.encode("nmod_mat_mul");
  const u641 = (w: bigint[]) => {
    const b = new Uint8Array(12 + 8 * w.length);
    const v = new DataView(b.buffer);
    b.set(enc.encode("U641"));
    v.setBigUint64(4, BigInt(w.length), true);
    w.forEach((x, i) => v.setBigUint64(12 + 8 * i, x, true));
    return b;
  };
  const mat = () => {
    const m = new Uint8Array(12 + 20);
    m.set(enc.encode("MAT1"));
    new DataView(m.buffer).setUint32(4, 1, true);
    new DataView(m.buffer).setUint32(8, 1, true);
    m.set(u641([1n]), 12);
    return m;
  };
  const args = [u641([7n]), mat(), mat()];
  const len = 4 + 4 + name.length + 4 + args.reduce((n, a) => n + 4 + a.length, 0);
  const req = new Uint8Array(len);
  const dv = new DataView(req.buffer);
  req.set(enc.encode("SBW1"));
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
  ["lazy", false], ["correct", false], ["threshold", false], ["frame", false], ["preflight", false],
  ["outcomes", false], ["fields", false], ["oracle", false], ["mem", true],
] as const) {
  test(`GF(p) products, the binary route in pyjs: ${c}`, (t) => {
    if (!binaryProduct()) return t.skip("this engine build predates the binary nmod_mat_mul");
    if (full && !FULL) return t.skip("the full tier's (SAGEBRUSH_FULL=1)");
    const r = run(c);
    assert.ifError(r.error);
    assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-2000));
    assert.match(r.stdout, new RegExp(`^ok ${c} `, "m"));
    if (c === "mem") console.log(r.stdout.trim());
  });
}
