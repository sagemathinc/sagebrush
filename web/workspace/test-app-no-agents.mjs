// ci: web-browser/board-a order=66
// The desktop app has no agents page yet (#1542; the app's server answers /agents/ with a short "not in the app"
// page, which William saw as the switch flickering and failing): there, the files panel offers no way to it. On the
// notebook page and on a board, in headless Chromium against web/dist (web/serve.py), with the page given what the
// desktop app's web view has (window.__TAURI__ and __SB_DESKTOP_APP__, lib.rs) and without:
//   - in a browser, the panel's header has the Files | Agents switch and its foot Agents…;
//   - in the desktop app, neither: no switch and no Agents… (the corner toggle still hides the panel).
//   bun web/build.ts && node web/workspace/test-app-no-agents.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const web = join(here, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0, failures = 0;
const ok = (c, what) => { checks++; if (!c) failures++; console.log((c ? "ok   " : "FAIL ") + what); };
const DEADLINE = Number(process.env.SB_TEST_DEADLINE) || 240_000;
setTimeout(() => { console.log(`FAIL the test did not end within ${DEADLINE / 1000} s`); process.exit(1); }, DEADLINE).unref();

const serve = startServe(() => spawn("python3", [join(web, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }));
const site = `http://127.0.0.1:${await serve.port}/`;
const profile = mkdtempSync(join(tmpdir(), "sb-app-no-agents-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", "--window-size=1200,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
const cleanup = () => { try { process.kill(-chrome.pid, "SIGKILL"); } catch {} try { serve.child.kill("SIGKILL"); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);

const port = await devtoolsPort(profile, undefined, { child: chrome });
// (one fresh target per case: its own init script, nothing left from the last)
async function page(app) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, no) => { ws.onopen = r; ws.onerror = () => no(new Error("the DevTools socket did not open")); });
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  const send = (method, params = {}, ms = 30000) => new Promise((resolve, reject) => {
    const id = ++n, timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method}: no answer within ${ms / 1000} s`)); }, ms);
    waiting.set(id, (r) => { clearTimeout(timer); resolve(r); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
  const until = async (expr, ms = 60000) => { for (let t0 = Date.now(); Date.now() - t0 < ms; await sleep(150)) if (await ev(expr).catch(() => false)) return true; return false; };
  await send("Page.enable");
  // (what the desktop app's web view has before the page's scripts: its bridge, answering the page's startup asks
  // with nothing, and the flag lib.rs sets only there)
  if (app) await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__SB_DESKTOP_APP__ = true; window.__TAURI__ = { core: { invoke: async (c) => (["startup_files", "disk_list"].includes(c) ? [] : null) }, event: { listen: async () => () => {} }, window: { getCurrentWindow: () => ({ setTitle: async () => {} }) } };` });
  return { send, ev, until, close: () => { try { ws.close(); } catch {} } };
}
// (the panel shown, then what its header and foot offer)
const PANEL = "(() => { const p = document.querySelector('#wssidebar .sbfiles'); return p ? { sw: !!p.querySelector('.fh .sb-mode'), agentsBtn: !!p.querySelector('[data-mode=\"agents\"]'), fagents: !!p.querySelector('.fagents'), app: typeof window.__TAURI__ === 'object' && window.__SB_DESKTOP_APP__ === true } : null; })()";

for (const app of [false, true]) {
  const where = app ? "the desktop app" : "a browser";
  // ---- the notebook page
  {
    const p = await page(app);
    await p.send("Page.navigate", { url: site });
    await p.until("!!document.querySelector('#wsfilesbtn') && !!window.sagebrush?.notebook", 90000);
    await p.ev("(() => { const s = document.querySelector('#wssidebar'); if (s.hidden) document.querySelector('#wsfilesbtn').click(); return 1; })()");
    await p.until("!!document.querySelector('#wssidebar .sbfiles')", 30000);
    const r = await p.ev(PANEL);
    if (app) ok(r && r.app && !r.sw && !r.agentsBtn && !r.fagents, `notebook page, ${where}: no Files | Agents switch and no Agents… in the files panel: ${JSON.stringify(r)}`);
    else ok(r && !r.app && r.sw && r.agentsBtn && r.fagents, `notebook page, ${where}: the Files | Agents switch and Agents… are there: ${JSON.stringify(r)}`);
    p.close();
  }
  // ---- a board
  {
    const p = await page(app);
    await p.send("Page.navigate", { url: site + "board/?new=1" });
    const has = await p.until("!!document.querySelector('[data-sbb=\"files\"]')", 90000);
    if (has) {
      await p.ev("(() => { const s = document.querySelector('#wssidebar'); if (s.hidden) document.querySelector('[data-sbb=\"files\"]').click(); return 1; })()");
      await p.until("!!document.querySelector('#wssidebar .sbfiles')", 30000);
    }
    const r = has ? await p.ev(PANEL) : null;
    if (app) ok(r && r.app && !r.sw && !r.agentsBtn && !r.fagents, `board, ${where}: no Files | Agents switch and no Agents… in the files panel: ${JSON.stringify(r)}`);
    else ok(r && !r.app && r.sw && r.agentsBtn && r.fagents, `board, ${where}: the Files | Agents switch and Agents… are there: ${JSON.stringify(r)}`);
    p.close();
  }
}
console.log(failures ? `${failures} of ${checks} failed` : `all ${checks} passed`);
cleanup();
process.exit(failures ? 1 : 0);
