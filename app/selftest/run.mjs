// Run the desktop app's self-test: copy this folder's notebook and data to a
// scratch folder, start the app with SAGEBRUSH_APP_SELFTEST pointing at it,
// and print its report.  The page opens the notebook, runs it (Sage, a file
// in its folder, 3D), checks what Python wrote, saves, checks the Terminal's
// shell worker (web/notebook/selftest-terminal.js), and reports (selftest()
// in web/index.html); the app then exits.  The report's diagnosis lines are
// then read (coi-reading.py, --no-logcat): information for comparing with
// Android, never part of the verdict.
//
// The verdict (run-judge.mjs): the app's output is captured to the END of
// both streams (on "close", never on "exit" alone: astra's NC-R1-A2), then
// the app exits 0 with "all passed"; the report passes the report judge
// (android-report.py, the same closed grammar the Android and iOS legs use:
// every REQUIRED key, the Terminal's three included, exactly once and ok)
// with --engine fixed by THIS platform, never by the report (the grader's
// condition: {win32: chromium (WebView2), darwin: webkit (WKWebView), linux:
// webkit (WebKitGTK)}, any other platform a FAIL), so check 3's engine and its
// rule are judged from outside the page; and the app's own log (its stderr,
// all of it) is the native witness: probe-log.py --desktop finds this run's
// page markers, one per route the page reached, the page's "done" marker
// once after them, and no worker marker at all (app/selftest/probe-grammar.md).
//
// The whole run is bounded at 360 s, the drain included: the self-test before
// the Terminal's checks (240 s, its bound before them), the Terminal's checks
// (85 s at most, each step bounded: check 1's fetch 5 s; check 2 30 s (app_log
// 5, the probe's import 10, two invoke routes 5 each, the page's own fetch 5);
// check 3 45 s (the page's fetch 5, the control worker 10, the worker's whole
// report 30, whose own steps are bounded at 25.5 s); the done marker 5 s), and
// the output's drain after the app's exit (20 s).
//
//   node app/selftest/run.mjs <the app's executable>
import { spawn } from "node:child_process";
import { mkdtempSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, judge, python } from "./run-judge.mjs";

const RUN_MS = 360000;

const exe = process.argv[2];
if (!exe) throw new Error("usage: node app/selftest/run.mjs <executable>");
const here = new URL(".", import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "sagebrush-app-selftest-"));
for (const f of ["selftest.ipynb", "data.csv"]) copyFileSync(new URL(f, here), join(dir, f));
const p = spawn(exe, [], { env: { ...process.env, SAGEBRUSH_APP_SELFTEST: join(dir, "selftest.ipynb") }, stdio: ["ignore", "pipe", "pipe"] });
const res = await capture(p, { deadlineMs: RUN_MS, drainMs: 20000 });
const { passed, report } = judge(res, { dir });
const r = python([fileURLToPath(new URL("coi-reading.py", here)), report, "--no-logcat"]);
if (r.status !== 0) console.log(`(coi-reading.py: ${r.error ? "no python" : "exit " + r.status}; the readings are information only)`);
console.log(passed ? "self-test passed" : `self-test failed (exit code ${res.code})`);
process.exit(passed ? 0 : 1);
