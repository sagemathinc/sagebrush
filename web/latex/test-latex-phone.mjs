// ci: web-browser/latex order=63 chrome
// The LaTeX editor's page on a phone, in headless Chrome with a phone's metrics (393 x 800, touch, the notebook page's
// phone layout), against a web/dist built with SAGEBRUSH_LATEX_PREVIEW=test, served by web/serve.py:
//   - the head one row: Sagebrush, the name, its save state and Share; the source's size and the preview's zoom not
//     shown there;
//   - the actions (File, Preview, Comments, Agent) in one row at the foot, above the early-alpha notice, and the
//     notebook page's own toolbar not shown over the page; Comments a speech bubble (its name still "Comments"), the
//     row fitting the screen; at its end ⋯, a menu over the page above the row with the source's size, the preview's
//     zoom (which work from there), Follow, Show and Terminal; Escape closes it;
//   - the notice one line, its link; the File menu opening above the foot; the foot put away while the keyboard is up;
//   - and on a wide screen with a mouse, the head as before, its actions and tools in it, no foot.
//   SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts && CHROME=google-chrome node web/latex/test-latex-phone.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "../test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the server: web/serve.py on a port it picks, printed once it listens
const server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const sport = await new Promise((res, rej) => { let acc = ""; server.stdout.on("data", (b) => { acc += b; const m = /(\d{2,5})/.exec(acc); if (m) res(+m[1]); }); setTimeout(() => rej(new Error("no server port")), 15000); });
const base = `http://127.0.0.1:${sport}/`;
let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-latex-phone-"));
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

// the page's parts: shown (laid out, not display:none) and their boxes
const PARTS = `(() => { const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(), s = getComputedStyle(e); return { shown: s.display !== "none" && s.visibility !== "hidden" && !e.closest("[hidden]") && r.width > 0 && r.height > 0, top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; };
  const q = (s) => document.querySelector(s), head = q(".tex-page .tex-head");
  return { vh: innerHeight, head: box(head), foot: box(q(".tex-page .tex-foot")), tools: box(q(".tex-page .tex-tools")), share: box(q(".tex-page .tex-sharebtn")), banner: box(q(".tex-page .tex-banner")),
    alpha: box(q("#sb-alpha-banner")), nbBar: box(q('.bar[aria-label="Notebook"]')), menu: box(q(".tex-page .tex-filemenu")),
    inFoot: [...(q(".tex-page .tex-foot")?.querySelectorAll("button") ?? [])].filter((b) => !b.hidden).map((b) => b.textContent.trim()),
    inHead: [...head.querySelectorAll(":scope > button")].filter((b) => !b.hidden && getComputedStyle(b).display !== "none").map((b) => b.textContent.trim()) }; })()`;
