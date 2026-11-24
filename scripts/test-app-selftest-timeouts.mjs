// ci: checks.3 order=62
// Every step of the app job (.github/workflows/app.yml) that runs the app's
// self-test (app/selftest/run.mjs) has its own timeout-minutes, at most 15 and
// below the job's: a hung self-test fails in minutes, not at the job's 40, so
// it holds its runner, and a merge queue entry, for less (Nov 23 2026: the
// stripped AppImage's self-test hung 32 min and ejected its entry).  Controls:
// the same check over the workflow with one step's timeout removed, and with
// one raised to the job's, must fail.
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

if (failed) {
  console.log(`${failed} failure(s)`);
  process.exit(1);
}
console.log(`app self-test timeouts: ${checks} checks pass; both controls caught`);
