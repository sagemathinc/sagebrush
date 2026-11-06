import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// engine/nd's thread pool and large matrix products (threads r2, PR (1): src/runtime/nd.ts ndMatmul, the helper
// src/runtime/nd-helper.ts, the module's pool record and checks engine/nd/src/boundary.rs check_part): the same bytes
// on 1 thread and on every pool size, partition edges included (grader r1.1 pin 1); 20 runs at 8 threads in one
// process (pin 2: CI's runners have about 4 cores, so this oversubscribes; each scenario has a time budget, pin 7);
// a helper lost mid-job, a late helper writing after the failover (its sentinel only in the abandoned memory), a
// fresh memory that can't be made, a second or malformed bootstrap (pins 4, r2.1 3 and 5, daybreak3's sentinel and
// oversubscription after a fallback); the test hooks out of production code's reach (pin 5); and the public
// product's cutoff (pin 6). Each scenario runs in a fresh process: the pool is per session.
const ND = join(__dirname, "..", "src", "runtime", "nd.js");
const NS = join(__dirname, "..", "src", "notebook-session.js");

// (n, m, p): C (n x p) = A (n x m) B (m x p); n is the module's column count, which the pool partitions: 257 and 300
// don't divide among 2, 3, 4, 8 or 9 participants, at 257 the last of 9 gets 1 column, at 5 and 1 most get none;
// m = 513 crosses the module's blocks of k
const SHAPES = [[256, 256, 256], [257, 300, 257], [300, 257, 256], [5, 7, 3], [1, 1, 1], [13, 300, 9], [257, 1, 257], [2, 513, 600]];

function scenario(body: string, timeout = 60000): any {
  const pre = `
const nd = require(${JSON.stringify(ND)});
const T = nd.ndTest();
let s = 7;
const rnd = (len) => Float64Array.from({ length: len }, () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296 - 0.5);
const fnv = (c) => { let h = 0xcbf29ce484222325n; for (const x of new Uint8Array(c.buffer, c.byteOffset, c.byteLength)) h = ((h ^ BigInt(x)) * 0x100000001b3n) & 0xffffffffffffffffn; return h.toString(16); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ready = async () => { for (let i = 0; i < 1000 && nd.ndThreads().state === "starting"; i++) await sleep(10); return nd.ndThreads(); };
const ops = ${JSON.stringify(SHAPES)}.map(([n, m, p]) => [rnd(n * m), rnd(m * p), n, m, p]);
const hashes = () => ops.map(([A, B, n, m, p]) => fnv(nd.ndMatmul(A, B, n, m, p)));
const big = ops[1];
const product = () => nd.ndMatmul(big[0], big[1], big[2], big[3], big[4]);
const out = {};
(async () => { if (!nd.useNd()) throw new Error("engine/nd doesn't run here"); ${body}; })()
  .then(() => process.stdout.write(JSON.stringify(out)), (e) => process.stdout.write(JSON.stringify({ ...out, error: String(e?.message ?? e) })));`;
  return JSON.parse(execFileSync(process.execPath, ["-e", pre], { encoding: "utf8", timeout }));
}

// the one-thread bytes (no helpers: the pool is off), checked against a plain sum
let one: { hashes: string[]; err: number } | null = null;
function oneThread() {
  one ??= scenario(`
nd.ndTest({ helpers: 0 });
out.hashes = hashes();
const [A, B, n, m, p] = big, C = product();
let err = 0;
for (let i = 0; i < n; i++) for (let j = 0; j < p; j += 7) { let x = 0; for (let k = 0; k < m; k++) x += A[i * m + k] * B[k * p + j]; err = Math.max(err, Math.abs(x - C[i * p + j])); }
out.err = err;
out.threads = nd.ndThreads();
out.made = T.made;`);
  return one!;
}

test("one thread: no pool, no worker; the product within rounding of a plain sum", () => {
  const r: any = oneThread();
  assert.equal(r.error, undefined);
  assert.ok(r.err < 1e-13, `error ${r.err}`);
  assert.deepEqual(r.threads, { threads: 1, state: "off", why: "one core" });
  assert.equal(r.made, 0);
});

for (const helpers of [1, 2, 3, 7, 8]) {
  test(`${helpers + 1} threads: the one-thread bytes for every shape, partition edges included (pins 1, 7)`, { timeout: 90000 }, () => {
    const r = scenario(`
nd.ndTest({ helpers: ${helpers} });
product();
out.firstTeams = T.teams;
out.first = hashes();
out.ready = await ready();
const t0 = T.teams;
out.hashes = hashes();
out.teams = T.teams - t0;`);
    assert.equal(r.error, undefined);
    // (the first product starts the pool, so it comes before the pool is up: one thread, no team; the next ones,
    // during its start, have threads or not, the same bytes either way)
    assert.equal(r.firstTeams, 0);
    assert.deepEqual(r.ready, { threads: helpers + 1, state: "ready", why: "" });
    assert.deepEqual(r.first, oneThread().hashes);
    assert.deepEqual(r.hashes, oneThread().hashes);
    assert.equal(r.teams, SHAPES.length);
  });
}

