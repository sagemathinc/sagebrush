// ci: web-runner order=481 chrome
// A workspace board's pictures as workspace files (#1872), in headless Chromium against the built site: a pasted
// picture is saved in /Attachments/board-<id>/ under its content name; a picture kept before in this browser only is
// saved there when the board shows it (this browser's copy kept); with this browser's store gone (another device),
// the board shows them from its files; a copy of the board gets them in its own folder.
//   bun web/build.ts, then node web/board/test-board-picture-files.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "../test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-board-picfiles-"));
const serve = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((r) => serve.stdout.once("data", (d) => r(Number(String(d).trim().split(/\s+/).pop()))));
const profile = join(tmp, "profile");
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--password-store=basic", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const kill = () => { try { chrome.kill("SIGKILL"); } catch {} try { serve.kill("SIGKILL"); } catch {} };
process.on("exit", kill);
const cdp = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  // (an alert the page shows: kept, and dismissed, so the page goes on)
  if (m.method === "Page.javascriptDialogOpening") { dialogs.push(m.params.message); send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {}); }
};
const dialogs = [];
// (an answer that never comes, the page or the browser gone, fails by name instead of leaving node nothing to wait for)
const send = (method, params = {}, ms = 60000) => new Promise((resolve, reject) => { const id = ++n, timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method}: no answer within ${ms / 1000} s`)); }, ms); waiting.set(id, (r) => { clearTimeout(timer); resolve(r); }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
const idOf = () => ev(`new URLSearchParams(location.search).get("doc")?.slice(6) ?? null`);
const folder = (id) => `/Attachments/board-${id}`;
const filesIn = (id) => ev(`window.sagebrush.workspace.list(${JSON.stringify(folder(id))}).then((l) => l.map((e) => e.path).sort(), () => [])`);
const docOf = () => ev("JSON.parse(JSON.stringify(window.sagebrush.board.snapshot().doc))");
const ready = () => until("/doc=local:/.test(location.search) && !!window.sagebrush?.workspace && !!window.sagebrush?.board?.snapshot?.()?.doc", 60000);
// a PNG made in the page, w by h
const png = (w, h) => `(async () => { const c = document.createElement("canvas"); c.width = ${w}; c.height = ${h}; const g = c.getContext("2d"); g.fillStyle = "#3a6"; g.fillRect(0, 0, ${w}, ${h}); return new File([await new Promise((r) => c.toBlob(r, "image/png"))], "pic.png", { type: "image/png" }); })()`;
const paste = (file) => ev(`(async () => { const dt = new DataTransfer(); dt.items.add(await ${file}); document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true })); return 1; })()`);
const shows = (w) => until(`[...document.querySelectorAll("img.board-img")].some((i) => i.complete && i.naturalWidth === ${w})`);
try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/board/?new=python` });
  check(await ready(), "a new board of the workspace opens");
  const id = await idOf();
  await ev("window.sagebrush.board.editing(true), 1");

  // pasted: the board's file, under its content name
  await paste(png(30, 20));
  check(await until("window.sagebrush.board.snapshot().doc.nodes.some((x) => x.image)"), "a pasted picture is added");
  const p1 = (await docOf()).nodes.find((x) => x.image).image;
  check(await until(`window.sagebrush.workspace.list(${JSON.stringify(folder(id))}).then((l) => l.some((e) => e.path === ${JSON.stringify(`${folder(id)}/${p1}.png`)}))`), `saved as ${folder("<id>")}/<its name>.png: ` + JSON.stringify(await filesIn(id)));
  check(JSON.stringify(await docOf()).indexOf("data:") === -1, "the document still holds only its name and size");

  // a picture kept before in this browser alone (as every board's was): saved as the board's file when it shows
  const p2 = await ev(`(async () => {
    const f = await ${png(40, 10)}, u = new Uint8Array(await f.arrayBuffer());
    const name = "i" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", u)).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const db = await new Promise((res, rej) => { const r = indexedDB.open("sagebrush-board-images", 1); r.onupgradeneeded = () => r.result.createObjectStore("blobs"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => { const t = db.transaction("blobs", "readwrite"); t.objectStore("blobs").put(new Blob([u], { type: "image/png" }), name); t.oncomplete = res; t.onerror = () => rej(t.error); });
    db.close();
    return name;
  })()`);
  await ev(`Promise.resolve(window.sagebrush.board.edit((d) => { d.images = { ...(d.images ?? {}), ${JSON.stringify(p2)}: { w: 40, h: 10 } }; d.nodes.push({ id: "old", image: ${JSON.stringify(p2)}, x: 300, y: 0, w: 40 }); })).then(() => 1)`);
  check(await shows(40), "a picture from this browser's store shows");
  check(await until(`window.sagebrush.workspace.list(${JSON.stringify(folder(id))}).then((l) => l.some((e) => e.path === ${JSON.stringify(`${folder(id)}/${p2}.png`)}))`), "...and is saved as the board's file: " + JSON.stringify(await filesIn(id)));
  check(await ev(`new Promise((res) => { const r = indexedDB.open("sagebrush-board-images", 1); r.onsuccess = () => { const g = r.result.transaction("blobs").objectStore("blobs").get(${JSON.stringify(p2)}); g.onsuccess = () => { res(g.result instanceof Blob); r.result.close(); }; g.onerror = () => res(false); }; r.onerror = () => res(false); })`), "this browser's copy is kept");
  // (saved: the board's own file written before the page goes)
  check(await until(`window.sagebrush.workspace.list("/").then((l) => l.find((e) => e.kind === "board" && e.ref === ${JSON.stringify(id)})).then((e) => window.sagebrush.workspace.read(e.path)).then((r) => r.content.nodes.some((x) => x.id === "old"))`), "the board is saved");

  // another device: this browser's store gone; the board shows them from its files
  await send("Page.navigate", { url: "about:blank" });
  await sleep(300);
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/board/` });
  await until("!!window.sagebrush?.workspace");
  check(await ev(`new Promise((res) => { const r = indexedDB.deleteDatabase("sagebrush-board-images"); r.onsuccess = () => res(true); r.onerror = () => res(false); r.onblocked = () => res(false); })`), "this browser's picture store deleted");
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/board/?doc=local:${id}` });
  check(await ready(), "the board opens again");
  check(await shows(30) && (await shows(40)), "both pictures show, from the board's files");

  // a copy: its pictures in its own folder
  await ev("document.querySelector('[data-sbb=duplicate]').click(), 1");
  check(await until(`new URLSearchParams(location.search).get("doc") !== ${JSON.stringify("local:" + id)} && /doc=local:/.test(location.search)`, 30000) && (await ready()), "Duplicate opens the copy");
  const copy = await idOf();
  const got = await filesIn(copy);
  check(copy !== id && JSON.stringify(got) === JSON.stringify([`${folder(copy)}/${p1}.png`, `${folder(copy)}/${p2}.png`].sort()), "the copy's pictures are in its own folder: " + JSON.stringify(got));
  check(await shows(30) && (await shows(40)), "and it shows them");

  // Files > Duplicate (and an agent's, a shell's cp): the workspace's own duplicate, not the page's; its copy gets the
  // pictures in its own folder too, and opens showing them with this browser's store gone again
  const dup = await ev(`window.sagebrush.workspace.list("/").then((l) => l.find((e) => e.kind === "board" && e.ref === ${JSON.stringify(copy)})).then((e) => window.sagebrush.workspace.duplicate(e.path)).then((x) => ({ ref: x.ref, left: x.picturesLeft ?? 0 }))`);
  const got2 = await filesIn(dup.ref);
  check(dup.ref !== copy && dup.left === 0 && JSON.stringify(got2) === JSON.stringify([`${folder(dup.ref)}/${p1}.png`, `${folder(dup.ref)}/${p2}.png`].sort()), "the workspace's Duplicate copies the pictures to the copy's folder: " + JSON.stringify({ dup, got2 }));
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/board/` });
  await until("!!window.sagebrush?.workspace");
  check(await ev(`new Promise((res) => { const r = indexedDB.deleteDatabase("sagebrush-board-images"); r.onsuccess = () => res(true); r.onerror = () => res(false); r.onblocked = () => res(false); })`), "this browser's picture store deleted again");
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/board/?doc=local:${dup.ref}` });
  check(await ready(), "the workspace's copy opens");
  check(await shows(30) && (await shows(40)), "and shows both pictures, from its own files");

  // a copy that can't get a picture (its file too big to read, as no picture file can be) and can't keep it either
  // (not in this browser's store): the person is told before the copy opens; kept (in the store), not told
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/board/?new=python` });
  check(await ready(), "another new board opens");
  const id3 = await idOf(), NB = "i" + "d4".repeat(16);
  await ev(`window.sagebrush.board.editing(true), 1`);
  check(await ev(`(async () => { const u = new Uint8Array(4_000_000).fill(7); u.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); await window.sagebrush.workspace.create(${JSON.stringify(`${folder(id3)}/${NB}.png`)}, { content: u }); return true; })()`), "a picture file too big to read, in its folder");
  await ev(`Promise.resolve(window.sagebrush.board.edit((d) => { d.images = { ${JSON.stringify(NB)}: { w: 4, h: 4 } }; d.nodes.push({ id: "big", image: ${JSON.stringify(NB)}, x: 0, y: 0, w: 4 }); })).then(() => 1)`);
  check(await until(`window.sagebrush.workspace.list("/").then((l) => l.find((e) => e.kind === "board" && e.ref === ${JSON.stringify(id3)})).then((e) => window.sagebrush.workspace.read(e.path)).then((r) => r.content.nodes.some((x) => x.id === "big"))`), "its board names it, saved");
  const before = dialogs.length;
  await ev("document.querySelector('[data-sbb=duplicate]').click(), 1");
  check(await until(`new URLSearchParams(location.search).get("doc") !== ${JSON.stringify("local:" + id3)} && /doc=local:/.test(location.search)`, 30000) && (await ready()), "Duplicate opens the copy");
  check(dialogs.length === before + 1 && /without one of its pictures/.test(dialogs[before] ?? ""), "the person was told the copy lacks one picture, before it opened: " + JSON.stringify(dialogs.slice(before)));
  // the control: this browser's store has it, so the copy shows it from there; no word
  await ev(`(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open("sagebrush-board-images", 1); r.onupgradeneeded = () => r.result.createObjectStore("blobs"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); await new Promise((res, rej) => { const t = db.transaction("blobs", "readwrite"); t.objectStore("blobs").put(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), ${JSON.stringify(NB)}); t.oncomplete = res; t.onerror = () => rej(t.error); }); db.close(); return 1; })()`);
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/board/?doc=local:${id3}` });
  check(await ready(), "the board opens again");
  const mid = dialogs.length;
  await ev("document.querySelector('[data-sbb=duplicate]').click(), 1");
  check(await until(`new URLSearchParams(location.search).get("doc") !== ${JSON.stringify("local:" + id3)} && /doc=local:/.test(location.search)`, 30000) && (await ready()), "Duplicate opens another copy");
  check(dialogs.length === mid, "kept in this browser's store: no word " + JSON.stringify(dialogs.slice(mid)));
  check(!errors.length, "errors: " + errors.join(" | "));
} catch (e) {
  fails.push(String(e?.stack ?? e));
  console.log("FAIL", String(e?.stack ?? e));
} finally {
  kill();
  await sleep(200);
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
process.exit(fails.length ? 1 : 0);
