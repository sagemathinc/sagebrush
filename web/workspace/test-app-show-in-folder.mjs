// ci: web-browser/board-a order=67
// Where the desktop app's files are, and Show in folder (#1539): since #1268 the app's workspace is real files in a
// folder on the computer (disk_where), so the files panel says so and opens it. In headless Chromium against web/dist
// (web/serve.py), with the page given what the desktop app's web view has (window.__TAURI__, which records each
// disk_reveal asked of it, and __SB_DESKTOP_APP__) and without:
//   - the desktop app, notebook page: the panel's ⋯ offers Show in folder, which asks disk_reveal for "/"; a file's
//     own menu offers it for that file; the Storage panel is "Storage on this computer", names the folder in full and
//     has Show in folder; a refusal (the file not on disk yet, say) is said, nothing thrown;
//   - the desktop app, a board: its panel's ⋯ offers Show in folder too;
//   - a browser: none of it, and the Storage panel is still "Storage in this browser".
//   bun web/build.ts && node web/workspace/test-app-show-in-folder.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const web = join(here, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0, failures = 0;
const ok = (c, what) => { checks++; if (!c) failures++; console.log((c ? "ok   " : "FAIL ") + what); };
const J = JSON.stringify;
const DEADLINE = Number(process.env.SB_TEST_DEADLINE) || 300_000;
setTimeout(() => { console.log(`FAIL the test did not end within ${DEADLINE / 1000} s`); process.exit(1); }, DEADLINE).unref();

const FOLDER = "/Users/someone/Library/Application Support/space.sagebrush.notebook/Workspace";
const serve = startServe(() => spawn("python3", [join(web, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }));
const site = `http://127.0.0.1:${await serve.port}/`;
const profile = mkdtempSync(join(tmpdir(), "sb-app-reveal-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", "--window-size=1200,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
const cleanup = () => { try { process.kill(-chrome.pid, "SIGKILL"); } catch {} try { serve.child.kill("SIGKILL"); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);
const port = await devtoolsPort(profile, undefined, { child: chrome });

async function page(app) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, no) => { ws.onopen = r; ws.onerror = () => no(new Error("the DevTools socket did not open")); });
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  const send = (method, params = {}, ms = 30000) => new Promise((resolve, reject) => {
    const id = ++n, timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method}: no answer within ${ms / 1000} s`)); }, ms);
    waiting.set(id, (r) => { clearTimeout(timer); resolve(r); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
  const until = async (expr, ms = 60000) => { for (let t0 = Date.now(); Date.now() - t0 < ms; await sleep(150)) if (await ev(expr).catch(() => false)) return true; return false; };
  await send("Page.enable");
  // (the desktop app's web view: its bridge, answering the page's startup asks with nothing, disk_where with the
  // folder, and disk_reveal recorded (refused for "/missing.txt", as the app refuses a path that isn't on disk))
  if (app) await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__SB_DESKTOP_APP__ = true; window.__reveals = []; window.__TAURI__ = { core: { invoke: async (c, a) => { if (c === "disk_where") return ${J(FOLDER)}; if (c === "disk_reveal") { window.__reveals.push(a?.path); if (a?.path === "/missing.txt") throw "/missing.txt: not there"; return null; } return ["startup_files", "disk_list"].includes(c) ? [] : null; } }, event: { listen: async () => () => {} }, window: { getCurrentWindow: () => ({ setTitle: async () => {} }) } };` });
  return { send, ev, until, close: () => { try { ws.close(); } catch {} } };
}
const items = "[...document.querySelectorAll('.sbfmenu [role=menuitem]')].map((b) => b.textContent)";
const pick = (label) => `(() => { const b = [...document.querySelectorAll('.sbfmenu [role=menuitem]')].find((b) => b.textContent === ${J(label)}); if (!b) return false; b.click(); return true; })()`;
const closeMenus = "(document.querySelectorAll('.sbfmenu').forEach((m) => (m.sbClose ?? (() => m.remove()))()), 1)";
const moreMenu = "(document.querySelector('#wssidebar .fh button[aria-label=\"More\"]').click(), 1)";

