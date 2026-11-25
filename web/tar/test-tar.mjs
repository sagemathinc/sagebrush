// ci: web-runner order=597 runner=bun
// The arXiv source reader (web/tar: inflate.ts, read.ts, main-file.ts; design/arxiv-proxy.md §4 and §7), against
// archives a small tar and gzip writer here makes: every shape, entry type, name rule and refusal by its code, each
// cap exactly at its edge and one past it (the real caps, as LIMITS accepted them), the ratio cap refused at the same
// byte however the input is chunked, the accounted memory peak, and the recorded arXiv responses (fixtures/).
//   bun web/tar/test-tar.mjs
import { constants, deflateRawSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GzipInflater, SLAB } from "./inflate.ts";
import { CAPS, FIXED_BYTES, SourceExtractor, TarError, headerFormat, sniff } from "./read.ts";
import { HINT_MAX, hasDocumentClass, isTexText, mainFileOf, parseBoundedJson, texInputs } from "./main-file.ts";
import { crc32Final, crc32Init, crc32Update } from "../zip/crc32.ts";

let failures = 0, count = 0;
const ok = (c, msg, detail) => {
  count++;
  if (c) console.log("ok   " + msg);
  else {
    failures++;
    console.log("FAIL " + msg + (detail === undefined ? "" : "  " + JSON.stringify(detail).slice(0, 400)));
  }
};
const MiB = 2 ** 20;
const enc = new TextEncoder();
const bytes = (s) => (typeof s === "string" ? enc.encode(s) : s);
const cat = (...parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};
const sha = (b) => createHash("sha256").update(b).digest("hex");
const crc = (b) => crc32Final(crc32Update(crc32Init(), b));

// ---- a tar writer that can break any field ----
const MAGIC = { ustar: "ustar\u000000", gnu: "ustar  \u0000", v7: "" };
function header({ name = "", type = "0", size = 0, prefix = "", format = "ustar", sizeField, checksum, signedSum, magic }) {
  const h = new Uint8Array(512);
  const put = (off, s, len) => {
    const b = bytes(s);
    if (b.length > len) throw new Error(`field too long: ${s}`);
    h.set(b, off);
  };
  put(0, name, 100);
  put(100, "0000644\u0000", 8);
  put(108, "0000000\u0000", 8);
  put(116, "0000000\u0000", 8);
  if (sizeField !== undefined) h.set(bytes(sizeField), 124);
  else put(124, size.toString(8).padStart(11, "0") + "\u0000", 12);
  put(136, "00000000000\u0000", 12);
  put(156, type, 1);
  put(257, magic ?? MAGIC[format], 8);
  if (format !== "v7") (put(265, "user", 32), put(297, "group", 32));
  if (prefix) put(345, prefix, 155);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += signedSum && b > 127 ? b - 256 : b;
  put(148, (checksum ?? sum).toString(8).padStart(6, "0") + "\u0000 ", 8);
  return h;
}
const pad = (n) => new Uint8Array((512 - (n % 512)) % 512);
const entry = (opts, data = new Uint8Array(0)) => {
  const d = bytes(data);
  return cat(header({ size: d.length, ...opts }), d, pad(d.length));
};
const file = (name, data = "", opts = {}) => entry({ name, ...opts }, data);
const dir = (name, opts = {}) => entry({ name, type: "5", ...opts });
const paxRecord = (key, value) => {
  const body = ` ${key}=${value}\n`;
  const len = enc.encode(body).length;
  let n = len + 1;
  while (String(n).length + len !== n) n++;
  return n + body;
};
const pax = (records, opts = {}) => entry({ name: "PaxHeader", type: "x", ...opts }, records instanceof Uint8Array ? records : bytes(typeof records === "string" ? records : records.map(([k, v]) => paxRecord(k, v)).join("")));
const gnuL = (name, size) => {
  const b = cat(bytes(name), new Uint8Array(1));
  const data = size === undefined ? b : cat(b, new Uint8Array(size - b.length));
  return entry({ name: "././@LongLink", type: "L", format: "gnu" }, data);
};
const END = new Uint8Array(1024);
const tar = (...parts) => cat(...parts, END);

// ---- a gzip writer that can set every header flag and break the trailer ----
function gz(data, { level = 6, huffman, name, comment, extra, hcrc, flags = 0, cm = 8, badCrc, badSize, after } = {}) {
  const d = bytes(data);
  let flg = flags;
  const head = [0x1f, 0x8b, cm, 0, 0, 0, 0, 0, 0, 3];
  const opt = [];
  if (extra !== undefined) {
    flg |= 4;
    opt.push(extra.length & 255, extra.length >> 8);
    for (const b of extra) opt.push(b);
  }
  if (name !== undefined) (flg |= 8, opt.push(...bytes(name), 0));
  if (comment !== undefined) (flg |= 16, opt.push(...bytes(comment), 0));
  head[3] = flg | (hcrc ? 2 : 0);
  let h = Uint8Array.from([...head, ...opt]);
  if (hcrc) {
    const c = crc(h) & 0xffff;
    const v = hcrc === "bad" ? c ^ 1 : c;
    h = cat(h, Uint8Array.of(v & 255, v >> 8));
  }
  const body = deflateRawSync(d, { level, strategy: huffman ? constants.Z_HUFFMAN_ONLY : constants.Z_DEFAULT_STRATEGY });
  const t = new Uint8Array(8);
  const dv = new DataView(t.buffer);
  dv.setUint32(0, (crc(d) ^ (badCrc ? 1 : 0)) >>> 0, true);
  dv.setUint32(4, (d.length + (badSize ? 1 : 0)) >>> 0, true);
  return cat(h, body, t, after ?? new Uint8Array(0));
}

/** The extractor over `gzb`, pushed in `chunk`-byte pieces (default: 64 KiB, as the page's network buffers). */
function extract(gzb, { chunk = 65536, caps } = {}) {
  const x = new SourceExtractor(caps);
  try {
    for (let i = 0; i < gzb.length; i += chunk) x.push(gzb.subarray(i, i + chunk));
    return { r: x.end(), x };
  } catch (e) {
    if (!(e instanceof TarError)) throw e;
    return { err: e, x };
  }
}
const refuses = (code, gzb, msg, opts) => {
  const { err, r } = extract(gzb, opts);
  ok(err?.code === code, `${msg}: refused (${code})`, err ? { code: err.code, message: err.message } : { files: r.files.map((f) => f.path) });
  return err;
};
const accepts = (gzb, msg, opts) => {
  const { err, r } = extract(gzb, opts);
  ok(!err, `${msg}: accepted`, err && { code: err.code, message: err.message });
  return r;
};
const paths = (r) => r?.files.map((f) => f.path) ?? null;
const text = (f) => new TextDecoder().decode(f.bytes);

