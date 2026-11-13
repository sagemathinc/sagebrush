// ci: web-browser/latex order=62 chrome
// A shared collection's file that doesn't match its SHA-256, read by the import system: the runner's interpreter
// raises the OSError open() raises on it (errno 5, the file named), not an internal error with the worker's stack;
// traceback.format_exc() formats it; the session runs on. The collection is mounted as the share page mounts it
// (sagebrush-latex-run.js's sessionOf), its files served through CDP Fetch: talks/bad.py's bytes are not the ones
// its SHA-256 names, talks/good.py's are.
//   1. open() and import of the bad file: the same exception (class, errno, strerror, filename), errno 5
//   2. format_exc() of the import's exception: its last line is the OSError's
//   3. `from bad import B` raises it again (the file is fetched again, not kept), caught by `except Exception`
//   4. the good file imports; a later cell runs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = spawn("python3", [join(web, "serve.py"), "0"], { stdio: ["ignore", "pipe", "ignore"] });
const port = await new Promise((r) => server.stdout.once("data", (d) => r(Number(String(d).match(/\d+/)[0]))));
const site = `http://127.0.0.1:${port}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "sb-eio-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
let cdpPort = null;
chrome.stderr.on("data", (d) => {
  const m = /DevTools listening on ws:\/\/[^:]+:(\d+)/.exec(String(d));
  if (m) cdpPort = m[1];
});
const FILES = { "talks/bad.py": "B = 1\n", "talks/good.py": "G = 2\n" };
const sha = (s) => createHash("sha256").update(s).digest("hex");
const MOUNT = Object.entries(FILES).map(([p, t]) => [p, { url: new URL(`__sbshare/${encodeURIComponent(p)}`, site).href, sha256: p === "talks/bad.py" ? sha("other") : sha(t), size: Buffer.byteLength(t) }]);
let failures = 0;
const ok = (c, msg) => {
  console.log((c ? "ok   " : "FAIL ") + msg);
  if (!c) failures++;
};
try {
  for (let i = 0; i < 100 && !cdpPort; i++) await sleep(100);
  let targets;
  for (let i = 0; i < 100; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
      break;
    } catch {
      await sleep(100);
    }
  }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map();
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m.result ?? m.error), waiting.delete(m.id));
    if (m.method === "Fetch.requestPaused") {
      const p = decodeURIComponent(new URL(m.params.request.url).pathname.split("/__sbshare/")[1] ?? "");
      void send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "Access-Control-Allow-Origin", value: "*" }], body: Buffer.from(FILES[p] ?? "").toString("base64") });
    }
  };
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  };
  await send("Page.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*__sbshare*" }] });
  await send("Page.navigate", { url: site });
  for (let i = 0; i < 600 && !(await ev("!!window.sagebrush?.workspace").catch(() => false)); i++) await sleep(100);
  const CELLS = [
    [
      "import sys, traceback",
      "sys.path.append('/talks')",
      "try:",
      "    open('/talks/bad.py').read()",
      "except OSError as e:",
      "    o = (type(e).__name__, e.errno, e.strerror, e.filename)",
      "try:",
      "    import bad",
      "except OSError as e:",
      "    i = (type(e).__name__, e.errno, e.strerror, e.filename)",
      "    last = traceback.format_exc().splitlines()[-1]",
      "print('same', o == i, i[0], i[1], i[3])",
      "print('last', last)",
      "print('strerror', i[2])",
    ],
    ["try:", "    from bad import B", "except Exception as e:", "    print('again', type(e).__name__, e.errno, traceback.format_exc().splitlines()[-1] == last)"],
    ["import good", "print('good', good.G)"],
    ["print('alive', 1 + 1)"],
  ].map((c) => c.join("\n"));
  const out = await ev(`(async () => {
    const nb = await import(new URL("sagebrush-notebook.js", location.href).href);
    const rc = await import(new URL("sagebrush-latex-run.js", location.href).href);
    const s = rc.sessionOf({ module: async () => nb, worker: (mod) => new mod.RunnerWorker(new URL("runner/", location.href).href, {}) }, 120000, ${JSON.stringify(MOUNT)});
    const k = await s();
    const run = (code) => new Promise((res) => { const got = { out: [], done: null }; k.execute(code, { mode: "sage" }, { start() {}, out: (t) => got.out.push(String(t)), display: () => {}, done: (r) => { got.done = r; res(got); } }); });
    const all = [];
    for (const c of ${JSON.stringify(CELLS)}) all.push(await run(c));
    s.dispose();
    return all.map((g) => ({ out: g.out.join(""), error: !!g.done?.error }));
  })()`);
  const [a, b, c, d] = out;
  console.log(JSON.stringify(out, null, 1).slice(0, 2000));
  ok(!a.error && /^same True OSError 5 \/talks\/bad\.py$/m.test(a.out), "1. import of the mismatched file raises the OSError open() raises: errno 5, the file named");
  ok(!/internal error|SystemError|blob:/.test(a.out) && /SHA-256/.test(a.out), "…no internal error and no worker stack; the strerror says why");
  ok(/^last OSError: \[Errno 5\] .*'\/talks\/bad\.py'$/m.test(a.out), "2. format_exc() formats it: its last line is the OSError's");
  ok(!b.error && /^again OSError 5 True$/m.test(b.out), "3. from bad import B raises it again, caught by except Exception");
  ok(!c.error && /^good 2$/m.test(c.out), "4. the good file imports");
  ok(!d.error && /^alive 2$/m.test(d.out), "…and a later cell runs");
  ws.close();
} catch (e) {
  ok(false, "the test ran: " + (e?.stack ?? e));
} finally {
  chrome.kill();
  server.kill();
  await sleep(200);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}
console.log(failures ? `${failures} FAILED` : "all ok");
process.exit(failures ? 1 : 0);