for (const app of [true, false]) {
  const where = app ? "the desktop app" : "a browser";
  // ---- the notebook page
  {
    const p = await page(app);
    await p.send("Page.navigate", { url: site });
    await p.until("!!document.querySelector('#wsfilesbtn') && !!window.sagebrush?.notebook && !!window.sagebrush?.workspace", 90000);
    await p.ev("window.sagebrush.workspace.create('/kept.txt', { content: new TextEncoder().encode('k') }).then(() => 1, () => 0)");
    await p.ev("window.sagebrush.workspace.create('/missing.txt', { content: new TextEncoder().encode('m') }).then(() => 1, () => 0)");
    await p.ev("(() => { const s = document.querySelector('#wssidebar'); if (s.hidden) document.querySelector('#wsfilesbtn').click(); return 1; })()");
    await p.until("!!document.querySelector('#wssidebar .frow[data-path=\"/kept.txt\"]')", 30000);
    // (the panel's ⋯)
    await p.ev(moreMenu);
    await p.until("!!document.querySelector('.sbfmenu')", 5000);
    const more = await p.ev(items);
    if (app) {
      const clicked = await p.ev(pick("Show in folder"));
      await sleep(300);
      ok(more.includes("Show in folder") && clicked && J(await p.ev("window.__reveals")) === J(["/"]), `notebook page, ${where}: the panel's ⋯ offers Show in folder, which shows the workspace's folder ("/"): ${J({ more, reveals: await p.ev("window.__reveals") })}`);
    } else ok(!more.includes("Show in folder"), `notebook page, ${where}: the panel's ⋯ has no Show in folder: ${J(more)}`);
    await p.ev(closeMenus);
    // (a file's own menu)
    await p.ev("(() => { const r = document.querySelector('#wssidebar .frow[data-path=\"/kept.txt\"]'); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return 1; })()");
    await p.until("!!document.querySelector('.sbfmenu')", 5000);
    const row = await p.ev(items);
    if (app) {
      await p.ev(pick("Show in folder"));
      await sleep(300);
      ok(row.includes("Show in folder") && (await p.ev("window.__reveals.at(-1)")) === "/kept.txt", `notebook page, ${where}: a file's menu offers Show in folder, for that file: ${J({ row, last: await p.ev("window.__reveals.at(-1)") })}`);
      // (refused: said, nothing thrown)
      await p.ev(closeMenus);
      await p.ev("(() => { const r = document.querySelector('#wssidebar .frow[data-path=\"/missing.txt\"]'); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return 1; })()");
      await p.until("!!document.querySelector('.sbfmenu')", 5000);
      await p.ev(pick("Show in folder"));
      const said = await p.until("/not there/.test(document.querySelector('#wssidebar .ftoastslot')?.textContent ?? '')", 5000);
      ok(said && (await p.ev("window.__reveals.at(-1)")) === "/missing.txt", `notebook page, ${where}: a refusal is said in the panel: ${J(await p.ev("document.querySelector('#wssidebar .ftoastslot')?.textContent ?? ''"))}`);
    } else ok(!row.includes("Show in folder"), `notebook page, ${where}: a file's menu has no Show in folder: ${J(row)}`);
    await p.ev(closeMenus);
    // (the Storage panel)
    await p.ev(moreMenu);
    await p.until("!!document.querySelector('.sbfmenu')", 5000);
    await p.ev(pick("Storage…"));
    await p.until("!!document.querySelector('.sbfprev .ph b')", 10000);
    const st = await p.ev("(() => { const box = document.querySelector('.sbfprev .ph').parentElement; return { title: box.querySelector('.ph b').textContent, where: box.querySelector('.where code')?.textContent ?? null, button: [...box.querySelectorAll('.where button')].map((b) => b.textContent) }; })()");
    if (app) {
      const n0 = await p.ev("window.__reveals.length");
      await p.ev("(document.querySelector('.sbfprev .where button').click(), 1)");
      await sleep(300);
      ok(st.title === "Storage on this computer" && st.where === FOLDER && J(st.button) === J(["Show in folder"]) && (await p.ev("window.__reveals.length")) === n0 + 1 && (await p.ev("window.__reveals.at(-1)")) === "/", `notebook page, ${where}: the Storage panel is about this computer, names the folder in full, and its Show in folder shows it: ${J(st)}`);
    } else ok(st.title === "Storage in this browser" && st.where === null && st.button.length === 0, `notebook page, ${where}: the Storage panel is still about this browser, no folder named: ${J(st)}`);
    p.close();
  }
  // ---- a board
  {
    const p = await page(app);
    await p.send("Page.navigate", { url: site + "board/?new=1" });
    await p.until("!!document.querySelector('[data-sbb=\"files\"]')", 90000);
    await p.ev("(() => { const s = document.querySelector('#wssidebar'); if (s.hidden) document.querySelector('[data-sbb=\"files\"]').click(); return 1; })()");
    await p.until("!!document.querySelector('#wssidebar .fh button[aria-label=\"More\"]')", 30000);
    await p.ev(moreMenu);
    await p.until("!!document.querySelector('.sbfmenu')", 5000);
    const more = await p.ev(items);
    if (app) {
      await p.ev(pick("Show in folder"));
      await sleep(300);
      ok(more.includes("Show in folder") && J(await p.ev("window.__reveals")) === J(["/"]), `board, ${where}: the panel's ⋯ offers Show in folder, which shows the workspace's folder: ${J({ more, reveals: await p.ev("window.__reveals") })}`);
    } else ok(!more.includes("Show in folder"), `board, ${where}: the panel's ⋯ has no Show in folder: ${J(more)}`);
    p.close();
  }
}
console.log(failures ? `${failures} of ${checks} failed` : `all ${checks} passed`);
cleanup();
process.exit(failures ? 1 : 0);
