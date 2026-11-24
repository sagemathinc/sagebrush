// ci: web-browser/space order=50 chrome
// Your own files in the 3D view, end to end in headless Chromium against the built site, reached by DEV's name (the
// browser maps dev.sagebrush.space to this machine), where its hooks are offered: a folder made in the workspace (two Python files, one importing the other; a Sage file
// in a subfolder; a notebook; two JavaScript files), the file browser's ⋯ on it, Open in 3D. The view shows the folder
// as a room (its files, the subfolder, the import as an arrow); a Python file is entered (its text read from the
// workspace through the page), a JavaScript file and its import, and the notebook (its cells, linked by the names that
// flow between them, with their outputs). What the page reads for the view: only the folder's files, by their paths
// exactly as listed, and within an opening's totals (files and bytes). Close. Then where it is offered: exactly the
// listed hosts (dev.sagebrush.space, not loopback, not sagebrush.space, nor a name that merely ends or begins like it).
//   (after a site build: bun web/build.ts)   node web/space/test-own-files.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 300) : "")); if (!c) failures++; };
const port = 8600 + Math.floor(Math.random() * 90);
const server = spawn("python3", [join(here, "..", "serve.py"), String(port)], { stdio: "ignore" });
// (the hosts the gate is tried on, all this server: DEV's, PROD's, and two names that only look like DEV's)
const HOSTS = ["dev.sagebrush.space", "sagebrush.space", "xdev.sagebrush.space", "dev.sagebrush.space.example.test"];
const profile = mkdtempSync(join(tmpdir(), "space-own-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
  `--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} 127.0.0.1`).join(", ")}`, `--unsafely-treat-insecure-origin-as-secure=${HOSTS.map((h) => `http://${h}:${port}`).join(",")}`,
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
const ev = async (expr, ms) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, ms); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
const until = async (expr, ms = 15000) => { for (const t = Date.now(); Date.now() - t < ms; ) { if (await ev(expr, 5000).catch(() => false)) return true; await sleep(150); } return false; };
const F = `document.querySelector('iframe[src*="/space/"]')?.contentWindow`;
// (in the view's own frame: as the viewer itself would post)
const inFrame = async (expr, ms = 60000) => {
  const ctx = contexts.filter((c) => c.auxData?.isDefault && /\/space\//.test(c.origin + " " + (c.name ?? "")) || (c.auxData?.isDefault && c.auxData?.frameId && c.auxData.frameId !== contexts[0]?.auxData?.frameId)).at(-1);
  const r = await send("Runtime.evaluate", { contextId: ctx?.id, awaitPromise: true, returnByValue: true, expression: expr }, ms);
  return r.result?.result?.value;
};
// (Back out of every room, one at a time: each leave's space loaded before the next)
const leaveAll = async () => { for (let k = 0; k < 6 && (await ev(`${F}.space3d.room`)) !== null; k++) { await ev(`${F}.space3d.leave()`); await sleep(400); } return until(`${F}.space3d.room === null`, 5000); };
const askFromFrame = (path, rid) => inFrame(`new Promise((res) => { const h = (e) => { if (e.data?.sagebrush === "space-file" && e.data.id === ${rid}) { removeEventListener("message", h); res(e.data.error ?? "read"); } };
  addEventListener("message", h); window.parent.postMessage({ sagebrush: "space-read", version: 1, id: ${rid}, path: ${JSON.stringify(path)} }, location.origin);
  setTimeout(() => res("no answer"), 5000); })`);

setTimeout(() => { console.log("FAIL the suite didn't end in 300 s"); process.exit(1); }, 300_000).unref();
await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `http://dev.sagebrush.space:${port}/` });
ok(await until(`location.hostname === "dev.sagebrush.space" && !!window.sagebrush?.workspace`, 30000), "the notebook page has its workspace, on DEV's name");

