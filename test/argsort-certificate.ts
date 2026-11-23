import assert from "node:assert/strict";

export function realOrder(a: number, b: number): number {
  if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : 1;
  if (Number.isNaN(b)) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Independent certificate: permutation, sorted values, original tie order. */
export function certify(values: Float64Array, indices: ArrayLike<number>): void {
  assert.equal(indices.length, values.length);
  const seen = new Uint8Array(values.length);
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    assert.ok(Number.isInteger(i) && i >= 0 && i < values.length, "index range");
    assert.equal(seen[i], 0, "index is unique");
    seen[i] = 1;
    if (k) {
      const prev = indices[k - 1], order = realOrder(values[prev], values[i]);
      assert.ok(order <= 0, "values are sorted");
      if (order === 0) assert.ok(prev < i, "equal values preserve original order");
    }
  }
}

export function corpus(): { name: string; values: Float64Array }[] {
  const cases: { name: string; values: Float64Array }[] = [];
  let seed = 0x5a17;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (const n of [32, 128, 512, 2048, 8192]) {
    for (const family of ["ascending", "descending", "equal", "ties", "specials"]) {
      const values = Float64Array.from({ length: n }, (_, i) => family === "ascending" ? i : family === "descending" ? n - i : family === "equal" ? 7 : Math.floor(random() * 97) - 48);
      if (family === "specials") for (let i = 0; i < n; i += 7) values[i] = [NaN, -Infinity, Infinity, -0, +0][(i / 7) % 5];
      cases.push({ name: `${family}/${n}`, values });
    }
  }
  return cases;
}
