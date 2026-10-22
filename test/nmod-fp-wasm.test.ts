import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// engine/web's GF(p) ops (nmod_echelon, nmod_poly_mul, nmod_poly_divrem,
// nmod_poly_gcd: engine/web/src/nmod_ops.rs) through the real WebAssembly
// ABI (sb_alloc, sb_call, sb_free):
// - each op's largest admitted request, right after a reply from another
//   op longer than any nmod reply (> 20 * 400 * 401 bytes), grows the
//   instance's memory by less than the op's closed-form peak (8, 12, 14,
//   2 MiB) with a quarter of allocator headroom: the previous reply is
//   freed at entry;
// - the shared transform cache, filled by other ops to its 64-table policy
//   and to its 2^28-byte policy, is neither used nor changed by them, and
//   100 NTT primes in a row do not grow memory;
// - Stop: the host's interrupt flag is asked at least once per 2^16
//   multiply-adds, and a Stop at the middle of a run traps;
// - the caps, at the cap and one past it.
const MIB = 1 << 20;
const P = 9223372036854775783n; // the largest prime below 2^63 (three CRT primes)
const NTT_P = 4601552919265804289n; // an NTT prime: its own table

function instance(interrupted: () => number = () => 0) {
  const bytes = readFileSync(join(__dirname, "..", "..", "wasm", "sagebrush-engine.wasm"));
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), { sagebrush: { interrupted } }).exports as any;
}

function call(e: any, request: string): string {
  const req = new TextEncoder().encode(request);
  const p = e.sb_alloc(req.length);
  new Uint8Array(e.memory.buffer, p, req.length).set(req);
  const r = e.sb_call(p, req.length);
  const out = new TextDecoder().decode(new Uint8Array(e.memory.buffer, r, e.sb_reply_len()));
  e.sb_free(p, req.length);
  return out;
}

let seed = 12345n;
function rand(p: bigint): bigint {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
  return (seed >> 1n) % p;
}

function poly(n: number, p: bigint): string {
  const c: string[] = [];
  for (let i = 0; i < n; i++) c.push(String(rand(p)));
  if (c[n - 1] === "0") c[n - 1] = "1";
  return c.join(",");
}

function matrix(rows: number, cols: number, p: bigint): string {
  const r: string[] = [];
  for (let i = 0; i < rows; i++) {
    const row: string[] = [];
    for (let j = 0; j < cols; j++) row.push(String(p - 1n - rand(1000n)));
    r.push(row.join(","));
  }
  return r.join(";");
}

const preq = (f: string, p: bigint, a: string, b: string) => `{"fn":"nmod_poly_${f}","p":"${p}","a":"${a}","b":"${b}"}`;

// the worst admitted request of each op (and each division path)
function worst(): [string, number, string][] {
  return [
    ["echelon 400x401", 8 * MIB, `{"fn":"nmod_echelon","p":"${P}","rows":400,"cols":401,"m":"${matrix(400, 401, P)}","reduced":true,"want_rows":true}`],
    ["mul 2^15, three primes", 12 * MIB, preq("mul", P, poly(1 << 15, P), poly(1 << 15, P))],
    ["mul 2^15, NTT prime", 12 * MIB, preq("mul", NTT_P, poly(1 << 15, NTT_P), poly(1 << 15, NTT_P))],
    ["divrem Newton", 14 * MIB, preq("divrem", P, poly(1 << 15, P), poly((1 << 14) + 1, P))],
    ["divrem Newton, lb = 60", 14 * MIB, preq("divrem", P, poly(1 << 15, P), poly(60, P))],
    ["divrem classical", 14 * MIB, preq("divrem", P, poly(1 << 15, P), poly(59, P))],
    ["gcd 2^14", 2 * MIB, preq("gcd", P, poly(1 << 14, P), poly(1 << 14, P))],
  ];
}

function stats(e: any): number[] {
  return JSON.parse(call(e, '{"fn":"ntt_cache_stats"}')).ok;
}

const digits = (k: number) => Array.from({ length: k }, () => String(rand(10n ** 19n)).padStart(19, "0")).join("");

// Both fills are integer polynomial products (another op) whose replies
// are longer than any nmod reply can be (20 bytes for each of the 400 * 401
// echelon entries, about 3.2 MB), so each leaves the shared cache at a
// policy limit AND a maximal prior reply in the reply buffer.
const LONGEST_NMOD_REPLY = 20 * 400 * 401;

