// ci: inline (ci.yml)
// A real temporary git repository exercises the CLI: an existing file is never a blanket exemption, duplicate
// lines count, staged additions are scanned, and pruning cannot bless new debt. Fixture strings are assembled
// here so the suite doesn't introduce the very public text it tests for.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASELINE, PATTERN } from "./public-text.mjs";

// Every CI event reaches this job before docs-only and other tier decisions.
const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const start = workflow.indexOf("\n  changes:\n");
assert.ok(start >= 0);
const nextJob = /^  [a-z][\w-]*:/m.exec(workflow.slice(start + "\n  changes:\n".length));
const changes = workflow.slice(start, nextJob ? start + "\n  changes:\n".length + nextJob.index : undefined);
assert.ok(changes.includes("run: node scripts/test-public-text.mjs && node scripts/public-text.mjs"));

const root = mkdtempSync(join(tmpdir(), "public-text-test-"));
const script = fileURLToPath(new URL("./public-text.mjs", import.meta.url));
let checks = 0;
try {
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const write = (path, value) => writeFileSync(join(root, path), value);
  const run = (args, success) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, success ? 0 : 1, result.stdout + result.stderr);
    checks++;
    return result;
  };
  git("init", "-q");
  mkdirSync(join(root, "scripts"));
  const old = "review by " + "astra" + "2";
  write("existing.md", old + "\n");
  git("add", "existing.md");
  run([], false); // a missing baseline fails closed
  run(["--init"], true);
  git("add", BASELINE);
  run([], true);
  run(["--init"], false); // cannot reset an existing baseline
  write("existing.md", "unrelated text\n" + old + "\n");
  run([], true); // moving a line doesn't require churn in the baseline
  write("existing.md", old + "\n" + old + "\n");
  run([], false); // even an identical added line is new debt
  run(["--prune"], false);
  write("existing.md", old + "\nnew " + "daybreak" + "3\n");
  run([], false); // the already-listed file cannot add a different offending line
  write("existing.md", old + "\n");
  write("new.md", old + "\n");
  run([], true); // untracked scratch text is outside the check
  git("add", "new.md");
  run([], false); // newly staged text and a different path are checked
  write("new.md", "security review; instructors and graders\n");
  run([], true);
  const bad = ["sagebrush-" + "astra4b", "sagebrush-" + "daybreak2", "sagebrush-" + "gpu1",
    "sagebrush-" + "grader2", "sagebrush-" + "macapp3", "astra" + "5", "daybreak" + "2",
    "/home/" + "user/file", "/scr" + "atch/file"];
  for (const value of bad) {
    write("new.md", value + "\n");
    run([], false);
  }
  write("new.md", "grader; instructors and graders; security review; ./before.json\n");
  write("existing.md", "limits review\n");
  write("binary.bin", Buffer.from([0, ...Buffer.from(old)]));
  git("add", "binary.bin");
  run([], true); // binary bytes are not text
  run(["--prune"], true);
  assert.deepEqual(JSON.parse(readFileSync(join(root, BASELINE), "utf8")).entries, []);
  checks++;
  write("existing.md", old + "\n");
  run([], false); // removed debt cannot reappear after pruning
  write("existing.md", "limits review\n");
  write(BASELINE, JSON.stringify({ version: 1, pattern: PATTERN, entries: [{ path: "x", hash: "bad", count: -1 }] }));
  run([], false); // malformed entries fail closed
  run(["--typo"], false);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`public-text: ${checks} checks passed`);
