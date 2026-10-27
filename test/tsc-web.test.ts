import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// The browser code's type check (tooling plan r2, T1; William, Oct 27 2026): tsconfig.web.json's explicit roots,
// each with its whole import closure, under tsc with checkJs.  Here (node-tests runs on every web/ change, and on
// tsconfig.web.json's own as an unknown path):
// - the real check, its exit propagated (a nonzero status, a signal or a timeout fails; nothing is ignored);
// - its elapsed time and closure, against the ceiling (G-C1: 120 s, shard trigger 90 s);
// - the config's shape (explicit files only, checkJs and noEmit on);
// - the escape hatches, counted and refused (G-C4): no ts-nocheck or ts-ignore directive anywhere in the closure,
//   every ts-expect-error directive with a reason, every JSDoc any explained by an "any:" comment;
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

/** The escape hatches in a file's text, each a problem (G-C4: only a reasoned expect-error directive, a reasoned any). */
export function hatches(text: string): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    const at = `line ${i + 1}`;
    if (/@ts-nocheck\b/.test(line)) out.push(`${at}: @ts-nocheck turns the file's check off`);
    if (/@ts-ignore\b/.test(line)) out.push(`${at}: @ts-ignore (use @ts-expect-error with a reason)`);
    const m = line.match(/@ts-expect-error\b(.*)$/);
    if (m && !/[A-Za-z]{3,}/.test(m[1].replace(/\*\/.*$/, ""))) out.push(`${at}: @ts-expect-error without a reason`);
    if (/@(?:type|param|returns?|typedef)\s*\{[^}]*(?:\bany\b|\*)[^}]*\}/.test(line) && !/\bany:\s*\S/.test(line)) out.push(`${at}: a JSDoc any without an "any: <reason>" comment`);
  });
  return out;
}

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
  const found = closure.flatMap((f) => hatches(readFileSync(join(ROOT, f), "utf8")).map((h) => `${f} ${h}`));
  assert.deepEqual(found, [], `escape hatches in the checked closure:\n${found.join("\n")}`);
});

test("the negative control: a planted error in a root, and one in a file it only imports, both fail the check", () => {
  const r = tsc(join("test", "fixtures", "tsc-web-negative"));
  assert.equal(r.signal, null);
  assert.equal(r.error, undefined);
  assert.notEqual(r.status, 0, "tsc must exit nonzero on the planted errors");
  assert.match(r.out, /tsc-web-negative\/root\.mjs\(\d+,\d+\): error TS2322/, "the root's planted error is reported");
  assert.match(r.out, /tsc-web-negative\/dep\.mjs\(\d+,\d+\): error TS2322/, "the imported file's planted error is reported (roots are not a boundary)");
});

test("the escape-hatch scan itself: each kind is caught, a reasoned one passes (controls)", () => {
  assert.equal(hatches("// @ts-nocheck\n").length, 1);
  assert.equal(hatches("x; // @ts-ignore\n").length, 1);
  assert.equal(hatches("// @ts-expect-error\n").length, 1);
  assert.equal(hatches("// @ts-expect-error  \n").length, 1);
  assert.deepEqual(hatches("// @ts-expect-error the DOM lib lacks this event's type\n"), []);
  assert.equal(hatches("/** @type {any} */ let x;\n").length, 1);
  assert.equal(hatches("/** @param {Array<*>} a */\n").length, 1);
  assert.deepEqual(hatches("/** @type {any} */ let x; // any: a parsed JSON payload, validated below\n"), []);
  assert.deepEqual(hatches("/** @type {number} */ const company = 1;\n"), []);
});