// the table-count policy (64 tables): 1400 x 1400 coefficients of 608
// digits, whose multimodular path needs 67 primes; a reply of about 3.4 MB
const COUNT_FILL = (() => {
  const a = Array.from({ length: 1400 }, () => digits(32)).join(",");
  return `{"fn":"poly_mul","a":"${a}","b":"${a}","wire":"csv"}`;
})();
function fillCount(e: any) {
  const n = call(e, COUNT_FILL).length;
  assert.ok(n > LONGEST_NMOD_REPLY, `the prior reply has ${n} bytes`);
  assert.equal(stats(e)[1], 64, "the shared cache at its 64-table policy");
}

// the byte policy (2^28 bytes): a product of length 2^20 (32 MiB tables)
// needing 9 primes leaves 8 tables; a reply of about 180 MB
const BYTE_FILL = (() => {
  const a = Array.from({ length: 1 << 19 }, () => digits(4) + "7").join(",");
  return `{"fn":"poly_mul","a":"${a}","b":"${a}","wire":"csv"}`;
})();
function fillBytes(e: any) {
  const n = call(e, BYTE_FILL).length;
  assert.ok(n > LONGEST_NMOD_REPLY, `the prior reply has ${n} bytes`);
  assert.deepEqual(stats(e).slice(1), [8, 1 << 28], "the shared cache at its 2^28-byte policy");
}

test("the nmod ops' largest requests stay within their peaks in wasm, after a large reply and a filled cache", (t) => {
  const e0 = instance();
  if (call(e0, preq("gcd", 7n, "1,1", "1")).includes("unknown fn")) return t.skip("this engine build predates the nmod ops");
  const grew: Record<string, number> = {};
  const replies: Record<string, string> = {};
  const cases = worst();
  // (page growth is the evidence only on an instance that has not grown
  // for something else first: here after a small seed reply; the exact
  // live-byte peaks after a maximal prior reply are the native ABI test's,
  // engine/web/tests/nmod_alloc.rs)
  const small = `{"fn":"nmod_echelon","p":"7","rows":400,"cols":401,"m":"${Array(400).fill(Array(401).fill("6").join(",")).join(";")}","reduced":true,"want_rows":true}`;
  for (const [label, peak, req] of cases) {
    const e = instance();
    assert.ok(call(e, small).startsWith('{"ok":'));
    const before = e.memory.buffer.byteLength;
    const reply = call(e, req);
    grew[label] = e.memory.buffer.byteLength - before;
    replies[label] = reply;
    assert.ok(reply.startsWith('{"ok":'), `${label}: ${reply.slice(0, 200)}`);
    assert.ok(grew[label] < peak * 1.25, `${label}: grew by ${grew[label]} bytes, peak ${peak}`);
  }
  console.log(`nmod ops wasm: grew ${JSON.stringify(grew)} bytes`);
  // with the shared cache at its 64-table policy and a prior reply past
  // every nmod reply: the same replies, the cache unchanged, no growth
  // past the op's peak
  for (const [label, peak, req] of cases) {
    const e = instance();
    fillCount(e);
    const cache = stats(e);
    const before = e.memory.buffer.byteLength;
    assert.ok(call(e, req) === replies[label], `${label}: a different reply with the cache at its count policy`);
    assert.ok(e.memory.buffer.byteLength - before < peak * 1.25, label);
    assert.deepEqual(stats(e), cache, `${label}: the shared cache at its count policy`);
  }
  // and with the cache at its byte policy (one long-lived instance, every
  // op right after the fill): the same replies, the cache unchanged
  const f = instance();
  for (const [label, , req] of cases) {
    fillBytes(f);
    const cache = stats(f);
    // (compared without printing megabytes on a failure)
    assert.ok(call(f, req) === replies[label], `${label}: a different reply with the cache at its byte policy`);
    assert.deepEqual(stats(f), cache, `${label}: the shared cache at its byte policy`);
  }
});

function isPrime(n: bigint): boolean {
  if (n < 2n) return false;
  for (const q of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) if (n % q === 0n) return n === q;
  let d = n - 1n, s = 0;
  while (d % 2n === 0n) (d /= 2n), s++;
  const pow = (b: bigint, e: bigint) => {
    let r = 1n;
    b %= n;
    while (e > 0n) {
      if (e & 1n) r = (r * b) % n;
      b = (b * b) % n;
      e >>= 1n;
    }
    return r;
  };
  outer: for (const a of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
    let x = pow(a, d);
    if (x === 1n || x === n - 1n) continue;
    for (let i = 1; i < s; i++) {
      x = (x * x) % n;
      if (x === n - 1n) continue outer;
    }
    return false;
  }
  return true;
}

