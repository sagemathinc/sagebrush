import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Retired engine instances and admitted creation (no-cliffs C r14-r17,
// C-2b scope r2 section 2; src/runtime/engine.ts): the three call paths
// retire a trapped instance through retire(), its bytes stay in R_ret until
// both of its finalizers fire, and the next instance is created only through
// the admission phi (M0 + R_ret + O_host) <= total / 4, at the outer
// boundary, with a debt per failed creation that may have allocated.
const E = require("../src/runtime/engine");
const H = E.retireTest;
const PAGE = 65536;

// ---- a small WebAssembly assembler for the test modules ----
const uleb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
};
const sleb = (n: number): number[] => {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) return [...out, b];
    out.push(b | 0x80);
  }
};
const name = (s: string) => [...uleb(s.length), ...Buffer.from(s)];
const vec = (xs: number[][]) => [...uleb(xs.length), ...xs.flat()];
const section = (id: number, body: number[]) => [id, ...uleb(body.length), ...body];
const I32 = 0x7f, F64 = 0x7c;
const i32c = (n: number) => [0x41, ...sleb(n)];

interface ModOpts {
  pages: number;
  /** sb_last_error grows the memory by one page (symCall's error read). */
  growOnError?: boolean;
  /** a start function that traps (a failure after the memory exists). */
  trapStart?: boolean;
  /** an invalid function body (a compile error). */
  invalid?: boolean;
}

/** A module with the engine's ABI: each call traps when its request starts
 * with "T"; sb_set_retired_bytes stores (bytes, faulted) at 32 and 40, and
 * sb_set_memory_total (bytes, status, uncertified) at 8, 16 and 20. */
function module(o: ModOpts): Uint8Array {
  const types = [
    [0x60, ...vec([[I32]]), ...vec([[I32]])], // 0 (i32) -> i32
    [0x60, ...vec([[I32], [I32]]), ...vec([])], // 1 (i32, i32)
    [0x60, ...vec([[I32], [I32]]), ...vec([[I32]])], // 2 (i32, i32) -> i32
    [0x60, ...vec([]), ...vec([[I32]])], // 3 () -> i32
    [0x60, ...vec([[F64], [I32], [I32]]), ...vec([])], // 4 (f64, i32, i32)
    [0x60, ...vec([[F64], [I32]]), ...vec([[I32]])], // 5 (f64, i32) -> i32
    [0x60, ...vec([[F64]]), ...vec([])], // 6 (f64)
    [0x60, ...vec([]), ...vec([])], // 7 ()
  ];
  const trapIfT = [0x20, 0, 0x2d, 0, 0, ...i32c(84), 0x46, 0x04, 0x40, 0x00, 0x0b, ...i32c(0)];
  // [name, type, body] (function index = 1 + position: import 0 is interrupted)
  const funcs: [string, number, number[]][] = [
    ["sb_alloc", 0, i32c(1024)],
    ["sb_free", 1, []],
    ["sb_call", 2, o.invalid ? [0xff] : trapIfT],
    ["sb_sym_call", 2, trapIfT],
    ["sb_mp_call", 2, trapIfT],
    ["sb_last_error", 3, [...(o.growOnError ? [...i32c(1), 0x40, 0x00, 0x1a] : []), ...i32c(0)]],
    ["sb_reply_len", 3, i32c(0)],
    ["sb_set_memory_total", 4, [...i32c(8), 0x20, 0, 0x39, 3, 0, ...i32c(16), 0x20, 1, 0x36, 2, 0, ...i32c(20), 0x20, 2, 0x36, 2, 0]],
    ["sb_set_retired_bytes", 5, [...i32c(32), 0x20, 0, 0x39, 3, 0, ...i32c(40), 0x20, 1, 0x36, 2, 0, ...i32c(0)]],
    ["sb_set_memory_share", 6, []],
  ];
  if (o.trapStart) funcs.push(["start", 7, [0x00]]);
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    ...section(2, vec([[...name("sagebrush"), ...name("interrupted"), 0x00, 3]])),
    ...section(3, vec(funcs.map(([, t]) => uleb(t)))),
    ...section(5, vec([[0x00, ...uleb(o.pages)]])),
    ...section(7, vec([[...name("memory"), 0x02, 0], ...funcs.filter(([n]) => n !== "start").map(([n], i) => [...name(n), 0x00, ...uleb(1 + i)])])),
    ...(o.trapStart ? section(8, uleb(funcs.length)) : []),
    ...section(10, vec(funcs.map(([, , b]) => { const body = [0, ...b, 0x0b]; return [...uleb(body.length), ...body]; }))),
  ];
  return new Uint8Array(bytes);
}

/** What the live test instance was pushed: [R_ret, faulted]. */
function pushedRetired(): [number, number] {
  const m = H.live().memory.buffer;
  return [new Float64Array(m, 32, 1)[0], new Int32Array(m, 40, 1)[0]];
}

