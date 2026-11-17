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
// The first run is without the engine subprocess (SAGEBRUSH_APP_ENGINE=off,
// app/src-tauri/src/engine.rs): the page runs Python itself.  Then, on macOS
// and Linux, where app/engine/ and app/dist are here (a checkout with the
// page built), the same self-test again with the engine subprocess: in a
// built .app or an AppImage, the one it ships; else, where
// app/engine/bundle.mjs has made it (macOS, Linux), the same files and pinned
// Node, named by SAGEBRUSH_APP_ENGINE and its siblings (a bare executable has
// no resources beside it); else app/engine/ run by this Node.  It is judged
// the same way, and the app's log must say the engine's interpreter ran the
// notebook ("interpreter: the engine subprocess's", selftest() in
// web/index.html).  Then, on Linux, once more with a Node that can't start, as
// on a system whose C library is older than Node needs (it prints the
// loader's error and exits): the page must fall back to its own worker, pass,
// and say so ("interpreter: the page's own worker").  Each run has its own
// bound.
//
//   node app/selftest/run.mjs <the app's executable>
import { spawn } from "node:child_process";
import { mkdtempSync, copyFileSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, judge, python } from "./run-judge.mjs";

const RUN_MS = 360000;

const exe = process.argv[2];
if (!exe) throw new Error("usage: node app/selftest/run.mjs <executable>");
const here = new URL(".", import.meta.url);
async function selftest(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sagebrush-app-selftest-"));
  for (const f of ["selftest.ipynb", "data.csv"]) copyFileSync(new URL(f, here), join(dir, f));
  const p = spawn(exe, [], { env: { ...process.env, ...env, SAGEBRUSH_APP_SELFTEST: join(dir, "selftest.ipynb") }, stdio: ["ignore", "pipe", "pipe"] });
  const res = await capture(p, { deadlineMs: RUN_MS, drainMs: 20000 });
  const { passed, report } = judge(res, { dir });
  const r = python([fileURLToPath(new URL("coi-reading.py", here)), report, "--no-logcat"]);
  if (r.status !== 0) console.log(`(coi-reading.py: ${r.error ? "no python" : "exit " + r.status}; the readings are information only)`);
  return { passed, res };
}
let { passed, res } = await selftest({ SAGEBRUSH_APP_ENGINE: "off" });
console.log(passed ? "self-test passed" : `self-test failed (exit code ${res.code})`);
const engine = fileURLToPath(new URL("../engine/main.mjs", here)), root = fileURLToPath(new URL("../dist", here));
if (passed && process.platform !== "win32" && existsSync(engine) && existsSync(join(root, "sagebrush-worker.js"))) {
  console.log("\nthe self-test again, with the engine subprocess");
  // (the pinned Node app/engine/bundle.mjs puts beside the app, by this platform's target triple)
  const triple = { darwin: "aarch64-apple-darwin", linux: "x86_64-unknown-linux-gnu" }[process.platform];
  const bundled = fileURLToPath(new URL("../src-tauri/engine/", here)), bundledNode = triple ? fileURLToPath(new URL(`../src-tauri/binaries/sagebrush-node-${triple}`, here)) : "";
  const env = /\.app\/Contents\/MacOS\/[^/]+$/.test(exe) || /\.AppImage$/.test(exe) ? ["the engine the app ships", {}]
    : bundledNode && existsSync(join(bundled, "main.mjs")) && existsSync(bundledNode) ? ["the shipped engine's files and Node", { SAGEBRUSH_APP_ENGINE: join(bundled, "main.mjs"), SAGEBRUSH_APP_ENGINE_ROOT: join(bundled, "root"), SAGEBRUSH_APP_ENGINE_NODE: bundledNode }]
    : ["app/engine/, run by this Node", { SAGEBRUSH_APP_ENGINE: engine, SAGEBRUSH_APP_ENGINE_ROOT: root, SAGEBRUSH_APP_ENGINE_NODE: process.execPath }];
  console.log(`(${env[0]})`);
  ({ passed, res } = await selftest(env[1]));
  const used = /interpreter: the engine subprocess's/.test(res.err);
  if (!used) console.log("FAIL the app's log doesn't say the engine's interpreter ran the notebook");
  passed &&= used;
  console.log(passed ? "self-test with the engine passed" : `self-test with the engine failed (exit code ${res.code})`);
  if (passed && process.platform === "linux") {
    console.log("\nthe self-test again, with a Node that can't start (an older C library than it needs)");
    const fake = join(mkdtempSync(join(tmpdir(), "sagebrush-old-libc-")), "node");
    writeFileSync(fake, "#!/bin/sh\necho \"node: /lib/x86_64-linux-gnu/libc.so.6: version \\`GLIBC_2.28' not found (required by node)\" >&2\nexit 1\n");
    chmodSync(fake, 0o755);
    ({ passed, res } = await selftest({ SAGEBRUSH_APP_ENGINE: engine, SAGEBRUSH_APP_ENGINE_ROOT: root, SAGEBRUSH_APP_ENGINE_NODE: fake }));
    const own = /interpreter: the page's own worker/.test(res.err);
    if (!own) console.log("FAIL the app's log doesn't say the page's own worker ran the notebook");
    passed &&= own;
    console.log(passed ? "self-test with a Node that can't start passed (the page's own worker)" : `self-test with a Node that can't start failed (exit code ${res.code})`);
  }
}
// The workspace is kept between launches: the page's origin, which the web view keeps it by, is
// http://127.0.0.1:<this install's port> (lib.rs page_listener), the same in every launch.  Two launches, each
// with SAGEBRUSH_APP_PERSIST (persistProbe in web/index.html): the first makes a workspace file holding a token
// and exits as quitting does; the second must find it there, at the same origin, and deletes it.  Then the port
// held by another program (a page there would be served to the app's window): on 127.0.0.1, the app must say so
// and exit 3 (lib.rs fail_closed) without a request to that program; on every address (0.0.0.0), the same, or (where
// the system lets a socket on 127.0.0.1 take that address's connections from one on every address, as macOS's and
// Windows's do) start as ever, still without a request to it.  On every platform, after the self-tests above.
async function launch(env, bound = 120000) {
  const p = spawn(exe, [], { env: { ...process.env, SAGEBRUSH_APP_ENGINE: "off", SAGEBRUSH_APP_SELFTEST: join(mkdtempSync(join(tmpdir(), "sagebrush-app-persist-")), "selftest.ipynb"), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const res = await capture(p, { deadlineMs: bound, drainMs: 20000 });
  return { ...res, origin: /\[app\] the page is at (http:\/\/127\.0\.0\.1:(\d+)\/)/.exec(res.err) };
}
const persistLine = (res) => /^(ok|FAIL) persist: .*$/m.exec(res.out)?.[0] ?? "(no persist line)";
async function squatted(host, port) {
  const { createServer } = await import("node:http");
  const seen = [];
  // (what the app's window would run, were it to load this: the self-test's report, passed)
  const hostile = "<!doctype html><script>window.__TAURI__?.core.invoke('selftest_report', { report: 'ok persist: a squatter served this\\nall passed', ok: true })</script>";
  const server = createServer((req, res) => { seen.push(req.url); res.writeHead(200, { "content-type": "text/html" }).end(hostile); });
  await new Promise((ok, no) => server.once("error", no).listen(port, host, ok));
  return { seen, close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }) };
}
if (passed) {
  console.log("\nthe workspace is kept between launches (two launches)");
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const one = await launch({ SAGEBRUSH_APP_PERSIST: `write:${token}` });
  const two = one.code === 0 ? await launch({ SAGEBRUSH_APP_PERSIST: `check:${token}` }) : null;
  console.log(`launch 1: ${persistLine(one)} (exit ${one.code}); launch 2: ${two ? `${persistLine(two)} (exit ${two.code})` : "not run"}`);
  const same = !!one.origin && !!two?.origin && one.origin[1] === two.origin[1];
  if (!same) console.log(`FAIL the two launches' pages weren't at one origin: ${one.origin?.[1] ?? "?"} and ${two?.origin?.[1] ?? "?"}`);
  passed = one.code === 0 && two?.code === 0 && /^ok persist: found /m.test(two.out) && same;
  console.log(passed ? "the workspace was kept between launches" : "FAIL the workspace wasn't kept between launches");
  const port = Number(one.origin?.[2]);
  for (const host of passed ? ["127.0.0.1", "0.0.0.0"] : []) {
    console.log(`\nthe app's port (${port}) held by another program, on ${host}`);
    let sq;
    try { sq = await squatted(host, port); } catch (e) { console.log(`(couldn't hold ${host}:${port} here: ${e.code ?? e.message}; this case not checked)`); continue; }
    const t = `${token}-${host === "0.0.0.0" ? "any" : "lo"}`;
    const r = await launch({ SAGEBRUSH_APP_PERSIST: `write:${t}` }, 60000);
    await sq.close();
    const refused = r.code === 3 && /Sagebrush couldn't use its port, 127\.0\.0\.1:\d+/.test(r.err);
    const started = host === "0.0.0.0" && r.code === 0 && /^ok persist: made /m.test(r.out);
    console.log(`exit ${r.code}; the other program's requests: ${sq.seen.length ? sq.seen.slice(0, 5).join(", ") : "none"}`);
    if (sq.seen.length) console.log("FAIL the app's window asked the other program for a page");
    if (!refused && !started) console.log(`FAIL the app neither refused (exit 3, saying its port couldn't be used) nor${host === "0.0.0.0" ? "" : " (on 127.0.0.1, it can't)"} started as ever`);
    passed &&= !sq.seen.length && (refused || started);
    // (the file the started launch made, deleted)
    if (started) passed &&= (await launch({ SAGEBRUSH_APP_PERSIST: `check:${t}` })).code === 0;
  }
  console.log(passed ? "the port's checks passed" : "the port's checks failed");
}
process.exit(passed ? 0 : 1);