// A deterministic filler: 4 letters, so it compresses about 4:1 (under the ratio cap, and small enough for the
// download cap at the expanded cap's size).
function acgt(n, seed = 1) {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = 0x41 + [0, 2, 6, 19][s >>> 30];
  }
  return out;
}

// ======== the inflater ========
{
  const run = (gzb, chunk, limits = { total: 2 ** 31, ratio: 1e9 }) => {
    const parts = [];
    const inf = new GzipInflater((v) => parts.push(Uint8Array.from(v)), limits);
    for (let i = 0; i < gzb.length; i += chunk) inf.push(gzb.subarray(i, i + chunk));
    inf.end();
    return cat(...parts);
  };
  const same = (a, b) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
  const words = enc.encode(Array.from({ length: 20000 }, (_, i) => `line ${i} \\documentclass ${i % 97}\n`).join(""));
  const rnd = Uint8Array.from(createHash("sha512").update("x").digest().toString("hex").repeat(400), (c) => c.charCodeAt(0) * 7);
  for (const [n, data] of [["text", words], ["noise", rnd], ["zeros", new Uint8Array(300000)], ["empty", new Uint8Array(0)]]) {
    for (const level of [0, 1, 9]) {
      const g = gzipSync(data, { level });
      ok([1, 4096, g.length || 1].every((ch) => same(run(g, ch), data)), `inflate ${n}, level ${level}: zlib's output, byte for byte, for 1-byte, 4 KiB and whole-body input`);
    }
  }
  ok(same(run(gz(words, { name: "paper.tex", comment: "c", extra: [1, 2, 3], hcrc: true }), 7), words), "inflate: a gzip header with a name, a comment, an extra field and a header CRC");
  const bad = (code, g, msg) => {
    let got;
    try {
      run(g, 4096);
    } catch (e) {
      got = e;
    }
    ok(got instanceof TarError && got.code === code, `inflate ${msg}: refused (${code})`, got && { code: got.code, message: got.message });
  };
  bad("gzip", gz(words, { hcrc: "bad" }), "a header CRC that doesn't match");
  bad("gzip", gz(words, { flags: 0x20 }), "a reserved flag");
  bad("gzip", gz(words, { cm: 7 }), "a method other than DEFLATE");
  bad("gzip", cat(Uint8Array.of(0x1f, 0x8c), gz(words).subarray(2)), "a wrong magic");
  const g = gz(words);
  bad("truncated", g.subarray(0, g.length - 3), "a stream cut short");
  bad("crc", gz(words, { badCrc: true }), "a trailer CRC that doesn't match");
  bad("length", gz(words, { badSize: true }), "a trailer length that doesn't match");
  bad("trailing", cat(g, g), "a second gzip member");
  bad("trailing", gz(words, { after: Uint8Array.of(0) }), "one byte after the trailer");
  // (hand-made DEFLATE: a fixed block whose first symbol copies from before the start, and a block of type 3)
  const bits = [];
  const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
  const putCode = (code, len) => { for (let i = len - 1; i >= 0; i--) bits.push((code >> i) & 1); };
  const pack = () => Uint8Array.from({ length: Math.ceil(bits.length / 8) }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((a, b, k) => a | (b << k), 0));
  const raw = (b) => cat(Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3), b, new Uint8Array(8));
  put(1, 1), put(1, 2), putCode(1, 7), putCode(0, 5), putCode(0, 7);
  bad("deflate", raw(pack()), "a distance too far back");
  bits.length = 0;
  put(1, 1), put(3, 2);
  bad("deflate", raw(pack()), "a block of type 3");
  bad("deflate", raw(Uint8Array.of(1, 5, 0, 5, 0)), "a stored block whose length and complement disagree");
  // (malformed dynamic blocks, each breaking one rule and nothing else, from a builder that takes the code lengths)
  const ORDER19 = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  const canonical = (lens) => {
    const max = Math.max(0, ...lens);
    const count = new Array(max + 1).fill(0);
    for (const l of lens) if (l) count[l]++;
    const next = [];
    for (let b = 1, code = 0; b <= max; b++) next[b] = code = (code + (count[b - 1] ?? 0)) << 1;
    return lens.map((l) => (l ? next[l]++ : -1));
  };
  /** A gzip member holding one dynamic block: `lit` and `dist` the code lengths (by symbol), `seq` the code-length
   * symbols sent ([symbol, extra, extraBits]; by default each length as itself), `cl` the code-length code's lengths
   * (by default a complete code over the symbols `seq` uses), `data` the block's symbols, `out` its expected output. */
  const dyn = ({ lit, dist, seq, cl, data, hlit, hdist, out = new Uint8Array(0) }) => {
    seq ??= [...lit, ...dist].map((l) => [l, 0, 0]);
    if (!cl) {
      cl = new Array(19).fill(0);
      const used = [...new Set(seq.map(([s]) => s))];
      const k = Math.max(1, Math.ceil(Math.log2(used.length)));
      for (let s = 0; used.length < 2 ** k; s++) if (!used.includes(s)) used.push(s);
      for (const s of used) cl[s] = k;
    }
    const clCodes = canonical(cl), litCodes = canonical(lit), distCodes = canonical(dist);
    const b = [];
    const put = (v, n) => { for (let i = 0; i < n; i++) b.push((v >> i) & 1); };
    const huff = (code, len) => { for (let i = len - 1; i >= 0; i--) b.push((code >> i) & 1); };
    put(1, 1), put(2, 2), put(hlit ?? lit.length - 257, 5), put(hdist ?? dist.length - 1, 5), put(15, 4);
    for (const s of ORDER19) put(cl[s], 3);
    for (const [s, x, n] of seq) (huff(clCodes[s], cl[s]), put(x, n));
    for (const [kind, s, x = 0, n = 0] of data) {
      if (kind === "bits") put(s, x);
      else (kind === "dist" ? huff(distCodes[s], dist[s]) : huff(litCodes[s], lit[s]), put(x, n));
    }
    const body = Uint8Array.from({ length: Math.ceil(b.length / 8) }, (_, i) => b.slice(i * 8, i * 8 + 8).reduce((a, v, k) => a | (v << k), 0));
    const t = new Uint8Array(8);
    new DataView(t.buffer).setUint32(0, crc(out), true);
    new DataView(t.buffer).setUint32(4, out.length, true);
    return cat(Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3), body, t);
  };
  const lens = (n, pairs) => Object.assign(new Array(n).fill(0), pairs);
  const refusedAs = (re, g, msg) => {
    const got = [1, g.length].map((chunk) => {
      try {
        run(g, chunk);
        return "accepted";
      } catch (e) {
        return e instanceof TarError ? `${e.code}: ${e.message}` : String(e);
      }
    });
    ok(got.every((m) => m.startsWith("deflate: ") && re.test(m)), `inflate ${msg}: refused (deflate, ${re.source}) for 1-byte and whole-body input`, got);
  };
  const okLit = lens(257, { 65: 1, 256: 1 });
  ok(same(run(dyn({ lit: okLit, dist: [1], data: [["lit", 65], ["lit", 256]], out: bytes("A") }), 1), bytes("A")), "inflate: a hand-made dynamic block (the control for the refusals below)");
  refusedAs(/too many length or distance codes/, dyn({ lit: okLit, dist: [1], hlit: 30, data: [] }), "a dynamic block with 287 length codes");
  refusedAs(/too many length or distance codes/, dyn({ lit: okLit, dist: [1], hdist: 30, data: [] }), "a dynamic block with 31 distance codes");
  refusedAs(/code-length code/, dyn({ lit: okLit, dist: [1], cl: lens(19, { 0: 1 }), seq: [], data: [] }), "an incomplete code-length code");
  refusedAs(/code-length code/, dyn({ lit: okLit, dist: [1], cl: lens(19, { 0: 1, 1: 1, 2: 1 }), seq: [], data: [] }), "an over-subscribed code-length code");
  refusedAs(/a repeat with no previous length/, dyn({ lit: okLit, dist: [1], seq: [[16, 0, 2], ...[...okLit, 1].map((l) => [l, 0, 0])], data: [] }), "a repeat of the previous length first");
  refusedAs(/too many code lengths/, dyn({ lit: okLit, dist: [1], seq: [...okLit.map((l) => [l, 0, 0]), [18, 127, 7]], data: [] }), "repeated zeros past the last length");
  refusedAs(/too many code lengths/, dyn({ lit: okLit, dist: [1, 1], seq: [...okLit.map((l) => [l, 0, 0]), [1, 0, 0], [16, 0, 2]], data: [] }), "a repeat of the previous length past the last length");
  refusedAs(/no end-of-block code/, dyn({ lit: lens(257, { 65: 1, 66: 1 }), dist: [1], data: [["lit", 65]] }), "a dynamic block without an end-of-block code");
  refusedAs(/an invalid literal\/length code/, dyn({ lit: lens(257, { 65: 1, 66: 1, 256: 1 }), dist: [1], data: [] }), "an over-subscribed literal/length code");
  refusedAs(/an invalid literal\/length code/, dyn({ lit: lens(257, { 65: 1, 256: 2 }), dist: [1], data: [] }), "an incomplete literal/length code of more than one length-1 code");
  refusedAs(/an invalid distance code/, dyn({ lit: okLit, dist: [1, 1, 1], data: [] }), "an over-subscribed distance code");
  refusedAs(/an invalid distance code/, dyn({ lit: okLit, dist: [1, 2], data: [] }), "an incomplete distance code of more than one length-1 code");
  refusedAs(/an invalid Huffman code/, dyn({ lit: lens(258, { 65: 1, 256: 2, 257: 2 }), dist: [1], data: [["lit", 65], ["lit", 257], ["bits", 1, 1]] }), "a distance outside a one-code distance code");
  bits.length = 0;
  put(1, 1), put(1, 2), putCode(0xc6, 8);
  refusedAs(/an invalid length symbol/, raw(pack()), "the reserved length symbol 286");
  bits.length = 0;
  put(1, 1), put(1, 2), putCode(0x71, 8), putCode(1, 7), putCode(30, 5);
  // (the fixed distance code has 30 symbols, as in zlib, so 30 and 31 are bit patterns no symbol has; a dynamic one has at
  //  most 30 too: the distance-symbol check behind them is a second fence)
  refusedAs(/an invalid Huffman code/, raw(pack()), "the reserved distance symbol 30, in a fixed block");

  let threw = null;
  try {
    new GzipInflater(() => {}, { total: 10, ratio: 0.5 });
  } catch (e) {
    threw = e;
  }
  ok(threw instanceof RangeError, "a ratio cap under 1 is refused (with one of at least 1, stored data never passes it, whatever the chunking)");
}

