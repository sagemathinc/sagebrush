import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A call whose WebAssembly workspace is past its memory's FIXED maximum (wasm32's 4 GiB, or the module's declared
// maximum) is refused with a MemoryError, decided from the input before any grow: no JavaScript route without an
// explicit request (src/runtime/wasm_room.ts; William's ruling on #2147, Nov 25 2026). Made deterministic and small
// here: a preload stubs that maximum at 64 MiB (globalThis.__SAGEBRUSH_KERNEL_MAX_BYTES__), and 20,000,000 doubles need
// more than that; so does a 3000 x 3000 product on engine/nd. The preload counts the grows asked for past 64 MiB: none,
// the size test comes first. A smaller call after them still runs on the kernels.
test("a kernel's workspace past its memory's fixed maximum: a MemoryError, no grow tried, no JavaScript route", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-room-"));
  const pre = join(dir, "pre.js");
  writeFileSync(pre, `globalThis.__SAGEBRUSH_KERNEL_MAX_BYTES__ = 64 * 2 ** 20;
const real = WebAssembly.Memory.prototype.grow;
let past = 0;
WebAssembly.Memory.prototype.grow = function (pages) {
  if (this.buffer.byteLength + pages * 65536 > 64 * 2 ** 20) past++;
  return real.call(this, pages);
};
process.on("exit", () => process.stderr.write("grows past the maximum: " + past + "\\n"));`);
  try {
    const r = require("node:child_process").spawnSync(process.execPath, ["-r", pre, __dirname + "/../src/cli.js", "-c", `
import math
import numpy as np
def step(name, f):
    try:
        print(name, f())
    except BaseException as e:
        print(name, "EXC", type(e).__name__, str(e))
n = 20000000
b = np.arange(float(n))[::-1].copy()
step("sort", lambda: bool(np.sort(b)[0] == 0.0 and np.sort(b)[-1] == n - 1))
step("sin", lambda: bool(np.sin(b)[1] == math.sin(n - 2)))
step("fft", lambda: bool(np.fft.fft(b[:2**23])[0].real == float(b[:2**23].sum())))
step("matmul", lambda: bool((np.ones((3000, 256)) @ np.ones((256, 3000)) == 256.0).all()))
step("nd", lambda: np.linalg._kernels()["solve"]["path"])
step("argsort", lambda: int(np.argsort(b)[0]))
step("small sort", lambda: np.sort(b[:1000])[:2].tolist())
step("small matmul", lambda: float((np.ones((700, 700)) @ np.ones((700, 700)))[0, 0]))
`], { encoding: "utf8" });
    const out = r.stdout.trim().split("\n");
    // (the low-memory flag would give sort, sin, fft and engine/nd's matmul a route, so their refusals name it;
    // argsort has none)
    const past = /^(\w+) EXC MemoryError WebAssembly kernel workspace: needs \d+ bytes, past its memory's maximum of 67108864 bytes; (?:to try reviewed lower-memory routes \(results may differ slightly from upstream\), start a new session with SAGEBRUSH_LOW_MEMORY=1; or )?use the native app on a computer with more memory$/;
    const flag = (l: string) => (l.includes("SAGEBRUSH_LOW_MEMORY=1") ? " FLAG" : "");
    assert.deepEqual(out.map((l) => l.replace(past, "$1 REFUSED") + (past.test(l) ? flag(l) : "")), ["sort REFUSED FLAG", "sin REFUSED FLAG", "fft REFUSED FLAG", "matmul REFUSED FLAG", "nd engine/nd", "argsort REFUSED",
      "small sort [19999000.0, 19999001.0]", "small matmul 700.0"], out.join("\n") + r.stderr);
    assert.match(r.stderr, /grows past the maximum: 0\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
