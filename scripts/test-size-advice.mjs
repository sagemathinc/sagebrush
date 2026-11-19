#!/usr/bin/env node
// ci: checks.6 order=11
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendPullRequestSummary, coreAdvice, latexAdvice, markerAdvice, safelyAppendPullRequestSummary } from "./size-advice.mjs";

for (const [current, verdict, suggested] of [[99, "RAISE", 164], [100, "KEEP", null], [120, "KEEP", null], [163, "KEEP", null], [164, "KEEP", null], [165, "TIGHTEN", 164]]) {
  assert.deepEqual(markerAdvice(100, current), { measured: 100, current, suggested, verdict });
}
assert.throws(() => markerAdvice(Number.MAX_SAFE_INTEGER, 1), /safe-integer range/);

const core = coreAdvice({ rows: [
  { bundle: "grow", delta: 100, markers: 120 },
  { bundle: "reset", delta: -20, charge: 80, growth: 144 },
  { bundle: "shrink", delta: -1, markers: 0 },
  { bundle: "exact", delta: 50 },
] }).join("\n");
assert.match(core, /\| grow \| \+100 \| 120 \| — \| \*\*KEEP\*\* \|/);
assert.match(core, /\| reset \| \+80 \| 144 \| — \| \*\*KEEP\*\* \|/);
assert.doesNotMatch(core, /\| (?:shrink|exact) \|/);
const noise = coreAdvice({ rows: [{ bundle: "jitter", delta: 64, markers: 0 }] }, { bundles: { jitter: { noise_bytes: 64 } } }).join("\n");
assert.match(noise, /No eligible row has growth needing a marker/);

const latex = latexAdvice(
  { raw: 1000, gzip: 400, cap: { raw: 1064, gzip: 450 } },
  [{ present: true, label: "lazy", raw: 200, gzip: 90, cap: { raw: 250, gzip: 154 } }],
).join("\n");
assert.match(latex, /LaTeX eager group \(raw\) \| 0 \| 1064 \| — \| \*\*KEEP\*\*/);
assert.match(latex, /LaTeX eager group \(gzip\) \| \+14 \| 450 \| — \| \*\*KEEP\*\*/);
assert.match(latex, /lazy \(raw\) \| \+14 \| 250 \| — \| \*\*KEEP\*\*/);
assert.match(latex, /lazy \(gzip\) \| 0 \| 154 \| — \| \*\*KEEP\*\*/);
assert.match(latex, /current cap \| suggested cap \(measured \+ 64 B\) \| target-relative verdict/);
assert.match(latex, /not pass\/fail, and do not approve a marker or cap raise/);
for (const [cap, verdict, suggested] of [[99, "RAISE", 164], [100, "KEEP", null], [120, "KEEP", null], [163, "KEEP", null], [164, "KEEP", null], [165, "TIGHTEN", 164]]) {
  const row = latexAdvice({ raw: 100, gzip: 100, cap: { raw: cap, gzip: 164 } }, []).join("\n");
  assert.match(row, new RegExp(`LaTeX eager group \\(raw\\) \\| [^|]+ \\| ${cap} \\| ${suggested ?? "—"} \\| \\*\\*${verdict}\\*\\*`));
}

const dir = mkdtempSync(join(tmpdir(), "size-advice-"));
try {
  const file = join(dir, "summary.md");
  assert.equal(appendPullRequestSummary(["hello"], { GITHUB_EVENT_NAME: "push", GITHUB_STEP_SUMMARY: file }), false);
  assert.equal(appendPullRequestSummary(["hello"], { GITHUB_EVENT_NAME: "pull_request", GITHUB_STEP_SUMMARY: file }), true);
  assert.equal(readFileSync(file, "utf8"), "hello\n");
  const env = { GITHUB_EVENT_NAME: "pull_request", GITHUB_STEP_SUMMARY: dir };
  const reportThenStatus = (status, makeLines, reportEnv) => (safelyAppendPullRequestSummary(makeLines, reportEnv), status);
  assert.equal(reportThenStatus(0, ["unwritable"], env), 0, "an unwritable summary leaves a valid gate passing");
  assert.equal(reportThenStatus(1, ["unwritable"], env), 1, "an unwritable summary leaves a failing gate failing");
  const malformed = () => { throw new Error("malformed advice"); };
  assert.equal(reportThenStatus(0, malformed, { GITHUB_EVENT_NAME: "pull_request", GITHUB_STEP_SUMMARY: file }), 0, "malformed advice leaves a valid gate passing");
  assert.equal(reportThenStatus(1, malformed, { GITHUB_EVENT_NAME: "pull_request", GITHUB_STEP_SUMMARY: file }), 1, "malformed advice leaves a failing gate failing");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
assert.match(ci, /name: suggested growth-marker advice\n        if: always\(\) && github\.event_name == 'pull_request'\n        continue-on-error: true\n        run: node scripts\/size-advice\.mjs --core/);
assert.doesNotMatch(ci, /pull-requests:\s*write/);

const latexGate = readFileSync(new URL("./test-latex-group-budget.mjs", import.meta.url), "utf8");
assert.match(latexGate, /const status = fails\.length \? 1 : 0;\nif \(latexReport\) safelyAppendPullRequestSummary/);
assert.match(latexGate, /process\.exit\(status\);/);

console.log("test-size-advice: all pass");
