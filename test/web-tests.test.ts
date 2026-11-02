import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// scripts/web-tests.mjs on small repositories: the suites' "// ci:" headers,
// the plan they make, check's problems, and run's order, environment,
// arguments and first failure.
const script = join(__dirname, "..", "..", "scripts", "web-tests.mjs");

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "web-tests-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  for (const args of [["init", "-q"], ["add", "-A"]]) assert.equal(spawnSync("git", args, { cwd: dir }).status, 0);
  return dir;
}

function cli(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });
}

// (a suite that appends its name, arguments and FLAVOR to log.txt, then exits with CODE or 0)
const suite = (header: string, code = 0) =>
  `${header}\nimport { appendFileSync } from "node:fs";\n` +
  `appendFileSync("log.txt", [import.meta.url.split("/").pop(), ...process.argv.slice(2), process.env.FLAVOR ?? "-"].join(" ") + "\\n");\n` +
  `process.exit(${code});\n`;

const workflow = (...targets: string[]) =>
  `jobs:\n  web:\n    steps:\n      - run: |\n${targets.map((t) => `          node scripts/web-tests.mjs run ${t}\n`).join("")}`;

test("web-tests: the plan follows order, then the path; a file's header lines keep their order", () => {
  const dir = repo({
    "web/test-b.mjs": suite("// ci: web order=10\n// ci: web order=30 env=FLAVOR=x -- one two"),
    "web/a/test-a.mjs": suite("// ci: web order=20 runner=bun chrome\n// ci: other test"),
    ".github/workflows/ci.yml": workflow("web", "other"),
  });
  const r = cli(dir, "plan");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), [
    "other\tnode --test web/a/test-a.mjs",
    "web\tnode web/test-b.mjs",
    "web\tCHROME=google-chrome bun web/a/test-a.mjs",
    "web\tFLAVOR=x node web/test-b.mjs one two",
  ]);
  assert.equal(cli(dir, "check").status, 0);
});

test("web-tests run: in order, with each run's environment and arguments; the first failure stops it with its code", () => {
  const dir = repo({
    "web/test-1.mjs": suite("// ci: web order=10\n// ci: web order=40"),
    "web/test-2.mjs": suite("// ci: web order=20 env=FLAVOR=y -- a b"),
    "web/test-3.mjs": suite("// ci: web order=30", 3),
    ".github/workflows/ci.yml": workflow("web"),
  });
  const r = cli(dir, "run", "web");
  assert.equal(r.status, 3);
  assert.equal(readFileSync(join(dir, "log.txt"), "utf8"), "test-1.mjs -\ntest-2.mjs a b y\ntest-3.mjs -\n");
  assert.match(r.stdout, /^START web: node web\/test-1\.mjs$/m);
  assert.match(r.stderr, /FAILED web: node web\/test-3\.mjs \(exit 3\)/);
  assert.equal(cli(dir, "run", "nothing").status, 1);
});

test("web-tests check: a suite without a header, a target no workflow runs, a workflow target with no suite", () => {
  const dir = repo({
    "web/test-1.mjs": suite("// ci: web"),
    "web/test-2.mjs": suite("// not a header"),
    "scripts/test-3.mjs": suite("// ci: lost"),
    ".github/workflows/ci.yml": workflow("web", "ghost"),
  });
  const r = cli(dir, "check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /web\/test-2\.mjs: no "\/\/ ci:" header/);
  assert.match(r.stderr, /scripts\/test-3\.mjs: target lost isn't run by any workflow/);
  assert.match(r.stderr, /ci\.yml: runs target ghost, which no suite names/);
  assert.doesNotMatch(r.stderr, /test-1/);
});

test("web-tests check: inline is a suite a workflow's command names (a comment doesn't); none stands alone", () => {
  const files = {
    "web/test-1.mjs": suite("// ci: inline (ci.yml's own step)"),
    "web/test-2.mjs": suite("// ci: none (needs a DEV account)"),
    "web/test-3.mjs": suite("// ci: web"),
  };
  const named = repo({ ...files, ".github/workflows/ci.yml": workflow("web") + "          node web/test-1.mjs \"$X\"\n" });
  assert.equal(cli(named, "check").status, 0, cli(named, "check").stderr);
  const comment = repo({ ...files, ".github/workflows/ci.yml": workflow("web") + "          # node web/test-1.mjs\n          node web/test-3.mjs\n" });
  const r = cli(comment, "check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /web\/test-1\.mjs: "ci: inline" but no workflow names it/);
  assert.match(r.stderr, /web\/test-3\.mjs: a workflow names it, but its header isn't "ci: inline"/);
  const both = repo({ "web/test-1.mjs": suite("// ci: none (x)\n// ci: web"), ".github/workflows/ci.yml": workflow("web") });
  assert.match(cli(both, "check").stderr, /"ci: none" with other headers/);
});

test("web-tests: a malformed header is an error naming its line", () => {
  for (const [header, message] of [
    ["// ci: web order=x", /web\/test-1\.mjs:1: unknown option "order=x"/],
    ["// ci: Web", /"Web" is not a target/],
    ["// ci: web runner=bun test", /test is node --test/],
    ["// ci: web -- $HOME", /argument "\$HOME" needs a shell/],
    ["// ci: web env=A=b;c", /unknown option/],
    ["// ci: none", /needs its reason in parentheses/],
  ] as const) {
    const dir = repo({ "web/test-1.mjs": suite(header), ".github/workflows/ci.yml": workflow("web") });
    const r = cli(dir, "check");
    assert.equal(r.status, 1, header);
    assert.match(r.stderr, message, header);
  }
});
