#!/usr/bin/env node
// The growth envelope against the engine's own allocator (no-cliffs C r15
// section 1; astra2's carried cases): every block's real page growth must be
// at most W(b) = ceil((b + 64) / 65536) * 65536 + 65536.  The probe module
// (engine/growth-probe) allocates through the same global allocator as the
// engine's module (std's dlmalloc on wasm32-unknown-unknown).
//
//   node engine/growth-probe/sweep.mjs <sagebrush_growth_probe.wasm>
//   SWEEP_W=identity node ...   (the mutation W(b) = b: must FAIL)
import { readFileSync } from "node:fs";

const PAGE = 65536;
const W = process.env.SWEEP_W === "identity" ? (b) => b : (b) => Math.ceil((b + 64) / PAGE) * PAGE + PAGE;
const module = new WebAssembly.Module(readFileSync(process.argv[2]));
const fresh = () => new WebAssembly.Instance(module, {}).exports;

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
  if (!ok) failures++;
}
/** The page growth (bytes) of one allocation of b bytes on instance e. */
function grow(e, b) {
  const p0 = e.probe_pages();
  const ptr = e.probe_alloc(b);
  if (ptr === 0) throw new Error(`allocation of ${b} bytes failed`);
  return { ptr, bytes: (e.probe_pages() - p0) * PAGE };
}

// 1. a fresh allocator's first growth, small non-page-aligned blocks
for (const b of [1, 100, 4096]) {
  const g = grow(fresh(), b);
  check(`first growth, ${b} B`, g.bytes <= W(b), `grew ${g.bytes} <= W ${W(b)}`);
}

// 2. page multiples and their neighbours, each on a fresh instance
for (const k of [1, 2, 16]) {
  for (const b of [k * PAGE - 1, k * PAGE, k * PAGE + 1]) {
    const g = grow(fresh(), b);
    check(`fresh, b = ${b}`, g.bytes <= W(b), `grew ${g.bytes} <= W ${W(b)}`);
  }
}

// 3. a fragmented heap that forces a growth: every other small block freed
//    (non-adjacent holes), then a block no hole can hold
{
  const e = fresh();
  const small = [];
  for (let i = 0; i < 64; i++) small.push(e.probe_alloc(1000));
  for (let i = 0; i < 64; i += 2) e.probe_free(small[i], 1000);
  const b = 32 * PAGE;
  const g = grow(e, b);
  check("fragmented heap, forced growth", g.bytes > 0 && g.bytes <= W(b), `grew ${g.bytes} (> 0) <= W ${W(b)}`);
}

// 4. reuse only: a freed block of the same size is reused, no growth
{
  const e = fresh();
  const b = 10000;
  e.probe_free(e.probe_alloc(b), b);
  const g = grow(e, b);
  check("reuse only", g.bytes === 0, `grew ${g.bytes} (= 0)`);
}

// 5. a call sequence on one instance: each growth within its W, the
//    watermark never falls
{
  const e = fresh();
  let pages = e.probe_pages();
  for (const b of [5000, 70000, 200000, 1000, 1 << 20, 3 * PAGE + 7]) {
    const g = grow(e, b);
    const now = e.probe_pages();
    check(`sequence, b = ${b}`, g.bytes <= W(b) && now >= pages, `grew ${g.bytes} <= W ${W(b)}, pages ${pages} -> ${now}`);
    pages = now;
  }
}

console.log(failures ? `growth envelope: ${failures} FAILED` : "growth envelope: every growth within W(b)");
process.exit(failures ? 1 : 0);
