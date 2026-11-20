// Sagebrush's PNG module (engine/raster: plots' SVG drawn with tiny-skia,
// PNG files read with limits) as the builtin module `_sbraster`:
//   render(svg, scale, width, height, background (CSS), dpi, text) -> (png bytes,
//          characters the font lacks); width x height pixels, 0 x 0 for the drawing's size
//   decode(png bytes) -> (width, height, channels, float32 bytes)
// The WebAssembly module (wasm/sagebrush-raster.wasm, about 750 KB) is
// compiled the first time a PNG is written or read, from wherever the host
// keeps it (src/runtime/wasm-asset.ts, key RASTER).

import { assetBytes } from "./wasm-asset";
import * as Obj from "./object";
import { newBuiltinModule } from "./modules";
import * as O from "./ops";

interface Raster {
  memory: WebAssembly.Memory;
  rs_alloc(len: number): number;
  rs_free(ptr: number, len: number): void;
  rs_render(svg: number, svgLen: number, scale: number, width: number, height: number, background: number, backgroundLen: number, dpi: number, text: number, textLen: number): number;
  rs_decode(png: number, len: number): number;
  rs_reply_ptr(): number;
  rs_reply_len(): number;
  // the heap's page bound (engine/raster/src/wasm.rs)
  rs_begin(pages: number): void;
  rs_last_refusal(): number;
  rs_heap_base(): number;
}

let R: Raster | null = null;

// (exported for test/png.test.ts)
export function rasterBytes(): Uint8Array {
  return assetBytes("RASTER", "sagebrush-raster.wasm", "PNG module");
}

function raster(): Raster {
  if (R === null) R = new WebAssembly.Instance(new WebAssembly.Module(rasterBytes() as any), {}).exports as unknown as Raster;
  return R;
}

/** Runs f on the instance's view of the inputs; returns the reply, or throws
 *  the call's outcome (engine/raster/src/lib.rs's codes): RasterError (1,
 *  the input refused), RasterMemoryError (2, an allocation refused, or a
 *  trap with a refused growth recorded) or Error (3, the engine failing).
 *  A trap (a Rust panic) drops the instance. */
function call(inputs: Uint8Array[], f: (r: Raster, ptrs: number[]) => number): Uint8Array {
  const r = raster();
  const ptrs = inputs.map((a) => {
    const p = r.rs_alloc(a.length);
    new Uint8Array(r.memory.buffer, p, a.length).set(a);
    return p;
  });
  let code: number;
  try {
    code = f(r, ptrs);
  } catch (err) {
    R = null;
    // (an allocation that could not fail cleanly traps; the page bound
    // recorded what it refused, readable from the trapped instance)
    const refused = lastRefusal(r);
    if (refused !== null) throw new RasterMemoryError(refused.need, "the PNG engine's working memory");
    throw err;
  }
  inputs.forEach((a, i) => r.rs_free(ptrs[i], a.length));
  const out = new Uint8Array(r.memory.buffer, r.rs_reply_ptr(), r.rs_reply_len()).slice();
  if (code === 0) return out;
  if (code === 2) {
    const v = new DataView(out.buffer, out.byteOffset);
    throw new RasterMemoryError(Number(v.getBigUint64(0, true)), new TextDecoder().decode(out.subarray(8)));
  }
  const message = new TextDecoder().decode(out);
  if (code === 1) throw new RasterError(message);
  throw new Error(message);
}

/** The growth the page bound refused in this call: the bytes asked for, or
 *  null (none, or a module that can't say). */
function lastRefusal(r: Raster): { need: number } | null {
  try {
    const p = r.rs_last_refusal();
    const need = new DataView(r.memory.buffer, p, 12).getUint32(0, true);
    return need === 0 ? null : { need: need * 65536 };
  } catch {
    return null;
  }
}

class RasterError extends Error {}
class RasterMemoryError extends Error {
  constructor(public bytes: number, public what: string) {
    super(`${what} needs ${bytes} bytes, which the PNG engine could not allocate`);
  }
}

// a Python int or float as a JS number (1.0 is boxed, to stay a float)
function num(v: any): number {
  if (v instanceof Obj.FloatBox) return v.v;
  const u = Obj.unbox(v);
  return typeof u === "bigint" ? Number(u) : Number(u);
}

function bytesOf(x: any): Uint8Array {
  if (x instanceof Obj.PyBytes) return x.a.subarray(0, x.n);
  return Obj.raise(Obj.T.TypeError, `a bytes object is required, not '${Obj.typeName(x)}'`);
}

// A refusal (a limit, an unsupported drawing, a file that is not a PNG) is a
// ValueError; anything else is the module failing.
function failed(err: any): never {
  if (err instanceof RasterError) return Obj.raise(Obj.T.ValueError, err.message);
  if (err instanceof RasterMemoryError) return Obj.raise(Obj.T.MemoryError, err.message);
  return Obj.raise(Obj.T.RuntimeError, `Sagebrush's PNG module: ${err?.message ?? err}`);
}

newBuiltinModule("_sbraster", (m) => {
  // background: a CSS color ("" for none); text: [(key, value)]
  m.render = Obj.builtin((svg: any, scale: any, width: any, height: any, background: any, dpi: any, text: any) => {
    const enc = new TextEncoder();
    const s = enc.encode(String(svg));
    // (each key and value as UTF-8 after its length, u32 little-endian: any
    // character may be in them)
    const parts: Uint8Array[] = [];
    for (const kv of O.toArray(text)) {
      for (const x of O.toArray(kv)) {
        const b = enc.encode(String(x));
        const n = new Uint8Array(4);
        new DataView(n.buffer).setUint32(0, b.length, true);
        parts.push(n, b);
      }
    }
    const t = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    parts.reduce((at, p) => (t.set(p, at), at + p.length), 0);
    const bg = enc.encode(background === null ? "" : String(background));
    let out: Uint8Array;
    try {
      out = call([s, t, bg], (r, [ps, pt, pb]) => r.rs_render(ps, s.length, num(scale), num(width) >>> 0, num(height) >>> 0, pb, bg.length, num(dpi), pt, t.length));
    } catch (err) {
      return failed(err);
    }
    // (the WebAssembly cannot see a Stop while it draws: one that came during
    // it is taken here, a KeyboardInterrupt from the call, not at some later
    // loop; outside the try, so it is not the module failing)
    O.pollInterrupt();
    const n = new DataView(out.buffer, out.byteOffset).getUint32(0, true);
    return Obj.tuple([new Obj.PyBytes(out.slice(4, 4 + n)), new TextDecoder().decode(out.subarray(4 + n))]);
  }, "render");
  // whether the module has been compiled (it is, the first time a PNG is
  // written or read)
  m.loaded = Obj.builtin(() => R !== null, "loaded");
  // the module's linear memory in bytes (0 before it is compiled): it only
  // grows, so a test can tell, without a clock, that a drawing was refused
  // before its rasters were allocated (test/png.test.ts, HARD-6BC-1)
  m.memory_bytes = Obj.builtin(() => (R === null ? 0 : R.memory.buffer.byteLength), "memory_bytes");
  m.decode = Obj.builtin((png: any) => {
    const a = bytesOf(png);
    let out: Uint8Array;
    try {
      out = call([a], (r, [p]) => r.rs_decode(p, a.length));
    } catch (err) {
      return failed(err);
    }
    O.pollInterrupt(); // (as render's)
    const v = new DataView(out.buffer, out.byteOffset);
    return Obj.tuple([v.getUint32(0, true), v.getUint32(4, true), v.getUint32(8, true), new Obj.PyBytes(out.slice(12))]);
  }, "decode");
});
