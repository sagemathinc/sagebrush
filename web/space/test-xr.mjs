// ci: web-browser/space order=70 runner=bun chrome
// The 3D view in a headset, without one: Meta's WebXR emulator (IWER, a devDependency), an emulated Quest 3 with its
// controllers, installed in headless Chromium before the page runs. Enter VR is offered (and the headset's code is
// loaded) only where a headset is; in VR: the right controller pointed at an object and its trigger pulled (its
// reading panel opens; it is selected), Run on the panel, the thumbsticks (walk, turn), the wrist menu (Back, Forward,
// See all, Tour, Fly), A and Y, Exit VR (the camera back where it was); AR (no background, then the background back);
// rooms (a folder, a file, an import's Go there, Back out room by room); walking and flying. Without the emulator,
// neither button is offered and the headset's code isn't loaded.
//   (after a site build: bun web/build.ts)   CHROME=chromium bun web/space/test-xr.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 300) : "")); if (!c) failures++; };
setTimeout(() => { console.log("FAIL the suite didn't end in 300 s"); void finish(1); }, 300_000).unref();

// ---- the emulator, as one classic script that runs before the page's own (forceInstall: headless Chromium has a
//      navigator.xr of its own, with no device); built from a file beside this one, so 'iwer' resolves
const entry = join(here, `.test-xr-iwer-${process.pid}.js`);
writeFileSync(entry, "import { XRDevice, metaQuest3 } from 'iwer'; const d = new XRDevice(metaQuest3); d.installRuntime({ forceInstall: true }); window.__xrDevice = d;\n");
let iwer;
try {
  const r = await Bun.build({ entrypoints: [entry], target: "browser", format: "iife" });
  if (!r.success) throw new Error(r.logs.map(String).join("\n"));
  iwer = await r.outputs[0].text();
} finally { rmSync(entry, { force: true }); }

// ---- the site, as web/serve.py serves it
const port = 8300 + Math.floor(Math.random() * 90);
const server = spawn("python3", [join(here, "..", "serve.py"), String(port)], { stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "space-xr-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1400,900", "about:blank"], { stdio: "ignore" });
// (cleanup, bounded: Chrome is stopped and waited for (at most 5 s) before its profile is removed; the exit handler is
//  the last resort, for an exit that didn't come through finish)
const chromeGone = new Promise((r) => chrome.once("exit", r));
let cleaned = false;
const cleanup = async () => {
  if (cleaned) return;
  cleaned = true;
  chrome.kill("SIGKILL"); server.kill("SIGKILL");
  await Promise.race([chromeGone, sleep(5000)]);
  rmSync(profile, { recursive: true, force: true });
};
const finish = async (code) => { await cleanup().catch(() => {}); process.exit(code); };
process.on("exit", () => { chrome.kill("SIGKILL"); server.kill("SIGKILL"); if (!cleaned) try { rmSync(profile, { recursive: true, force: true }); } catch {} });
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
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, 15000);
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};
const until = async (expr, ms = 15000) => {
  for (const t = Date.now(); Date.now() - t < ms; ) { if (await ev(expr).catch(() => false)) return true; await sleep(150); }
  return false;
};
const status = `document.querySelector('[data-c="status"]')?.textContent ?? ''`;
const VR = `document.querySelector('[data-c="vr"]')`, AR = `document.querySelector('[data-c="ar"]')`;
await send("Runtime.enable");
await send("Page.enable");
const added = await send("Page.addScriptToEvaluateOnNewDocument", { source: iwer });
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `http://127.0.0.1:${port}/space/?space=intro.space.json` });
ok(await until(`/objects/.test(${status})`, 30000), "the space loads");
ok(await until(`!${VR}.hidden && !${AR}.hidden`), "Enter VR and Enter AR are offered (the headset can enter both)");

// ---- enter VR (first the page's opening view must be in place: it is framed over a few drawn frames, and headless
//      Chromium draws few; wait until the camera has moved and stopped)
const camNow = () => ev(`space3d.camera.position.toArray().map((x) => +x.toFixed(3))`);
let camBefore = await camNow();
for (const t = Date.now(); Date.now() - t < 15000; ) { await sleep(400); const c = await camNow(); if (JSON.stringify(c) === JSON.stringify(camBefore) && c.some((x) => x !== 0)) break; camBefore = c; }
await ev(`${VR}.click(), true`);
ok(await until(`space3d.xr.presenting`), "in VR");
ok((await ev(`${VR}.textContent`)) === "Exit VR", "the button says Exit VR");