// ---- the folder
const NB = { mode: "python", cells: [
  { id: "t1", type: "markdown", code: "# A small notebook\nTwo numbers and their product." },
  { id: "c1", code: "x = 2\ny = 3", outputs: [] },
  { id: "c2", code: "z = x * y\nprint(z)", outputs: [{ output_type: "stream", name: "stdout", text: "6\n" }] },
  { id: "c3", code: "import math\nprint(math.pi)", outputs: [] },
] };
const JSC = "import { helper } from \"./d.js\";\n\nexport function main() {\n  return helper(2) + new Box().open();\n}\n\nclass Box {\n  open() {\n    return this.peek();\n  }\n  peek() {\n    return 1;\n  }\n}\n";
const seeded = await ev(`(async () => {
  const w = window.sagebrush.workspace;
  await w.mkdir("/proj/sub");
  await w.create("/proj/b.py", { content: "def f(x):\\n    \\"\\"\\"One more than x.\\"\\"\\"\\n    return x + 1\\n" });
  await w.create("/proj/a.py", { content: "from b import f\\n\\n\\ndef g():\\n    return f(2)\\n\\n\\nprint(g())\\n" });
  await w.create("/proj/sub/c.sage", { content: "R.<t> = QQ[]\\nprint(t^2 + 1)\\n" });
  await w.create("/proj/demo.ipynb", { content: ${JSON.stringify(NB)}, mode: "python" });
  await w.create("/outside.py", { content: "secret = 1\\n" });
  await w.create("/proj/c.js", { content: ${JSON.stringify(JSC)} });
  await w.create("/proj/d.js", { content: ${JSON.stringify("/** One more than x. */\nexport function helper(x) {\n  return x + 1;\n}\n")} });
  // (a large file, 4 MiB less a little: read whole, 16 of them pass the opening's 64 MiB, the 17th doesn't)
  await w.create("/proj/big.txt", { content: "x".repeat((4 << 20) - 1000) });
  return (await w.list("/proj", { recursive: true })).map((e) => e.path).sort();
})()`, 60000);
ok(Array.isArray(seeded) && seeded.includes("/proj/demo.ipynb") && seeded.includes("/proj/sub/c.sage"), "the folder is made", seeded);

// ---- the file browser: the folder's ⋯, Open in 3D
const menuOf = async (sel) => ev(`(async () => {
  const b = ${sel};
  if (!b) return null;
  b.click();
  await new Promise((r) => setTimeout(r, 300));
  const items = [...document.querySelectorAll(".sbfmenu button")].map((x) => x.textContent.trim());
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  return items;
})()`);
const showFiles = async () => {
  await until(`!!document.querySelector("#wsfilesbtn") && !document.querySelector("#wsfilesbtn").hidden`, 30000);
  if (await ev(`document.querySelector('#wssidebar').hidden`)) await ev(`document.querySelector("#wsfilesbtn").click(), true`);
};
await showFiles();
await until(`!!document.querySelector('#wssidebar .frow[data-path="/proj"]')`, 10000);
const FOLDER_MORE = `[...(document.querySelector('#wssidebar .frow[data-path="/proj"]')?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === "⋯")`;
const ALL_MORE = `[...document.querySelectorAll('#wssidebar button')].find((b) => b.textContent.trim() === "⋯" && b.title.startsWith("Trash"))`;
ok((await menuOf(FOLDER_MORE))?.includes("Open in 3D"), "on DEV, a folder's ⋯ has Open in 3D");
ok((await menuOf(ALL_MORE))?.includes("Open all files in 3D"), "and the files' ⋯ has Open all files in 3D");
ok(!(await ev(`performance.getEntriesByType("resource").some((r) => r.name.includes("sagebrush-space3d"))`)), "the 3D view's chunk isn't fetched before one is chosen");
const opened = await ev(`(async () => {
  ${FOLDER_MORE}.click();
  await new Promise((r) => setTimeout(r, 300));
  const item = [...document.querySelectorAll(".sbfmenu button")].find((b) => b.textContent.trim() === "Open in 3D");
  if (!item) return "no item";
  item.click();
  return "clicked";
})()`);
ok(opened === "clicked", "Open in 3D is chosen", opened);
ok(await until(`(${F})?.space3d?.space?.nodes?.length >= 4`, 30000), "the view shows the folder");
ok(await ev(`performance.getEntriesByType("resource").some((r) => r.name.endsWith("/sagebrush-space3d.js"))`), "its chunk is fetched now");
const top = await ev(`(() => { const W = ${F}.space3d; return { ids: W.space.nodes.map((n) => n.id).sort(), edges: W.space.edges.map((e) => e.from + ">" + e.to) }; })()`);
ok(["d:sub", "p:a.py", "p:b.py", "p:demo.ipynb"].every((x) => top.ids.includes(x)) && !top.ids.some((x) => x.includes("outside")), "its files, its subfolder and its notebook, nothing from outside it", top.ids);
ok(top.edges.includes("p:a.py>p:b.py"), "a.py's import of b is an arrow", top.edges);

