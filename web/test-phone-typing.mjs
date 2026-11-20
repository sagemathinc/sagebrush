// ci: web-browser/notebook order=242
// Typing in a cell on a phone-sized screen moves nothing, in headless Chrome at 393 x 800 (an iPhone's width, set as
// the page's metrics: the window alone can't be narrower than Chrome's least width): each
// keystroke empties the header's "saved" line and each save sets it again, and that line once wrapped onto three lines
// in a narrow window, so the header, and the notebook under it, went up and down with every key.  Here, for the
// narrow window's layout (?phone=0) and the phone layout (?phone=1): a new notebook, then a character at a time, each
// one saved before the next, and after every keystroke and every save the header's height, the cell's place on the
// screen and the scroll position are what they were before the first one; "saved" is one line.  Also: a touch
// screen whose shorter side is a phone's gets the phone layout without the flag, and a mouse's window doesn't.
// Serve web/dist first (python3 web/serve.py 8765), then   node web/test-phone-typing.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-phone-typing-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=393,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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

// the header's height, the cell's top on the screen, the scroll position and the "saved" line
const PLACE = `(() => { const h = document.querySelector("header").getBoundingClientRect(), c = document.querySelector(".cell").getBoundingClientRect(), s = document.getElementById("saved"), r = s.getBoundingClientRect();
  return { header: Math.round(h.height), cell: Math.round(c.top), y: Math.round(scrollY), saved: s.textContent, savedH: Math.round(r.height), line: parseFloat(getComputedStyle(s).lineHeight) || 18 }; })()`;
const open = async (url) => {
  await send("Page.navigate", { url });
  ok(await until("!!window.sagebrush?.notebook?.cells && document.querySelectorAll('.cell').length > 0 && !document.body.classList.contains('opening')", 60000), `the notebook page (${url})`);
  await sleep(800);
};

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  // (a narrow window with a mouse, 393 px wide; the flag chooses the layout)
  const narrow = { width: 393, height: 800, deviceScaleFactor: 1, mobile: false };
  await send("Emulation.setDeviceMetricsOverride", narrow);
  for (const flag of ["0", "1"]) {
    const layout = flag === "1" ? "the phone layout" : "a narrow window's layout";
    await open(`${base}?phone=${flag}`);
    ok((await ev(`document.documentElement.classList.contains("phone")`)) === (flag === "1") && (await ev("innerWidth")) === 393, `${layout}: ?phone=${flag} chooses it, 393 px wide`);
    await ev(`document.querySelector('#filemenu [data-f=new]').click(), 1`);
    ok(await until("document.querySelectorAll('.cell').length === 1 && !document.body.classList.contains('opening')", 30000), `${layout}: a new notebook`);
    await ev(`document.querySelector(".cell textarea").focus(), 1`);
    await sleep(300);
    const first = await ev(PLACE);
    const seen = [];
    for (const ch of "x = 1") {
      await send("Input.insertText", { text: ch });
      seen.push({ after: "key " + J(ch), ...(await ev(PLACE)) });
      ok(await until(`document.getElementById("saved").textContent.trim() !== ""`, 15000), `${layout}: ${J(ch)} typed, then saved`);
      seen.push({ after: "saved", ...(await ev(PLACE)) });
    }
    const moved = seen.filter((p) => p.header !== first.header || p.cell !== first.cell || p.y !== first.y);
    ok(moved.length === 0, `${layout}: no keystroke and no save moved the header (${first.header} px), the cell (top ${first.cell}) or the page (scrollY ${first.y}): ` + J(moved.slice(0, 4)));
    const saved = seen.filter((p) => p.after === "saved");
    ok(saved.every((p) => p.savedH <= Math.ceil(p.line) + 1), `${layout}: "saved" is one line: ` + J(saved.map((p) => [p.saved, p.savedH])));
  }

  // the layout without the flag: a phone's touch screen gets it, a mouse's narrow window doesn't
  await open(`${base}?phone=reset`);
  await ev(`localStorage.removeItem("sagebrush-phone"), 1`);
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });
  await send("Emulation.setDeviceMetricsOverride", { width: 393, height: 800, deviceScaleFactor: 3, mobile: true, screenWidth: 393, screenHeight: 852 });
  await open(base);
  ok(await ev(`document.documentElement.classList.contains("phone")`), "no flag, a phone's touch screen (393 x 852): the phone layout");
  await send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await send("Emulation.setEmitTouchEventsForMouse", { enabled: false });
  await send("Emulation.setDeviceMetricsOverride", narrow);
  await open(base);
  ok(!(await ev(`document.documentElement.classList.contains("phone")`)), "no flag, a narrow window with a mouse: not the phone layout");
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
