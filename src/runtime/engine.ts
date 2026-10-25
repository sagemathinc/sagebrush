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
import { INTR, INTR_CTRL_C, consumeCtrlC } from "./interrupt";
import { fullGc } from "./gc";

interface Engine {
  memory: WebAssembly.Memory;
  sb_alloc(len: number): number;
  sb_free(ptr: number, len: number): void;
  sb_call(ptr: number, len: number): number;
  sb_sym_call(ptr: number, len: number): number;
  sb_mp_call(ptr: number, len: number): number;
  sb_last_error(): number;
  sb_reply_len(): number;
  // (optional: engines built before item D0 lack it)
  sb_set_memory_share?(v: number): void;
}

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

function engine(): Engine {
  // sagebrush.interrupted: Ctrl-C, polled by the engine's long loops
  // (engine/interrupt); an interrupted call traps and the instance is dropped.
  const imports = { sagebrush: { interrupted: () => INTR[0] & INTR_CTRL_C } };
  if (E === null) E = new WebAssembly.Instance(new WebAssembly.Module(engineBytes() as any), imports).exports as unknown as Engine;
  return E;
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
    // it again, so the call it came before is interrupted, not this push)
    try {
      if (Obj.typeOf(Obj.toPyExc(e)).$mro.includes(Obj.T.KeyboardInterrupt)) Atomics.or(INTR, 0, 1);
    } catch {}
    return [-1, 0];
  }
}

export function engineCall(request: string): string {
  const e = engine();
  pushShare(e);
  const req = new TextEncoder().encode(request);
  const p = e.sb_alloc(req.length);
  new Uint8Array(e.memory.buffer, p, req.length).set(req);
  let r: number;
  try {
    r = e.sb_call(p, req.length);
  } catch (err) {
    // a Rust panic (wasm unreachable) leaves the instance unusable
    E = null;
    throw err;
  } finally {
    if (E) e.sb_free(p, req.length);
  }
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
  try {
    r = e.sb_sym_call(p, req.length);
  } catch (err) {
    // an error or an interrupt trapped: read the error, then start afresh
    let msg = "";
    try {
      const q = e.sb_last_error();
      msg = new TextDecoder().decode(new Uint8Array(e.memory.buffer, q, e.sb_reply_len()));
    } catch {
      // the instance is gone
    }
    E = null;
    if (msg) return msg;
    throw err;
  }
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
  try {
    r = e.sb_mp_call(p, req.length);
  } catch (err) {
    // an interrupt (or a bug) trapped: start afresh
    E = null;
    throw err;
  }
  e.sb_free(p, req.length);
  return new Uint8Array(e.memory.buffer, r, e.sb_reply_len()).slice();
}

// A Stop traps the engine, the instance is dropped (E = null), and a new one
// is made on the next call; the old one's memory (tens of MB after an F4
// matrix) is freed only by V8's next major collection, so a run of Stops
// could hold several dead instances at once.  Where the host allows it
// (Node: the CLI, the Jupyter kernel) collect at once: one major collection
// per Stop, none for other errors.  Called from the builtins' catch, not from
// the call's own, whose frame still holds the dropped instance.  (A browser
// worker has no such call: there V8 collects under its own pressure.)
function reclaimEngine(): void {
  if (E === null) fullGc();
}

newBuiltinModule("_sbengine", (m) => {
  m.mp = Obj.builtin((req: any) => {
    try {
      const a = req instanceof Obj.PyBytes ? req.a.subarray(0, req.n) : new TextEncoder().encode(String(req));
      return new Obj.PyBytes(mpCall(a));
    } catch (err: any) {
      if (consumeCtrlC()) {
        reclaimEngine();
        return Obj.raise(Obj.T.KeyboardInterrupt);
      }
      return Obj.raise(Obj.T.RuntimeError, `Sagebrush engine: ${err?.message ?? err}`);
    }
  }, "mp");
  m.sym = Obj.builtin((req: any) => {
    try {
      return symCall(String(req));
    } catch (err: any) {
      if (consumeCtrlC()) {
        reclaimEngine();
        return Obj.raise(Obj.T.KeyboardInterrupt);
      }
      return Obj.raise(Obj.T.RuntimeError, `Sagebrush engine: ${err?.message ?? err}`);
    }
  }, "sym");
  m.call = Obj.builtin((req: any) => {
    try {
      return engineCall(String(req));
    } catch (err: any) {
      if (consumeCtrlC()) {
        reclaimEngine();
        return Obj.raise(Obj.T.KeyboardInterrupt);
      }
      return Obj.raise(Obj.T.RuntimeError, `Sagebrush engine: ${err?.message ?? err}`);
    }
  }, "call");
  // The runtime's parts of the memory capacity (lib/_capacity.py, item D0):
  // (source, limit, used) in bytes, used None when unknown; never guessed in
  // Python, and nothing here calls the engine.  The engine's instance has at
  // most 4 GiB (wasm32); the JS heap is V8's (or the browser's) limit and
  // use, without a collection.
  m.capacity_parts = Obj.builtin(() => {
    const parts: any[] = [Obj.tuple(["wasm engine", WASM_CEILING, E ? E.memory.buffer.byteLength : 0])];
    let used: number | null = null;
    try {
      const p = (globalThis as any).process;
      if (p?.versions?.v8 && !p.versions.bun && !p.versions.deno) used = p.getBuiltinModule?.("node:v8")?.getHeapStatistics?.().used_heap_size ?? null;
      else used = (globalThis as any).performance?.memory?.usedJSHeapSize ?? null;
    } catch {
      used = null;
    }
    parts.push(Obj.tuple(["js heap", heapLimit(), typeof used === "number" && used >= 0 ? Math.floor(used) : null]));
    return Obj.tuple(parts);
  }, "capacity_parts");
  // Sage mode gives Python ints Sage's Integer methods ((12).factor()), and
  // builtin types refuse new attributes from Python code (as in CPython).
  m.extend_type = Obj.builtin((cls: any, name: any, value: any) => {
    cls.$dict.set(String(name), value);
    return null;
  }, "extend_type");
});
