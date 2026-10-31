// Run the desktop app's self-test: copy this folder's notebook and data to a
// scratch folder, start the app with SAGEBRUSH_APP_SELFTEST pointing at it,
// and print its report.  The page opens the notebook, runs it (Sage, a file
// in its folder, 3D), checks what Python wrote, saves, checks the Terminal's
// shell worker (web/notebook/selftest-terminal.js), and reports (selftest()
// in web/index.html); the app then exits.  The report's diagnosis lines are
// then read (coi-reading.py, --no-logcat): information for comparing with
// Android, never part of the verdict.
//
// The verdict: the app exits 0 with "all passed"; the report passes the report
// judge (android-report.py, the same closed grammar the Android and iOS legs
// use: every REQUIRED key, the Terminal's three included, exactly once and ok)
// with --engine fixed by THIS platform, never by the report (the grader's
// condition: {win32: chromium (WebView2), darwin: webkit (WKWebView), linux:
// webkit (WebKitGTK)}, any other platform a FAIL), so check 3's engine and its
// rule are judged from outside the page; and the app's own log (its stderr,
// all of it, until the app exits) is the native witness: probe-log.py --desktop
// finds this run's page markers, one per route the page reached, and no
// worker marker at all (app/selftest/probe-grammar.md).
//
// The whole run is bounded at 300 s: the self-test (240 s before the
// Terminal's checks) plus their own bound (5 s header, 20 s page, 30 s
// worker).
//
//   node app/selftest/run.mjs <the app's executable>
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportLines } from "./report-lines.mjs";

const ENGINE_OF_PLATFORM = { win32: "chromium", darwin: "webkit", linux: "webkit" };
const RUN_MS = 300000;

const exe = process.argv[2];
if (!exe) throw new Error("usage: node app/selftest/run.mjs <executable>");
const here = new URL(".", import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "sagebrush-app-selftest-"));
for (const f of ["selftest.ipynb", "data.csv"]) copyFileSync(new URL(f, here), join(dir, f));
const p = spawn(exe, [], { env: { ...process.env, SAGEBRUSH_APP_SELFTEST: join(dir, "selftest.ipynb") }, stdio: ["ignore", "pipe", "pipe"] });
let out = "", err = "";
p.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
p.stderr.on("data", (d) => { err += d; process.stderr.write(d); });
const timer = setTimeout(() => { console.log(`FAIL the app did not report within ${RUN_MS / 1000} s`); p.kill(); process.exit(1); }, RUN_MS);
const python = (args) => {
  let r = { status: null };
  for (const py of ["python3", "python"]) {
    r = spawnSync(py, ["-I", ...args], { stdio: "inherit" });
    if (!r.error) break;
  }
  return r;
};
p.on("exit", (code) => {
  clearTimeout(timer);
  const lines = reportLines(out);
  const report = join(dir, "report.txt");
  writeFileSync(report, lines.join("\n") + "\n");
  // (the report judge, with this platform's engine)
  const engine = Object.hasOwn(ENGINE_OF_PLATFORM, process.platform) ? ENGINE_OF_PLATFORM[process.platform] : null;
  let judged = false;
  if (!engine) console.log(`FAIL no engine family is known for the platform ${JSON.stringify(process.platform)}`);
  else {
    const j = python([fileURLToPath(new URL("android-report.py", here)), "--engine", engine, report]);
    judged = j.status === 0;
    if (!judged) console.log(`FAIL the report judge, --engine ${engine} (android-report.py: ${j.error ? "no python" : "exit " + j.status})`);
  }
  // (the native witness: the app's log, this run's nonce from the report's check 2)
  const stderr = join(dir, "stderr.txt");
  writeFileSync(stderr, err);
  const nonce = lines.map((l) => /^ok {3}the page reaches the app's bridge: nonce=([0-9a-f-]{36}) /.exec(l)?.[1]).find(Boolean);
  let witness = false;
  if (!nonce) console.log("FAIL the native witness: no nonce in the report's check 2");
  else {
    const w = python([fileURLToPath(new URL("probe-log.py", here)), "--desktop", stderr, nonce, report]);
    witness = w.status === 0;
    if (!witness) console.log(`FAIL the native witness (probe-log.py: ${w.error ? "no python" : "exit " + w.status})`);
  }
  const passed = code === 0 && out.includes("all passed") && judged && witness;
  const r = python([fileURLToPath(new URL("coi-reading.py", here)), report, "--no-logcat"]);
  if (r.status !== 0) console.log(`(coi-reading.py: ${r.error ? "no python" : "exit " + r.status}; the readings are information only)`);
  console.log(passed ? "self-test passed" : `self-test failed (exit code ${code})`);
  process.exit(passed ? 0 : 1);
});