const MiB = 1 << 20;
/** A total whose E (total / 4) admits exactly need = M0 + R_ret (phi = 21/8):
 * 21 need = 8 E.  need must be a multiple of 8. */
const equalityTotal = (need: number) => (21 * need / 8) * 4;

function fresh(o: ModOpts, total: number) {
  H.reset();
  H.setModule(module(o));
  H.setTotal([total, 0, 0]);
}
const trap = {
  engineCall: () => assert.throws(() => E.engineCall("T")),
  symCall: () => assert.throws(() => E.symCall("T")),
  mpCall: () => assert.throws(() => E.mpCall(new Uint8Array([84]))),
};

test("each of the three paths retires a trapped instance through retire(), and the next call is an admitted creation", () => {
  for (const [path, run] of Object.entries(trap)) {
    fresh({ pages: 16 }, 4 * 1024 * MiB);
    H.setRegister(() => {}); // (no finalizer fires in this test)
    assert.equal(E.engineCall("x"), "", path);
    const first = H.state().liveId;
    run();
    const s = H.state();
    assert.equal(s.liveId, 0, path);
    assert.deepEqual(s.roots, { E: false, frames: false, shareTo: false }, path);
    assert.deepEqual(s.pending.map((p: any) => [p.id, p.bytes, p.debt]), [[first, 16 * PAGE, false]], path);
    assert.equal(s.retired, 16 * PAGE, path);
    E.engineCall("x");
    assert.notEqual(H.state().liveId, first, path);
    assert.deepEqual(pushedRetired(), [16 * PAGE, 0], `${path}: R_ret pushed to the new instance`);
  }
});

test("retained old memory: R_ret stays and the next creation is refused at phi (M0 + R_ret) > E; equality admits", () => {
  const m0 = 16 * PAGE;
  for (const [path, run] of Object.entries(trap)) {
    // E admits M0 alone, not M0 plus the retained instance
    fresh({ pages: 16 }, 4 * 4 * MiB);
    H.setRegister(() => {});
    E.engineCall("x");
    const kept = H.live().memory; // (the fixture keeps the old instance reachable)
    run();
    assert.equal(H.state().retired, m0, path);
    assert.throws(() => E.engineCall("x"), (e: any) => e.constructor.name === "CreationRefused" && e.retired === m0 && e.initial === m0, path);
    assert.equal(H.state().liveId, 0, `${path}: nothing created`);
    assert.equal(H.state().creating, 0, `${path}: no credit held`);
    // at equality, admitted; one byte of E less, refused
    H.setTotal([equalityTotal(2 * m0) - 4, 0, 0]);
    assert.throws(() => E.engineCall("x"), (e: any) => e.constructor.name === "CreationRefused", path);
    H.setTotal([equalityTotal(2 * m0), 0, 0]);
    assert.equal(E.engineCall("x"), "", path);
    assert.ok(kept.buffer.byteLength === m0);
  }
});

test("repeated cycles: R_ret rises by each D_i and falls only once both finalizers of that id have fired; repeats are no-ops", () => {
  fresh({ pages: 2 }, 4 * 1024 * MiB);
  const reg: [object, number, string][] = [];
  H.setRegister((t: object, id: number, kind: string) => reg.push([t, id, kind]));
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    E.engineCall("x");
    ids.push(H.state().liveId);
    trap.engineCall();
    assert.equal(H.state().retired, (i + 1) * 2 * PAGE);
  }
  // each retirement registered its Memory and its ArrayBuffer, with the id
  // only as the held value
  assert.deepEqual(reg.map(([, id, k]) => [id, k]), ids.flatMap((id) => [[id, "memory"], [id, "buffer"]]));
  assert.ok(reg.every(([t], i) => (i % 2 ? t instanceof ArrayBuffer : t instanceof WebAssembly.Memory)));
  E.engineCall("x");
  assert.deepEqual(pushedRetired(), [10 * PAGE, 0]);
  H.collected(ids[0], "memory");
  assert.equal(H.state().retired, 10 * PAGE, "one finalizer: still pending");
  H.collected(ids[0], "memory");
  assert.equal(H.state().retired, 10 * PAGE, "a repeat: no-op");
  H.collected(ids[0], "buffer");
  assert.equal(H.state().retired, 8 * PAGE, "both: removed");
  assert.deepEqual(pushedRetired(), [8 * PAGE, 0], "and pushed");
  H.collected(ids[0], "buffer");
  H.collected(ids[0], "memory");
  H.collected(987654, "memory");
  assert.equal(H.state().retired, 8 * PAGE, "repeats and unknown ids: no-ops");
  for (const id of ids.slice(1)) {
    H.collected(id, "buffer");
    H.collected(id, "memory");
  }
  assert.equal(H.state().retired, 0);
  assert.deepEqual(pushedRetired(), [0, 0]);
});

