// ci: web-runner order=194 runner=bun
// The review page's pure parts, without a browser: its line diff, the notebook's cell diff and folds, the JSON value
// count, the outputs it shows, the run line, and the run notes' merge (branch-rules.ts) and canonical bytes.
//   bun web/workspace/review/test-review-pure.mjs          (SHOW=1 every check)
import { REVIEW_DIFF, reviewLineDiff, utf8Length } from "./line-diff.ts";
import { CELL_LIMITS, cellDiff, foldRows } from "./cells.ts";
import { JSON_LIMITS, jsonValues } from "./json-scan.ts";
import { OUTPUT_LIMITS, filterOutputs, pictureSize, base64Head } from "./outputs.ts";
import { runFact } from "./run-line.ts";
import { boardCounts, itemSignatures } from "./board-summary.ts";
import { RUNS_LIMITS, mergeRun, jsonBytes } from "../branch-rules.ts";
import { docCanonBytes, blobOid } from "../canon-doc.ts";
import { canonBytes } from "../branch-canon.ts";
import { objectId } from "../branch-store.ts";
import { lineDiff } from "../../latex/posmap.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); if (process.env.SHOW) console.log((ok ? "  ok   " : "  FAIL ") + what); };
let seed = 20261112;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const lines = (xs) => xs.map((x) => x + "\n").join("");

// ---- the line diff ------------------------------------------------------------------------------------------------
{
  // (on seeded random inputs with many repeats, the script applied to the old text gives the new, its
  //  "=" runs are equal lines, and its edit count is the editor's lineDiff's: both are the least there is)
  let bad = 0, n = 0;
  for (let t = 0; t < 300; t++) {
    const k = 1 + Math.floor(rnd() * 4), gen = () => Array.from({ length: Math.floor(rnd() * 40) }, () => "abcd"[Math.floor(rnd() * k)]);
    const a = lines(gen()) + (rnd() < 0.2 ? "tail" : ""), b = lines(gen()) + (rnd() < 0.2 ? "tail" : "");
    const r = reviewLineDiff(a, b);
    if (!r.ok) { bad++; continue; }
    let out = "";
    for (const s of r.segs) { if (s.t === "+") out += r.b.slice(s.b, s.b + s.n).join(""); else if (s.t === "=") { out += r.a.slice(s.a, s.a + s.n).join(""); for (let i = 0; i < s.n; i++) if (r.a[s.a + i] !== r.b[s.b + i]) bad++; } }
    const L = lineDiff(a, b), cnt = (s) => s.split("\n").length - 1 + (s.length && !s.endsWith("\n") ? 1 : 0);
    const editor = L.changes.reduce((x, c, i) => x + cnt(a.slice(c.from, c.to)) + cnt(L.inserted[i]), 0);
    if (out !== b || editor !== r.edits) bad++;
    n++;
  }
  check(bad === 0 && n === 300, `line diff: 300 seeded random inputs rebuild the new text, with the editor's edit count (bad ${bad})`);
  check(REVIEW_DIFF.budget === 4_000_000 && REVIEW_DIFF.maxD === 1000, "line diff: the budget is 4,000,000 comparisons, maxD 1000");

  // (the budget's edge, exactly what a call counts and one less)
  const reps = (m, s) => Array.from({ length: m }, () => s);
  const a = lines([...reps(300, "x"), "p", ...reps(300, "x"), "q", ...reps(300, "x")]), b = lines([...reps(299, "x"), "y", ...reps(301, "x"), "z", ...reps(300, "x")]);
  const free = reviewLineDiff(a, b, { budget: Infinity });
  check(free.ok && reviewLineDiff(a, b, { budget: free.used }).ok, `line diff: a budget of exactly what it uses (${free.used}) is enough`);
  const short = reviewLineDiff(a, b, { budget: free.used - 1 });
  check(!short.ok && short.why === "budget" && short.used === free.used, "line diff: one comparison less is over the budget, counted to the one past it");

  // (repeated interior equal runs: one call at maxD can take about 2,000,000 comparisons, so the 4,000,000 is a file's,
  //  shared by its calls: the second such call stops one past what was left)
  const alt = (k) => lines(Array.from({ length: 24_000 }, (_, i) => (i % k ? "x" : "y")));
  const one = reviewLineDiff(alt(2), alt(3));
  const left = REVIEW_DIFF.budget - one.used, rest = reviewLineDiff(alt(2), alt(3), { budget: left });
  check(one.used > 1_900_000 && one.used <= REVIEW_DIFF.budget && !rest.ok && rest.why === "budget" && rest.used === left + 1,
    `line diff: repeated runs use ${one.used} comparisons; a second call with the ${left} left stops at ${left + 1}`);
  const near = Array.from({ length: 2000 }, (_, i) => "same prefix ".repeat(40) + (i % 2 ? "a" : "b"));
  const nearB = Array.from({ length: 2000 }, (_, i) => "same prefix ".repeat(40) + (i % 2 ? "b" : "a"));
  const nr = reviewLineDiff(lines(near), lines(nearB), { budget: Infinity });
  check(nr.ok ? nr.edits === 2 : nr.why === "edits", "line diff: long lines equal but for their last character compare as ids (2 edits)");

  // (the maxD fallback: disjoint sides needing more than 1000 edits)
  const dis = reviewLineDiff(lines(Array.from({ length: 600 }, (_, i) => "a" + i)), lines(Array.from({ length: 600 }, (_, i) => "b" + i)));
  check(!dis.ok && dis.why === "edits", "line diff: 1,200 edits are past maxD 1000: the fallback");

  // (the sizes: 2 MiB a side exactly, and one byte more; 50,000 lines, and one more)
  const two = "x".repeat(REVIEW_DIFF.sideBytes);
  const eq = reviewLineDiff(two, two);
  check(eq.ok && eq.edits === 0 && eq.used === 1, "line diff: two equal 2 MiB single lines: one comparison after interning");
  check(!reviewLineDiff(two + "y", two).ok && reviewLineDiff(two + "y", two).why === "size", "line diff: 2 MiB + 1 byte a side is refused before splitting");
  check(utf8Length("é€😀\ud800") === 2 + 3 + 4 + 3, "line diff: UTF-8 lengths as the encoder's");
  const l50 = "\n".repeat(REVIEW_DIFF.sideLines);
  check(reviewLineDiff(l50, "\n".repeat(REVIEW_DIFF.sideLines - 1) + "z\n").ok, "line diff: 50,000 lines a side are compared");
  check(reviewLineDiff(l50 + "\n", l50).why === "size", "line diff: 50,001 lines a side are refused");
  check(reviewLineDiff(l50 + "z", l50).why === "size", "line diff: 50,001 lines, the last without a newline, are refused");
}