// ---- a Python file: entered, its text read from the workspace through the page
ok(await ev(`${F}.space3d.enter('p:a.py')`), "a.py is entered");
const fileRoom = await ev(`(() => { const W = ${F}.space3d; return { room: W.room, ids: W.space.nodes.map((n) => n.id), edges: W.space.edges.map((e) => e.from + ">" + e.to) }; })()`);
ok(fileRoom.room === "proj › a.py" && fileRoom.ids.includes("f:g") && fileRoom.ids.includes("m:b"), "its room: g, the import of b", fileRoom);
ok(await ev(`${F}.space3d.enter('m:b')`) && await until(`${F}.space3d.room === 'proj › a.py › b.py' && ${F}.space3d.selection?.id === 'f:f'`, 8000), "the import leads through to b.py, at f", await ev(`${F}.space3d.room`));
ok((await ev(`${F}.space3d.space.nodes.find((n) => n.id === 'f:f')?.summary`)) === "One more than x.", "f's docstring is its summary");
ok(await leaveAll(), "and Back out to the folder");

// ---- JavaScript: the file's room, the import through to d.js
ok(await ev(`${F}.space3d.enter('p:c.js')`), "a JavaScript file is entered");
const js = await ev(`(() => { const W = ${F}.space3d; return { ids: W.space.nodes.map((n) => n.id).sort(), edges: W.space.edges.map((e) => e.from + ">" + e.to) }; })()`);
ok(js.ids.includes("m:./d.js") && js.edges.includes("f:main>m:./d.js") && js.edges.includes("f:main>c:Box"), "its room: main calls the import and the class", js);
ok(await ev(`${F}.space3d.enter('m:./d.js')`) && await until(`${F}.space3d.room === 'proj › c.js › d.js'`, 8000), "the import leads through to d.js", await ev(`${F}.space3d.room`));
await leaveAll();

// ---- the notebook: its cells and what flows between them
ok(await ev(`${F}.space3d.enter('p:demo.ipynb')`), "the notebook is entered", await ev(`${F}.document.querySelector('[data-c="status"]')?.textContent`));
const nb = await ev(`(() => { const W = ${F}.space3d; return { room: W.room, nodes: W.space.nodes.map((n) => [n.id, n.kind, n.output ?? null]), edges: W.space.edges.map((e) => e.from + ">" + e.to + ":" + (e.vars ?? [e.kind]).join(",")) }; })()`);
ok(nb.room === "proj › demo.ipynb", "its room", nb.room);
ok(nb.edges.includes("cell:c1>cell:c2:x,y"), "the cell defining x and y leads to the cell that reads them", nb.edges);
ok(nb.nodes.some(([i, , o]) => i === "cell:c2" && o === "6"), "a cell's output, as the notebook showed it", nb.nodes);
ok(nb.edges.includes("cell:t1>cell:c1:explains"), "the text cell stands by the cell after it", nb.edges);
await leaveAll();

// ---- what the page reads for the view: only the folder's files, by their paths exactly as listed
ok(/not a file of this folder/.test(await askFromFrame("../outside.py", 9001)), "a file outside the folder is refused");
for (const [p, n] of [["./a.py", 9002], ["sub/../a.py", 9003], ["/proj/a.py", 9004], ["a.py ", 9005], ["A.py", 9006], ["a.py/", 9007], ["x".repeat(5000), 9008]])
  ok(/not a file of this folder/.test(await askFromFrame(p, n)), `another spelling of a path isn't looked up: ${JSON.stringify(p.slice(0, 20))}`);
