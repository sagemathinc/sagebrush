import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
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

test("the escape-hatch policy against the compiler: tsc ACCEPTS the fixture, the policy refuses its unexplained multiline any and permits and counts the reasoned ones", () => {
  const r = tsc(join("test", "fixtures", "tsc-web-hatches"));
  assert.equal(r.signal, null);
  assert.equal(r.status, 0, "tsc accepts the fixture (the multiline any, the reasoned any and the expect-error over a real error):\n" + r.out.slice(0, 2000));
  const h = hatches(readFileSync(join(ROOT, "test", "fixtures", "tsc-web-hatches", "multi.mjs"), "utf8"));
  assert.deepEqual(h.problems, []);
  assert.deepEqual(h.counts["jsdoc-any"], { permitted: 1, refused: 1 }, JSON.stringify(h.findings));
  assert.deepEqual(h.counts["ts-expect-error"], { permitted: 1, refused: 0 });
  assert.deepEqual([h.counts["ts-nocheck"], h.counts["ts-ignore"]], [{ permitted: 0, refused: 0 }, { permitted: 0, refused: 0 }], "a string, a template and a regex holding comment-like text aren't comments");
  assert.equal(h.findings.find((f) => !f.permitted)?.line, 2, "the refused any is reported at its comment's line");
});

test("the lexer's slash context against the compiler (T1-LEX): divisions after postfix ++, -- and (a) never hide the comments after them; regexes after a control head and nested templates make no false finding", () => {
  const r = tsc(join("test", "fixtures", "tsc-web-hatches"));
  assert.equal(r.status, 0, "tsc accepts lex.mjs:\n" + r.out.slice(0, 2000));
  const h = hatches(readFileSync(join(ROOT, "test", "fixtures", "tsc-web-hatches", "lex.mjs"), "utf8"));
  assert.deepEqual(h.problems, []);
  assert.deepEqual(h.counts["jsdoc-any"], { permitted: 0, refused: 2 }, "the multiline any after a++ / b and the any after (a) / b: " + JSON.stringify(h.findings));
  assert.deepEqual(h.counts["ts-ignore"], { permitted: 0, refused: 1 }, "the ignore after a-- / b");
  assert.deepEqual(h.counts["ts-nocheck"], { permitted: 0, refused: 0 }, "a regex after if (...) and nested templates hold no comment");
});

test("the lexer fails closed at the ambiguous } slash; division after } off its line is fine", () => {
  assert.match(hatches("x = {} / 2 /* @ts-ignore */;\n").problems.join(), /ambiguous slash after \}/);
  assert.deepEqual(hatches("if (x) {}\ny = {} / 2;\n").problems, []);
  assert.deepEqual(hatches("function f() {}\n/ab/.test('x');\n").problems, []);
  assert.equal(hatches("a++ / b; // @ts-ignore\n").counts["ts-ignore"].refused, 1);
  assert.equal(hatches("a-- / b; /* @ts-nocheck */\n").counts["ts-nocheck"].refused, 1);
  assert.equal(hatches("x = ++a / b; // @ts-ignore\n").counts["ts-ignore"].refused, 1, "a prefix ++ operand: division after a");
  assert.equal(hatches("x = a + /re\\/*/.source; // @ts-ignore\n").counts["ts-ignore"].refused, 1, "a regex after + still lexes as a regex");
  assert.equal(hatches("while (go) /x\\/* y/.exec(s);\n").problems.length, 0);
});

test("the escape-hatch policy's own controls: each refused kind, multiline forms, reasons, and the lexer failing closed", () => {
  const k = (src: string) => hatches(src).counts;
  assert.equal(k("// @ts-nocheck\n")["ts-nocheck"].refused, 1);
  assert.equal(k("x(); /* @ts-ignore */\n")["ts-ignore"].refused, 1);
  assert.equal(k("/**\n * @ts-ignore\n */\n")["ts-ignore"].refused, 1);
  assert.equal(k("// @ts-expect-error\n")["ts-expect-error"].refused, 1);
  assert.equal(k("/* @ts-expect-error\n *\n */\n")["ts-expect-error"].refused, 1);
  assert.equal(k("/* @ts-expect-error\n * the DOM lib lacks this event\n */\n")["ts-expect-error"].permitted, 1);
  assert.equal(k("/** @type {any} */ let a;\n")["jsdoc-any"].refused, 1);
  assert.equal(k("/** @param {Array<*>} a */\n")["jsdoc-any"].refused, 1);
  assert.equal(k("/**\n * @returns {Promise<\n *   any\n * >}\n */\n")["jsdoc-any"].refused, 1);
  assert.equal(k("/** @type {any} */ let a; // any: a parsed JSON payload\n")["jsdoc-any"].permitted, 1);
  assert.equal(k("/** @type {number} */ const company = 1; /** @type {Many} */ let m;\n")["jsdoc-any"].refused, 0);
  assert.equal(k("const s = '// @ts-ignore'; const t = `${a /* @ts-nocheck */}`;\n")["ts-nocheck"].refused, 1, "a comment inside a template's expression IS a comment");
  assert.equal(k("const t = `${'x'} // @ts-ignore`;\n")["ts-ignore"].refused, 0, "text in a template is not");
  for (const src of ["/* never closed", "const s = 'never closed\n", "const t = `never closed", "x = /never closed\n"]) assert.ok(hatches(src).problems.length > 0, "fails closed: " + src);
});
