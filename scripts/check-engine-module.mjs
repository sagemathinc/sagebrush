#!/usr/bin/env node
// The engine module's build check (no-cliffs C r16 section 3.2): after the
// instance's memories are created, instantiation can fail only by an
// out-of-bounds active data or element segment or a trap in the start
// function.  This asserts the built module has neither (no start section;
// every active segment within the declared initial memory and table), so a
// failed instantiation of OUR module never leaves engine memory behind
// (C r17 section 2.2's phase-3 refund rests on it).  Fail closed: anything
// it can't read (an imported memory or table, a non-constant segment
// offset, a malformed section) is a failure.
//
//   node scripts/check-engine-module.mjs [wasm/sagebrush-engine.wasm]
//   node scripts/check-engine-module.mjs --self-test
import { readFileSync } from "node:fs";

const PAGE = 65536;

/** The problems of a module (bytes), or [] when it passes. */
export function checkModule(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const problems = [];
  let i = 0;
  const fail = (m) => {
    throw new Error(`${m} at byte ${i}`);
  };
  const byte = () => (i < b.length ? b[i++] : fail("truncated"));
  const uleb = () => {
    let r = 0n, shift = 0n, x;
    do {
      x = byte();
      r |= BigInt(x & 0x7f) << shift;
      shift += 7n;
      if (shift > 70n) fail("an overlong LEB128");
    } while (x & 0x80);
    return r;
  };
  const sleb = () => {
    let r = 0n, shift = 0n, x;
    do {
      x = byte();
      r |= BigInt(x & 0x7f) << shift;
      shift += 7n;
      if (shift > 70n) fail("an overlong LEB128");
    } while (x & 0x80);
    if (x & 0x40) r -= 1n << shift;
    return r;
  };
  const limits = () => {
    const flag = Number(uleb());
    if (flag & ~0x07) fail(`unknown limits flag ${flag}`);
    const min = uleb();
    if (flag & 1) uleb();
    return { min, shared: (flag & 2) !== 0, wide: (flag & 4) !== 0 };
  };
  // a constant offset expression (i32/i64.const N; end), or a failure
  const constOffset = (what) => {
    const op = byte();
    if (op !== 0x41 && op !== 0x42) fail(`${what}: a non-constant offset (opcode 0x${op.toString(16)})`);
    const v = sleb();
    if (byte() !== 0x0b) fail(`${what}: a non-constant offset expression`);
    if (v < 0n) fail(`${what}: a negative offset`);
    return v;
  };
  // skip a constant element expression (ref.func i; ref.null t; end)
  const skipExpr = () => {
    for (;;) {
      const op = byte();
      if (op === 0x0b) return;
      if (op === 0xd2) uleb();
      else if (op === 0xd0) byte();
      else if (op === 0x23 || op === 0x41) sleb();
      else fail(`an element expression opcode 0x${op.toString(16)}`);
    }
  };
  try {
    if (b.length < 8 || b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) fail("not a WebAssembly module");
    i = 8;
    let memMin = null, tableMin = null, importedMem = false, importedTable = false;
    const data = [], elems = [];
    while (i < b.length) {
      const id = byte();
      const size = Number(uleb());
      const end = i + size;
      if (end > b.length) fail(`section ${id} runs past the end`);
      if (id === 2) {
        const n = Number(uleb());
        for (let k = 0; k < n; k++) {
          for (let s = 0; s < 2; s++) {
            const len = Number(uleb()); // (module, name: read the length first, then skip)
            i += len;
          }
          const kind = byte();
          if (kind === 0) uleb();
          else if (kind === 1) {
            byte();
            limits();
            importedTable = true;
          } else if (kind === 2) {
            limits();
            importedMem = true;
          } else if (kind === 3) {
            byte();
            byte();
          } else if (kind === 4) {
            byte();
            uleb();
          } else fail(`import kind ${kind}`);
        }
      } else if (id === 4) {
        const n = Number(uleb());
        for (let k = 0; k < n; k++) {
          byte();
          const l = limits();
          if (k === 0) tableMin = l.min;
        }
      } else if (id === 5) {
        const n = Number(uleb());
        for (let k = 0; k < n; k++) {
          const l = limits();
          if (k === 0) memMin = l.min;
          if (l.shared) problems.push("a shared memory");
        }
        if (n > 1) problems.push("more than one memory");
      } else if (id === 8) {
        problems.push("a start section (a trap there would fail instantiation after the memory exists)");
      } else if (id === 9) {
        const n = Number(uleb());
        for (let k = 0; k < n; k++) {
          const flag = Number(uleb());
          if (flag > 7) fail(`element segment flag ${flag}`);
          const passive = flag & 1, explicit = flag & 2, exprs = flag & 4;
          let table = 0n, offset = null;
          if (!passive) {
            if (explicit) table = uleb();
            offset = constOffset(`element segment ${k}`);
            if (explicit) byte(); // elemkind or reftype
          } else byte();
          const count = uleb();
          for (let e = 0n; e < count; e++) exprs ? skipExpr() : uleb();
          if (!passive) elems.push({ k, table, offset, count });
        }
      } else if (id === 11) {
        const n = Number(uleb());
        for (let k = 0; k < n; k++) {
          const flag = Number(uleb());
          let mem = 0n, offset = null;
          if (flag === 0) offset = constOffset(`data segment ${k}`);
          else if (flag === 2) {
            mem = uleb();
            offset = constOffset(`data segment ${k}`);
          } else if (flag !== 1) fail(`data segment flag ${flag}`);
          const len = uleb();
          i += Number(len);
          if (offset !== null) data.push({ k, mem, offset, len });
        }
      }
      i = end;
    }
    if (importedMem) problems.push("an imported memory (not the production layout)");
    if (importedTable) problems.push("an imported table (not the production layout)");
    for (const d of data) {
      if (d.mem !== 0n) problems.push(`data segment ${d.k}: memory ${d.mem}`);
      else if (memMin === null) problems.push(`data segment ${d.k}: no memory is declared`);
      else if (d.offset + d.len > memMin * BigInt(PAGE)) problems.push(`data segment ${d.k}: [${d.offset}, ${d.offset + d.len}) is beyond the initial memory of ${memMin * BigInt(PAGE)} bytes`);
    }
    for (const e of elems) {
      if (e.table !== 0n) problems.push(`element segment ${e.k}: table ${e.table}`);
      else if (tableMin === null) problems.push(`element segment ${e.k}: no table is declared`);
      else if (e.offset + e.count > tableMin) problems.push(`element segment ${e.k}: [${e.offset}, ${e.offset + e.count}) is beyond the initial table of ${tableMin} entries`);
    }
  } catch (err) {
    problems.push(`unreadable: ${err.message}`);
  }
  return problems;
}