ok((await askFromFrame("a.py", 9010)) === "read", "the path as listed is read");
const fromPage = await ev(`new Promise((res) => { const w = ${F}; const h = (e) => { if (e.data?.sagebrush === "space-file" && e.data.id === 9011) { w.removeEventListener("message", h); res(e.data.error ?? "read"); } };
  w.addEventListener("message", h); window.postMessage({ sagebrush: "space-read", version: 1, id: 9011, path: "a.py" }, location.origin);
  setTimeout(() => res("no answer"), 3000); })`);
ok(fromPage === "no answer", "a read posted by anything but the view's frame isn't answered", fromPage);
// (and within an opening's totals: 64 MiB in all; the view has read a little so far, so the 16th large file is the last)
const bytes = await inFrame(`(async () => {
  const one = (rid) => new Promise((res) => { const h = (e) => { if (e.data?.sagebrush === "space-file" && e.data.id === rid) { removeEventListener("message", h); res(e.data.error ?? "read"); } };
    addEventListener("message", h); window.parent.postMessage({ sagebrush: "space-read", version: 1, id: rid, path: "big.txt" }, location.origin); });
  const out = [];
  for (let k = 0; k < 17; k++) out.push(await one(9100 + k));
  return out;
})()`, 120000);
ok(Array.isArray(bytes) && bytes.slice(0, 15).every((x) => x === "read") && bytes.at(-1)?.includes("too much read in this view"), "a view that has read 64 MiB is told so, and given nothing more", bytes?.map((x) => x.slice(0, 12)));
// (a new opening has totals of its own: closed, and opened again)
await ev(`[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Close") && b.closest("[role=dialog]"))?.click(), true`);
await until(`!document.querySelector('iframe[src*="/space/"]')`, 3000);
await ev(`(async () => { ${FOLDER_MORE}.click(); await new Promise((r) => setTimeout(r, 300)); [...document.querySelectorAll(".sbfmenu button")].find((b) => b.textContent.trim() === "Open in 3D").click(); return 1; })()`);
ok(await until(`(${F})?.space3d?.space?.nodes?.length >= 4`, 30000), "opened again");
const many = await inFrame(`(async () => {
  const one = (rid) => new Promise((res) => { const h = (e) => { if (e.data?.sagebrush === "space-file" && e.data.id === rid) { removeEventListener("message", h); res(e.data.error ?? "read"); } };
    addEventListener("message", h); window.parent.postMessage({ sagebrush: "space-read", version: 1, id: rid, path: "b.py" }, location.origin); });
  const out = [];
  for (let b = 0; b < 2010; b += 50) out.push(...(await Promise.all(Array.from({ length: Math.min(50, 2010 - b) }, (_, k) => one(20000 + b + k)))));
  return { read: out.filter((x) => x === "read").length, refused: out.filter((x) => x.includes("too many files read")).length, last: out.at(-1) };
})()`, 120000);
ok(many?.read === 2000 && many.refused === 10 && /too many files read/.test(many.last), "a new opening reads 2,000 files, and is told so after that", many);

