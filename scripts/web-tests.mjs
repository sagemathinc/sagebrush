#!/usr/bin/env node
// The web and script test suites, found by their own headers rather than
// listed in the workflows.  Each test file (web/**/test-*.mjs,
// scripts/test-*.mjs) says near its top where CI runs it, one line per run:
//
//   // ci: web-runner order=120 runner=bun chrome
//   // ci: web-browser/board-a order=30 env=NO_EDIT=1 -- examples/primes.board.json
//   // ci: none (needs a signed-in DEV account)
//   // ci: inline (nightly.yml's export controls)
//
// A target is a job's name, with /GROUP for a matrix group and .N when the
// job runs its suites in more than one place.  The options: order=N (the
// run's place among its target's, then the path), runner=node|bun (node),
// test (node --test), chrome (CHROME=google-chrome), env=K=V (repeatable),
// solo (in a WORKERS target, it runs alone: see runParallel), then -- and
// the arguments.  "none" is a suite CI doesn't run; "inline" is one a
// workflow runs itself (its arguments are the shell's, or its step is its
// own), named there by its path.
//
//   node scripts/web-tests.mjs run TARGET     run the target's suites in order; stop at the first failure
//                                             (a target in WORKERS: that many at once, each one's output whole)
//   node scripts/web-tests.mjs plan [TARGET] [--json]   the commands, without running them
//   node scripts/web-tests.mjs check          every suite has a header; every target is run by a workflow
//                                             and every workflow target has a suite; inline suites are
//                                             named in a workflow, and a workflow names no other suite
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HEAD_LINES = 40;
const TARGET = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)?(\.[0-9]+)?$/;
const ENV = /^[A-Z_][A-Z0-9_]*=[^\s'"$`\\;&|<>()]*$/;
const ARG = /^[^\s'"$`\\;&|<>()*?]+$/;
const WORKFLOWS = ".github/workflows";

export function suites() {
  const out = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--",
      "web/**/test-*.mjs",
      "web/test-*.mjs",
      "scripts/test-*.mjs",
    ],
    { encoding: "utf8" },
  );
  return [...new Set(out.split("\0").filter(Boolean))].sort();
}

// One header line's run, or {none}/{inline} with the reason; throws on a malformed line.
export function parseHeader(text, where = "") {
  const words = text.trim().split(/\s+/);
  const target = words.shift();
  if (target === "none" || target === "inline") {
    const reason = words.join(" ");
    if (!/^\(.+\)$/.test(reason))
      throw new Error(
        `${where}: "ci: ${target}" needs its reason in parentheses`,
      );
    return { kind: target, reason };
  }
  if (!TARGET.test(target ?? ""))
    throw new Error(
      `${where}: "${target}" is not a target (JOB, JOB/GROUP, JOB.N)`,
    );
  const run = {
    kind: "run",
    target,
    order: Infinity,
    runner: "node",
    test: false,
    solo: false,
    env: [],
    args: [],
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    let m;
    if (w === "--") {
      run.args = words.slice(i + 1);
      const bad = run.args.find((a) => !ARG.test(a));
      if (bad !== undefined)
        throw new Error(
          `${where}: argument ${JSON.stringify(bad)} needs a shell: make the suite inline`,
        );
      break;
    } else if ((m = /^order=(-?[0-9]+)$/.exec(w))) run.order = Number(m[1]);
    else if ((m = /^runner=(node|bun)$/.exec(w))) run.runner = m[1];
    else if (w === "test") run.test = true;
    else if (w === "solo") run.solo = true;
    else if (w === "chrome") run.env.push("CHROME=google-chrome");
    else if ((m = /^env=(.*)$/.exec(w)) && ENV.test(m[1])) run.env.push(m[1]);
    else throw new Error(`${where}: unknown option ${JSON.stringify(w)}`);
  }
  if (run.test && run.runner !== "node")
    throw new Error(`${where}: test is node --test`);
  return run;
}

export function headers(file, text) {
  const lines = text.split("\n").slice(0, HEAD_LINES);
  const found = [];
  lines.forEach((line, i) => {
    const m = /^\/\/ ci:(.*)$/.exec(line);
    if (m) found.push({ ...parseHeader(m[1], `${file}:${i + 1}`), file });
  });
  return found;
}

// The targets a suite's header names (a path from the repository's root): for a suite's own workflow contract.
export function targetsOf(file) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  return headers(file, readFileSync(join(root, file), "utf8"))
    .filter((h) => h.kind === "run")
    .map((h) => h.target);
}

export function command(run) {
  return [
    ...run.env,
    run.runner,
    ...(run.test ? ["--test"] : []),
    run.file,
    ...run.args,
  ].join(" ");
}