const openTex = async (url) => {
  await send("Page.navigate", { url });
  ok(await until("!!window.sagebrush?.notebook?.cells && !document.body.classList.contains('opening')", 60000), `the notebook page (${url})`);
  await sleep(500);
  await ev(`document.querySelector('#filemenu [data-f="newlatex"]').click(), 1`);
  ok(await until(`/[?&]tex=/.test(location.search) && !!document.querySelector(".tex-page .tex-head") && !!document.querySelector(".tex-page .cm-content, .tex-page .tex-ed textarea, .tex-page .tex-ed")`, 30000), "File > New > LaTeX document opens the editor's page");
  await sleep(1500);
};

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // ---- a phone
  await send("Emulation.setDeviceMetricsOverride", { width: 393, height: 800, deviceScaleFactor: 3, mobile: true, screenWidth: 393, screenHeight: 852 });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Page.navigate", { url: `${base}?phone=1` });
  await until("!!window.sagebrush?.notebook && !document.body.classList.contains('opening')", 60000);
  await ev(`localStorage.removeItem("sagebrush-latex-banner-dismissed"), 1`);
  await openTex(`${base}?phone=1`);
  let p = await ev(PARTS);
  ok(p.head.shown && p.head.h < 60, "the head is one row: " + J(p.head));
  ok(p.share?.shown && p.share.top < p.head.bottom, "Share in it: " + J(p.share));
  ok(!p.tools?.shown, "the source's size and the preview's zoom aren't shown on a phone: " + J(p.tools));
  ok(["File", "Preview", "Comments", "Agent"].every((t) => p.inFoot.includes(t)) && !p.inHead.some((t) => /^(File|Preview|Comments|Agent)$/.test(t)), "File, Preview, Comments and Agent are in the foot, not the head: " + J({ foot: p.inFoot, head: p.inHead }));
  ok(p.foot?.shown && p.alpha?.shown && p.foot.bottom === p.alpha.top && p.alpha.bottom === p.vh, "the foot sits on the early-alpha notice, at the foot of the screen: " + J({ foot: p.foot, alpha: p.alpha, vh: p.vh }));
  ok(!p.nbBar?.shown, "the notebook page's own toolbar isn't shown over the page: " + J(p.nbBar));
  ok(p.banner?.shown && p.banner.h < 34 && (await ev(`!!document.querySelector(".tex-page .tex-banner a:not([hidden])")`)), "the notice is one line, its link: " + J(p.banner));
  // Comments a bubble, ⋯ at the row's end, the row fitting the screen
  const cm = await ev(`(() => { const b = document.querySelector(".tex-page .tex-foot .tex-comments"), r = b.getBoundingClientRect(), f = document.querySelector(".tex-page .tex-foot");
    return { font: getComputedStyle(b).fontSize, icon: getComputedStyle(b, "::before").width, w: Math.round(r.width), name: b.textContent, fits: f.scrollWidth <= f.clientWidth, last: f.lastElementChild.textContent }; })()`);
  ok(cm.font === "0px" && cm.icon === "22px" && cm.w < 60 && /^Comments/.test(cm.name), "Comments is a speech bubble, narrow, still named Comments: " + J(cm));
  ok(cm.fits && cm.last === "⋯", "the foot's row fits the screen, ⋯ at its end: " + J(cm));
  const MORE = `(() => { const m = document.querySelector(".tex-page .tex-moremenu"); if (!m) return null; const r = m.getBoundingClientRect();
    return { shown: !m.hidden && r.height > 0, bottom: Math.round(r.bottom), items: [...m.querySelectorAll("button, .tex-zoomv")].filter((b) => b.offsetWidth > 0).map((b) => b.textContent.trim()) }; })()`;
  ok((await ev(MORE))?.shown === false, "⋯'s menu closed at first");
  await ev(`document.querySelector(".tex-page .tex-foot .tex-morebtn").click(), 1`);
  await sleep(300);
  let mm = await ev(MORE);
  p = await ev(PARTS);
  ok(mm?.shown && mm.bottom <= p.foot.top + 1 && ["A−", "A+", "−", "+", "Follow", "Show", "Terminal"].every((t) => mm.items.includes(t)), "⋯ opens a menu above the foot: the text size, the zoom, Follow, Show, Terminal: " + J({ mm, foot: p.foot }));
  const z0 = await ev(`document.querySelector(".tex-moremenu .tex-zoomv").textContent`);
  await ev(`([...document.querySelectorAll(".tex-moremenu button")].find((b) => b.textContent === "+").click(), 1)`);
  await sleep(300);
  const z1 = await ev(`document.querySelector(".tex-moremenu .tex-zoomv").textContent`);
  ok(z1 !== z0 && (await ev(MORE)).shown, "its zoom works from there, the menu staying open: " + J({ z0, z1 }));
  await ev(`([...document.querySelectorAll(".tex-moremenu button")].find((b) => b.textContent === "−").click(), 1)`);
  await ev(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`);
  await sleep(200);
  ok((await ev(MORE)).shown === false, "Escape closes it");
  await ev(`document.querySelector(".tex-page .tex-foot .tex-filebtn").click(), 1`);
  await sleep(400);
  p = await ev(PARTS);
  ok(p.menu?.shown && p.menu.bottom <= p.foot.top + 1, "the File menu opens above the foot: " + J({ menu: p.menu, foot: p.foot }));
  await ev(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), document.body.click(), 1)`);
  await sleep(300);
  // the keyboard up (a field with the focus): the foot put away
  await ev(`(document.querySelector(".tex-page .cm-content, .tex-page textarea")?.focus(), 1)`);
  await sleep(300);
  p = await ev(PARTS);
  ok((await ev(`document.documentElement.classList.contains("typing")`)) && !p.foot?.shown, "typing in the source: the foot is put away: " + J(p.foot));

  // ---- a wide screen with a mouse: as before
  await send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await openTex(`${base}?phone=0`);
  p = await ev(PARTS);
  ok(!p.foot && !(await ev(`!!document.querySelector(".tex-moremenu, .tex-morebtn")`)) && ["File", "Comments", "Agent"].every((t) => p.inHead.includes(t)) && p.tools?.shown, "a wide screen (source and preview side by side, no Preview toggle): no foot, the actions and the tools in the head: " + J({ head: p.inHead, tools: p.tools }));
} catch (e) {
  ok(false, "threw: " + (e?.stack ?? e));
} finally {
  ws.close();
  chrome.kill();
  server.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
ok(errors.length === 0, "no exceptions on the page: " + J(errors.slice(0, 3)));
console.log(`${checks - fails.length}/${checks} checks passed`);
process.exit(fails.length ? 1 : 0);
