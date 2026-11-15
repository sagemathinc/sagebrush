// ci: web-browser/notebook order=248
// Two things on a phone, in headless Chrome with a phone's metrics (393 x 800, touch, the phone layout), and the same
// on a wide screen with a mouse for contrast:
// - the Files panel covers a phone's screen, so a page never opens with it showing, even when it was left open:
//   a file opened from it (a LaTeX document, a board, another page) is what you see; a wide window opens it again;
// - the 3D viewer (web/viewer3d.js) on a touch screen: no Fly (it looks with a mouse and moves with keys), help that
//   says what fingers do; and where the browser has no full screen for an element (an iPhone's), Full screen puts the
//   view over the whole window, out of a container that would clip it, and Close puts it back where it was.
//   On a wide screen with a mouse: Fly and the keys' help, as before.
// Serve web/dist first (python3 web/serve.py 8765), then   node web/test-phone-pages.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-phone-pages-"));
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

// a small Sage plot3d's scene, as the notebook hands it to the viewer
const SCENE = {"version":1,"lo":[-1,-1,-1],"hi":[1,1,1],"scale":[1,1,1],"objects":[{"type":"mesh","pos":[-1,-1,1,-0.5,-1,0.5,-0.5,-0.5,0.25,-1,-0.5,0.5,-0.5,0,0,-1,0,0,-0.5,0.5,-0.25,-1,0.5,-0.5,-0.5,1,-0.5,-1,1,-1,0,-1,0,0,-0.5,0,0,0,0,0,0.5,0,0,1,0,0.5,-1,-0.5,0.5,-0.5,-0.25,0.5,0,0,0.5,0.5,0.25,0.5,1,0.5,1,-1,-1,1,-0.5,-0.5,1,0,0,1,0.5,0.5,1,1,1],"idx":[0,1,2,0,2,3,3,2,4,3,4,5,5,4,6,5,6,7,7,6,8,7,8,9,1,10,11,1,11,2,2,11,12,2,12,4,4,12,13,4,13,6,6,13,14,6,14,8,10,15,16,10,16,11,11,16,17,11,17,12,12,17,18,12,18,13,13,18,19,13,19,14,15,20,21,15,21,16,16,21,22,16,22,17,17,22,23,17,23,18,18,23,24,18,24,19],"color":"#4573e6","opacity":1}],"frame":true,"axes":false,"labels":["x","y","z"],"title":null,"azimuth":-60,"elevation":25,"description":"3D plot: surface z = x*y of 16 polygons; x from -1 to 1; y from -1 to 1; z from -1 to 1"};
const phone = async () => {
  await send("Emulation.setDeviceMetricsOverride", { width: 393, height: 800, deviceScaleFactor: 3, mobile: true, screenWidth: 393, screenHeight: 852 });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
};
const wide = async () => {
  await send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
};
const open = async (url) => {
  await send("Page.navigate", { url });
  ok(await until("!!window.sagebrush?.notebook?.cells && document.querySelectorAll('.cell').length > 0 && !document.body.classList.contains('opening')", 60000), `the notebook page (${url})`);
  await sleep(800);
};
const filesShown = `!document.getElementById("wssidebar").hidden`;
// the viewer, mounted in a container that clips what is fixed inside it (a transformed one, as an output's frame can be)
const MOUNT = `new Promise((resolve, reject) => {
  const go = () => { const box = document.createElement("div"); box.id = "t3d"; box.style.cssText = "transform:translateZ(0);overflow:hidden;width:300px;margin:20px";
    const c = document.createElement("div"); box.append(c); document.querySelector("main").prepend(box); window.SagebrushViewer3d.mount(c, ${J(SCENE)}); resolve(1); };
  if (window.SagebrushViewer3d) return go();
  const s = document.createElement("script"); s.src = "/sagebrush-viewer3d.js"; s.onload = go; s.onerror = reject; document.head.append(s); })`;
