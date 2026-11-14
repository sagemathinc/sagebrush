// Run one notebook on Sagebrush's notebook page, in headless Chromium, cell by cell: score.py's browser level.
//
//   node bench/notebooks/browser.mjs NOTEBOOK.ipynb [--classic] [--cell-timeout S] [--timeout S]   (CHROME=... for the browser)
//
// The page is web/dist as built (bun web/build.ts), served by web/serve.py behind a small front server that also
// serves the notebook and the files beside it, read-only, under /t/.  The page opens it as a reader's link does,
// ?open=<notebook>&file=<each file beside it> (the files land at the top of the browser's files: a file in a
// subfolder is not given), then each code cell is run in order, as Run does, with automatic reruns off.  One JSON
// line per code cell on stdout: {cell (its index in the notebook), timeout, ms, outputs (nbformat outputs, as the
// page saves them)}; the first line is {page: "ready"} or {page: "error", detail}.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { devtoolsPort, startServe } from "../../web/test-port.mjs";

const here = dirname(new URL(import.meta.url).pathname);
const web = join(here, "..", "..", "web");
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
const nbPath = resolve(args.find((a) => a.endsWith(".ipynb")) ?? "");
const CELL_S = opt("--cell-timeout", 120), TOTAL_S = opt("--timeout", 1800);
// (the files given to the page: at most this many, and this many bytes in all, the rest left out)
const FILES_MAX = 50, BYTES_MAX = 512 * 2 ** 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const children = [];
// (stdout to a pipe is written asynchronously: exit once it is flushed, or the last lines are lost)
const end = (code) => { for (const k of children) try { k(); } catch {} process.stdout.write("", () => process.exit(code)); };
setTimeout(() => { say({ page: "error", detail: `no end within ${TOTAL_S + 120} s` }); end(1); }, (TOTAL_S + 120) * 1000).unref();

const dir = dirname(nbPath);
const nb = JSON.parse(readFileSync(nbPath, "utf8"));
const codeCells = nb.cells.map((c, i) => [c, i]).filter(([c]) => c.cell_type === "code").map(([, i]) => i);
let bytes = 0;
const files = readdirSync(dir).filter((f) => {
  const p = join(dir, f);
  if (f.endsWith(".ipynb") || f.startsWith(".") || !statSync(p).isFile()) return false;
  bytes += statSync(p).size;
  return bytes <= BYTES_MAX;
}).slice(0, FILES_MAX);

// web/dist behind a front server: /t/<name> is a file of the notebook's folder (that folder only, read-only)
const serve = startServe(() => spawn("python3", [join(web, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }));
children.push(() => serve.child.kill("SIGKILL"));
const upstream = await serve.port;
const front = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.startsWith("/t/")) {
    const f = resolve(dir, path.slice(3));
    if (req.method !== "GET" || dirname(f) !== dir || !(f === nbPath || files.includes(basename(f)))) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "application/octet-stream", "cross-origin-resource-policy": "same-origin" });
    return res.end(readFileSync(f));
  }
  const up = request({ host: "127.0.0.1", port: upstream, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on("error", () => res.destroy());
  req.pipe(up);
});
await new Promise((r) => front.listen(0, "127.0.0.1", r));
const site = `http://127.0.0.1:${front.address().port}/`;

// Chromium, a fresh profile (short TMPDIR paths: its socket's path has a length limit)
const profile = mkdtempSync(join(tmpdir(), "sbnb-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--password-store=basic", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"], detached: true });
children.push(() => { try { process.kill(-chrome.pid, "SIGKILL"); } catch {} rmSync(profile, { recursive: true, force: true }); });
const port = await devtoolsPort(profile, undefined, { child: chrome });
let target;
for (let i = 0; i < 300 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {}
  if (!target) await sleep(100);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, no) => { ws.onopen = r; ws.onerror = () => no(new Error("the DevTools socket did not open")); });
let n = 0;
const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
const until = async (expr, ms) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr)) return true; await sleep(200); } return false; };

const t0 = Date.now();
const q = new URLSearchParams();
// (--classic: the notebook runs top to bottom, as in Jupyter, not reactively: the page's ?reactive=0)
if (args.includes("--classic")) q.set("reactive", "0");
q.set("open", site + "t/" + encodeURIComponent(basename(nbPath)));
for (const f of files) q.append("file", site + "t/" + encodeURIComponent(f));
await send("Page.enable");
await send("Page.navigate", { url: site + "?" + q });
if (!(await until("document.querySelector('#status')?.textContent.startsWith('ready') && window.sagebrush?.notebook?.cells().length > 0", 120_000))) {
  say({ page: "error", detail: String(await ev("document.querySelector('#status')?.textContent")).slice(0, 300) });
  end(0);
}
say({ page: "ready", files: files.length });
// (no automatic reruns: each cell runs once, in order, as the scorer asks)
await ev("(() => { try { sagebrush.notebook.setBudget(0, { save: false }); } catch {} return true; })()");
for (const [k, cell] of codeCells.entries()) {
  const left = TOTAL_S * 1000 - (Date.now() - t0);
  if (left <= 0) { say({ cell, notRun: true }); continue; }
  const ms = Math.min(CELL_S * 1000, left);
  const r = await ev(`(async () => {
    const c = sagebrush.notebook.cells().filter((c) => c.type === "code")[${k}];
    if (!c) return { missing: true };
    const t = performance.now();
    // (a reactive notebook's run returns once the cell is queued: its result is in when the cell is neither queued nor running)
    const settled = (async () => {
      await sagebrush.notebook.run(c);
      while (c.el.classList.contains("queued") || c.el.classList.contains("running")) await new Promise((ok) => setTimeout(ok, 50));
      return {};
    })();
    const r = await Promise.race([settled, new Promise((ok) => setTimeout(() => ok({ timeout: true }), ${ms}))]);
    if (r?.timeout) document.querySelector("#stop")?.click();
    return { timeout: !!r?.timeout, ms: Math.round(performance.now() - t), outputs: sagebrush.notebook.saveOutputs(c.out) };
  })()`);
  if (r?.timeout) await until("!document.querySelector('#stop') || document.querySelector('#stop').hidden", 10_000);
  say({ cell, ...(r ?? { missing: true }) });
}
end(0);
