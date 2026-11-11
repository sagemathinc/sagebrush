// ci: web-runner order=123 chrome
// pyexpat and xml.parsers.expat in the browser's worker (P3c-1, the design note r3 all five lanes cleared), in
// headless Chromium against the built worker (web/worker.ts; lib/pyexpat.py and lib/xml/ in the mod-xml group, fetched
// at the first import):
//   - every whole-document case of test/expat_corpus.json (CPython 3.14.10's events, errors, codes and positions)
//     gives CPython's result, through test/expat_run.py --whole, except the cases test/expat_divergences.json states,
//     which give the result stated there;
//   - test/expat_api_cases.py, the module's interface, prints what CPython prints, line for line;
//   - a cold program fetches no XML code: the group mod-xml is fetched at the first import, once (the worker's
//     requests, seen through the DevTools protocol);
//   - xml.dom and xml.sax are not here (P3c's scope: @sagebrush's ruling), ModuleNotFoundError;
//   - xml.etree (P3c-2): test/etree_cases.py prints test/etree_cases.out (CPython 3.14.10's), and
//     test/etree_files.py, every open() xml.etree makes, on the worker's file system, prints test/etree_files.out;
//     test/etree_svg.py over an SVG the CLI's matplotlib plots at test time prints what CPython's ElementTree prints.
//   bun web/build.ts, then node web/test-expat-worker.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-expat-"));
const T = (f) => readFileSync(join(here, "..", "test", f), "utf8");
const corpus = JSON.parse(T("expat_corpus.json"));
const whole = { ...corpus, cases: corpus.cases.filter((c) => c.chunking === "whole") };
const divergences = JSON.parse(T("expat_divergences.json"));
// (an SVG plotted at test time by the built CLI, never committed; CPython's reading of it is the expected output)
const svg = join(tmp, "plot.svg");
execFileSync(process.execPath, [join(here, "..", "build", "cli", "pyjs.cjs"), "-c", `import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([1, 2, 3], [1, 4, 9], label="sq"); ax.scatter([1, 2], [3, 4]); ax.set_title("caf\\u00e9 & tea"); ax.legend()
fig.savefig(${JSON.stringify(svg)})`]);
const wantSvg = execFileSync("python3", ["-I", join(here, "..", "test", "etree_svg.py"), svg], { encoding: "utf8" });
const FILES = [
  ["/xt/expat_run.py", T("expat_run.py")],
  ["/xt/expat_trace.py", T("expat_trace.py")],
  ["/xt/expat_corpus.json", JSON.stringify(whole)],
  ["/xt/expat_divergences.json", T("expat_divergences.json")],
  ["/xt/expat_api_cases.py", T("expat_api_cases.py")],
  ["/xt/etree_cases.py", T("etree_cases.py")],
  ["/xt/etree_files.py", T("etree_files.py")],
  ["/xt/etree_svg.py", T("etree_svg.py")],
  ["/xt/plot.svg", readFileSync(svg, "utf8")],
];
const API = T("expat_api_cases.py");
const wantApi = execFileSync("python3", ["-c", API], { cwd: tmp, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: tmp } });
const serve = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((r) => serve.stdout.once("data", (d) => r(Number(String(d).trim().split(/\s+/).pop()))));
const profile = join(tmp, "profile");
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--password-store=basic", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdp = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json();
    break;
  } catch {
    await sleep(100);
  }
}
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map();
// (the requests of the Python worker, attached as its own session: the group's fetch is seen once there, and again
// in the service worker's session, which serves it)
const requests = [];
const workerSessions = new Set();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Network.requestWillBeSent" && workerSessions.has(m.sessionId)) requests.push(m.params.request.url);
  if (m.method === "Target.attachedToTarget") {
    const sessionId = m.params.sessionId;
    if (m.params.targetInfo.type === "worker") workerSessions.add(sessionId);
    for (const [method, params] of [["Network.enable", {}], ["Runtime.runIfWaitingForDebugger", {}]]) ws.send(JSON.stringify({ id: ++n, method, params, sessionId }));
  }
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m.result ?? m.error);
    waiting.delete(m.id);
  }
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const xmlFetches = () => requests.filter((u) => /\/lib\/mod-xml\./.test(u)).length;
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result?.value;
};
const fails = [];
const check = (ok, what) => {
  console.log((ok ? "ok   " : "FAIL ") + what);
  if (!ok) fails.push(what);
};
// (one worker, its files under /xt, then runs, each with its stdout and stderr)
const start = () => ev(`(() => {
  const w = new Worker("sagebrush-worker.js", { type: "module" });
  const s = window.__s = { w, runs: new Map(), next: 1 };
  w.onmessage = (e) => {
    const m = e.data;
    const r = s.runs.get(m?.id);
    if (!r) return;
    if (m.stream) r.out[m.stream] += m.text;
    if (m.done) { s.runs.delete(m.id); r.res({ ...r.out, error: m.error ?? null }); }
  };
  w.postMessage({ files: ${JSON.stringify(FILES)}.map(([p, t]) => [p, new TextEncoder().encode(t)]) });
  w.postMessage({ startDir: "/xt" });
  w.postMessage({ init: { limits: null } });
  return true;
})()`);
const run = (code) => ev(`new Promise((res) => {
  const s = window.__s;
  const id = s.next++;
  const r = { res, out: { stdout: "", stderr: "" } };
  s.runs.set(id, r);
  setTimeout(() => { if (s.runs.has(id)) { s.runs.delete(id); res({ ...r.out, timeout: true }); } }, 120000);
  s.w.postMessage({ id, code: ${JSON.stringify(code)} });
})`);
const firstDiff = (want, got) => {
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) if (w[i] !== g[i]) return `line ${i + 1}: CPython ${JSON.stringify(w[i])}, the worker ${JSON.stringify(g[i])}`;
  return null;
};
const ranOk = (r, what) => check(!r.timeout && r.error === null && r.stderr === "", `${what} ran (${r.timeout ? "timed out" : r.error ?? "no error"}${r.stderr ? ": " + r.stderr.slice(-300) : ""})`);