// ======== the ratio cap: the same byte, however the input is chunked ========
{
  const bomb = gzipSync(new Uint8Array(30 * MiB), { level: 9 });
  const msgs = [1, 4096, bomb.length].map((chunk) => extract(bomb, { chunk }).err);
  ok(msgs.every((e) => e?.code === "cap-ratio"), "a gzip bomb (30 MiB of zeros): refused by the ratio cap while it decompresses", msgs.map((e) => e?.code));
  ok(new Set(msgs.map((e) => e?.message)).size === 1, "…at the same output byte and compressed count for 1-byte, 4 KiB and whole-body input", msgs.map((e) => e?.message));
  const m = /at byte (\d+), after (\d+) compressed/.exec(msgs[0]?.message ?? "");
  ok(m && Number(m[1]) === 100 * Number(m[2]) + 1, "…the first byte over 100 times the compressed bytes consumed", m?.slice(1));
  ok(Number(m?.[1]) < 30 * MiB, "…long before the whole bomb is inflated");
  // (the decoder itself stops exactly at the cap: its output is ratio × consumed, or the total, to the byte)
  const stop = (limits, g, chunk = g.length) => {
    const inf = new GzipInflater(() => {}, limits);
    let err = null;
    try {
      for (let i = 0; i < g.length; i += chunk) inf.push(g.subarray(i, i + chunk));
      inf.end();
    } catch (e) {
      err = e;
    }
    return { inf, err };
  };
  let s = stop({ total: 2 ** 40, ratio: 100 }, bomb);
  ok(s.err?.code === "cap-ratio" && s.inf.out === 100 * s.inf.consumed, "the inflater stops at exactly 100 × the compressed bytes consumed", { out: s.inf.out, consumed: s.inf.consumed });
  s = stop({ total: 123457, ratio: 1e9 }, bomb);
  ok(s.err?.code === "cap-total" && s.inf.out === 123457, "…and at exactly the total cap", { out: s.inf.out });
  s = stop({ total: 1000, ratio: 1e9 }, gzipSync(acgt(5000), { level: 0 }));
  ok(s.err?.code === "cap-total" && s.inf.out === 1000, "…in a stored block too", { out: s.inf.out });
  const runs = [bomb.length, 1, 4096].map((chunk) => stop({ total: 2 ** 40, ratio: 100 }, bomb, chunk)).map((r) => JSON.stringify([r.err?.code, r.inf.out, r.inf.consumed]));
  ok(new Set(runs).size === 1 && JSON.parse(runs[0])[0] === "cap-ratio", "…at the same byte, after the same compressed count, for whole-body, 1-byte and 4 KiB input", runs);
  for (const bad of [{ total: 1.5, ratio: 100 }, { total: -1, ratio: 100 }, { total: NaN, ratio: 100 }, { total: 10, ratio: Infinity }]) {
    let t = null;
    try {
      new GzipInflater(() => {}, bad);
    } catch (e) {
      t = e;
    }
    ok(t instanceof RangeError, `limits refused: ${JSON.stringify(bad)}`);
  }
  // (the edge: the same data with the ratio just at its overall expansion passes, just under refuses)
  const data = tar(file("a.txt", new Uint8Array(400000)));
  const g = gzipSync(data, { level: 9 });
  let need = 1;
  for (let lo = 1, hi = 100000; lo <= hi; ) {
    const mid = (lo + hi) >> 1;
    if (extract(g, { caps: { ratio: mid } }).err) lo = mid + 1;
    else (need = mid), (hi = mid - 1);
  }
  ok(!extract(g, { caps: { ratio: need } }).err && extract(g, { caps: { ratio: need - 1 } }).err?.code === "cap-ratio", `the ratio cap's edge: ${need} passes, ${need - 1} refuses`);
}

