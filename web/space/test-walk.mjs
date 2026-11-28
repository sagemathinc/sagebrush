// ci: web-browser/space order=20 chrome
// Walking on the desktop, in headless Chromium against the built site: walking is the default with a mouse; W walks
// along the floor and you stay on it; Space jumps and you land again; dragging looks around without moving you; a
// click on the floor takes you there (a blink), standing on it; G flies instead (and back); ? shows the help.
//   (after a site build: space/build-alpha.sh, or node build.mjs --site ../web/dist)   node space/test-walk.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 300) : "")); if (!c) failures++; };
const port = 8500 + Math.floor(Math.random() * 90);
const server = spawn("python3", [join(here, "..", "serve.py"), String(port)], { stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "space-walk-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1400,900", "about:blank"], { stdio: "ignore" });
process.on("exit", () => { chrome.kill("SIGKILL"); server.kill("SIGKILL"); });
let cdpPort;
for (let i = 0; i < 200 && !cdpPort; i++) { try { cdpPort = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch {} await sleep(100); }
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map(), errors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description?.slice(0, 300) ?? m.params.exceptionDetails.text);
});
const send = (method, params = {}, ms = 30000) => Promise.race([new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }), sleep(ms).then(() => ({ timeout: method }))]);
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
const until = async (expr, ms = 15000) => { for (const t = Date.now(); Date.now() - t < ms; ) { if (await ev(expr).catch(() => false)) return true; await sleep(150); } return false; };
const key = async (k, down = true, extra = {}) => send("Input.dispatchKeyEvent", { type: down ? "keyDown" : "keyUp", key: k, ...extra });
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `http://127.0.0.1:${port}/space/?space=intro.space.json` });
ok(await until(`/objects/.test(document.querySelector('[data-c="status"]')?.textContent ?? '')`, 30000), "the space loads");
await sleep(1200);
ok((await ev(`space3d.walking`)) === (await ev(`matchMedia("(pointer: fine)").matches`)), "walking is the default with a mouse, flying without one (headless: none)", await ev(`document.querySelector('[data-c="move"]').textContent`));
if (!(await ev(`space3d.walking`))) { await key("g"); await key("g", false); }
ok(await ev(`space3d.walking`), "G turns walking on");
const P = () => ev(`space3d.camera.position.toArray().map((x) => +x.toFixed(2))`);
// (first, onto the floor: a click on the floor below the middle of the view)
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700, y: 860 });
for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: 700, y: 860, button: "left", clickCount: 1 });
ok(await until(`Math.abs(space3d.feet - space3d.floorY) < 0.01`, 5000), "a click on the floor takes you there, standing on it", { feet: await ev(`space3d.feet`), floor: await ev(`space3d.floorY`) });
// (movement is per drawn frame, and headless Chromium draws this scene only a few frames a second: a key is held
//  until what it does has happened (with a deadline), never for a fixed time; then the view is let settle)
const settle = async () => { let p = await P(); for (const t = Date.now(); Date.now() - t < 5000; ) { await sleep(300); const q = await P(); if (JSON.stringify(q) === JSON.stringify(p)) return q; p = q; } return p; };
const a = await settle();
await key("w");
const walked = await until(`Math.hypot(space3d.camera.position.x - ${a[0]}, space3d.camera.position.z - ${a[2]}) > 3`, 8000);
await key("w", false);
const b = await settle();
ok(walked && Math.abs(b[1] - a[1]) < 0.01, "W walks along the floor", { a, b });
await key(" ", true, { code: "Space" });
const jumped = await until(`space3d.feet - space3d.floorY > 1`, 3000);
const up = await ev(`space3d.feet - space3d.floorY`);
await key(" ", false, { code: "Space" });
ok(jumped, "Space jumps", { up });
// (a jump lands over a few drawn frames, and a headless browser draws few, fewer still beside another suite)
ok(await until(`Math.abs(space3d.feet - space3d.floorY) < 0.01`, 10000), "and you land again");
const c0 = await settle(), t0 = await ev(`space3d.controls.target.toArray()`);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 300, y: 200, button: "left", clickCount: 1 });
for (let i = 1; i <= 5; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300 + i * 30, y: 200, button: "left", buttons: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 450, y: 200, button: "left", clickCount: 1 });
await until(`Math.hypot(space3d.controls.target.x - ${t0[0]}, space3d.controls.target.z - ${t0[2]}) > 1`, 5000);
const t1 = await ev(`space3d.controls.target.toArray()`), c1 = await settle();
ok(Math.hypot(t1[0] - t0[0], t1[2] - t0[2]) > 1 && JSON.stringify(c1) === JSON.stringify(c0), "dragging looks around, without moving you", { t0, t1 });
await key("g"); await key("g", false);
ok((await ev(`space3d.walking`)) === false && (await ev(`space3d.controls.enabled`)), "G flies instead (the orbit controls back)");
await key("g"); await key("g", false);
ok((await ev(`space3d.walking`)) === true, "and G walks again");
// (the wheel: a mouse's notch is a step of 3; a trackpad's pinch, many small Ctrl+wheel turns, walks only as far as they turn)
const wheel = (n, init) => ev(`(async () => {
  const c = document.querySelector("canvas"), a = space3d.camera.position.clone();
  for (let k = 0; k < ${n}; k++) { c.dispatchEvent(new WheelEvent("wheel", { ...${JSON.stringify(init)}, bubbles: true, cancelable: true })); await new Promise((r) => requestAnimationFrame(r)); }
  const b = space3d.camera.position; return +Math.hypot(b.x - a.x, b.z - a.z).toFixed(2);
})()`);
const notch = await wheel(1, { deltaY: -100 });
ok(notch > 2.5 && notch < 3.5, "a mouse wheel's notch walks a step of 3", { notch });
const pinch = await wheel(60, { deltaY: -2, ctrlKey: true });
ok(pinch > 1 && pinch < 6, "a second of trackpad pinch (60 small Ctrl+wheel turns) walks a few units, not 180", { pinch });
const lines = await wheel(1, { deltaY: -3, deltaMode: 1 });
ok(lines > 1 && lines < 2, "a wheel that counts in lines (3 lines) walks as 48 pixels would", { lines });
const none = await wheel(1, { deltaY: 0 });
ok(none === 0, "a wheel event that didn't turn doesn't move you", { none });
const big = await wheel(1, { deltaY: -5000 });
ok(big > 2.5 && big < 3.5, "a large turn is still one step of 3 at most", { big });
const page = await wheel(1, { deltaY: -1, deltaMode: 2 });
ok(page > 2.5 && page < 3.5, "a wheel that counts in pages (800 pixels each) is a step of 3, the most", { page });
const ahead = await ev(`(() => { const p = space3d.camera.position, t = space3d.controls.target; return [t.x - p.x, t.z - p.z]; })()`);
const before = await ev(`space3d.camera.position.toArray()`);
await wheel(1, { deltaY: 100 });
const after = await ev(`space3d.camera.position.toArray()`);
const along = (after[0] - before[0]) * ahead[0] + (after[2] - before[2]) * ahead[1];
ok(along < 0, "a turn the other way walks back", { along: +along.toFixed(2) });
await key("?"); await key("?", false);
ok(await ev(`!document.querySelector('[data-c="helpcard"]').hidden`), "? shows the help");
await key("Escape"); await key("Escape", false);
ok(await ev(`document.querySelector('[data-c="helpcard"]').hidden`), "and Esc closes it");
ok(errors.length === 0, "no page errors", errors.slice(0, 3));
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
