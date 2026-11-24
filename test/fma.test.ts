import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fma, fmaExact, fmaf } from "../src/runtime/fma";

// fma and fmaf against correctly rounded references (test/fma_cases.py): every case the same double or float32,
// NaN for NaN, and the sign of a zero.
const parseHex = (s: string): number => {
  if (s === "inf") return Infinity;
  if (s === "-inf") return -Infinity;
  if (s === "nan") return NaN;
  const m = /^(-?)0x([01])\.([0-9a-f]*)p([+-]\d+)$/.exec(s);
  if (!m) throw new Error("bad hex " + s);
  const bits = m[3].length * 4;
  const mant = (BigInt(m[2]) << BigInt(bits)) + (m[3] ? BigInt("0x" + m[3]) : 0n);
  const e = Number(m[4]) - bits;
  // (scaled in two steps so subnormal values come out exactly)
  const v = e < -1000 ? Number(mant) * 2 ** (e + 600) * 2 ** -600 : Number(mant) * 2 ** e;
  return m[1] ? -v : v;
};
const same = (a: number, b: number) => Object.is(a, b) || (a !== a && b !== b);

test("fma and fmaf: correctly rounded, as C's (100,000 cases from math.fma and exact rationals)", { timeout: 120_000 }, () => {
  const lines = execFileSync("python3", [__dirname + "/../../test/fma_cases.py", "100000", "7"], { encoding: "utf8", maxBuffer: 1 << 26 }).trim().split("\n");
  const bad: string[] = [];
  let n = 0;
  for (const line of lines) {
    const [kind, xs, ys, zs, es] = line.split(" ");
    const [x, y, z, want] = [xs, ys, zs, es].map(parseHex);
    const got = kind === "f" ? [fmaf(x, y, z)] : [fma(x, y, z), fmaExact(x, y, z)];
    for (const g of got) {
      n++;
      if (!same(g, want) && bad.length < 5) bad.push(`${line} -> ${g}`);
    }
  }
  assert.ok(lines.length > 100000, `${lines.length} cases`);
  assert.deepEqual(bad, [], `${n} checks`);
});
