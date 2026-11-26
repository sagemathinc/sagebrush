// ci: checks.3 order=98
// The merged CI jobs' loops (the CI capacity ruling, Nov 22 2026: web-browser's groups, conformance's runtimes,
// modes' groups, each in one step): their exact run blocks from ci.yml, under the shells Actions uses, with node,
// bun and python3 replaced by stubs that log each command and fail the one named.  With nothing failing every
// group runs every command and the step passes; with any one command failing the step fails, names its group
// (and only it), and every other group still runs all of its commands.  Two known-bad loops are controls: a
// helper that resets the caller's status, and a tested subshell (`( set -e ... ) || rc=$?`), each must be caught.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const yml = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
// (read, not imported: importing ci-paths.mjs runs it, and in CI it writes the step's outputs)
const buckets = /^export const WEB_BUCKETS = (\[[\s\S]*?\n\]);/m.exec(readFileSync(join(root, "scripts", "ci-paths.mjs"), "utf8"))[1];
const WEB_BUCKETS = JSON.parse(buckets.replace(/,(\s*\])/g, "$1"));

// a step's run block, dedented, from its `- name:` line
function runBlock(name, from = "") {
  const lines = yml.split("\n");
  const at = lines.findIndex((line) => line === `      - name: ${name}`);
  if (at < 0) throw new Error(`no step named ${name}`);
  let i = at + 1;
  while (lines[i] !== "        run: |") {
    if (!/^ {8}\S/.test(lines[i]) && !/^ {10}/.test(lines[i])) throw new Error(`${name}: no run block`);
    i++;
  }
  const body = [];
  for (i++; i < lines.length && (lines[i] === "" || lines[i].startsWith("          ")); i++) body.push(lines[i].slice(10));
  let text = body.join("\n").trimEnd() + "\n";
  if (from) {
    const start = text.indexOf(from);
    if (start < 0) throw new Error(`${name}: no ${JSON.stringify(from)}`);
    text = text.slice(start);
  }
  if (text.includes("${{")) throw new Error(`${name}: an expression left in the extracted loop`);
  return text;
}

const stubs = `__run() { local cmd="$*"; printf '%s\\t%s\\n' "\${GROUP:-\${runtime:-}}" "$cmd" >> "$LOG"; [ "$cmd" != "$FAIL" ] || return 17; }
python3() { __run python3 "$@"; }
node() { __run node "$@"; }
bun() { __run bun "$@"; }
`;

const work = mkdtempSync(join(tmpdir(), "ci-loops-"));
mkdirSync(join(work, "packages", "sagebrush-board"), { recursive: true });
const shells = [["--noprofile", "--norc", "-eo", "pipefail"], ["-e"]]; // `shell: bash`, and the default
let failures = 0;
let checks = 0;
const fail = (message) => {
  failures++;
  console.error(`FAIL ${message}`);
};

function run(script, { failing = "", env = {}, shell = shells[0] } = {}) {
  const file = join(work, "step.sh");
  const log = join(work, "log");
  writeFileSync(file, stubs + script);
  writeFileSync(log, "");
  const r = spawnSync("bash", [...shell, file], {
    cwd: work,
    encoding: "utf8",
    env: { PATH: process.env.PATH, LOG: log, FAIL: failing, SAGEBRUSH_CPUS: "2", ...env },
  });
  const ran = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => line.split("\t"));
  const error = /::error::failed (?:groups|on):(.*)/.exec(r.stdout);
  return { status: r.status, ran, failed: error ? error[1].trim().split(/\s+/) : [], stdout: r.stdout + r.stderr };
}

const key = ([group, cmd]) => `${group}\t${cmd}`;

