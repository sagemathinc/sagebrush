// ci: web-browser/board-unit.2 order=150 runner=bun
// E1 r2e item 4, route (b): preflight's length-only measure (stream.ts notebookBytes / boardBytes, a counting Out)
// against the real writer (notebookSlices / boardSlices, each slice encoded by TextEncoder), byte for byte, over whole
// members (the JSON's framing, indentation, the data: URL's prefix and padding included), at several slice and piece
// sizes so that cuts land everywhere; and the counter's contract: nothing handed on, no picture read, its cap.
//   bun web/workspace/export/test-measure.mjs
import { boardBytes, boardSlices, Counter, notebookBytes, notebookSlices, outForTest, sizes } from "./stream";
import { boardTextParts, cleanDocSteps, ipynbObject } from "../file-bytes";

const SER = { cleanDocSteps, boardTextParts };
const results = [];
const check = (ok, what) => results.push([!!ok, what]);
const J = JSON.stringify;
const pace = () => ({ signal: new AbortController().signal, breathe: async () => {}, stopped: () => { throw new Error("cancelled"); } });
const over = () => { throw new Error("over the cap"); };
const written = async (it) => { let n = 0; const parts = []; for await (const s of it) { n += s.length; parts.push(s); } return { n, parts }; };

// (pictures: one the document doesn't carry (a Blob this browser has, read in slices when written), of sizes around
// 3-byte groups and the 768 KiB picture slice; reads counted)
let reads = 0;
const blobOf = (n, type) => { const b = new Blob([new Uint8Array(n).map((_, i) => (i * 7) & 255)], { type }); const slice = b.slice.bind(b); b.slice = (...a) => { reads++; return slice(...a); }; return b; };
const imagesOf = (m) => ({ blob: async (name) => m[name], dispose() {} });

const emo = "😀👩‍👩‍👧🇫🇷", lone = "\ud800x\udc00", hiEnd = "end\ud83d", loStart = "\ude00start";
const notebook = () => ({
  mode: "python",
  cells: [
    { id: "n1", code: `s = ${J(emo.repeat(40))}\nprint(s)`, outputs: [{ output_type: "stream", name: "stdout", text: (emo + " \t\"\\\u0001" + lone + "\n").repeat(600) }], n: "1" },
    { id: "n2", code: "x", outputs: [{ output_type: "execute_result", execution_count: 2, metadata: {}, data: { "text/plain": ["a\n", emo.repeat(3000), "b", hiEnd, loStart], "application/json": { neg: -0, big: 1e21, small: 5e-324, u2028: "  " } } }] },
    { id: "n3", type: "markdown", code: ("# Ünïcode " + emo + "\n").repeat(5000), attachments: { "a.png": { "image/png": "iVBORw0KGgo" + "A".repeat(300000) } } },
    { id: "n4", type: "raw", code: "" },
    { id: "n5", code: lone.repeat(20000) + "\n" + "x".repeat(70000), outputs: [] },
  ],
});
const board = () => ({
  title: "b " + emo, nodes: [
    { id: "t1", title: (emo + lone + "\n").repeat(4000) },
    { id: "i1", title: "p1", image: "p1" },
    { id: "i2", title: "p2", image: "p2" },
    { id: "i3", title: "p3", image: "p3" },
  ],
  images: {
    p1: { w: 300, h: 200 },                                                      // (this browser's: a Blob, 1 byte past a slice)
    p2: { w: 30, h: 20 },                                                        // (this browser's: a Blob of 3k + 2 bytes)
    p3: { w: 40, h: 30, src: "data:image/png;base64," + "QUJD".repeat(40000) },  // (carried: a long data: URL, written as it is)
  },
});

