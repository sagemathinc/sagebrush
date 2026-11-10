// ci: checks.3 order=110 runner=bun
// The preview's code colouring (hl.ts), without a page: the byte cap counted as UTF-8 from UTF-16 units (at the cap
// coloured, one byte over plain, for ASCII, two-, three- and four-byte characters and a lone surrogate), and the
// highlighter's HTML read back into tokens only when they give back the text exactly (the one synthetic trailing
// newline dropped; an empty text no tokens; the text's own trailing newline kept; HTML-looking text as text).
//   bun web/latex/test-latex-hl.mjs
import { HL_MAX, fitsUtf8, tokensFromHtml } from "./hl.ts";
import { highlight } from "../notebook/highlight.js";

let checks = 0;
const fails = [];
const check = (ok, what, detail) => { checks++; if (!ok) { fails.push(what); console.log("FAIL", what, detail === undefined ? "" : JSON.stringify(detail).slice(0, 300)); } };
const bytes = (s) => new TextEncoder().encode(s).length;

// ---- the cap: 64 KiB of UTF-8, counted without encoding, the same as TextEncoder counts
check(HL_MAX === 65536, "the cap is 64 KiB (65,536 UTF-8 bytes)", HL_MAX);
const cases = [
  ["ASCII", "a".repeat(65536), "a"],
  ["two-byte (é)", "é".repeat(32768), "a"],
  ["three-byte (€), filled with ASCII", "€".repeat(21845) + "a", "a"],
  ["four-byte (𝑥, a surrogate pair)", "𝑥".repeat(16384), "a"],
];
for (const [what, at, more] of cases) {
  check(bytes(at) === 65536 && fitsUtf8(at), `${what}: exactly at the cap fits`, { bytes: bytes(at) });
  check(bytes(at + more) === 65537 && !fitsUtf8(at + more), `${what}: one byte over doesn't`, { bytes: bytes(at + more) });
}
// (a lone surrogate is three bytes, as TextEncoder writes its replacement)
const lone = "\ud835".repeat(21845) + "a";
check(bytes(lone) === 65536 && fitsUtf8(lone) && !fitsUtf8(lone + "a"), "a lone surrogate counts three bytes, as TextEncoder writes it", { bytes: bytes(lone) });
// (more UTF-16 units than the cap: plain at once, before any counting)
check(!fitsUtf8("a".repeat(65537)), "more units than the cap: over");
check(fitsUtf8("") && fitsUtf8("x = 1\n"), "small texts fit");

// ---- the highlighter's HTML read back: exact or nothing
const toks = (src) => tokensFromHtml(highlight(src, true), src);
check(JSON.stringify(toks("")) === "[]", "an empty text: no tokens", toks(""));
const t1 = toks("x = 1\n");
check(!!t1 && t1.map((t) => t[1]).join("") === "x = 1\n", "the text's own trailing newline is kept (only the highlighter's own is dropped)", t1);
const t2 = toks("for k in range(3):\n    print(k)  # done");
check(!!t2 && t2.some(([c, s]) => c === "hk" && s === "for") && t2.some(([c, s]) => c === "hn" && s === "3") && t2.some(([c]) => c === "hc"), "keywords, numbers and comments get their classes", t2);
const html = 'x = "<b>&amp;</b>" < 2 & 3';
const t3 = toks(html);
check(!!t3 && t3.map((t) => t[1]).join("") === html, "HTML-looking and entity-looking text comes back as the same text", t3);
check(tokensFromHtml('<span class="hk">for</span> x<i>', "for x") === null, "a shape other than escaped text and spans: null (the block stays plain)");
check(tokensFromHtml('<span class="hk">for</span>\n', "for y") === null, "tokens that don't give back the text: null");

console.log(fails.length ? `FAIL: ${fails.length} of ${checks}:\n  ${fails.join("\n  ")}` : `ok: the preview's code colouring, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
