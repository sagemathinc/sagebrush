// The Sagebrush engines (engine/web: modular symbols, a_p of elliptic
// curves, Dirichlet characters, dimensions) as the builtin module
// `_sbengine`: call(request JSON) -> reply JSON, the ABI of engine/web.
// The 450 KB WebAssembly module (wasm/sagebrush-engine.wasm) is compiled on
// first use, from wherever the host keeps it:
//   globalThis.__SAGEBRUSH_ENGINE__      its bytes, as base64 (the CLI bundle)
//   globalThis.__SAGEBRUSH_ENGINE_URL__  a URL to fetch synchronously (the
//                                        notebook's worker, where that is allowed)
//   else, in Node, the file wasm/sagebrush-engine.wasm above this module.

import { sha256Hex } from "./sha256";
import * as Obj from "./object";
import { newBuiltinModule, heapLimit } from "./modules";
import { JS_ENGINE, JS_HOST } from "./js-engine";
import { INTR, INTR_CTRL_C, consumeCtrlC, requestCtrlC } from "./interrupt";
import { fullGc } from "./gc";
import * as P from "./progress";

interface Engine {
  memory: WebAssembly.Memory;
  /** Optional (engines from before progress lack it): the progress frames. */
  sb_progress_ptr?(): number;
  sb_alloc(len: number): number;
  sb_free(ptr: number, len: number): void;
  sb_call(ptr: number, len: number): number;
  sb_sym_call(ptr: number, len: number): number;
  sb_mp_call(ptr: number, len: number): number;
  sb_last_error(): number;
  sb_reply_len(): number;
  // (optional: engines built before item D0 lack it)
  sb_set_memory_share?(v: number): void;
  sb_set_memory_total?(bytes: number, status: number, uncertified: number): void;
  // (optional: engines built before C r16b lack it; status 3 is none)
  sb_set_instance_total?(bytes: number, status: number): number;
  sb_live_estimate?(): number;
  sb_outstanding_bytes?(): number;
  // (optional: engines built before C-2b lack them)
  sb_set_retired_bytes?(bytes: number, faulted: number): number;
  sb_reserve?(whatPtr: number, whatLen: number, bytes: number): number;
  sb_grow?(handle: number, bytes: number): number;
  sb_release?(handle: number): number;
  sb_reply_ptr?(): number;
}

// The live instance.  Assigned only by createInstance (an admitted
// creation) and retire (no-cliffs C r14-r17, C-2b-ii; a test greps for any
// other assignment).
let E: Engine | null = null;

function engineBytes(): Uint8Array {
  const g = globalThis as any;
  if (typeof g.__SAGEBRUSH_ENGINE__ === "string") {
    const bin = atob(g.__SAGEBRUSH_ENGINE__);
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }
  if (g.__SAGEBRUSH_ENGINE_URL__) {
    let b: Uint8Array;
    // (in the runner, which has no network, the page fetches it: web/runner)
    if (typeof g.__SAGEBRUSH_FETCH_SYNC__ === "function") b = g.__SAGEBRUSH_FETCH_SYNC__(String(g.__SAGEBRUSH_ENGINE_URL__));
    else {
      const x = new XMLHttpRequest();
      x.open("GET", String(g.__SAGEBRUSH_ENGINE_URL__), false);
      x.responseType = "arraybuffer";
      x.send();
      if (x.status !== 200) throw new Error(`could not load the engine (HTTP ${x.status})`);
      b = new Uint8Array(x.response);
    }
    // (the browser's worker says which bytes it was built with: anything else,
    // a cached copy rewritten, say, is not run; design/security.md, SEC-522-1)
    if (typeof g.__SAGEBRUSH_ENGINE_SHA256__ === "string" && sha256Hex(b) !== g.__SAGEBRUSH_ENGINE_SHA256__) throw new Error("the engine fetched is not the one this page was built with");
    return b;
  }
  const fs = g.process?.getBuiltinModule?.("fs"), path = g.process?.getBuiltinModule?.("path");
  if (fs && path) {
    const start = typeof __dirname === "string" ? __dirname : g.process.cwd();
    for (let dir = start, i = 0; i < 6; i++, dir = path.dirname(dir)) {
      const f = path.join(dir, "wasm", "sagebrush-engine.wasm");
      if (fs.existsSync(f)) return new Uint8Array(fs.readFileSync(f));
    }
  }
  throw new Error("the Sagebrush engine (sagebrush-engine.wasm) is not available here");
}

/** The engine's progress frames (progress.ts), if this engine has them. */
let frames: Uint32Array | null = null;

// sagebrush.interrupted: Ctrl-C, polled by the engine's long loops
// (engine/interrupt); an interrupted call traps and the instance is retired.
// The same import copies the engine's progress frames into the shared slots
// (progress.ts), so progress needs no import of its own.
function interrupted(): number {
  if (frames !== null) {
    // (a view of memory that has since grown is detached: length 0; no
    // buffer getter is read on this path, which every poll takes)
    if (frames.length === 0) frames = frameView(E!);
    P.syncFrames(frames);
  }
  return INTR[0] & INTR_CTRL_C;
}

