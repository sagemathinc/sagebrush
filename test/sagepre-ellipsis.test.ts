import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEllipsis, preparse, stripLiterals } from "../src/sagepre";

// Sage's ellipsis ranges ([a..b], (a..b), [a,b..c; s]) in one pass: the same text as the rewrite it replaces, which
// searched again from the start for each `..` and scanned across the source for each one's block, so (number of `..`)
// x (length): minutes for a 1 MiB .sage file that a workspace preparses when its room is entered.

// The rewrite as it was, the oracle: each eligible `..` (not part of `...`), left to right, rewrites the innermost (
// or [ around it (brackets of any kind counted; a { or an unclosed one leaves it), its whole text.
function oldParseEllipsis(code: string): string {
  const OPEN = "([{", CLOSE = ")]}";
  const containingBlock = (code: string, i: number): [number, number] | null => {
    let depth = 0, s = i;
    for (; s >= 0; s--) {
      const ch = code[s];
      if (CLOSE.includes(ch)) depth++;
      else if (OPEN.includes(ch)) {
        if (depth === 0) break;
        depth--;
      }
    }
    if (s < 0 || code[s] === "{") return null;
    depth = 0;
    let e = i;
    for (; e < code.length; e++) {
      const ch = code[e];
      if (OPEN.includes(ch)) depth++;
      else if (CLOSE.includes(ch)) {
        if (depth === 0) break;
        depth--;
      }
    }
    if (e >= code.length) return null;
    return [s, e + 1];
  };
  let ix = code.indexOf("..");
  while (ix !== -1) {
    if (code[ix + 2] === "." || code[ix - 1] === ".") {
      ix = code.indexOf("..", ix + 3);
      continue;
    }
    const b = containingBlock(code, ix);
    if (!b) {
      ix = code.indexOf("..", ix + 2);
      continue;
    }
    const [s, e] = b;
    let args = code.slice(s + 1, e - 1).replace(/\.\./g, ",Ellipsis,").replace(/,\s*,/g, ",").replace(/,\s*$/, "");
    args = args.replace(/;\s*/, ", step=");
    code = `${code.slice(0, s)}(ellipsis_${code[s] === "[" ? "range" : "iter"}(${args}))${code.slice(e)}`;
    ix = code.indexOf("..");
  }
  return code;
}

test("ellipsis ranges: the same text as the old rewrite, on Sage programs and generated code", () => {
  let n = 0;
  const check = (src: string, label: string) => {
    n++;
    assert.equal(parseEllipsis(src), oldParseEllipsis(src), label + ": " + JSON.stringify(src).slice(0, 200));
  };
  for (const [src, want] of [
    ["[1..5]", "(ellipsis_range(1,Ellipsis,5))"],
    ["[1,3..9]", "(ellipsis_range(1,3,Ellipsis,9))"],
    ["(1..10)", "(ellipsis_iter(1,Ellipsis,10))"],
    ["[1..10; 2]", "(ellipsis_range(1,Ellipsis,10, step=2))"],
    ["[(1..2)..3]", "(ellipsis_range((ellipsis_iter(1,Ellipsis,2)),Ellipsis,3))"],
    ["[1..2, (3..4)]", "(ellipsis_range(1,Ellipsis,2, (3,Ellipsis,4)))"],
    ["{1..2}", "{1..2}"],
    ["x...y", "x...y"],
  ]) assert.equal(parseEllipsis(src), want, src);
  // every Sage program of the sage-tests, as the preparser sees it (literals and comments out)
  const dir = join(__dirname, "..", "..", "sage-tests");
  for (const f of readdirSync(dir)) if (f.endsWith(".sage")) check(stripLiterals(readFileSync(join(dir, f), "utf8"))[0], f);
  // generated: nested brackets of every kind (mismatched and unclosed ones too), lists with .., ..., ;, commas at each level
  let seed = 1850;
  const rnd = (k: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 12) % k; };
  const pick = <T>(xs: T[]) => xs[rnd(xs.length)];
  const atom = () => pick(["1", "x", "a", "-3", "f(1)", "..", "...", "", " "]);
  const sep = () => pick(["..", ",", ", ", "..", "...", ";", "; ", ",,", ",,,", " .. "]);
  const expr = (d: number): string => {
    if (d > 6 || rnd(3) === 0) return atom();
    const [o, c] = pick([["[", "]"], ["(", ")"], ["{", "}"], ["[", "]"], ["(", ")"], ["[", ")"]]);
    let s = o;
    for (let j = 0, k = 1 + rnd(4); j < k; j++) s += (j ? sep() : "") + expr(d + 1);
    return s + (rnd(20) === 0 ? "" : c);
  };
  for (let t = 0; t < 20000; t++) check(expr(0) + (rnd(3) === 0 ? sep() + expr(0) : ""), "generated");
  const TOK = ["(", ")", "[", "]", "{", "}", "..", "...", ".", ",", ";", " ", "1", "x", "a,", "..2", "1..", ", ", "; ", "\n", "....", ",,,"];
  for (let t = 0; t < 20000; t++) {
    let s = "";
    for (let k = 0, len = 1 + rnd(t % 2 ? 40 : 12); k < len; k++) s += pick(TOK);
    check(s, "tokens");
  }
  assert.ok(n > 40000);
});

