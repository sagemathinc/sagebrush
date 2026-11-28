// ci: web-browser/space order=40 chrome
// Rooms for files of code, in headless Chromium against the built site, on the example project (web/space/examples/
// project, its space written by web/build.ts): folders entered in turn; a Python file's room (its classes, functions and
// imports, from a real parse) and a class's room (its methods); an import that leads to the file it names (Go there),
// relative and absolute; a JavaScript file's room and its relative import; a file too long to parse here isn't; the
// page's title says 3D view.
//   (after a site build: bun web/build.ts)   node web/space/test-rooms.mjs
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
const profile = mkdtempSync(join(tmpdir(), "space-rooms-"));
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

setTimeout(() => { console.log("FAIL the suite didn't end in 180 s"); process.exit(1); }, 180_000).unref();
await send("Runtime.enable");
await send("Page.navigate", { url: `http://127.0.0.1:${port}/space/?space=project.space.json` });
ok(await until(`space3d.space?.room?.kind === "dir"`, 30000), "the example project opens as its top folder's room");
const titles = () => ev(`space3d.space.nodes.map((n) => n.title)`);
const room = () => ev(`space3d.room`);
const enter = async (id) => { const r = await ev(`space3d.enter(${JSON.stringify(id)})`); await sleep(200); return r; };
const leave = () => ev(`space3d.leave()`);
const idOf = (pred) => ev(`space3d.space.nodes.find(${pred})?.id ?? null`);
ok(JSON.stringify(await titles()) === JSON.stringify(["geometry/", "web/", "main.py"]), "its folders and files", await titles());
ok(/3D view/.test(await ev(`document.title`)), "the page's title says 3D view", await ev(`document.title`));

