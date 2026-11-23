// ci: web-browser/notebook order=246
// The LaTeX and code pages (/?tex=<fid>, /?code=<fid>) open over the notebook page with their own toolbars: the
// notebook's toolbar, at the foot of a phone's screen in the phone layout, must not show over them.  In headless
// Chrome with a phone's metrics (393 x 800, touch, the phone layout), and with a mouse's wide window: the notebook's
// toolbar shows on the notebook page, and doesn't with ?tex= or ?code= in the address (the root carries
// html.overpage), whether or not that page could be opened here.
// Serve web/dist first (python3 web/serve.py 8765), then   node web/test-phone-overpage.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-phone-overpage-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1200,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
const fails = [];
let checks = 0;
const ok = (cond, what) => { checks++; console.log((cond ? "ok   " : "FAIL ") + what); if (!cond) fails.push(what); };
const J = JSON.stringify;

// the notebook's toolbar: shown (laid out, not display:none) and where
const BAR = `(() => { const b = document.querySelector('.bar[aria-label="Notebook"]'); if (!b) return null; const r = b.getBoundingClientRect(), s = getComputedStyle(b);
  return { shown: s.display !== "none" && r.width > 0 && r.height > 0, top: Math.round(r.top), phone: document.documentElement.classList.contains("phone"), overpage: document.documentElement.classList.contains("overpage") }; })()`;
const visit = async (path) => {
  await send("Page.navigate", { url: base + path });
  // (the toolbar is in the page's own HTML: there once the document has loaded, whatever the page over it does)
  await until(`document.readyState === "complete" && !!document.querySelector('.bar[aria-label="Notebook"]')`, 30000);
  await sleep(1500);
  return ev(BAR);
};

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Emulation.setDeviceMetricsOverride", { width: 393, height: 800, deviceScaleFactor: 3, mobile: true, screenWidth: 393, screenHeight: 852 });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  let b = await visit("?phone=1");
  ok(b?.phone && b.shown && !b.overpage && b.top > 600, "a phone, the notebook page: its toolbar shows, at the foot of the screen: " + J(b));
  for (const q of ["tex", "code"]) {
    b = await visit(`?${q}=0123456789abcdef`);
    ok(b?.phone && b.overpage && !b.shown, `a phone, ?${q}=: the page over the notebook's has its own toolbar, and the notebook's isn't shown: ` + J(b));
  }
  b = await visit("?phone=1");
  ok(b?.shown && !b.overpage, "back on the notebook page, its toolbar again: " + J(b));
  // a mouse's wide window: the same
  await send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  b = await visit("?phone=0&tex=0123456789abcdef");
  ok(b && !b.phone && b.overpage && !b.shown, "a wide window, ?tex=: the notebook's toolbar isn't shown either: " + J(b));
  b = await visit("?phone=0");
  ok(b?.shown && !b.overpage, "a wide window, the notebook page: its toolbar shows: " + J(b));
} catch (e) {
  ok(false, "threw: " + (e?.stack ?? e));
} finally {
  ws.close();
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
process.exit(fails.length ? 1 : 0);