function engine(): Engine {
  return E ?? createInstance();
}

// ---------------------------------------------------------------------------
// Retired instances and admitted creation (no-cliffs C r14 section 2, r15
// sections 3-4, r16, r17 section 2; C-2b scope r2 section 2).
//
// A trapped or stopped instance is retired: its memory stays live until the
// collector frees it, so its bytes D_i (memory.buffer.byteLength after the
// last read of it) are pending in R_ret until BOTH its WebAssembly.Memory and
// that last ArrayBuffer are collected (two FinalizationRegistry callbacks,
// whose held values are the id only, never the targets).  A failed creation
// that may have allocated adds a debt D_fail = M0 per attempt, which nothing
// clears (no reference to wait for) and which makes the domain uncertified.
// R_ret is pushed to the live instance (sb_set_retired_bytes) on creation and
// on every change; the next instance is created only through
// createInstance's admission: phi (M0 + R_ret + O_host) <= E, with E the
// pushed total / 4 and phi = 21/8, the ledger's own figures.
// ---------------------------------------------------------------------------

const PAGE = 65536, MAX_SAFE = 2 ** 53 - 1;
const PHI_NUM = 21n, PHI_DEN = 8n, SHARE_DEN = 4n, NOMINAL_TOTAL = 2 ** 30;

/** What is pending in R_ret: a retired instance (until both of its
 * finalizers fire) or a failed creation's debt (until the process ends). */
interface Pending {
  bytes: number;
  debt: boolean;
  memoryGone: boolean;
  bufferGone: boolean;
}
const pending = new Map<number, Pending>();
let retiredSum = 0;
// sticky: a failed creation that may have allocated (the debt), or a sum
// that would not be exact; the domain is uncertified from then on
let fault = false, overflow = false;
let nextId = 1, liveId = 0;
/** The creation credit (M0) while a creation is in progress, else 0. */
let creating = 0;
/** Engine calls in progress (creation needs none). */
let inCall = 0;
/** The open host handles of this domain (O_host, by count) and their bytes. */
let oHost = 0, oHostBytes = 0;

/** Add to R_ret, exactly or fail closed (an inexact sum is a fault). */
function addPending(id: number, p: Pending) {
  pending.set(id, p);
  if (retiredSum + p.bytes > MAX_SAFE) overflow = fault = true;
  else retiredSum += p.bytes;
}

// The finalizers (replaced by tests): each target's collection calls
// collected(id, kind).  Without FinalizationRegistry nothing is removed, and
// R_ret only grows: conservative.
type Register = (target: object, id: number, kind: "memory" | "buffer") => void;
function realRegister(): Register | null {
  const FR = (globalThis as any).FinalizationRegistry;
  if (typeof FR !== "function") return null;
  const mem = new FR((id: number) => collected(id, "memory"));
  const buf = new FR((id: number) => collected(id, "buffer"));
  return (target, id, kind) => (kind === "memory" ? mem : buf).register(target, id);
}
// (the one real pair, kept for the process: the test hooks restore it rather
// than building another, so a registry never becomes garbage while it still
// has targets)
const REAL_REGISTER: Register | null = realRegister();
let register: Register | null = REAL_REGISTER;

/** A finalizer fired: the entry goes once both have; repeats, and ids that
 * are a debt or gone, are no-ops. */
function collected(id: number, kind: "memory" | "buffer") {
  const p = pending.get(id);
  if (!p || p.debt) return;
  if (kind === "memory") p.memoryGone = true;
  else p.bufferGone = true;
  if (!(p.memoryGone && p.bufferGone)) return;
  pending.delete(id);
  if (!overflow) retiredSum -= p.bytes;
  pushRetired();
}

/** Push R_ret and the failed-creation fault to the live instance. */
function pushRetired() {
  if (E === null || typeof E.sb_set_retired_bytes !== "function") return;
  // (an inexact sum pushes the largest exact page multiple, faulted)
  const bytes = overflow ? Math.floor(MAX_SAFE / PAGE) * PAGE : retiredSum;
  E.sb_set_retired_bytes(bytes, fault ? 1 : 0);
}

/** Retire the live instance after its last read (the caller has finished
 * every read of it, symCall's error included): freeze D_i, register both
 * finalizers, and drop every root this module holds (E, the frames view and
 * the share cache), so the old instance can be collected even when the
 * next creation is refused. */
function retire(e: Engine) {
  if (E !== e) return;
  const memory = e.memory, buffer = memory.buffer;
  const id = liveId;
  addPending(id, { bytes: buffer.byteLength, debt: false, memoryGone: false, bufferGone: false });
  if (register) {
    register(memory, id, "memory");
    register(buffer, id, "buffer");
  }
  E = null;
  liveId = 0;
  frames = null;
  shareTo = null;
}

/** The module's own initial memory in bytes (M0), or null when it isn't one
 * plain defined memory (none, imported, shared, several, or unreadable). */
