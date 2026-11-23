import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A WebAssembly kernel with no room in its module's memory (past wasm32's 4 GiB, or more than the computer could
// give: its grow refused) answers "use JavaScript", and NumPy computes in JavaScript instead: never refused for the
// kernel's sake (engine cost policy r2). Made deterministic and small here: a preload refuses any grow past 64 MiB, as
// V8 refuses one past 4 GiB, and 20,000,000 doubles need more than that; so does a 3000 x 3000 product on engine/nd.
test("a kernel with no room in its memory: NumPy computes in JavaScript, including argsort", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-room-"));
  const pre = join(dir, "pre.js");
  writeFileSync(pre, `const real = WebAssembly.Memory.prototype.grow;
WebAssembly.Memory.prototype.grow = function (pages) {
  if (this.buffer.byteLength + pages * 65536 > 64 * 2 ** 20) throw new RangeError("WebAssembly.Memory.grow(): Maximum memory size exceeded");
  return real.call(this, pages);
};`);
  try {
    const out = execFileSync(process.execPath, ["-r", pre, __dirname + "/../src/cli.js", "-c", `
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
`], { encoding: "utf8" }).trim().split("\n");
    for (const l of ["sort True", "sin True", "fft True", "nd engine/nd", "matmul True", "argsort 19999999"]) assert.ok(out.includes(l), l + "\n" + out.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
