// The decision-tree kernel (engine/skltree, wasm/sagebrush-skltree.wasm; the design note sklearn-trees r3) as
// the private builtin module `_skltree`, which lib/sagebrush/skltree.py makes public as sagebrush.skltree.
// This first part hands datasets over: dataset(X, y, mask) copies X (C-contiguous float32), y (float64) and
// the missing-value mask into the module once, checks them there, and returns an opaque token; release(token)
// frees them.  The trees that use them come later.
//
// The module is compiled at the first dataset(), never before (an import of sagebrush.skltree makes nothing),
// from wherever the host keeps it (src/runtime/wasm-asset.ts, key SKLTREE).  There is no TypeScript fallback:
// a second implementation would be a second set of bits to keep equal, so where WebAssembly is off the call
// says so.
//
// Memory (§6, LIMITS' L1-L3): one bound for the module's whole footprint,
//   B = min(4 GiB, ARRAY_LIMITS.bytes, E), E the engine's per-instance allowance (engine.ts moduleAllowance:
//   the pushed total / 4, or 256 MiB of its nominal total when the host pushes none),
// and one invariant, checked before anything is allocated:
//   committed wasm bytes (memory.size, M0 included) + retired debt + held JS bytes + the call's growth <= B,
// the growth charged page-rounded (with a page of the allocator's own rounding per buffer), and the heap's
// page bound (wasmheap, skt_begin) set to exactly the pages charged, so the module can't grow past what was
// admitted even if the estimate were short: a refusal there is the same explained MemoryError.  Free space
// inside the committed memory is never credited.  A retired instance's memory stays charged until it is
// collected (src/runtime/retired-debt.ts, the engine's mechanism).  The copies in are straight from the
// arrays' storage into the module's buffers, so this part holds no JS bytes of its own.
//
// Stop: the module's loops poll it (engine/interrupt, every 4096 elements of work), and an interrupt traps;
// the copies in poll between chunks of 4096 elements.  A trap retires the instance and every dataset in it
// (a new instance is made at the next dataset()); a stale token raises on use and releases silently.

import { assetBytes } from "./wasm-asset";
import * as Obj from "./object";
import * as O from "./ops";
import { memoryGuard, newBuiltinModule } from "./modules";
import { INTR, INTR_CTRL_C } from "./interrupt";
import { initialMemory, moduleAllowance } from "./engine";
import { ARRAY_LIMITS, NDArray } from "./numpy";
import { RetiredDebt } from "./retired-debt";

interface Kernel {
  memory: WebAssembly.Memory;
  skt_dataset_new(n: number, f: number, outputs: number, masked: number): number;
  skt_dataset_x(h: number): number;
  skt_dataset_y(h: number): number;
  skt_dataset_mask(h: number): number;
  skt_dataset_seal(h: number): number;
  skt_dataset_release(h: number): number;
  skt_detail_row(): number;
  skt_detail_col(): number;
  skt_live_bytes(): number;
  skt_begin(pages: number): void;
  skt_last_refusal(): number;
}

const PAGE = 65536;
// (the allocator's own rounding: dlmalloc may take a fresh 64 KiB segment for each buffer, and one more for the
// table's node; charged on top of the bytes asked for)
const SLACK_PAGES = 4;
// The elements a copy in moves between two polls of Stop (engine/skltree's work::STRIDE).
const STRIDE = 4096;
// The address space of a wasm32 memory: B's own cap.
const ADDRESS_SPACE = 2n ** 32n;
// A memory more than this many times a new dataset's need, with no dataset live in it, is retired for a fresh
// one (E4: one big fit doesn't pin its high-water mark for the session).
const FRESH_RATIO = 4;
const WHO = "the decision-tree kernel";

let MOD: WebAssembly.Module | null = null;
let M0 = 0;
let K: Kernel | null = null;
// (the live instance's generation: a token names its instance's; a new instance, never an old one, gets a new one)
let gen = 0;
// the live instance's datasets: handle -> bytes
const live = new Map<number, number>();
const debt = new RetiredDebt();
// the JS bytes this module holds (staging, a copy out in flight): none in this part
const held = 0;

interface Key {
  gen: number;
  h: number;
}
// the tokens dataset() returned (an object() each: unforgeable), and their datasets
const tokens = new WeakMap<object, Key>();
const FR = (globalThis as any).FinalizationRegistry;
// (a token collected without release(): its dataset released then, silently; never during a call, since a
// finalizer runs only between tasks)
const finalizer = typeof FR === "function" ? new FR((k: Key) => releaseKey(k)) : null;

function wasmOff(): boolean {
  const g = globalThis as any;
  return !!(g.__SAGEBRUSH_NO_WASM__ || g.process?.env?.SAGEBRUSH_NO_WASM || typeof WebAssembly !== "object");
}

// (exported for the tests)
export function skltreeBytes(): Uint8Array {
  return assetBytes("SKLTREE", "sagebrush-skltree.wasm", "decision-tree kernel");
}

// (the tests' lower bound, _skltree._test_bound: it can only lower B, never raise it)
let testBound: bigint | null = null;