export function initialMemory(bytes: Uint8Array): number | null {
  let i = 8;
  const uleb = (): number => {
    let r = 0, s = 0, b: number;
    do {
      if (i >= bytes.length || s > 49) throw new Error("truncated");
      b = bytes[i++];
      r += (b & 0x7f) * 2 ** s;
      s += 7;
    } while (b & 0x80);
    return r;
  };
  try {
    if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) return null;
    let found: number | null = null;
    while (i < bytes.length) {
      const id = bytes[i++], size = uleb(), end = i + size;
      if (end > bytes.length) return null;
      if (id === 2) {
        // (an imported memory is not the module's own)
        for (let n = uleb(), k = 0; k < n; k++) {
          for (let s = 0; s < 2; s++) {
            const len = uleb(); // (read first: uleb moves i)
            i += len;
          }
          const kind = bytes[i++];
          if (kind === 2) return null;
          if (kind === 0) uleb();
          else if (kind === 1) {
            i++;
            const f = uleb();
            uleb();
            if (f & 1) uleb();
          } else if (kind === 3) i += 2;
          else if (kind === 4) {
            i++;
            uleb();
          } else return null;
        }
      } else if (id === 5) {
        if (uleb() !== 1) return null;
        const flags = uleb();
        if (flags & ~1) return null;
        found = uleb() * PAGE;
      }
      i = end;
    }
    return found;
  } catch {
    return null;
  }
}

/** A creation refused by the admission: raised as the memory guards'
 * refusal (lib/_memguard.py), with the retired bytes shown. */
class CreationRefused extends Error {
  constructor(
    /** the scope of the row that refused (C r16b): "instance" or "shared" */
    readonly row: "instance" | "shared",
    readonly need: bigint,
    readonly limit: bigint,
    readonly initial: number,
    readonly retired: number,
    readonly inexact: boolean,
  ) {
    super(
      row === "instance"
        ? `a new engine instance needs ${need} bytes of its own address space, but an instance is allowed ${limit} here`
        : `a new engine instance needs ${need} bytes with what retired instances still hold (${retired}), but the engine is allowed ${limit} here`,
    );
  }
}

// Test hooks (test/engine-retire.test.ts): another module (never the
// production one, so its failed creations are debt), another import object
// (not our frozen one: likewise), a total, and the finalizers.
let testModule: Uint8Array | null = null;
let testImports: object | null = null;
let testTotals: Totals | null = null;

/** The totals for the admission (memoryTotals; the ledger reads the same
 * push the same way). */
function admissionTotals(): Totals {
  return testTotals ?? memoryTotals();
}

/** E for a total as pushed: total / 4 (the nominal total when none). */
function allowanceOf([bytes, status]: [number, number]): bigint {
  const b = status >= 0 && status <= 2 && bytes >= 0 ? BigInt(bytes) : BigInt(NOMINAL_TOTAL);
  return b / SHARE_DEN;
}

/** The creation admission (C r15 section 3.2 with C r16b's scopes): on the
 * instance row phi (M0 + O_host) <= E_inst, retired instances being
 * outside its scope; on the shared row, when one applies, phi (M0 + R_ret
 * + O_host) <= E_shared.  The refusal, or null; an inexact R_ret refuses
 * (fail closed). */
function creationCheck(m0: number, t: Totals): CreationRefused | null {
  const refuse = (row: "instance" | "shared", need: bigint, limit: bigint) =>
    new CreationRefused(row, (PHI_NUM * need + PHI_DEN - 1n) / PHI_DEN, limit, m0, row === "shared" ? retiredSum : 0, overflow);
  if (t.instance) {
    const limit = allowanceOf(t.instance);
    const need = BigInt(m0) + BigInt(oHostBytes);
    if (PHI_NUM * need > PHI_DEN * limit) return refuse("instance", need, limit);
  }
  const shared = sharedOf(t);
  if (shared || overflow) {
    const limit = allowanceOf(shared ?? [-1, -1]);
    const need = BigInt(m0) + BigInt(retiredSum) + BigInt(oHostBytes);
    if (overflow || PHI_NUM * need > PHI_DEN * limit) return refuse("shared", need, limit);
  }
  return null;
}

/** The creation transaction: the only way E gets a new instance. */
function createInstance(): Engine {
  // the genuine outer boundary: no open host handle, no call, no creation
  if (oHost !== 0 || inCall !== 0 || creating !== 0) {
    throw new Error(`internal error: an engine instance must be created at the outer boundary (open host handles ${oHost}, calls ${inCall}, creating ${creating})`);
  }
  const production = testModule === null;
  const bytes = testModule ?? engineBytes();
  const m0 = initialMemory(bytes);
  if (m0 === null) throw new Error("internal error: the engine module's initial memory can't be read");
  // phase 1: compile (no instance memory exists yet: a failure is refunded,
  // there being nothing to refund)
  const module = new WebAssembly.Module(bytes as any);
  // the admission, with the full state
  const totals = admissionTotals();
  const refused = creationCheck(m0, totals);
  if (refused) throw refused;
  const id = nextId++;
  creating = m0;
  try {
    // phase 2: our own import object, frozen plain functions
    const ours = testImports === null;
    const imports = testImports ?? Object.freeze({ sagebrush: Object.freeze({ interrupted }) });
    // phase 3: instantiation
    let exports: Engine;
    try {
      exports = new WebAssembly.Instance(module, imports as any).exports as unknown as Engine;
    } catch (err) {
      // refunded only for the validated production module with our import
      // object (its build check: no start section, segments in bounds, so
      // nothing can fail after its memory exists); anything else may have
      // allocated: a debt for this attempt, never coalesced
      if (!(production && ours)) {
        addPending(id, { bytes: m0, debt: true, memoryGone: false, bufferGone: false });
        fault = true;
      }
      throw err;
    }
    E = exports;
    liveId = id;
  } finally {
    creating = 0;
  }
  const e = E;
  // the totals and R_ret, before anything runs on it
  if (typeof e.sb_set_memory_total === "function") pushTotals(e, totals);
  pushRetired();
  frames = typeof e.sb_progress_ptr === "function" ? frameView(e) : null;
  if (frames) {
    try {
      P.setEngineTables(JSON.parse(rawCall(e, '{"fn":"progress_tables"}')).ok);
    } catch {
      frames = null;
    }
  }
  return e;
}

