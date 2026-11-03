// ci: web-runner order=116 chrome
// A notebook's permission to change files (web/notebook/permissions.js; William, Nov 2: code from elsewhere runs, but
// changes nothing until the person allows it; plan-no-mutation r3, astra's CLEAR 5fe204ad), in headless Chromium:
//   - a remote notebook (?open=…&run) runs nothing on open; Run all then runs it: it reads the person's files, and its
//     write, mkdir, remove, rename and replace each raise PermissionError, /tmp's writes don't; the workspace is unchanged
//     and the page shows "This notebook wants to change files";
//   - a synthetic click on Allow changes nothing; the person's own (trusted) click does, and the cell run again writes;
//   - the person's own notebook writes; ⋯ "Don't allow file changes" (trusted) makes its writes refused, a run in
//     flight at its next write; "Allow file changes" makes them work again; an explicit "don't allow" survives a reopen;
//   - a change queued before "don't allow" isn't kept; a change the page didn't ask for (a forged fsChanged) isn't kept;
//   - a notebook that can't change files never runs in a plain worker (?runner=0): it says why; one that can, runs.
//   bun web/build.ts, then node web/test-file-permissions.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-fileperm-"));
const serve = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((r) => serve.stdout.once("data", (d) => r(Number(String(d).trim().split(/\s+/).pop()))));
const profile = join(tmp, "profile");
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--password-store=basic", "--remote-debugging-port=0", "--window-size=1280,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdp = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
// (the remote notebook: its one cell tries every kind of change, and reads)
const PROBE = [
  "import os",
  "r = []",
  "def t(name, f):",
  "    try:",
  "        f(); r.append(name + ':ok')",
  "    except PermissionError:",
  "        r.append(name + ':refused')",
  "    except Exception as e:",
  "        r.append(name + ':' + type(e).__name__)",
  "t('read', lambda: open('keep.txt').read())",
  "t('write', lambda: open('nm-w.txt', 'w').write('x'))",
  "t('mkdir', lambda: os.mkdir('nm-dir'))",
  "t('remove', lambda: os.remove('keep.txt'))",
  "t('rename', lambda: os.rename('keep.txt', 'keep2.txt'))",
  "t('move', lambda: os.replace('keep.txt', 'moved.txt'))",
  "t('tmp', lambda: open('/tmp/nm-t.txt', 'w').write('x'))",
  "print('NM:' + ','.join(r))",
].join("\n");
const ipynb = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: "code", source: PROBE, metadata: {}, outputs: [], execution_count: null }] });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails).slice(0, 300));
  if (m.method === "Fetch.requestPaused") {
    if (/\/remote\.ipynb$/.test(m.params.request.url)) send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(ipynb).toString("base64") });
    else send("Fetch.continueRequest", { requestId: m.params.requestId });
  }
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
const W = "window.sagebrush.workspace";
const base = `http://127.0.0.1:${port}/`;
const go = async (url) => { await send("Page.navigate", { url }); await until("document.querySelector('#status')?.textContent.startsWith('ready')", 90000); await sleep(300); };
// (the person's own click: one the browser marks isTrusted)
const trusted = async (sel) => {
  const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (!r) throw new Error("no " + sel);
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
  await sleep(200);
};
const out = (i = 0) => ev(`[...document.querySelectorAll('#cells .cell')][${i}]?.querySelector('.out')?.textContent ?? ''`);
const setCode = (code, i = 0) => ev(`(() => { const ta = [...document.querySelectorAll('#cells .cell textarea')][${i}]; ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
const runAll = () => ev("sagebrush.notebook.runAll().then(() => 1)");
const stat = (p) => ev(`${W}.stat(${JSON.stringify(p)}).then((e) => !!e, () => false)`);
const files = () => ev("sagebrush.permissions()?.files");
try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/remote.ipynb", requestStage: "Request" }] });
  // (the person's data file, made in their workspace first)
  await go(base);
  await until(`!!${W}`, 60000);
  await ev(`${W}.create("/keep.txt", { content: new TextEncoder().encode("kept") }).then(() => 1)`);

  // ---- a remote notebook: runs nothing on open; Run all runs it, changing nothing
  await go(base + "?open=" + encodeURIComponent(base + "remote.ipynb") + "&run");
  check((await ev("[...document.querySelectorAll('#cells .cell textarea')][0]?.value.startsWith('import os')")), "a remote notebook opens (?open=…&run)");
  await sleep(3000);
  check((await out()) === "" && !(await ev("!!document.querySelector('#cells .running, #cells .queued')")), "…and runs nothing on open (?run is gone)");
  check((await files()) === false, "…its code can't change files: " + JSON.stringify(await ev("sagebrush.permissions()")));
  await runAll();
  check(await until("/NM:/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')", 60000), "Run all runs it");
  const res = (await out()).trim();
  check(res === "NM:read:ok,write:refused,mkdir:refused,remove:refused,rename:refused,move:refused,tmp:ok", "…it reads the person's files; its write, mkdir, remove, rename and replace are each refused with PermissionError; /tmp's write isn't: " + res);
  await sleep(1500);
  check((await stat("/keep.txt")) && !(await stat("/nm-w.txt")) && !(await stat("/nm-dir")) && !(await stat("/keep2.txt")) && !(await stat("/moved.txt")) && !(await stat("/tmp/nm-t.txt")), "…and the workspace is unchanged (/tmp kept nowhere)");
  check(await ev("!document.querySelector('#filesbar').hidden && /wants to change files/.test(document.querySelector('#filesbar').textContent)"), "…the page says: This notebook wants to change files [Allow changes for this notebook]");
  // (a forged change, as if from its interpreter: kept nowhere)
  await ev(`(() => { sagebrush.kernel.worker.onmessage?.({ data: { fsChanged: "/forged.txt", data: new Uint8Array([1, 2]) } }); return 1; })()`);
  await sleep(1500);
  check(!(await stat("/forged.txt")), "a change its interpreter sends anyway (a forged fsChanged) is kept nowhere");
  // (Allow: a synthetic click does nothing; the person's own click allows)
  await ev("(document.querySelector('#filesallow').click(), 1)");
  check((await files()) === false && !(await ev("document.querySelector('#filesbar').hidden")), "a synthetic click on Allow changes nothing");
  await trusted("#filesallow");
  check((await files()) === true && (await ev("document.querySelector('#filesbar').hidden")), "the person's own click on Allow changes for this notebook: it may change files now, the bar gone");
  await runAll();
  check(await until(`${W}.stat("/nm-w.txt").then((e) => !!e)`, 30000), "…and the cell run again writes: /nm-w.txt is in the workspace");

  // ---- a notebook that can't change files never runs in a plain worker
  const remoteId = await ev("localStorage.getItem('sagebrush-current')");
  await go(base + "?open=" + encodeURIComponent(base + "remote.ipynb") + "&runner=0");
  await runAll();
  check(await until("/can't run here/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')", 30000), "?runner=0: a notebook from elsewhere doesn't run in the page's own interpreter, and says why: " + (await out()).slice(0, 120));

  // ---- the person's own notebook: writes; Don't allow file changes; a run in flight; reopen; Allow again
  await go(base + "?runner=1");
  await ev(`(() => { document.querySelector('#filebtn')?.click(); document.querySelector('#filemenu [data-group="new"]')?.click(); document.querySelector('#filemenu [data-f="new"]').click(); return 1; })()`);
  await until("sagebrush.notebook.cells().length === 1 && !sagebrush.notebook.cells()[0].ta.value", 20000);
  await sleep(1000);
  check((await files()) === true, "the person's own new notebook may change files: " + JSON.stringify(await ev("sagebrush.permissions()")));
  await setCode("open('own-1.txt', 'w').write('x'); print('W1')");
  await runAll();
  check(await until(`${W}.stat("/own-1.txt").then((e) => !!e)`, 30000), "…it writes: /own-1.txt");
  await trusted("#morebtn");
  check(/Don't allow file changes/.test(await ev("document.querySelector('#filesperm').textContent")), "⋯ offers Don't allow file changes");
  await trusted("#filesperm");
  check((await files()) === false, "…the person's own click: it can't change files now");
  await setCode("try:\n    open('own-2.txt', 'w').write('x'); print('W2')\nexcept PermissionError as e:\n    print('REFUSED', e)");
  await runAll();
  check(await until("/REFUSED/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')", 30000), "…a write raises PermissionError, saying why: " + (await out()).trim().slice(0, 160)); check(/can't change your files/.test(await out()), "…in words: " + (await out()).trim().slice(0, 160));
  check(!(await stat("/own-2.txt")), "…and nothing is written");
  const ownId = await ev("localStorage.getItem('sagebrush-current')");
  await go(base + "?nb=" + encodeURIComponent(ownId));
  await sleep(800);
  check((await files()) === false, "…the person's choice survives a reopen (an explicit don't-allow beats the own-notebook default)");
  await trusted("#morebtn");
  check(/^Allow file changes/.test(await ev("document.querySelector('#filesperm').textContent")), "⋯ now offers Allow file changes");
  await trusted("#filesperm");
  check((await files()) === true, "…which allows them again");
  await setCode("open('own-3.txt', 'w').write('x'); print('W3')");
  await runAll();
  check(await until(`${W}.stat("/own-3.txt").then((e) => !!e)`, 30000), "…and the write works: /own-3.txt");
  // (a run in flight: a loop writing a file every 0.25 s, its permission withdrawn part-way: refused at its next write)
  await setCode("import time\nfor i in range(40):\n    try:\n        open(f'flight-{i}.txt', 'w').write('x'); print('w', i, flush=True)\n    except PermissionError:\n        print('refused at', i); break\n    time.sleep(0.25)");
  await ev("(sagebrush.notebook.runAll(), 1)");
  await until("/w 3/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')", 30000);
  await trusted("#morebtn");
  await trusted("#filesperm");
  check(await until("/refused at \\d+/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')", 20000), "a run in flight is refused at its next write once file changes aren't allowed: " + (await out()).trim().split("\n").slice(-1)[0]);
  await trusted("#morebtn");
  await trusted("#filesperm");
  check((await files()) === true, "(allowed again)");
  // (a change still queued when file changes stop being allowed: not kept)
  await ev("(window.__release = sagebrush.files.holdDrain(), 1)");
  await setCode("open('queued.txt', 'w').write('x'); print('Q')");
  await runAll();
  await until("/Q/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')", 30000);
  await until("sagebrush.files.queue().paths > 0", 10000);
  await trusted("#morebtn");
  await trusted("#filesperm");
  await ev("(window.__release(), 1)");
  await sleep(1500);
  check((await files()) === false && !(await stat("/queued.txt")), "a change queued before file changes stopped being allowed isn't kept");
  check(errors.length === 0, "no exceptions in the page: " + errors.slice(0, 3).join(" | "));
  void remoteId;
} catch (e) {
  check(false, "threw: " + String(e?.stack ?? e).slice(0, 800));
} finally {
  const gone = chrome.exitCode !== null ? Promise.resolve() : new Promise((r) => chrome.once("exit", r));
  chrome.kill(); serve.kill();
  await Promise.race([gone, sleep(5000)]);
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
process.exit(fails.length ? 1 : 0);
