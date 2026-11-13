import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Numbl corpus ratchet (upstream/numbl/README.md): where CI runs it, and its own tests.  The corpus runs on the
// full tier only, through scripts/test-numbl-corpus.mjs's `// ci: web-runner-sync` header; these keep it there.
const root = join(__dirname, "..", "..");
const HOOK = "scripts/test-numbl-corpus.mjs";
const workflows = readdirSync(join(root, ".github", "workflows")).filter((f) => /\.ya?ml$/.test(f));

// A job's lines in ci.yml, its `  name:` line to the next job's
function job(workflow: string, name: string): string {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `ci.yml has no job ${name}`);
  let end = start + 1;
  while (end < lines.length && !/^  [a-z0-9-]+:$/.test(lines[end])) end++;
  return lines.slice(start, end).join("\n");
}

test("the Numbl ratchet's hook is discovered, and runs in web-runner-sync, a full-tier-only job, and nowhere else", () => {
  const r = spawnSync(process.execPath, [join(root, "scripts", "web-tests.mjs"), "plan", "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const runs = (JSON.parse(r.stdout) as { target: string; command: string }[]).filter((p) => p.command.split(" ").includes(HOOK));
  assert.deepEqual(runs, [{ target: "web-runner-sync", command: `node ${HOOK}` }]);
  // (the full tier's own list in ci-paths, and ci.yml's gate on that job)
  const paths = readFileSync(join(root, "scripts", "ci-paths.mjs"), "utf8");
  assert.ok((JSON.parse(/const fullOnlyJobs = (\[[^\]]*\]);/.exec(paths)![1]) as string[]).includes("web-runner-sync"));
  const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
  const sync = job(ci, "web-runner-sync");
  // (the full tier's gate is the condition's last term; a reader of wasm/ wraps it, `${{ ... && (...) }}`)
  assert.match(sync, /^    if: .*needs\.changes\.outputs\.full == 'true'(?:\) \}\})?$/m);
  // (what the hook needs there: Python, the CLI build, and the target's run)
  assert.match(sync, /actions\/setup-python@/);
  assert.match(sync, /node scripts\/build-cli\.mjs/);
  assert.match(sync, /node scripts\/web-tests\.mjs run web-runner-sync$/m);
  // (the target runs in that job only, and no workflow runs the ratchet or the hook another way)
  for (const f of workflows) {
    const text = readFileSync(join(root, ".github", "workflows", f), "utf8");
    const elsewhere = f === "ci.yml" ? text.replace(sync, "") : text;
    assert.doesNotMatch(elsewhere, /web-tests\.mjs run web-runner-sync\b/, f);
    assert.doesNotMatch(text, /numbl-ratchet\.py|test-numbl-corpus\.mjs|NUMBL_CORPUS_/, f);
  }
});

test("the Numbl ratchet's own tests (scripts/test-numbl-ratchet.py, a fake CLI: no corpus run)", () => {
  const r = spawnSync("python3", [join(root, "scripts", "test-numbl-ratchet.py")], { cwd: root, encoding: "utf8", timeout: 180000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-3000));
  assert.match(r.stdout, /^all ok$/m);
});

// N3: the hook's own exit status, which is what the full tier sees: non-zero for a red ratchet, a ratchet killed by a
// signal and a missing CLI; zero for a green one.  A fake ratchet (NUMBL_CORPUS_RATCHET, test-only) stands in for the
// corpus run and logs the arguments the hook gave it.
test("the Numbl ratchet's hook fails when the ratchet fails, is killed or has no CLI, and passes it the CLI and node", () => {
  const d = mkdtempSync(join(tmpdir(), "numbl-hook-"));
  try {
    const fake = join(d, "fake-ratchet.py"), cli = join(d, "pyjs.cjs"), log = join(d, "argv.json");
    writeFileSync(cli, "");
    writeFileSync(fake, [
      "import json, os, signal, sys",
      `json.dump(sys.argv[1:], open(${JSON.stringify(log)}, "w"))`,
      "mode = os.environ['FAKE_MODE']",
      "if mode == 'signal':",
      "    os.kill(os.getpid(), signal.SIGKILL)",
      "sys.exit(1 if mode == 'red' else 0)",
      "",
    ].join("\n"));
    const hook = (mode: string, cliPath = cli) => {
      rmSync(log, { force: true });
      return spawnSync(process.execPath, [join(root, HOOK)], {
        cwd: root, encoding: "utf8", timeout: 60000,
        env: { ...process.env, NUMBL_CORPUS_RATCHET: fake, NUMBL_CORPUS_CLI: cliPath, FAKE_MODE: mode, SAGEBRUSH_CPUS: "3" },
      });
    };
    const green = hook("green");
    assert.equal(green.status, 0, green.stderr);
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), ["--cli", cli, "--node", process.execPath, "--jobs", "3"]);
    const red = hook("red");
    assert.equal(red.status, 1, "a red ratchet must fail the hook");
    const killed = hook("signal");
    assert.equal(killed.status, 1, "a ratchet killed by a signal must fail the hook");
    assert.match(killed.stderr, /killed by SIGKILL/);
    const nocli = hook("green", join(d, "no-such-cli.cjs"));
    assert.equal(nocli.status, 1, "a missing CLI must fail the hook");
    assert.throws(() => readFileSync(log), "with no CLI the ratchet must not run");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