// ======== tar shapes, entry types and the result ========
const sniffRecorded = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "arxiv-recorded.json"), "utf8"));
{
  const content = "\\documentclass{article}\\begin{document}x\\end{document}\n";
  const archive = tar(dir("./"), dir("paper/"), file("paper/main.tex", content), file("./paper/fig.eps", "%!PS"), file("README", "hi"),
    file("x.tex", "y", { prefix: "deep/er" }), file("gnu.txt", "g", { format: "gnu" }), file("v7.txt", "v", { format: "v7", type: "\u0000" }),
    file("v7dir/", "", { format: "v7", type: "0" }), file("s.txt", "signed", { signedSum: true, name: "s\u00e9.txt" }));
  const g = gz(archive);
  const r = accepts(g, "a tar.gz with ustar (and its prefix), GNU and v7 headers, a v7 folder and a signed checksum");
  ok(r?.shape === "tar", "…its shape is tar");
  ok(JSON.stringify(paths(r)) === JSON.stringify(["paper/main.tex", "paper/fig.eps", "README", "deep/er/x.tex", "gnu.txt", "v7.txt", "sé.txt"]), "…the files kept, in archive order, `./` dropped, the prefix joined", paths(r));
  ok(JSON.stringify(r?.dirs) === JSON.stringify(["deep", "paper", "v7dir", "deep/er"]), "…every folder, explicit and implicit, parents first", r?.dirs);
  ok(text(r.files[0]) === content && r.files[0].sha256 === sha(bytes(content)), "…a file's bytes and SHA-256");
  ok(r?.tarSha256 === sha(g) && r.compressed === g.length && r.expanded === archive.length, "…the download's SHA-256, its size and the expanded size");
  for (const chunk of [1, 4096]) ok(JSON.stringify(extract(g, { chunk }).r) === JSON.stringify(r), `…the same result for ${chunk}-byte input`);
  const skip = tar(...["1", "2", "3", "4", "6", "7", "S", "V", "M", "Z"].map((t) => entry({ name: `e${t}`, type: t }, t === "7" || t === "S" ? "data!" : "")), file("kept.txt", "k"));
  const rs = accepts(gz(skip), "links, devices, FIFOs, contiguous, sparse, volume, multi-volume and unknown entries");
  ok(JSON.stringify(paths(rs)) === JSON.stringify(["kept.txt"]) && rs.skippedCount === 10, "…skipped, never followed; their data skipped too", { files: paths(rs), n: rs?.skippedCount });
  ok(rs?.skipped.map((s) => s.type).join("|") === "a hard link|a symbolic link|a character device|a block device|a FIFO|a contiguous file|a GNU sparse file|a GNU volume header|a GNU multi-volume part|an entry of type \"Z\"", "…and listed by kind", rs?.skipped);
  const many = accepts(gz(tar(...Array.from({ length: 150 }, (_, i) => entry({ name: `l${i}`, type: "2" })))), "150 skipped links");
  ok(many?.skippedCount === 150 && many.skipped.length === 100, "…counted, with the first 100 listed");
  ok(accepts(gz(tar(file("a", "1")), { level: 0 }), "a stored (level 0) tar.gz") !== undefined, "…stored blocks read");
}

