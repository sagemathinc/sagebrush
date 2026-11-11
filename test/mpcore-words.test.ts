import test from "node:test";
import assert from "node:assert/strict";

// The binding's int <-> limb conversions (src/runtime/mpcore.ts wordsOf and manOf) against a reference by shifts:
// every size from 1 bit to past the mid-size path's end (2^65536), each side of its two edges (2^4096, by shifts;
// 2^65536, by the text with its count from the bits) and manOf's (1024 bits), mantissas of all ones, a single top bit, and random words.
const DIST = __dirname + "/..";

test("wordsOf and manOf: the words of |x| (32 bits each, low first, an even count), and back, at every size", () => {
  const M = require(DIST + "/src/runtime/mpcore.js");
  const ref = (x: bigint) => {
    const w: number[] = [];
    for (; x > 0n; x >>= 32n) w.push(Number(x & 0xffffffffn));
    if (w.length & 1) w.push(0);
    return w;
  };
  let seed = 0x9e3779b97f4a7c15n;
  const rnd = (bits: number) => {
    let x = 0n;
    for (let i = 0; i < bits; i += 64) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      x = (x << 64n) | seed;
    }
    return BigInt.asUintN(bits, x) | (1n << BigInt(bits - 1));
  };
  const sizes = [1, 2, 31, 32, 33, 63, 64, 65, 96, 128, 1000, 1023, 1024, 1025, 1088, 3322, 4095, 4096, 4097, 10000, 65535, 65536, 65537, 70000];
  for (const bits of sizes) {
    for (const x of [rnd(bits), (1n << BigInt(bits)) - 1n, 1n << BigInt(bits - 1)]) {
      const w = M.wordsOf(x);
      assert.deepEqual(w, ref(x), `wordsOf at ${bits} bits`);
      assert.equal(M.manOf(w), x, `manOf at ${bits} bits`);
    }
  }
  assert.deepEqual(M.wordsOf(0n), []);
});
