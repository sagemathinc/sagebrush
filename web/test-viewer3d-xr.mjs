// ci: none (a browser test, as web/test-notebook.mjs: run by hand or wired with it)
// The 3D viewer's headset mode (web/viewer3d-xr.js), end to end in headless Chromium, on Meta's WebXR emulator (IWER,
// a devDependency: an emulated Quest 3 and its controllers, installed before the page runs). In the notebook page, a
// Sage plot3d's view offers "Enter VR" (the module is fetched only when pressed); in VR the plot is drawn every frame,
// a grip takes it in that hand and it follows the hand, the thumbstick scales it, B leaves; the page's view is back.
// Without WebXR (no emulator), there is no "Enter VR".
//   bun web/build.ts && python3 web/serve.py 8765 &
//   bun web/test-viewer3d-xr.mjs             (SB_URL=..., CHROME=...)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const url = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, msg, detail) => {
  console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 300) : ""));
  if (!c) failures++;
};

// (the emulator as one classic script, run before the page's own; forceInstall: headless Chromium has a navigator.xr
//  of its own, with no device)
const entry = join(here, `.test-iwer-${process.pid}.js`);
writeFileSync(entry, "import { XRDevice, metaQuest3 } from 'iwer'; const d = new XRDevice(metaQuest3); d.installRuntime({ forceInstall: true }); window.__xrDevice = d;\n");
let iwer;
try {
  const r = await Bun.build({ entrypoints: [entry], target: "browser", format: "iife" });
  if (!r.success) throw new Error(r.logs.map(String).join("\n"));
  iwer = await r.outputs[0].text();
} finally {
  rmSync(entry, { force: true });
}

async function browser(withXR) {
  const profile = mkdtempSync(join(tmpdir(), "sb-viewer3d-xr-"));
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  // (Chromium and its profile go away however this ends)
  const close = () => { chrome.kill("SIGKILL"); rmSync(profile, { recursive: true, force: true }); };
  process.on("exit", close);
  let port;
  for (let i = 0; i < 300 && !port; i++) { try { port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch {} await sleep(100); }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map(), errors = [], requested = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description?.slice(0, 300) ?? m.params.exceptionDetails.text);
    if (m.method === "Network.requestWillBeSent") requested.push(m.params.request.url);
  });
  // (every call bounded: a hung page fails the check instead of the run)
  const send = (method, params = {}, ms = 30000) => Promise.race([new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }), sleep(ms).then(() => ({ timeout: method }))]);
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.timeout || r.result?.exceptionDetails) throw new Error(r.timeout ? "timeout" : JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };
  const until = async (expr, ms = 20000) => {
    for (const t = Date.now(); Date.now() - t < ms; ) { if (await ev(expr).catch(() => false)) return true; await sleep(150); }
    return false;
  };
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Page.enable");
  if (withXR) await send("Page.addScriptToEvaluateOnNewDocument", { source: iwer });
  await send("Page.navigate", { url });
  return { ev, until, send, errors, requested, close };
}

// A Sage plot3d in a new cell; resolves once its view (a canvas) is up.
async function plot(b) {
  await b.until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
  await b.ev("(() => { window.confirm = () => true; const m = document.querySelector('#mode'); m.value = 'sage'; m.dispatchEvent(new Event('change')); return true; })()");
  await b.ev(`(() => { const cs = [...document.querySelectorAll('.cell')]; let c = cs.at(-1); if (c.querySelector('textarea').value.trim()) { document.querySelector('#add').click(); c = [...document.querySelectorAll('.cell')].at(-1); } const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify("y = var('y')\nplot3d(sin(x*y), (x, -3, 3), (y, -3, 3))")}; ta.dispatchEvent(new Event('input', {bubbles: true})); c.querySelector('[data-a=run]').click(); return true; })()`);
  return b.until("!!document.querySelector('figure.plot3d canvas')", 90000);
}
const vrButton = "[...document.querySelectorAll('figure.plot3d .sb3d-buttons button')].find((b) => /VR/.test(b.textContent))";
// (the view's canvas, kept before Enter VR: the emulator moves a session's canvas into a container of its own while
//  it runs, and puts it back after)
const xr = "window.__canvas.sagebrush.xr";