// ---- the cells ----------------------------------------------------------------------------------------------------
{
  const C = (code, type = "code") => ({ type, code });
  const rows = cellDiff([C("a"), C("b")], [C("b"), C("a")]);
  check(JSON.stringify(rows) === JSON.stringify([{ t: "-", a: 0 }, { t: "=", a: 1, b: 0 }, { t: "+", b: 1 }]), "cells: on a tie the base's cell is deleted first (" + JSON.stringify(rows) + ")");
  const dup = cellDiff([C("x"), C("x"), C("y")], [C("x"), C("y")]);
  check(JSON.stringify(dup) === JSON.stringify([{ t: "=", a: 0, b: 0 }, { t: "-", a: 1 }, { t: "=", a: 2, b: 1 }]), "cells: a duplicate's second copy is the one deleted");
  const ty = cellDiff([C("x")], [C("x", "markdown")]);
  check(JSON.stringify(ty) === JSON.stringify([{ t: "-", a: 0 }, { t: "+", b: 0 }]), "cells: a type change is a deletion and an insertion, never a changed cell");
  const ch = cellDiff([C("1"), C("a = 1"), C("2")], [C("1"), C("a = 2"), C("2")]);
  check(JSON.stringify(ch) === JSON.stringify([{ t: "=", a: 0, b: 0 }, { t: "~", a: 1, b: 1 }, { t: "=", a: 2, b: 2 }]), "cells: an edited cell between kept ones is one changed cell");
  const many = Array.from({ length: CELL_LIMITS.cells }, (_, i) => C(String(i)));
  check(cellDiff(many, [...many].reverse()) !== null, "cells: 2,000 a side are compared");
  check(cellDiff([...many, C("z")], many) === null, "cells: 2,001 on a side are refused");
  const pre = Array.from({ length: 1999 }, () => C("same ".repeat(200)));
  const lp = cellDiff([...pre, C("a")], [...pre, C("b")]);
  check(lp.length === 2000 && lp[1999].t === "~", "cells: a long equal prefix is trimmed, the last cell changed");
  check(foldRows(cellDiff([C("a")], [C("b")])).every((r) => !("fold" in r)), "folds: no unchanged cell, no fold");
  const f1 = foldRows(cellDiff([C("a"), C("k")], [C("b"), C("k")]));
  check(f1.length === 2 && f1[1].fold === 1, "folds: one unchanged cell, a fold of 1");
  const fa = foldRows(cellDiff(many, many));
  check(fa.length === 1 && fa[0].fold === 2000, "folds: all unchanged, one fold of all");
}

