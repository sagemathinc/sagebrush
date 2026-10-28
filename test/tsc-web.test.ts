import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { hatches } from "./tsc-web-hatches";

// The browser code's type check (tooling plan r2, T1; William, Oct 27 2026): tsconfig.web.json's explicit roots,
// each with its whole import closure, under tsc with checkJs.  Here (node-tests runs on every web/ change, and on a
// change to tsconfig.web.json itself, which ci-paths' workflowOrBuildPaths matches as a tsconfig*.json; every import a
// future root pulls in must also sit in a path class that selects node, astra2 #232):
// - the real check, its exit propagated (a nonzero status, a signal or a timeout fails; nothing is ignored);
// - its elapsed time and closure, against the ceiling (G-C1: 120 s, shard trigger 90 s);
// - the config's shape (explicit files only, checkJs and noEmit on);
// - the escape hatches (G-C4), on whole comments (test/tsc-web-hatches.ts): counted per kind, permitted uses included,
//   and refused unless permitted (no ts-nocheck or ts-ignore; a ts-expect-error or a JSDoc any only with a reason);
// - a negative control: a planted error in a root and one in a file it only imports, with the real options, must
//   make tsc exit nonzero and report both.
const ROOT = join(__dirname, "..", "..");
const TSC = join(ROOT, "node_modules", ".bin", "tsc");
const CEILING_MS = 120_000;
const TRIGGER_MS = 90_000;

function tsc(project: string) {
  const t0 = Date.now();
  const r = spawnSync(TSC, ["-p", project, "--listFiles", "--pretty", "false"], { cwd: ROOT, encoding: "utf8", timeout: CEILING_MS + 30_000, maxBuffer: 64 << 20 });
  return { status: r.status, signal: r.signal, error: r.error, out: (r.stdout ?? "") + (r.stderr ?? ""), ms: Date.now() - t0 };
}
/** The repository files tsc read (the closure), from --listFiles: never node_modules or the standard library. */
const closureOf = (out: string) => out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith(ROOT + "/") && !l.includes("/node_modules/")).map((l) => relative(ROOT, l));

test("tsconfig.web.json: explicit roots only, checkJs and noEmit on, every root present", () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, "tsconfig.web.json"), "utf8"));
  assert.ok(Array.isArray(cfg.files) && cfg.files.length > 0, "an explicit, non-empty files list");
  assert.equal(cfg.include, undefined, "no include globs: roots are listed one by one");
  assert.equal(cfg.exclude, undefined);
  assert.equal(cfg.extends, undefined);
  assert.equal(cfg.compilerOptions.checkJs, true);
  assert.equal(cfg.compilerOptions.allowJs, true);
  assert.equal(cfg.compilerOptions.noEmit, true);
  for (const f of cfg.files) assert.ok(existsSync(join(ROOT, f)), `root ${f} exists`);
});

test("the type check passes, within its ceiling, with no escape hatch in its closure", () => {
  const r = tsc("tsconfig.web.json");
  assert.equal(r.error, undefined, `tsc could not run: ${r.error}`);
  assert.equal(r.signal, null, `tsc was killed by ${r.signal} (a timeout past ${CEILING_MS + 30_000} ms, or a signal)`);
  const errors = r.out.split("\n").filter((l) => / error TS\d+/.test(l));
  assert.equal(r.status, 0, `tsc failed:\n${errors.slice(0, 40).join("\n")}`);
  const closure = closureOf(r.out);
  const roots: string[] = JSON.parse(readFileSync(join(ROOT, "tsconfig.web.json"), "utf8")).files;
  for (const f of roots) assert.ok(closure.includes(f), `root ${f} was checked`);
  // (the figures each opt-in PR reports, before and after: G-C1)
  console.log(JSON.stringify({ tsc_web: { ms: r.ms, roots: roots.length, closure: closure.length, files: closure, ceiling_ms: CEILING_MS, trigger_ms: TRIGGER_MS } }));
  if (r.ms > TRIGGER_MS) console.log(`TRIGGER: tsc took ${r.ms} ms, past ${TRIGGER_MS} ms: the next opt-in PR shards tsconfig.web.json first (plan-tooling r2 G-C1)`);
  assert.ok(r.ms <= CEILING_MS, `tsc took ${r.ms} ms, past the ${CEILING_MS} ms ceiling: shard tsconfig.web.json into per-directory projects (plan-tooling r2 G-C1); never drop files or skip the check`);
  // (every closure file scanned whole; the per-kind counts printed, permitted uses included)
  const total = { "ts-nocheck": { permitted: 0, refused: 0 }, "ts-ignore": { permitted: 0, refused: 0 }, "ts-expect-error": { permitted: 0, refused: 0 }, "jsdoc-any": { permitted: 0, refused: 0 } };
  const bad: string[] = [];
  for (const f of closure) {
    const h = hatches(readFileSync(join(ROOT, f), "utf8"));
    for (const k of Object.keys(total) as (keyof typeof total)[]) { total[k].permitted += h.counts[k].permitted; total[k].refused += h.counts[k].refused; }
    bad.push(...h.problems.map((p) => `${f} ${p}`), ...h.findings.filter((x) => !x.permitted).map((x) => `${f} line ${x.line}: ${x.why}`));
  }
  console.log(JSON.stringify({ tsc_web_hatches: total }));
  assert.deepEqual(bad, [], `escape hatches in the checked closure:\n${bad.join("\n")}`);
});

