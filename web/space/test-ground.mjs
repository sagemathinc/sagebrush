// ci: web-browser/space order=10 chrome
// The ground (src/ground.ts), in headless Chromium against the built site: a room stands on the floor as a grandstand:
// every object on its post above what is under it, none overlapping; W walks up its stairs; a terrace's side stops you;
// going to an object you stand in front of it, on the ground; Float lifts the space into the air and Ground brings it back.
//   (after a site build: space/build-alpha.sh, or node build.mjs --site ../web/dist)   node space/test-ground.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 300) : "")); if (!c) failures++; };
const port = 8500 + Math.floor(Math.random() * 90);
const server = spawn("python3", [join(here, "..", "serve.py"), String(port)], { stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "space-ground-"));
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
// (a room of a whole repository: this checkout's files, as a space's tree carries them (paths and lengths), and links
//  between the first files of the top-level folders, so the room has links to draw)
const files = execFileSync("git", ["ls-files"], { cwd: join(here, "..", ".."), encoding: "utf8" }).split("\n").filter(Boolean)
  .map((p) => [p, Math.max(1, Math.round(statSync(join(here, "..", "..", p), { throwIfNoEntry: false })?.size / 40) || 1)]);
const firsts = [...new Map(files.map(([p], k) => [p.split("/")[0], k])).values()].slice(0, 12);
const tree = { name: "sagebrush", commit: "", base: "/", files, imports: firsts.slice(1).map((k, i) => [firsts[i], k]) };
await send("Page.navigate", { url: `http://127.0.0.1:${port}/space/?space=intro.space.json` });
ok(await until(`/objects/.test(document.querySelector('[data-c="status"]')?.textContent ?? '')`, 30000), "the space loads");
await ev(`space3d.load(${JSON.stringify({ format: "sagebrush-space", version: 1, title: "sagebrush", tree })}, "sagebrush.space.json").then(() => true)`);
ok(await until(`space3d.space?.room?.kind === "dir"`, 30000), "a repository's tree: its top folder's room");
await sleep(1200);
ok(await ev(`space3d.grounded && space3d.terraces > 0 && space3d.floorY === 0`), "a room is on the ground, with terraces", { t: await ev(`space3d.terraces`) });
// (each object: above what is under it, on its post; no two in the same place)
const geo = await ev(`space3d.objects.map((o) => { const b = new o.constructor().copy ? null : null; const s = o.children[0].geometry.parameters; return [o.position.x, o.position.y, o.position.z, s.width, s.height, space3d.groundAt(o.position.x, o.position.z), o.userData.post[0].visible]; })`);
ok(geo.every(([, y, , , h, g]) => y - h / 2 >= g + 0.5), "every object stands clear of the ground under it");
ok(geo.every(([, y, , , h, g, post]) => post || y - h / 2 - g <= 0.3), "and on its post");
const overlap = geo.some((a, i) => geo.some((b, j) => j > i && Math.abs(a[0] - b[0]) < (a[3] + b[3]) / 2 - 0.05 && Math.abs(a[1] - b[1]) < (a[4] + b[4]) / 2 - 0.05 && Math.abs(a[2] - b[2]) < 0.5));
ok(!overlap, "no two objects overlap");
// (the links on the floor: every point of their ribbons on the ground, at most a step above it)
const off = await ev(`(() => { const f = space3d.floorLinks, a = f.geometry.attributes.position; let lo = Infinity, hi = -Infinity; for (let k = 0; k < a.count; k += 7) { const d = a.getY(k) - space3d.groundAt(a.getX(k), a.getZ(k)); lo = Math.min(lo, d); hi = Math.max(hi, d); } return [f.visible, lo, hi]; })()`);
ok(off[0] && off[1] > -0.01 && off[2] < 1.2, "the links run along the floor", off);
if (!(await ev(`space3d.walking`))) { await key("g"); await key("g", false); }
ok(await ev(`space3d.walking`), "walking");
// (in front of the main stand, facing it: W walks up its stairs)
const front = await ev(`(() => { const zs = space3d.objects.map((o) => o.position.z); return Math.max(...zs); })()`);
const cx = await ev(`(() => { const o = space3d.objects.filter((o) => Math.abs(o.position.z - ${front}) < 0.1 && space3d.groundAt(o.position.x, o.position.z - 5) > 0.5); return o.length ? o[0].position.x : 0; })()`);
const put = (x, z, tx, tz) => ev(`(() => { const c = space3d.camera, t = space3d.controls.target; c.position.set(${x}, 8, ${z}); t.set(${tx}, 8, ${tz}); return true; })()`);
await put(cx + 0.7, front + 4, cx + 0.7, front - 20);
await sleep(300);
// (held until you are up, or 20 s: a headless browser draws few frames a second)
await key("w"); await until(`space3d.feet > 4`, 20000); await key("w", false);
await sleep(500);
const climbed = await ev(`space3d.feet`), gHere = await ev(`space3d.groundAt(space3d.camera.position.x, space3d.camera.position.z)`);
ok(climbed > 4 && Math.abs(climbed - gHere) < 0.05, "W walks up the stairs, standing on them", { climbed, gHere });
// (beside a high terrace, at the stands' left end, facing its side: you don't walk into it)
const side = await ev(`(() => { for (const z of [${front} - 30, ${front} - 20, ${front} - 12]) for (let x = -400; x < 400; x += 0.25) { const g = space3d.groundAt(x, z); if (g > 0) return g > 4 ? [x, z] : null; } return null; })()`);
if (side) {
  await put(side[0] - 6, side[1], side[0] + 20, side[1]);
  await sleep(1000);
  await key("w"); await sleep(4000); await key("w", false);
  await sleep(300);
  const p = await ev(`[space3d.camera.position.x, space3d.feet]`);
  ok(p[1] < 0.05 && p[0] < side[0], "a terrace's side stops you", { p, side });
} else ok(false, "found a terrace side to walk into");
// (going to an object on a high row: standing in front of it, on the ground there)
const high = await ev(`(() => { let best = null; for (const o of space3d.objects) if (!best || o.position.y > best.position.y) best = o; return best.userData.node.id; })()`);
await ev(`space3d.select(${JSON.stringify(high)})`);
await until(`space3d.feet > 2`, 10000);
await sleep(500);
const stand = await ev(`[space3d.feet, space3d.groundAt(space3d.camera.position.x, space3d.camera.position.z)]`);
ok(stand[1] > 2 && Math.abs(stand[0] - stand[1]) < 0.05, "going to an object on a high row: you stand on the ground in front of it", { stand });
await key("Escape"); await key("Escape", false);
// (Float, and Ground again)
await ev(`space3d.setGround(false)`);
ok(await until(`!space3d.grounded && !space3d.objects[0].userData.post[0].visible && space3d.floorY < 0`, 4000), "Float: the space in the air, without terraces or posts");
ok(await ev(`document.querySelector('[data-c="dims"]').textContent === 'Ground'`), "and the button says Ground");
await sleep(1500);
await ev(`space3d.setGround(true)`);
ok(await until(`space3d.grounded && space3d.floorY === 0 && space3d.objects.some((o) => o.userData.post[0].visible)`, 4000), "Ground: back on the ground");
// (a space that isn't a room: flat on the floor, no terraces)
await ev(`(() => { const s = document.querySelector('[data-c="space"]'); s.value = 'intro.space.json'; s.onchange(); return true; })()`);
ok(await until(`space3d.space?.title === ${JSON.stringify(JSON.parse(readFileSync(join(here, "examples", "intro.space.json"), "utf8")).title)} && space3d.terraces === 0`, 10000), "another space: flat on the floor");
ok(await ev(`space3d.objects.every((o) => o.position.y - o.children[0].geometry.parameters.height / 2 > 0.5)`), "everything above the floor");
// (a mound under an object placed high, with a slope up from its front: ground.js)
const { moundFor, supportAt } = await import("./src/ground.ts");
const mound = moundFor({ kind: "code", size: [4, 4, 0.2] }, [0, 10, 0]);
const at = (z) => supportAt(mound, 0, z);
ok(mound.length === 2 && Math.abs(at(-1) - 3) < 1e-9 && at(20) === 0 && at(5) > 0 && at(5) < 3 && at(4) > at(6), "an object placed high stands on a mound, with a slope up to it", mound);
ok(errors.length === 0, "no page errors", errors.slice(0, 3));
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