// ---- the JSON value count -----------------------------------------------------------------------------------------
{
  const enc = (s) => new TextEncoder().encode(s);
  const ref = (v) => (Array.isArray(v) ? 1 + v.reduce((n, x) => n + ref(x), 0) : v && typeof v === "object" ? 1 + Object.values(v).reduce((n, x) => n + ref(x), 0) : 1);
  let bad = 0;
  for (let t = 0; t < 200; t++) {
    const gen = (d) => { const r = rnd(); if (d > 4 || r < 0.3) return [0, -1.5e3, true, false, null, "s{[,\":\\\"x", ""][Math.floor(rnd() * 7)]; if (r < 0.65) return Array.from({ length: Math.floor(rnd() * 5) }, () => gen(d + 1)); return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 5) }, (_, i) => [`k${i}:"{`, gen(d + 1)])); };
    const v = gen(0), s = rnd() < 0.5 ? JSON.stringify(v) : JSON.stringify(v, null, 2);
    if (jsonValues(enc(s)) !== ref(v)) bad++;
  }
  check(bad === 0, `json: 200 random documents (escaped quotes, structural characters in strings and keys) count as JSON.parse makes them (bad ${bad})`);
  const flat = (k) => "[" + Array(k).fill("0").join(",") + "]";
  check(jsonValues(enc(flat(JSON_LIMITS.full - 1))) === JSON_LIMITS.full, "json: a flat array at the 400,000 cap counts exactly");
  check(jsonValues(enc(flat(JSON_LIMITS.full))) === JSON_LIMITS.full + 1, "json: one more value is over it");
  const obj = (k) => "{" + Array.from({ length: k }, (_, i) => `"k${i}":1`).join(",") + "}";
  check(jsonValues(enc(obj(JSON_LIMITS.side - 1))) === JSON_LIMITS.side && jsonValues(enc(obj(JSON_LIMITS.side))) === JSON_LIMITS.side + 1, "json: a flat object at the 40,000 cap, and one more");
  check(jsonValues(enc("[".repeat(5000) + "]".repeat(5000))) === 5000, "json: deep nesting counts each container");
  check(jsonValues(enc(JSON.stringify(["{[,\":" .repeat(1000)]))) === 2, "json: structural characters inside a string aren't values");
}

