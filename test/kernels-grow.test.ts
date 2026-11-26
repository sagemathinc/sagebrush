import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A grow of a WebAssembly kernel's memory, below its fixed maximum, that the computer refuses: a MemoryError for that
// call ("WebAssembly kernel workspace: could not grow by N bytes (more than the computer could give); use the native app
// on a computer with more memory"), never the JavaScript path (LIMITS + ENGINE's ruling on #2147, and William's: no
// automatic fallback; src/runtime/wasm_room.ts). Nothing is kept: the next call grows
// the memory and answers through the same kernel. One main kernel (sort), one relaxed-SIMD kernel (exp) and one
// engine/nd site (matmul). A preload refuses the first grow of the chosen memory, as V8 does when memory runs out, and
// counts its grows.
type Which = "main" | "relaxed" | "nd";
function run(which: Which, program: string): { out: string[]; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "sb-grow-"));
  const pre = join(dir, "pre.js");
  writeFileSync(pre, `const W = WebAssembly, RealInstance = W.Instance, realGrow = W.Memory.prototype.grow;
const which = ${JSON.stringify(which)};
const names = new WeakMap();
W.Instance = function (mod, imports) {
  const inst = new RealInstance(mod, imports);
  const ex = W.Module.exports(mod).map((x) => x.name);
  const memory = inst.exports.memory ?? imports?.env?.memory;
  if (memory) names.set(memory, ex.includes("dgemm") ? "main" : ex.includes("fma_probe") ? "relaxed" : "nd");
  return inst;
};
let refused = 0, grown = 0;
W.Memory.prototype.grow = function (pages) {
  if (names.get(this) === which) {
    if (refused === 0) { refused++; throw new RangeError("WebAssembly.Memory.grow(): Unable to grow instance memory"); }
    grown++;
  }
  return realGrow.call(this, pages);
};
process.on("exit", () => process.stderr.write("refused " + refused + " grown " + grown + "\\n"));`);
  try {
    const r = spawnSync(process.execPath, ["-r", pre, __dirname + "/../src/cli.js", "-c", program], { encoding: "utf8" });
    return { out: r.stdout.trim().split("\n"), err: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const STEP = `
import _nplinalg
import numpy as np
def step(name, f):
    try:
        print(name, f())
    except BaseException as e:
        print(name, "EXC", type(e).__name__, str(e))
`;
// (the same sum through the JavaScript code: the kernels promise its bits)
const EXP = spawnSync(process.execPath, [__dirname + "/../src/cli.js", "-c", "import numpy as np\nprint(float(np.exp(np.arange(2000000.0) / 1e6).sum()))"],
  { encoding: "utf8", env: { ...process.env, SAGEBRUSH_NO_WASM: "1" } }).stdout.trim();
const REFUSED = /^first EXC MemoryError WebAssembly kernel workspace: could not grow by \d+ bytes \(more than the computer could give\); use the native app on a computer with more memory$/;
// (engine/nd's refusal also names the low-memory flag, which avoids engine/nd: wasm_room.ts)
const REFUSED_ND = /^first EXC MemoryError WebAssembly kernel workspace: could not grow by \d+ bytes \(more than the computer could give\); to try reviewed lower-memory routes \(results may differ slightly from upstream\), start a new session with SAGEBRUSH_LOW_MEMORY=1; or use the native app on a computer with more memory$/;

test("a main kernel's grow refused: a MemoryError for that call, then the kernel answers the next", () => {
  const { out, err } = run("main", STEP + `
x = np.arange(2000000.0)[::-1] / 3
step("first", lambda: np.sort(x)[:2].tolist())
step("again", lambda: np.sort(x)[:2].tolist())
step("wasm", _nplinalg.wasm)
`);
  assert.match(out[0], REFUSED, out.join("\n"));
  assert.deepEqual(out.slice(1), ["again [0.0, 0.3333333333333333]", "wasm True"]);
  assert.match(err, /refused 1 grown 1\n/);
});

test("a relaxed-SIMD kernel's grow refused: a MemoryError for that call, then the kernel answers the next", () => {
  const { out, err } = run("relaxed", STEP + `
x = np.arange(2000000.0) / 1e6
step("first", lambda: float(np.exp(x).sum()))
step("again", lambda: float(np.exp(x).sum()))
step("fma", _nplinalg.wasm_fma)
`);
  assert.match(out[0], REFUSED, out.join("\n"));
  assert.deepEqual(out.slice(1), [`again ${EXP}`, "fma True"]);
  assert.match(err, /refused 1 grown 1\n/);
});

test("engine/nd's grow refused: a MemoryError for that product, then engine/nd answers the next", () => {
  const { out, err } = run("nd", STEP + `
a = np.ones((700, 700))
step("first", lambda: float((a @ a)[0, 0]))
step("again", lambda: float((a @ a)[0, 0]))
step("nd", lambda: np.linalg._kernels()["solve"]["path"])
`);
  assert.match(out[0], REFUSED_ND, out.join("\n"));
  assert.deepEqual(out.slice(1), ["again 700.0", "nd engine/nd"]);
  assert.match(err, /refused 1 grown \d+\n/);
});
