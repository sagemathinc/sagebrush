import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
  ])
    assert.equal(spawnSync("git", args, { cwd: dir }).status, 0);
  return dir;
}

function cli(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: dir,
    encoding: "utf8",
  });
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
    "web/test-b.mjs": suite(
      "// ci: web order=10\n// ci: web order=30 env=FLAVOR=x -- one two",
    ),
    "web/a/test-a.mjs": suite(
      "// ci: web order=20 runner=bun chrome\n// ci: other test",
    ),
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
  assert.equal(
    readFileSync(join(dir, "log.txt"), "utf8"),
    "test-1.mjs -\ntest-2.mjs a b y\ntest-3.mjs -\n",
  );
  assert.match(r.stdout, /^START web: node web\/test-1\.mjs$/m);
  assert.match(r.stderr, /FAILED web: node web\/test-3\.mjs \(exit 3\)/);
  assert.equal(cli(dir, "run", "nothing").status, 1);
});

test("web-tests run: by any path to the script (a symlink too), it runs, and it ends with ran N of N", () => {
  const dir = repo({
    "web/test-1.mjs": suite("// ci: web order=10"),
    "web/test-2.mjs": suite("// ci: web order=20"),
    ".github/workflows/ci.yml": workflow("web"),
  });
  // (a guard that compared the raw argv[1] ran nothing through a symlink, and exited 0 with no output)
  const link = join(
    mkdtempSync(join(tmpdir(), "web-tests-link-")),
    "web-tests.mjs",
  );
  symlinkSync(script, link);
  const via = (...args: string[]) =>
    spawnSync(process.execPath, [link, ...args], {
      cwd: dir,
      encoding: "utf8",
    });
  const r = via("run", "web");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^web-tests: ran 2 of 2 \(web\)$/m);
  assert.equal(
    readFileSync(join(dir, "log.txt"), "utf8"),
    "test-1.mjs -\ntest-2.mjs -\n",
  );
  const none = via("run", "nosuch");
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no suite names target nosuch/);
  assert.equal(via("check").status, 0);
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
  assert.match(
    r.stderr,
    /scripts\/test-3\.mjs: target lost isn't run by any workflow/,
  );
  assert.match(r.stderr, /ci\.yml: runs target ghost, which no suite names/);
  assert.doesNotMatch(r.stderr, /test-1/);
});

test("web-tests check: inline is a suite a workflow's command names (a comment doesn't); none stands alone", () => {
  const files = {
    "web/test-1.mjs": suite("// ci: inline (ci.yml's own step)"),
    "web/test-2.mjs": suite("// ci: none (needs a DEV account)"),
    "web/test-3.mjs": suite("// ci: web"),
  };
  const named = repo({
    ...files,
    ".github/workflows/ci.yml":
      workflow("web") + '          node web/test-1.mjs "$X"\n',
  });
  assert.equal(cli(named, "check").status, 0, cli(named, "check").stderr);
  const comment = repo({
    ...files,
    ".github/workflows/ci.yml":
      workflow("web") +
      "          # node web/test-1.mjs\n          node web/test-3.mjs\n",
  });
  const r = cli(comment, "check");
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /web\/test-1\.mjs: "ci: inline" but no workflow names it/,
  );
  assert.match(
    r.stderr,
    /web\/test-3\.mjs: a workflow names it, but its header isn't "ci: inline"/,
  );
  const both = repo({
    "web/test-1.mjs": suite("// ci: none (x)\n// ci: web"),
    ".github/workflows/ci.yml": workflow("web"),
  });
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
    const dir = repo({
      "web/test-1.mjs": suite(header),
      ".github/workflows/ci.yml": workflow("web"),
    });
    const r = cli(dir, "check");
    assert.equal(r.status, 1, header);
    assert.match(r.stderr, message, header);
  }
});

