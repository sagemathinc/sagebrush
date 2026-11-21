// Memory on the person's own computer: no cap of ours, as in Sage or Magma (numpy.ts ARRAY_LIMITS, heap.ts). The desktop
// app's engine tells its interpreter its heap (app/engine/thread.mjs sets __SAGEBRUSH_MEMORY__, all of the computer's
// memory by default), and the interpreter's heap guards take it; arrays have no byte cap there or in the CLI (Node
// itself); a browser keeps 4 GiB, as a tab really has.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const heap = require("../src/runtime/heap");
const np = require("../src/runtime/numpy");
const GiB = 2 ** 30;

test("which host is the person's own computer: the engine (its memory given) and Node's CLI; not a browser, Bun or Deno", () => {
  const node = { versions: { node: "24.21.0" }, getBuiltinModule() {} };
  assert.equal(heap.nativeHost({ __SAGEBRUSH_MEMORY__: 8 * GiB }), true, "the desktop app's engine");
  assert.equal(heap.nativeHost({ process: node }), true, "the CLI on Node");
  assert.equal(heap.nativeHost({ process: { versions: {} } }), false, "a browser (the page's process shim)");
  assert.equal(heap.nativeHost({}), false, "a browser without any");
  assert.equal(heap.nativeHost({ process: { ...node, versions: { node: "24", bun: "1.4.4" } } }), false, "Bun");
  assert.equal(heap.nativeHost({ process: { ...node, versions: { node: "24", deno: "2.5" } } }), false, "Deno");
  for (const v of [NaN, -5, 0, Infinity, "24000000000", null]) assert.equal(heap.hostMemory({ __SAGEBRUSH_MEMORY__: v }), null, String(v));
});

test("the arrays' byte cap: none on the person's own computer (this test's Node); the element cap unchanged", () => {
  assert.equal(np.ARRAY_LIMITS.bytes, Number.MAX_SAFE_INTEGER, "this test runs on Node: no cap");
  assert.equal(np.ARRAY_LIMITS.elements, 2 ** 32);
});

test("the engine's memory is its interpreter's heap limit (in a fresh Node: it is read once)", () => {
  const out = execFileSync(process.execPath, ["-e", `globalThis.__SAGEBRUSH_MEMORY__ = ${24 * GiB}; const h = require(${JSON.stringify(require.resolve("../src/runtime/heap"))}); console.log(h.heapLimit());`], { encoding: "utf8" });
  assert.equal(Number(out.trim()), 24 * GiB);
});

test("a JavaScript engine limit hit is a MemoryError naming it; a dict or set past V8's Map size too, not an internal error", () => {
  const { R } = require("../src/compile");
  const F = require("../src/runtime/format");
  for (const [message, says] of [
    ["Invalid array length", /a list, tuple or other array past the JavaScript engine's largest \(about 2\*\*27 = 134,217,728 items in V8/],
    ["Map maximum size exceeded", /a dict or set past the JavaScript engine's largest \(2\*\*24 = 16,777,216 entries in V8/],
    ["Set maximum size exceeded", /a dict or set past/],
    ["Invalid string length", /a string past the JavaScript engine's largest \(2\*\*29 - 24 = 536,870,888 characters in V8/],
    ["Maximum BigInt size exceeded", /an int past the JavaScript engine's largest \(2\*\*30 bits in V8/],
    ["BigInt generated from this operation is too big", /an int past the JavaScript engine's largest \(2\*\*20 bits in JavaScriptCore/],
    ["Array buffer allocation failed", /the computer couldn't give the memory an array buffer needed/],
    ["WebAssembly.Memory.grow(): Maximum memory size exceeded", /a WebAssembly module's memory past its limit of 4 GiB \(wasm32\)/],
    ["WebAssembly.Memory.grow(): Unable to grow instance memory", /a WebAssembly module's memory: more than the computer could give/],
  ] as [string, RegExp][]) {
    const exc = R.toPyExc(new RangeError(message));
    assert.ok(R.typeOf(exc) === R.T.MemoryError, `${message}: ${R.typeOf(exc).$name}`);
    assert.match(F.str(exc), says, message);
  }
  // (a RangeError that isn't an allocation stays an internal error)
  assert.ok(R.typeOf(R.toPyExc(new RangeError("toFixed() digits argument must be between 0 and 100"))) === R.T.SystemError);
});

test("a real dict past 2**24 entries: a named MemoryError (V8's Map limit)", () => {
  // (the CLI, a fresh process: 2**24 + 1 int keys, about 1 GiB of heap at most, refused at the limit with its name)
  const out = execFileSync(process.execPath, ["--max-old-space-size=8192", require.resolve("../src/cli.js"), "-c", "d = {}\ntry:\n    for i in range(2**24 + 1):\n        d[i] = None\n    print('made', len(d))\nexcept MemoryError as e:\n    print(len(d), e)"], { encoding: "utf8", timeout: 600000 });
  assert.match(out.trim(), /^16777216 a dict or set past the JavaScript engine's largest \(2\*\*24 = 16,777,216 entries in V8: Chrome, Edge, the app, the CLI on Node\)$/);
});
