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
const server = spawn("python3", [join(here, "..", "web", "serve.py"), String(port)], { stdio: "ignore" });
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
await send("Page.navigate", { url: `http://127.0.0.1:${port}/space/?space=demo.space.json` });
ok(await until(`/objects/.test(document.querySelector('#status')?.textContent ?? '')`, 30000), "the space loads");
await sleep(1200);
ok((await ev(`whitespace.walking`)) === (await ev(`matchMedia("(pointer: fine)").matches`)), "walking is the default with a mouse, flying without one (headless: none)", await ev(`document.querySelector('#move').textContent`));
if (!(await ev(`whitespace.walking`))) { await key("g"); await key("g", false); }
ok(await ev(`whitespace.walking`), "G turns walking on");
const P = () => ev(`whitespace.camera.position.toArray().map((x) => +x.toFixed(2))`);
// (first, onto the floor: a click on the floor below the middle of the view)
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700, y: 860 });
for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: 700, y: 860, button: "left", clickCount: 1 });
ok(await until(`Math.abs(whitespace.feet - whitespace.floorY) < 0.01`, 5000), "a click on the floor takes you there, standing on it", { feet: await ev(`whitespace.feet`), floor: await ev(`whitespace.floorY`) });
const a = await P();
await key("w"); await sleep(700); await key("w", false);
const b = await P();
ok(Math.hypot(b[0] - a[0], b[2] - a[2]) > 3 && Math.abs(b[1] - a[1]) < 0.01, "W walks along the floor", { a, b });
await key(" ", true, { code: "Space" }); await sleep(250);
const up = await ev(`whitespace.feet - whitespace.floorY`);
await key(" ", false, { code: "Space" });
ok(up > 1, "Space jumps", { up });
ok(await until(`Math.abs(whitespace.feet - whitespace.floorY) < 0.01`, 3000), "and you land again");
const t0 = await ev(`whitespace.controls.target.toArray()`), c0 = await P();
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 300, y: 200, button: "left", clickCount: 1 });
for (let i = 1; i <= 5; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300 + i * 30, y: 200, button: "left", buttons: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 450, y: 200, button: "left", clickCount: 1 });
const t1 = await ev(`whitespace.controls.target.toArray()`), c1 = await P();
ok(Math.hypot(t1[0] - t0[0], t1[2] - t0[2]) > 1 && JSON.stringify(c1) === JSON.stringify(c0), "dragging looks around, without moving you", { t0, t1 });
await key("g"); await key("g", false);
ok((await ev(`whitespace.walking`)) === false && (await ev(`whitespace.controls.enabled`)), "G flies instead (the orbit controls back)");
await key("g"); await key("g", false);
ok((await ev(`whitespace.walking`)) === true, "and G walks again");
await key("?"); await key("?", false);
ok(await ev(`!document.querySelector('#helpcard').hidden`), "? shows the help");
await key("Escape"); await key("Escape", false);
ok(await ev(`document.querySelector('#helpcard').hidden`), "and Esc closes it");
ok(errors.length === 0, "no page errors", errors.slice(0, 3));
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