test("the negative control: a planted error in a root, and one in a file it only imports, both fail the check", () => {
  const r = tsc(join("test", "fixtures", "tsc-web-negative"));
  assert.equal(r.signal, null);
  assert.equal(r.error, undefined);
  assert.notEqual(r.status, 0, "tsc must exit nonzero on the planted errors");
  assert.match(r.out, /tsc-web-negative\/root\.mjs\(\d+,\d+\): error TS2322/, "the root's planted error is reported");
  assert.match(r.out, /tsc-web-negative\/dep\.mjs\(\d+,\d+\): error TS2322/, "the imported file's planted error is reported (roots are not a boundary)");
});

const FIX = join(ROOT, "test", "fixtures", "tsc-web-hatches");
const fx = (f: string) => readFileSync(join(FIX, f), "utf8");
// every shape astra2 found, r2-r5 (a division or a regex a lexer could misread, then a hatch it would hide), plus a
// hashbang; tsc accepts every file
const SHAPES: [string, keyof ReturnType<typeof hatches>["counts"]][] = [
  ["postinc.mjs", "jsdoc-any"], ["postdec.mjs", "jsdoc-any"], ["paren.mjs", "jsdoc-any"], ["brace.mjs", "jsdoc-any"],
  ["member-return.mjs", "jsdoc-any"], ["member-if.mjs", "jsdoc-any"], ["member-gap.mjs", "jsdoc-any"], ["unicode.mjs", "jsdoc-any"],
  ["nonnull.ts", "jsdoc-any"], ["asi.mjs", "jsdoc-any"], ["forawait.mjs", "jsdoc-any"], ["backtick.mjs", "jsdoc-any"], ["hashbang.mjs", "ts-ignore"],
];

test("the policy against the compiler: tsc ACCEPTS the fixtures; multi.mjs's unexplained multiline any is refused, its reasoned any and expect-error permitted and counted", () => {
  const r = tsc(join("test", "fixtures", "tsc-web-hatches"));
  assert.equal(r.status, 0, "tsc accepts every fixture:\n" + r.out.slice(0, 2000));
  const h = hatches(fx("multi.mjs"));
  assert.deepEqual(h.problems, []);
  assert.deepEqual(h.counts["jsdoc-any"], { permitted: 1, refused: 1 }, JSON.stringify(h.findings));
  assert.deepEqual(h.counts["ts-expect-error"], { permitted: 1, refused: 0 });
  assert.equal(h.findings.find((f) => !f.permitted)?.line, 4, "the refused any, at its tag's line");
});

test("T1-LEX r6: every shape tsc accepts (astra2 r2-r5, both regex/division directions, the backtick variant, a hashbang) is REFUSED by the superset scan", () => {
  for (const [f, kind] of SHAPES) {
    const h = hatches(fx("shapes/" + f));
    assert.ok(h.counts[kind].refused >= 1, `${f}: its ${kind} must be refused: ${JSON.stringify({ problems: h.problems, counts: h.counts })}`);
  }
});