/** B: the module's whole footprint may not exceed it. */
export function skltreeBound(): bigint {
  let b = testBound !== null && testBound < ADDRESS_SPACE ? testBound : ADDRESS_SPACE;
  const arr = BigInt(ARRAY_LIMITS.bytes), e = moduleAllowance();
  if (arr < b) b = arr;
  if (e < b) b = e;
  return b;
}

/** The invariant: refuse (the memory guard's explained MemoryError) unless `committed` + the retired debt + the
 * held JS bytes + `grow` fit B.  `grow` is page-rounded already. */
function check(what: string, committed: number, grow: bigint) {
  const b = skltreeBound();
  const d = debt.bytes();
  if (!Number.isFinite(d)) memoryGuard(what, b + 1n, b, WHO);
  const need = BigInt(committed) + BigInt(d) + BigInt(held) + grow;
  if (need > b) memoryGuard(what, need, b, WHO);
}

/** The pages a growth of `bytes` is charged: rounded up, plus the allocator's own rounding. */
const pagesFor = (bytes: bigint): bigint => (bytes + BigInt(PAGE - 1)) / BigInt(PAGE) + BigInt(SLACK_PAGES);

function kernel(): Kernel {
  if (K) return K;
  if (wasmOff()) Obj.raise(Obj.T.RuntimeError, "Sagebrush's decision trees need WebAssembly, which is turned off here");
  if (MOD === null) {
    const bytes = skltreeBytes();
    const m0 = initialMemory(bytes);
    if (m0 === null) Obj.raise(Obj.T.SystemError, "the decision-tree kernel's module has no plain memory of its own");
    M0 = m0;
    MOD = new WebAssembly.Module(bytes as any);
  }
  check("A new decision-tree kernel instance", M0, 0n);
  const imports = { sagebrush: { interrupted: () => INTR[0] & INTR_CTRL_C } };
  K = new WebAssembly.Instance(MOD, imports).exports as unknown as Kernel;
  gen++;
  live.clear();
  return K;
}

/** Retire the live instance after its last read: its memory charged until collected, every dataset in it stale. */
function retire() {
  if (K === null) return;
  const memory = K.memory;
  K = null;
  live.clear();
  debt.retire(memory);
}

/** Admit a growth of `bytes` in the live instance and bound its heap to exactly what was charged. */
function admit(k: Kernel, what: string, bytes: bigint) {
  const pages = pagesFor(bytes);
  check(what, k.memory.buffer.byteLength, pages * BigInt(PAGE));
  k.skt_begin(Number(pages));
}

/** A refused growth (the heap's page bound), as the memory guard's MemoryError. */
function refused(k: Kernel, what: string): never {
  let need = 0;
  try {
    need = new Uint32Array(k.memory.buffer, k.skt_last_refusal(), 1)[0];
  } catch {}
  return memoryGuard(what, BigInt(k.memory.buffer.byteLength) + BigInt(need) * BigInt(PAGE), skltreeBound(), WHO);
}

/** Run `f` on the instance; a trap (Stop, a growth refused where it couldn't fail cleanly, or a bug) retires it,
 * after its last read, and is the call's KeyboardInterrupt, MemoryError or SystemError. */
function guarded<T>(k: Kernel, what: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    let need = 0;
    try {
      need = new Uint32Array(k.memory.buffer, k.skt_last_refusal(), 1)[0];
    } catch {}
    retire();
    O.pollInterrupt();
    if (need > 0) memoryGuard(what, BigInt(need) * BigInt(PAGE), skltreeBound(), WHO);
    return Obj.raise(Obj.T.SystemError, `the decision-tree kernel failed: ${e.message}`);
  }
}

function releaseKey(key: Key) {
  if (K === null || key.gen !== gen || !live.has(key.h)) return;
  live.delete(key.h);
  K.skt_dataset_release(key.h);
}

/** `a`'s elements from its storage (C-contiguous), as a typed array view */
const storage = (a: NDArray): any => a.data.subarray(a.offset, a.offset + a.size);

/** Copy `src` into the module's memory at `at` (a typed array of the same kind over the module's buffer, made
 * once: nothing grows the memory while it is copied), polling Stop every STRIDE elements. */
function copyIn(dst: any, src: any) {
  for (let lo = 0; lo < src.length; lo += STRIDE) {
    dst.set(src.subarray(lo, Math.min(src.length, lo + STRIDE)), lo);
    O.pollInterrupt();
  }
}

function arrayArg(name: string, a: any, dtypes: string[], ndim: number, shape: string): NDArray {
  if (!(a instanceof NDArray) || !dtypes.includes(a.dt.name) || a.shape.length !== ndim || !a.isC())
    Obj.raise(Obj.T.TypeError, `${name} must be a C-contiguous ${dtypes.join(" or ")} array of shape ${shape}`);
  return a;
}

const U32 = 2 ** 32 - 1;

