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
import { ARRAY_LIMITS, NDArray, empty, toDtype } from "./numpy";
import { RetiredDebt } from "./retired-debt";
import { floatCall } from "./types";

// a Python number (int, bool, float, a numpy scalar) as a JS number
const toNum = (v: any): number => O.fv(v) ?? (O.fv(floatCall(v)) as number);

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
  skt_buffer_new(len: number): number;
  skt_buffer_ptr(h: number): number;
  skt_buffer_release(h: number): number;
  skt_fit(ds: number, sw: number, classes: number, kind: number, maxDepth: number, minSamplesSplit: number, minSamplesLeaf: number, minWeightLeaf: number, maxFeatures: number, minImpurityDecrease: number, seed: number): number;
  skt_tree_info(h: number, what: number): number;
  skt_tree_array(h: number, which: number): number;
  skt_tree_release(h: number): number;
  skt_fit_bytes(n: number, f: number, nOutputs: number, stride: number, maxDepth: number, minSamplesLeaf: number): number;
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
// the JS bytes this module holds: a fitted tree's arrays while they are copied out, until numpy owns them
let held = 0;

interface Key {
  gen: number;
  h: number;
  n: number;
  f: number;
  o: number;
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

/** The pages a growth of `bytes` is charged: rounded up, plus the allocator's own rounding (a page an allocation
 * for `allocations` of them, at least SLACK_PAGES). */
const pagesFor = (bytes: bigint, allocations = SLACK_PAGES): bigint => (bytes + BigInt(PAGE - 1)) / BigInt(PAGE) + BigInt(Math.max(SLACK_PAGES, allocations));

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
function admit(k: Kernel, what: string, bytes: bigint, allocations = SLACK_PAGES) {
  const pages = pagesFor(bytes, allocations);
  check(what, k.memory.buffer.byteLength, pages * BigInt(PAGE));
  k.skt_begin(Number(pages));
}

/** A wasm32 address as JS gets it (an i32 result, so SIGNED: from 2 GiB on it is negative), unsigned. */
export const at = (p: number): number => p >>> 0;

/** The pages the heap's bound last refused (wasmheap::Refusal's first u32), or 0.  (Exported for the tests.) */
export function refusedPages(k: Pick<Kernel, "memory" | "skt_last_refusal">): number {
  try {
    return new Uint32Array(k.memory.buffer, at(k.skt_last_refusal()), 1)[0];
  } catch {
    return 0;
  }
}

/** An open dataset's buffers in the module's memory: X, y and the mask (or null).  (Exported for the tests.) */
export function datasetViews(k: Pick<Kernel, "memory" | "skt_dataset_x" | "skt_dataset_y" | "skt_dataset_mask">, h: number, n: number, f: number, o: number, masked: boolean) {
  const b = k.memory.buffer;
  return {
    x: new Float32Array(b, at(k.skt_dataset_x(h)), n * f),
    y: new Float64Array(b, at(k.skt_dataset_y(h)), n * o),
    mask: masked ? new Uint8Array(b, at(k.skt_dataset_mask(h)), f) : null,
  };
}

/** A refused growth (the heap's page bound), as the memory guard's MemoryError. */
function refused(k: Kernel, what: string): never {
  const need = refusedPages(k);
  return memoryGuard(what, BigInt(k.memory.buffer.byteLength) + BigInt(need) * BigInt(PAGE), skltreeBound(), WHO);
}

/** Run `f` on the instance; a trap (Stop, a growth refused where it couldn't fail cleanly, or a bug) retires it,
 * after its last read, and is the call's KeyboardInterrupt, MemoryError or SystemError. */
function guarded<T>(k: Kernel, what: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    // (between a trap and retire() nothing may call an export that touches the dataset table: a trap skips Drop,
    // so its RefCell may still be borrowed and any such call would trap again; skt_last_refusal reads only the
    // heap's own state)
    const need = refusedPages(k);
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
    const v = datasetViews(k, h, n, f, o, m !== null);
    copyIn(v.x, storage(x));
    copyIn(v.y, storage(yy));
    if (v.mask) copyIn(v.mask, storage(m!));
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
  const key = { gen, h, n, f, o };
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

/** A token's key when its dataset is usable; else the call's ValueError. */
function usableKey(token: any): Key {
  const key = token !== null && typeof token === "object" ? tokens.get(token) : undefined;
  if (key === undefined || K === null || key.gen !== gen || !live.has(key.h))
    return Obj.raise(Obj.T.ValueError, "this dataset can't be used: it was released, or a Stop retired the decision-tree kernel it lived in");
  return key;
}

const KINDS: Record<string, number> = { gini: 0, entropy: 1, log_loss: 1, squared_error: 2 };
// (a fit's allocations, for the allocator's rounding: the weights' and counts' buffers, the splitter's five, the
// criterion's three, the stack, the tree's nine arrays, the importances, the table's node)
const FIT_ALLOCATIONS = 24;

/** A float64 copy of a 1-D array or list of numbers, in a buffer of the kernel's: its handle (0 for None). */
function bufferIn(k: Kernel, what: string, values: any, len: number): number {
  if (values === null || values === undefined) return 0;
  const src: Float64Array = values instanceof NDArray ? Float64Array.from(storage(values)) : Float64Array.from(O.toArray(values).map((v: any) => toNum(v)));
  if (src.length !== len) Obj.raise(Obj.T.ValueError, `${what} has ${src.length} entries; ${len} expected`);
  const h = guarded(k, what, () => k.skt_buffer_new(len));
  if (h < 0) refused(k, what);
  try {
    copyIn(new Float64Array(k.memory.buffer, at(k.skt_buffer_ptr(h)), len), src);
  } catch (e) {
    // (a Stop between chunks: the buffer goes with the call)
    if (K === k) k.skt_buffer_release(h);
    throw e;
  }
  return h;
}

/** Copy a fitted tree's arrays out as numpy arrays (the int64 ones exact: every value is far below 2**53). */
function treeOut(k: Kernel, t: number): any {
  const nodes = k.skt_tree_info(t, 0), maxDepth = k.skt_tree_info(t, 1), o = k.skt_tree_info(t, 2), stride = k.skt_tree_info(t, 3), f = k.skt_tree_info(t, 4);
  // (the copies out are held by this module until numpy owns them: charged with the tree still in the module)
  const jsBytes = nodes * (8 * 7 + 1) + nodes * o * stride * 8 + f * 8;
  check("A fitted tree's copy out", k.memory.buffer.byteLength, BigInt(jsBytes));
  held += jsBytes;
  try {
    const b = k.memory.buffer;
    const ints = (which: number) => {
      const a = empty([nodes], toDtype("int64")), src = new BigInt64Array(b, at(k.skt_tree_array(t, which)), nodes);
      for (let i = 0; i < nodes; i++) {
        a.data[i] = Number(src[i]);
        if ((i & 4095) === 4095) O.pollInterrupt();
      }
      return a;
    };
    const floats = (which: number, shape: number[]) => {
      const a = empty(shape, toDtype("float64"));
      copyIn(a.data, new Float64Array(b, at(k.skt_tree_array(t, which)), a.size));
      return a;
    };
    const mgl = empty([nodes], toDtype("uint8"));
    copyIn(mgl.data, new Uint8Array(b, at(k.skt_tree_array(t, 7)), nodes));
    const d = new Obj.PyDict();
    Obj.dictSet(d, "children_left", ints(0));
    Obj.dictSet(d, "children_right", ints(1));
    Obj.dictSet(d, "feature", ints(2));
    Obj.dictSet(d, "threshold", floats(3, [nodes]));
    Obj.dictSet(d, "impurity", floats(4, [nodes]));
    Obj.dictSet(d, "n_node_samples", ints(5));
    Obj.dictSet(d, "weighted_n_node_samples", floats(6, [nodes]));
    Obj.dictSet(d, "missing_go_to_left", mgl);
    Obj.dictSet(d, "value", floats(8, [nodes, o, stride]));
    Obj.dictSet(d, "importances", floats(9, [f]));
    Obj.dictSet(d, "node_count", nodes);
    Obj.dictSet(d, "max_depth", maxDepth);
    return d;
  } finally {
    // (numpy owns the arrays now: they leave this module's count)
    held -= jsBytes;
  }
}

const FIT_ERRORS: Record<number, string> = {
  [-9]: "the tree's parameters are out of range",
  [-1]: "the tree's sizes overflow",
};

/** Fit one tree on a dataset: the tree's arrays, as `tree_` holds them, and the raw importances. */
function fit(token: any, sampleWeight: any, nClasses: any, criterion: any, maxDepth: any, minSamplesSplit: any, minSamplesLeaf: any, minWeightLeaf: any, maxFeatures: any, minImpurityDecrease: any, seed: any): any {
  const key = usableKey(token);
  const kind = KINDS[String(criterion)];
  if (kind === undefined) Obj.raise(Obj.T.ValueError, `criterion must be one of gini, entropy, log_loss or squared_error, not ${String(criterion)}`);
  const num = (v: any) => (v === null || v === undefined ? NaN : toNum(v));
  const classes: number[] | null = kind === 2 ? null : O.toArray(nClasses).map((v: any) => toNum(v));
  if (classes !== null && classes.length !== key.o) Obj.raise(Obj.T.ValueError, `n_classes has ${classes.length} entries; y has ${key.o} outputs`);
  const stride = classes === null ? 1 : Math.max(...classes);
  const md = maxDepth === null || maxDepth === undefined ? 2 ** 31 - 1 : num(maxDepth);
  const what = `Fitting a tree on ${key.n} samples by ${key.f} features`;
  const k = K!;
  const fb = k.skt_fit_bytes(key.n, key.f, key.o, stride, md, num(minSamplesLeaf));
  if (fb < 0) memoryGuard(what, 2n ** 64n, skltreeBound(), WHO);
  admit(k, what, BigInt(fb) + 8n * BigInt(key.n + key.o), FIT_ALLOCATIONS);
  const sw = bufferIn(k, "sample_weight", sampleWeight, key.n);
  let cls = 0;
  try {
    cls = classes === null ? 0 : bufferIn(k, "n_classes", classes, key.o);
  } catch (e) {
    // (the weights' buffer goes with the call: skt_fit, which consumes the buffers, wasn't reached)
    if (K === k && sw) k.skt_buffer_release(sw);
    throw e;
  }
  const t = guarded(k, what, () => k.skt_fit(key.h, sw, cls, kind, md, num(minSamplesSplit), num(minSamplesLeaf), num(minWeightLeaf), num(maxFeatures), num(minImpurityDecrease), num(seed) >>> 0));
  if (t < 0) {
    if (t === -2) refused(k, what);
    const row = k.skt_detail_row(), col = k.skt_detail_col();
    if (t === -10) Obj.raise(Obj.T.ValueError, `y holds something other than a class index in row ${row}, output ${col}`);
    if (t === -11) Obj.raise(Obj.T.ValueError, "sample_weight holds a value that isn't finite, or every weight is zero");
    Obj.raise(t in FIT_ERRORS ? Obj.T.ValueError : Obj.T.SystemError, FIT_ERRORS[t] ?? `the decision-tree kernel refused the fit (${t})`);
  }
  try {
    return treeOut(k, t);
  } finally {
    if (K === k) k.skt_tree_release(t);
  }
}

/** apply(children_left, children_right, feature, threshold, missing_go_to_left, X): each row's leaf, as
 * scikit-learn's Tree._apply_dense: the float32 value (a JS number: widened to float64, exactly) compared `<=`
 * with the float64 threshold; NaN follows missing_go_to_left. */
function apply(left: any, right: any, feature: any, threshold: any, mgl: any, X: any): any {
  const x = arrayArg("X", X, ["float32"], 2, "(n_samples, n_features)");
  const L = storage(arrayArg("children_left", left, ["int64"], 1, "(node_count,)")), R = storage(arrayArg("children_right", right, ["int64"], 1, "(node_count,)"));
  const F = storage(arrayArg("feature", feature, ["int64"], 1, "(node_count,)")), T = storage(arrayArg("threshold", threshold, ["float64"], 1, "(node_count,)"));
  const M = storage(arrayArg("missing_go_to_left", mgl, ["uint8"], 1, "(node_count,)"));
  const nodes = L.length;
  if (R.length !== nodes || F.length !== nodes || T.length !== nodes || M.length !== nodes || nodes === 0) Obj.raise(Obj.T.ValueError, "the tree's arrays must have one entry a node");
  const [m, f] = x.shape;
  const xs = storage(x);
  const out = empty([m], toDtype("int64"));
  let steps = 0;
  for (let i = 0; i < m; i++) {
    let node = 0;
    while (L[node] !== -1) {
      const j = F[node];
      // (a malformed tree can't send the walk outside its arrays)
      if (!(j >= 0 && j < f) || !(L[node] > node && L[node] < nodes && R[node] > node && R[node] < nodes)) Obj.raise(Obj.T.ValueError, "the tree's arrays don't form a tree");
      const v = xs[i * f + j];
      node = v !== v ? (M[node] ? L[node] : R[node]) : v <= T[node] ? L[node] : R[node];
      if ((++steps & 4095) === 0) O.pollInterrupt();
    }
    out.data[i] = node;
  }
  return out;
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
  m.fit = Obj.builtin(fit, "fit", Obj.sig(["dataset", "sample_weight", "n_classes", "criterion", "max_depth", "min_samples_split", "min_samples_leaf", "min_weight_leaf", "max_features", "min_impurity_decrease", "seed"]));
  m.apply = Obj.builtin(apply, "apply", Obj.sig(["children_left", "children_right", "feature", "threshold", "missing_go_to_left", "X"]));
  m._state = Obj.builtin(state, "_state");
  m._test_bound = Obj.builtin((bytes: any) => ((testBound = bytes === null ? null : BigInt(bytes)), null), "_test_bound");
});