try {
  for (const m of ["Page.enable", "Runtime.enable", "Network.enable"]) await send(m);
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await sleep(1500);
  await start();

  // ---- a cold start fetches no XML: the group mod-xml comes with the first import, once
  const cold = await run("import sys\nprint(1 + 1, 'pyexpat' in sys.modules, 'xml' in sys.modules)");
  ranOk(cold, "a cold program");
  check(cold.stdout === "2 False False\n" && xmlFetches() === 0, `a cold program: no XML module loaded, mod-xml not fetched (${JSON.stringify(cold.stdout)}, ${xmlFetches()} fetches)`);
  const first = await run("import pyexpat, xml.parsers.expat\nprint(pyexpat.EXPAT_VERSION)");
  check(first.stdout === "expat_2.9.0\n" && xmlFetches() === 1, `the first import fetches mod-xml once (${JSON.stringify(first.stdout)}, ${xmlFetches()} fetches)`);

  // ---- the whole-document cases, as CPython 3.14.10's pyexpat gives them
  const c = await run("import sys\nsys.path.insert(0, '/xt')\nimport expat_run\nexpat_run.main(['expat_run.py', '--sagebrush', '--whole'])");
  ranOk(c, "expat_run.py --sagebrush --whole");
  check(xmlFetches() === 1, `mod-xml still fetched once (${xmlFetches()})`);
  let r = null;
  try {
    r = JSON.parse(c.stdout);
  } catch {
    check(false, `expat_run.py printed JSON (${c.stdout.slice(0, 300)})`);
  }
  if (r) {
    check(r.cases === whole.cases.length && r.cases > 400, `every whole-document case ran (${r.cases} of ${whole.cases.length})`);
    check(r.mismatch_count === 0, `each gives CPython's events, errors and positions (${r.mismatch_count} differ: ${JSON.stringify(r.mismatches).slice(0, 600)})`);
    const stated = divergences.cases.filter((d) => d.key.split("|")[3] === "whole").length;
    check(r.diverged === stated && r.stated_but_same.length === 0 && r.stated_but_other.length === 0, `the stated divergences give the stated results (${r.diverged} of ${stated}; ${JSON.stringify([r.stated_but_same, r.stated_but_other]).slice(0, 300)})`);
    check(r.tables_equal === true, "the error codes and messages, version_info and features are CPython's");
  }

  // ---- the interface
  const a = await run(API);
  ranOk(a, "expat_api_cases.py");
  const da = firstDiff(wantApi, a.stdout);
  check(da === null, da ?? `expat_api_cases.py: ${wantApi.split("\n").length - 1} lines, each as CPython 3.14.10 prints it`);

  // ---- xml.etree (P3c-2): the cases, and its file paths on the worker's file system, in a directory of their own
  const et = await run(T("etree_cases.py"));
  ranOk(et, "etree_cases.py");
  const de = firstDiff(T("etree_cases.out"), et.stdout);
  check(de === null, de ?? `etree_cases.py: ${T("etree_cases.out").split("\n").length - 1} lines, as CPython 3.14.10 prints them`);
  const ef = await run("import os\nos.mkdir('/xt/files')\nos.chdir('/xt/files')\nexec(compile(open('/xt/etree_files.py').read(), 'etree_files.py', 'exec'))\nprint(os.listdir('.'))");
  ranOk(ef, "etree_files.py");
  const df = firstDiff(T("etree_files.out") + "[]\n", ef.stdout);
  check(df === null, df ?? "etree_files.py: every open() xml.etree makes, on the worker's file system, as CPython's on its own");

  const es = await run("import sys\nsys.argv = ['etree_svg.py', '/xt/plot.svg']\nexec(compile(open('/xt/etree_svg.py').read(), 'etree_svg.py', 'exec'))");
  ranOk(es, "etree_svg.py");
  const ds = firstDiff(wantSvg, es.stdout);
  check(ds === null && wantSvg.split("\n").length === 14, ds ?? "etree_svg.py: an SVG the CLI plotted, read as CPython's ElementTree reads it");

  // ---- what P3c leaves out
  const o = await run("for m in ('xml.dom', 'xml.sax', 'xml.dom.minidom'):\n    try:\n        __import__(m); print('imported', m)\n    except ModuleNotFoundError as e:\n        print(type(e).__name__, e)");
  check(o.stdout === "ModuleNotFoundError No module named 'xml.dom'\nModuleNotFoundError No module named 'xml.sax'\nModuleNotFoundError No module named 'xml.dom'\n", `xml.dom and xml.sax: ModuleNotFoundError (${JSON.stringify(o.stdout)})`);
} catch (e) {
  check(false, "the test ran: " + String(e?.stack ?? e).slice(0, 400));
} finally {
  chrome.kill();
  serve.kill();
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `${fails.length} failed` : "all passed");
process.exit(fails.length ? 1 : 0);