// ======== pax and GNU long names ========
{
  const long = "d/" + "n".repeat(150) + ".tex";
  let r = accepts(gz(tar(pax([["path", long], ["mtime", "1.5"]]), file("short"), file("next"))), "a pax path");
  ok(JSON.stringify(paths(r)) === JSON.stringify([long, "next"]), "…applies to the next entry only", paths(r));
  r = accepts(gz(tar(pax([["size", "3"]]), entry({ name: "sized", size: 99 }, "abc"))), "a pax size");
  ok(r && text(r.files[0]) === "abc", "…overrides the header's size");
  r = accepts(gz(tar(gnuL(long), file("short", "x", { format: "gnu" }), file("after"))), "a GNU long name");
  ok(JSON.stringify(paths(r)) === JSON.stringify([long, "after"]), "…applies to the next entry only", paths(r));
  r = accepts(gz(tar(pax([["path", "global.txt"]], { type: "g" }), file("plain"))), "a pax global header");
  ok(JSON.stringify(paths(r)) === JSON.stringify(["plain"]), "…is ignored, never applied", paths(r));
  r = accepts(gz(tar(pax([["path", "p/from-pax"]]), file("n", "", { prefix: "pre" }))), "a pax path over a ustar prefix");
  ok(JSON.stringify(paths(r)) === JSON.stringify(["p/from-pax"]), "…wins", paths(r));
  refuses("meta", gz(tar(pax([["path", "a"]]), pax([["path", "b"]]), file("c"))), "two pax headers in a row");
  refuses("meta", gz(tar(pax([["path", "a"]]), gnuL("b"), file("c"))), "a pax header then a GNU long name");
  refuses("meta", gz(tar(gnuL("a"), pax([["path", "b"]]), file("c"))), "a GNU long name then a pax header");
  refuses("meta", gz(tar(pax([["path", "a"]]))), "a pax header with no entry after it");
  refuses("meta", gz(tar(pax("11 path=abc\n"), file("x"))), "a pax record whose length is one short");
  refuses("meta", gz(tar(pax("13 path=abc\n"), file("x"))), "a pax record whose length is one long");
  accepts(gz(tar(pax("12 path=abc\n"), file("x"))), "(the same record with its exact length)");
  refuses("meta", gz(tar(pax("013 path=abc\n"), file("x"))), "a pax record length with a leading zero");
  refuses("meta", gz(tar(pax("12 path=abcd"), file("x"))), "a pax record without its newline");
  refuses("meta", gz(tar(pax("11 pathabc\n"), file("x"))), "a pax record without \"=\"");
  refuses("meta", gz(tar(pax([["path", "a"], ["path", "b"]]), file("x"))), "two pax path records");
  refuses("sparse", gz(tar(pax([["GNU.sparse.size", "10"]]), file("x"))), "a sparse pax entry");
  refuses("size", gz(tar(pax([["size", "1e3"]]), file("x"))), "a pax size that isn't decimal");
  refuses("size", gz(tar(pax([["size", "9007199254740993"]]), file("x"))), "a pax size past the safe integers");
  refuses("name", gz(tar(pax(cat(bytes("13 path=a"), Uint8Array.of(0xff), bytes("bc\n"))), file("x"))), "a pax path that isn't UTF-8");
}

// ======== names ========
{
  const deep = Array.from({ length: CAPS.maxDepth }, (_, i) => "d" + i).join("/");
  const longPath = ("p".repeat(200) + "/").repeat(5).slice(0, CAPS.maxPath);
  accepts(gz(tar(pax([["path", deep]]), file("x"), pax([["path", longPath]]), file("y"))), `a path ${CAPS.maxDepth} folders deep and one of ${CAPS.maxPath} characters`);
  for (const [n, msg] of [
    ["", "an empty name"], ["a\u0001b", "a control character"], ["a\\b", "a backslash"], ["/etc/passwd", "an absolute name"],
    ["C:x", "a drive letter"], ["a/../b", "a \"..\" part"], ["a//b", "an empty part"], ["./", "a file named \"./\""], ["a/./b", "a \".\" part"],
    [deep + "/f", "one folder too deep"], ["x".repeat(256), "a part over 255 characters"], [longPath + "q", "a path one character too long"],
  ]) refuses("name", gz(tar(pax([["path", n]]), file("x"))), `a name with ${msg}`);
  refuses("name", gz(tar(file(Uint8Array.of(0x62, 0x61, 0xff)), file("x"))), "a header name that isn't UTF-8");
  refuses("duplicate", gz(tar(file("a.tex"), file("a.tex"))), "the same file twice");
  refuses("duplicate", gz(tar(pax([["path", "caf\u00e9.tex"]]), file("x"), pax([["path", "cafe\u0301.tex"]]), file("y"))), "two names that look the same (the same NFC form)");
  refuses("duplicate", gz(tar(dir("d/"), dir("d/"))), "the same folder twice");
  refuses("conflict", gz(tar(file("a"), file("a/b"))), "a file, then a file inside it");
  refuses("name", gz(tar(entry({ name: "../outside", type: "2" }), file("x"))), "a skipped link named \"../outside\"");
  refuses("name", gz(tar(pax([["path", "a\u0007b"]]), entry({ name: "l", type: "2" }), file("x"))), "a skipped link whose pax name has a control character");
  accepts(gz(tar(entry({ name: "dumpdir/", type: "D" }), file("x"))), "a skipped entry whose name ends with \"/\"");
  refuses("name", gz(tar(dir(""), file("x"))), "a folder with an empty name");
  refuses("conflict", gz(tar(file("a/b"), file("a"))), "a file whose name is an earlier file's folder");
  refuses("conflict", gz(tar(file("a"), dir("a/"))), "a file and a folder with the same name");
  accepts(gz(tar(file("a/b"), dir("a/"))), "a folder named after a file inside it implied it");
}

