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
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, writeFileSync, readFileSync, chmodSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as httpCreateServer } from "node:http";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, judge, python } from "./run-judge.mjs";
import { signerVerdict } from "./signer-judge.mjs";

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
// The workspace is kept between launches, on disk (app/src-tauri/src/disk.rs, web/workspace/disk-mirror.ts), not
// by the page's origin: two launches on two different ports (SAGEBRUSH_APP_PORT: two origins, and a web view that
// keeps nothing), sharing a data folder of this test's own (SAGEBRUSH_APP_DATA_DIR), each with SAGEBRUSH_APP_PERSIST
// (web/workspace/persist-probe.ts).  The first makes a data file, a notebook, a board and a setting, waits until they
// are on disk (and times a large notebook's, board's and data file's write-through), and exits; its file and its
// setting must be in the data folder (settings.json).  Between the launches another program (this test) changes the
// data file on disk, and allows the notebook to change a folder (grants.json); the second must find all four, the data
// file as changed and the notebook still allowed there (another id now), at its other origin, then deletes
// them and finds them gone from disk, the setting gone from settings.json.  Each launch also checks the page has
// cross-origin isolation and SharedArrayBuffer in the page and a worker (OPFS said only).  Then the controls: the
// same with the first launch's write-through left out, and with the second's import left out: each must fail.
// On every platform, after the self-tests above.
async function launch(env, bound = 120000) {
  const p = spawn(exe, [], { env: { ...process.env, SAGEBRUSH_APP_ENGINE: "off", SAGEBRUSH_APP_SELFTEST: join(mkdtempSync(join(tmpdir(), "sagebrush-app-persist-")), "selftest.ipynb"), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const res = await capture(p, { deadlineMs: bound, drainMs: 20000 });
  return { ...res, origin: /\[app\] the page is at (http:\/\/127\.0\.0\.1:(\d+)\/)/.exec(res.err)?.[1] };
}
const persistLine = (res) => /^(ok|FAIL) persist: .*$/m.exec(res.out)?.[0] ?? "(no persist line)";
// (a port free now: the system's, let go)
const freePort = () => new Promise((ok, no) => { const s = createServer(); s.once("error", no).listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
// Two launches, sharing a data folder (`data`), on two different free ports; `control` (SAGEBRUSH_APP_DISK_CONTROL):
// the import, or the write-through, left out of one launch, so the check must then fail.
async function twoLaunches(control) {
  const data = mkdtempSync(join(tmpdir(), "sagebrush-app-data-"));
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let a = await freePort(), b = await freePort();
  while (b === a) b = await freePort();
  const one = await launch({ SAGEBRUSH_APP_PERSIST: `write:${token}`, SAGEBRUSH_APP_PORT: String(a), SAGEBRUSH_APP_DATA_DIR: data, ...(control === "no-write" ? { SAGEBRUSH_APP_DISK_CONTROL: control } : {}) }, 240000);
  console.log(`launch 1 (port ${a}${control === "no-write" ? ", no write-through" : ""}): ${persistLine(one)} (exit ${one.code})`);
  const file = join(data, "Workspace", `sagebrush-persist-${token}.txt`), settings = join(data, "settings.json");
  const onDisk = existsSync(file) && readFileSync(file, "utf8") === token;
  const settingKept = existsSync(settings) && JSON.parse(readFileSync(settings, "utf8"))["sagebrush-files-sort"] === "probe-" + token;
  if (!onDisk) console.log(`launch 1's data file isn't on disk as written: ${file}`);
  if (!settingKept) console.log(`launch 1's setting isn't in ${settings}`);
  // (and the notebook's file permission, in grants.json by its path: web/workspace/grants-file.ts)
  const grantsFile = join(data, "grants.json");
  const grantKept = existsSync(grantsFile) && readFileSync(grantsFile, "utf8").includes(JSON.stringify(`ws:/sagebrush-persist-${token}.ipynb`));
  if (!grantKept && one.code === 0) console.log(`launch 1's file permission isn't in ${grantsFile}`);
  if (onDisk) writeFileSync(file, token + "-edited");
  const two = one.code === 0 && onDisk && settingKept ? await launch({ SAGEBRUSH_APP_PERSIST: `check:${token}`, SAGEBRUSH_APP_PORT: String(b), SAGEBRUSH_APP_DATA_DIR: data, ...(control === "no-import" ? { SAGEBRUSH_APP_DISK_CONTROL: control } : {}) }) : null;
  console.log(`launch 2 (port ${b}${control === "no-import" ? ", no import" : ""}): ${two ? `${persistLine(two)} (exit ${two.code})` : "not run"}`);
  const differ = !!one.origin && !!two?.origin && one.origin !== two.origin;
  const settingGone = two?.code === 0 && existsSync(settings) && JSON.parse(readFileSync(settings, "utf8"))["sagebrush-files-sort"] === undefined;
  return {
    kept: one.code === 0 && onDisk && settingKept && grantKept && two?.code === 0 && /^ok persist: found /m.test(two.out) && differ && settingGone,
    // (the first launch's probe ran to its end, healthy: the files made, the page's capabilities there)
    firstHealthy: one.code === 0 && /^ok persist: made /m.test(one.out),
    onDisk,
    // (the second launch's probe ran and failed for the reason the import's control is about: the file not there)
    secondMissed: !!two && two.code === 1 && /^FAIL persist: check at .*: \/sagebrush-persist-\S+\.txt isn't in this workspace/m.test(two.out),
  };
}
if (passed) {
  console.log("\nthe workspace on disk, kept between two launches on different ports");
  passed = (await twoLaunches(null)).kept;
  console.log(passed ? "the workspace was kept on disk between launches" : "FAIL the workspace wasn't kept between launches");
  // (the controls: without the write-through, or without the import, the same check fails, and for that reason: the
  // first launch healthy and its files not on disk; or the first launch healthy and the second not finding them.  A
  // launch that crashed or timed out is no such failure: the control then fails too)
  for (const control of passed ? ["no-write", "no-import"] : []) {
    console.log(`\nthe control: the same, ${control === "no-write" ? "without the write-through" : "without the import"} (must fail, for that reason)`);
    const r = await twoLaunches(control);
    const why = control === "no-write" ? r.firstHealthy && !r.onDisk : r.firstHealthy && r.onDisk && r.secondMissed;
    if (r.kept) console.log(`FAIL the check passed ${control === "no-write" ? "without the write-through" : "without the import"}: it doesn't see the path it checks`);
    else if (!why) console.log(`FAIL the control didn't fail for its reason (${control === "no-write" ? "a healthy first launch, its files not on disk" : "a healthy first launch, the second not finding its file"}): a crash or a timeout, not the check`);
    else console.log("the control failed, for its reason, as it must");
    passed &&= !r.kept && why;
  }
}
// Who can reach the app's commands (app/src-tauri/src/nav.rs; web/workspace/persist-probe.ts, "nav"): a launch with
// SAGEBRUSH_APP_PERSIST=nav:<another local server's origin>.  The page probes a notebook output's frame
// (sandbox="allow-scripts" srcdoc), whose every way to the commands must be refused while the page's own succeed; then
// it loads a frame and a window of the other server's and sends its own window there, and must stay, its commands
// still working.  The other server's pages (/frame, /open, /top) try the commands too and say so to it: none may
// reach them.  The controls (SAGEBRUSH_APP_NAV_CONTROL): "open", the window's navigation guard left out: the other
// server's page and frame load in the window, and the commands, granted to the page's exact origin only, still refuse
// them; "wide", that and the commands granted to every http://127.0.0.1 port (as before): the page loads and reaches
// them.
function otherServer() {
  const seen = [];
  const page = (name) => `<!doctype html><script>
    const say = (v) => fetch("/report?p=${name}&v=" + encodeURIComponent(v)).catch(() => {});
    say("loaded");
    (async () => {
      try { const w = await window.__TAURI__.core.invoke("disk_where"); say("REACHED disk_where " + String(w).length); }
      catch (e) { say("refused: " + String(e && e.message || e).slice(0, 80)); }
      try { const x = await window.__TAURI__.fs.exists("/"); say("REACHED fs.exists " + x); }
      catch (e) { say("fs refused: " + String(e && e.message || e).slice(0, 80)); }
      // (the approvals window's signing command, N1: never another origin's page's, wherever it is loaded)
      try { const x = await window.__TAURI__.core.invoke("signer_probe_sign", { msg: "${name}" }); say("REACHED signer " + String(x).slice(0, 40)); }
      catch (e) { say("signer refused: " + String(e && e.message || e).slice(0, 80)); }
    })();
  <\/script>`;
  const server = httpCreateServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/report") seen.push(`${u.searchParams.get("p")}: ${u.searchParams.get("v")}`);
    else seen.push(`${u.pathname.slice(1) || "/"}: requested`);
    res.writeHead(200, { "Content-Type": "text/html", "Cross-Origin-Resource-Policy": "cross-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Access-Control-Allow-Origin": "*" });
    res.end(u.pathname === "/report" ? "" : page(u.pathname.slice(1)));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ origin: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() })));
}
async function navLaunch(control) {
  const o = await otherServer();
  const res = await launch({ SAGEBRUSH_APP_PERSIST: `nav:${o.origin}`, SAGEBRUSH_APP_DATA_DIR: mkdtempSync(join(tmpdir(), "sagebrush-app-data-")), ...(control ? { SAGEBRUSH_APP_NAV_CONTROL: control } : {}) }, control ? 60000 : 120000);
  await new Promise((r) => setTimeout(r, 1000));
  o.close();
  const line = persistLine(res);
  console.log(`launch${control === "open" ? " (navigation guard left out)" : control === "wide" ? " (navigation guard left out, commands for every port)" : ""}: ${line} (exit ${res.code})`);
  console.log(`  the other server (${o.origin}) saw: ${o.seen.length ? o.seen.join("; ") : "nothing"}`);
  const reached = o.seen.filter((s) => / REACHED|: REACHED/.test(s));
  const frameLoaded = o.seen.includes("frame: loaded");
  // (the frame's own positive, on Windows and in the "open" control: it loaded, and both its command calls were
  // refused, the capability showing)
  const frameRefused = frameLoaded && o.seen.some((x) => x.startsWith("frame: refused")) && o.seen.some((x) => x.startsWith("frame: signer refused"));
  return { line, code: res.code, reached, topLoaded: o.seen.includes("top: loaded"), frameLoaded, frameRefused };
}
if (passed) {
  console.log("\nwho can reach the app's commands: a notebook output's frame, another local server's pages");
  const r = await navLaunch(false);
  // (the other origin's frame: refused before it loads by the window's navigation guard where the web view asks it about
  // a frame's navigation (macOS and Linux, nav.rs may_load); WebView2 asks only about the window's own, so on Windows
  // the frame loads and the exact-origin capability alone refuses it: there it must have loaded and had both its calls
  // (disk_where and the signing command) refused, so a frame that silently never ran fails too)
  const frameGuarded = process.platform === "win32" ? r.frameRefused : !r.frameLoaded;
  const good = r.code === 0 && /^ok persist: nav at /m.test(r.line) && !r.reached.length && !r.topLoaded && frameGuarded;
  console.log(good ? "only the app's own page reached its commands" : `FAIL ${r.reached.length ? `another origin's page reached the commands: ${r.reached.join("; ")}` : r.topLoaded ? "the window loaded another origin's page" : !frameGuarded ? (process.platform === "win32" ? "another origin's frame didn't load and show both its calls refused (the capability's positive)" : "another origin's frame loaded in the window: its navigation guard didn't refuse it") : "the probe failed (above)"}`);
  passed = good;
  // (the controls: each must show what its part keeps out)
  for (const control of passed ? ["open", "wide"] : []) {
    console.log(`\nthe control: the same, ${control === "open" ? "the navigation guard left out (the page may leave; the commands must still refuse the other origin)" : "the guard left out and the commands for every port (the other origin's page must reach them)"}`);
    const c = await navLaunch(control);
    const topReached = c.reached.some((s) => s.startsWith("top: REACHED"));
    // ("open": the other origin's frame too must load, and have both its calls refused, on every OS: so the launch
    // without the control, where it never loaded on macOS and Linux, shows the guard refusing it, not a frame that
    // couldn't load at all; and the capability refusing it without the guard)
    const why = control === "open" ? c.topLoaded && c.frameRefused && !c.reached.length : c.topLoaded && topReached;
    console.log(why ? `the control ${control === "open" ? "showed the exact-origin grant holding on its own" : "failed, for its reason, as it must: the other origin's page reached the commands"}` : `FAIL the control didn't show its reason (${control === "open" ? "the other origin's page and frame loaded, refused the commands" : "the other origin's page loaded and reached the commands"}): ${c.line}${control === "open" ? ` (top ${c.topLoaded ? "loaded" : "not loaded"}, frame ${c.frameLoaded ? (c.frameRefused ? "loaded and refused" : "loaded, its calls not both refused") : "not loaded"})` : ""}`);
    passed &&= why;
  }
}
// Two windows (#1541: app/src-tauri/src/windows.rs; web/workspace/persist-probe.ts, "windows"): a launch with
// SAGEBRUSH_APP_PERSIST=windows:<token>.  The first window leaves a marker in its localStorage, sessionStorage and
// IndexedDB and opens a second, which must see none of them (each window its own storage: on Windows, its own WebView2
// data folder), must find the first's file on disk, must be told the first window has that file open, and whose report,
// a file it writes, must reach the first as another window's change.  A window's web view data folder
// (<data>/webviews/<label>) goes when it closes, or at the next launch: after the app exits none may be left, but on
// Windows, whose web view may still hold its folder then; and after the next launch (the control, the same data folder,
// opening no second window) none at all.  The control ("windows:<token>:same"): the second window's reading done in the
// first itself, which sees its own markers: the check must fail, for that reason.
async function windowsLaunch(control, data) {
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const res = await launch({ SAGEBRUSH_APP_PERSIST: `windows:${token}${control ? ":same" : ""}`, SAGEBRUSH_APP_DATA_DIR: data }, 120000);
  const left = existsSync(join(data, "webviews")) ? readdirSync(join(data, "webviews")) : [];
  const line = persistLine(res);
  console.log(`launch${control ? " (the second window's reading done in the first)" : ""}: ${line} (exit ${res.code})${left.length ? `; web view data folders left: ${left.join(", ")}` : ""}`);
  return { line, code: res.code, left };
}
if (passed) {
  console.log("\ntwo windows: each its own storage, the same files");
  const data = mkdtempSync(join(tmpdir(), "sagebrush-app-data-"));
  const r = await windowsLaunch(false, data);
  const good = r.code === 0 && /^ok persist: windows at /m.test(r.line) && (!r.left.length || process.platform === "win32");
  console.log(good ? "the second window saw nothing of the first's storage, and the same files" : `FAIL ${r.left.length ? "a window's web view data folder was left after the app quit" : "the two-window check failed (above)"}`);
  passed = good;
  if (passed) {
    console.log("\nthe control: the same, the second window's reading done in the first (must fail, for that reason)");
    const c = await windowsLaunch(true, data);
    const why = c.code === 1 && /^FAIL persist: windows at .*saw the first's marker in local, session, idb/m.test(c.line);
    console.log(why ? "the control failed, for its reason, as it must" : `FAIL the control didn't fail for its reason (the markers seen): ${c.line}`);
    if (c.left.length) console.log("FAIL the last launch's web view data folders weren't removed at this launch");
    passed &&= why && !c.left.length;
  }
}
// The approvals window (N1, app/src-tauri/src/signer.rs; the verdict is signer-judge.mjs, whose expectations it
// states): a launch with SAGEBRUSH_APP_PERSIST=signer:<another local server's origin>.  The app opens the approvals
// window as its menu does; its page signs once with the stand-in command (no key yet).  The main page, a second window,
// a notebook output's frame and the other server's frame each try the command, and the main page tries to open the
// window from a page.  Then the controls, each leaving one guard out (SAGEBRUSH_APP_SIGNER_CONTROL): "cap" the command
// in the page's capability too (other windows' calls reach it; its own check refuses them), "cap+check" that and no
// check (another window's call signs: the probe sees the path it checks), "csp-off" the signer's page without its CSP,
// framing the other server's page, and "guard-off" the signer window's navigation guard left out, the window sent to
// that page (each loads there, and reaches nothing).  Calls that reached the command and signatures are counted from
// the app's own log.
// (what's in a folder, as relative paths, folders ending in "/"; null if it isn't there)
function listTree(dir, rel = "") {
  if (!existsSync(dir)) return null;
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(`${r}/`, ...listTree(dir, r));
    else out.push(r);
  }
  return out;
}
async function signerLaunch(control) {
  const o = await otherServer();
  const data = mkdtempSync(join(tmpdir(), "sagebrush-app-data-"));
  // (a previous launch's leftover, as a crash leaves it: the launch's cleanup must remove it, signer.rs)
  mkdirSync(join(data, "signer-webview"), { mode: 0o700 });
  writeFileSync(join(data, "signer-webview", "crash-leftover"), "x");
  const res = await launch({ SAGEBRUSH_APP_PERSIST: `signer:${o.origin}`, SAGEBRUSH_APP_DATA_DIR: data, ...(control ? { SAGEBRUSH_APP_SIGNER_CONTROL: control } : {}) }, 120000);
  await new Promise((r) => setTimeout(r, 1000));
  o.close();
  // (the approvals window's web view data folder once the app has quit: signer.rs DATA_FOLDER)
  const left = listTree(join(data, "signer-webview"));
  console.log(`  the approvals window's data folder after the app quit: ${left === null ? "absent" : left.length ? `${left.length} entries: ${left.slice(0, 80).join(", ")}` : "empty"}`);
  const v = signerVerdict({ err: res.err, out: res.out, seen: o.seen, control, code: res.code, signal: res.signal, problems: res.problems, left });
  console.log(`launch${control ? ` (control: ${control})` : ""}: ${persistLine(res)} (exit ${res.code}); reached the command ${v.counts.dispatches} (${v.counts.dispatchesOthers} not the approvals window's), signed ${v.counts.signed} (${v.counts.signedOthers} not the approvals window's)`);
  console.log(`  the other server (${o.origin}) saw: ${o.seen.length ? o.seen.join("; ") : "nothing"}`);
  return v;
}
if (passed) {
  for (const control of [null, "cap", "cap+check", "csp-off", "guard-off"]) {
    console.log(`\nthe approvals window${control ? `, the control "${control}"` : ": only its own page signs"}`);
    const v = await signerLaunch(control);
    console.log(v.ok ? "as it must" : `FAIL ${v.why.join("; ")}`);
    passed &&= v.ok; // (every row runs, after a failure too: a control's outcome says why the positive failed)
  }
}
process.exit(passed ? 0 : 1);