test("false-positive guards: ordinary code (regexes, escaped slashes, divisions, a URL, nested templates) has no finding and no problem", () => {
  const h = hatches(fx("shapes/guards.mjs"));
  assert.deepEqual([h.problems, h.findings], [[], []]);
});

test("today's three roots don't trip the superset scan (no fake candidate, no unterminated /*)", () => {
  for (const f of JSON.parse(readFileSync(join(ROOT, "tsconfig.web.json"), "utf8")).files as string[]) {
    const h = hatches(readFileSync(join(ROOT, f), "utf8"));
    assert.deepEqual([h.problems, h.findings], [[], []], f);
  }
});

test("the superset scan's controls: each kind, multiline, reasons only inside their own comment, terminators, HTML-like comments, fail closed, one count per hatch", () => {
  const k = (src: string) => hatches(src).counts;
  // (each kind, block and line, multiline)
  assert.equal(k("// @ts-nocheck\n")["ts-nocheck"].refused, 1);
  assert.equal(k("x(); /* @ts-ignore */\n")["ts-ignore"].refused, 1);
  assert.equal(k("/**\n * @ts-ignore\n */\n")["ts-ignore"].refused, 1);
  assert.equal(k("// @ts-expect-error\n")["ts-expect-error"].refused, 1);
  assert.equal(k("/* @ts-expect-error\n * the DOM lib lacks this event\n */\n")["ts-expect-error"].permitted, 1);
  assert.equal(k("/** @type {any} */ let a;\n")["jsdoc-any"].refused, 1);
  assert.equal(k("/** @param {Array<*>} a */\n")["jsdoc-any"].refused, 1);
  assert.equal(k("/**\n * @returns {Promise<\n *   any\n * >}\n */\n")["jsdoc-any"].refused, 1);
  assert.equal(k("/** any: a parsed JSON payload\n * @type {any} */ let a;\n")["jsdoc-any"].permitted, 1);
  assert.equal(k("/** @type {number} */ const company = 1; /** @type {Many} */ let m;\n")["jsdoc-any"].refused, 0);
  // (a reason counts only inside its own comment: never a trailing line comment, never a fake candidate)
  assert.equal(k("/** @type {any} */ let a; // any: a parsed JSON payload\n")["jsdoc-any"].refused, 1);
  assert.equal(k('const s = "/** any: fake reason"; /** @type {any} */ let a;\n')["jsdoc-any"].refused, 1, "a fake candidate can't lend the real comment a reason");
  assert.equal(k("// @ts-expect-error\r a fake reason past a CR\n")["ts-expect-error"].refused, 1, "a line comment ends at CR");
  assert.equal(k("// @ts-expect-error\u2028 a fake reason past LS\n")["ts-expect-error"].refused, 1, "and at U+2028");
  // (HTML-like comments, which tsc 7 rejects but a script engine accepts: still refused)
  assert.equal(k("<!-- @ts-ignore\nx;\n")["ts-ignore"].refused, 1);
  assert.equal(k("x;\n--> @ts-nocheck\n")["ts-nocheck"].refused, 1);
  // (hatch-like text in a string, regex or template fails too: the price of the superset)
  assert.equal(k('const s = "// @ts-ignore";\n')["ts-ignore"].refused, 1);
  assert.equal(k("const r = /@ts-nocheck/; // fine\n")["ts-nocheck"].refused, 0, "no comment opener before it: no candidate");
  assert.deepEqual(hatches('const s = "@" + "ts-ignore";\n').findings, [], "the rewrite a future file would use");
  // (fail closed: a /* with no */ after it)
  assert.match(hatches("/* never closed").problems.join(), /fails closed/);
  assert.match(hatches('const s = "a/*b";\n').problems.join(), /fails closed/);
  // (one count per hatch, by position: a line candidate inside a block comment, or a nested /*, counts once; the refusal wins)
  assert.equal(k("/* x // @ts-ignore */\n")["ts-ignore"].refused, 1);
  assert.equal(k("/** a /* @type {any} */\n")["jsdoc-any"].refused, 1);
  assert.deepEqual(k('const s = "/** any: fake"; /** @type {any} */ let a;\n')["jsdoc-any"], { permitted: 0, refused: 1 }, "the real any once, refused");
});

