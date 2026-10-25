import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rasterBytes } from "../src/runtime/raster";

// The PNG engine's own contract (engine/raster; PNG plan r8, step A1): its
// typed outcomes, its WebAssembly heap's page bound, and dashing without
// tiny-skia's limit on the number of dashes.  The hosts' admission of memory
// (the ledger) comes in A2 and A3.

const TEST = __dirname + "/../../test/";
const run = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8", cwd: TEST });

interface Engine {
  memory: WebAssembly.Memory;
  rs_alloc(len: number): number;
  rs_render(svg: number, svgLen: number, scale: number, w: number, h: number, bg: number, bgLen: number, dpi: number, text: number, textLen: number): number;
  rs_decode(png: number, len: number): number;
  rs_reply_ptr(): number;
  rs_reply_len(): number;
  rs_begin(pages: number): void;
  rs_last_refusal(): number;
  rs_heap_base(): number;
}

const MODULE = new WebAssembly.Module(rasterBytes() as any);
const fresh = () => new WebAssembly.Instance(MODULE, {}).exports as unknown as Engine;

function put(e: Engine, b: Uint8Array): number {
  const p = e.rs_alloc(b.length);
  new Uint8Array(e.memory.buffer, p, b.length).set(b);
  return p;
}

function render(e: Engine, svg: string): { code: number; reply: Uint8Array } {
  const s = new TextEncoder().encode(svg);
  const ps = put(e, s);
  const code = e.rs_render(ps, s.length, 1, 0, 0, 0, 0, 72, 0, 0);
  return { code, reply: new Uint8Array(e.memory.buffer, e.rs_reply_ptr(), e.rs_reply_len()).slice() };
}

const refusal = (e: Engine) => {
  const v = new DataView(e.memory.buffer, e.rs_last_refusal(), 12);
  return { need: v.getUint32(0, true), size: v.getUint32(4, true), limit: v.getUint32(8, true) };
};

const picture = (w: number, h: number, body = "") => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`;

test("the engine's outcomes are typed: 0 a result, 1 the input refused, 2 memory refused with its bytes", () => {
  const e = fresh();
  assert.equal(render(e, picture(4, 4)).code, 0);
  const bad = render(e, "<svg");
  assert.equal(bad.code, 1);
  assert.match(new TextDecoder().decode(bad.reply), /unterminated/);
  // a 3000 x 3000 picture (36,000,000 bytes) on an instance allowed 4 pages
  // of growth (dlmalloc takes its memory from the system 64 KiB at a time,
  // more than the initial memory's slack): refused at the picture's own
  // allocation, in-band, with its bytes
  const small = fresh();
  small.rs_begin(4);
  const r = render(small, picture(3000, 3000));
  assert.equal(r.code, 2);
  const v = new DataView(r.reply.buffer, r.reply.byteOffset);
  assert.equal(Number(v.getBigUint64(0, true)), 3000 * 3000 * 4);
  assert.equal(new TextDecoder().decode(r.reply.subarray(8)), "the picture");
  const f = refusal(small);
  assert.ok(f.need >= Math.ceil((3000 * 3000 * 4) / 65536) && f.size + f.need > f.limit, JSON.stringify(f));
});

test("the heap's page bound: memory.size never passes the pages it had at rs_begin plus those allowed", () => {
  // the pages a 3000 x 3000 render grows by unbounded (its 36 MB picture,
  // 36 MB RGBA copy and the PNG): allowed exactly those, drawn; allowed
  // fewer, refused, and the memory never grew past the bound
  const unbounded = fresh();
  const start0 = unbounded.memory.buffer.byteLength / 65536;
  assert.equal(render(unbounded, picture(3000, 3000)).code, 0);
  const grown = unbounded.memory.buffer.byteLength / 65536 - start0;
  assert.ok(grown >= (2 * 3000 * 3000 * 4) / 65536, `${grown} pages`);
  for (const pages of [0, Math.floor(grown / 2), grown - 1, grown]) {
    const e = fresh();
    const start = e.memory.buffer.byteLength / 65536;
    e.rs_begin(pages);
    // (refused in-band where the allocation is ours, else by a trap with
    // the refusal recorded: both are the memory outcome)
    let outcome: string;
    try {
      const code = render(e, picture(3000, 3000)).code;
      outcome = code === 0 ? "drawn" : code === 2 ? "memory" : `code ${code}`;
    } catch {
      outcome = refusal(e).need > 0 ? "memory" : "a trap without a refusal";
    }
    assert.ok(e.memory.buffer.byteLength / 65536 <= start + pages, `${pages}: ${e.memory.buffer.byteLength / 65536} pages`);
    assert.equal(outcome, pages === grown ? "drawn" : "memory", `${pages} of ${grown} pages allowed`);
  }
  // a call within the bound records no refusal (the record is the call's own)
  const e = fresh();
  e.rs_begin(1000);
  assert.equal(render(e, picture(16, 16)).code, 0);
  assert.equal(refusal(e).need, 0);
});

test("an allocation that can't fail cleanly traps, with the refused growth recorded for the host", () => {
  // 2,000,000 dashes' path (tens of MB, in tiny-skia's PathBuilder, which
  // allocates infallibly) on an instance allowed 8 pages: a trap, and the
  // record says what was asked for
  const e = fresh();
  e.rs_begin(8);
  const svg = picture(10, 10, `<line x1="0" y1="5" x2="2000000" y2="5" stroke="black" stroke-dasharray="0.5 0.5"/>`);
  assert.throws(() => render(e, svg), WebAssembly.RuntimeError);
  const f = refusal(e);
  assert.ok(f.need > 0 && f.size + f.need > f.limit, JSON.stringify(f));
});

test("a stroke of more than 1,000,000 dashes is drawn (tiny-skia's dashing gives up there, drawing nothing)", () => {
  // the line's first ten pixels, dashed with half-pixel dashes: covered
  // half-way, where tiny-skia's dash would have dropped the whole stroke
  const out = run(["-c", `
import _sbraster, struct
svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><line x1="0" y1="5" x2="2000000" y2="5" stroke="black" stroke-width="2" stroke-dasharray="0.5 0.5"/></svg>'
png, missing = _sbraster.render(svg, 1.0, 0, 0, None, 72.0, [])
w, h, ch, raw = _sbraster.decode(png)
v = struct.unpack("<%df" % (len(raw) // 4), raw)
print(w, h, ch, [round(v[(5 * w + x) * ch + 3], 2) for x in range(1, 9)])
`]);
  assert.equal(out.trim(), "10 10 4 [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]");
});