test("100 NTT primes in a row: no memory growth, the shared cache untouched", (t) => {
  const e = instance();
  if (call(e, preq("gcd", 7n, "1,1", "1")).includes("unknown fn")) return t.skip("this engine build predates the nmod ops");
  fillCount(e);
  const primes: bigint[] = [];
  for (let c = 1n << 21n; primes.length < 100; c++) if (isPrime((c << 20n) + 1n)) primes.push((c << 20n) + 1n);
  const run = (p: bigint) => {
    const a = poly(3000, p), b = poly(1500, p);
    for (const f of ["mul", "divrem"]) assert.ok(call(e, preq(f, p, a, b)).startsWith('{"ok"'));
    assert.ok(call(e, preq("mul", P, poly(3000, P), poly(1500, P))).startsWith('{"ok"'));
  };
  const atCap = (p: bigint) => assert.ok(call(e, preq("mul", p, poly(1 << 15, p), poly(1 << 15, p))).startsWith('{"ok"'));
  run(primes[0]);
  atCap(primes[0]);
  const before = e.memory.buffer.byteLength;
  const cache = stats(e);
  for (const p of primes) run(p);
  // small, then at the cap, then small again: tables are the call's own,
  // never a larger one replacing a smaller one
  atCap(primes[1]);
  run(primes[2]);
  assert.equal(e.memory.buffer.byteLength, before);
  assert.deepEqual(stats(e), cache);
});

test("Stop: the host is asked at least every 2^16 multiply-adds, and Stop mid-run traps", () => {
  const e0 = instance();
  if (call(e0, preq("gcd", 7n, "1,1", "1")).includes("unknown fn")) return;
  // (label, request, its work in multiply-adds or butterflies, about)
  const cases: [string, string, number][] = [
    ["echelon", worst()[0][2], 2 * (400 * 400 * 400) / 3],
    ["mul", worst()[1][2], 9 * (1 << 15) * 16],
    ["divrem classical", worst()[5][2], 59 * (1 << 15)],
    ["gcd", worst()[6][2], 2 ** 27],
  ];
  for (const [label, req, work] of cases) {
    let asked = 0;
    const e = instance(() => (asked++, 0));
    const full = call(e, req);
    assert.ok(full.startsWith('{"ok":'));
    assert.ok(asked >= work / (1 << 16), `${label}: asked ${asked} times for about ${work}`);
    let k = 0;
    const half = asked >> 1;
    const e2 = instance(() => (k++ >= half ? 1 : 0));
    assert.throws(() => call(e2, req), WebAssembly.RuntimeError, label);
    console.log(`nmod ${label} wasm: ${asked} host checks`);
  }
});

test("the nmod ops' caps through the ABI", (t) => {
  const e = instance();
  if (call(e, preq("gcd", 7n, "1,1", "1")).includes("unknown fn")) return t.skip("this engine build predates the nmod ops");
  const zeros = (r: number, c: number) => Array(r).fill(Array(c).fill("0").join(",")).join(";");
  const ech = (r: number, c: number) => `{"fn":"nmod_echelon","p":"7","rows":${r},"cols":${c},"m":"${zeros(r, c)}"}`;
  assert.match(call(e, ech(1, 1024)), /^\{"ok":/);
  assert.match(call(e, ech(1, 1025)), /rows and cols/);
  assert.match(call(e, ech(400, 401)), /^\{"ok":/);
  assert.match(call(e, ech(401, 401)), /entries, more than/);
  const ones = (n: number) => Array(n).fill("1").join(",");
  for (const [f, cap] of [["mul", 1 << 15], ["divrem", 1 << 15], ["gcd", 1 << 14]] as const) {
    assert.match(call(e, preq(f, 7n, ones(cap), "1,1")), /^\{"ok":/, f);
    assert.match(call(e, preq(f, 7n, ones(cap + 1), "1,1")), /coefficients, more than/, f);
    const huge = `{"fn":"nmod_poly_${f}","p":"7","a":"${"1,".repeat(cap * 20 + 2100)}1","b":"1"}`;
    const before = e.memory.buffer.byteLength;
    assert.match(call(e, huge), /the request has \d+ bytes/, f);
    // (only the request's own bytes)
    assert.ok(e.memory.buffer.byteLength - before <= huge.length + MIB, f);
  }
});