// (a controller button is read once a drawn frame, and headless Chromium draws few: a press is held for 2 drawn frames
//  and then released for 2, never for a fixed time, so the page sees both the press and its release)
const frames = async (n, ms = 10000) => { const f0 = await ev(`space3d.frames`); return until(`space3d.frames >= ${f0 + n}`, ms); };
const tap = async (hand, button) => {
  await ev(`window.__xrDevice.controllers.${hand}.updateButtonValue('${button}', 1), true`); await frames(2);
  await ev(`window.__xrDevice.controllers.${hand}.updateButtonValue('${button}', 0), true`); await frames(2);
};
// (the right controller pointed at an object)
const aim = (target) => `(() => {
  const W = space3d, rig = W.xr.rig, V = rig.position.constructor, Q = rig.quaternion.constructor;
  const o = W.objects[W.space.nodes.findIndex((n) => n.id === ${JSON.stringify(target)})];
  const t = rig.worldToLocal(o.getWorldPosition(new V()));
  const c = window.__xrDevice.controllers.right;
  const from = new V(c.position.x, c.position.y, c.position.z);
  const q = new Q().setFromUnitVectors(new V(0, 0, -1), t.sub(from).normalize());
  c.quaternion.set(q.x, q.y, q.z, q.w);
  return true;
})()`;
await ev(aim("logistic"));
await frames(2);
await tap("right", "trigger");
ok(await until(`space3d.xr.panel?.id === 'logistic'`, 5000), "the trigger on an object opens its reading panel", await ev(`space3d.xr.panel`));
ok((await ev(`space3d.selection?.id`)) === "logistic", "and selects it, as a click does");
const headTo = (target) => `(() => { const W = space3d, V = W.camera.position.constructor;
  const o = W.objects[W.space.nodes.findIndex((n) => n.id === ${JSON.stringify(target)})];
  return +W.camera.getWorldPosition(new V()).distanceTo(o.getWorldPosition(new V())).toFixed(2); })()`;
ok(await until(`space3d.xr.history.flying === false && space3d.xr.history.back === 1`, 5000), "and you go there (one step to go back)", await ev(`space3d.xr.history`));
const near = await ev(headTo("logistic"));
ok(near > 4 && near < 14, "you end up in front of it, as on the desktop", { distance: near });

// ---- Run, from the panel (as its button does)
await ev(`space3d.xr.press('run'), true`);
ok(await until(`space3d.xr.panel?.state === 'done'`, 90000), "Run on the panel runs the object's code", await ev(`space3d.xr.panel`));

// ---- the thumbsticks: left forward moves; right sideways turns 30°
const rigBefore = await ev(`[...space3d.xr.rig.position.toArray(), space3d.xr.rig.rotation.y].map((x) => +x.toFixed(3))`);
await ev(`window.__xrDevice.controllers.left.updateAxes('thumbstick', 0, -1), true`);
await until(`Math.hypot(space3d.xr.rig.position.x - ${rigBefore[0]}, space3d.xr.rig.position.z - ${rigBefore[2]}) > 1`, 10000);
await ev(`window.__xrDevice.controllers.left.updateAxes('thumbstick', 0, 0), true`);
const rigMoved = await ev(`space3d.xr.rig.position.toArray().map((x) => +x.toFixed(3))`);
const moved = Math.hypot(rigMoved[0] - rigBefore[0], rigMoved[2] - rigBefore[2]);
ok(moved > 1, "the left thumbstick moves you", { moved: +moved.toFixed(2) });
await ev(`window.__xrDevice.controllers.right.updateAxes('thumbstick', 1, 0), true`);
await frames(2);
await ev(`window.__xrDevice.controllers.right.updateAxes('thumbstick', 0, 0), true`);
await frames(2);
const turned = (await ev(`space3d.xr.rig.rotation.y`)) - rigBefore[3];
ok(Math.abs(Math.abs(turned) - Math.PI / 6) < 1e-3, "the right thumbstick turns you 30°", { turned: +turned.toFixed(3) });