function allHeaders() {
  return suites().map((file) => ({
    file,
    found: headers(file, readFileSync(file, "utf8")),
  }));
}

function plan(all, target) {
  const runs = all
    .flatMap(({ found }) => found)
    .filter(
      (h) => h.kind === "run" && (target === undefined || h.target === target),
    );
  // (stable: within a file, its header lines' order)
  return runs.sort(
    (a, b) =>
      (a.target < b.target ? -1 : a.target > b.target ? 1 : 0) ||
      a.order - b.order ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
  );
}

function workflowText() {
  return readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => ({ f, text: readFileSync(join(WORKFLOWS, f), "utf8") }));
}

export function check(all, workflows) {
  const problems = [];
  const ran = new Map();
  const named = new Set();
  // (commands only: the workflows' comments don't count)
  for (const { f, text } of workflows) {
    const code = text
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    for (const m of code.matchAll(
      /node scripts\/web-tests\.mjs run ([^\s"']+)/g,
    ))
      ran.set(m[1], f);
    for (const m of code.matchAll(
      /(?:web|scripts)\/[A-Za-z0-9_./-]*test-[A-Za-z0-9_.-]+\.mjs/g,
    ))
      named.add(m[0]);
  }
  const targets = new Set();
  for (const { file, found } of all) {
    if (found.length === 0)
      problems.push(
        `${file}: no "// ci:" header in its first ${HEAD_LINES} lines`,
      );
    const kinds = new Set(found.map((h) => h.kind));
    if (kinds.has("none") && kinds.size > 1)
      problems.push(`${file}: "ci: none" with other headers`);
    if (kinds.has("inline") && !named.has(file))
      problems.push(`${file}: "ci: inline" but no workflow names it`);
    if (!kinds.has("inline") && named.has(file))
      problems.push(
        `${file}: a workflow names it, but its header isn't "ci: inline"`,
      );
    for (const h of found)
      if (h.kind === "run") {
        targets.add(h.target);
        if (!ran.has(h.target))
          problems.push(
            `${file}: target ${h.target} isn't run by any workflow (node scripts/web-tests.mjs run ${h.target})`,
          );
      }
  }
  for (const [t, f] of ran)
    if (!targets.has(t))
      problems.push(`${f}: runs target ${t}, which no suite names`);
  return problems;
}

// The suites a target runs at once: one unless named here.  web-runner's 70
// suites took 19.5 min one after another, past "PR CI <= 10 min" (@sagebrush's
// work order, Nov 7).  Each of its suites has its own temporary site, Chromium
// profile and DevTools port (0, as CDP_PORT is unset), so they share only the
// step's read-only site server.  web-browser/latex: test-latex-page in two
// parts at once (LATEX_PAGE_PART), 8 of the job's 10 minutes alone (Nov 10).
export const WORKERS = { "web-runner": 3, "web-browser/latex": 2 };

function runEnv(r) {
  return {
    ...process.env,
    ...Object.fromEntries(
      r.env.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]),
    ),
  };
}