// ---- the outputs --------------------------------------------------------------------------------------------------
{
  const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
  const png = (w, h) => b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, w >>> 24, (w >> 16) & 255, (w >> 8) & 255, w & 255, h >>> 24, (h >> 16) & 255, (h >> 8) & 255, h & 255, 8, 6, 0, 0, 0]);
  const jpeg = (w, h, pad = 0) => { const app = []; for (let left = pad; left > 0; left -= 60_000) { const k = Math.min(left, 60_000); app.push(0xff, 0xe1, ((k + 2) >> 8) & 255, (k + 2) & 255, ...new Array(k).fill(0)); } return b64([0xff, 0xd8, ...app, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0, 0]); };
  const webp = (w, h) => b64([...[..."RIFF"].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...[..."WEBPVP8X"].map((c) => c.charCodeAt(0)), 10, 0, 0, 0, 0, 0, 0, 0, (w - 1) & 255, ((w - 1) >> 8) & 255, (w - 1) >> 16, (h - 1) & 255, ((h - 1) >> 8) & 255, (h - 1) >> 16, 0, 0]);
  const out = (data) => ({ output_type: "display_data", data, metadata: {} });
  const doc = (...outputs) => ({ cells: [{ type: "code", code: "", outputs }] });
  const NS = "This output isn't shown here.";
  for (const kind of ["text/html", "image/svg+xml", "text/markdown", "text/latex", "application/vnd.sagebrush.graph+json", "application/vnd.sagebrush.typeset", "application/json", "image/gif", "image/x-foo", "application/javascript"]) {
    const d = doc(out({ [kind]: "<x>" }));
    const r = filterOutputs(d, NS);
    check(!("refused" in r) && JSON.stringify(d.cells[0].outputs[0].data) === JSON.stringify({ "text/plain": NS }), `outputs: ${kind} alone is taken out; the one line instead`);
  }
  const mixed = doc(out({ "text/html": "<b>x</b>", "text/plain": "x" }));
  filterOutputs(mixed, NS);
  check(JSON.stringify(mixed.cells[0].outputs[0].data) === JSON.stringify({ "text/plain": "x" }), "outputs: html beside text/plain: the text shows");
  const ok = doc(out({ "image/png": png(10, 20) }), out({ "image/jpeg": jpeg(30, 40) }), out({ "image/webp": webp(50, 60) }), { output_type: "stream", name: "stdout", text: "hi" });
  const r1 = filterOutputs(ok, NS);
  check(r1.images === 3 && r1.pixels === 200 + 1200 + 3000 && r1.stripped === 0, "outputs: PNG, JPEG and WebP sizes read from their headers (" + JSON.stringify(r1) + ")");
  const lie = doc(out({ "image/jpeg": png(10, 10) }));
  filterOutputs(lie, NS);
  check(lie.cells[0].outputs[0].data["text/plain"] === NS, "outputs: a PNG labelled JPEG is taken out");
  const noSoi = b64([0x00, 0x00, 0xff, 0xc0, 0, 17, 8, 0, 10, 0, 10, 3, 0, 0, 0, 0]);
  check(pictureSize("image/jpeg", base64Head(noSoi)) === null, "outputs: a JPEG size marker without the JPEG start isn't read");
  const cut = doc(out({ "image/png": png(10, 10).slice(0, 12) }));
  filterOutputs(cut, NS);
  check(cut.cells[0].outputs[0].data["text/plain"] === NS, "outputs: a truncated header is taken out, never charged at a guessed size");
  const far = doc(out({ "image/jpeg": jpeg(10, 10, 66_000) }));
  filterOutputs(far, NS);
  check(far.cells[0].outputs[0].data["text/plain"] === NS, "outputs: a JPEG whose size marker is past 64 KiB is taken out");
  const near = doc(out({ "image/jpeg": jpeg(10, 10, 60_000) }));
  check(filterOutputs(near, NS).images === 1, "outputs: one within 64 KiB is read");
  const s4096 = doc(out({ "image/png": png(4096, 1) })), s4097 = doc(out({ "image/png": png(4097, 1) }));
  check(filterOutputs(s4096, NS).images === 1 && filterOutputs(s4097, NS).images === 0, "outputs: a side of 4096 kept, 4097 taken out");
  const px = (last) => doc(out({ "image/png": png(4096, 2048) }), out({ "image/png": png(last, 1) }));
  const exact = doc(out({ "image/png": png(4096, 2047) }), out({ "image/png": png(4096, 1) }));
  check(filterOutputs(exact, NS).pixels === OUTPUT_LIMITS.pixels, "outputs: exactly 8,388,608 pixels kept");
  check(filterOutputs(px(1), NS).refused === "pixels", "outputs: one pixel more: refused whole");
  const imgs = (k) => doc(...Array.from({ length: k }, () => out({ "image/png": png(1, 1) })));
  check(filterOutputs(imgs(64), NS).images === 64 && filterOutputs(imgs(65), NS).refused === "images", "outputs: 64 pictures kept, 65 refused");
  const outs = (k) => doc(...Array.from({ length: k }, () => ({ output_type: "stream", name: "stdout", text: "" })));
  check(filterOutputs(outs(2000), NS).outputs === 2000 && filterOutputs(outs(2001), NS).refused === "outputs", "outputs: 2,000 kept, 2,001 refused");
  const txt = (k) => doc({ output_type: "stream", name: "stdout", text: "x".repeat(k) });
  check(filterOutputs(txt(OUTPUT_LIMITS.text), NS).text === OUTPUT_LIMITS.text && filterOutputs(txt(OUTPUT_LIMITS.text + 1), NS).refused === "text", "outputs: 4 MiB of text kept, one byte more refused");
  const big = png(5000, 5000);
  const tp = doc(out({ "text/plain": "x".repeat(OUTPUT_LIMITS.text + 1) }));
  check(filterOutputs(tp, NS).refused === "text", "outputs: text/plain past 4 MiB refuses the document");
  const tb = doc({ output_type: "error", ename: "E", evalue: "v", traceback: ["t".repeat(OUTPUT_LIMITS.text)] });
  check(filterOutputs(tb, NS).refused === "text", "outputs: an error's traceback is charged to the text budget");
  const dht = b64([0xff, 0xd8, 0xff, 0xc4, 0, 6, 0x10, 0, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 30, 0, 40, 3, 0, 0, 0, 0]);
  const dsz = pictureSize("image/jpeg", base64Head(dht));
  check(dsz?.w === 40 && dsz.h === 30, `outputs: a JPEG's Huffman table before its frame: the frame's size is read (${JSON.stringify(dsz)})`);
  const avi = b64([...[..."RIFF"].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...[..."AVI VP8 "].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 10, 0, 10, 0, 0, 0]);
  const webpLike = b64([...[..."RIFF"].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...[..."WEBPVP8 "].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 10, 0, 10, 0, 0, 0]);
  check(pictureSize("image/webp", base64Head(webpLike))?.w === 10, "outputs: the same bytes tagged WEBP are read (the control)");
  check(pictureSize("image/webp", base64Head(avi)) === null, "outputs: a RIFF that isn't WEBP, with a VP8 chunk, isn't read as WebP");
  const att = { cells: [{ type: "markdown", code: `![](attachment:a.svg) ![x](data:image/png;base64,${big}) <img src=x>`, attachments: { "a.svg": { "image/svg+xml": "<svg/>" } } }] };
  const ra = filterOutputs(att, NS);
  check(att.cells[0].type === "raw" && !("attachments" in att.cells[0]) && ra.images === 0 && att.cells[0].code.includes("data:image/png"), "outputs: a Markdown cell becomes raw text (its inline picture and HTML never rendered), its attachments dropped");
  check(pictureSize("image/png", base64Head(png(7, 9))).w === 7, "outputs: base64 heads decode");
}

