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
import { newBuiltinModule } from "./modules";
import { INTR } from "./interrupt";
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
  const imports = { sagebrush: { interrupted: () => INTR[0] } };
  if (E === null) E = new WebAssembly.Instance(new WebAssembly.Module(engineBytes() as any), imports).exports as unknown as Engine;
  return E;
}

export function engineCall(request: string): string {
  const e = engine();
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
      if (INTR[0]) {
        INTR[0] = 0;
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
      if (INTR[0]) {
        INTR[0] = 0;
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
      if (INTR[0]) {
        INTR[0] = 0;
        reclaimEngine();
        return Obj.raise(Obj.T.KeyboardInterrupt);
      }
      return Obj.raise(Obj.T.RuntimeError, `Sagebrush engine: ${err?.message ?? err}`);
    }
  }, "call");
  // Sage mode gives Python ints Sage's Integer methods ((12).factor()), and
  // builtin types refuse new attributes from Python code (as in CPython).
  m.extend_type = Obj.builtin((cls: any, name: any, value: any) => {
    cls.$dict.set(String(name), value);
    return null;
  }, "extend_type");
});
