// ci: checks.3 order=62
// Every step of the app job (.github/workflows/app.yml) that runs the app's
// self-test (app/selftest/run.mjs) has its own timeout-minutes, at most 15 and
// below the job's: a hung self-test fails in minutes, not at the job's 40, so
// it holds its runner, and a merge queue entry, for less (Nov 23 2026: the
// stripped AppImage's self-test hung 32 min and ejected its entry).  Controls:
// the same check over the workflow with one step's timeout removed, and with
// one raised to the job's, must fail.
// And which self-tests run where (CI job cuts, cut 2, William Nov 24 2026): on a pull request and in the merge queue
// the stripped AppImage's is the one Linux self-test; the unstripped AppImage's runs only on a push, a dispatch and the
// schedule; macOS and Windows run theirs on every event.  Each step's `if:` is evaluated for each event (the only
// names it may use are runner.os and github.event_name); controls: the unstripped one run everywhere, and the stripped
// one given the same event condition, must fail.
//
//   node scripts/test-app-selftest-timeouts.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const text = readFileSync(join(root, ".github", "workflows", "app.yml"), "utf8");

// (the app job's block: from "  app:" to the next job at two spaces)
function appJob(source) {
  const start = source.search(/^  app:\n/m);
  if (start < 0) return null;
  const rest = source.slice(start + 1);
  const end = rest.search(/^  [a-z0-9-]+:\n/m);
  return end < 0 ? rest : rest.slice(0, end);
}

function check(source) {
  const findings = [];
  const job = appJob(source);
  if (!job) return ["no app job"];
  const jobTimeout = Number(/^    timeout-minutes: (\d+)$/m.exec(job)?.[1]);
  if (!jobTimeout) findings.push("the app job has no timeout-minutes");
  // (steps: each "      - " item up to the next)
  const steps = job.split(/^      - /m).slice(1);
  const selfTests = steps.filter((s) => /node app\/selftest\/run\.mjs/.test(s));
  if (selfTests.length < 4) findings.push(`${selfTests.length} self-test steps, expected at least 4 (Linux, the stripped AppImage, macOS/Windows, the .app)`);
  for (const step of selfTests) {
    const name = /^name: (.+)$/m.exec(step)?.[1] ?? step.split("\n")[0];
    const t = /^        timeout-minutes: (\d+)$/m.exec(step)?.[1];
    if (!t) findings.push(`"${name}": no timeout-minutes`);
    else if (Number(t) > 15 || Number(t) >= jobTimeout) findings.push(`"${name}": timeout-minutes ${t}, not at most 15 and below the job's ${jobTimeout}`);
  }
  return findings;
}

let failed = 0;
let checks = 0;
const findings = check(text);
checks++;
for (const f of findings) { console.log(`FAIL ${f}`); failed++; }

// the controls: each must be caught
const first = /^(        timeout-minutes: )(\d+)\n(        run: xvfb-run -a node app\/selftest\/run\.mjs)/m;
const controls = [
  ["a self-test step's timeout removed", text.replace(first, "$3")],
  ["a self-test step's timeout raised to the job's", text.replace(first, "$140\n$3")],
];
for (const [label, mutated] of controls) {
  checks++;
  if (mutated === text) { console.log(`FAIL control "${label}": the mutation didn't apply`); failed++; }
  else if (check(mutated).length === 0) { console.log(`FAIL control "${label}": not caught`); failed++; }
}

// which self-tests run where: each step's `if:`, per event and runner OS
function runs(step, event, os) {
  const cond = /^        if: (.+)$/m.exec(step)?.[1] ?? "true";
  const e = cond.replace(/\$\{\{\s*|\s*\}\}/g, "").replace(/runner\.os/g, JSON.stringify(os)).replace(/github\.event_name/g, JSON.stringify(event));
  if (/[a-zA-Z_]+\.[a-zA-Z_]/.test(e.replace(/'[^']*'/g, "''"))) throw new Error(`a name this check doesn't model: ${cond}`);
  return Boolean(Function(`return (${e.replace(/==/g, "===").replace(/!===/g, "!==")});`)());
}
const EVENTS = ["pull_request", "merge_group", "push", "workflow_dispatch", "schedule"];
function where(source) {
  const findings = [];
  const steps = (appJob(source) ?? "").split(/^      - /m).slice(1);
  const named = (n) => steps.find((s) => s.startsWith(`name: ${n}\n`));
  const unstripped = named("self-test (Linux, in a virtual display)"), stripped = named("self-test the stripped AppImage"), other = named("self-test");
  if (!unstripped || !stripped || !other) return ["a self-test step not found by name"];
  for (const ev of EVENTS) {
    const fast = ev === "pull_request" || ev === "merge_group";
    if (runs(unstripped, ev, "Linux") === fast) findings.push(`the unstripped AppImage's self-test ${fast ? "runs" : "doesn't run"} on ${ev}`);
    if (!runs(stripped, ev, "Linux")) findings.push(`the stripped AppImage's self-test doesn't run on ${ev}`);
    for (const os of ["macOS", "Windows"]) if (!runs(other, ev, os)) findings.push(`${os}'s self-test doesn't run on ${ev}`);
    if (runs(other, ev, "Linux") || runs(stripped, ev, "macOS")) findings.push(`a self-test on the wrong OS on ${ev}`);
  }
  return findings;
}
checks++;
for (const f of where(text)) { console.log(`FAIL ${f}`); failed++; }
const unstrippedIf = "        if: runner.os == 'Linux' && github.event_name != 'pull_request' && github.event_name != 'merge_group'\n";
for (const [label, mutated] of [
  ["the unstripped self-test run on every event", text.replace(unstrippedIf, "        if: runner.os == 'Linux'\n")],
  ["the stripped self-test given the same event condition", text.replace(/(name: self-test the stripped AppImage\n)        if: runner\.os == 'Linux'\n/, `$1${unstrippedIf}`)],
]) {
  checks++;
  if (mutated === text) { console.log(`FAIL control "${label}": the mutation didn't apply`); failed++; }
  else if (where(mutated).length === 0) { console.log(`FAIL control "${label}": not caught`); failed++; }
}

if (failed) {
  console.log(`${failed} failure(s)`);
  process.exit(1);
}
console.log(`app self-test timeouts and events: ${checks} checks pass; all four controls caught`);
