// The agents page's resizable columns (William A1 + A10; the layout plan r3, PR 2): the chat list and the artifact
// pane are dragged or moved with the keys, clamped so the chat keeps 420 px and the pane 320, re-clamped on a resize
// and when the pane opens, kept in localStorage only in a valid shape, and left alone by the narrow overlay and full
// screen. The scripted agent (no pairing) opens a code artifact ("plot a Fourier series"); notebooks are
// test-agents-artifacts.mjs's (A10 there: opening a notebook leaves the pane width as it was).
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && CHROME=google-chrome bun web/agents/test-agents-layout.mjs
// Each case prints its id first ("ok   L2-side-179: ..."), so a run's FAIL set is the ids of its FAIL lines.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort, startServe } from "../test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const KEY = "sb-agents-layout-v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, checks = 0;
const ok = (id, cond, msg, detail) => {
  checks++;
  if (!cond) fails++;
  console.log(`${cond ? "ok  " : "FAIL"} ${id}: ${msg}${!cond && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 400) : ""}`);
};

let server;
const port = await startServe(() => (server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
const origin = `http://127.0.0.1:${port}`;
const profile = mkdtempSync(join(tmpdir(), "sb-agents-layout-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let code = 1;
try {
  const cdpPort = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300 && !targets; i++) targets = await fetch(`http://127.0.0.1:${cdpPort}/json`).then((r) => r.json(), () => sleep(100).then(() => undefined));
  const cdp = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (cdp.onopen = r));
  let n = 0;
  const waiting = new Map();
  let exceptions = [];
  cdp.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m.result ?? m.error), waiting.delete(m.id));
    else if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); cdp.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result?.value; };
  const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } throw new Error("timeout: " + expr); };
  const size = (width, height = 900) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await send("Runtime.enable");
  await send("Page.enable");

  /** A fresh page at `width`: chats and the stored layout cleared, then `stored` (a raw string) put back if given. */
  const fresh = async (width, { stored = null, query = "" } = {}) => {
    await size(width);
    const url = `${origin}/agents/?speed=20${query}`;
    await send("Page.navigate", { url });
    await until(`location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete'`);
    await ev(`(() => { localStorage.clear(); ${stored == null ? "" : `localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(stored)});`} })()`);
    exceptions = [];
    await send("Page.navigate", { url });
    await sleep(300);
    // (the layout mounted: its separators wired and valued, as apply() writes aria-valuenow only after mountLayout wires
    // them; the editor is mounted earlier, before the layout. OR a page exception since this navigate: a mount that
    // throws never values the separators, and the case's own checks must then fail it, not this wait; 20 s either way)
    const mounted = `document.readyState === 'complete' && !!document.querySelector('#editor .mb') && document.getElementById('sep-side').hasAttribute('aria-valuenow')`;
    for (const t = Date.now(); ; await sleep(50)) {
      if (exceptions.length > 0 || (await ev(mounted).catch(() => false))) break;
      if (Date.now() - t > 20000) throw new Error("timeout: the layout's mount (no aria-valuenow and no page exception) at " + url);
    }
    await sleep(300);
  };
  /** The scripted agent's turn that opens a code artifact (through the page's own artifact path, renderArtifacts). */
  const openPane = async () => {
    if (!(await ev(`!!document.querySelector('#editor textarea')`))) {
      const [x, y] = await ev(`(() => { const r = document.querySelector('#editor .mb-block').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
    await until(`!!document.querySelector('#editor textarea')`);
    await ev(`document.querySelector('#editor textarea').focus()`);
    await send("Input.insertText", { text: "plot a Fourier series" });
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", modifiers: 8, windowsVirtualKeyCode: 13 });
    await until(`!!document.querySelector('#artifacts [data-tab]') && document.querySelector('#stop').hidden`, 30000);
    await sleep(300);
  };
  const w = () => ev(`(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return { side: r('nav.side').width, sideRight: r('nav.side').right, chat: r('main').width, pane: r('#artifacts').width, vw: innerWidth }; })()`);
  const aria = (id) => ev(`(() => { const e = document.getElementById('${id}'); return { now: e.getAttribute('aria-valuenow'), min: e.getAttribute('aria-valuemin'), max: e.getAttribute('aria-valuemax') }; })()`);
  const sepX = (id) => ev(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  /** A drag of a separator: pressed at its middle, moved to x in one jump (off the handle: pointer capture), released. */
  const drag = async (id, x) => {
    const [x0, y] = await sepX(id);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    await sleep(100);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(200);
  };
  const key = async (k) => { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code: k }); await sleep(80); };
  const near = (a, b) => Math.abs(a - b) < 1;

  // ---- the sidebar's clamps (1600 px, no pane: 180-480)
  for (const [id, x, want] of [["L2-side-179", 179, 180], ["L2-side-180", 180, 180], ["L2-side-480", 480, 480], ["L2-side-481", 481, 480]]) {
    await fresh(1600);
    await drag("sep-side", x);
    const m = await w();
    ok(id, near(m.side, want), `the chat list dragged to ${x} px is ${want} px wide`, m);
  }

  // ---- the chat keeps 420 px; the pane keeps 320 (1600 px, a code artifact open)
  await fresh(1600);
  await openPane();
  await drag("sep-pane", 1600 - 931);
  {
    const m = await w();
    ok("L2-chat-419", near(m.chat, 420), "a pane drag that would leave the chat 419 px leaves it 420", m);
  }
  for (const [id, pane] of [["L2-pane-319", 319], ["L2-pane-320", 320]]) {
    await drag("sep-pane", 1600 - pane);
    const m = await w();
    ok(id, near(m.pane, 320), `the pane dragged to ${pane} px is 320 px wide`, m);
  }

  // ---- too narrow for 180 + 420 + 320 beside an open pane: the chat list collapses (910 px)
  await fresh(910);
  await openPane();
  {
    const m = await w();
    ok("L2-narrow-collapse", m.sideRight <= 0 && m.chat >= 419.5, "at 910 px with a pane open the chat list collapses and the chat keeps 420 px", m);
  }

  // ---- the keys, and the separator's values
  await fresh(1600);
  await ev(`document.getElementById('sep-side').focus()`);
  {
    await key("ArrowRight");
    const a = await w(), aa = await aria("sep-side");
    await key("ArrowLeft");
    const b = await w(), ba = await aria("sep-side");
    ok("L2-key-arrows", near(a.side, 266) && aa.now === "266" && near(b.side, 250) && ba.now === "250", "the arrows move the chat list's edge 16 px, and aria-valuenow follows", { a, aa, b, ba });
    await key("Home");
    const h = await w(), ha = await aria("sep-side");
    await key("End");
    const e = await w(), ea = await aria("sep-side");
    ok("L2-key-home-end", near(h.side, 180) && ha.now === "180" && near(e.side, 480) && ea.now === "480", "Home and End take the chat list to 180 and 480 px", { h, ha, e, ea });
  }
  await fresh(1600);
  await openPane();
  await size(1100);
  await sleep(400);
  {
    const m = await w(), ap = await aria("sep-pane"), as = await aria("sep-side");
    ok("L2-aria-resize", ap.min === "320" && ap.max === String(Math.round(1100 - m.side - 420)) && ap.now === String(Math.round(m.pane)) && as.max === "360" && as.now === String(Math.round(m.side)), "after a resize from 1600 to 1100 px the separators' valuemin/max/now are current", { m, ap, as });
  }
  await fresh(1000);
  await openPane();
  {
    const m = await w(), ap = await aria("sep-pane");
    ok("L2-aria-clamped", near(m.pane, 330) && ap.now === "330", "the default pane re-clamped to keep the chat at 420 px: aria-valuenow is the width shown (330)", { m, ap });
  }

  // ---- pointer capture: a drag that ends far from the handle
  await fresh(1600);
  await drag("sep-side", 400);
  {
    const m = await w();
    ok("L2-capture", near(m.side, 400), "a drag ending off the handle (400 px) still moves and ends", m);
  }

  // ---- 900 and 901 px: no separators in the narrow overlay
  await fresh(900);
  {
    const a = await ev(`[getComputedStyle(document.getElementById('sep-side')).display, document.querySelector('nav.side').getBoundingClientRect().right]`);
    await size(901);
    await sleep(300);
    const b = await ev(`getComputedStyle(document.getElementById('sep-side')).display`);
    ok("L2-900-901", a[0] === "none" && a[1] <= 0 && b === "block", "the separators are hidden at 900 px (the overlay unchanged) and shown at 901", { a, b });
  }

  // ---- the pane's default, min(46vw, 760px)
  for (const [id, vw, want] of [["L2-default-below", 1400, 0.46 * 1400], ["L2-default-above", 1800, 760]]) {
    await fresh(vw);
    await openPane();
    const m = await w();
    ok(id, near(m.pane, want), `at ${vw} px the pane opens ${Math.round(want)} px wide`, m);
  }

  // ---- the stored layout: only exactly {side, pane}, finite numbers in 0..4096; anything else -> the defaults
  for (const [id, raw] of [
    ["L2-shape-nan", '{"side":1e999,"pane":500}'],
    ["L2-shape-string", '{"side":"300","pane":500}'],
    ["L2-shape-negative", '{"side":-5,"pane":500}'],
    ["L2-shape-huge", '{"side":300,"pane":99999}'],
    ["L2-shape-missing", '{"side":300}'],
    ["L2-shape-nonobject", "[300,500]"],
    ["L2-shape-notjson", "{side:300"],
    ["L2-shape-extrakey", '{"side":300,"pane":500,"x":1}'],
  ]) {
    await fresh(1600, { stored: raw });
    await openPane();
    const m = await w();
    ok(id, near(m.side, 250) && near(m.pane, 736) && exceptions.length === 0, `stored ${raw}: the defaults (250, 736 px), no page exception`, { m, exceptions });
  }
  // (storage that throws for this key: the page mounts and the drag works)
  {
    const s = await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const g = Storage.prototype.getItem, p = Storage.prototype.setItem; Storage.prototype.getItem = function (k) { if (k === ${JSON.stringify(KEY)}) throw new Error("storage off"); return g.call(this, k); }; Storage.prototype.setItem = function (k, v) { if (k === ${JSON.stringify(KEY)}) throw new Error("storage off"); return p.call(this, k, v); }; })()` });
    await fresh(1600);
    await drag("sep-side", 300);
    const m = await w();
    ok("L2-storage-fail", near(m.side, 300) && exceptions.length === 0, "with localStorage throwing for the layout key, the page mounts and the drag works", { m, exceptions });
    await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: s.identifier });
  }

  // ---- the narrow overlay and full screen ignore the stored widths
  await fresh(800, { stored: '{"side":400,"pane":500}' });
  await openPane();
  {
    const m = await w();
    ok("L2-overlay-800", near(m.pane, 800) && m.sideRight <= 0, "at 800 px the pane covers the page and the chat list is the overlay's, whatever is stored", m);
  }
  await fresh(1600, { stored: '{"side":400,"pane":500}' });
  await openPane();
  await ev(`document.querySelector('#full').click()`);
  await sleep(300);
  {
    const m = await w();
    ok("L2-fullscreen", near(m.pane, 1600), "in full screen the pane covers the page, whatever is stored", m);
  }

  // ---- re-clamping: on a resize, and when the agent opens the pane
  await fresh(1600, { stored: '{"side":300,"pane":700}' });
  await openPane();
  await size(1100);
  await sleep(400);
  {
    const m = await w();
    ok("L2-resize-reclamp", near(m.pane, 380) && m.chat >= 419.5, "stored 300/700 at 1600 px, resized to 1100: the pane 380 px, the chat 420", m);
  }
  await fresh(1000, { stored: '{"side":480,"pane":460}' });
  await openPane();
  {
    const m = await w();
    ok("L2-agent-open-1000", m.chat >= 419.5, "at 1000 px (480 px chat list stored), the pane the agent opens leaves the chat 420 px", m);
  }

  // ---- one layout update per animation frame; one write per drag
  await fresh(1600, { query: "&layout-test" });
  {
    await ev(`(window.__fr = [], window.__sbLayout.setFrame((cb) => window.__fr.push(cb)))`);
    const [x0, y] = await sepX("sep-side");
    const a0 = await ev(`window.__sbLayout.stats.applies`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 0; i < 50; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 260 + i, y, button: "left", buttons: 1 });
    const a1 = await ev(`window.__sbLayout.stats.applies`);
    await ev(`window.__fr.splice(0).forEach((f) => f())`);
    const a2 = await ev(`window.__sbLayout.stats.applies`);
    const m = await w();
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 309, y, button: "left", buttons: 0, clickCount: 1 });
    ok("L2-apply-drag", a1 - a0 === 0 && a2 - a0 === 1 && near(m.side, 309), "50 pointer moves before the frame: no layout update, then exactly one, at the 50th position", { a0, a1, a2, side: m.side });
    const r0 = await ev(`window.__sbLayout.stats.applies`);
    await ev(`(() => { for (let i = 0; i < 50; i++) dispatchEvent(new Event('resize')); })()`);
    const r1 = await ev(`window.__sbLayout.stats.applies`);
    await ev(`window.__fr.splice(0).forEach((f) => f())`);
    const r2 = await ev(`window.__sbLayout.stats.applies`);
    ok("L2-apply-resize", r1 - r0 === 0 && r2 - r0 === 1, "50 resize events before the frame: no layout update, then exactly one", { r0, r1, r2 });
  }
  await fresh(1600, { query: "&layout-test" });
  {
    const [x0, y] = await sepX("sep-side");
    const w0 = await ev(`window.__sbLayout.stats.writes`);
    // (moves off the handle from the first, 300 to 398 px: pointer capture carries them, and the release)
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 0; i < 50; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300 + 2 * i, y, button: "left", buttons: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 398, y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(200);
    const w1 = await ev(`window.__sbLayout.stats.writes`);
    ok("L2-write-count", w1 - w0 === 1, "one drag of 50 moves writes the stored layout once", { w0, w1 });
  }
  console.log(`${checks - fails}/${checks} passed${fails ? "" : ", all passed"}`);
  code = fails ? 1 : 0;
} finally {
  chrome.kill("SIGKILL");
  server?.kill("SIGKILL");
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(code);
