import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Factorization's lattice route (van Hoeij with the L^2 reducer) through the
// real WebAssembly engine (sb_alloc, sb_call, sb_free): the polynomials
// whose recombination lattice L^2 reduces must factor there too, not only
// natively. The engine traps (a Rust panic is `unreachable` in wasm32) on
// any std API the platform lacks, such as a clock, which native tests can't
// see.

function instance() {
  const bytes = readFileSync(join(__dirname, "..", "..", "wasm", "sagebrush-engine.wasm"));
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), { sagebrush: { interrupted: () => 0 } }).exports as any;
}

function call(e: any, request: string): any {
  const req = new TextEncoder().encode(request);
  const p = e.sb_alloc(req.length);
  new Uint8Array(e.memory.buffer, p, req.length).set(req);
  const r = e.sb_call(p, req.length);
  const out = new TextDecoder().decode(new Uint8Array(e.memory.buffer, r, e.sb_reply_len()));
  e.sb_free(p, req.length);
  return JSON.parse(out);
}

// The Swinnerton-Dyer polynomial of the first k primes: the minimal
// polynomial of sqrt(2) + sqrt(3) + ... (degree 2^k, irreducible), whose
// factors mod every prime have degree at most 2, so van Hoeij needs its
// lattice; coefficients from constant term up.
function swinnertonDyer(primes: bigint[]): bigint[] {
  const binom = (n: number, k: number): bigint => {
    let r = 1n;
    for (let i = 0; i < k; i++) r = (r * BigInt(n - i)) / BigInt(i + 1);
    return r;
  };
  const mul = (a: bigint[], b: bigint[]) => {
    const r = new Array<bigint>(a.length + b.length - 1).fill(0n);
    a.forEach((x, i) => b.forEach((y, j) => (r[i + j] += x * y)));
    return r;
  };
  let f = [0n, 1n];
  for (const p of primes) {
    // f(x + s) = A(x) + s B(x) with s = sqrt(p); f(x - s) f(x + s) = A^2 - p B^2
    const A = new Array<bigint>(f.length).fill(0n);
    const B = new Array<bigint>(f.length).fill(0n);
    f.forEach((c, k) => {
      for (let j = 0; j <= k; j++) {
        const t = c * binom(k, j) * p ** BigInt(j >> 1);
        if (j % 2 === 0) A[k - j] += t;
        else B[k - j] += t;
      }
    });
    const AA = mul(A, A);
    const BB = mul(B, B);
    f = AA.map((x, i) => x - p * (BB[i] ?? 0n));
    while (f.length > 1 && f[f.length - 1] === 0n) f.pop();
  }
  return f;
}

test("factorization's lattice route runs in the WebAssembly engine (S_5, S_6, and a product)", () => {
  const e = instance();
  const s4 = swinnertonDyer([2n, 3n, 5n, 7n]);
  const s5 = swinnertonDyer([2n, 3n, 5n, 7n, 11n]);
  const s6 = swinnertonDyer([2n, 3n, 5n, 7n, 11n, 13n]);
  for (const f of [s5, s6]) {
    const r = call(e, JSON.stringify({ fn: "factor", f: f.map(String) }));
    assert.ok(r.ok, JSON.stringify(r).slice(0, 300));
    assert.equal(r.ok.factors.length, 1, `degree ${f.length - 1}: irreducible`);
    assert.deepEqual(r.ok.factors[0][0], f.map(String));
  }
  // a product of two of them: the lattice must separate the factors
  const prod = new Array<bigint>(s4.length + s5.length - 1).fill(0n);
  s4.forEach((x, i) => s5.forEach((y, j) => (prod[i + j] += x * y)));
  const r = call(e, JSON.stringify({ fn: "factor", f: prod.map(String) }));
  assert.ok(r.ok, JSON.stringify(r).slice(0, 300));
  const got = r.ok.factors.map((x: [string[], number]) => x[0].join(",")).sort();
  assert.deepEqual(got, [s4.map(String).join(","), s5.map(String).join(",")].sort());
});

