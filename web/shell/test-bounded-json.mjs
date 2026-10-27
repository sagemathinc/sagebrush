// The documents' bounded serializer (web/shell/bounded-json.ts; LIMIT-BASH-S2-R2-1, CORR-BASH-S2-R2-2):
// exactly JSON.stringify(v, null, 1) + "\n" in UTF-8, refused past its cap without building any value, key
// or text whole, in a number of chunks that follows the output's bytes, not its tokens.
//   bun web/shell/test-bounded-json.mjs
import { boundedJson, TooLarge, CHUNK_BYTES } from "./bounded-json.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => {
  checks++;
  if (!ok) fails.push(what);
};
const enc = new TextEncoder();
const want = (v) => enc.encode(JSON.stringify(v, null, 1) + "\n");
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// The seam: every string JSON.stringify or TextEncoder.encode is given while boundedJson runs, by length.
// The serializer must give them nothing: no value, key or text is stringified or encoded to learn its size.
const realStringify = JSON.stringify, realEncode = TextEncoder.prototype.encode;
function watched(f) {
  const seen = { stringify: 0, encode: 0, longest: 0 };
  JSON.stringify = function (v, ...a) {
    seen.stringify++;
    if (typeof v === "string") seen.longest = Math.max(seen.longest, v.length);
    return realStringify.call(this, v, ...a);
  };
  TextEncoder.prototype.encode = function (s) {
    seen.encode++;
    seen.longest = Math.max(seen.longest, String(s).length);
    return realEncode.call(this, s);
  };
  try {
    return { seen, out: f() };
  } catch (err) {
    return { seen, err };
  } finally {
    JSON.stringify = realStringify;
    TextEncoder.prototype.encode = realEncode;
  }
}
// a refusal past `max`, built from at most one chunk past it, with nothing handed to stringify or encode
function refused(what, v, max) {
  const stats = {};
  const { seen, err } = watched(() => boundedJson(v, max, stats));
  check(err instanceof TooLarge && seen.stringify === 0 && seen.encode === 0 && stats.bytes === max && stats.chunks <= Math.ceil(max / CHUNK_BYTES) + 1,
    `${what}: TooLarge at the cap (${max} B), from ${stats.chunks} chunk(s), nothing stringified or encoded (${err}, ${JSON.stringify(seen)}, ${JSON.stringify(stats)})`);
}

// (a) one ordinary string far over the cap
refused("one 1,000,000-character string, cap 64", { cells: [{ source: "a".repeat(1e6) }] }, 64);
refused("one 1,000,000-character string at the top, cap 64", "a".repeat(1e6), 64);
// (b) strings under the cap in characters, over it only once escaped or encoded
refused("40 control characters (6 bytes each escaped), cap 100", "\u0001".repeat(40), 100);
refused("40 lone surrogates (6 bytes each escaped), cap 100", "\ud800".repeat(40), 100);
refused("40 euro signs (3 bytes each in UTF-8), cap 100", "€".repeat(40), 100);
refused("40 quotes (2 bytes each escaped), cap 60", '"'.repeat(40), 60);
// (c) one key far over the cap
refused("one 1,000,000-character key, cap 64", { ["k".repeat(1e6)]: 1 }, 64);
refused("one key of 40 lone low surrogates, cap 100", { ["\udc00".repeat(40)]: 1 }, 100);

// at the cap exactly: accepted; one byte under it: refused
{
  const v = { a: ["x€😀", 1.5, null, true] }, w = want(v);
  check(same(boundedJson(v, w.length), w), `a text of exactly the cap's ${w.length} bytes is accepted`);
  let err = null;
  try {
    boundedJson(v, w.length - 1);
  } catch (e) {
    err = e;
  }
  check(err instanceof TooLarge, "one byte under the text's size: TooLarge");
}