// The memory share of a default polynomial factorization (item D0,
// plan-d0-capacity-r2 §3): lib/_capacity.py's poly_share, pushed into the
// instance before a dispatch when the observation last pushed to it is
// 250 ms old or more (one clock comparison per call otherwise), so a
// factorization sees the share of its call's entry, and a long call keeps
// it.  The age is the observation's, not the push's: poly_share may hand
// over its own snapshot, up to 250 ms old, and the two caches share the one
// 250 ms budget (CORR-PR122-3).  An instance's
// dispatches are serialized.  The push is optional both ways: an engine
// without sb_set_memory_share is left alone, and a share that can't be had
// is pushed as -1 (none: the factorization keeps its 512 MiB).
let shareTo: Engine | null = null, shareAt = 0;
const SHARE_MAX_AGE_MS = 250, WASM_CEILING = 2 ** 32;
// (the clock, monotonic; replaced by tests)
let shareClock = () => performance.now();
export function setShareClock(f: (() => number) | null) {
  shareClock = f ?? (() => performance.now());
  shareTo = null;
}
export function pushShare(e: Engine) {
  if (typeof e.sb_set_memory_share !== "function") return;
  const now = shareClock();
  if (e === shareTo && now - shareAt < SHARE_MAX_AGE_MS) return;
  shareTo = e;
  shareAt = now;
  const [share, ageMs] = memoryShare();
  shareAt = now - ageMs;
  e.sb_set_memory_share(share);
  // the engine ledger's total (no-cliffs plan C r10 section 1), on the same
  // cadence; an engine without the export is left alone
  if (typeof e.sb_set_memory_total === "function") pushTotals(e, admissionTotals());
}
/** The totals by row extent (no-cliffs C r16b): the instance-local one
 * (one memory's address space: retired instances are outside it), or null;
 * the shared one, or null when no shared row applies (pushed as status 3,
 * absent, never as zero). */
interface Totals {
  instance: [number, number] | null;
  shared: [number, number] | null;
  /** 1 when some applicable row of either extent is joint or unknown
   * (C r17 section 1.3: engine_uncertified), else 0 */
  uncertified: number;
}
/** The shared row in force (C r16b section 3.2, fail closed): none only
 * beside an instance row; with neither, the nominal total (absence is
 * never an empty set of checks). */
function sharedOf(t: Totals): [number, number] | null {
  return t.shared ?? (t.instance ? null : [-1, -1]);
}
/** Push both totals; an engine without sb_set_instance_total (before C
 * r16b) gets the one total of before. */
function pushTotals(e: Engine, t: Totals) {
  if (typeof e.sb_set_instance_total === "function") {
    e.sb_set_instance_total(t.instance ? t.instance[0] : 0, t.instance ? t.instance[1] : 3);
    // (absent: no shared row, only beside an instance row; uncertified
    // still comes with it)
    const shared = sharedOf(t);
    e.sb_set_memory_total!(shared ? shared[0] : 0, shared ? shared[1] : 3, t.uncertified);
  } else {
    const [bytes, status, uncertified] = memoryTotal();
    e.sb_set_memory_total!(bytes, status, uncertified);
  }
}
// (a Map, not a plain object: an inherited name such as "toString" or
// "__proto__" is no status; astra2's LIMIT-C2BII-1 r2 finding)
const TOTAL_STATUS: ReadonlyMap<string, number> = new Map([
  ["observed", 0],
  ["zero", 1],
  ["nominal", 2],
]);
/** A status name's code: only one of the known names, as a string; else
 * undefined (malformed). */
function statusCode(s: unknown): number | undefined {
  return typeof s === "string" ? TOTAL_STATUS.get(s) : undefined;
}
/** lib/_capacity.py engine_total as [bytes, status code, uncertified]: none
 * (status -1, which the engine reads as the nominal total) when it can't
 * be had.  uncertified (no-cliffs plan C r17 section 1.3) is 1 when
 * engine_rows finds an applicable row that is joint (it also bounds a host
 * domain: the instance has no fresh measure of it) or an incomplete
 * classification; engine_total's own joint flag covers only the rows at
 * the least limit, so it is not used for this. */