// ======== headers, sizes and the end ========
{
  const h = header({ name: "x" });
  ok(headerFormat(h) === "ustar" && headerFormat(header({ name: "x", format: "gnu" })) === "gnu" && headerFormat(header({ name: "x", format: "v7" })) === "v7", "headerFormat: ustar, GNU and v7");
  refuses("checksum", gz(tar(file("first"), entry({ name: "x", checksum: 1234 }), file("y"))), "a header whose checksum doesn't match");
  refuses("format", gz(tar(entry({ name: "x", checksum: 1234 }, "\\documentclass"), file("y"))), "a first header whose checksum doesn't match: not a tar, and not TeX text either");
  refuses("checksum", gz(tar(file("first"), entry({ name: "x", checksum: 1234, type: "2" }))), "a skipped entry's bad checksum");
  refuses("header", gz(tar(file("first"), entry({ name: "x", magic: "ustar\u000001" }))), "an unknown magic");
  refuses("size", gz(tar(file("first"), entry({ name: "x", sizeField: Uint8Array.of(0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1) }))), "a base-256 size");
  refuses("size", gz(tar(file("first"), entry({ name: "x", sizeField: "000000000001" }))), "a size of 12 octal digits");
  refuses("size", gz(tar(file("first"), entry({ name: "x", sizeField: "0000000001x\u0000" }))), "a size with junk after it");
  refuses("end", gz(cat(file("a", "1"))), "an archive without its end marker");
  refuses("trailing", gz(cat(file("a", "1"), END, Uint8Array.of(0, 0, 7))), "data after the end marker");
  refuses("end", gz(cat(file("a", "1"), new Uint8Array(512))), "a single zero block, half an end marker");
  refuses("end", gz(cat(file("a", "1"), new Uint8Array(1023))), "an end marker one byte short");
  const modeX = (() => { const h = header({ name: "x" }); h[100] = 0x78; h.fill(0x20, 148, 156); let s = 0; for (const b of h) s += b; h.set(enc.encode(s.toString(8).padStart(6, "0") + "\u0000 "), 148); return h; })();
  refuses("header", gz(tar(file("first"), modeX)), "a mode field with a letter (checksum right)");
  const b256 = (() => { const h = header({ name: "x" }); h.set([0x80, 0, 0, 0, 0, 0, 0, 1], 108); h.fill(0, 136, 148); h.fill(0x20, 148, 156); let s = 0; for (const b of h) s += b; h.set(enc.encode(s.toString(8).padStart(6, "0") + "\u0000 "), 148); return h; })();
  accepts(gz(tar(file("first"), b256)), "a base-256 uid and an empty mtime");
  accepts(gz(cat(file("paper.tex", acgt(2000)), new Uint8Array(10240 - 2560))), "zero padding to a 10 KiB record");
  ok(sniff(bytes("%PDF-1.5")) === "pdf" && sniff(Uint8Array.of(0x1f, 0x8b, 8)) === "gzip" && sniff(bytes("<!DOCTYPE html>")) === "other", "sniff: gzip, PDF and anything else");
  const rec = Object.fromEntries(sniffRecorded.rows.map((r) => [r.case, r]));
  ok(sniff(Buffer.from(rec["pdf-only"].first_bytes_b64, "base64")) === "pdf" && rec["pdf-only"].status === 200, "recorded: a PDF-only paper's source is a PDF (200)");
  ok(sniff(Buffer.from(rec.withdrawn.first_bytes_b64, "base64")) === "other" && rec.withdrawn.status === 404, "recorded: a withdrawn version is a 404 HTML page");
  const cors = (r) => r.headers.some(([k]) => k.toLowerCase() === "access-control-allow-origin");
  ok(cors(rec["pdf-only"]) && !cors(rec.withdrawn) && !cors(rec["missing-version"]), "recorded: CORS on the PDF only; none on the withdrawn and missing versions' 404s");
}

// ======== the single gzipped file ========
{
  const tex = "\\documentclass{amsart}\n\\begin{document}Hi\\end{document}\n";
  let r = accepts(gz(tex), "a single gzipped TeX file");
  ok(r?.shape === "single" && JSON.stringify(paths(r)) === '["main.tex"]' && text(r.files[0]) === tex, "…kept as main.tex");
  r = accepts(gz(cat(bytes("\\documentstyle{article}\n% caf"), Uint8Array.of(0xe9), bytes("\n"), bytes("x".repeat(600)))), "a Latin-1 one, longer than a block");
  refuses("format", gz("just some text, no class\n"), "a single file that isn't TeX");
  refuses("format", gz(cat(bytes("\\documentclass{a}"), Uint8Array.of(0, 1, 2))), "a single binary file");
  refuses("format", gz("% \\documentclass{article}\n"), "a single file whose class is commented out");
  accepts(gz("% an old Mac file\r\\documentclass{article}\r"), "a single TeX file with CR line ends (a comment ends at CR)");
}