// ---- the wrist menu: Back goes back to where you were; Forward returns; Y is Back too; See all
const far = async () => ev(headTo("logistic"));
const beforeBack = await far();
await ev(`space3d.xr.menuPress('back'), true`);
await until(`${headTo("logistic")} > ${beforeBack + 3} && space3d.xr.history.flying === false`, 8000);
const afterBack = await far();
ok(afterBack > beforeBack + 3, "Back (wrist menu) takes you back to where you were before going to it", { afterBack, beforeBack });
await ev(`space3d.xr.menuPress('forward'), true`);
await until(`Math.abs(${headTo("logistic")} - ${beforeBack}) < 0.5 && space3d.xr.history.flying === false`, 8000);
ok(Math.abs((await far()) - beforeBack) < 0.5, "Forward returns to where you were at the object", { distance: await far(), beforeBack });
await tap("left", "y-button");
await until(`${headTo("logistic")} > ${beforeBack + 3} && space3d.xr.history.flying === false`, 8000);
ok((await far()) > beforeBack + 3, "Y is Back too", { distance: await far(), history: await ev(`space3d.xr.history`) });
await ev(`space3d.xr.menuPress('home'), true`);
await until(`space3d.xr.history.flying === false`, 3000);
ok((await ev(`space3d.xr.history.back`)) >= 1, "See all goes out (and can be undone)", await ev(`space3d.xr.history`));

// ---- a guided tour, from the wrist menu: the first stop with its narration on the panel; Next stop goes on
await ev(`space3d.xr.menuPress('tour'), true`);
ok(await until(`space3d.xr.panel?.id === 'intro' && space3d.xr.panel.buttons.includes('tournext')`, 5000), "Tour (wrist menu) opens the first stop, with Next stop", await ev(`space3d.xr.panel`));
await ev(`space3d.xr.press('tournext'), true`);
ok(await until(`space3d.xr.panel?.id === 'logistic'`, 5000), "Next stop goes on to the second", await ev(`space3d.xr.panel`));
await ev(`space3d.xr.press('close'), true`);
ok(await until(`space3d.xr.panel === null`, 3000), "Close ends the tour's panel");

// ---- A closes the panel; Exit VR puts the camera back
await ev(aim("logistic"));
await frames(2);
await tap("right", "trigger");
await until(`space3d.xr.panel?.id === 'logistic'`, 5000);
await tap("right", "a-button");
ok(await until(`space3d.xr.panel === null`, 3000), "A closes the panel");
await ev(`space3d.xr.menuPress('exit'), true`);
ok(await until(`!space3d.xr.presenting`), "Exit VR (wrist menu) leaves");
await until(`JSON.stringify(space3d.camera.position.toArray().map((x) => +x.toFixed(3))) === ${JSON.stringify(JSON.stringify(camBefore))}`, 5000);
ok(JSON.stringify(await camNow()) === JSON.stringify(camBefore), "the camera is back where it was", [camBefore, await camNow()]);
ok((await ev(`${VR}.textContent`)) === "Enter VR", "and the button says Enter VR again");

// ---- AR: the space in the room (no background, so passthrough shows), and the background back afterwards
await ev(`${AR}.click(), true`);
ok(await until(`space3d.xr.presenting && space3d.xr.mode === 'immersive-ar'`), "in AR");
ok((await ev(`space3d.camera.parent.parent.background === null`)) === true, "AR has no background (the room shows)");
await ev(`${AR}.click(), true`);
ok(await until(`!space3d.xr.presenting`), "Exit AR leaves");
ok((await ev(`space3d.camera.parent.parent.background !== null`)) === true, "and the background is back");