test("symCall reads the error before D_i is frozen: an error read that grows the memory is counted", () => {
  fresh({ pages: 3, growOnError: true }, 4 * 1024 * MiB);
  H.setRegister(() => {});
  E.symCall("x");
  trap.symCall();
  assert.equal(H.state().retired, 4 * PAGE);
});

test("retirement drops every root (E, the frames view and the share cache): the old instance is collected even when the next creation is refused", async () => {
  const { fullGc } = require("../src/runtime/gc");
  fresh({ pages: 16 }, 4 * 4 * MiB);
  // (the real finalizers)
  let weak: WeakRef<object> | null = null;
  (() => {
    E.engineCall("x");
    weak = new WeakRef(H.live().memory);
    // (a plain catch: the trap's error, whose stack names the instance's
    // frames, is not kept)
    try {
      E.engineCall("T");
    } catch {}
  })();
  // the next creation is refused (the retired instance fills the room)
  let refused = "";
  try {
    E.engineCall("x");
  } catch (e: any) {
    refused = e.constructor.name;
  }
  assert.equal(refused, "CreationRefused");
  assert.deepEqual(H.state().roots, { E: false, frames: false, shareTo: false });
  let collectedAll = false;
  for (let i = 0; i < 50 && !collectedAll; i++) {
    await new Promise((r) => setImmediate(r));
    if (!fullGc()) return; // (a host without a full collection: nothing to check)
    await new Promise((r) => setTimeout(r, 10));
    collectedAll = weak!.deref() === undefined && H.state().pending.length === 0;
  }
  assert.ok(weak!.deref() === undefined, "the old instance's memory is collected");
  assert.equal(H.state().pending.length, 0, "both finalizers fired and removed its entry");
  assert.equal(H.state().retired, 0);
  // and the next creation is admitted
  assert.equal(E.engineCall("x"), "");
});

