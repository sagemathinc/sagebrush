// The notebook page's phone layout (?phone=1, web/index.html's html.phone) at a
// phone's size, 390x844 with touch, in headless Chromium:
// - nothing a person can press is covered by something else, and no two
//   controls overlap (a 390 px overlap check of every visible button, select,
//   input, textarea, link, the cell toolbar and the status line);
// - no horizontal scroll; the toolbar at the bottom, its menus as sheets above
//   it; the active cell's toolbar on its own row above its editor; 16px code;
//   TimeTravel's header at the top; the toolbar hidden while a field has the
//   focus;
// - the same with a preview site's notice (its band at the bottom,
//   --sb-preview-gutter: web/preview/notice.js), as a stand-in;
// - ?phone=0 turns it off.
// Bounded: every DevTools call times out naming its method (SEND_MS), every
// wait for the page is a bounded until(), and a watchdog (WATCHDOG_MS) ends the
// whole run with the phase it was in.
// Run after `bun web/build.ts`:
//   CHROME=google-chrome node web/test-phone-layout.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort, startServe } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0;
const fails = [];
const ok = (cond, what) => {
  checks++;
  console.log((cond ? "ok   " : "FAIL ") + what);
  if (!cond) fails.push(what);
};
const W = 390, H = 844;
const SEND_MS = 30_000, WATCHDOG_MS = 240_000;
let phase = "start";

// The overlap check, run in the page: every visible control whose centre is
// covered by something that isn't itself (or inside it), and every two visible
// controls whose boxes intersect (by more than 2 px each way), among controls
// of the same layer: the fixed ones (toolbar, menus, notices) with each other,
// and the page's with each other.  (The page scrolls under the fixed toolbar,
// and its end has room to scroll above it, so a page control under a fixed
// one isn't stuck there.)  ALLOWED: the early-alpha notice's own link and
// close button touch by a few pixels at this width (its layout, not the phone
// layout's).
const OVERLAPS = `(() => {
  const sel = "button, select, input:not([type=hidden]), textarea, a[href], .sbnb .cell .head, #status";
  const vis = (e) => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return s.visibility !== "hidden" && s.display !== "none" && r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && !e.closest("[hidden], .sbnb .ed"); };
  const name = (e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\\s+/).join(".") : "") + (e.textContent ? " '" + e.textContent.trim().slice(0, 16) + "'" : "");
  const inNotice = (e) => !!e.closest('[id^="sb-alpha"]');
  const fixed = (e) => { for (let x = e; x && x !== document.documentElement; x = x.parentElement) if (getComputedStyle(x).position === "fixed") return true; return false; };
  const allowed = (a, b) => (inNotice(a) && inNotice(b)) || fixed(a) !== fixed(b);
  const els = [...document.querySelectorAll(sel)].filter(vis);
  const out = [];
  for (const e of els) {
    const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    const top = document.elementFromPoint(x, y);
    if (top && top !== e && !e.contains(top) && !top.contains(e) && !allowed(e, top)) out.push("covered: " + name(e) + " by " + name(top));
  }
  for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
    const a = els[i], b = els[j];
    if (a.contains(b) || b.contains(a) || allowed(a, b)) continue;
    const p = a.getBoundingClientRect(), q = b.getBoundingClientRect();
    const w = Math.min(p.right, q.right) - Math.max(p.left, q.left), h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
    if (w > 2 && h > 2) out.push("overlap: " + name(a) + " / " + name(b) + " (" + Math.round(w) + "x" + Math.round(h) + ")");
  }
  return out;
})()`;

// (a stand-in for a preview site's notice: its gutter, its pill, and its rule for the early-alpha notice)
const PREVIEW_NOTICE = `(() => {
  const st = document.createElement("style");
  st.textContent = ':root { --sb-preview-gutter: 44px; } body { padding-bottom: var(--sb-preview-gutter) !important; }'
    + ' #sb-alpha\\\\-banner { bottom: var(--sb-preview-gutter) !important; }'
    + ' #sb-preview-notice { position: fixed; left: 0; right: 0; bottom: 0; height: var(--sb-preview-gutter); padding: 6px 8px; box-sizing: border-box; z-index: 2147483647; pointer-events: none; }'
    + ' #sb-preview-pill { pointer-events: auto; border: 1px solid #ad8128; border-radius: 999px; padding: 4px 10px; font: 12px/1.5 system-ui; }';
  document.head.append(st);
  const d = document.createElement("div"); d.id = "sb-preview-notice";
  const p = document.createElement("button"); p.id = "sb-preview-pill"; p.textContent = "PREVIEW, not production";
  d.append(p); document.body.append(d);
  return true;
})()`;