// ---- self-test fixtures (hand-assembled modules)

const leb = (n) => {
  const out = [];
  do {
    let x = n & 0x7f;
    n >>>= 7;
    if (n) x |= 0x80;
    out.push(x);
  } while (n);
  return out;
};
const sec = (id, body) => [id, ...leb(body.length), ...body];
const vec = (items) => [...leb(items.length), ...items.flat()];
const i32c = (v) => [0x41, ...sleb32(v), 0x0b];
function sleb32(v) {
  const out = [];
  for (;;) {
    const x = v & 0x7f;
    v >>= 7;
    if ((v === 0 && !(x & 0x40)) || (v === -1 && x & 0x40)) {
      out.push(x);
      return out;
    }
    out.push(x | 0x80);
  }
}
const header = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
const types = sec(1, vec([[0x60, 0, 0]])); // () -> ()
const funcs = sec(3, vec([[0]]));
const code = sec(10, vec([[...leb(2), 0, 0x0b]]));
const memory = (pages) => sec(5, vec([[0, ...leb(pages)]]));
const table = (n) => sec(4, vec([[0x70, 0, ...leb(n)]]));
const dataSeg = (offset, len) => sec(11, vec([[0, ...i32c(offset), ...leb(len), ...new Array(len).fill(7)]]));
const elemSeg = (offset, n) => sec(9, vec([[0, ...i32c(offset), ...leb(n), ...new Array(n).fill(0)]]));
const mod = (...sections) => new Uint8Array([...header, ...sections.flat()]);

function selfTest() {
  const cases = [
    ["in bounds", mod(types, funcs, table(2), memory(1), elemSeg(0, 2), code, dataSeg(PAGE - 10, 10)), true],
    ["a data segment one byte past the memory", mod(types, funcs, memory(1), code, dataSeg(PAGE - 10, 11)), false],
    ["an element segment past the table", mod(types, funcs, table(1), elemSeg(0, 2), code), false],
    ["a start section", mod(types, funcs, memory(1), sec(8, leb(0)), code), false],
    ["an imported memory", mod(types, sec(2, vec([[...leb(1), 0x65, ...leb(1), 0x6d, 2, 0, 1]])), funcs, code), false],
    ["a non-constant offset", mod(types, funcs, memory(1), code, sec(11, vec([[0, 0x23, 0, 0x0b, 1, 7]]))), false],
    ["truncated", mod(types, funcs, memory(1)).slice(0, 20), false],
  ];
  let bad = 0;
  for (const [name, bytes, pass] of cases) {
    const p = checkModule(bytes);
    const ok = (p.length === 0) === pass;
    if (pass && ok) new WebAssembly.Module(bytes); // (the passing fixture is a valid module)
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${p.length ? p.join("; ") : "passes"}`);
    if (!ok) bad++;
  }
  if (bad) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === "--self-test") selfTest();
  else {
    const path = process.argv[2] ?? "wasm/sagebrush-engine.wasm";
    const p = checkModule(readFileSync(path));
    if (p.length) {
      console.error(`${path}:\n  ${p.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`${path}: no start section, every active segment within the initial memory and table`);
  }
}