// Whether the rows are (0.51, 0.99)-reduced, exactly: the integral
// Gram-Schmidt data (d_i, the Gram determinants, and lambda_ij = mu_ij d_j)
// give |mu_ij| <= 51/100 as 100 |lambda_ij| <= 51 d_j, and Lovasz as
// 99 d_k^2 <= 100 (d_{k+1} d_{k-1} + lambda_{k,k-1}^2); also d_n, the lattice's
// squared volume.
function reducedExactly(b: bigint[][]): { ok: boolean; volume2: bigint } {
  const n = b.length;
  const dot = (x: bigint[], y: bigint[]) => x.reduce((s, v, i) => s + v * y[i], 0n);
  const d: bigint[] = new Array(n + 1).fill(0n);
  d[0] = 1n;
  const lam: bigint[][] = b.map(() => new Array<bigint>(n).fill(0n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let u = dot(b[i], b[j]);
      for (let l = 0; l < j; l++) u = (d[l + 1] * u - lam[i][l] * lam[j][l]) / d[l];
      if (j < i) lam[i][j] = u;
      else d[i + 1] = u;
    }
  }
  const abs = (x: bigint) => (x < 0n ? -x : x);
  let ok = true;
  for (let i = 1; i < n; i++) for (let j = 0; j < i; j++) if (100n * abs(lam[i][j]) > 51n * d[j + 1]) ok = false;
  for (let k = 1; k < n; k++) if (99n * d[k] * d[k] > 100n * (d[k + 1] * d[k - 1] + lam[k][k - 1] * lam[k][k - 1])) ok = false;
  return { ok, volume2: d[n] };
}

test("matrix.LLL()'s engine call (lll) runs in the WebAssembly engine and reduces exactly", () => {
  const e = instance();
  let seed = 20261118n;
  // a random value of exactly `bits` bits, from 32-bit draws of an LCG
  const next = (bits: bigint) => {
    let v = 0n;
    for (let k = 0n; k < bits; k += 32n) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
      v = (v << 32n) | (seed >> 32n);
    }
    return (v % (1n << (bits - 1n))) + (1n << (bits - 1n));
  };
  // knapsack-like rows (identity | a big column) of the sizes L^2 is routed at
  for (const [d, bits] of [
    [8, 60n],
    [24, 200n],
  ] as [number, bigint][]) {
    const rows: bigint[][] = [];
    for (let i = 0; i < d; i++) {
      const r = new Array<bigint>(d + 1).fill(0n);
      r[i] = 1n;
      r[d] = next(bits);
      rows.push(r);
    }
    const r = call(e, JSON.stringify({ fn: "lll", m: rows.map((x) => x.join(",")).join(";") }));
    assert.ok(r.ok, JSON.stringify(r).slice(0, 300));
    const out: bigint[][] = r.ok.map((x: string[]) => x.map((v) => BigInt(v)));
    assert.equal(out.length, d);
    const got = reducedExactly(out);
    assert.ok(got.ok, `d ${d}: not (0.51, 0.99)-reduced`);
    assert.equal(got.volume2, reducedExactly(rows).volume2, `d ${d}: a lattice of another volume`);
    // every output row lies in the input's lattice: a row of (identity | a)
    // combinations is (c | sum c_i a_i); with the same volume, the same lattice
    for (const v of out) {
      assert.equal(v.length, d + 1, `d ${d}: a row of another length`);
      let s = 0n;
      for (let i = 0; i < d; i++) s += v[i] * rows[i][d];
      assert.equal(v[d], s, `d ${d}: a row outside the input's lattice`);
    }
    // (the entries are of the stated size)
    assert.equal(rows.reduce((m, r) => (r[d] > m ? r[d] : m), 0n).toString(2).length, Number(bits), `d ${d}: entries of ${bits} bits`);
  }
});
