// Your own files in 3D, end to end in headless Chromium against the built site: a folder made in the workspace
// (two Python files, one importing the other; a Sage file in a subfolder; a notebook), the file browser's ⋯ on it,
// Open in 3D; the space shows the folder as a room (its files, the subfolder, the import as an arrow); a Python file
// is entered (its text read from the workspace through the page), and the notebook (its cells, linked by the names
// that flow between them, with their outputs); a file outside the folder is refused; Close.
//   (after a site build: space/build-alpha.sh, or bun web/build.ts and node build.mjs --site ../web/dist)
//   node space/test-own-files.mjs [screenshot-prefix]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const out = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, msg, detail) => {
  console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 300) : ""));
  if (!c) failures++;
};
const port = 8700 + Math.floor(Math.random() * 500);
const server = spawn("python3", [join(here, "..", "web", "serve.py"), String(port)], { stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "space-own-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1400,900", "about:blank"], { stdio: "ignore" });
process.on("exit", () => { chrome.kill("SIGKILL"); server.kill("SIGKILL"); });
let cdpPort;
for (let i = 0; i < 200 && !cdpPort; i++) { try { cdpPort = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch {} await sleep(100); }
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map(), errors = [], contexts = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.executionContextCreated") contexts.push(m.params.context);
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
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
ok(await until(`!!window.sagebrush?.workspace`, 30000), "the notebook page has its workspace");

// ---- the folder
const NB = { mode: "python", cells: [
  { id: "t1", type: "markdown", code: "# A small notebook\nTwo numbers and their product." },
  { id: "c1", code: "x = 2\ny = 3", outputs: [] },
  { id: "c2", code: "z = x * y\nprint(z)", outputs: [{ output_type: "stream", name: "stdout", text: "6\n" }] },
  { id: "c3", code: "import math\nprint(math.pi)", outputs: [] },
] };
const seeded = await ev(`(async () => {
  const w = window.sagebrush.workspace;
  await w.mkdir("/proj/sub");
  await w.create("/proj/b.py", { content: "def f(x):\\n    \\"\\"\\"One more than x.\\"\\"\\"\\n    return x + 1\\n" });
  await w.create("/proj/a.py", { content: "from b import f\\n\\n\\ndef g():\\n    return f(2)\\n\\n\\nprint(g())\\n" });
  await w.create("/proj/sub/c.sage", { content: "R.<t> = QQ[]\\nprint(t^2 + 1)\\n" });
  await w.create("/proj/demo.ipynb", { content: ${JSON.stringify(NB)}, mode: "python" });
  await w.create("/outside.py", { content: "secret = 1\\n" });
  return (await w.list("/proj", { recursive: true })).map((e) => e.path).sort();
})()`);
ok(Array.isArray(seeded) && seeded.includes("/proj/demo.ipynb") && seeded.includes("/proj/sub/c.sage"), "the folder is made", seeded);

// ---- the file browser (Files): the folder's ⋯, Open in 3D
await until(`!!document.querySelector("#wsfilesbtn") && !document.querySelector("#wsfilesbtn").hidden`, 30000);
if (await ev(`document.querySelector('#wssidebar').hidden`)) await ev(`document.querySelector("#wsfilesbtn").click(), true`);
await until(`!!document.querySelector('#wssidebar .frow[data-path="/proj"]')`, 10000);
const opened = await ev(`(async () => {
  const row = document.querySelector('#wssidebar .frow[data-path="/proj"]');
  if (!row) return "no row";
  const more = [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === "⋯");
  if (!more) return "no ⋯";
  more.click();
  await new Promise((r) => setTimeout(r, 300));
  const item = [...document.querySelectorAll(".sbfmenu button")].find((b) => b.textContent.trim() === "Open in 3D");
  if (!item) return "no item";
  item.click();
  return "clicked";
})()`);
ok(opened === "clicked", "the folder's ⋯ has Open in 3D", opened);
const F = `document.querySelector('iframe[src*="/space/"]')?.contentWindow`;
ok(await until(`(${F})?.whitespace?.space?.nodes?.length >= 4`, 20000), "the space shows the folder");
const top = await ev(`(() => { const W = ${F}.whitespace; return { room: W.room, ids: W.space.nodes.map((n) => n.id).sort(), edges: W.space.edges.map((e) => e.from + ">" + e.to), title: W.space.title }; })()`);
ok(["d:sub", "p:a.py", "p:b.py", "p:demo.ipynb"].every((x) => top.ids.includes(x)) && !top.ids.some((x) => x.includes("outside")), "its files, its subfolder and its notebook, nothing from outside it", top.ids);
ok(top.edges.includes("p:a.py>p:b.py"), "a.py's import of b is an arrow", top.edges);
await sleep(800);
await shot("top");

// ---- a Python file: entered, its text read from the workspace through the page
ok(await ev(`${F}.whitespace.enter('p:a.py')`), "a.py is entered");
const fileRoom = await ev(`(() => { const W = ${F}.whitespace; return { room: W.room, ids: W.space.nodes.map((n) => n.id), edges: W.space.edges.map((e) => e.from + ">" + e.to) }; })()`);
ok(fileRoom.room === "proj › a.py" && fileRoom.ids.includes("f:g") && fileRoom.ids.includes("m:b"), "its room: g, the import of b", fileRoom);
ok(fileRoom.edges.includes("f:g>m:b"), "g's call of f is an arrow to the import", fileRoom.edges);
ok(await ev(`${F}.whitespace.enter('m:b')`) && await until(`${F}.whitespace.room === 'proj › a.py › b.py' && ${F}.whitespace.selection?.id === 'f:f'`, 8000), "the import leads through to b.py, at f", await ev(`${F}.whitespace.room`));
ok((await ev(`${F}.whitespace.space.nodes.find((n) => n.id === 'f:f')?.summary`)) === "One more than x.", "f's docstring is its summary");
await ev(`(() => { ${F}.whitespace.leave(); ${F}.whitespace.leave(); return 1; })()`);
ok(await until(`${F}.whitespace.room === null`, 5000), "and Back out to the folder");

// ---- the notebook: its cells and what flows between them
ok(await ev(`${F}.whitespace.enter('p:demo.ipynb')`), "the notebook is entered");
const nb = await ev(`(() => { const W = ${F}.whitespace; return { room: W.room, nodes: W.space.nodes.map((n) => [n.id, n.kind, n.title, n.output ?? null]), edges: W.space.edges.map((e) => e.from + ">" + e.to + ":" + (e.vars ?? [e.kind]).join(",")) }; })()`);
ok(nb.room === "proj › demo.ipynb", "its room", nb.room);
ok(nb.edges.includes("cell:c1>cell:c2:x,y"), "the cell defining x and y leads to the cell that reads them", nb.edges);
ok(nb.nodes.some(([i, , , o]) => i === "cell:c2" && o === "6"), "a cell's output, as the notebook showed it", nb.nodes);
ok(nb.edges.includes("cell:t1>cell:c1:explains"), "the text cell stands by the cell after it", nb.edges);
await ev(`${F}.whitespace.select('cell:c2')`);
await sleep(1200);
const drawer = await ev(`${F}.document.querySelector('#overlay')?.innerText ?? ''`);
ok(/Output, as the notebook last showed it/i.test(drawer) && /Uses names from/i.test(drawer) && /\b6\b/.test(drawer) && !/▶ Run/.test(drawer), "its drawer: the code and its output, no Run", drawer.slice(0, 200));
await shot("notebook");

// ---- only the folder's files are read
const refused = await ev(`new Promise((res) => { const w = ${F}; const h = (e) => { if (e.data?.sagebrush === "space-file" && e.data.id === 9999) { w.removeEventListener("message", h); res(e.data.error ?? "read!"); } };
  w.addEventListener("message", h); w.parent.postMessage({ sagebrush: "space-read", version: 1, id: 9999, path: "../outside.py" }, location.origin);
  setTimeout(() => res("no answer"), 3000); })`);
ok(refused === "no answer", "a read asked from outside the frame isn't answered", refused);
// (from inside the frame itself, as the viewer would ask: in the frame's own context)
const frameCtx = contexts.filter((c) => c.auxData?.isDefault && /\/space\//.test(c.origin + (c.name ?? "")) || (c.auxData?.isDefault && c.auxData?.frameId && c.auxData.frameId !== contexts[0]?.auxData?.frameId)).at(-1);
const r2 = await send("Runtime.evaluate", { contextId: frameCtx?.id, awaitPromise: true, returnByValue: true, expression: `new Promise((res) => { const h = (e) => { if (e.data?.sagebrush === "space-file" && e.data.id === 9998) { removeEventListener("message", h); res(e.data.error ?? "read!"); } };
  addEventListener("message", h); window.parent.postMessage({ sagebrush: "space-read", version: 1, id: 9998, path: "../outside.py" }, location.origin);
  setTimeout(() => res("no answer"), 3000); })` });
const refused2 = r2.result?.result?.value;
ok(/not a file of this folder/.test(refused2), "the frame's read of a file outside the folder is refused", refused2);

// ---- Close
await ev(`[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Close") && b.closest("[role=dialog]"))?.click(), true`);
ok(await until(`!document.querySelector('iframe[src*="/space/"]')`, 3000), "Close takes the 3D view away");
ok(errors.length === 0, "no page errors", errors.slice(0, 3));
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