let cleanup = async () => {};
const watchdog = setTimeout(async () => {
  console.log(`FAIL the whole run took more than ${WATCHDOG_MS / 1000} s (phase: ${phase})`);
  await cleanup();
  process.exit(1);
}, WATCHDOG_MS);
phase = "serve.py";
const serve = startServe(() => spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }));
const port = await serve.port;
const profile = mkdtempSync(join(tmpdir(), "sb-phone-layout-chrome-"));
let cdpPort = Number(process.env.CDP_PORT) || 0;
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--hide-scrollbars", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
phase = "Chrome";
if (!cdpPort) cdpPort = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {} await sleep(100); }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; setTimeout(() => j(new Error("the DevTools socket didn't open within 30 s")), 30_000); });
let n = 0; const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
// (each call bounded: one that never answers fails the run naming its method)
const send = (method, params = {}) => new Promise((r, j) => {
  const id = ++n;
  const t = setTimeout(() => { waiting.delete(id); j(new Error(`DevTools ${method} didn't answer within ${SEND_MS / 1000} s (phase: ${phase})`)); }, SEND_MS);
  waiting.set(id, (v) => { clearTimeout(t); r(v); });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
const until = async (expr, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } return false; };
cleanup = async () => {
  try { ws.close(); } catch {}
  const gone = chrome.exitCode !== null ? Promise.resolve() : new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  serve.child.kill();
  await Promise.race([gone, sleep(5000)]);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
};
process.on("uncaughtException", async (e) => { console.log("FAIL " + (e?.stack ?? e)); await cleanup(); process.exit(1); });

const open = async (query) => {
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/${query}` });
  return until(`(document.getElementById("status")?.textContent ?? "").startsWith("ready")`, 60_000);
};
const rect = (sel) => `(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r && { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })()`;
const report = (list, what) => { ok(Array.isArray(list) && list.length === 0, what + (Array.isArray(list) && list.length ? ": " + list.slice(0, 6).join("; ") : "")); };

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  // (headless Chromium's page never has the focus otherwise, so focus events would not fire)
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });

  phase = "?phone=1";
  ok(await open("?phone=1"), "the page is ready with ?phone=1");
  ok(await ev(`document.documentElement.classList.contains("phone")`), "?phone=1 turns the phone layout on");
  ok(await ev(`document.documentElement.scrollWidth <= innerWidth`), "no horizontal scroll at 390 px");
  const bar = await ev(rect(".bar"));
  ok(bar && Math.abs(bar.bottom - H) < 1 && bar.right <= W + 0.5, `the toolbar is at the bottom of the screen (${JSON.stringify(bar)})`);
  for (const id of ["runall", "add", "filebtn", "morebtn"]) {
    const r = await ev(rect("#" + id));
    ok(r && r.left >= 0 && r.right <= W && r.top >= 0 && r.bottom <= H, `#${id} is on the screen`);
  }
  ok(await ev(`!!document.querySelector("header #docsearchbox") && !!document.querySelector("header #mode")`), "the search and the language are in the header");
  ok(await ev(`getComputedStyle(document.querySelector("#cells .ed textarea")).fontSize === "16px"`), "code is 16px (no zoom on iOS)");
  report(await ev(OVERLAPS), "no covered or overlapping controls (the top of the page)");

  phase = "the active cell";
  // the active cell: its toolbar on its own row, above its editor, inside the cell
  ok(await ev(`(() => { const c = [...document.querySelectorAll("#cells .cell")].find((c) => !c.classList.contains("markdown")); c.querySelector(".gutter").click(); c.scrollIntoView({ block: "center" }); return c.classList.contains("active"); })()`), "a code cell is active");
  ok(await until(`(() => { const h = document.querySelector("#cells .cell.active .head"); return !!h && h.getBoundingClientRect().height > 0; })()`), "its toolbar shows");
  ok(await ev(`(() => { const c = document.querySelector("#cells .cell.active"), h = c.querySelector(".head").getBoundingClientRect(), e = c.querySelector(".ed").getBoundingClientRect(), r = c.getBoundingClientRect(); return h.height > 0 && h.bottom <= e.top + 0.5 && h.top >= r.top - 0.5; })()`), "the active cell's toolbar is on its own row above its editor");
  report(await ev(OVERLAPS), "no covered or overlapping controls (an active cell)");

  phase = "the menus";
  // the menus: sheets above the toolbar
  for (const [btn, menu] of [["morebtn", "moremenu"], ["filebtn", "filemenu"]]) {
    await ev(`document.getElementById(${JSON.stringify(btn)}).click()`);
    ok(await until(`!document.getElementById(${JSON.stringify(menu)}).hidden`), `#${menu} opens`);
    const m = await ev(rect("#" + menu)), b = await ev(rect(".bar"));
    ok(m && b && m.bottom <= b.top + 0.5 && m.left >= 0 && m.right <= W, `#${menu} opens as a sheet above the toolbar`);
    await ev(`document.getElementById(${JSON.stringify(btn)}).click()`);
    ok(await until(`document.getElementById(${JSON.stringify(menu)}).hidden`), `#${menu} closes`);
  }

  phase = "typing";
  // typing: the toolbar steps aside while a field has the focus
  await ev(`document.querySelector("#cells .cell.active textarea").focus()`);
  ok(await until(`document.documentElement.classList.contains("typing") && getComputedStyle(document.querySelector(".bar")).display === "none"`), "the toolbar hides while a cell is being edited");
  await ev(`document.activeElement.blur()`);
  ok(await until(`!document.documentElement.classList.contains("typing") && getComputedStyle(document.querySelector(".bar")).display !== "none"`), "and comes back on blur");

  phase = "TimeTravel";
  // TimeTravel's header sticks at the top
  await ev(`document.getElementById("ttbtn").click()`);
  ok(await until(`!document.getElementById("timetravel").hidden && getComputedStyle(document.querySelector("#timetravel .tthead")).top === "0px"`), "TimeTravel's header sticks at the top");
  await ev(`document.getElementById("ttclose").click()`);
  ok(await until(`document.getElementById("timetravel").hidden`), "TimeTravel closes");

  phase = "a preview notice";
  // a preview site's notice: the toolbar above its band
  ok(await ev(PREVIEW_NOTICE), "a preview notice is added");
  ok(await until(`Math.abs(document.querySelector(".bar").getBoundingClientRect().bottom - (innerHeight - 44)) < 1`), "the toolbar moves up for it");
  const bar2 = await ev(rect(".bar")), pill = await ev(rect("#sb-preview-pill"));
  ok(bar2 && pill && bar2.bottom <= pill.top + 0.5 && Math.abs(bar2.bottom - (H - 44)) < 1, `with a preview notice, the toolbar is above its band (${JSON.stringify({ bar: bar2, pill })})`);
  await ev(`window.scrollTo(0, 0)`);
  ok(await until(`scrollY === 0`), "back at the top");
  report(await ev(OVERLAPS), "no covered or overlapping controls (with a preview notice)");
  await ev(`document.getElementById("morebtn").click()`);
  ok(await until(`!document.getElementById("moremenu").hidden`), "the ⋯ menu opens again");
  const m2 = await ev(rect("#moremenu"));
  ok(m2 && m2.bottom <= bar2.top + 0.5, "with a preview notice, the menu is above the toolbar");

  phase = "?phone=0";
  // ?phone=0: off
  ok(await open("?phone=0"), "the page is ready with ?phone=0");
  ok(await ev(`!document.documentElement.classList.contains("phone") && getComputedStyle(document.querySelector(".bar")).position !== "fixed"`), "?phone=0 turns it off");
} finally {
  clearTimeout(watchdog);
  await cleanup();
}
console.log(fails.length ? `${fails.length} of ${checks} failed` : `${checks}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