// ---- walking (the default): a step to the floor puts your feet on it; the right thumbstick doesn't lift you; Fly does
await ev(`${VR}.click(), true`);
ok(await until(`space3d.xr.presenting`), "in VR again");
ok(await ev(`space3d.xr.walking`), "walking is the default");
const floorY = await ev(`space3d.floorY`);
await ev(`space3d.xr.teleport(space3d.xr.rig.position.x + 20, space3d.xr.rig.position.z + 5), true`);
ok(await until(`space3d.xr.history.flying === false`, 3000) && Math.abs((await ev(`space3d.xr.rig.position.y`)) - (await ev(`space3d.groundAt(space3d.xr.rig.position.x, space3d.xr.rig.position.z)`))) < 1e-3, "a step to the floor puts your feet on it", { y: await ev(`space3d.xr.rig.position.y`), floorY });
const y0 = await ev(`space3d.xr.rig.position.y`);
await ev(`window.__xrDevice.controllers.right.updateAxes('thumbstick', 0, -1), true`);
await frames(4);
await ev(`window.__xrDevice.controllers.right.updateAxes('thumbstick', 0, 0), true`);
ok(Math.abs((await ev(`space3d.xr.rig.position.y`)) - y0) < 1e-6, "walking: the right thumbstick doesn't lift you off the floor");
await ev(`space3d.xr.menuPress('fly'), true`);
ok((await ev(`space3d.xr.walking`)) === false, "Fly (wrist menu) turns flying on");
await ev(`window.__xrDevice.controllers.right.updateAxes('thumbstick', 0, -1), true`);
await until(`space3d.xr.rig.position.y > ${y0 + 1}`, 10000);
await ev(`window.__xrDevice.controllers.right.updateAxes('thumbstick', 0, 0), true`);
ok((await ev(`space3d.xr.rig.position.y`)) > y0 + 1, "flying: the right thumbstick lifts you");
await ev(`space3d.xr.menuPress('fly'), true`);
await until(`space3d.xr.history.flying === false`, 3000);
await ev(`space3d.xr.menuPress('exit'), true`);
ok(await until(`!space3d.xr.presenting`), "and Exit VR");

// ---- rooms in a headset: the example project; a folder's panel offers Enter; a file in it, and its relative import's
//      Go there; Back (wrist menu) brings you out room by room, to the top
await send("Page.navigate", { url: `http://127.0.0.1:${port}/space/?space=project.space.json` });
ok(await until(`space3d.space?.room?.kind === "dir" && !${VR}.hidden`, 30000), "the example project loads");
await sleep(1500);
await ev(`${VR}.click(), true`);
ok(await until(`space3d.xr.presenting`), "in VR, in the project");
await ev(aim("d:geometry"));
await frames(2);
await tap("right", "trigger");
ok(await until(`space3d.xr.panel?.id === 'd:geometry' && space3d.xr.panel.buttons.includes('enter')`, 5000), "a folder's panel offers Enter", await ev(`space3d.xr.panel`));
await until(`space3d.xr.history.flying === false`, 3000);
const levels = [];
const boundary = async () => levels.push({ room: await ev(`space3d.room`), pos: await ev(`space3d.xr.rig.position.toArray().map((x) => +x.toFixed(2))`) });
await boundary();
await ev(`space3d.xr.press('enter'), true`);
ok(await until(`space3d.room === 'project › geometry/' && space3d.xr.panel === null`, 8000), "Enter puts you in its room", { room: await ev(`space3d.room`) });
await until(`space3d.xr.history.flying === false`, 3000);
await ev(`(() => { space3d.xr.open(space3d.space.nodes.find((n) => n.id === 'p:geometry/report.py')); return true; })()`);
ok(await until(`(space3d.xr.panel?.buttons ?? []).includes('enter')`, 8000), "a Python file's panel offers Enter", await ev(`space3d.xr.panel`));
await until(`space3d.xr.history.flying === false`, 3000);
await boundary();
await ev(`space3d.xr.press('enter'), true`);
ok(await until(`space3d.room === 'project › geometry/ › report.py'`, 10000), "Enter parses the file into its room", { room: await ev(`space3d.room`), status: await ev(status) });
const rel = await ev(`space3d.space.nodes.find((n) => n.kind === "import" && /shapes/.test(n.title))?.id ?? null`);
await until(`space3d.xr.history.flying === false`, 3000);
await ev(`(() => { space3d.xr.open(space3d.space.nodes.find((n) => n.id === ${JSON.stringify(rel)})); return true; })()`);
ok(!!rel && await until(`(space3d.xr.panel?.buttons ?? []).includes('enter')`, 5000), "its relative import's panel offers Go there", await ev(`space3d.xr.panel`));
await until(`space3d.xr.history.flying === false`, 3000);
await boundary();
await ev(`space3d.xr.press('enter'), true`);
ok(await until(`/shapes\\.py$/.test(space3d.room ?? '')`, 10000), "Go there leads to the imported file", { room: await ev(`space3d.room`) });
// (Back out, room by room: moves made inside a room are undone first; then Back leaves exactly the room you are in, to
//  where you stood when you entered it (never to the view of everything, nor to a place in another room))
ok(levels.length === 3, "three rooms were entered", levels.map((l) => l.room));
for (const want of levels.slice().reverse()) {
  const from = await ev(`space3d.room`);
  for (let i = 0; i < 4 && (await ev(`space3d.room`)) === from; i++) {
    await until(`space3d.xr.history.flying === false`, 3000);
    await ev(`space3d.xr.menuPress('back'), true`);
    await sleep(300);
  }
  await until(`space3d.xr.history.flying === false`, 5000);
  const got = { room: await ev(`space3d.room`), pos: await ev(`space3d.xr.rig.position.toArray().map((x) => +x.toFixed(2))`) };
  const d = Math.hypot(...got.pos.map((x, k) => x - want.pos[k]));
  ok(got.room === want.room && d < 0.05, `Back leaves ${from} for ${want.room ?? "the top"}, to where you stood when you entered`, { got, want: want.pos });
}
ok((await ev(`space3d.room`)) === null && (await ev(`space3d.space.nodes.some((n) => n.id === 'd:geometry')`)), "Back (wrist menu) brings you out room by room, to the top", { room: await ev(`space3d.room`) });
// (a notebook's panel doesn't fetch it, as the drawer doesn't: a notebook is read only when entered)
await ev(`space3d.load({ format: "sagebrush-space", version: 1, nodes: [{ id: "nb", kind: "file", doc: "notebook", title: "nb.ipynb", path: "nb.ipynb", src: "/space/nb-probe.ipynb" }, { id: "f", kind: "file", title: "f.py", path: "f.py", src: "/space/f-probe.py" }] }, "nb.space.json").then(() => true)`);
await sleep(500);
await ev(`(space3d.xr.open(space3d.space.nodes.find((n) => n.id === "nb")), space3d.xr.open(space3d.space.nodes.find((n) => n.id === "f")), true)`);
await sleep(1500);
const probes = await ev(`performance.getEntriesByType("resource").map((r) => r.name).filter((n) => /-probe\./.test(n))`);
ok(!probes.some((n) => n.includes("nb-probe")) && probes.some((n) => n.includes("f-probe")), "a notebook's panel doesn't fetch it; a file's does", probes);
await ev(`space3d.xr.menuPress('exit'), true`);
ok(await until(`!space3d.xr.presenting`), "and Exit VR leaves");
ok(errors.length === 0, "no page errors", errors.slice(0, 3));

