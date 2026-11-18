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