// ======== the caps, each at its edge and one past (the real caps) ========
{
  // headers: every block counts, the end marker included
  const links = (n) => Array.from({ length: n }, (_, i) => entry({ name: `l${i}`, type: "2" }));
  accepts(gz(tar(...links(CAPS.headers - 1))), `${CAPS.headers} headers, the end marker included`);
  refuses("cap-headers", gz(tar(...links(CAPS.headers))), `${CAPS.headers + 1} headers`);
  refuses("cap-headers", gz(tar(...links(10000))), "10,000 empty headers");
  // kept files
  const files = (n) => Array.from({ length: n }, (_, i) => file(`f${i}`));
  accepts(gz(tar(...files(CAPS.files))), `${CAPS.files} files`);
  refuses("cap-files", gz(tar(...files(CAPS.files + 1))), `${CAPS.files + 1} files`);
  // created entries, implicit folders counted: 1,000 files at depth 5 make 5,000 entries from 1,001 headers
  const deepFiles = Array.from({ length: 1000 }, (_, i) => file(`r${i}/a/b/c/f`));
  const re = accepts(gz(tar(...deepFiles)), "5,000 created entries (1,000 files and 4,000 implicit folders)");
  ok(re && re.files.length + re.dirs.length === 5000, "…all counted", re && re.files.length + re.dirs.length);
  refuses("cap-entries", gz(tar(...deepFiles, dir("one-more/"))), "5,001 created entries, with the headers far under their cap");
  // pax and GNU metadata, refused before anything is allocated
  const paxAt = (n) => {
    let k = n - 16;
    while (paxRecord("comment", "x".repeat(k)).length < n) k++;
    const recs = paxRecord("comment", "x".repeat(k));
    if (recs.length !== n) throw new Error("pax size");
    return gz(tar(pax(recs), file("after")));
  };
  const pm = accepts(paxAt(CAPS.meta), `a pax header of ${CAPS.meta} bytes`);
  ok(pm?.peak === FIXED_BYTES + CAPS.meta, "…its payload counted while it is held", pm?.peak);
  let e = extract(paxAt(CAPS.meta + 1));
  ok(e.err?.code === "cap-meta" && e.x.peak === FIXED_BYTES, `a pax header of ${CAPS.meta + 1} bytes: refused (cap-meta), with nothing allocated for it`, { code: e.err?.code, peak: e.x.peak });
  ok(CAPS.longName === 3072, "the GNU long-name bound is 3 UTF-8 bytes per code unit of MAX_PATH (3,072), under 4 KiB");
  const lAt = (n) => gz(tar(gnuL("long/name.tex", n), file("ignored", "", { format: "gnu" })));
  const la = accepts(lAt(CAPS.longName), `a GNU long name of ${CAPS.longName} bytes`);
  ok(JSON.stringify(paths(la)) === '["long/name.tex"]', "…read to its NUL");
  e = extract(lAt(CAPS.longName + 1));
  ok(e.err?.code === "cap-longname" && e.x.peak === FIXED_BYTES, `a GNU long name of ${CAPS.longName + 1} bytes: refused (cap-longname) before allocation`, { code: e.err?.code, peak: e.x.peak });
  // per file: the header's size is checked before anything is allocated
  const big = acgt(CAPS.perFile);
  const pf = accepts(gz(tar(file("big.tex", big)), { level: 1, huffman: true }), `a file of ${CAPS.perFile} bytes`);
  ok(pf && pf.files[0].sha256 === sha(big), "…its bytes intact");
  ok(pf && pf.peak === FIXED_BYTES + CAPS.perFile, "…the accounted peak: the fixed buffers and the file's exact size", pf?.peak);
  e = extract(gz(tar(entry({ name: "big.tex", size: CAPS.perFile + 1 }, new Uint8Array(0)))));
  ok(e.err?.code === "cap-file" && e.x.peak === FIXED_BYTES, `a file of ${CAPS.perFile + 1} bytes: refused (cap-file) at its header, before allocation`, { code: e.err?.code, peak: e.x.peak });
  // the expanded total: every decompressed byte, the end marker and what follows it included
  const second = 100 * MiB - CAPS.perFile - 4 * 512;
  const total = cat(header({ name: "a", size: CAPS.perFile }), big, header({ name: "b", size: second }), acgt(second, 7), END);
  ok(total.length === CAPS.total, "(an archive of exactly 100 MiB)");
  const tg = gz(total, { level: 1, huffman: true });
  const ta = accepts(tg, `an archive that expands to exactly ${CAPS.total} bytes`);
  ok(ta?.expanded === CAPS.total && tg.length < CAPS.download, "…all of it counted, and its download under the download cap", { expanded: ta?.expanded, compressed: tg.length });
  e = extract(gz(cat(total, new Uint8Array(1)), { level: 1, huffman: true }));
  ok(e.err?.code === "cap-total" && /at byte 104857601\b/.test(e.err.message), `one more zero byte after the end marker: refused (cap-total) at byte ${CAPS.total + 1}`, e.err?.message);
  // the download: an exact size reached with the gzip header's extra field, which the inflater reads and skips
  const body = tar(file("noise.bin", acgt(CAPS.download - 66000, 11)));
  const base = gz(body, { level: 0 });
  const extraLen = CAPS.download - base.length - 2;
  ok(extraLen >= 0 && extraLen < 65536, "(a stored archive, padded to exactly 50 MiB by its gzip header's extra field)", extraLen);
  const at = gz(body, { level: 0, extra: new Uint8Array(extraLen) });
  const da = accepts(at, `a download of exactly ${CAPS.download} bytes`);
  ok(at.length === CAPS.download && da?.compressed === CAPS.download, "…counted to the byte");
  e = extract(gz(body, { level: 0, extra: new Uint8Array(extraLen + 1) }));
  ok(e.err?.code === "cap-download", `a download of ${CAPS.download + 1} bytes: refused (cap-download)`, e.err?.code);
  // the single-file shape: 1 MiB chunks counted by capacity, and the join counted too
  const single = cat(bytes("\\documentclass{article}\n"), acgt(CAPS.perFile - 24, 3));
  const sa = accepts(gz(single, { level: 1, huffman: true }), `a single gzipped TeX file of ${CAPS.perFile} bytes`);
  ok(sa && sa.files[0].bytes.length === CAPS.perFile && sa.files[0].sha256 === sha(single), "…kept whole");
  ok(sa?.peak === FIXED_BYTES + 64 * MiB + CAPS.perFile, "…the accounted peak: 64 one-MiB chunks plus the joined copy, plus the fixed buffers", sa?.peak);
  e = extract(gz(cat(single, bytes("x")), { level: 1, huffman: true }));
  ok(e.err?.code === "cap-file", `a single gzipped file of ${CAPS.perFile + 1} bytes: refused (cap-file)`, e.err?.code);
  ok(e.x.peak <= FIXED_BYTES + 64 * MiB, "…before a 65th chunk or a join is allocated", e.x.peak);
  // a declared size must fit under what the expanded cap has left, skipped data included, before allocation
  e = extract(gz(tar(entry({ name: "s", type: "7" }, acgt(5000)), entry({ name: "f", size: 4000 }))), { caps: { total: 10000 } });
  ok(e.err?.code === "cap-total" && e.x.peak === FIXED_BYTES, "a file declared after 5,000 skipped bytes, under a 10,000-byte expanded cap: refused (cap-total) at its header, before allocation", { code: e.err?.code, peak: e.x.peak });
  ok(!extract(gz(tar(entry({ name: "s", type: "7" }, acgt(5000)), file("f", acgt(2000)))), { caps: { total: 10000 } }).err, "…and one that fits passes");
  // the budget backstop
  refuses("cap-budget", gz(tar(file("a", acgt(5000)))), "a file over a lowered budget", { caps: { budget: FIXED_BYTES + 4999 } });
}

// ======== the tarball's hash is computed while streaming, never by WebCrypto over a whole buffer ========
{
  const subtle = globalThis.crypto?.subtle;
  const calls = [];
  const real = subtle?.digest;
  if (subtle) subtle.digest = (...a) => (calls.push(a[1]?.byteLength), Promise.reject(new Error("no whole-buffer digests")));
  const g = gz(tar(file("a.tex", acgt(3 * MiB))), { level: 1, huffman: true });
  const r = extract(g, { chunk: 1000 }).r;
  if (subtle) subtle.digest = real;
  ok(r?.tarSha256 === sha(g) && calls.length === 0, "the download's SHA-256 is computed incrementally over 1,000-byte pieces, with a WebCrypto that refuses whole buffers never called", { calls: calls.length });
}