function memoryTotal(): [number, number, number] {
  try {
    const m = Obj.hooks.importModule("_capacity");
    const t: any = Obj.callObj(Obj.getattr(m, "engine_total"), []);
    const get = (o: any, k: string) => Obj.unbox(Obj.callObj(Obj.getattr(o, "get"), [k]));
    let bytes: any = get(t, "bytes");
    if (typeof bytes === "bigint") bytes = bytes <= 9007199254740991n && bytes >= 0n ? Number(bytes) : -1;
    const status = statusCode(get(t, "status")) ?? -1;
    return [typeof bytes === "number" && Number.isInteger(bytes) && bytes >= 0 ? bytes : -1, status, rowsUncertified(m)];
  } catch (e) {
    // (as memoryShare: a Ctrl-C seen by the collector is set again)
    try {
      if (Obj.typeOf(Obj.toPyExc(e)).$mro.includes(Obj.T.KeyboardInterrupt)) requestCtrlC();
    } catch {}
    return [-1, -1, 0];
  }
}
/** lib/_capacity.py engine_totals (no-cliffs C r16b section 3.1): each
 * extent's least row as [bytes, status code], or null for an extent with
 * no row.  The shape is validated: a dict with both keys, each None or a
 * dict with a valid bytes and status.  The shared one is absent only when
 * it is an explicit None beside a VALID instance record; missing,
 * malformed, or None with no valid instance row, it is the nominal total
 * (as memoryTotal): never "absent" by mistake.  A malformed instance record
 * is no instance row. */
function memoryTotals(): Totals {
  try {
    const m = Obj.hooks.importModule("_capacity");
    const t: any = Obj.callObj(Obj.getattr(m, "engine_totals"), []);
    const isDict = (o: any) => o != null && typeof o === "object" && Obj.isinstance(o, Obj.T.dict);
    const has = (o: any, k: string) => Obj.unbox(Obj.callObj(Obj.getattr(o, "__contains__"), [k])) === true;
    const get = (o: any, k: string) => Obj.unbox(Obj.callObj(Obj.getattr(o, "get"), [k]));
    // a record: null for an explicit None, the tuple when valid, else
    // "malformed" (a missing key is malformed, never None)
    const one = (o: any, k: string): [number, number] | null | "malformed" => {
      if (!has(o, k)) return "malformed";
      const r = get(o, k);
      if (r === null || r === undefined) return null;
      if (!isDict(r) || !has(r, "bytes") || !has(r, "status")) return "malformed";
      let bytes: any = get(r, "bytes");
      if (typeof bytes === "bigint") bytes = bytes <= 9007199254740991n && bytes >= 0n ? Number(bytes) : -1;
      const status = statusCode(get(r, "status"));
      if (status === undefined || typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) return "malformed";
      return [bytes, status];
    };
    if (!isDict(t)) throw new Error("engine_totals: not a dict");
    const i = one(t, "instance");
    const sh = one(t, "shared");
    const instance = Array.isArray(i) ? i : null;
    const shared = Array.isArray(sh) ? sh : sh === null && instance ? null : ([-1, -1] as [number, number]);
    return { instance, shared, uncertified: rowsUncertified(m) };
  } catch (e) {
    try {
      if (Obj.typeOf(Obj.toPyExc(e)).$mro.includes(Obj.T.KeyboardInterrupt)) requestCtrlC();
    } catch {}
    return { instance: null, shared: [-1, -1], uncertified: 0 };
  }
}
/** 0 only when _capacity.engine_uncertified() is exactly False
 * (fail-closed: any other error is 1).  A KeyboardInterrupt is rethrown, so
 * memoryTotal's catch sets the Ctrl-C again, as for the other collectors
 * (astra2's CORR-C2A-3: a Ctrl-C the helper consumed is not lost). */
function rowsUncertified(m: any): number {
  try {
    return Obj.unbox(Obj.callObj(Obj.getattr(m, "engine_uncertified"), [])) === false ? 0 : 1;
  } catch (e) {
    let ki = false;
    try {
      ki = Obj.typeOf(Obj.toPyExc(e)).$mro.includes(Obj.T.KeyboardInterrupt);
    } catch {}
    if (ki) throw e;
    return 1;
  }
}
/** [poly_share() as an integer from 0 to 4 GiB, or -1; the age of its
 * observation in ms, from 0 to 250]. */
function memoryShare(): [number, number] {
  try {
    const m = Obj.hooks.importModule("_capacity");
    // (0 unless poly_share says otherwise: a replacement for it, in a test,
    // has no snapshot)
    Obj.setattr(m, "_poly_age", 0);
    let v: any = Obj.callObj(Obj.getattr(m, "poly_share"), []);
    if (typeof v === "bigint") v = v <= BigInt(WASM_CEILING) && v >= 0n ? Number(v) : -1;
    let age: any = Obj.getattr(m, "_poly_age");
    age = age instanceof Obj.FloatBox ? age.v : Number(Obj.unbox(age));
    const ageMs = Number.isFinite(age) ? Math.min(SHARE_MAX_AGE_MS, Math.max(0, age * 1000)) : SHARE_MAX_AGE_MS;
    return [typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= WASM_CEILING ? v : -1, ageMs];
  } catch (e) {
    // (a Ctrl-C seen by the collector's Python code consumed the flag: set
    // it again, so the call it came before is interrupted, not this push;
    // requestCtrlC also wakes a time.sleep waiting on the word, as every
    // producer of Ctrl-C does: #135)
    try {
      if (Obj.typeOf(Obj.toPyExc(e)).$mro.includes(Obj.T.KeyboardInterrupt)) requestCtrlC();
    } catch {}
    return [-1, 0];
  }
}