// (a suite for a target in WORKERS: it marks itself started and running, logs how many run with it, waits until
// `meet` suites have started (a barrier: one at a time never gets there, and the suite exits 9 after 3000 looks), prints
// a line of its own, then ends with CODE)
const meeting = (header: string, meet: number, code = 0) =>
  `${header}\nimport { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";\n` +
  `const me = import.meta.url.split("/").pop();\n` +
  `for (const d of ["started", "running"]) mkdirSync(d, { recursive: true });\n` +
  `writeFileSync("started/" + me, ""); writeFileSync("running/" + me, "");\n` +
  `appendFileSync("log.txt", me + " " + readdirSync("running").length + "\\n");\n` +
  `let n = 0;\n` +
  `while (readdirSync("started").length < ${meet}) { if (++n > 3000) process.exit(9); await new Promise((r) => setTimeout(r, 10)); }\n` +
  `console.log("own line of " + me);\n` +
  `rmSync("running/" + me);\n` +
  `process.exit(${code});\n`;

test("web-tests run: a target in WORKERS runs that many suites at once, never more, and prints each suite's output whole", () => {
  const files: Record<string, string> = { ".github/workflows/ci.yml": workflow("web-runner") };
  for (let i = 1; i <= 5; i++) files[`web/test-${i}.mjs`] = meeting(`// ci: web-runner order=${i}0`, 3);
  const dir = repo(files);
  const r = cli(dir, "run", "web-runner");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^web-tests: ran 5 of 5 \(web-runner, 3 at a time\)$/m);
  const log = readFileSync(join(dir, "log.txt"), "utf8").trim().split("\n");
  assert.equal(log.length, 5);
  assert.ok(log.every((l) => Number(l.split(" ")[1]) <= 3), log.join("; "));
  // (each suite's START, its own line and its END, together)
  for (let i = 1; i <= 5; i++)
    assert.match(r.stdout, new RegExp(`^START web-runner: node web/test-${i}\\.mjs\\nown line of test-${i}\\.mjs\\nEND web-runner: node web/test-${i}\\.mjs \\([0-9.]+s\\)$`, "m"));
});

test("web-tests run: in WORKERS, a failure is the run's code; no suite starts after it, and the ones that ran are the plan's first", () => {
  const files: Record<string, string> = { ".github/workflows/ci.yml": workflow("web-runner") };
  for (let i = 1; i <= 6; i++) files[`web/test-${i}.mjs`] = meeting(`// ci: web-runner order=${i}0`, 3, i === 2 ? 4 : 0);
  const dir = repo(files);
  const r = cli(dir, "run", "web-runner");
  assert.equal(r.status, 4);
  assert.match(r.stderr, /^FAILED web-runner: node web\/test-2\.mjs \(exit 4\) after [0-9.]+s$/m);
  assert.doesNotMatch(r.stdout, /web-tests: ran/);
  const ran = readFileSync(join(dir, "log.txt"), "utf8").trim().split("\n").map((l) => l.split(" ")[0]);
  assert.ok(ran.length >= 3 && ran.length < 6, ran.join(" "));
  assert.deepEqual([...ran].sort(), Array.from({ length: ran.length }, (_, i) => `test-${i + 1}.mjs`));
});

// (a solo suite: it marks itself started and running, logs how many run with it, then looks 20 times (a moment in
// which a suite started beside it would be seen; never a bound on anything), logs how many have started, and ends)
const alone = (header: string) =>
  `${header}\nimport { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";\n` +
  `const me = import.meta.url.split("/").pop();\n` +
  `for (const d of ["started", "running"]) mkdirSync(d, { recursive: true });\n` +
  `writeFileSync("started/" + me, ""); writeFileSync("running/" + me, "");\n` +
  `appendFileSync("log.txt", me + " " + readdirSync("running").length + "\\n");\n` +
  `for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));\n` +
  `appendFileSync("log.txt", "end " + me + " started=" + readdirSync("started").length + "\\n");\n` +
  `rmSync("running/" + me);\n`;

