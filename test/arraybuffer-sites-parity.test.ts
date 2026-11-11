import test from "node:test";
import assert from "node:assert/strict";
import { slowSkipFor } from "./slow-tests";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The gate's parity with TypeScript 7 (erratum E1r2.2): tsc 7 checks, at every
// call and `new`, the kind TypeScript 5.9's walk gave it, in both directions
// (scripts/arraybuffer-sites-parity.mjs).  A site tsc 7 can't finish is a
// reviewed entry in the table's parity section; any other disagreement fails.
const ROOT = join(__dirname, "..", "..");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const P = require(join(ROOT, "scripts/arraybuffer-sites-parity.mjs"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const G = require(join(ROOT, "scripts/arraybuffer-sites-check.mjs"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const S = require(join(ROOT, "scripts/arraybuffer-sites.mjs"));

// (954 s on master: a slow test, test/slow-tests.ts; and not in engine-node, whose fresh engine it never runs)
test("tsc 7 agrees with every kind on this tree, except the reviewed sites it can't finish", { skip: slowSkipFor("arraybuffer") || (process.env.GITHUB_JOB === "engine-node" && "engine-independent: node-tests runs it") }, async (t) => {
  // (the host's memory while the check runs: its total, the least it had available, sampled each second, and the root
  // cgroup's limit and peak, "unavailable" where they can't be read; the passes run at once, so their memory is a CI
  // budget too.  The job's own cgroup is printed by node-tests' memory telemetry step)
  const meminfo = (k: string) => Number(/^\d+/.exec((readFileSync("/proc/meminfo", "utf8").match(new RegExp(`^${k}:\\s+(\\d+)`, "m")) ?? [])[1] ?? "") ?? NaN);
  const cg = (f: string) => { try { return readFileSync(`/sys/fs/cgroup/${f}`, "utf8").trim(); } catch { return "unavailable"; } };
  let minAvailable = Infinity;
  const sample = () => { const a = meminfo("MemAvailable"); if (a < minAvailable) minAvailable = a; };
  sample();
  const timer = setInterval(sample, 1000);
  let r: any;
  try {
    r = await P.checkParity(ROOT);
  } finally {
    clearInterval(timer);
  }
  sample();
  t.diagnostic(`parity memory (MiB): ${JSON.stringify({ total: Math.round(meminfo("MemTotal") / 1024), min_available: Math.round(minAvailable / 1024), cgroup_max: cg("memory.max"), cgroup_peak_bytes: cg("memory.peak") })}`);
  // (where the time went: the census, then pass 1, the reveal and the plain pass together, any second reveal, pass 3)
  t.diagnostic(`parity timing (ms): ${JSON.stringify({ ...r.timing, flagged: r.p1.located.filter((e: any) => e.site).length, early: r.early, unresolved: r.unresolved.length })}`);
  assert.deepEqual(r.disagree, [], "a disagreement between TypeScript 5.9's walk and tsc 7");
  assert.deepEqual(r.unplaced.map((e: any) => e.line), [], "an error the wrapping caused away from any site");
  const table = G.readTable(ROOT);
  const want = Object.entries(table.parity ?? {}).map(([k, v]: [string, any]) => `${k} ${v.kind59} ${v.tsc7}`).sort();
  const got = r.unresolved.map((u: any) => `${u.key} ${u.kind59} ${u.tsc7}`).sort();
  assert.deepEqual(got, want, "the sites tsc 7 can't finish are exactly the reviewed parity entries");
  for (const [k, v] of Object.entries(table.parity ?? {}) as [string, any][]) assert.ok(P.PARITY_REASONS[v.tsc7] && v.reason === P.PARITY_REASONS[v.tsc7], k);
  // the skips are counted, never silent
  assert.ok(r.p1.wrapped > 20000);
  for (const k of Object.keys(r.p1.skipped)) assert.ok(P.SKIPS.includes(k), k);
});

test("train-16: a tsc 7 run that was killed, crashed, cut short or printed what isn't its diagnostic output, or missed the probe, is an error, never an empty result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-parity-tsc-"));
  try {
    const probe = `${P.PROBE_FILE}(2,1): error TS2554: Expected 2 arguments, but got 1.`;
    const site = "src/runtime/c.ts(3,10): error TS2554: Expected 2 arguments, but got 1.";
    // a real chained message, as tsc 7 prints one (two spaces a level), and a program's diagnostic
    const chain = ["src/runtime/c.ts(5,40): error TS2322: Type '{ p: { q: number; }; }' is not assignable to type 'I'.", "  The types of 'p.q' are incompatible between these types.", "    Type 'number' is not assignable to type 'string'."];
    const global = "error TS5023: Unknown compiler option 'x'.";
    const panic = ["panic: runtime error: invalid memory address or nil pointer dereference", "", "goroutine 1 [running]:"];
    // bash printing exactly these lines (each ending in a newline), to stdout or to stderr
    const say = (lines: string[], to = "") => lines.map((l) => `printf '%b\\n' ${JSON.stringify(l).replace(/\$/g, "\\$")}${to}`).join("\n");
    const fakes: Record<string, [string, RegExp | string[]]> = {
      "killed after its diagnostics": [`${say([probe, site])}\nkill -9 $$`, /\(a signal\): status null, signal SIGKILL/],
      "killed silently (the OOM killer)": ["kill -9 $$", /\(a signal\)/],
      "exit 0, nothing printed": ["exit 0", /\(its exit status\): status 0/],
      "exit 2 (outputs emitted, not --noEmit's status)": [`${say([probe, site])}\nexit 2`, /\(its exit status\): status 2/],
      "exit 3 after its diagnostics": [`${say([probe, site])}\nexit 3`, /\(its exit status\): status 3/],
      "a Go panic on stderr, exit 2": [`${say([probe])}\n${say(panic, " >&2")}\nexit 2`, /\(its exit status\)/],
      "diagnostics on stdout, a panic on stderr, exit 1": [`${say([probe, site])}\n${say(panic, " >&2")}\nexit 1`, /\(output on stderr\)[^]*--- stderr \(tail\)\npanic: runtime error/],
      "a last stdout line without its newline, then stderr text": [`${say([probe, site])}\nprintf '%s' '  The types of x'\n${say([" panic: and the rest"], " >&2")}\nexit 1`, /\(output on stderr\)/],
      "a last line without its newline": [`${say([probe])}\nprintf '%s' ${JSON.stringify(site)}\nexit 1`, /\(a last line with no newline\)/],
      "a panic's text, exit 1": [`${say([probe, ...panic])}\nexit 1`, /\(a line that isn't tsc 7's output: "panic: /],
      "a stack frame (tab-indented)": [`${say([probe, "\tinternal/checker/checker.go:1234 +0x1f"])}\nexit 1`, /\(a line that isn't tsc 7's output: "\\tinternal/],
      "a line one space in (astra2's panic)": [`${say([probe, " panic: fatal runtime failure"])}\nexit 1`, /\(a line that isn't tsc 7's output: " panic: /],
      "a line one space in, before the probe (astra2's orphan)": [`${say([" orphaned arbitrary output", probe])}\nexit 1`, /\(a line that isn't tsc 7's output: " orphaned/],
      "a blank line between diagnostics": [`${say([probe, "", site])}\nexit 1`, /\(a line that isn't tsc 7's output: ""\)/],
      "a panic indented as a message line": [`${say([probe, "  panic: fatal runtime failure"])}\nexit 1`, /\(a crash's text: "  panic: /],
      "a goroutine header indented as a message line": [`${say([site, "  goroutine 1 [running]:", probe])}\nexit 1`, /\(a crash's text: "  goroutine 1/],
      "a stack frame indented as a message line": [`${say([probe, "  internal/checker/checker.go:1234 +0x1f"])}\nexit 1`, /\(a crash's text: "  internal\/checker\/checker\.go/],
      "a message line before any diagnostic": [`${say(["  orphaned arbitrary output", probe])}\nexit 1`, /\(a message line before any diagnostic: "  orphaned/],
      "a message line two levels deeper": [`${say([probe, "    two levels at once"])}\nexit 1`, /\(a message line more than one level deeper: "    two/],
      "no probe": [`${say(chain)}\nexit 1`, /\(no kind mismatch at the probe\)/],
      "the control: the probe alone": [`${say([probe])}\nexit 1`, []],
      "the control: diagnostics, a chained message, a program's diagnostic, the probe": [`${say([site, ...chain, global, probe])}\nexit 1`, [site, chain[0], global]],
    };
    const bins: Record<string, string> = {};
    for (const [name, [body, want]] of Object.entries(fakes)) {
      const bin = (bins[name] = join(dir, name.replace(/\W+/g, "-")));
      writeFileSync(bin, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
      if (want instanceof RegExp) assert.throws(() => P.runTsc(bin, dir), want, name);
      else assert.deepEqual(P.runTsc(bin, dir), want, name);
      // (the same run without blocking, as checkParity's passes run: admitted by the same rules)
      if (want instanceof RegExp) await assert.rejects(P.runTscAsync(bin, dir), want, `async: ${name}`);
      else assert.deepEqual(await P.runTscAsync(bin, dir), want, `async: ${name}`);
    }
    // every kind of Go crash text, indented as a message line, after a diagnostic
    const crashes = ["panic: x", "fatal error: out of memory", "goroutine 1 [running]:", "runtime: goroutine stack exceeds 1000000000-byte limit", "runtime/debug.Stack()", "runtime.gopanic({0x1})", "[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x0]", "created by main.main in goroutine 1", "exit status 2", "checker.go:1234 +0x1f"];
    for (const [i, c] of crashes.entries()) {
      const bin = join(dir, `crash-${i}`);
      writeFileSync(bin, `#!/bin/bash\n${say([probe, `  ${c}`])}\nexit 1\n`, { mode: 0o755 });
      assert.throws(() => P.runTsc(bin, dir), /\(a crash's text: /, c);
      await assert.rejects(P.runTscAsync(bin, dir), /\(a crash's text: /, `async: ${c}`);
    }
    assert.throws(() => P.runTsc(join(dir, "no-such-tsc"), dir), /\(a spawn error\): status null, signal null, spawnSync .* ENOENT/);
    // a full buffer, through the seam's small one: spawnSync's ENOBUFS, with status 1 if the child had
    // exited by then (astra2's reproduction) or killed (status null, SIGTERM) if not, a race; either is
    // refused.  The same output under a large enough buffer is the control
    const big = join(dir, "big");
    writeFileSync(big, `#!/bin/bash\n${say([probe, `  ${"x".repeat(4096)}`])}\nexit 1\n`, { mode: 0o755 });
    assert.throws(() => P.runTsc(big, dir, { maxBuffer: 1024 }), /\(a spawn error\): status (1, signal null|null, signal SIGTERM), spawnSync .* ENOBUFS/);
    assert.deepEqual(P.runTsc(big, dir, { maxBuffer: 8192 }), []);
    // (and without blocking: a missing binary, and past the cap the child killed and the run refused as spawnSync's)
    await assert.rejects(P.runTscAsync(join(dir, "no-such-tsc"), dir), /\(a spawn error\): status null, signal null, spawn .*no-such-tsc ENOENT/);
    await assert.rejects(P.runTscAsync(big, dir, { maxBuffer: 1024 }), /\(a spawn error\): status null, signal null, spawn .* ENOBUFS/);
    assert.deepEqual(await P.runTscAsync(big, dir, { maxBuffer: 8192 }), []);
    // the status-1 shape exactly, and results no real child gives, so a future wrapper can't erase the
    // checks: an error or a signal with status 1 and a whole, valid stdout
    const result = (r: object) => () => ({ status: 1, signal: null, error: undefined, stdout: `${probe}\n`, stderr: "", ...r });
    const enobufs = Object.assign(new Error(`spawnSync ${big} ENOBUFS`), { code: "ENOBUFS" });
    assert.throws(() => P.runTsc(big, dir, { spawn: result({ error: enobufs, stdout: `${probe}\n  ${"x".repeat(1000)}\n` }) }), /\(a spawn error\): status 1, signal null, spawnSync .* ENOBUFS/);
    assert.throws(() => P.runTsc("tsc", dir, { spawn: result({ error: new Error("injected") }) }), /\(a spawn error\): status 1, signal null, injected/);
    assert.throws(() => P.runTsc("tsc", dir, { spawn: result({ signal: "SIGKILL" }) }), /\(a signal\): status 1, signal SIGKILL/);
    assert.deepEqual(P.runTsc("tsc", dir, { spawn: result({}) }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pass 2 started early is reused only when pass 1 flagged exactly the table's reviewed sites, each once", () => {
  const T = ["src/a.ts:10", "src/a.ts:40", "src/b.ts:7"];
  assert.equal(P.reusesEarly([...T].reverse(), T), true, "the same sites, in another order");
  assert.equal(P.reusesEarly([], []), true, "none flagged, none reviewed");
  assert.equal(P.reusesEarly([...T, "src/c.ts:1"], T), false, "a flagged site the table lacks");
  assert.equal(P.reusesEarly(T.slice(1), T), false, "a reviewed site pass 1 didn't flag");
  assert.equal(P.reusesEarly(["src/c.ts:1", ...T.slice(1)], T), false, "one swapped for another");
  assert.equal(P.reusesEarly([...T, T[0]], [...T, "src/c.ts:1"]), false, "a site flagged twice");
  assert.equal(P.reusesEarly(T, [...T, T[0]]), false, "a table site twice");
});

test("checkParity reuses the early pass 2 when pass 1 flags exactly the table's sites, and runs it again when the table lists a site pass 1 didn't flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-parity-early-"));
  try {
    const opts = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")).compilerOptions;
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: opts, include: ["src/**/*.ts", "web/**/*.ts"] }));
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    const files: Record<string, string> = {
      "web/worker.ts": "export {};\n",
      "src/runtime/c.ts": "export function b(): Uint8Array { return new Uint8Array(4); }\nexport function uses() { const y = b(); const z = new Uint8Array(8); return [y, z]; }\n",
      "test/arraybuffer-sites.json": JSON.stringify({ parity: {} }),
    };
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t);
    }
    const none = await P.checkParity(dir);
    assert.equal(none.p1.located.filter((e: any) => e.site).length, 0, "pass 1 flags no site here");
    assert.equal(none.early, true, "none flagged, none in the table: the early pass 2 is reused");
    const site = S.census(dir).spans.find((x: any) => !x.skip);
    assert.ok(site, "the fixture has a census site");
    writeFileSync(join(dir, "test/arraybuffer-sites.json"), JSON.stringify({ parity: { [site.key]: { kind59: "store", tsc7: "unresolved", reason: "a site pass 1 doesn't flag" } } }));
    const listed = await P.checkParity(dir);
    assert.equal(listed.p1.located.filter((e: any) => e.site).length, 0, "pass 1 still flags no site");
    assert.equal(listed.early, false, "the table lists a site pass 1 didn't flag: pass 2 runs again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E1r2.2.4: the parity check rejects a clean site made any, a store expected clean, and a store replaced by a concrete non-store", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-parity-fx-"));
  try {
    const opts = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")).compilerOptions;
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: opts, include: ["src/**/*.ts", "web/**/*.ts"] }));
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    const files: Record<string, string> = {
      "web/worker.ts": "export {};\n",
      "src/runtime/c.ts": `export function a(): number { return 1; }
export function b(): Uint8Array { return new Uint8Array(4); }
export function uses() { const x = a(); const y = b(); const z = new Uint8Array(8); return [x, y, z]; }
// (a tracked JavaScript module a constant require reaches: the census reads it, so tsc 7 must take it too)
export const d = require("./d.js");
`,
      "src/runtime/d.js": "module.exports = 1;\n",
    };
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t);
    }
    const clean = P.parity(dir);
    assert.equal(clean.mismatch.length, 0, clean.errors.join("\n"));
    for (const control of ["i", "ii", "iii"]) {
      const r = P.parity(dir, { control });
      assert.ok(r.control, `control ${control} found a site`);
      assert.ok(r.mismatch.some((e: any) => e.site.start === r.control.start), `control ${control} is rejected: ${r.errors.join(" | ")}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