// ---- a board's counts: each value written once, however its items nest, and no recursion
{
  const it = (id, extra = {}) => ({ id, ...extra });
  check(JSON.stringify(boardCounts({ items: [it("a", { t: 1 }), it("b")] }, { items: [it("a", { t: 2 }), it("c")] })) === JSON.stringify({ added: 1, removed: 1, changed: 1, bytes: boardCounts({ items: [it("a", { t: 1 }), it("b")] }, { items: [it("a", { t: 2 }), it("c")] }).bytes }), "board: one added, one removed, one changed");
  // (5,000 items each inside the last: a signature per item, each its own fields and its child's id only)
  let deep = it("x0");
  for (let i = 1; i < 5000; i++) deep = it("x" + i, { kids: [deep], text: "t" });
  const doc = { items: [deep] }, len = JSON.stringify(doc).length;
  const sg = itemSignatures(doc);
  check(sg && sg.sigs.size === 5000 && sg.bytes < 2 * len, `board: 5,000 nested items: signatures in linear bytes (${sg?.bytes} for a ${len}-unit document)`);
  // (the same chain under a property named "" (the key JSON.stringify gives its root too), with 64-unit ids: still
  //  each item's own fields and its child's id only)
  let empty = it("e0-".padEnd(64, "0"));
  for (let i = 1; i < 2000; i++) empty = it(("e" + i + "-").padEnd(64, "0"), { "": empty, text: "t" });
  const edoc = { items: [empty] }, elen = JSON.stringify(edoc).length;
  const se = itemSignatures(edoc);
  check(se && se.sigs.size === 2000 && se.bytes < 2 * elen, `board: 2,000 items nested under an empty key: signatures in linear bytes (${se?.bytes} for a ${elen}-unit document)`);
  const ep = it("p", { "": it("c", { v: 1 }) }), ep2 = it("p", { "": it("c", { v: 2 }) });
  check(boardCounts({ items: [ep] }, { items: [ep2] })?.changed === 1, "board: under an empty key too, a child's change is its own, not its parent's");
  const parent = it("p", { kids: [it("c", { v: 1 })] }), parent2 = it("p", { kids: [it("c", { v: 2 })] });
  const n = boardCounts({ items: [parent] }, { items: [parent2] });
  check(n.changed === 1, "board: a child's change is its own, not its parent's too");
}