// (d) millions of tiny values: the chunks follow the bytes written, not the tokens
{
  const tiny = new Array(2_000_000).fill(0);
  const stats = {};
  const { seen, out } = watched(() => boundedJson(tiny, 64 << 20, stats));
  const w = want(tiny);
  check(same(out, w) && seen.encode === 0 && seen.stringify === 0, `2,000,000 zeros: JSON.stringify's ${w.length} bytes, nothing stringified or encoded (${JSON.stringify(seen)})`);
  check(stats.chunks === Math.ceil(w.length / CHUNK_BYTES) && stats.bytes === w.length,
    `2,000,000 values (${w.length} B): ${stats.chunks} chunks of ${CHUNK_BYTES} B, ceil(bytes / chunk) (${JSON.stringify(stats)})`);
  // the same bytes as one string: the same number of chunks, one token instead of 2,000,000
  const one = "z".repeat(w.length - 3);
  const s1 = {};
  const o1 = boundedJson(one, 64 << 20, s1);
  check(o1.length === w.length && s1.chunks === stats.chunks, `one string of the same ${o1.length} bytes: the same ${s1.chunks} chunks`);
  // a million tiny keys, refused at a small cap: the chunks held stay the cap's
  const keys = {};
  for (let i = 0; i < 1_000_000; i++) keys["k" + i] = i;
  refused("1,000,000 keys, cap 100,000", keys, 100_000);
  const sk = {};
  const ok = boundedJson(keys, 64 << 20, sk);
  check(same(ok, want(keys)) && sk.chunks === Math.ceil(ok.length / CHUNK_BYTES), `1,000,000 keys: JSON.stringify's bytes, ${sk.chunks} chunks for ${ok.length} B`);
}

// (e) Unicode and formatting parity with JSON.stringify(v, null, 1) + "\n"
{
  const units = [];
  for (let c = 0; c < 0x20; c++) units.push(String.fromCharCode(c));
  units.push('"', "\\", "/", "\u007f", "\u0080", "߿", "ࠀ", "￿", "﻿", " ", " ", "😀", "\ud800", "\udbff", "\udc00", "\udfff",
    "\udc00\ud800", "a\ud800", "\ud800a", "\ud83d😀", "😀\ude00", "é", "\u{10ffff}", "\u{10000}");
  for (const u of units) {
    const v = { [u]: [u, "x" + u + "y"] };
    check(same(boundedJson(v, 1e6), want(v)), `parity for ${realStringify(u)} as a key and in values`);
  }
  const docs = [0, -0, 1e21, 1e-7, 123.456, -1, NaN, Infinity, null, true, false, "", [], {}, [[]], [{}], { a: {} }, { "2": 1, "1": 2, b: 3, a: 4 },
    { u: undefined, f: () => 1, s: Symbol("x"), k: 1 }, [undefined, () => 1, Symbol("y")], { d: new Date(0) }, { t: { toJSON: (k) => "key " + k } },
    { cells: [{ cell_type: "code", source: "print('héllo')\n", outputs: [{ text: ["a\n", "b"] }] }], metadata: { nested: [1, [2, [3, { x: "y" }]]] } }];
  for (const d of docs) check(same(boundedJson(d, 1e6), want(d)), `parity: ${realStringify(d)?.slice(0, 60)}`);
  // (only own keys, as JSON.stringify: an inherited enumerable property is left out)
  const child = Object.assign(Object.create({ inherited: 1 }), { own: 2 });
  check(same(boundedJson({ c: child }, 1e6), want({ c: child })), `parity: an inherited enumerable property is left out (${realStringify(child)})`);
  // random strings of any UTF-16 code units, surrogates included
  let seed = 12345;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  let bad = 0;
  for (let t = 0; t < 3000; t++) {
    let s = "";
    const len = rand(24);
    for (let i = 0; i < len; i++) {
      const r = rand(10);
      s += String.fromCharCode(r < 3 ? rand(0x80) : r < 5 ? 0xd800 + rand(0x800) : r < 6 ? rand(0x20) : rand(0x10000));
    }
    const v = { [s]: s, l: [s, s.length] };
    if (!same(boundedJson(v, 1e6), want(v))) bad++;
  }
  check(bad === 0, `3,000 random strings of any code units, as keys and values: ${bad} differ from JSON.stringify`);
}
// (what it refuses as JSON.stringify can't do it either, said plainly)
for (const [what, v] of [["a cycle", (() => { const a = []; a.push(a); return a; })()], ["a BigInt", { n: 1n }], ["undefined at the top", undefined]]) {
  let err = null;
  try {
    boundedJson(v, 1e6);
  } catch (e) {
    err = e;
  }
  check(err instanceof TypeError, `${what}: a TypeError (${err})`);
}

if (fails.length) {
  console.log(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`ok: boundedJson, ${checks} checks`);