// The plan's suites, `workers` at a time, started in the plan's order.  Each
// suite's output is printed whole when it ends (START, its output, then END
// and its time), so the log reads suite by suite.  After a failure no more
// suites start; the ones running finish and are printed, and the first
// failure's code is the run's.  A SIGTERM or SIGINT closes the queue first,
// then goes to the suites running; they finish (and are printed), and the
// run's code is the signal's (143, 130), whatever theirs (astra's
// RUNNER-SIGNAL-1: a suite that cleaned up and exited 0 let the next start).
// A solo suite (its header's "solo": one that asserts the main thread's
// blocking or a wall-clock bound, which suites beside it would skew: #801's
// migrate-time 1135 ms) runs alone: the solo suites go first, in the plan's
// order, one at a time with nothing beside them, then the rest `workers` at a
// time (first, so no running suite has to be drained for one).
function runParallel(runs, workers, target) {
  runs = [...runs.filter((r) => r.solo), ...runs.filter((r) => !r.solo)];
  return new Promise((resolve) => {
    let next = 0, ran = 0, running = 0, failed = null, stopped = null, solo = false;
    const children = new Set();
    const stop = (sig, code) => {
      if (stopped !== null) return;
      stopped = code;
      for (const c of children) c.kill(sig);
      if (running === 0) resolve(code);
    };
    process.once("SIGTERM", () => stop("SIGTERM", 143));
    process.once("SIGINT", () => stop("SIGINT", 130));
    const finish = () => {
      if (stopped !== null) return resolve(stopped);
      if (failed !== null) return resolve(failed);
      console.log(`web-tests: ran ${ran} of ${runs.length} (${target}, ${workers} at a time)`);
      resolve(ran > 0 && ran === runs.length ? 0 : 1);
    };
    const start = () => {
      while (running < workers && next < runs.length && failed === null && stopped === null && !solo) {
        const r = runs[next++];
        solo = r.solo;
        const t0 = Date.now(), out = [];
        const child = spawn(r.runner, [...(r.test ? ["--test"] : []), r.file, ...r.args], {
          stdio: ["ignore", "pipe", "pipe"],
          env: runEnv(r),
        });
        running++;
        children.add(child);
        child.stdout.on("data", (d) => out.push(d));
        child.stderr.on("data", (d) => out.push(d));
        let done = false;
        const end = (status, signal, error) => {
          if (done) return;
          done = true;
          running--;
          if (r.solo) solo = false;
          children.delete(child);
          const s = ((Date.now() - t0) / 1000).toFixed(1);
          process.stdout.write(`START ${r.target}: ${command(r)}\n${Buffer.concat(out).toString()}`);
          if (error) {
            console.error(`web-tests: ${r.runner}: ${error.message}`);
            if (failed === null) failed = 127;
          } else if (status !== 0) {
            console.error(`FAILED ${r.target}: ${command(r)} (${signal ?? `exit ${status}`}) after ${s}s`);
            // (as the shell reports a signal: 128 + its number)
            if (failed === null) failed = status ?? 128 + (constants.signals[signal] ?? 0);
          } else {
            console.log(`END ${r.target}: ${command(r)} (${s}s)`);
            ran++;
          }
          if (running === 0 && (failed !== null || stopped !== null || next === runs.length)) finish();
          else start();
        };
        child.on("error", (e) => end(null, null, e));
        child.on("close", (status, signal) => end(status, signal, null));
      }
    };
    start();
  });
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "check") {
    let all;
    try {
      all = allHeaders();
    } catch (e) {
      console.error(e.message);
      return 1;
    }
    const problems = check(all, workflowText());
    for (const p of problems) console.error(p);
    const runs = all
      .flatMap(({ found }) => found)
      .filter((h) => h.kind === "run").length;
    console.log(
      `${all.length} suites, ${runs} runs: ${problems.length ? `${problems.length} problems` : "ok"}`,
    );
    return problems.length ? 1 : 0;
  }
  if (cmd === "plan") {
    const json = rest.includes("--json");
    const target = rest.find((a) => a !== "--json");
    const runs = plan(allHeaders(), target);
    if (json)
      console.log(
        JSON.stringify(
          runs.map((r) => ({ target: r.target, command: command(r) })),
          null,
          1,
        ),
      );
    else for (const r of runs) console.log(`${r.target}\t${command(r)}`);
    return 0;
  }
  if (cmd === "run" && rest.length === 1) {
    const runs = plan(allHeaders(), rest[0]);
    if (runs.length === 0) {
      console.error(`web-tests: no suite names target ${rest[0]}`);
      return 1;
    }
    if ((WORKERS[rest[0]] ?? 1) > 1)
      return runParallel(runs, WORKERS[rest[0]], rest[0]);
    let ran = 0;
    for (const r of runs) {
      console.log(`START ${r.target}: ${command(r)}`);
      const env = {
        ...process.env,
        ...Object.fromEntries(
          r.env.map((e) => [
            e.slice(0, e.indexOf("=")),
            e.slice(e.indexOf("=") + 1),
          ]),
        ),
      };
      const res = spawnSync(
        r.runner,
        [...(r.test ? ["--test"] : []), r.file, ...r.args],
        { stdio: "inherit", env },
      );
      if (res.error) {
        console.error(`web-tests: ${r.runner}: ${res.error.message}`);
        return 127;
      }
      if (res.status !== 0) {
        console.error(
          `FAILED ${r.target}: ${command(r)} (${res.signal ?? `exit ${res.status}`})`,
        );
        // (as the shell reports a signal: 128 + its number)
        return res.status ?? 128 + (constants.signals[res.signal] ?? 0);
      }
      ran++;
    }
    // (the run's own count, so a run that ran nothing, or less than its plan, can never pass silently)
    console.log(`web-tests: ran ${ran} of ${runs.length} (${rest[0]})`);
    return ran > 0 && ran === runs.length ? 0 : 1;
  }
  console.error(
    "usage: node scripts/web-tests.mjs run TARGET | plan [TARGET] [--json] | check",
  );
  return 2;
}

// (run as a script, by any path to it, a symlink or a relative one included: a guard that compared the
// raw argv[1] did nothing, and exited 0, through a symlink)
const isMain = () => {
  try {
    return (
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
};
if (isMain())
  Promise.resolve(main(process.argv.slice(2))).then((code) => {
    process.exitCode = code;
  });