test("the creation precondition: an open host handle, a call or another creation refuses (Internal), never a silent pass", () => {
  H.reset();
  H.setTotal([4 * 1024 * MiB, 0, 0]);
  // the production engine: host handles
  const h = E.hostReserve("carried T", 4096);
  assert.ok(h.open && h.handle > 0);
  assert.equal(H.state().oHost, 1);
  H.retire();
  assert.throws(() => E.engineCall('{"fn":"progress_tables"}'), /outer boundary \(open host handles 1/);
  assert.equal(H.state().liveId, 0, "nothing created");
  // astra2's equality case: M0 + R_ret exactly at E / phi with an open host
  // obligation: refused by the precondition, not admitted
  const m0 = E.initialMemory(readFileSync(join(__dirname, "../../wasm/sagebrush-engine.wasm")));
  const r = H.state().retired;
  H.setTotal([equalityTotal(m0 + r), 0, 0]);
  assert.throws(() => E.engineCall('{"fn":"progress_tables"}'), /outer boundary/);
  // closing the handle (its instance is retired: only the count) lets the
  // creation go ahead, admitted at equality
  E.hostRelease(h);
  E.hostRelease(h);
  assert.equal(H.state().oHost, 0);
  E.engineCall('{"fn":"progress_tables"}');
  assert.ok(H.state().liveId > 0);
});

test("while a creation holds its credit (the test-only async variant's pause hook), no host reservation can spend the same room", async () => {
  fresh({ pages: 4 }, 4 * 1024 * MiB);
  let refused = "";
  await H.createAsync(async () => {
    assert.equal(H.state().creating, 4 * PAGE);
    try {
      E.hostReserve("T", 1);
    } catch (e: any) {
      refused = e.message;
    }
  });
  assert.match(refused, /while an engine instance is being created/);
  assert.equal(H.state().creating, 0);
  assert.ok(H.state().liveId > 0);
  // a throw during the pause refunds the credit and creates nothing
  H.retire();
  H.setRegister(() => {});
  await assert.rejects(H.createAsync(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(H.state().creating, 0);
  assert.equal(H.live(), null);
});

test("failed creations: two failures after allocation are two debts (never coalesced), the third attempt is refused at admission; equality admits", () => {
  const m0 = 8 * PAGE;
  fresh({ pages: 8, trapStart: true }, equalityTotal(3 * m0) - 4);
  for (let i = 1; i <= 2; i++) {
    assert.throws(() => E.engineCall("x"), (e: any) => e instanceof WebAssembly.RuntimeError, `attempt ${i}`);
    const s = H.state();
    assert.equal(s.pending.filter((p: any) => p.debt).length, i);
    assert.equal(s.retired, i * m0);
    assert.equal(s.fault, true, "the failed-creation fault");
    assert.equal(s.creating, 0);
  }
  // M0 + 2 M0 just over the room: refused before allocating
  assert.throws(() => E.engineCall("x"), (e: any) => e.constructor.name === "CreationRefused" && e.retired === 2 * m0);
  assert.equal(H.state().pending.length, 2);
  // at equality, admitted (and this module fails again: a third debt)
  H.setTotal([equalityTotal(3 * m0), 0, 0]);
  assert.throws(() => E.engineCall("x"), (e: any) => e instanceof WebAssembly.RuntimeError);
  assert.equal(H.state().pending.length, 3);
  // debts have no finalizer: firing their ids does nothing
  for (const p of H.state().pending) {
    H.collected(p.id, "memory");
    H.collected(p.id, "buffer");
  }
  assert.equal(H.state().retired, 3 * m0);
  // a good instance afterwards is pushed the debt and the fault
  H.setModule(module({ pages: 8 }));
  H.setTotal([4 * 1024 * MiB, 0, 0]);
  E.engineCall("x");
  assert.deepEqual(pushedRetired(), [3 * m0, 1]);
});

test("phase refunds: a compile failure is refunded; a throwing import getter (not our import object) is a debt, even for the production module", () => {
  fresh({ pages: 2, invalid: true }, 4 * 1024 * MiB);
  assert.throws(() => E.engineCall("x"), (e: any) => e instanceof WebAssembly.CompileError);
  assert.deepEqual([H.state().pending.length, H.state().fault, H.state().creating], [0, false, 0], "compile: refunded");
  H.reset();
  H.setTotal([4 * 1024 * MiB, 0, 0]);
  const imports = {};
  Object.defineProperty(imports, "sagebrush", { get() { throw new Error("getter"); }, enumerable: true });
  H.setImports(imports);
  assert.throws(() => E.engineCall('{"fn":"progress_tables"}'), /getter/);
  const s = H.state();
  assert.equal(s.pending.length, 1);
  assert.equal(s.pending[0].debt, true);
  assert.equal(s.fault, true);
});

test("an overflow of R_ret fails closed: creation refused, the fault pushed", () => {
  fresh({ pages: 2 }, 4 * 1024 * MiB);
  H.setRegister(() => {});
  E.engineCall("x");
  H.inject(2 ** 53 - 2 * PAGE);
  assert.equal(H.state().overflow, false);
  E.engineCall("x");
  trap.engineCall();
  assert.equal(H.state().overflow, true);
  assert.equal(H.state().fault, true);
  assert.throws(() => E.engineCall("x"), (e: any) => e.constructor.name === "CreationRefused" && e.inexact);
});

test("R_ret through the real engine_total push (fake /proc/meminfo, basis MemAvailable: the pushed total is MemTotal): astra2's case refuses creation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retire-"));
  try {
    mkdirSync(join(dir, "proc"));
    writeFileSync(join(dir, "proc/meminfo"), "MemTotal:       1048576 kB\nMemAvailable:    943718 kB\n");
    const c = require("../src/compile.js");
    await Promise.resolve(c.initParser && c.initParser());
    c.R.importModule("sys").path.push(c.libDir());
    c.execModule(`import _capacity as C\nC._set_sources(root=${JSON.stringify(dir)}, rlimits={}, runtime=lambda: [])\nt = C.engine_total()\nassert (t["bytes"], t["status"], t["basis"]) == (1 << 30, "observed", ["MemAvailable"]), t\n`, "<t>", "__main__");
    // E = 1 GiB / 4 = 256 MiB, E / phi = 97.5 MiB: M0 = 64 MiB is admitted
    // alone, not with a retained 64 MiB instance
    H.reset();
    H.setModule(module({ pages: 1024 }));
    H.setRegister(() => {});
    E.engineCall("x");
    const kept = H.live().memory;
    trap.engineCall();
    assert.equal(H.state().retired, 64 * MiB);
    assert.throws(() => E.engineCall("x"), (e: any) => e.constructor.name === "CreationRefused" && e.limit === 256n * BigInt(MiB));
    assert.ok(kept);
    c.execModule("import _capacity as C\nC._set_sources()\n", "<t>", "__main__");
  } finally {
    H.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only retire() and the creation transaction assign the live instance E (and the test hooks' reset)", () => {
  const src = readFileSync(join(__dirname, "../../src/runtime/engine.ts"), "utf8").split("\n");
  const owners: string[] = [];
  let fn = "";
  src.forEach((line) => {
    const m = /^(?:export )?(?:async )?function (\w+)|^\s{2}(\w+)\(.*\) \{$|^\s{2}async (\w+)\(/.exec(line);
    if (m) fn = m[1] ?? m[2] ?? m[3];
    if (/(^|[^\w.])E\s*=(?!=)/.test(line.replace(/\/\/.*$/, ""))) owners.push(fn);
  });
  assert.deepEqual(owners.sort(), ["createAsync", "createInstance", "reset", "retire"]);
});