// ---- the run line and the run notes -------------------------------------------------------------------------------
{
  check(runFact(undefined, "o1").state === "none", "run line: no note: none");
  check(runFact({ at: 5, oid: "o1" }, "o1").state === "ran", "run line: the committed file as run: ran");
  check(runFact({ at: 5, oid: "o0" }, "o1").state === "changed" && runFact({ at: 5, oid: "o0" }, "o1").at === 5, "run line: changed since its run, with its time");
  check(runFact({ at: 5, oid: "o1" }, undefined).state === "changed", "run line: a note for a file not in the commit isn't 'ran'");
  const all = () => true;
  const r1 = mergeRun(null, "/a", { at: 10, oid: "x" }, all);
  check(r1.seq === 1 && r1.runs.length === 1, "runs: the first note");
  const older = mergeRun(r1, "/a", { at: 9, oid: "y" }, all);
  check(older === null, "runs: an older run arriving second leaves the later one");
  const t1 = mergeRun(mergeRun(null, "/a", { at: 5, oid: "b" }, all), "/a", { at: 5, oid: "a" }, all);
  const t2 = mergeRun(mergeRun(null, "/a", { at: 5, oid: "a" }, all), "/a", { at: 5, oid: "b" }, all);
  check(t1 === null && t2.runs[0][1].oid === "b", "runs: an equal-time tie ends the same in either order (the larger id)");
  const other = mergeRun(r1, "/b", { at: 11, oid: "z" }, all);
  check(other.runs.length === 2 && other.seq === 2, "runs: another path's note is kept beside it");
  const pruned = mergeRun(other, "/c", { at: 12, oid: "w" }, (p) => p !== "/a");
  check(pruned.runs.map(([p]) => p).sort().join() === "/b,/c", "runs: a path gone is dropped at the next note");
  let cur = null;
  for (let i = 0; i < RUNS_LIMITS.count + 1; i++) cur = mergeRun(cur, `/${i}`, { at: i, oid: "o" }, all);
  check(cur.runs.length === RUNS_LIMITS.count && !cur.runs.some(([p]) => p === "/0"), "runs: 2,001 notes keep the newest 2,000 (the oldest goes)");
  const wide = "/" + "p".repeat(4000);
  let w = null;
  for (let i = 0; i < 40; i++) w = mergeRun(w, wide + i, { at: i, oid: "0".repeat(40) }, all);
  check(jsonBytes(w.runs) <= RUNS_LIMITS.bytes && w.runs.length < 40 && w.runs[0][1].at === 39, `runs: max-width paths stay within 64 KiB of JSON (${w.runs.length} kept, newest first)`);
  check(mergeRun(null, "/" + "q".repeat(RUNS_LIMITS.bytes), { at: 1, oid: "o" }, all) === null, "runs: a note too large alone isn't written");
  let churn = null;
  for (let i = 0; i < 5000; i++) churn = mergeRun(churn, `/${i % 2500}`, { at: i, oid: "o" }, all);
  check(churn.runs.length === RUNS_LIMITS.count && churn.runs[0][0] === "/2499", "runs: churn over 2,500 paths keeps the newest 2,000");
}

// ---- canonical bytes ------------------------------------------------------------------------------------------------
{
  const nb = { mode: "sage", cells: [{ id: "c1", type: "code", code: "641*6700417", outputs: [{ output_type: "stream", text: "x" }], n: 3 }, { type: "markdown", code: "# hi" }] };
  const file = new TextEncoder().encode("\\documentclass{article}");
  let same = true;
  for (const v of [1, 2]) for (const [k, c] of [["notebook", nb], ["file", file], ["file", "text"]]) {
    const x = canonBytes(k, c, v), y = docCanonBytes(k, c, v);
    if (x.length !== y.length || x.some((b, i) => b !== y[i])) same = false;
  }
  check(same, "canon: canon-doc's bytes are branch-canon's, for notebooks and files, canon 1 and canon 2");
  check((await blobOid(file)) === (await objectId("blob", file)), "canon: blobOid is the store's blob id");
}

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL " + f);
process.exit(fails.length ? 1 : 0);