// ---- a folder, a Python file, a class
ok(await enter("d:geometry") && (await room()) === "project › geometry/", "a folder is entered", await room());
ok(await enter("p:geometry/shapes.py") && (await room()) === "project › geometry/ › shapes.py", "a Python file is entered", await room());
const shapes = await titles();
ok(["class Circle", "class Square", "total_area(shapes)", "math"].every((t) => shapes.includes(t)), "its room: the classes, the function and the import, from a parse", shapes);
ok(await enter(await idOf(`(n) => n.title === "class Circle"`)), "a class is entered");
const circle = await titles();
ok(["area", "scaled", "__init__"].every((m) => circle.some((t) => t.startsWith(m))), "its room: its methods", circle);
ok((await leave()) && (await room()) === "project › geometry/ › shapes.py", "Back out of the class", await room());
// (Back to a room that has links: drawn again as it was, not refused: drawing it linked its objects to each other)
const linked = await ev(`({ ids: space3d.space.nodes.map((n) => n.id).sort().join(), edges: space3d.space.edges.length })`);
ok(linked.edges > 0, "the file's room has links", linked);
ok(await enter(await idOf(`(n) => n.title === "class Circle"`)) && (await leave()), "a class entered again, and left");
await sleep(300);
ok((await ev(`space3d.space.nodes.map((n) => n.id).sort().join()`)) === linked.ids && !/couldn't load/.test(await ev(`document.querySelector('[data-c="status"]').textContent`)), "Back to it shows it again", await ev(`document.querySelector('[data-c="status"]').textContent`));
// (Back checks the space it comes back to, as any space: one changed past the limits while you were in a room, through
//  the page's API, which hands out the live space, is refused, and you stay where you are)
const status = () => ev(`document.querySelector('[data-c="status"]').textContent`);
await ev(`(window.__outer = space3d.space, true)`);
const circleId = await idOf(`(n) => n.title === "class Circle"`);
ok(await enter(circleId), "a class entered, its file's space kept by the page");
await ev(`(window.__outer.nodes[0].deep = JSON.parse("[".repeat(30) + "]".repeat(30)), true)`);
await leave();
await sleep(300);
ok(/nested too deeply/.test(await status()) && (await room()) === "project › geometry/ › shapes.py › class Circle", "made too deep meanwhile: Back refuses it, and you stay in the class", [await status(), await room()]);
await ev(`(delete window.__outer.nodes[0].deep, window.__outer.nodes.push(...Array.from({ length: 4000 }, (_, i) => ({ id: "x" + i, kind: "note", title: "x" }))), true)`);
await leave();
await sleep(300);
ok(/more than 4000 objects/.test(await status()) && (await room()) === "project › geometry/ › shapes.py › class Circle", "given 4,000 objects more meanwhile: refused too", [await status(), await room()]);
await ev(`(window.__outer.nodes.length = 4, true)`);
ok((await leave()) && (await room()) === "project › geometry/ › shapes.py", "put right: Back takes you out", await room());
await sleep(300);
ok((await ev(`space3d.space.nodes.map((n) => n.id).sort().join()`)) === linked.ids, "and shows the file's room again");
ok((await leave()) && (await room()) === "project › geometry/", "Back out, room by room", await room());

// ---- an import leads to the file it names: relative (from .shapes) and absolute (geometry.report)
ok(await enter("p:geometry/report.py"), "another file");
const rel = await idOf(`(n) => n.kind === "import" && /shapes/.test(n.title)`);
ok(!!rel && await ev(`(() => { space3d.select(${JSON.stringify(rel)}); return /Go there/.test(document.querySelector('[data-c="overlay"] .enter')?.textContent ?? ''); })()`), "its relative import offers Go there", rel);
ok(await enter(rel) && /shapes\.py$/.test(await room()), "and goes through to that file's room", await room());
await leave(); await leave(); await leave();
ok((await room()) === null, "out to the top", await room());
ok(await enter("p:main.py"), "the top file");
const abs = await idOf(`(n) => n.kind === "import" && /geometry\.report/.test(n.title)`);
ok(!!abs && await enter(abs) && /report\.py$/.test(await room()), "an absolute import goes through to its file too", await room());
await leave(); await leave();

// ---- JavaScript: a file's room, and its relative import
ok(await enter("d:web") && await enter("p:web/chart.js"), "a JavaScript file is entered", await room());
const chart = await titles();
ok(chart.some((t) => /Chart/.test(t)), "its room: the class", chart);
const util = await idOf(`(n) => n.kind === "import" && /util/.test(n.title)`);
ok(!!util && await enter(util) && /util\.js$/.test(await room()), "its relative import goes through to util.js", await room());
const utilTitles = await titles();
ok(utilTitles.some((t) => t.startsWith("range")) && utilTitles.some((t) => t.startsWith("sum")), "whose room has its functions", utilTitles);

// ---- a file too long to parse here: not entered, and said
const long = { format: "sagebrush-space", version: 1, nodes: [{ id: "long", kind: "file", title: "long.py", path: "long.py", lang: "python", text: "x = 1\n".repeat(200000), lines: 200000 }] };
await ev(`space3d.load(${JSON.stringify(long)}, "long.space.json").then(() => true)`);
ok((await ev(`space3d.enter("long")`)) === false && /too long to enter/.test(await ev(`document.querySelector('[data-c="status"]').textContent`)), "a file of 1.2 MB isn't parsed: not entered, and said", await ev(`document.querySelector('[data-c="status"]').textContent`));

// ---- the parse cap is in bytes (UTF-8): 400,000 € in a comment are 1.2 MB, though fewer than 1 Mi characters
const euro = { format: "sagebrush-space", version: 1, nodes: [{ id: "euro", kind: "file", title: "euro.py", path: "euro.py", lang: "python", text: "# " + "€".repeat(400000) + "\nx = 1\n", lines: 2 }] };
await ev(`space3d.load(${JSON.stringify(euro)}, "euro.space.json").then(() => true)`);
ok((await ev(`space3d.enter("euro")`)) === false && /too long to enter/.test(await ev(`document.querySelector('[data-c="status"]').textContent`)), "a file of 1.2 MB in UTF-8 (400,000 characters) isn't parsed either", await ev(`document.querySelector('[data-c="status"]').textContent`));

// ---- the parse cap, exactly: 1 MiB in UTF-8 is parsed, one byte more isn't (a comment of € and a line of code)
const atCap = (pad) => ({ format: "sagebrush-space", version: 1, nodes: [{ id: "cap", kind: "file", title: "cap.py", path: "cap.py", lang: "python", text: "#" + "a".repeat(pad) + "€".repeat(349522) + "\nx = 1\n", lines: 2 }] });
await ev(`space3d.load(${JSON.stringify(atCap(2))}, "cap.space.json").then(() => true)`);
ok((await ev(`space3d.enter("cap")`)) === true, "a file of exactly 1 MiB in UTF-8 (1,048,576 bytes, mostly €) is entered", await ev(`document.querySelector('[data-c="status"]').textContent`));
await ev(`space3d.leave()`);
await ev(`space3d.load(${JSON.stringify(atCap(3))}, "cap1.space.json").then(() => true)`);
ok((await ev(`space3d.enter("cap")`)) === false && /too long to enter/.test(await ev(`document.querySelector('[data-c="status"]').textContent`)), "one byte more isn't", await ev(`document.querySelector('[data-c="status"]').textContent`));

// ---- the same cap for JavaScript, which has no preparser to catch a long file later: 1 MiB in UTF-8 exactly is
//      entered, one byte more isn't, nor a comment of 400,000 € (1.2 MB)
const jsFile = (id, text) => ({ format: "sagebrush-space", version: 1, nodes: [{ id, kind: "file", title: id + ".js", path: id + ".js", lang: "javascript", text, lines: 2 }] });
const jsAt = (extra) => { const tail = "\nfunction f() {}\n", euros = 349000; return "//" + "€".repeat(euros) + "a".repeat((1 << 20) - 2 - 3 * euros - tail.length + extra) + tail; };
ok(Buffer.byteLength(jsAt(0)) === 1 << 20 && Buffer.byteLength(jsAt(1)) === (1 << 20) + 1, "the JavaScript samples: 1,048,576 bytes, and one more");
await ev(`space3d.load(${JSON.stringify(jsFile("jscap", jsAt(0)))}, "jscap.space.json").then(() => true)`);
ok((await ev(`space3d.enter("jscap")`)) === true, "a JavaScript file of exactly 1 MiB in UTF-8 (mostly €) is entered", await ev(`document.querySelector('[data-c="status"]').textContent`));
await ev(`space3d.leave()`);
await ev(`space3d.load(${JSON.stringify(jsFile("jscap", jsAt(1)))}, "jscap1.space.json").then(() => true)`);
ok((await ev(`space3d.enter("jscap")`)) === false && /too long to enter/.test(await ev(`document.querySelector('[data-c="status"]').textContent`)), "one byte more isn't", await ev(`document.querySelector('[data-c="status"]').textContent`));
await ev(`space3d.load(${JSON.stringify(jsFile("jseuro", "//" + "€".repeat(400000) + "\nfunction f() {}\n"))}, "jseuro.space.json").then(() => true)`);
ok((await ev(`space3d.enter("jseuro")`)) === false && /too long to enter/.test(await ev(`document.querySelector('[data-c="status"]').textContent`)), "a JavaScript file of 400,000 € (1.2 MB, fewer characters) isn't either", await ev(`document.querySelector('[data-c="status"]').textContent`));

// ---- a room over the limits isn't laid out, whatever made it: a file of 4,001 functions
const many = { format: "sagebrush-space", version: 1, nodes: [{ id: "many", kind: "file", title: "many.py", path: "many.py", lang: "python", text: Array.from({ length: 4001 }, (_, i) => `def f${i}():\n    pass\n`).join(""), lines: 8002 }] };
await ev(`space3d.load(${JSON.stringify(many)}, "many.space.json").then(() => true)`);
ok((await ev(`space3d.enter("many")`)) === false && /more than 4000 objects/.test(await ev(`document.querySelector('[data-c="status"]').textContent`)), "a file of 4,001 functions: its room isn't laid out, and that is said", await ev(`document.querySelector('[data-c="status"]').textContent`));

ok(errors.length === 0, "no page errors", errors.slice(0, 3));
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