/** A view of the engine's frame area (again after its memory grows). */
function frameView(e: Engine): Uint32Array | null {
  const p = e.sb_progress_ptr!();
  return p ? new Uint32Array(e.memory.buffer, p, P.FRAME_WORDS) : null;
}

function rawCall(e: Engine, request: string): string {
  const req = new TextEncoder().encode(request);
  const p = e.sb_alloc(req.length);
  new Uint8Array(e.memory.buffer, p, req.length).set(req);
  const r = e.sb_call(p, req.length);
  e.sb_free(p, req.length);
  return new TextDecoder().decode(new Uint8Array(e.memory.buffer, r, e.sb_reply_len()));
}

/** After an engine call: its progress frames' calls end (all of them, and a
 *  new engine generation, when the call trapped and the instance is gone). */
function callEnded(trapped: boolean) {
  if (trapped) frames = null;
  P.endFrames(trapped);
}

export function engineCall(request: string): string {
  const e = engine();
  pushShare(e);
  // an ASCII request (every engine request so far) is written straight
  // into the engine's memory: no request-sized copy outside it (plan F4
  // r4 §2a: a 1024 x 1024 echelon request is 20 MiB); otherwise as before
  let n = request.length;
  let p = e.sb_alloc(n);
  if (new TextEncoder().encodeInto(request, new Uint8Array(e.memory.buffer, p, n)).read !== n) {
    e.sb_free(p, n);
    const req = new TextEncoder().encode(request);
    n = req.length;
    p = e.sb_alloc(n);
    new Uint8Array(e.memory.buffer, p, n).set(req);
  }
  let r: number;
  inCall++;
  try {
    r = e.sb_call(p, n);
  } catch (err) {
    // a Rust panic (wasm unreachable) leaves the instance unusable
    inCall--;
    retire(e);
    callEnded(true);
    throw err;
  }
  inCall--;
  callEnded(false);
  e.sb_free(p, n);
  return new TextDecoder().decode(new Uint8Array(e.memory.buffer, r, e.sb_reply_len()));
}

/** A symbolic-engine call (engine/sym/src/api.rs).  Errors come back in
 *  band ("err\x1fKind\x1fmessage"), also when they abort the instance. */
export function symCall(request: string): string {
  const e = engine();
  pushShare(e);
  const req = new TextEncoder().encode(request);
  const p = e.sb_alloc(req.length);
  new Uint8Array(e.memory.buffer, p, req.length).set(req);
  let r: number;
  inCall++;
  try {
    r = e.sb_sym_call(p, req.length);
  } catch (err) {
    // an error or an interrupt trapped: read the error (an engine call that
    // may grow the memory: before D_i is frozen), then retire the instance
    let msg = "";
    try {
      const q = e.sb_last_error();
      msg = new TextDecoder().decode(new Uint8Array(e.memory.buffer, q, e.sb_reply_len()));
    } catch {
      // the instance is gone
    }
    inCall--;
    retire(e);
    callEnded(true);
    if (msg) return msg;
    throw err;
  }
  inCall--;
  callEnded(false);
  e.sb_free(p, req.length);
  return new TextDecoder().decode(new Uint8Array(e.memory.buffer, r, e.sb_reply_len()));
}

/** A multivariate polynomial call (engine/mpoly): binary request and reply
 *  (sagebrush_mpoly::call_framed); errors come back in band ("er..."). */
export function mpCall(req: Uint8Array): Uint8Array {
  const e = engine();
  pushShare(e);
  const p = e.sb_alloc(req.length);
  new Uint8Array(e.memory.buffer, p, req.length).set(req);
  let r: number;
  inCall++;
  try {
    r = e.sb_mp_call(p, req.length);
  } catch (err) {
    // an interrupt (or a bug) trapped: retire the instance
    inCall--;
    retire(e);
    callEnded(true);
    throw err;
  }
  inCall--;
  callEnded(false);
  e.sb_free(p, req.length);
  return new Uint8Array(e.memory.buffer, r, e.sb_reply_len()).slice();
}

// A Stop traps the engine, the instance is retired, and a new one is created
// (admitted) on the next call; the old one's memory (tens of MB after an F4
// matrix) is freed only by V8's next major collection, so a run of Stops
// could hold several dead instances at once.  Where the host allows it
// (Node: the CLI, the Jupyter kernel) collect at once: one major collection
// per Stop, none for other errors.  Called from the builtins' catch, not from
// the call's own, whose frame still holds the retired instance.  (A browser
// worker has no such call: there V8 collects under its own pressure.)
function reclaimEngine(): void {
  if (E === null) fullGc();
}

