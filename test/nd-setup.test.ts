import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// engine/nd's setup (src/runtime/nd.ts decide, #2157): which code runs is decided by the engine's features alone
// (shared WebAssembly memory, cross-origin isolation, SAGEBRUSH_NO_WASM), and only that answer is kept for the
// session. Memory the computer can't give while making the module's shared memory or instance is no answer about the
// engine: that call is refused with a MemoryError, nothing is decided, and the next call sets engine/nd up and uses it.
// The shared memory's maximum is the largest of 4 GiB, 1 GiB and 256 MiB that can be reserved: it only moves where a
// call is refused, and np.linalg._kernels() says which ("memory_max"). A preload makes the shared memory or engine/nd's
// instance fail, and counts the attempts, on stderr.
type How =
  | "memory-oom-once" // every maximum refused for memory, once
  | "memory-4g-refused" // only 4 GiB refused for memory (address space): 1 GiB is taken
  | "instance-oom-once" // the instance refused for memory, once
  | "instance-exec-oom-once" // the instance refused for executable memory in an engine's own words (a CompileError), once
  | "no-shared" // the engine makes no shared memory (a TypeError): a feature it lacks
  | "not-isolated" // a page that isn't cross-origin isolated
  | "instance-link-error"; // a valid module the engine won't link: taken as the feature's absence
function run(how: How): { out: string[]; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "sb-ndset-"));
  const pre = join(dir, "pre.js");
  writeFileSync(pre, `const W = WebAssembly, RealMemory = W.Memory, RealInstance = W.Instance, how = ${JSON.stringify(how)};
let memories = 0, instances = 0, refused = 0, memOomDone = false, instOomDone = false;
if (how === "not-isolated") globalThis.crossOriginIsolated = false;
W.Memory = function (desc) {
  if (desc && desc.shared) {
    memories++;
    if (how === "memory-oom-once" && !memOomDone) {
      if (desc.maximum === 4096) memOomDone = true;
      refused++;
      throw new RangeError("WebAssembly.Memory(): could not allocate memory");
    }
    if (how === "memory-4g-refused" && desc.maximum === 65536) { refused++; throw new RangeError("WebAssembly.Memory(): could not allocate memory"); }
    if (how === "no-shared") throw new TypeError("WebAssembly.Memory(): shared memory is not supported");
  }
  return new RealMemory(desc);
};
W.Memory.prototype = RealMemory.prototype;
W.Instance = function (mod, imports) {
  const m = imports && imports.env && imports.env.memory;
  if (m && m.buffer instanceof SharedArrayBuffer) {
    instances++;
    if (how === "instance-oom-once" && !instOomDone) { instOomDone = true; refused++; throw new RangeError("WebAssembly.Instance(): Out of memory: Cannot allocate Wasm memory for new instance"); }
    if (how === "instance-exec-oom-once" && !instOomDone) { instOomDone = true; refused++; throw new W.CompileError("WebAssembly.Instance(): out of executable memory"); }
    if (how === "instance-link-error") { refused++; throw new W.LinkError("WebAssembly.Instance(): Import #0 \\"env\\" \\"memory\\": not supported here"); }
  }
  return new RealInstance(mod, imports);
};
W.Instance.prototype = RealInstance.prototype;
process.on("exit", () => process.stderr.write("memories " + memories + " instances " + instances + " refused " + refused + "\\n"));`);
  try {
    const r = spawnSync(process.execPath, ["-r", pre, __dirname + "/../src/cli.js", "-c", PROGRAM], { encoding: "utf8" });
    return { out: r.stdout.trim().split("\n"), err: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// (a 60 x 60 Cholesky: engine/nd's from n = 48)
const PROGRAM = `
import numpy as np
def step(name, f):
    try:
        print(name, f())
    except BaseException as e:
        print(name, "EXC", type(e).__name__, str(e))
M = np.random.default_rng(4).standard_normal((60, 60))
A = M @ M.T + 60 * np.eye(60)
step("first", lambda: repr(float(np.linalg.cholesky(A)[59, 59])))
step("again", lambda: repr(float(np.linalg.cholesky(A)[59, 59])))
k = np.linalg._kernels()["cholesky"]
step("path", lambda: k["path"])
step("why", lambda: k["why"])
step("max", lambda: k["memory_max"])
`;

// the factor's last entry on engine/nd, from an ordinary session
const ND = spawnSync(process.execPath, [__dirname + "/../src/cli.js", "-c", PROGRAM], { encoding: "utf8" }).stdout.trim().split("\n");

const REFUSED = (what: string) =>
  `first EXC MemoryError WebAssembly kernel workspace: ${what} could not be set up (more than the computer could give); use the native app on a computer with more memory`;

test("(the ordinary session: engine/nd, 4 GiB)", () => {
  assert.equal(ND[2], "path engine/nd");
  assert.equal(ND[4], `max ${2 ** 32}`);
});

test("engine/nd's shared memory refused for memory: a MemoryError for that call, then engine/nd answers the next", () => {
  const { out, err } = run("memory-oom-once");
  assert.deepEqual(out, [REFUSED("engine/nd's shared memory"), ND[1], "path engine/nd", "why ", `max ${2 ** 32}`]);
  // (three maxima tried and refused, then 4 GiB made on the next call)
  assert.match(err, /memories 4 instances 1 refused 3\n/);
});

test("only 4 GiB of address space refused: engine/nd with a 1 GiB maximum, the same bits, and _kernels() says so", () => {
  const { out } = run("memory-4g-refused");
  assert.deepEqual(out, [ND[0], ND[1], "path engine/nd", "why ", `max ${2 ** 30}`]);
});

test("engine/nd's instance refused for memory: a MemoryError for that call, then engine/nd answers the next", () => {
  const { out, err } = run("instance-oom-once");
  assert.deepEqual(out, [REFUSED("engine/nd"), ND[1], "path engine/nd", "why ", `max ${2 ** 32}`]);
  assert.match(err, /instances 2 refused 1\n/);
});

test("engine/nd's instance refused for executable memory (a CompileError, not a RangeError): a MemoryError, then engine/nd", () => {
  const { out, err } = run("instance-exec-oom-once");
  assert.deepEqual(out, [REFUSED("engine/nd"), ND[1], "path engine/nd", "why ", `max ${2 ** 32}`]);
  assert.match(err, /instances 2 refused 1\n/);
});

// (the TypeScript loop's last bits can differ from engine/nd's: only its being a number is checked here)
test("an engine without shared memory, or a page not cross-origin isolated: the TypeScript loop, decided once", () => {
  for (const how of ["no-shared", "not-isolated"] as const) {
    const { out, err } = run(how);
    assert.match(out[0], /^first \d+\.\d+$/, how);
    assert.deepEqual(out.slice(2), ["path typescript", "why no shared WebAssembly memory here (the page is not cross-origin isolated)", "max 0"], how);
    // (no-shared: one try, never again; not isolated: no shared memory made at all)
    assert.match(err, how === "no-shared" ? /memories 1 instances 0 / : /memories 0 instances 0 /, how);
  }
});

test("a valid module the engine won't link (no memory words): the TypeScript loop, tried once, decided", () => {
  const { out, err } = run("instance-link-error");
  assert.match(out[0], /^first \d+\.\d+$/);
  assert.equal(out[2], "path typescript");
  assert.match(out[3], /^why the numerics module could not be loaded \(WebAssembly\.Instance\(\): Import #0/);
  assert.match(err, /memories 1 instances 1 refused 1\n/);
});
