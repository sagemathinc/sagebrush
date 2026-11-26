import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The decision-tree kernel's shipped module, wasm/sagebrush-skltree.wasm (engine/skltree; the design note
// sklearn-trees r3, ENGINE's E3), read instruction by instruction: no SIMD (no v128 type or 0xFD opcode, relaxed
// SIMD included: its fused multiply-adds would change bits), no threads (no 0xFE atomics, no shared memory), exactly
// one memory, exported and not imported, and no start function, so that it instantiates on any page and computes
// the same bits on every host.  The decoder knows the MVP, sign extension, saturating truncation, bulk memory,
// reference types and multi-value, and fails on anything else: an opcode it doesn't know is never passed over.
// Planted modules check that each refusal fires.

const root = join(__dirname, "..", "..");

class Reader {
  constructor(readonly b: Uint8Array, readonly end = b.length, public i = 0) {}
  byte(): number {
    if (this.i >= this.end) throw new Error("truncated");
    return this.b[this.i++];
  }
  u32(): number {
    let r = 0, s = 0, x: number;
    do {
      x = this.byte();
      r += (x & 0x7f) * 2 ** s;
      s += 7;
      if (s > 35) throw new Error("bad LEB128");
    } while (x & 0x80);
    return r;
  }
  // a signed LEB128 of up to 64 bits (only its length matters here)
  sleb(): void {
    let s = 0, x: number;
    do {
      x = this.byte();
      s += 7;
      if (s > 70) throw new Error("bad LEB128");
    } while (x & 0x80);
  }
  skip(n: number) {
    if (this.i + n > this.end) throw new Error("truncated");
    this.i += n;
  }
}

const VALTYPES = new Set([0x7f, 0x7e, 0x7d, 0x7c, 0x70, 0x6f]);
function valtype(t: number, where: string) {
  if (t === 0x7b) throw new Error(`v128 in ${where}`);
  if (!VALTYPES.has(t)) throw new Error(`value type 0x${t.toString(16)} in ${where}`);
}

function blocktype(r: Reader) {
  const t = r.b[r.i];
  if (t === 0x40) return void r.i++;
  if (t === 0x7b || VALTYPES.has(t)) return valtype(r.byte(), "a block type");
  r.sleb(); // (a type index)
}

function memarg(r: Reader) {
  const align = r.u32();
  if (align & 0x40) r.u32(); // (a memory index: multi-memory)
  r.u32();
}

/** Every instruction of one function body; throws on SIMD, atomics or an unknown opcode. */
function body(r: Reader, fn: number) {
  for (let n = r.u32(); n > 0; n--) {
    r.u32();
    valtype(r.byte(), `function ${fn}'s locals`);
  }
  while (r.i < r.end) {
    const op = r.byte();
    if (op === 0xfd) throw new Error(`a SIMD instruction in function ${fn}`);
    if (op === 0xfe) throw new Error(`an atomic instruction in function ${fn}`);
    if (op <= 0x01 || op === 0x05 || op === 0x0b || op === 0x0f || op === 0x1a || op === 0x1b || op === 0xd1 || (op >= 0x45 && op <= 0xc4)) continue;
    if (op >= 0x02 && op <= 0x04) blocktype(r);
    else if (op === 0x0c || op === 0x0d || op === 0x10 || op === 0xd2 || (op >= 0x20 && op <= 0x26)) r.u32();
    else if (op === 0x0e) {
      for (let k = r.u32(); k >= 0; k--) r.u32(); // (the labels and the default)
    } else if (op === 0x11) (r.u32(), r.u32());
    else if (op === 0x1c) for (let k = r.u32(); k > 0; k--) valtype(r.byte(), `function ${fn}'s select`);
    else if (op >= 0x28 && op <= 0x3e) memarg(r);
    else if (op === 0x3f || op === 0x40) r.byte();
    else if (op === 0x41 || op === 0x42) r.sleb();
    else if (op === 0x43) r.skip(4);
    else if (op === 0x44) r.skip(8);
    else if (op === 0xd0) r.byte();
    else if (op === 0xfc) {
      const sub = r.u32();
      if (sub <= 7) continue;
      if (sub === 8) (r.u32(), r.byte());
      else if (sub === 9 || sub === 13 || (sub >= 15 && sub <= 17)) r.u32();
      else if (sub === 10 || sub === 12 || sub === 14) (r.u32(), r.u32());
      else if (sub === 11) r.byte();
      else throw new Error(`opcode 0xfc ${sub} in function ${fn}`);
    } else throw new Error(`opcode 0x${op.toString(16)} in function ${fn}`);
  }
}

interface Scan {
  functions: number;
  imports: string[];
  memoryExports: number;
}