for (const [chunk, piece] of [[256 * 1024, 64 * 1024], [4096, 1024], [97, 31], [7, 3]]) {
  sizes(chunk, piece);
  const tag = `CHUNK ${chunk}, PIECE ${piece}`;
  {
    const real = await written(notebookSlices(notebook(), ipynbObject, pace()));
    const count = new Counter(Infinity, over);
    const n = await notebookBytes(notebook(), ipynbObject, pace(), count);
    check(n === real.n && count.bytes === n, `${tag}: a notebook (pairs, lone and split surrogates, controls, long texts): counted ${n} = written ${real.n}`);
  }
  {
    const p1 = blobOf(3 * 256 * 1024 + 1, "image/png"), p2 = blobOf(3002, "image/webp");
    const real = await written(boardSlices(board(), imagesOf({ p1, p2 }), SER, pace()));
    const text = new TextDecoder().decode(Buffer.concat(real.parts));
    check(/"data:image\/png;base64,/.test(text) && /"data:image\/webp;base64,/.test(text), `${tag}: the written board carries both pictures as data: URLs (the fixture exercises picture())`);
    reads = 0;
    const count = new Counter(Infinity, over);
    const n = await boardBytes(board(), imagesOf({ p1: blobOf(3 * 256 * 1024 + 1, "image/png"), p2: blobOf(3002, "image/webp") }), SER, pace(), count);
    check(n === real.n, `${tag}: a board (pictures this browser has, a carried data: URL, text): counted ${n} = written ${real.n}`);
    check(reads === 0, `${tag}: counting reads no picture's bytes (${reads} slices read)`);
  }
}
// (the writer itself, on parts cut anywhere: a surrogate pair split between two parts of one slice (encoded joined: 4
// bytes), split across a slice's end (two lone halves: 3 + 3), and lone halves; counted = written for every cut)
{
  const texts = ["a\ud83d\ude00b", "\ud83d\ude00\ud83d\ude00", "x\ud800y\udc00z", "\udc00\ud800", "é😀€\ud83d"];
  let bad = [], cases = 0;
  for (const chunk of [1, 2, 3, 5, 1 << 20]) for (const t of texts) for (let cut = 0; cut <= t.length; cut++) for (const steps of [false, true]) {
    sizes(chunk, 64 * 1024);
    const parts = [t.slice(0, cut), t.slice(cut)];
    let n = 0;
    const w = outForTest(async (b) => { n += b.length; }, pace());
    const count = new Counter(Infinity, over);
    const c = outForTest(async () => { throw new Error("handed on"); }, pace(), count);
    for (const o of [w, c]) { for (const p of parts) { o.add(p); if (steps) await o.step(); } await o.flush(); }
    cases++;
    if (count.bytes !== n) bad.push([chunk, J(t), cut, steps, count.bytes, n]);
  }
  check(bad.length === 0, `the writer on ${cases} cuts (pairs split between parts, across a slice's end, lone halves): counted = written${bad.length ? " " + J(bad.slice(0, 5)) : ""}`);
}
sizes(256 * 1024, 64 * 1024);
// (the cap: past max, the counter's own stop, at the first part past it)
{
  let stopped = null;
  const count = new Counter(1000, () => { throw new Error("CAP"); });
  try { await notebookBytes(notebook(), ipynbObject, pace(), count); } catch (e) { stopped = String(e.message); }
  check(stopped === "CAP" && count.bytes > 1000, `the cap: stopped past it (${stopped}, at ${count.bytes} bytes)`);
}
// (nothing handed on: the counting writer has no slice to give, and any attempt throws)
{
  const count = new Counter(Infinity, over);
  let threw = null;
  try { await notebookBytes(notebook(), ipynbObject, pace(), count); } catch (e) { threw = e; }
  check(threw === null, `counting hands on no slice (no "a counting writer hands on no slice" thrown): ${threw}`);
}

const fails = results.filter(([ok]) => !ok).map(([, w]) => w);
if (fails.length) { console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  ")); process.exit(1); }
console.log(`ok: preflight's length-only measure, ${results.length} checks`);
if (process.env.SHOW) for (const [, w] of results) console.log("  " + w);