function dataset(X: any, y: any, mask: any = null): any {
  const x = arrayArg("X", X, ["float32"], 2, "(n_samples, n_features)");
  const yy = arrayArg("y", y, ["float64"], 2, "(n_samples, n_outputs)");
  const [n, f] = x.shape, o = yy.shape[1];
  if (yy.shape[0] !== n) Obj.raise(Obj.T.ValueError, `y has ${yy.shape[0]} rows, but X has ${n}`);
  if (n === 0 || f === 0 || o === 0) Obj.raise(Obj.T.ValueError, `a dataset needs at least one sample, one feature and one output (X is ${n} by ${f}, y has ${o} outputs)`);
  if (n > U32 || f > U32 || o > U32) Obj.raise(Obj.T.ValueError, "a dataset's dimensions must each be below 2**32");
  const m = mask === null || mask === undefined ? null : arrayArg("missing_mask", mask, ["bool", "uint8"], 1, "(n_features,)");
  if (m !== null && m.shape[0] !== f) Obj.raise(Obj.T.ValueError, `missing_mask has ${m.shape[0]} entries, but X has ${f} features`);
  const what = `A dataset of ${n} samples by ${f} features and ${o} outputs`;
  const bytes = 4n * BigInt(n) * BigInt(f) + 8n * BigInt(n) * BigInt(o) + (m ? BigInt(f) : 0n);
  // (E4: a memory more than FRESH_RATIO times what a fresh instance would hold for this dataset (its M0 and the
  // charged growth), with nothing live in it, is retired for a fresh instance, if the invariant allows charging
  // the old memory as debt meanwhile)
  const freshSize = BigInt(M0) + pagesFor(bytes) * BigInt(PAGE);
  if (K !== null && live.size === 0 && BigInt(K.memory.buffer.byteLength) > BigInt(FRESH_RATIO) * freshSize) {
    const d = debt.bytes();
    if (Number.isFinite(d) && BigInt(K.memory.buffer.byteLength) + BigInt(d) + BigInt(held) + freshSize <= skltreeBound()) retire();
  }
  const k = kernel();
  admit(k, what, bytes);
  const h = guarded(k, what, () => k.skt_dataset_new(n, f, o, m ? 1 : 0));
  if (h < 0) {
    if (h === -2) refused(k, what);
    Obj.raise(Obj.T.SystemError, `the decision-tree kernel refused a dataset (${h})`);
  }
  try {
    copyIn(new Float32Array(k.memory.buffer, k.skt_dataset_x(h), n * f), storage(x));
    copyIn(new Float64Array(k.memory.buffer, k.skt_dataset_y(h), n * o), storage(yy));
    if (m) copyIn(new Uint8Array(k.memory.buffer, k.skt_dataset_mask(h), f), storage(m));
    const r = guarded(k, what, () => k.skt_dataset_seal(h));
    if (r < 0) {
      const row = k.skt_detail_row(), col = k.skt_detail_col();
      if (r === -3) Obj.raise(Obj.T.ValueError, `Input X contains NaN in row ${row}, column ${col}, a column the missing-value mask says has none.`);
      if (r === -4) Obj.raise(Obj.T.ValueError, `Input X contains infinity in row ${row}, column ${col}.`);
      if (r === -5) Obj.raise(Obj.T.ValueError, `Input y contains NaN or infinity in row ${row}, output ${col}.`);
      if (r === -8) Obj.raise(Obj.T.ValueError, `missing_mask must hold only 0 and 1 (feature ${col} holds another value).`);
      Obj.raise(Obj.T.SystemError, `the decision-tree kernel refused a dataset (${r})`);
    }
  } catch (e) {
    // (a Stop between chunks, or a refusal: the open dataset goes, unless the instance went with a trap)
    if (K === k) k.skt_dataset_release(h);
    throw e;
  }
  live.set(h, Number(bytes));
  const token = Obj.callObj(Obj.T.object, []);
  const key = { gen, h };
  tokens.set(token, key);
  finalizer?.register(token, key, token);
  return token;
}

/** Release a dataset; a released or stale token, or an object that isn't a token, is silently nothing. */
function release(token: any): null {
  if (token === null || typeof token !== "object") return null;
  const key = tokens.get(token);
  if (key === undefined) return null;
  tokens.delete(token);
  finalizer?.unregister(token);
  releaseKey(key);
  return null;
}

/** Whether a token's dataset is usable (live, in the live instance). */
function usable(token: any): boolean {
  const key = token !== null && typeof token === "object" ? tokens.get(token) : undefined;
  return key !== undefined && K !== null && key.gen === gen && live.has(key.h);
}

/** The module's state, for the tests: the instance's generation and memory, the live datasets and their bytes
 * as the module counts them, the retired debt, and B. */
function state(): any {
  return Obj.tuple([gen, K ? K.memory.buffer.byteLength : 0, live.size, K ? K.skt_live_bytes() : 0, debt.bytes(), debt.count, Number(skltreeBound())]);
}

newBuiltinModule("_skltree", (m) => {
  m.dataset = Obj.builtin(dataset, "dataset", Obj.sig(["X", "y", "missing_mask"]));
  m.release = Obj.builtin(release, "release");
  m.usable = Obj.builtin(usable, "usable");
  m._state = Obj.builtin(state, "_state");
  m._test_bound = Obj.builtin((bytes: any) => ((testBound = bytes === null ? null : BigInt(bytes)), null), "_test_bound");
});