// The shapes that took minutes (1 MiB each, a fraction of a second on an idle machine): linear now, so a 1 MiB file
// costs about 4 times a 256 KiB one, where the old rewrite's cost grew 16 times; the bound, 8 times, sits between.
// Measured so that a loaded runner can't fail it (#2276): CPU time, not wall-clock time (another process on the
// runner takes the CPU away, not this process's CPU time); the two sizes back to back, alternately, the least of 5 of
// each, with a floor of 50 ms so that one garbage collection in a fast shape can't fail it; and a ratio over the bound
// measured again, up to 3 times, before it fails (a quadratic cost is over it every time, a burst of load once).
// Code nested past Python's limit of 200 brackets is left as it is (Python refuses it, whatever the preparser does).
const cpuMs = (f: () => unknown) => {
  const t = process.cpuUsage();
  f();
  const d = process.cpuUsage(t);
  return (d.user + d.system) / 1000;
};
const linear = (name: string, run: (src: string) => unknown, rep: (n: number) => string) => {
  const small = rep(1 << 18), big = rep(1 << 20);
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    let s = Infinity, b = Infinity;
    for (let r = 0; r < 5; r++) {
      s = Math.min(s, cpuMs(() => run(small)));
      b = Math.min(b, cpuMs(() => run(big)));
    }
    if (b < 8 * Math.max(s, 50)) return;
    last = name + ": 1 MiB " + Math.round(b) + " ms, 256 KiB " + Math.round(s) + " ms of CPU time";
  }
  assert.fail(last + ", 3 times");
};

test("ellipsis ranges: linear in the file's length", () => {
  const deep = (() => { let s = "1..2"; for (let d = 0; d < 199; d++) s = "[" + s + "]..3"; return "[" + s + "]\n"; })();
  for (const [name, unit] of [["[1,..,", "[1,..,"], ["[1..2]", "[1..2]\n"], ["mixed", "[(1..2), 3..4; 2]\n"], ["200 deep", deep]]) {
    linear(name, parseEllipsis, (n) => unit.repeat(Math.floor(n / unit.length)));
  }
  const tooDeep = "[".repeat(201) + "1..2" + "]".repeat(201);
  assert.equal(parseEllipsis(tooDeep), tooDeep);
  const deepest = "[".repeat(200) + "1..2" + "]".repeat(200);
  assert.equal(parseEllipsis(deepest), oldParseEllipsis(deepest));
  // (and the whole preparser on the shape that took minutes)
  linear("preparse [1,..,", preparse, (n) => "[1,..,".repeat(Math.floor(n / 6)));
});
