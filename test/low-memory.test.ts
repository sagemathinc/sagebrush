import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The low-memory flag (SAGEBRUSH_LOW_MEMORY=1, src/runtime/wasm_room.ts), the one explicit way to lower-memory routes
// (William, Nov 25 2026: "Require the explicit low-memory flag"): each chosen up front from the input, fixed limits
// and the flag, never by catching a failure. With it, engine/nd is not used (the TypeScript code, no shared memory
// reserved), and a kernel whose workspace is past its memory's fixed maximum takes its JavaScript path. argsort has
// no such route (its JavaScript path keeps its indices in a JavaScript array): refused, without naming the flag. A
// preload stubs the kernels' fixed maximum at 16 MiB (globalThis.__SAGEBRUSH_KERNEL_MAX_BYTES__), counts grows past
// it and shared memories made, on stderr.
function run(env: Record<string, string>, program: string): { out: string[]; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "sb-lowmem-"));
  const pre = join(dir, "pre.js");
  writeFileSync(pre, `globalThis.__SAGEBRUSH_KERNEL_MAX_BYTES__ = 16 * 2 ** 20;
const W = WebAssembly, RealMemory = W.Memory, real = RealMemory.prototype.grow;
let past = 0, shared = 0;
RealMemory.prototype.grow = function (pages) {
  if (this.buffer.byteLength + pages * 65536 > 16 * 2 ** 20) past++;
  return real.call(this, pages);
};
W.Memory = function (desc) { if (desc && desc.shared) shared++; return new RealMemory(desc); };
W.Memory.prototype = RealMemory.prototype;
process.on("exit", () => process.stderr.write("grows past the maximum: " + past + " shared memories: " + shared + "\\n"));`);
  try {
    const r = spawnSync(process.execPath, ["-r", pre, __dirname + "/../src/cli.js", "-c", program],
      { encoding: "utf8", env: { ...process.env, ...env } });
    return { out: r.stdout.trim().split("\n"), err: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PROGRAM = `
import math
import numpy as np
def step(name, f):
    try:
        print(name, f())
    except BaseException as e:
        print(name, "EXC", type(e).__name__, str(e))
n = 4000000
b = np.arange(float(n))[::-1].copy()
step("sort", lambda: bool(np.sort(b)[0] == 0.0 and np.sort(b)[-1] == n - 1))
step("sin", lambda: bool(np.sin(b)[1] == math.sin(n - 2)))
step("fft", lambda: bool(np.fft.fft(b[:2**21])[0].real == float(b[:2**21].sum())))
step("matmul", lambda: bool((np.ones((1000, 256)) @ np.ones((256, 1000)) == 256.0).all()))
step("argsort", lambda: int(np.argsort(b)[0]))
k = np.linalg._kernels()["solve"]
step("path", lambda: k["path"])
step("why", lambda: k["why"])
step("low", lambda: k["low_memory"])
`;

test("with SAGEBRUSH_LOW_MEMORY=1: past the kernels' maximum, JavaScript; engine/nd not used, no shared memory; argsort refused", () => {
  const { out, err } = run({ SAGEBRUSH_LOW_MEMORY: "1" }, PROGRAM);
  assert.match(out[4], /^argsort EXC MemoryError WebAssembly kernel workspace: needs \d+ bytes, past its memory's maximum of 16777216 bytes; use the native app on a computer with more memory$/);
  assert.deepEqual([...out.slice(0, 4), ...out.slice(5)], [
    "sort True",
    "sin True",
    "fft True",
    "matmul True",
    "path typescript",
    "why the low-memory flag is set (SAGEBRUSH_LOW_MEMORY=1): the TypeScript code, which reserves no shared memory",
    "low True",
  ]);
  assert.match(err, /grows past the maximum: 0 shared memories: 0\n/);
});

test("without the flag (or with another value): the same calls refused, the flag named where it would give a route", () => {
  for (const env of [{}, { SAGEBRUSH_LOW_MEMORY: "yes" }] as Record<string, string>[]) {
    const { out } = run(env, PROGRAM);
    const named = out.slice(0, 5).map((l) => l.split(" ")[0] + (l.includes("EXC MemoryError") ? " REFUSED" : "") + (l.includes("SAGEBRUSH_LOW_MEMORY=1") ? " FLAG" : ""));
    assert.deepEqual(named, ["sort REFUSED FLAG", "sin REFUSED FLAG", "fft REFUSED FLAG", "matmul REFUSED FLAG", "argsort REFUSED"], JSON.stringify(env));
    assert.deepEqual(out.slice(5), ["path engine/nd", "why ", "low False"], JSON.stringify(env));
  }
});

test("the flag is read once per session: a later change takes effect only in a new session", () => {
  const room = join(__dirname, "..", "src", "runtime", "wasm_room.js");
  const r = spawnSync(process.execPath, ["-e", `
const w = require(${JSON.stringify(room)});
const a = w.lowMemory();
process.env.SAGEBRUSH_LOW_MEMORY = "1";
const b = w.lowMemory();
console.log(a, b);`], { encoding: "utf8", env: { ...process.env, SAGEBRUSH_LOW_MEMORY: "" } });
  assert.equal(r.stdout.trim(), "false false");
  const s = spawnSync(process.execPath, ["-e", `
const w = require(${JSON.stringify(room)});
const a = w.lowMemory();
delete process.env.SAGEBRUSH_LOW_MEMORY;
console.log(a, w.lowMemory());`], { encoding: "utf8", env: { ...process.env, SAGEBRUSH_LOW_MEMORY: "1" } });
  assert.equal(s.stdout.trim(), "true true");
});