// ---------------------------------------------------------------------------
// Host participants' obligations in the live instance's ledger (no-cliffs C
// r15 section 3.1): engine.ts opens and closes them, so it counts them
// (O_host), and creation requires none.  A handle can't outlive its
// instance: one opened on a retired instance is still counted until its
// holder closes it.  While a creation is in progress, none may be opened.
// ---------------------------------------------------------------------------

/** An open host obligation (hostReserve), closed by hostRelease. */
export interface HostHandle {
  readonly instance: number;
  readonly handle: number;
  bytes: number;
  open: boolean;
}

/** The engine's reply after a refusal (sb_reply_ptr, sb_reply_len). */
function hostReply(e: Engine): string {
  return new TextDecoder().decode(new Uint8Array(e.memory.buffer, e.sb_reply_ptr!(), e.sb_reply_len()));
}

/** Reserve `bytes` for `what` in the live instance's ledger: the handle, or
 * {memory} (the ledger's typed refusal) when it refuses. */
export function hostReserve(what: string, bytes: number): HostHandle | { memory: any } {
  if (creating !== 0) throw new Error("internal error: a host reservation while an engine instance is being created");
  const e = engine();
  if (typeof e.sb_reserve !== "function") throw new Error("internal error: this engine has no host reservations");
  const w = new TextEncoder().encode(what);
  const p = w.length ? e.sb_alloc(w.length) : 0;
  if (w.length) new Uint8Array(e.memory.buffer, p, w.length).set(w);
  const h = e.sb_reserve(p, w.length, bytes);
  if (w.length) e.sb_free(p, w.length);
  if (h > 0) {
    oHost++;
    oHostBytes += bytes;
    return { instance: liveId, handle: h, bytes, open: true };
  }
  const reply = JSON.parse(hostReply(e));
  if (h === 0 && reply.memory) return { memory: reply.memory };
  throw new Error(`internal error: sb_reserve: ${reply.error ?? h}`);
}

/** Grow an open host obligation by `bytes`: null, or {memory} refused. */
export function hostGrow(t: HostHandle, bytes: number): null | { memory: any } {
  if (creating !== 0) throw new Error("internal error: a host reservation while an engine instance is being created");
  if (!t.open || t.instance !== liveId || E === null) throw new Error("internal error: a host handle of a retired engine instance");
  const s = E.sb_grow!(t.handle, bytes);
  if (s === 0) {
    t.bytes += bytes;
    oHostBytes += bytes;
    return null;
  }
  const reply = JSON.parse(hostReply(E));
  if (s === 1 && reply.memory) return { memory: reply.memory };
  throw new Error(`internal error: sb_grow: ${reply.error ?? s}`);
}

/** Close a host obligation (once; on a retired instance only the count). */
export function hostRelease(t: HostHandle): void {
  if (!t.open) return;
  t.open = false;
  oHost--;
  oHostBytes -= t.bytes;
  if (t.instance === liveId && E !== null) E.sb_release!(t.handle);
}

/** The memory guards' refusal for a refused creation (lib/_memguard.py). */
function creationRefusal(err: CreationRefused): any {
  const g = Obj.hooks.importModule("_memguard");
  const mb = (n: number) => `${Math.round(n / 1048576)} MB`;
  const what = err.row === "shared" && err.retired > 0 ? `A new engine instance (with ${mb(err.retired)} still held by retired engine instances)` : "A new engine instance";
  const record = Obj.newDict();
  Obj.dictSet(record, "row", err.row);
  Obj.dictSet(record, "initial", err.initial);
  Obj.dictSet(record, "retired", err.retired);
  if (err.inexact) Obj.dictSet(record, "inexact", true);
  const int = (n: bigint) => (n <= BigInt(MAX_SAFE) ? Number(n) : n);
  return Obj.callObj(Obj.getattr(g, "memory_guard"), [what, int(err.need), int(err.limit), err.row === "instance" ? "one engine instance" : "the engine", record]);
}

/** The builtins' catch: a Ctrl-C, a refused creation, or another error. */
function engineError(err: any): any {
  if (consumeCtrlC()) {
    reclaimEngine();
    return Obj.raise(Obj.T.KeyboardInterrupt);
  }
  if (err instanceof CreationRefused) return Obj.raise(creationRefusal(err));
  return Obj.raise(Obj.T.RuntimeError, `Sagebrush engine: ${err?.message ?? err}`);
}

