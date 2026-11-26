import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The WebAssembly kernels' setup (src/runtime/kernels.ts): which kernel runs is decided by the engine's features
// alone (WebAssembly.validate of the module, and for the relaxed-SIMD module its multiply-add probe), and only that
// answer is kept for the session. Memory the computer can't give while setting a module up is no answer about the
// engine: the call is refused with a MemoryError, nothing is kept, and the next call sets the module up and uses it.
// A preload makes one module (the main one, which exports dgemm, or the relaxed one, which doesn't) fail as
// V8 fails when memory runs out, or fail validation, or answer its probe as a twice-rounding multiply-add would; it
// counts the instantiations, on stderr.
type How = "oom-once" | "other-once" | "invalid" | "probe0";
function preload(dir: string, which: "main" | "relaxed", how: How): string {
  const pre = join(dir, "pre.js");
  writeFileSync(pre, `const W = WebAssembly, RealModule = W.Module, RealInstance = W.Instance, realValidate = W.validate;
const which = ${JSON.stringify(which)}, how = ${JSON.stringify(how)};
// (the main module exports dgemm; the relaxed one exports fma_probe and no dgemm)
const ours = (mod) => {
  const names = RealModule.exports(mod).map((x) => x.name);
  return which === "main" ? names.includes("dgemm") : names.includes("fma_probe") && !names.includes("dgemm");
};
let made = 0, failed = 0;
W.validate = function (bytes) {
  if (how === "invalid" && ours(new RealModule(bytes))) return false;
  return realValidate.call(this, bytes);
};
W.Instance = function (mod, imports) {
  if (ours(mod)) {
    if (how === "oom-once" && failed === 0) { failed++; throw new RangeError("WebAssembly.Instance(): Out of memory: Cannot allocate Wasm memory for new instance"); }
    // (a resource failure in other words, as another engine or V8's code space might say it)
    if (how === "other-once" && failed === 0) { failed++; throw new RangeError("Wasm code space exhausted"); }
    made++;
    const inst = new RealInstance(mod, imports);
    if (how === "probe0") return { exports: Object.assign({}, inst.exports, { fma_probe: () => 0 }) };
    return inst;
  }
  return new RealInstance(mod, imports);
};
process.on("exit", () => process.stderr.write("instances " + made + " failed " + failed + "\\n"));`);
  return pre;
}

const PROGRAM = `
import _nplinalg
import numpy as np
def step(name, f):
    try:
        print(name, f())
    except BaseException as e:
        print(name, "EXC", type(e).__name__, str(e))
x = np.arange(200.0)[::-1] / 7
step("sort", lambda: np.sort(x)[:3].tolist())
step("exp", lambda: float(np.exp(x).sum()))
step("sort again", lambda: np.sort(x)[:3].tolist())
step("exp again", lambda: float(np.exp(x).sum()))
step("wasm", _nplinalg.wasm)
step("wasm_fma", _nplinalg.wasm_fma)
`;

function run(which: "main" | "relaxed", how: How): { out: string[]; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "sb-kset-"));
  try {
    const r = require("node:child_process").spawnSync(process.execPath, ["-r", preload(dir, which, how), __dirname + "/../src/cli.js", "-c", PROGRAM],
      { encoding: "utf8" });
    return { out: r.stdout.trim().split("\n"), err: r.stderr.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// (every path gives the same numbers: the kernels promise the JavaScript code's bits)
const SORTED = "[0.0, 0.14285714285714285, 0.2857142857142857]";
const EXP = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", "import numpy as np\nprint(float(np.exp(np.arange(200.0)[::-1] / 7).sum()))"],
  { encoding: "utf8", env: { ...process.env, SAGEBRUSH_NO_WASM: "1" } }).trim();

test("the main kernels' setup out of memory: a MemoryError, nothing kept, and the next call uses the kernels", () => {
  for (const how of ["oom-once", "other-once"] as const) {
    const { out, err } = run("main", how);
    assert.deepEqual(out, [
      "sort EXC MemoryError a WebAssembly module: more than the computer could give",
      `exp ${EXP}`,
      `sort again ${SORTED}`,
      `exp again ${EXP}`,
      "wasm True",
      "wasm_fma True",
    ], how);
    assert.match(err, /instances 1 failed 1/, how);
  }
});

test("the relaxed kernels' setup out of memory: a MemoryError, nothing kept, and the next call uses them", () => {
  const { out, err } = run("relaxed", "oom-once");
  assert.deepEqual(out, [
    `sort ${SORTED}`,
    "exp EXC MemoryError a WebAssembly module: more than the computer could give",
    `sort again ${SORTED}`,
    `exp again ${EXP}`,
    "wasm True",
    "wasm_fma True",
  ]);
  assert.match(err, /instances 1 failed 1/);
});

test("an engine without the main kernels' SIMD: the JavaScript code, for the session, the same numbers", () => {
  const { out, err } = run("main", "invalid");
  assert.deepEqual(out, [`sort ${SORTED}`, `exp ${EXP}`, `sort again ${SORTED}`, `exp again ${EXP}`, "wasm False", "wasm_fma False"]);
  assert.match(err, /instances 0 failed 0/);
});

test("an engine without relaxed SIMD, or whose multiply-add rounds twice: the main kernels, for the session", () => {
  for (const how of ["invalid", "probe0"] as const) {
    const { out, err } = run("relaxed", how);
    assert.deepEqual(out, [`sort ${SORTED}`, `exp ${EXP}`, `sort again ${SORTED}`, `exp again ${EXP}`, "wasm True", "wasm_fma False"], how);
    // (the probe's module is made once and not again: its answer is kept)
    assert.match(err, how === "invalid" ? /instances 0 failed 0/ : /instances 1 failed 0/, how);
  }
});
