// The space in a headset, without one: Meta's WebXR emulator (IWER, a devDependency), an emulated Quest 3 with its
// controllers, installed in headless Chromium before the page runs. Enters VR, points the right controller at an
// object and pulls the trigger (the reading panel opens; the selection is the object), presses Run on the panel,
// moves and turns with the thumbsticks, and leaves VR (the camera is back where it was).
//   (after a site build: space/build-alpha.sh, or node build.mjs --site ../web/dist)
//   node space/test-xr.mjs [screenshot-prefix]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const here = new URL(".", import.meta.url).pathname;
const out = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, msg, detail) => {
  console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 300) : ""));
  if (!c) failures++;
};

// ---- the emulator, as one classic script that runs before the page's own (forceInstall: headless Chromium has a
//      navigator.xr of its own, with no device)
const iwer = (await build({ stdin: { contents: "import { XRDevice, metaQuest3 } from 'iwer'; const d = new XRDevice(metaQuest3); d.installRuntime({ forceInstall: true }); window.__xrDevice = d;", resolveDir: here },
  bundle: true, format: "iife", write: false, logLevel: "error" })).outputFiles[0].text;

// ---- the site, as web/serve.py serves it (COOP/COEP from web/dist/_headers)
const port = 8200 + Math.floor(Math.random() * 500);
const server = spawn("python3", [join(here, "..", "web", "serve.py"), String(port)], { stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "space-xr-"));
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
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};
const until = async (expr, ms = 15000) => {
  for (const t = Date.now(); Date.now() - t < ms; ) { if (await ev(expr).catch(() => false)) return true; await sleep(150); }
  return false;
};
const shot = async (name) => { if (!out) return; const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${out}-${name}.png`, Buffer.from(r.result.data, "base64")); };
await send("Runtime.enable");
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: iwer });
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(500);
await send("Page.navigate", { url: `http://127.0.0.1:${port}/space/?space=demo.space.json` });
ok(await until(`/objects/.test(document.querySelector('#status')?.textContent ?? '')`, 30000), "the space loads");
ok(await until(`!document.querySelector('#vr').hidden`), "Enter VR is offered (the headset supports immersive-vr)");

// ---- enter VR
const camBefore = await ev(`whitespace.camera.position.toArray().map((x) => +x.toFixed(3))`);
await ev(`document.querySelector('#vr').click(), true`);
ok(await until(`whitespace.xr.presenting`), "in VR");
ok((await ev(`document.querySelector('#vr').textContent`)) === "Exit VR", "the button says Exit VR");
await sleep(800);
await shot("vr-enter");

// ---- point the right controller at an object (the logistic map's slab) and pull the trigger
const aim = (target) => `(() => {
  const W = whitespace, rig = W.xr.rig, V = rig.position.constructor, Q = rig.quaternion.constructor;
  const o = W.objects[W.space.nodes.findIndex((n) => n.id === ${JSON.stringify(target)})];
  const t = rig.worldToLocal(o.getWorldPosition(new V()));
  const c = window.__xrDevice.controllers.right;
  const from = new V(c.position.x, c.position.y, c.position.z);
  const q = new Q().setFromUnitVectors(new V(0, 0, -1), t.sub(from).normalize());
  c.quaternion.set(q.x, q.y, q.z, q.w);
  return true;
})()`;
await ev(aim("logistic"));
await sleep(300);
await ev(`window.__xrDevice.controllers.right.updateButtonValue('trigger', 1), true`);
await sleep(200);
await ev(`window.__xrDevice.controllers.right.updateButtonValue('trigger', 0), true`);
ok(await until(`whitespace.xr.panel?.id === 'logistic'`, 5000), "the trigger on an object opens its reading panel", await ev(`whitespace.xr.panel`));
ok((await ev(`whitespace.selection?.id`)) === "logistic", "and selects it (as a click does: the agent sees it)");
// (and flies you to it: your head where the desktop's camera would go, about 9 units in front of its face)
const headTo = (target) => `(() => { const W = whitespace, V = W.camera.position.constructor;
  const o = W.objects[W.space.nodes.findIndex((n) => n.id === ${JSON.stringify(target)})];
  return +W.camera.getWorldPosition(new V()).distanceTo(o.getWorldPosition(new V())).toFixed(2); })()`;
ok(await until(`whitespace.xr.history.flying === false && whitespace.xr.history.back === 1`, 5000), "and you fly there (one step to go back)", await ev(`whitespace.xr.history`));
const near = await ev(headTo("logistic"));
ok(near > 7 && near < 11, "you end up in front of it, as on the desktop", { distance: near });
await sleep(500);
await shot("vr-panel");

// ---- Run, from the panel (as its button does)
await ev(`whitespace.xr.press('run'), true`);
ok(await until(`whitespace.xr.panel?.state === 'done'`, 60000), "Run on the panel runs the object's code", await ev(`whitespace.xr.panel`));
await sleep(300);
await shot("vr-ran");

// ---- the thumbsticks: left forward moves; right sideways turns 30°
const rigBefore = await ev(`[...whitespace.xr.rig.position.toArray(), whitespace.xr.rig.rotation.y].map((x) => +x.toFixed(3))`);
await ev(`window.__xrDevice.controllers.left.updateAxes('thumbstick', 0, -1), true`);
await sleep(600);
await ev(`window.__xrDevice.controllers.left.updateAxes('thumbstick', 0, 0), true`);
const rigMoved = await ev(`whitespace.xr.rig.position.toArray().map((x) => +x.toFixed(3))`);
const moved = Math.hypot(rigMoved[0] - rigBefore[0], rigMoved[2] - rigBefore[2]);
ok(moved > 1, "the left thumbstick moves you", { moved: +moved.toFixed(2) });
await ev(`window.__xrDevice.controllers.right.updateAxes('thumbstick', 1, 0), true`);
await sleep(300);
await ev(`window.__xrDevice.controllers.right.updateAxes('thumbstick', 0, 0), true`);
await sleep(200);
const turned = (await ev(`whitespace.xr.rig.rotation.y`)) - rigBefore[3];
ok(Math.abs(Math.abs(turned) - Math.PI / 6) < 1e-3, "the right thumbstick turns you 30°", { turned: +turned.toFixed(3) });

// ---- the wrist menu: Back flies back to where you were; Forward returns; See all; B is Back too
const far = async () => ev(headTo("logistic"));
const beforeBack = await far(); // (where the thumbsticks left you: what Forward returns to)
await ev(`whitespace.xr.menuPress('back'), true`);
await until(`whitespace.xr.history.flying === false`, 3000);
await sleep(100);
const afterBack = await far();
ok(afterBack > beforeBack + 5, "Back (wrist menu) flies back to where you were before flying to it", { distance: afterBack });
await ev(`whitespace.xr.menuPress('forward'), true`);
await until(`whitespace.xr.history.flying === false`, 3000);
await sleep(100);
ok(Math.abs((await far()) - beforeBack) < 0.5, "Forward returns to where you were at the object", { distance: await far(), beforeBack });
await ev(`window.__xrDevice.controllers.left.updateButtonValue('y-button', 1), true`);
await sleep(300);
await ev(`window.__xrDevice.controllers.left.updateButtonValue('y-button', 0), true`);
await until(`whitespace.xr.history.flying === false`, 3000);
await sleep(100);
ok((await far()) > beforeBack + 5, "Y is Back too", { distance: await far(), history: await ev(`whitespace.xr.history`) });
await ev(`whitespace.xr.menuPress('home'), true`);
await until(`whitespace.xr.history.flying === false`, 3000);
ok((await ev(`whitespace.xr.history.back`)) >= 1, "See all flies out (and can be undone)", await ev(`whitespace.xr.history`));

// ---- a guided tour, from the wrist menu: the first stop flies you there with its narration on the panel; Next stop goes on
await ev(`whitespace.xr.menuPress('tour'), true`);
ok(await until(`whitespace.xr.panel?.id === 'intro' && whitespace.xr.panel.buttons.includes('tournext')`, 5000), "Tour (wrist menu) opens the first stop, with Next stop", await ev(`whitespace.xr.panel`));
await ev(`whitespace.xr.press('tournext'), true`);
ok(await until(`whitespace.xr.panel?.id === 'logistic'`, 5000), "Next stop goes on to the second", await ev(`whitespace.xr.panel`));
await ev(`whitespace.xr.press('close'), true`);
ok(await until(`whitespace.xr.panel === null`, 3000), "Close ends the tour's panel");

// ---- A closes the panel; Exit VR puts the camera back
await ev(aim("logistic"));
await ev(`window.__xrDevice.controllers.right.updateButtonValue('trigger', 1), true`);
await sleep(200);
await ev(`window.__xrDevice.controllers.right.updateButtonValue('trigger', 0), true`);
await until(`whitespace.xr.panel?.id === 'logistic'`, 5000);
await ev(`window.__xrDevice.controllers.right.updateButtonValue('a-button', 1), true`);
await sleep(300);
await ev(`window.__xrDevice.controllers.right.updateButtonValue('a-button', 0), true`);
ok(await until(`whitespace.xr.panel === null`, 3000), "A closes the panel");
await ev(`whitespace.xr.menuPress('exit'), true`);
ok(await until(`!whitespace.xr.presenting`), "Exit VR (wrist menu) leaves");
const camAfter = await ev(`whitespace.camera.position.toArray().map((x) => +x.toFixed(3))`);
ok(JSON.stringify(camAfter) === JSON.stringify(camBefore), "the camera is back where it was", [camBefore, camAfter]);
// ---- AR: the space in the room (no background, so passthrough shows), and the background back afterwards
ok(await until(`!document.querySelector('#ar').hidden`), "Enter AR is offered");
await ev(`document.querySelector('#ar').click(), true`);
ok(await until(`whitespace.xr.presenting && whitespace.xr.mode === 'immersive-ar'`), "in AR");
ok((await ev(`whitespace.camera.parent.parent.background === null`)) === true, "AR has no background (the room shows)");
await ev(`document.querySelector('#ar').click(), true`);
ok(await until(`!whitespace.xr.presenting`), "Exit AR leaves");
ok((await ev(`whitespace.camera.parent.parent.background !== null`)) === true, "and the background is back");
ok(errors.length === 0, "no page errors", errors.slice(0, 3));
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