/** For test/engine-retire.test.ts only. */
export const retireTest = {
  setModule(bytes: Uint8Array | null) {
    testModule = bytes;
  },
  setImports(imports: object | null) {
    testImports = imports;
  },
  /** A shared total alone ([bytes, status, uncertified]; null: the real ones). */
  setTotal(t: [number, number, number] | null) {
    testTotals = t ? { instance: null, shared: [t[0], t[1]], uncertified: t[2] } : null;
  },
  /** Both totals (C r16b). */
  setTotals(t: Totals | null) {
    testTotals = t;
  },
  /** Replace the finalizers (null: the real ones). */
  setRegister(r: Register | null) {
    register = r ?? REAL_REGISTER;
  },
  collected,
  /** A pending debt of `bytes` (the overflow test: sums near 2^53). */
  inject(bytes: number) {
    addPending(nextId++, { bytes, debt: true, memoryGone: false, bufferGone: false });
  },
  /** Retire the live instance as a trap would (after its last read). */
  retire() {
    if (E) retire(E);
  },
  live: () => E,
  /** The totals as memoryTotals parses them (before sharedOf). */
  parsed: () => memoryTotals(),
  state: () => ({
    retired: retiredSum,
    fault,
    overflow,
    creating,
    inCall,
    oHost,
    oHostBytes,
    liveId,
    pending: [...pending].map(([id, p]) => ({ id, ...p })),
    roots: { E: E !== null, frames: frames !== null, shareTo: shareTo !== null },
  }),
  /** Forget all retirement state (between tests). */
  reset() {
    E = null;
    liveId = 0;
    frames = null;
    shareTo = null;
    pending.clear();
    retiredSum = 0;
    fault = overflow = false;
    creating = inCall = oHost = oHostBytes = 0;
    testModule = testImports = testTotals = null;
    register = REAL_REGISTER;
  },
  /** The test-only async creation (r15 section 3.3's pause hook): the same
   * transaction, with WebAssembly.instantiate and a hook awaited while the
   * credit is held. */
  async createAsync(pause: () => Promise<void>): Promise<void> {
    if (oHost !== 0 || inCall !== 0 || creating !== 0 || E !== null) throw new Error("internal error: an engine instance must be created at the outer boundary");
    const bytes = testModule ?? engineBytes();
    const m0 = initialMemory(bytes);
    if (m0 === null) throw new Error("internal error: the engine module's initial memory can't be read");
    const refused = creationCheck(m0, admissionTotals());
    if (refused) throw refused;
    creating = m0;
    try {
      await pause();
      const { instance } = await WebAssembly.instantiate(bytes as any, Object.freeze({ sagebrush: Object.freeze({ interrupted }) }) as any);
      E = instance.exports as unknown as Engine;
      liveId = nextId++;
    } finally {
      creating = 0;
    }
    pushRetired();
  },
};

newBuiltinModule("_sbengine", (m) => {
  m.mp = Obj.builtin((req: any) => {
    try {
      const a = req instanceof Obj.PyBytes ? req.a.subarray(0, req.n) : new TextEncoder().encode(String(req));
      return new Obj.PyBytes(mpCall(a));
    } catch (err: any) {
      return engineError(err);
    }
  }, "mp");
  m.sym = Obj.builtin((req: any) => {
    try {
      return symCall(String(req));
    } catch (err: any) {
      return engineError(err);
    }
  }, "sym");
  m.call = Obj.builtin((req: any) => {
    try {
      return engineCall(String(req));
    } catch (err: any) {
      return engineError(err);
    }
  }, "call");
  // The runtime's parts of the memory capacity (lib/_capacity.py, item D0):
  // (source, limit, used, includes, constrains), bytes, used None when
  // unknown; never guessed in Python, and nothing here calls the engine.
  // The domains (plan-d0-domains-r2): the engine row counts and bounds only
  // the engine instance's own Memory; the JS heap's used_heap_size and
  // usedJSHeapSize count neither ArrayBuffer backing stores nor any wasm
  // Memory, and its limit bounds only the heap.  The engine's instance has at
  // most 4 GiB (wasm32); the JS heap is V8's (or the browser's) limit and
  // use, without a collection.
  m.capacity_parts = Obj.builtin(() => {
    const only = (d: string) => Obj.tuple([d]);
    // (its extent, C r16b: this one instance's address space, the wasm32
    // ceiling of one Memory; a retired instance occupies none of it)
    const parts: any[] = [Obj.tuple(["wasm engine", WASM_CEILING, E ? E.memory.buffer.byteLength : 0, only("wasm-engine"), only("wasm-engine"), "instance"])];
    let used: number | null = null;
    try {
      const p = (globalThis as any).process;
      if (p?.versions?.v8 && !p.versions.bun && !p.versions.deno) used = p.getBuiltinModule?.("node:v8")?.getHeapStatistics?.().used_heap_size ?? null;
      else used = (globalThis as any).performance?.memory?.usedJSHeapSize ?? null;
    } catch {
      used = null;
    }
    parts.push(Obj.tuple(["js heap", heapLimit(), typeof used === "number" && used >= 0 ? Math.floor(used) : null, only("js-heap"), only("js-heap")]));
    return Obj.tuple(parts);
  }, "capacity_parts");
  // The JavaScript engine, for the estimates whose object sizes are its own
  // (./js-engine.ts: decided once, before any user code).
  m.js_engine = Obj.builtin(() => JS_ENGINE, "js_engine");
  m.js_host = Obj.builtin(() => JS_HOST, "js_host");
  // Sage mode gives Python ints Sage's Integer methods ((12).factor()), and
  // builtin types refuse new attributes from Python code (as in CPython).
  m.extend_type = Obj.builtin((cls: any, name: any, value: any) => {
    cls.$dict.set(String(name), value);
    return null;
  }, "extend_type");
});