// ---- how the page reads for the view: one read at a time, each within what the opening has left, none after Close.
//      (The workspace's reads counted: its class's readUpTo and read, wrapped)
await ev(`(async () => {
  const m = await import(new URL("/sagebrush-space3d.js", location.href).href), n = (window.__reads = { calls: 0, now: 0, max: 0, paths: [], hows: [], copies: [] });
  m.SPACE3D_TESTING.reading = (p, d, how) => { if (d > 0) { n.calls++; n.now++; n.max = Math.max(n.max, n.now); n.paths.push(p); n.hows.push([p, how?.method ?? null, how?.cap ?? null]); } else n.now--; };
  m.SPACE3D_TESTING.copying = (p) => { n.copies.push(p); };
  return true;
})()`);
const reopen = async (folder = FOLDER_MORE) => {
  await ev(`[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Close") && b.closest("[role=dialog]"))?.click(), true`);
  await until(`!document.querySelector('iframe[src*="/space/"]')`, 3000);
  await ev(`(async () => { ${folder}.click(); await new Promise((r) => setTimeout(r, 300)); [...document.querySelectorAll(".sbfmenu button")].find((b) => b.textContent.trim().startsWith("Open")).click(); return 1; })()`);
  return until(`(${F})?.space3d?.space?.nodes?.length >= 1 && !/reading the folder/.test([...document.querySelectorAll("[role=dialog] span")].map((x) => x.textContent).join())`, 60000);
};
const askMany = (path, n, base) => inFrame(`(async () => {
  const one = (rid) => new Promise((res) => { const h = (e) => { if (e.data?.sagebrush === "space-file" && e.data.id === rid) { removeEventListener("message", h); res(e.data.error ?? "read"); } };
    addEventListener("message", h); window.parent.postMessage({ sagebrush: "space-read", version: 1, id: rid, path: ${JSON.stringify(path)} }, location.origin); });
  return Promise.all(Array.from({ length: ${n} }, (_, k) => one(${base} + k)));
})()`, 120000);
ok(await reopen(), "opened again, for the reading rows");
await ev(`(window.__reads.calls = 0, window.__reads.max = 0, window.__reads.paths = [], true)`);
const burst = await askMany("b.py", 100, 30000);
const rd = await ev(`window.__reads`);
const told = burst.filter((x) => /too many files asked for at once/.test(x)).length;
ok(rd.calls > 0, "the counter sees the view's reads", rd.calls);
ok(rd.max === 1 && burst.filter((x) => x === "read").length + told === 100 && told > 0, "100 asked at once: read one at a time, those past the 64 waiting told to try again", { max: rd.max, told });
// (the opening's 64 MiB, reserved before each read: sixteen files of exactly 4 MiB, then the seventeenth isn't read at all)
await ev(`window.sagebrush.workspace.create("/proj/four.txt", { content: "x".repeat(4 << 20) }).then(() => true)`, 60000);
ok(await reopen(), "opened again, for the bytes row");
await ev(`(window.__reads.calls = 0, window.__reads.paths = [], true)`);
const sixteen = [];
for (let k = 0; k < 17; k++) sixteen.push((await askMany("four.txt", 1, 31000 + k))[0]);
const fourReads = await ev(`window.__reads.paths.filter((p) => p.endsWith("four.txt")).length`);
ok(sixteen.slice(0, 16).every((x) => x === "read") && /too much read in this view/.test(sixteen[16]) && fourReads === 16, "16 files of 4 MiB fill the opening's 64 MiB; the 17th is refused before it is read", { last: sixteen[16], fourReads });
// (Close with reads waiting: none of them is read after it)
ok(await reopen(), "opened again, for the Close row");
await ev(`(window.__reads.paths = [], true)`);
void inFrame(`(() => { for (let k = 0; k < 30; k++) window.parent.postMessage({ sagebrush: "space-read", version: 1, id: 32000 + k, path: "four.txt" }, location.origin); return true; })()`);
await until(`window.__reads.paths.filter((p) => p.endsWith("four.txt")).length >= 1`, 10000);
await ev(`[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Close") && b.closest("[role=dialog]"))?.click(), true`);
const atClose = await ev(`window.__reads.paths.filter((p) => p.endsWith("four.txt")).length`);
await sleep(3000);
const afterClose = await ev(`window.__reads.paths.filter((p) => p.endsWith("four.txt")).length`);
ok(afterClose <= atClose + 1 && afterClose < 30, "Close with 30 reads waiting: no more of them are read", { atClose, afterClose });

