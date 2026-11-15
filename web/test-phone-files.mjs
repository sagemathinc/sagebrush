// ci: web-browser/notebook order=250
// The Files panel on a touch screen (web/workspace/browser.ts), in headless Chrome with a phone's metrics (393 x 800,
// touch, the phone layout) and real touches, and on a wide screen with a mouse for contrast:
// - every row's checkbox and ⋯ shown without pointing at the row (so a tap opens it at once); a finger put on a
//   checkbox and drawn down the column sets each it crosses, and one put on a set one, drawn, clears them; a tap on a
//   checkbox toggles it once;
// - a tap on a notebook's name opens it, the panel out of its way, nothing selected;
// - every row's ⋯ starts Open, Preview and versions: a notebook's, a board's, a data file's and a .tex's; a notebook's
//   Preview and versions opens it with its TimeTravel shown, a board's on the board page with its own;
// - File ▸ Examples… ▸ Open a copy, the Files panel open: the copy opened, the panel out of its way;
// - with a mouse on a wide screen: checkboxes only on the row pointed at, a click on a row opens it and the panel
//   stays, the same ⋯ order.
// The examples' catalog, files.json and ZIP are the page's fetch answered here, so the test needs no gallery in the
// served root.  Serve web/dist first (python3 web/serve.py 8765), then   node web/test-phone-files.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { devtoolsPort } from "./test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-phone-files-"));
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
const W = "window.sagebrush.workspace";

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
  ok(await until("!!window.sagebrush?.notebook?.cells && document.querySelectorAll('.cell').length > 0 && !document.body.classList.contains('opening') && !!window.sagebrush?.workspace", 60000), `the notebook page (${url})`);
  await sleep(800);
};
const filesShown = `!document.getElementById("wssidebar").hidden`;
const row = (p) => `#wssidebar .frow[data-path=${J(p)}]`;
const showFiles = async () => {
  if (!(await ev(filesShown))) await ev(`(document.querySelector("#wsfilesbtn").click(), 1)`);
  return until(`${filesShown} && !!document.querySelector(${J(row("/p3.ipynb"))})`, 15000);
};
// (an element's middle, in the window, after scrolling it into view)
const mid = (sel) => ev(`(() => { const e = document.querySelector(${J(sel)}); e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const touch = (type, at) => send("Input.dispatchTouchEvent", { type, touchPoints: at ? [{ x: at[0], y: at[1] }] : [] });
const tap = async (sel) => { const at = await mid(sel); await touch("touchStart", at); await sleep(60); await touch("touchEnd"); await sleep(400); };
// (a finger put on the first and drawn, in small steps, to the last)
const draw = async (sels) => {
  const pts = [];
  for (const s of sels) pts.push(await mid(s));
  await touch("touchStart", pts[0]);
  for (let i = 1; i < pts.length; i++) for (let k = 1; k <= 6; k++) { await touch("touchMove", [pts[i - 1][0] + ((pts[i][0] - pts[i - 1][0]) * k) / 6, pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * k) / 6]); await sleep(20); }
  await touch("touchEnd");
  await sleep(300);
};
const checked = () => ev(`[...document.querySelectorAll("#wssidebar .frow[data-sel] .sel[aria-checked=true]")].map((c) => c.closest(".frow").dataset.path).sort()`);
const shown = (sel) => ev(`[...document.querySelectorAll(${J(sel)})].map((x) => getComputedStyle(x).visibility)`);
// (a row's ⋯ opened: its menu's items, separators as "-"; the menu then closed)
const menuOf = async (p) => {
  await ev(`(document.querySelector(${J(row(p) + " .more")}).click(), 1)`);
  await until(`!!document.querySelector(".sbfmenu")`, 5000);
  await sleep(200);
  const items = await ev(`[...document.querySelector(".sbfmenu").children].map((x) => x.tagName === "BUTTON" ? x.textContent : "-")`);
  await ev(`(document.querySelector(".sbfmenu")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`);
  await sleep(150);
  return items;
};
const pickItem = (label) => ev(`([...document.querySelectorAll(".sbfmenu button")].find((b) => b.textContent === ${J(label)}).click(), 1)`);
const refOf = (p) => ev(`${W}.stat(${J(p)}).then((e) => e.ref)`);
const current = () => ev(`window.sagebrush.notebook.store?.id ?? null`);

// an example the gallery would serve: a catalog, its files.json and its ZIP (deflated, as web/build-examples.ts makes it)
const NB = new TextEncoder().encode(J({ cells: [{ cell_type: "code", source: "6 * 7", metadata: {}, outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const zip = (name, bytes) => {
  const nm = Buffer.from(name), data = deflateRawSync(bytes), crc = crc32(bytes);
  const h = Buffer.alloc(30), c = Buffer.alloc(46), end = Buffer.alloc(22);
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(0x21, 12);
  h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(bytes.length, 22); h.writeUInt16LE(nm.length, 26);
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0x031e, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(0x21, 14);
  c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(bytes.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(0, 42);
  const local = Buffer.concat([h, nm, data]), central = Buffer.concat([c, nm]);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
};
const FILES = Buffer.from(J({ id: "notebook/phone-copy", main: "phone-copy.ipynb", files: [{ path: "phone-copy.ipynb", bytes: NB.length, sha256: sha(NB) }] }));
const ROUTES = {
  "/examples/index.json": Buffer.from(J({ examples: [{ id: "notebook/phone-copy", kind: "notebook", title: "Phone copy", summary: "", main: "phone-copy.ipynb", files_sha256: sha(FILES) }] })).toString("base64"),
  "/examples/notebook/phone-copy/files.json": FILES.toString("base64"),
  "/examples/notebook/phone-copy/phone-copy.zip": zip("phone-copy.ipynb", NB).toString("base64"),
};
const STUB = `(() => { const R = ${J(ROUTES)}, f0 = window.__sbFetch0 ??= window.fetch;
  window.fetch = (u, o) => { const p = new URL(String(u?.url ?? u), location.href).pathname; if (!(p in R)) return f0(u, o);
    const b = Uint8Array.from(atob(R[p]), (c) => c.charCodeAt(0)); return Promise.resolve(new Response(b, { headers: { "content-type": p.endsWith(".zip") ? "application/zip" : "application/json" } })); }; return 1; })()`;

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });

  // ---- a phone: the files
  await phone();
  await open(`${base}?phone=1`);
  await ev(`Promise.all([${W}.create("/p1.ipynb", { mode: "python" }), ${W}.create("/p2.ipynb", { mode: "python" }), ${W}.create("/p3.ipynb", { mode: "python" }),
    ${W}.create("/plan.board.json"), ${W}.create("/data.csv", { content: "1,2\\n" }), ${W}.create("/paper.tex", { content: "\\\\documentclass{article}\\n" })]).then(() => 1)`);
  ok(await showFiles(), "a phone: the Files panel lists the files");
  const sels = await shown("#wssidebar .frow[data-sel] .sel"), mores = await shown("#wssidebar .frow .more");
  ok(sels.length >= 6 && sels.every((v) => v === "visible") && mores.every((v) => v === "visible"), "every row's checkbox and ⋯ shown, no row pointed at: " + J({ sels, mores }));

  // painting a column of checkboxes
  await draw([row("/p1.ipynb") + " .sel", row("/p2.ipynb") + " .sel", row("/p3.ipynb") + " .sel"]);
  ok(J(await checked()) === J(["/p1.ipynb", "/p2.ipynb", "/p3.ipynb"]), "a finger drawn down three checkboxes selects the three: " + J(await checked()));
  ok(await ev(filesShown) && J(await current()) !== J(await refOf("/p1.ipynb")), "…and opens nothing");
  await tap(row("/p2.ipynb") + " .sel");
  ok(J(await checked()) === J(["/p1.ipynb", "/p3.ipynb"]), "a tap on a set checkbox clears it, once: " + J(await checked()));
  await tap(row("/p2.ipynb") + " .sel");
  ok(J(await checked()) === J(["/p1.ipynb", "/p2.ipynb", "/p3.ipynb"]), "a tap on a clear one sets it, once: " + J(await checked()));
  await draw([row("/p3.ipynb") + " .sel", row("/p2.ipynb") + " .sel", row("/p1.ipynb") + " .sel"]);
  ok(J(await checked()) === J([]), "a finger put on a set checkbox and drawn up the column clears each it crosses: " + J(await checked()));

  // a tap on a name opens it
  const p2 = await refOf("/p2.ipynb");
  await tap(row("/p2.ipynb") + " .n");
  ok(await until(`window.sagebrush.notebook.store?.id === ${J(p2)}`, 15000), "a tap on a notebook's name opens it");
  ok(await until(`!(${filesShown})`, 5000), "…the Files panel out of its way");
  ok(J(await checked()) === J([]), "…nothing selected");

  // the ⋯ menus
  ok(await showFiles(), "the Files panel again");
  for (const p of ["/p1.ipynb", "/plan.board.json", "/data.csv", "/paper.tex"]) {
    const items = await menuOf(p);
    ok(items[0] === "Open" && items[1] === "Preview and versions" && items[2] === "-", `${p}'s ⋯ starts Open, Preview and versions: ` + J(items.slice(0, 5)));
  }
  // a notebook's Preview and versions: opened, its TimeTravel shown
  const p1 = await refOf("/p1.ipynb");
  await ev(`(document.querySelector(${J(row("/p1.ipynb") + " .more")}).click(), 1)`);
  await until(`!!document.querySelector(".sbfmenu")`, 5000);
  await pickItem("Preview and versions");
  ok(await until(`window.sagebrush.notebook.store?.id === ${J(p1)} && !document.querySelector("#timetravel").hidden`, 15000), "a notebook's Preview and versions: it opened, its TimeTravel shown");
  ok(await until(`!(${filesShown})`, 5000), "…the Files panel out of its way");
  await ev(`(document.querySelector("#ttbtn").click(), 1)`);
  await until(`document.querySelector("#timetravel").hidden`, 5000);

  // File ▸ Examples… ▸ Open a copy, the Files panel open
  ok(await showFiles(), "the Files panel again, for the examples");
  await ev(STUB);
  await ev(`(document.querySelector("#filemenu [data-item=examples]").click(), 1)`);
  ok(await until(`[...document.querySelectorAll("dialog.sb-examples[open] [role=option]")].some((b) => b.textContent.includes("Phone copy"))`, 15000), "File ▸ Examples…: the gallery's panel, the example listed");
  await ev(`([...document.querySelectorAll("dialog.sb-examples [role=option]")].find((b) => b.textContent.includes("Phone copy")).click(), 1)`);
  await until(`[...document.querySelectorAll("dialog.sb-examples button")].some((b) => b.textContent === "Open a copy" && !b.disabled)`, 5000);
  const before = await current();
  await ev(`([...document.querySelectorAll("dialog.sb-examples button")].find((b) => b.textContent === "Open a copy").click(), 1)`);
  ok(await until(`${W}.stat("/Examples/Phone copy/phone-copy.ipynb").then((e) => !!e && window.sagebrush.notebook.store?.id === e.ref)`, 20000), "Open a copy: the copy opened");
  ok(await until(`!(${filesShown}) && !document.querySelector("dialog.sb-examples[open]")`, 5000), "…the panel and the Files panel out of its way: " + J({ files: await ev(filesShown), before }));
  await ev(`(window.__sbFetch0 && (window.fetch = window.__sbFetch0), 1)`);

  // a board's Preview and versions: the board page, its TimeTravel shown
  ok(await showFiles(), "the Files panel again, for a board");
  await ev(`(document.querySelector(${J(row("/plan.board.json") + " .more")}).click(), 1)`);
  await until(`!!document.querySelector(".sbfmenu")`, 5000);
  await pickItem("Preview and versions");
  ok(await until(`location.pathname.startsWith("/board") && !!document.querySelector('#board [data-sbb="tt"]') && !document.querySelector('#board [data-sbb="tt"]').hidden`, 30000), "a board's Preview and versions: the board page, its TimeTravel shown");
  ok(await ev(`!new URLSearchParams(location.search).has("tt")`), "…the address without its tt=1 after");

  // ---- a wide screen with a mouse: as before
  await wide();
  await open(`${base}?phone=0`);
  ok(await showFiles(), "a wide screen: the Files panel lists the files");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 600 });
  await sleep(200);
  ok((await shown(row("/p2.ipynb") + " .sel"))[0] === "hidden", "with a mouse: a row's checkbox hidden while it isn't pointed at");
  const [mx, my] = await mid(row("/p2.ipynb"));
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: mx, y: my });
  await sleep(200);
  ok((await shown(row("/p2.ipynb") + " .sel"))[0] === "visible", "…shown on the row pointed at");
  const p3 = await refOf("/p3.ipynb");
  const [nx, ny] = await mid(row("/p3.ipynb") + " .n");
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: nx, y: ny, button: "left", clickCount: 1 });
  ok(await until(`window.sagebrush.notebook.store?.id === ${J(p3)}`, 15000), "a click on a notebook's name opens it");
  await sleep(500);
  ok(await ev(filesShown), "…and the Files panel stays, beside it");
  const items = await menuOf("/p1.ipynb");
  ok(items[0] === "Open" && items[1] === "Preview and versions" && items.includes("Open in a new tab"), "a notebook's ⋯ the same on a wide screen: " + J(items.slice(0, 5)));
  ok(J(await checked()) === J([]), "nothing selected by any of it");
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