// one step: every command passing, then each command failing in turn
function check(label, script, { env = {}, stopsAtFailure, expectGroups }) {
  const findings = [];
  for (const shell of shells) {
    const pass = run(script, { env, shell });
    if (pass.status !== 0) findings.push(`${label}: passes nothing failing (exit ${pass.status}): ${pass.stdout.slice(-400)}`);
    const groups = [...new Set(pass.ran.map(([g]) => g))];
    if (JSON.stringify(groups) !== JSON.stringify(expectGroups)) findings.push(`${label}: ran groups ${groups.join(" ")}, not ${expectGroups.join(" ")}`);
    for (const [index, [group, cmd]] of pass.ran.entries()) {
      checks++;
      const r = run(script, { failing: cmd, env, shell });
      const what = `${label} [bash ${shell.join(" ")}] with "${cmd}" failing`;
      if (r.status === 0) findings.push(`${what}: the step passed`);
      if (JSON.stringify(r.failed) !== JSON.stringify([group])) findings.push(`${what}: names ${r.failed.join(" ") || "nothing"}, not ${group}`);
      // every other group runs all of its commands; this one runs all (a list of independent commands) or stops there
      const expected = pass.ran.filter(([g], i) => g !== group || !stopsAtFailure || i <= index).map(key);
      if (JSON.stringify(r.ran.map(key)) !== JSON.stringify(expected)) findings.push(`${what}: ran\n  ${r.ran.map(key).join("\n  ")}\nnot\n  ${expected.join("\n  ")}`);
    }
  }
  return findings;
}

const allWeb = WEB_BUCKETS.flatMap(([, groups]) => groups);
const browser = runBlock("browser groups ${{ matrix.groups }}", 'failed=""');
const conformance = runBlock("conformance, then the catalog examples and coverage, on node, deno and bun");
const modes = runBlock("mode groups sage, magma-matlab, numeric and aux");

const report = (findings) => findings.forEach(fail);
report(check("web-browser", browser, { env: { WEB_GROUPS: allWeb.join(" ") }, stopsAtFailure: true, expectGroups: allWeb }));
for (const [name, groups] of WEB_BUCKETS) {
  checks++;
  // (the job's matrix.groups, through the environment as Actions passes it)
  const r = run(browser, { env: { WEB_GROUPS: groups.join(" ") } });
  const ran = [...new Set(r.ran.map(([g]) => g))];
  if (r.status !== 0 || JSON.stringify(ran) !== JSON.stringify(groups)) fail(`web-browser ${name}: ran ${ran.join(" ")} (exit ${r.status}), not ${groups.join(" ")}`);
}
for (const [label, env] of [["an unknown group", { WEB_GROUPS: "notebook no-such-group" }], ["no groups", { WEB_GROUPS: "" }]]) {
  checks++;
  if (run(browser, { env }).status === 0) fail(`web-browser with ${label}: the step passed`);
}
report(check("conformance", conformance, { stopsAtFailure: false, expectGroups: ["node", "deno", "bun"] }));
report(check("modes", modes, { stopsAtFailure: false, expectGroups: ["sage", "magma-matlab", "numeric", "aux"] }));

// the controls: each bad loop must be caught
const controls = [
  ["modes, the helper resetting the caller's rc (#1641 H1)", modes, 'group() { local status=0; echo "::group::$1"; shift; "$@" || status=$?; echo "::endgroup::"; return $status; }', 'group() { echo "::group::$1"; rc=0; shift; "$@" || rc=$?; echo "::endgroup::"; return $rc; }', {}, false, ["sage", "magma-matlab", "numeric", "aux"]],
  ["web-browser, a tested subshell", browser, "set +e\n(\nset -e\n", "rc=0\n(\nset -e\n", { WEB_GROUPS: allWeb.join(" ") }, true, allWeb],
];
for (const [label, script, good, bad, env, stopsAtFailure, expectGroups] of controls) {
  checks++;
  if (!script.includes(good)) {
    fail(`control ${label}: the step no longer has ${JSON.stringify(good)}`);
    continue;
  }
  let mutant = script.replace(good, bad);
  if (label.startsWith("web-browser")) mutant = mutant.replace("\n)\nrc=$?\n", "\n) || rc=$?\n");
  if (check(`control: ${label}`, mutant, { env, stopsAtFailure, expectGroups }).length === 0) fail(`control ${label}: not caught`);
}

rmSync(work, { recursive: true, force: true });
if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log(`ci loops: ${checks} checks, every early failure fails its step and names its group; both bad-loop controls caught`);