// ---- the folder's scan, within its own bounds: a file read as it is now (its listed size understated: not read
//      whole), a notebook over 1 MiB (its length from its kind), a file's imports kept to 200
await ev(`(async () => {
  const w = window.sagebrush.workspace;
  await w.mkdir("/scan");
  await w.create("/scan/lines.txt", { content: "x\\n" });
  await w.create("/scan/big.ipynb", { content: { cells: [{ id: "a", code: "x = 1\\n" + "#".repeat(3 << 19) }] }, mode: "python" });
  await w.create("/scan/huge.ipynb", { content: { cells: [{ id: "a", code: "#".repeat(5 << 20) }] }, mode: "python" });
  await w.create("/scan/small.ipynb", { content: { cells: [{ id: "a", code: "x = 1\\ny = 2" }] }, mode: "python" });
  await w.create("/scan/many.py", { content: Array.from({ length: 300 }, (_, i) => "import m" + i).join("\\n") + "\\n" });
  // (lines.txt, listed at 2 bytes, is 2 MiB by the time the scan reads it; grow.txt, 5 MiB when the view asks for it)
  await w.create("/scan/grow.txt", { content: "x\\n" });
  const m = await import(new URL("/sagebrush-space3d.js", location.href).href), count = m.SPACE3D_TESTING.reading;
  m.SPACE3D_TESTING.reading = async (p, d, how) => {
    if (d > 0 && p === "/scan/lines.txt") await w.write(p, "x\\n".repeat(1 << 20));
    if (d > 0 && p === "/scan/grow.txt" && window.__grow) await w.write(p, "x".repeat(5 << 20));
    return count?.(p, d, how);
  };
  return true;
})()`, 60000);
await until(`!!document.querySelector('#wssidebar .frow[data-path="/scan"]')`, 10000);
const SCAN_MORE = `[...(document.querySelector('#wssidebar .frow[data-path="/scan"]')?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === "⋯")`;
ok(await reopen(SCAN_MORE), "the scan folder opens");
const tree = await ev(`(() => { const t = ${F}.space3d.space.tree ?? ${F}.space3d.space._tree; const f = Object.fromEntries((t?.files ?? []).map((x) => [x[0], x[1]])); return { f, imports: (t?.pyimports?.["many.py"] ?? []).length }; })()`);
ok(tree.f["lines.txt"] === 1, "a file listed at 2 bytes but 2 MiB when it is read isn't read whole: its length is its listed size's, not its 1,048,576 lines", tree.f["lines.txt"]);
const scanNb = await ev(`window.__reads.hows.filter((h) => h[0].endsWith(".ipynb"))`);
ok(tree.f["big.ipynb"] === 40 && tree.f["small.ipynb"] === 40 && scanNb.length === 0, "the scan reads no notebook: each keeps its kind's length", { lengths: [tree.f["big.ipynb"], tree.f["small.ipynb"]], scanNb });
ok(tree.imports === 200, "a file's imports: 200 kept of 300", tree.imports);
// (read-size probes, through the hook: how each read was made, and which notebooks were copied)
const hows = (p) => ev(`window.__reads.hows.filter((h) => h[0] === ${JSON.stringify(p)})`);
const lh = await hows("/scan/lines.txt");
ok(lh.length >= 1 && lh.every((h) => h[1] === "readUpTo" && h[2] === 1 << 20), "the scan read lines.txt with its bytes capped at 1 MiB (readUpTo), never whole", lh);
await ev(`(window.__reads.copies = [], true)`);
const hugeSaid = (await askMany("huge.ipynb", 1, 33000))[0];
ok(/this notebook exceeds the 3D view's limits/.test(hugeSaid) && !(await ev(`window.__reads.copies.includes("/scan/huge.ipynb")`)), "a notebook over 4 MiB, asked for, is refused before any of it is copied", hugeSaid);
ok((await askMany("small.ipynb", 1, 33002))[0] === "read" && (await ev(`window.__reads.copies.includes("/scan/small.ipynb")`)), "a small one is copied and sent (the probe sees copies)");
await ev(`(window.__reads.hows = [], window.__grow = true, true)`);
const grew = (await askMany("grow.txt", 1, 33003))[0];
await ev(`(window.__grow = false, true)`);
const gh = await hows("/scan/grow.txt");
ok(/too large to read here \(over 4\.0 MiB\)/.test(grew) && gh.length === 1 && gh[0][1] === "readUpTo" && gh[0][2] === 4 << 20, "a file grown to 5 MiB after the scan, asked for: read with its bytes capped at 4 MiB (readUpTo), refused, never read whole", { grew, gh });

// (a notebook is read only when entered: selected, its drawer doesn't fetch it)
await ev(`(window.__reads.hows = [], ${F}.space3d.select("p:small.ipynb"), true)`);
await sleep(1500);
ok((await ev(`window.__reads.hows.filter((h) => h[0].endsWith(".ipynb")).length`)) === 0 && (await ev(`${F}.space3d.selection?.id`)) === "p:small.ipynb", "a notebook selected isn't read: only entering it reads it");
// (one notebook read at a time in the page, across openings: two more openings of the folder each ask for a notebook;
//  the first is held at its read, and the second doesn't begin until it is done)
await ev(`(async () => {
  const m = await import(new URL("/sagebrush-space3d.js", location.href).href), prev = m.SPACE3D_TESTING.reading;
  const nb = (window.__nb = { now: 0, max: 0, starts: 0 });
  window.__nbGate = new Promise((r) => (window.__nbOpen = r));
  m.SPACE3D_TESTING.reading = async (p, d, how) => {
    if (p.endsWith(".ipynb")) { if (d > 0) { nb.starts++; nb.now++; nb.max = Math.max(nb.max, nb.now); await window.__nbGate; } else nb.now--; }
    return prev?.(p, d, how);
  };
  void m.openIn3D(window.sagebrush.workspace, "/scan");
  void m.openIn3D(window.sagebrush.workspace, "/scan");
  return true;
})()`);
ok(await until(`[...document.querySelectorAll('iframe[src*="/space/"]')].slice(-2).every((f) => f.contentWindow?.space3d?.space?.nodes?.length >= 1) && document.querySelectorAll('iframe[src*="/space/"]').length === 3`, 30000), "two more openings of the folder");
await ev(`(window.__nbAns = [], [...document.querySelectorAll('iframe[src*="/space/"]')].slice(-2).forEach((f) => f.contentWindow.addEventListener("message", (e) => { if (e.data?.sagebrush === "space-file" && (e.data.id === 34000 || e.data.id === 34001)) window.__nbAns.push(e.data.error ?? "read"); })), true)`);
// (each asks from its own frame, as the viewer would: in the two newest frames' own contexts)
const main = contexts[0]?.auxData?.frameId, frameCtx = [];
for (const c of [...contexts].reverse()) if (c.auxData?.isDefault && c.auxData.frameId !== main && !frameCtx.some((x) => x.auxData.frameId === c.auxData.frameId)) frameCtx.push(c);
for (const [i, c] of frameCtx.slice(0, 2).entries())
  await send("Runtime.evaluate", { contextId: c.id, expression: `(window.parent.postMessage({ sagebrush: "space-read", version: 1, id: ${34000 + i}, path: "small.ipynb" }, location.origin), true)`, returnByValue: true });
await sleep(1500);
const heldNb = await ev(`({ ...window.__nb })`);
await ev(`(window.__nbOpen(), true)`);
const answered = await until(`window.__nbAns.length === 2`, 15000);
const doneNb = await ev(`({ ...window.__nb, ans: window.__nbAns })`);
ok(answered && heldNb.starts === 1 && doneNb.starts === 2 && doneNb.max === 1 && doneNb.ans.length === 2 && doneNb.ans.every((x) => x === "read"), "two openings each asking for a notebook: one read at a time (the second waits for the first, held)", { heldNb, doneNb });
await ev(`([...document.querySelectorAll("[role=dialog]")].slice(-2).forEach((d) => [...d.querySelectorAll("button")].find((b) => b.textContent.includes("Close"))?.click()), true)`);

// ---- Close
await ev(`[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Close") && b.closest("[role=dialog]"))?.click(), true`);
ok(await until(`!document.querySelector('iframe[src*="/space/"]')`, 3000), "Close takes the 3D view away");
ok(errors.length === 0, "no page errors", errors.slice(0, 3));

// ---- where it is offered: the listed hosts, matched exactly
for (const [host, want] of [["dev.sagebrush.space", true], ["127.0.0.1", false], ["localhost", false], ["sagebrush.space", false], ["xdev.sagebrush.space", false], ["dev.sagebrush.space.example.test", false]]) {
  await send("Page.navigate", { url: `http://${host}:${port}/` });
  await sleep(500);
  const ready = await until(`location.hostname === ${JSON.stringify(host)} && !!window.sagebrush?.workspace`, 30000);
  await showFiles();
  const items = ready ? await menuOf(ALL_MORE) : null;
  ok(Array.isArray(items) && items.includes("Open all files in 3D") === want, `on ${host}: ${want ? "offered" : "not offered"}`, items);
  if (!want) ok(!(await ev(`performance.getEntriesByType("resource").some((r) => r.name.includes("sagebrush-space3d"))`)), `on ${host}: its chunk isn't fetched`);
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