/** The module's sections, checked: see the header.  Throws with the reason. */
export function scan(b: Uint8Array): Scan {
  const r = new Reader(b);
  if (r.b.length < 8 || r.b[0] !== 0 || r.b[1] !== 0x61 || r.b[2] !== 0x73 || r.b[3] !== 0x6d) throw new Error("not a wasm module");
  r.i = 8;
  const out: Scan = { functions: 0, imports: [], memoryExports: 0 };
  let memories = 0;
  const name = (s: Reader) => {
    const n = s.u32();
    s.skip(n);
    return new TextDecoder().decode(s.b.subarray(s.i - n, s.i));
  };
  const limits = (s: Reader, what: string) => {
    const flags = s.byte();
    if (flags & 2) throw new Error(`a shared ${what}`);
    if (flags & ~1) throw new Error(`${what} limits 0x${flags.toString(16)}`);
    s.u32();
    if (flags & 1) s.u32();
  };
  while (r.i < r.b.length) {
    const id = r.byte(), size = r.u32(), end = r.i + size;
    if (end > r.b.length) throw new Error("truncated section");
    const s = new Reader(r.b, end, r.i);
    if (id === 8) throw new Error("a start function");
    if (id === 1) {
      for (let n = s.u32(); n > 0; n--) {
        if (s.byte() !== 0x60) throw new Error("a type that isn't a function type");
        for (let k = 0; k < 2; k++) for (let m = s.u32(); m > 0; m--) valtype(s.byte(), "a function type");
      }
    } else if (id === 2) {
      for (let n = s.u32(); n > 0; n--) {
        const where = `${name(s)}.${name(s)}`;
        out.imports.push(where);
        const kind = s.byte();
        if (kind === 0) s.u32();
        else if (kind === 2) throw new Error(`an imported memory (${where})`);
        else if (kind === 1) (s.byte(), limits(s, "table"));
        else if (kind === 3) (valtype(s.byte(), "an imported global"), s.byte());
        else throw new Error(`import kind ${kind}`);
      }
    } else if (id === 5) {
      for (let n = s.u32(); n > 0; n--, memories++) limits(s, "memory");
    } else if (id === 6) {
      for (let n = s.u32(); n > 0; n--) {
        valtype(s.byte(), "a global");
        s.byte();
        // (its constant expression: up to its end)
        while (s.byte() !== 0x0b);
      }
    } else if (id === 7) {
      for (let n = s.u32(); n > 0; n--) {
        name(s);
        const kind = s.byte();
        s.u32();
        if (kind === 2) out.memoryExports++;
      }
    } else if (id === 10) {
      for (let n = s.u32(), fn = 0; fn < n; fn++) {
        const len = s.u32();
        body(new Reader(s.b, s.i + len, s.i), fn);
        s.skip(len);
        out.functions++;
      }
    }
    r.i = end;
  }
  if (memories !== 1) throw new Error(`${memories} memories`);
  if (out.memoryExports !== 1) throw new Error(`${out.memoryExports} memory exports`);
  return out;
}

// A minimal module: one function type () -> (), one function with `code`, one memory, the memory exported.
function planted(code: number[], extra: { start?: boolean; sharedMemory?: boolean; v128Local?: boolean } = {}): Uint8Array {
  const sec = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];
  const locals = extra.v128Local ? [1, 1, 0x7b] : [0];
  const fbody = [...locals, ...code, 0x0b];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...sec(1, [1, 0x60, 0, 0]),
    ...sec(3, [1, 0]),
    ...sec(5, extra.sharedMemory ? [1, 3, 1, 1] : [1, 0, 1]),
    ...sec(7, [1, 1, 0x6d, 2, 0]),
    ...(extra.start ? sec(8, [0]) : []),
    ...sec(10, [1, fbody.length, ...fbody]),
  ]);
}

test("the scanner reads a plain module and refuses each planted SIMD, atomic, shared-memory and start-function module", () => {
  // (i32.const 1; f64.const 0; drop; drop; memory.size; drop; a bulk memory.fill on 0, 0, 0)
  const ok = planted([0x41, 0x01, 0x44, 0, 0, 0, 0, 0, 0, 0, 0, 0x1a, 0x1a, 0x3f, 0x00, 0x1a, 0x41, 0, 0x41, 0, 0x41, 0, 0xfc, 11, 0x00]);
  new WebAssembly.Module(ok as any);
  assert.equal(scan(ok).functions, 1);
  // v128.const 0 (16 bytes); drop
  assert.throws(() => scan(planted([0xfd, 0x0c, ...new Array(16).fill(0), 0x1a])), /SIMD/);
  // relaxed SIMD's f32x4.relaxed_madd lives under the same prefix
  assert.throws(() => scan(planted([0xfd, 0x85, 0x02])), /SIMD/);
  // atomic.fence
  assert.throws(() => scan(planted([0xfe, 0x03, 0x00])), /atomic/);
  assert.throws(() => scan(planted([], { v128Local: true })), /v128/);
  assert.throws(() => scan(planted([], { sharedMemory: true })), /shared/);
  assert.throws(() => scan(planted([], { start: true })), /start/);
  // an opcode outside the known proposals (a tail call) is refused, not passed over
  assert.throws(() => scan(planted([0x12, 0x00])), /opcode 0x12/);
});

test("the shipped kernel has no SIMD, no atomics, no shared memory, one exported memory and no start function", () => {
  const bytes = new Uint8Array(readFileSync(join(root, "wasm", "sagebrush-skltree.wasm")));
  const s = scan(bytes);
  assert.ok(s.functions > 10, `${s.functions} functions`);
  // its one import: Stop's flag (engine/interrupt's wasm-host)
  assert.deepEqual(s.imports, ["sagebrush.interrupted"]);
  // and it instantiates with only that import
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes as any), { sagebrush: { interrupted: () => 0 } });
  assert.ok(inst.exports.memory instanceof WebAssembly.Memory);
});
