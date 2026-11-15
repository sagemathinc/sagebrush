// ci: web-browser/notebook order=244
// File > Examples… on a phone, in headless Chrome with a phone's metrics (393 x 800, touch, the phone layout): the
// panel takes the screen and shows the list alone; a tapped example replaces the list with its preview across the
// screen; the panel's bar stays at the top and visible while its search has the focus (the notebook toolbar's phone
// rules, also .bar, once fixed it to the foot and hid it while a field had the focus); "← Examples" goes back to the
// list.  And on a wide screen the list and the preview are still side by side.
// Serve web/dist first (python3 web/serve.py 8765), then   node web/test-phone-examples.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-phone-examples-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1200,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map(), errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
const fails = [];
let checks = 0;
const ok = (cond, what) => { checks++; console.log((cond ? "ok   " : "FAIL ") + what); if (!cond) fails.push(what); };
const J = JSON.stringify;

// where the panel's parts are: shown (laid out, not display:none) and their boxes
const PANEL = `(() => { const d = document.querySelector("dialog.sb-examples[open]"); if (!d) return null;
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(), s = getComputedStyle(e); return { shown: s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0, x: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  return { vw: innerWidth, dialog: box(d), bar: box(d.querySelector(".bar")), list: box(d.querySelector("ul")), show: box(d.querySelector(".show")), frame: box(d.querySelector("iframe")),
    src: d.querySelector("iframe")?.getAttribute("src") ?? "", back: d.querySelector("[data-act=expand]")?.textContent ?? "", focus: document.activeElement?.type ?? document.activeElement?.tagName }; })()`;
const openPage = async (url) => {
  await send("Page.navigate", { url });
  ok(await until("!!window.sagebrush?.notebook?.cells && document.querySelectorAll('.cell').length > 0 && !document.body.classList.contains('opening')", 60000), `the notebook page (${url})`);
  await sleep(500);
};
const openPanel = async () => {
  await ev(`document.querySelector('#filemenu [data-f="examples"]').click(), 1`);
  return until(`document.querySelectorAll("dialog.sb-examples[open] ul li button[data-id]").length > 1`, 30000);
};

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  // (a headless page has no focus of its own: without this, focus() fires no focusin, which the phone layout listens for)
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });

  // ---- a phone: its metrics set here (the window alone can't be narrower than Chrome's least width)
  await send("Emulation.setDeviceMetricsOverride", { width: 393, height: 800, deviceScaleFactor: 3, mobile: true, screenWidth: 393, screenHeight: 852 });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await openPage(`${base}?phone=1`);
  ok((await ev("innerWidth")) === 393 && (await ev(`document.documentElement.classList.contains("phone")`)), "a phone's screen, 393 px wide, in the phone layout");
  ok(await openPanel(), "File > Examples… opens the panel with its list");
  let p = await ev(PANEL);
  ok(p.dialog.shown && p.dialog.x === 0 && p.dialog.w === 393 && p.dialog.top === 0, "the panel takes the whole screen: " + J(p.dialog));
  ok(p.list.shown && p.list.w > 350 && !p.show.shown, "first the list alone, across the screen, no preview beside it: " + J({ list: p.list, show: p.show }));
  ok(p.bar.shown && p.bar.top < 10, "its bar (title, Close, kinds, search) at the top: " + J(p.bar));
  ok(p.back === "← Examples", "its back button reads ← Examples: " + J(p.back));

  // a tap on an example: its preview replaces the list, across the screen
  const id = await ev(`(() => { const b = document.querySelectorAll("dialog.sb-examples[open] ul li button[data-id]")[1]; b.click(); return b.dataset.id; })()`);
  ok(await until(`(() => { const s = document.querySelector("dialog.sb-examples[open] .show"); return !!s && getComputedStyle(s).display !== "none"; })()`, 5000), `a tapped example (${id}) shows its preview`);
  p = await ev(PANEL);
  ok(!p.list.shown, "the list steps aside: " + J(p.list));
  ok(p.show.shown && p.frame.shown && p.frame.w >= 380, "the preview is across the screen (at least 380 of 393 px): " + J(p.frame));
  ok(p.src.includes(id), "of the example tapped: " + J({ src: p.src, id }));
  ok(p.bar.shown && p.bar.top < 10, "the bar still at the top: " + J(p.bar));

  // the search has the focus: the bar stays where it is, shown
  await ev(`document.querySelector("dialog.sb-examples[open] input[type=search]").focus(), 1`);
  await sleep(200);
  p = await ev(PANEL);
  ok(p.focus === "search" && (await ev(`document.documentElement.classList.contains("typing")`)), "the search has the focus (the phone layout's typing state): " + J(p.focus));
  ok(p.bar.shown && p.bar.top < 10 && p.bar.h > 0, "and the bar with it stays at the top, shown: " + J(p.bar));

  // ← Examples: back to the list
  await ev(`document.querySelector("dialog.sb-examples[open] [data-act=expand]").click(), 1`);
  await sleep(200);
  p = await ev(PANEL);
  ok(p.list.shown && !p.show.shown, "← Examples goes back to the list: " + J({ list: p.list, show: p.show }));
  await ev(`document.querySelector("dialog.sb-examples[open]").close(), 1`);

  // ---- a wide screen with a mouse: the list and the preview side by side, as before
  await send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await openPage(`${base}?phone=0`);
  ok(await openPanel(), "a wide screen: the panel opens");
  await sleep(300);
  p = await ev(PANEL);
  ok(p.list.shown && p.show.shown && p.frame.shown && p.show.x >= p.list.x + p.list.w - 2, "the list and the preview side by side: " + J({ list: p.list, show: p.show }));
  ok(p.back === "Expand", "its button is Expand: " + J(p.back));
} catch (e) {
  ok(false, "threw: " + (e?.stack ?? e));
} finally {
  ws.close();
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
ok(errors.length === 0, "no exceptions on the page: " + J(errors.slice(0, 3)));
console.log(`${checks - fails.length}/${checks} checks passed`);
process.exit(fails.length ? 1 : 0);