// ======== main-file detection ========
{
  const doc = (s) => bytes(`\\documentclass{article}\n${s}`);
  const f = (path, b) => ({ path, bytes: bytes(b) });
  let m = mainFileOf([f("a.tex", doc("")), f("b.tex", doc("")), f("00README.json", JSON.stringify({ sources: [{ filename: "./b.tex", usage: "toplevel" }] }))]);
  ok(m.main === "b.tex" && m.via === "00README.json" && JSON.stringify(m.others) === '["a.tex"]', "00README.json's toplevel source", m);
  m = mainFileOf([f("a.tex", doc("")), f("b.tex", doc("")), f("00README.json", JSON.stringify({ sources: [{ filename: "../etc/x.tex", usage: "toplevel" }] }))]);
  ok(m.main === "a.tex" && m.via === "tex", "…a hint that isn't a kept .tex file is ignored", m);
  m = mainFileOf([f("a.tex", doc("")), f("b.tex", doc("")), f("00README.XXX", "fig.eps ignore\nb.tex toplevelfile\n")]);
  ok(m.main === "b.tex" && m.via === "00README.XXX", "00README.XXX's toplevelfile", m);
  m = mainFileOf([f("sec.tex", "\\section{x}"), f("paper.tex", doc(""))]);
  ok(m.main === "paper.tex" && m.others.length === 0, "one \\documentclass file", m);
  m = mainFileOf([f("a.tex", doc("")), f("b.tex", doc("\\input{a}")), f("c.tex", doc("\\include c-part"))]);
  ok(m.main === "b.tex" && JSON.stringify(m.others) === '["a.tex","c.tex"]', "several: the one no other file \\input's, then the first by name", m);
  m = mainFileOf([f("a.tex", doc("")), f("b.tex", doc("\\input{x}\n".repeat(1000) + "\\input{a}"))]);
  ok(m.main === "b.tex", "every \\input of a file is seen, the 1,001st too", m);
  m = mainFileOf([f("a.tex", doc("")), f("a.tex.tex", doc("")), f("z.tex", doc("\\input{a.tex}"))]);
  ok(m.main === "a.tex.tex", "\\input{a.tex} names a.tex only, not a.tex.tex", m);
  m = mainFileOf([f("a.tex", doc("")), f("b.tex", doc("")), f("00README.XXX", "fig.eps ignore\rb.tex toplevelfile\r")]);
  ok(m.main === "b.tex" && m.via === "00README.XXX", "00README.XXX with CR line ends", m);
  m = mainFileOf([f("a.tex", doc("\\input{a}")), f("b.tex", doc(""))]);
  ok(m.main === "a.tex", "a file that \\input's itself isn't counted as included by another", m);
  m = mainFileOf([f("a.tex", "% \\documentclass{article}\n"), f("b.tex", "\\% \\documentclass{article}")]);
  ok(m.main === "b.tex", "a commented-out \\documentclass is ignored; an escaped \\% doesn't start a comment", m);
  ok(!hasDocumentClass(bytes("\\\\% \\documentclass")) && !hasDocumentClass(bytes("\\documentclassx")), "a % after an escaped backslash starts a comment; \\documentclassx isn't \\documentclass");
  ok(JSON.stringify(texInputs(bytes("\\input{a/b} \\input c.tex \\include{d}\\includegraphics{e} % \\input{f}\n\\inputencoding{g}"))) === '["a/b","c.tex","d"]', "\\input and \\include arguments, outside comments");
  ok(texInputs(bytes("\\input{x}".repeat(1001))).length === 1000, "texInputs lists at most 1,000");
  m = mainFileOf([f("a.tex", doc("")), f("b.tex", doc("\\input\n  {a}"))]);
  ok(m.main === "b.tex", "\\input with its argument on the next line", m);
  m = mainFileOf([f("a.tex", doc("")), f("b.tex", doc("")), f("00README.json", '{"sources":[{"filename":"b.tex","usage":"toplevel"}],"n":' + "1".repeat(65) + "}")]);
  ok(m.main === "b.tex" && m.via === "00README.json", "a 00README.json with a 65-digit number", m);
  const readme = (n) => {
    const head = JSON.stringify({ sources: [{ filename: "b.tex", usage: "toplevel" }] });
    return head + " ".repeat(n - head.length);
  };
  m = mainFileOf([f("a.tex", doc("")), f("b.tex", doc("")), f("00README.json", readme(HINT_MAX))]);
  ok(m.main === "b.tex", `a 00README.json of ${HINT_MAX} bytes is read`);
  m = mainFileOf([f("a.tex", doc("")), f("b.tex", doc("")), f("00README.json", readme(HINT_MAX + 1))]);
  ok(m.main === "a.tex" && m.via === "tex", `one of ${HINT_MAX + 1} bytes is ignored unread, and TeX detection decides`);
  const nest = (d) => "[".repeat(d) + "]".repeat(d);
  ok(parseBoundedJson(nest(8)) !== undefined && parseBoundedJson(nest(9)) === undefined, "JSON: depth 8 read, depth 9 ignored");
  const vals = (n) => "[" + Array(n - 1).fill("0").join(",") + "]";
  ok(parseBoundedJson(vals(1000)) !== undefined && parseBoundedJson(vals(1001)) === undefined, "JSON: 1,000 values read, 1,001 ignored");
  const proto = parseBoundedJson('{"__proto__": {"polluted": 1}}');
  ok(Object.getPrototypeOf(proto) === null && proto.__proto__.polluted === 1 && {}.polluted === undefined, "JSON: \"__proto__\" is only a key");
  ok(parseBoundedJson('{"a":1,}') === undefined && parseBoundedJson("[1] x") === undefined && JSON.stringify(parseBoundedJson('{"s":"\\u00e9\\n"}')) === '{"s":"é\\n"}', "JSON: strict syntax, escapes");
  ok(isTexText(cat(bytes("\\documentclass{a} caf"), Uint8Array.of(0xe9))) && !isTexText(cat(bytes("\\documentclass{a}"), Uint8Array.of(0))), "TeX text: Latin-1 is text, a NUL isn't");
}

console.log(failures ? `${failures} of ${count} FAILED` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