test("r7: a tag type's extent: unmatched braces cut at the comment's end (still refused); a multiline non-any type's leading * isn't a wildcard", () => {
  assert.equal(hatches("/** @type {any */ let a;\n").counts["jsdoc-any"].refused, 1);
  assert.deepEqual(hatches("/**\n * @type {{\n *   x: number\n * }}\n */\nlet a;\n").findings, []);
  assert.deepEqual(hatches("/** @type {number} */ let a; // a * b\n").findings, [], "a * outside the type's braces doesn't count");
  assert.equal(hatches("/** @type {Record<string, *>} */ let a;\n").counts["jsdoc-any"].refused, 1, "the wildcard inside the braces does");
});

test("r7: an unterminated /* fails closed (never outside every candidate); a // at the very end of the file is a candidate", () => {
  assert.match(hatches("x;\n/* @ts-ignore").problems.join(), /fails closed/);
  assert.equal(hatches("x; // @ts-ignore").counts["ts-ignore"].refused, 1, "a line comment with no terminator after it, at EOF");
  assert.equal(hatches("x; // @ts-expect-error").counts["ts-expect-error"].refused, 1);
  // (inside both a line candidate and a block candidate, both must allow it: the line one here has no reason)
  assert.equal(hatches("// /* @ts-expect-error\n a justification for it */\nx;\n").counts["ts-expect-error"].refused, 1);
  // (a line candidate's reason is judged in the SHORTEST one holding the token: a string's "// any: fake reason"
  // earlier on the line can't lend one to the real line comment after it)
  assert.equal(hatches('const s = "// any: fake reason"; // @type {any}\n').counts["jsdoc-any"].refused, 1);
  assert.equal(hatches('const s = "// fine"; // @ts-expect-error\n').counts["ts-expect-error"].refused, 1);
  // (a line candidate ends at its terminator: hatch text in code on a later line is in no candidate)
  assert.deepEqual(hatches("// a comment\nconst s = '@' + 'x'; const t = 1; // ok\nconst u = s + '@ts-ignore'.slice(0, 0);\n").findings, []);
});

/** The linearity rule (daybreak2's r7, as recalibrated by wall-clock bounds r2): on PAIRED ratios. In each round the
 *  hatch scanner (H) and a known-linear control (C) are timed back to back over the same input, and the round's
 *  per-call ratio is q_i(n) = (H_i(n) / hCalls) / (C_i(n) / cCalls); q(n) is the median of the six rounds' q_i(n).
 *  A shared-runner slowdown slows both and cancels; a scanner that isn't linear makes q grow with n. With q at the
 *  sizes n/2, n and 2n (0.5, 1 and 2 MiB):
 *  - over the span, q(2n) <= 2.5 q(n/2): linear keeps q flat (1x), a quadratic grows it 4x;
 *  - at the top, q(2n) <= 1.6 q(n): a superlinearity that only starts above n (2x there) is caught.
 *  n log n (about 1.1x over the span) passes: out of scope, as before. */
function linearEnough(q: number[]): boolean {
  return q[2] <= 2.5 * q[0] && q[2] <= 1.6 * q[1];
}

test("the linearity rule, on paired ratios: flat passes; a quadratic, or one that starts late, fails", () => {
  assert.ok(linearEnough([1, 1, 1]) && linearEnough([1, 1.05, 1.11]), "linear, and n log n (out of scope)");
  assert.ok(!linearEnough([1, 2, 4]) && !linearEnough([3, 6, 12]), "a quadratic, at any scale");
  assert.ok(!linearEnough([1, 1, 2]), "a quadratic that starts above 1 MiB (2x at the top)");
  // (r7's raw rows over an ideal linear control, ms / [1, 2, 4]: CI's noisy rows pass as before)
  assert.ok(linearEnough([46, 84.9, 66.5]) && linearEnough([26.3, 18.8, 28.7]), "master's ci 40617260405 and #241's 40618056762, as ratios");
  assert.ok(!linearEnough([10, 20, 40]) && !linearEnough([40, 40, 80]), "r7's exact quadratic and late quadratic, as ratios");
  // (r7's "10x over the span", 30 / 100 / 300 ms, is q = 30 / 50 / 75 here: exactly the span bound, so it passes
  // the frozen rule (<= 2.5); the old raw rule failed it)
  assert.ok(linearEnough([30, 50, 75]), "r7's 10x-over-the-span row sits on the span bound");
});