test("8 threads, 20 runs in one process: each the one-thread bytes (pins 2, 7: oversubscribed on CI)", { timeout: 120000 }, () => {
  const r = scenario(`
nd.ndTest({ helpers: 7 });
product();
out.ready = await ready();
out.runs = [];
for (let i = 0; i < 20; i++) out.runs.push(fnv(product()));
out.teams = T.teams;`, 110000);
  assert.equal(r.error, undefined);
  assert.equal(r.ready.threads, 8);
  assert.deepEqual(r.runs, Array(20).fill(oneThread().hashes[1]));
  assert.equal(r.teams, 20);
});

test("a helper lost mid-job: the call ends within the stall bound with the one-thread bytes; one thread after, every helper terminated (pin 4)", { timeout: 60000 }, () => {
  const r = scenario(`
nd.ndTest({ helpers: 3, fault: "exit", stallMs: 1000 });
product();
out.ready = await ready();
const t0 = performance.now();
out.lost = fnv(product());
out.ms = performance.now() - t0;
out.after = nd.ndThreads();
out.teams = T.teams;
out.again = [];
for (let i = 0; i < 5; i++) out.again.push(fnv(product()));
out.counts = [T.teams, T.failovers, T.made, T.terminated, T.abandoned.length];`);
  assert.equal(r.error, undefined);
  assert.equal(r.ready.threads, 4);
  assert.equal(r.lost, oneThread().hashes[1]);
  assert.ok(r.ms < 1000 + 5000, `${r.ms} ms`);
  assert.equal(r.after.threads, 1);
  assert.equal(r.after.state, "off");
  assert.match(r.after.why, /a helper stopped responding \(2 of 3 finished\)/);
  assert.deepEqual(r.again, Array(5).fill(oneThread().hashes[1]));
  // (one team, the failed one; no team after; every helper made was terminated; one memory abandoned)
  assert.deepEqual(r.counts, [1, 1, 3, 3, 1]);
});

// (the clock: the job's first sample, or a later one, not finite or going back, fails the job at once, not at the
// stall bound: helper 1 never finishes, so only the clock check can end the wait early; daybreak3 E1)
for (const [what, clock] of [
  ["a first sample that isn't finite", "(k, t) => (k === 0 ? NaN : t)"],
  ["a later sample that isn't finite", "(k, t) => (k === 1 ? Infinity : t)"],
  ["a sample going back", "(k, t) => (k === 1 ? t - 1000 : t)"],
] as const) {
  test(`the clock: ${what} fails the job at once, with the one-thread bytes (ENGINE contract 3)`, { timeout: 60000 }, () => {
    const r = scenario(`
nd.ndTest({ helpers: 2, fault: "exit", stallMs: 3000 });
product();
out.ready = await ready();
const real = performance.now.bind(performance), f = ${clock};
let k = -1;
performance.now = () => (k < 0 ? real() : f(k++, real()));
const t0 = real();
k = 0;
out.result = fnv(product());
k = -1;
out.ms = real() - t0;
out.after = nd.ndThreads();`);
    assert.equal(r.error, undefined);
    assert.equal(r.ready.threads, 3);
    assert.equal(r.result, oneThread().hashes[1]);
    assert.ok(r.ms < 2000, `${r.ms} ms`);
    assert.deepEqual(r.after, { threads: 1, state: "off", why: "the clock failed" });
  });
}

test("a helper that fails its job: the one-thread bytes from a fresh memory, then one thread (r2.1 pin 3)", () => {
  const r = scenario(`
nd.ndTest({ helpers: 2, fault: "throw" });
product();
out.ready = await ready();
out.failed = fnv(product());
out.next = fnv(product());
out.after = nd.ndThreads();
out.counts = [T.teams, T.failovers, T.made, T.terminated, T.abandoned.length];`);
  assert.equal(r.error, undefined);
  assert.equal(r.ready.threads, 3);
  assert.equal(r.failed, oneThread().hashes[1]);
  assert.equal(r.next, oneThread().hashes[1]);
  assert.deepEqual(r.after, { threads: 1, state: "off", why: "1 helper(s) failed a matrix product" });
  assert.deepEqual(r.counts, [1, 1, 2, 2, 1]);
});

test("no fresh memory after a failure: that call and every later one fail with a clear error, never a result from the damaged memory (r2.1 pin 3)", () => {
  const r = scenario(`
nd.ndTest({ helpers: 2, fault: "throw", memoryFault: true });
product();
out.ready = await ready();
out.errors = [];
for (const f of [product, () => nd.ndCholesky(new Float64Array([4]), 1)]) {
  try { f(); out.errors.push("ran"); } catch (e) { out.errors.push(e.message); }
}
out.counts = [T.failovers, T.made, T.terminated];`);
  assert.equal(r.error, undefined);
  assert.equal(r.ready.threads, 3);
  const why = "the numerics module's thread pool failed (1 helper(s) failed a matrix product), and no new memory could be made for the module";
  assert.deepEqual(r.errors, [why, why]);
  assert.deepEqual(r.counts, [1, 2, 2]);
});