// ---- starting a session: no floor reference space, no reference space at all, and a session ended while starting.
//      Each wraps the next granted session's requestReferenceSpace; a failure leaves the page as it was, never presenting
const startWith = (how, button = "vr") => ev(`(() => {
  const nx = navigator.xr, real = nx.requestSession.bind(nx);
  window.__sess = null;
  nx.requestSession = async (...a) => {
    nx.requestSession = real;
    const s = await real(...a), rrs = s.requestReferenceSpace.bind(s);
    window.__sess = { ended: false, ends: 0 }; s.addEventListener("end", () => (window.__sess.ended = true));
    const end = s.end.bind(s); s.end = () => { window.__sess.ends++; return end(); };
    s.requestReferenceSpace = (type) => {
      if (${JSON.stringify(how)} === "no-floor" && type === "local-floor") return Promise.reject(new DOMException("no floor", "NotSupportedError"));
      if (${JSON.stringify(how)} === "none") return Promise.reject(new DOMException("none", "NotSupportedError"));
      if (${JSON.stringify(how)} === "end") { void s.end(); return Promise.reject(new DOMException("ended", "InvalidStateError")); }
      return rrs(type);
    };
    return s;
  };
  document.querySelector('[data-c="${button}"]').click();
  return true;
})()`);
const restored = `!space3d.xr.presenting && space3d.controls.enabled && ${VR}.textContent === "Enter VR"`;
// (the head's height above the ground under it, in metres: after a step onto the floor, and after flying then walking
//  again, the same with or without a floor reference space)
const headHeight = `(() => { const V = space3d.camera.position.constructor, h = space3d.camera.getWorldPosition(new V()); return +((h.y - space3d.floorY) / 5).toFixed(2); })()`;
const heights = async () => {
  await ev(`(space3d.xr.setWalk(true), true)`);
  await ev(`(() => { const p = space3d.xr.rig.position; space3d.xr.teleport(p.x + 4, p.z); return true; })()`);
  await until(`space3d.xr.history.flying === false`, 5000); await frames(3);
  const step = await ev(headHeight);
  await ev(`(space3d.xr.setWalk(false), true)`); await frames(2);
  await ev(`(space3d.xr.setWalk(true), true)`);
  await until(`space3d.xr.history.flying === false`, 5000); await frames(3);
  return { step, walkAgain: await ev(headHeight) };
};
await startWith("ok");
ok(await until(`space3d.xr.presenting`, 8000), "in VR, with the floor space");
const withFloor = await heights();
await ev(`space3d.xr.menuPress('exit'), true`);
await until(restored, 5000);
await startWith("no-floor");
ok(await until(`space3d.xr.presenting`, 8000), "a headset without a floor reference space still enters (the local space, the floor an eye's height below)");
const noFloor = await heights();
ok(withFloor.step > 1 && Math.abs(noFloor.step - withFloor.step) < 0.1 && Math.abs(noFloor.walkAgain - withFloor.walkAgain) < 0.1, "without a floor space, the head stands as high above the floor as with one: after a step, and after walking again", { withFloor, noFloor });
await ev(`space3d.xr.menuPress('exit'), true`);
ok(await until(restored, 5000), "and leaves");
const cam0 = await ev(`space3d.camera.position.toArray().map((x) => +x.toFixed(2))`);
await startWith("none");
ok(await until(`window.__sess?.ended === true`, 8000) && await until(restored, 5000), "with no reference space at all: the session is ended, never presenting, the page as it was", { sess: await ev(`window.__sess`), status: await ev(status) });
ok(/couldn't start/.test(await ev(status)), "and it says it couldn't start", await ev(status));
ok(JSON.stringify(await ev(`space3d.camera.position.toArray().map((x) => +x.toFixed(2))`)) === JSON.stringify(cam0), "the camera is where it was");
// (AR, failing while it starts: the background it cleared comes back, the controls work again, and the session is
//  ended once)
await startWith("none", "ar");
ok(await until(`window.__sess?.ended === true`, 8000) && await until(`!space3d.xr.presenting && space3d.controls.enabled && ${AR}.textContent === "Enter AR"`, 5000), "AR failing while it starts: never presenting, the controls back", { sess: await ev(`window.__sess`), status: await ev(status) });
ok((await ev(`space3d.camera.parent.parent.isScene === true && space3d.camera.parent.parent.background !== null && window.__sess.ends === 1`)) === true, "its background is back, and the session was ended once", await ev(`({ scene: space3d.camera.parent.parent?.isScene, bg: space3d.camera.parent.parent?.background !== null, ends: window.__sess.ends })`));
await startWith("end");
ok(await until(`window.__sess?.ended === true`, 8000) && await until(restored, 5000), "a session that ends while starting: never presenting, the page as it was", { sess: await ev(`window.__sess`), status: await ev(status) });
await sleep(500);
ok(!(await ev(`space3d.xr.presenting`)), "and it stays not presenting");
await startWith("ok");
ok(await until(`space3d.xr.presenting`, 8000), "and the next Enter VR works");
await ev(`space3d.xr.menuPress('exit'), true`);
ok(await until(restored, 5000), "and leaves");
ok(errors.length === 0, "no page errors", errors.slice(0, 3));

// ---- without a headset: neither button is offered, and the headset's code isn't loaded
await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: added.result.identifier });
await send("Page.navigate", { url: `http://127.0.0.1:${port}/space/?space=intro.space.json` });
ok(await until(`/objects/.test(${status})`, 30000), "the space loads without the emulator");
await sleep(1500);
ok((await ev(`${VR}.hidden && ${AR}.hidden`)) === true, "without a headset, neither Enter VR nor Enter AR is offered");
ok((await ev(`performance.getEntriesByType("resource").filter((r) => /\\/chunks\\/xr-[^/]*\\.js$/.test(r.name)).length`)) === 0, "and the headset's code isn't loaded");
console.log(failures ? `${failures} FAILED` : "all passed");
await finish(failures ? 1 : 0);