// (a known-linear control over the same string: every character folded into a checksum, then every "\n" found by
// indexOf jumps. Its result is bound per input size, so its work can't be dropped)
function control(s: string): number {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  let k = 0;
  for (let j = s.indexOf("\n"); j !== -1; j = s.indexOf("\n", j + 1)) k++;
  return ((h ^ k) >>> 0) + 1;
}

test("r7 linearity (daybreak2): pathological inputs at 0.5, 1 and 2 MiB scan in linear time, paired against a linear control", () => {
  const MiB = 1 << 20;
  // (gc() before each timed batch: a collection the last batch's garbage triggers lands outside the timing)
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const kinds: [string, (n: number) => string][] = [
    ["/*/*/*...", (n) => "/*".repeat(n / 2)],
    ["////...", (n) => "/".repeat(n)],
    ["one unclosed /*", (n) => "/*" + "x".repeat(n - 2)],
    ["/*x/*x/*x... (every /* unclosed: '/*/*' holds a '*/', this doesn't)", (n) => "/*x".repeat(Math.floor(n / 3))],
    ["unmatched @type { in one block", (n) => "/**" + " @type {".repeat(Math.floor((n - 5) / 8)) + "*/"],
    ["// @ts-ignore lines", (n) => "// @ts-ignore\n".repeat(Math.floor(n / 14))],
  ];
  const ms = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;
  const rows: Record<string, unknown> = {};
  for (const [name, make] of kinds) {
    const inputs = [MiB / 2, MiB, 2 * MiB].map(make);
    const expected = inputs.map(control);
    const H = (s: string, calls: number) => { gc(); const t0 = process.hrtime.bigint(); for (let c = 0; c < calls; c++) hatches(s); return ms(t0); };
    const C = (i: number, calls: number) => {
      gc();
      let sum = 0;
      const t0 = process.hrtime.bigint();
      for (let c = 0; c < calls; c++) sum += control(inputs[i]);
      const t = ms(t0);
      assert.equal(sum, expected[i] * calls, `${name}: the control's checksum at size ${i}`);
      return t;
    };
    // (calibrated separately at 0.5 MiB, after a warm-up: each at least 3 calls, about 120 ms a batch)
    H(inputs[0], 1); C(0, 1);
    const hCalls = Math.max(3, Math.ceil(120 / Math.max(H(inputs[0], 1), 0.01)));
    const cCalls = Math.max(3, Math.ceil(120 / Math.max(C(0, 1), 0.01)));
    const q: number[][] = [[], [], []], hb: number[][] = [[], [], []], cb: number[][] = [[], [], []];
    // (six rounds; in each, every size's H and C batches back to back, H first in even rounds and C first in odd)
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 3; i++) {
        let h: number, c: number;
        if (round % 2 === 0) { h = H(inputs[i], hCalls); c = C(i, cCalls); }
        else { c = C(i, cCalls); h = H(inputs[i], hCalls); }
        hb[i].push(+h.toFixed(2)); cb[i].push(+c.toFixed(2));
        q[i].push((h / hCalls) / (c / cCalls));
      }
    }
    const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return (s[2] + s[3]) / 2; };
    const qm = q.map(median);
    const hPerCall = hb.map((b) => median(b) / hCalls);
    rows[name] = { q: qm.map((x) => +x.toFixed(3)), q_rounds: q.map((r) => r.map((x) => +x.toFixed(3))), h_batches_ms: hb, c_batches_ms: cb, hCalls, cCalls };
    assert.ok(linearEnough(qm), `${name}: q ${qm.map((x) => x.toFixed(3)).join(" / ")} over 0.5 / 1 / 2 MiB is not linear (q(2)/q(0.5) > 2.5, or q(2)/q(1) > 1.6): ${JSON.stringify(rows[name])}`);
    assert.ok(hPerCall[2] < 4000, `${name}: 2 MiB took ${hPerCall[2]} ms a call`);
  }
  console.log(JSON.stringify({ tsc_web_hatches_linearity: rows }));
});