// ---- with a headset (the emulator)
{
  const b = await browser(true);
  try {
    ok(await plot(b), "a Sage plot3d shows its 3D view");
    ok(await b.until(`!!${vrButton}`, 10000), "its view offers Enter VR (the browser has immersive VR, the page has the module)");
    ok(!b.requested.some((u) => u.includes("sagebrush-viewer3d-xr.js")), "the headset module isn't fetched before Enter VR");
    await b.ev(`(window.__canvas = document.querySelector('figure.plot3d canvas'), ${vrButton}.click(), true)`);
    ok(await b.until(`(${xr})?.state.frames > 5`, 15000), "Enter VR: the plot is drawn in the headset, frame after frame", await b.ev(`(${xr})?.state.frames ?? null`).catch(() => null));
    ok(b.requested.some((u) => u.includes("sagebrush-viewer3d-xr.js")), "the module was fetched when pressed");
    // (the headset's image: part of it is the plot, not the backdrop)
    const px = await b.ev(`(${xr}).probe()`);
    ok(px && px.covered > 0.01 && px.covered < 0.9, "the headset sees the plot (part of its view isn't the backdrop)", px);
    ok((await b.ev(`${vrButton}.textContent`)) === "Exit VR", "the button says Exit VR");

    // a grip takes the plot; moving the hand moves it
    const model = () => b.ev(`(${xr}).state.model.slice(12, 15).map((v) => +v.toFixed(3))`);
    const before = await model();
    await b.ev("window.__xrDevice.controllers.right.updateButtonValue('squeeze', 1), true");
    ok(await b.until(`(${xr}).state.grabbed === 'right'`, 3000), "the right grip takes the plot");
    await b.ev("(() => { const p = window.__xrDevice.controllers.right.position; p.set(p.x + 0.2, p.y + 0.1, p.z); return true; })()");
    await b.until(`(${xr}).state.model[12] > ${before[0]} + 0.19`, 3000);
    const moved = await model();
    ok(Math.abs(moved[0] - before[0] - 0.2) < 0.02 && Math.abs(moved[1] - before[1] - 0.1) < 0.02, "and it follows the hand (20 cm right, 10 cm up)", { before, moved });
    await b.ev("window.__xrDevice.controllers.right.updateButtonValue('squeeze', 0), true");
    ok(await b.until(`(${xr}).state.grabbed === null`, 3000), "letting go leaves it there");

    // the thumbstick: up makes it bigger
    const scale = () => b.ev(`(() => { const m = (${xr}).state.model; return Math.hypot(m[0], m[1], m[2]); })()`);
    const s0 = await scale();
    await b.ev("window.__xrDevice.controllers.left.updateAxes('thumbstick', 0, -1), true");
    await sleep(500);
    await b.ev("window.__xrDevice.controllers.left.updateAxes('thumbstick', 0, 0), true");
    const s1 = await scale();
    ok(s1 > s0 * 1.2, "thumbstick up makes it bigger", { s0: +s0.toFixed(4), s1: +s1.toFixed(4) });
    // the thumbstick sideways turns it about its upright axis
    const yaw = () => b.ev(`(() => { const m = (${xr}).state.model; return Math.atan2(m[8], m[10]); })()`);
    const a0 = await yaw();
    await b.ev("window.__xrDevice.controllers.right.updateAxes('thumbstick', 1, 0), true");
    await sleep(300);
    await b.ev("window.__xrDevice.controllers.right.updateAxes('thumbstick', 0, 0), true");
    const d = (await yaw()) - a0, turned = Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
    ok(turned > 0.2, "thumbstick sideways turns it", { turned: +turned.toFixed(3) });

    // the page's pixels now, to compare after leaving (its canvas keeps its drawing: preserveDrawingBuffer)
    // B leaves; the page's view is back and draws again
    await b.ev("window.__xrDevice.controllers.right.updateButtonValue('b-button', 1), true");
    await sleep(300);
    await b.ev("window.__xrDevice.controllers.right.updateButtonValue('b-button', 0), true");
    ok(await b.until(`${xr} === null`, 5000), "B leaves VR");
    ok((await b.ev(`${vrButton}.textContent`)) === "Enter VR", "the button says Enter VR again");
    ok(await b.ev("document.querySelector('figure.plot3d canvas') === window.__canvas"), "the view's canvas is back in its figure");
    const drew = await b.ev("(() => { const c = window.__canvas, t0 = c.sagebrush.view.az, p0 = c.toDataURL(); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', bubbles: true })); return new Promise((r) => setTimeout(() => r({ turned: c.sagebrush.view.az !== t0, pixels: c.toDataURL() !== p0 }), 600)); })()");
    ok(drew.turned && drew.pixels, "the page's view works as before (arrow keys turn it, and its pixels change)", drew);

    // again, leaving with Y on the left hand this time
    await b.ev(`${vrButton}.click(), true`);
    ok(await b.until(`(${xr})?.state.frames > 3`, 15000), "Enter VR a second time");
    await b.ev("window.__xrDevice.controllers.left.updateButtonValue('y-button', 1), true");
    await sleep(300);
    await b.ev("window.__xrDevice.controllers.left.updateButtonValue('y-button', 0), true");
    ok(await b.until(`${xr} === null`, 5000), "Y leaves too");

    // the view replaced while in VR (its cell run again): the session ends with it
    await b.ev(`${vrButton}.click(), true`);
    ok(await b.until(`(${xr})?.state.frames > 3`, 15000), "Enter VR a third time");
    await b.ev(`(() => { const c = [...document.querySelectorAll('.cell')].filter((c) => c.querySelector('textarea').value.trim()).at(-1); c.querySelector('[data-a=run]').click(); return true; })()`);
    ok(await b.until("!window.__canvas.isConnected && window.__canvas.sagebrush.xr === null", 20000), "running the cell again ends the session with the old view");
    ok(await b.until("!!document.querySelector('figure.plot3d canvas')", 60000), "and the new view comes up");

    // a version 2 scene (k3d) offers no Enter VR (for now)
    const v2 = await b.ev(`(() => { const d = document.createElement('div'); d.innerHTML = '<svg></svg>'; document.body.appendChild(d);
      window.SagebrushViewer3d.mount(d, { version: 2, lo: [0, 0, 0], hi: [1, 1, 1], scale: [2, 2, 2], objects: [{ type: 'mesh2', color: '#ff0000', positions: btoa(String.fromCharCode(...new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer))), indices: btoa(String.fromCharCode(...new Uint8Array(new Uint32Array([0, 1, 2]).buffer))) }] });
      return new Promise((r) => setTimeout(() => { const has = [...d.querySelectorAll('.sb3d-buttons button')].some((x) => /VR/.test(x.textContent)); const mounted = !!d.querySelector('canvas'); d.remove(); r({ mounted, has }); }, 1500)); })()`);
    ok(v2.mounted && !v2.has, "a version 2 scene shows its 3D view but offers no Enter VR", v2);
    ok(b.errors.length === 0, "no page errors", b.errors.slice(0, 3));
  } finally {
    b.close();
  }
}

// ---- without one: no Enter VR (headless Chromium's own navigator.xr has no immersive device)
{
  const b = await browser(false);
  try {
    ok(await plot(b), "without a headset, the plot shows as before");
    await sleep(1500);
    ok(!(await b.ev(`!!${vrButton}`)), "and there is no Enter VR");
    ok(!b.requested.some((u) => u.includes("sagebrush-viewer3d-xr.js")), "nor is the module fetched");
  } finally {
    b.close();
  }
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
