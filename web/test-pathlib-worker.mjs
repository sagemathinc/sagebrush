// ci: web-runner order=121 chrome
// pathlib on the browser's file system (P3a: the friction plan's step 2; @sagebrush's ruling, Nov 7: pinned on the
// CLI's real file system, test/pathlib.test.ts, and on the browser worker's, here), in headless Chromium against the
// built worker (web/worker.ts, web/shims/fs.ts):
//   - test/pathlib_cases.py, run in a worker, prints what CPython 3.14 prints for it, line for line (each run in a
//     fresh folder: CPython's in a temporary directory here, the worker's in its own /pl folder);
//   - with the document's `files` permission off ({fsWritable: false}, web/shims/fs.ts mayChange), every change
//     pathlib makes is refused before anything changes, write_text, mkdir, rename, unlink, with the refusal's
//     PermissionError, and /tmp (scratch) stays writable, as for open() and os.
//   bun web/build.ts, then node web/test-pathlib-worker.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-pathlib-"));
const CASES = readFileSync(join(here, "..", "test", "pathlib_cases.py"), "utf8");
const cpy = mkdtempSync(join(tmp, "cpy-"));
const want = execFileSync("python3", ["-c", CASES], { cwd: cpy, encoding: "utf8" });
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
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m.result ?? m.error);
    waiting.delete(m.id);
  }
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
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
// (a fresh worker: the files it starts with, its folder, its files permission, then one run; its stdout and stderr,
// the changes it was refused, or why it gave none)
const runIn = (dir, writable, code, files = []) => ev(`new Promise((res) => {
  const w = new Worker("sagebrush-worker.js", { type: "module" });
  const out = { stdout: "", stderr: "", refused: [] };
  const t = setTimeout(() => { w.terminate(); res({ ...out, timeout: true }); }, 120000);
  w.onmessage = (e) => {
    const m = e.data;
    if (m?.fsRefused !== undefined) out.refused.push(m.fsRefused);
    if (m?.id !== 1) return;
    if (m.stream) out[m.stream] += m.text;
    if (m.done) { clearTimeout(t); w.terminate(); res({ ...out, error: m.error ?? null }); }
  };
  w.postMessage({ files: ${JSON.stringify(files)}.map(([p, t]) => [p, new TextEncoder().encode(t)]) });
  w.postMessage({ startDir: ${JSON.stringify(dir)} });
  w.postMessage({ fsWritable: ${writable} });
  w.postMessage({ init: { limits: null } });
  w.postMessage({ id: 1, code: ${JSON.stringify(code)} });
})`);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await sleep(1500);

  // ---- the cases, as CPython prints them
  const r = await runIn("/pl", true, CASES);
  check(!r.timeout && r.error === null, `the cases ran in the worker (${r.timeout ? "timed out" : r.error ?? "no error"}${r.stderr ? ": " + r.stderr.slice(-300) : ""})`);
  const w = want.split("\n"), g = r.stdout.split("\n");
  let first = -1;
  for (let i = 0; i < Math.max(w.length, g.length); i++) if (w[i] !== g[i]) { first = i; break; }
  check(first === -1, first === -1 ? `pathlib_cases.py: ${w.length - 1} lines, each as CPython 3.14 prints it` : `pathlib_cases.py line ${first + 1}: CPython ${JSON.stringify(w[first])}, the worker ${JSON.stringify(g[first])}`);
  check(r.stderr === "", `nothing on stderr (${JSON.stringify(r.stderr.slice(0, 200))})`);

  // ---- the files permission off: pathlib's changes refused, nothing changed; /tmp scratch
  const REFUSE = [
    "import os",
    "from pathlib import Path",
    "os.makedirs('/tmp', exist_ok=True)",
    "def t(f):",
    "    try:",
    "        f()",
    "        return 'done'",
    "    except PermissionError as e:",
    "        return 'PermissionError ' + str(e.errno)",
    "print(t(lambda: Path('/pl/w.txt').write_text('x')), Path('/pl/w.txt').exists())",
    "print(t(lambda: Path('/pl/d').mkdir()), t(lambda: Path('/pl/e/f').mkdir(parents=True)), Path('/pl/d').exists(), Path('/pl/e').exists())",
    "print(t(lambda: Path('/pl/w.bin').write_bytes(b'x')), t(lambda: Path('/pl/keep.txt').rename('/pl/moved.txt')), t(lambda: Path('/pl/keep.txt').unlink()))",
    "print(Path('/pl/keep.txt').read_text(), Path('/pl/moved.txt').exists())",
    "print(t(lambda: Path('/tmp/scratch.txt').write_text('ok')), Path('/tmp/scratch.txt').read_text(), t(lambda: Path('/tmp/sd/x').mkdir(parents=True)))",
  ].join("\n");
  // (a file the document starts with, the permission off from the start)
  const q = await runIn("/pl", false, REFUSE, [["/pl/keep.txt", "kept"]]);
  const lines = q.stdout.split("\n");
  check(q.timeout !== true && q.error === null, `the refusal run ran (${q.timeout ? "timed out" : q.error ?? "no error"}${q.stderr ? ": " + q.stderr.slice(-300) : ""})`);
  check(lines[0] === "PermissionError 13 False", `write_text refused, nothing written (${lines[0]})`);
  check(lines[1] === "PermissionError 13 PermissionError 13 False False", `mkdir and mkdir(parents=True) refused, no folder made (${lines[1]})`);
  check(lines[2] === "PermissionError 13 PermissionError 13 PermissionError 13", `write_bytes, rename and unlink refused (${lines[2]})`);
  check(lines[3] === "kept False", `the file is unchanged, not moved (${lines[3]})`);
  check(lines[4] === "done ok done", `/tmp is scratch: written, read back and a folder made there (${lines[4]})`);
  check(q.refused.length >= 6 && q.refused.every((p) => !p.startsWith("/tmp")), `the page told of each refusal, none in /tmp (${JSON.stringify(q.refused)})`);
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