const VIEW = `(() => { const w = document.querySelector(".sb3d-view"); if (!w) return null; const r = w.getBoundingClientRect(), c = w.querySelector("canvas");
  const help = [...w.children].find((d) => d.tagName === "DIV" && /rotate/.test(d.textContent));
  return { buttons: [...w.querySelectorAll(".sb3d-buttons button")].map((b) => b.textContent), help: help ? help.textContent : "", inBox: !!w.closest("#t3d"),
    box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], canvas: [c.clientWidth, c.clientHeight], scroll: document.documentElement.style.overflow, title: c.title }; })()`;
const press = (label) => ev(`([...document.querySelectorAll(".sb3d-buttons button")].find((b) => b.textContent === ${J(label)})?.click(), 1)`);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });

  // ---- the Files panel, left open, and a page opened
  await phone();
  await open(`${base}?phone=1`);
  await ev(`localStorage.setItem("sagebrush-files-sidebar", "1"), 1`);
  await open(base);
  ok(!(await ev(filesShown)), "a phone: a page opens without the Files panel over it, though it was left open");
  ok(await ev(`!document.body.classList.contains("wsfiles")`), "…and the page isn't laid out for it");
  await wide();
  await open(`${base}?phone=0`);
  await ev(`localStorage.setItem("sagebrush-files-sidebar", "1"), 1`);
  await open(base);
  ok(await until(filesShown, 10000), "a wide window: the Files panel left open is open again");

  // ---- the 3D viewer on a touch screen, with no full screen for an element (an iPhone's)
  const noFull = await send("Page.addScriptToEvaluateOnNewDocument", { source: "delete Element.prototype.requestFullscreen; delete Element.prototype.webkitRequestFullscreen;" });
  await phone();
  await open(`${base}?phone=1`);
  await ev(`localStorage.setItem("sagebrush-files-sidebar", "0"), 1`);
  await ev(MOUNT);
  ok(await until(`!!document.querySelector(".sb3d-view canvas")`, 20000), "a phone: the 3D view is mounted");
  let v = await ev(VIEW);
  ok(!v.buttons.includes("Fly") && v.buttons.includes("Home") && v.buttons.includes("Full screen"), "no Fly on a touch screen; Home and Full screen are there: " + J(v.buttons));
  ok(/two fingers/.test(v.help) && /pinch/.test(v.help) && !/mouse|W A S D|wheel/i.test(v.help), "the help says what fingers do, not the mouse or the keys: " + J(v.help));
  ok(/two fingers/.test(v.title) && !/fly/i.test(v.title), "and so does the view's own label: " + J(v.title));
  await ev(`(document.querySelector(".sb3d-view canvas").dispatchEvent(new KeyboardEvent("keydown", { code: "KeyF", bubbles: true })), 1)`);
  ok(!(await ev(`document.querySelector(".sb3d-view canvas").sagebrush.fly`)), "F doesn't fly on a touch screen");
  await press("Full screen");
  await sleep(500);
  v = await ev(VIEW);
  ok(!v.inBox && v.box[0] === 0 && v.box[1] === 0 && v.box[2] === 393 && v.box[3] === 800 && v.canvas[0] === 393 && v.canvas[1] === 800, "Full screen, with no full screen for an element: the view over the whole window, out of its clipping container: " + J(v));
  ok(v.scroll === "hidden" && v.buttons.includes("Close"), "the page under it doesn't scroll, and Close is offered: " + J({ scroll: v.scroll, buttons: v.buttons }));
  await press("Close");
  await sleep(500);
  v = await ev(VIEW);
  ok(v.inBox && v.box[2] <= 300 && v.scroll === "" && v.buttons.includes("Full screen") && (await ev(`document.querySelectorAll("#t3d > div").length`)) === 1, "Close: back in its place, the page scrolling again, no placeholder left: " + J(v));
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: noFull.identifier });

  // ---- a wide screen with a mouse: as before
  await wide();
  await open(`${base}?phone=0`);
  await ev(MOUNT);
  ok(await until(`!!document.querySelector(".sb3d-view canvas")`, 20000), "a wide screen: the 3D view is mounted");
  v = await ev(VIEW);
  ok(v.buttons.includes("Fly") && /mouse/.test(v.help) && /W A S D/.test(v.help), "with a mouse: Fly, and the help for the mouse and the keys: " + J(v.buttons));
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