test("web-tests run: in WORKERS, a solo suite runs first and alone (nothing beside it, nothing started while it runs); the rest then run together", () => {
  const files: Record<string, string> = { ".github/workflows/ci.yml": workflow("web-runner") };
  // (the solo one is in the plan's middle; the three others meet: they only end once all three have started)
  files["web/test-1.mjs"] = meeting("// ci: web-runner order=10", 3);
  files["web/test-2.mjs"] = alone("// ci: web-runner order=15 solo");
  files["web/test-3.mjs"] = meeting("// ci: web-runner order=20", 3);
  files["web/test-4.mjs"] = meeting("// ci: web-runner order=30", 3);
  const dir = repo(files);
  const r = cli(dir, "run", "web-runner");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^web-tests: ran 4 of 4 \(web-runner, 3 at a time\)$/m);
  const log = readFileSync(join(dir, "log.txt"), "utf8").trim().split("\n");
  assert.deepEqual(log.slice(0, 2), ["test-2.mjs 1", "end test-2.mjs started=1"], log.join("; "));
  assert.deepEqual(log.slice(2).map((l) => l.split(" ")[0]).sort(), ["test-1.mjs", "test-3.mjs", "test-4.mjs"]);
  assert.ok(r.stdout.indexOf("END web-runner: node web/test-2.mjs") < r.stdout.indexOf("START web-runner: node web/test-1.mjs"), r.stdout);
});

test("web-tests: solo is a header word; the plan's commands don't change with it", () => {
  const dir = repo({ ".github/workflows/ci.yml": workflow("web-runner"), "web/test-a.mjs": suite("// ci: web-runner order=1 runner=bun solo -- x") });
  const r = cli(dir, "plan", "web-runner");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "web-runner\tbun web/test-a.mjs x");
  assert.equal(cli(dir, "check").status, 0);
});

// (a suite that marks itself started, then on SIGTERM or SIGINT notes that it cleaned up and exits 0; otherwise it
// waits for a file no one writes, and exits 9 after 3000 looks)
const tidy = (header: string) =>
  `${header}\nimport { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";\n` +
  `const me = import.meta.url.split("/").pop();\n` +
  `for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { appendFileSync("log.txt", "cleaned " + me + " " + s + "\\n"); process.exit(0); });\n` +
  // (its handlers before its started mark: the run is signalled once three marks exist, so a suite marked but not yet
  // listening would die by the signal's default and log no cleanup)
  `mkdirSync("started", { recursive: true }); writeFileSync("started/" + me, "");\n` +
  `let n = 0;\n` +
  `while (!existsSync("never")) { if (++n > 3000) process.exit(9); await new Promise((r) => setTimeout(r, 10)); }\n`;

for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const)
  test(`web-tests run: in WORKERS, ${signal} stops the queue before it reaches the suites; they clean up and end, none starts after, and the run's code is ${code}`, async () => {
    const files: Record<string, string> = { ".github/workflows/ci.yml": workflow("web-runner") };
    for (let i = 1; i <= 5; i++) files[`web/test-${i}.mjs`] = tidy(`// ci: web-runner order=${i}0`);
    const dir = repo(files);
    const child = spawn(process.execPath, [script, "run", "web-runner"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    const closed = new Promise<number | null>((r) => child.on("close", (c) => r(c)));
    // (signalled once its three suites have started: they say so themselves)
    let n = 0;
    const started = () => (existsSync(join(dir, "started")) ? readdirSync(join(dir, "started")).length : 0);
    while (started() < 3) {
      assert.ok(++n < 3000, "three suites started");
      await new Promise((r) => setTimeout(r, 10));
    }
    child.kill(signal);
    assert.equal(await closed, code);
    assert.deepEqual(readdirSync(join(dir, "started")).sort(), ["test-1.mjs", "test-2.mjs", "test-3.mjs"]);
    assert.deepEqual(readFileSync(join(dir, "log.txt"), "utf8").trim().split("\n").sort(), [1, 2, 3].map((i) => `cleaned test-${i}.mjs ${signal}`));
    assert.doesNotMatch(stdout, /START web-runner: node web\/test-[45]\.mjs/);
    assert.doesNotMatch(stdout, /web-tests: ran/);
  });
