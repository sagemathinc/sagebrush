import test from "node:test";
import assert from "node:assert/strict";
import { RELAXED_PROBE, chooseModule } from "../web/threads/kernel-module";

// The threads demo's module choice (web/threads/kernel-module.ts; numerics-core P2a): the relaxed-SIMD probe is a
// valid module exactly where relaxed SIMD is (this Node validates it; a one-byte change to an unknown opcode
// doesn't), and the choice follows the probe, with the page's override honoured only where it can run.

test("the relaxed-SIMD probe validates here, and only because of its relaxed_madd", () => {
  assert.equal(WebAssembly.validate(RELAXED_PROBE), true);
  const broken = RELAXED_PROBE.slice();
  const at = broken.length - 3; // the opcode's LEB128 (0x87 0x02 = 0x107)
  assert.deepEqual(Array.from(broken.slice(at - 1, at + 2)), [0xfd, 0x87, 0x02]);
  broken[at] = 0xff; // 0xfd 0x17f: no such SIMD instruction
  broken[at + 1] = 0x02;
  assert.equal(WebAssembly.validate(broken), false);
});

test("the module choice: relaxed where the probe validates, SIMD128 elsewhere; ?module= overrides only where usable", () => {
  const yes = () => true, no = () => false;
  assert.equal(chooseModule(yes).file, "sagebrush-nd-fma.wasm");
  assert.equal(chooseModule(no).file, "sagebrush-nd.wasm");
  assert.equal(chooseModule(yes, "simd128").file, "sagebrush-nd.wasm");
  assert.equal(chooseModule(no, "fma").file, "sagebrush-nd.wasm");
  assert.match(chooseModule(no, "fma").reason, /ignored/);
  assert.equal(chooseModule(yes, "fma").file, "sagebrush-nd-fma.wasm");
  assert.equal(chooseModule((b) => WebAssembly.validate(b)).file, "sagebrush-nd-fma.wasm");
});