test("a late helper writing after the failover: its sentinel only in the abandoned memory; that call and the next give the one-thread bytes (daybreak3, astra contract 2)", { timeout: 60000 }, () => {
  const r = scenario(`
nd.ndTest({ helpers: 2, fault: "late", lateMs: 2500, stallMs: 500, noTerminate: true });
product();
out.ready = await ready();
const C = product();
out.failed = fnv(C);
const count = (m) => new Float64Array(m.buffer).filter((x) => x === -12345.25).length;
out.before = count(T.abandoned[0]);
await sleep(3500);
out.after = count(T.abandoned[0]);
out.inResult = C.filter((x) => x === -12345.25).length;
const D = product();
out.next = fnv(D);
out.inNext = D.filter((x) => x === -12345.25).length;
out.threads = nd.ndThreads().threads;
for (const c of T.unstopped) c.end();`);
  assert.equal(r.error, undefined);
  assert.equal(r.ready.threads, 3);
  assert.equal(r.failed, oneThread().hashes[1]);
  assert.equal(r.next, oneThread().hashes[1]);
  assert.equal(r.before, 0);
  // (all of C, 257 x 257, and helper 1's scratch slot)
  assert.ok(r.after > 257 * 257, `${r.after} sentinel values`);
  assert.equal(r.inResult, 0);
  assert.equal(r.inNext, 0);
  assert.equal(r.threads, 1);
});

for (const [hook, why] of [["rebootstrap", /^the pool's helper takes one bootstrap only$/], ["malformed", /^helper 1 failed: |^the pool's helper was sent a malformed bootstrap$/]] as const) {
  test(`a ${hook === "rebootstrap" ? "second" : "malformed"} bootstrap is refused: the pool is torn down, and the next product fails over cleanly (r2.1 pin 5)`, { timeout: 60000 }, () => {
    const r = scenario(`
nd.ndTest({ helpers: 2, ${hook}: true });
product();
await sleep(500);
out.next = fnv(product());
out.after = nd.ndThreads();
out.counts = [T.teams, T.failovers, T.made, T.terminated];`);
    assert.equal(r.error, undefined);
    assert.equal(r.next, oneThread().hashes[1]);
    assert.equal(r.after.threads, 1);
    assert.equal(r.after.state, "off");
    // (the refusal is the helper's message, or a helper that stopped: the crew's error for it)
    assert.ok(why.test(r.after.why) || /a helper refused a message|stopped \(exit code 0\)/.test(r.after.why), r.after.why);
    assert.deepEqual(r.counts, [0, 1, 2, 2]);
  });
}

test("the public product's cutoff: every dimension at least ND_MATMUL_MIN goes to engine/nd, one below it doesn't (pin 6)", async () => {
  const r = scenario(`
nd.ndTest({ helpers: 1 });
const { notebookSession } = require(${JSON.stringify(NS)});
const ses = notebookSession(() => {}, { captureStreams: true });
out.products = [];
for (const [n, m, p] of [[255, 255, 255], [256, 256, 256], [255, 256, 256], [256, 255, 256], [256, 256, 255], [2, 256, 256, 256]]) {
  const shape = (r, c) => (n === 2 ? "(2, " : "(") + r + ", " + c + ")";
  await ses.handle({ id: 1, code: "import numpy as np\\nC = np.ones(" + (n === 2 ? "(2, 256, 256)" : shape(n, m)) + ") @ np.ones(" + (n === 2 ? "(256, 256)" : shape(m, p)) + ")" });
  out.products.push(T.products);
}
out.max = nd.ND_MATMUL_MIN;`);
  assert.equal(r.error, undefined);
  assert.equal(r.max, 256);
  // (a stack of two 256 x 256 products: one call each)
  assert.deepEqual(r.products, [0, 1, 1, 1, 1, 3]);
});

test("the test hooks are out of production code's reach: only nd.ts defines ndTest, no source calls it, and no thread-count variable exists (pin 5)", () => {
  const root = join(__dirname, "..", "..");
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) {
        if (!["node_modules", "dist"].includes(f)) walk(p);
      } else if (/\.(ts|mts|mjs|js|py)$/.test(f)) {
        const t = readFileSync(p, "utf8");
        if (/\bndTest\b|SAGEBRUSH_ND_THREADS/.test(t)) hits.push(p.slice(root.length + 1));
      }
    }
  };
  for (const d of ["src", "web", "lib", "packages", "scripts"]) walk(join(root, d));
  assert.deepEqual(hits, ["src/runtime/nd.ts"]);
  const nd = readFileSync(join(root, "src", "runtime", "nd.ts"), "utf8");
  // (the hooks are read only through tst, set only by ndTest)
  assert.equal(nd.match(/tst\.hooks = /g)?.length, 1);
  assert.match(nd, /export function ndTest\(hooks\?: NdTestHooks \| null\): typeof tst \{\n  if \(hooks !== undefined\) tst\.hooks = hooks;/);
});
