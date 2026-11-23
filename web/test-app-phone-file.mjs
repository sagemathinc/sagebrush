// ci: web-runner order=506 chrome
// A notebook the phone apps open from the device (web/index.html openDiskFile): by its path, through the fs plugin,
// never the desktop app's grant commands, which a phone doesn't have. In headless Chromium against the built site,
// with window.__TAURI__ before the page's scripts as a phone's web view has it (no __SB_DESKTOP_APP__): its fs plugin
// over files in memory, and every desktop grant command (file_*, folder_*) refused as a phone refuses it, "not found".
// The notebook handed to the app at its start opens, the files beside it are read for Python, a change is saved to the
// notebook's own path, and a file Python writes reaches the notebook's folder. (#1436's first page took the opened file for a grant, "undefined", on phones: every
// read went to file_read_text.)
//   bun web/build.ts && (python3 web/serve.py 8765 &) && CHROME=chromium node web/test-app-phone-file.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";
import { allowFiles } from "./test-allow.mjs";

const url = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const profile = mkdtempSync(join(tmpdir(), "sb-phone-file-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const results = [];
const check = (ok, what) => { results.push([!!ok, what]); console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };
const NB = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } }, cells: [{ cell_type: "code", source: "print(1 + 1)", metadata: {}, outputs: [], execution_count: null }] });
// (the phone's web view: its fs plugin over a folder in memory, and no desktop command)
const TAURI = `(() => {
  const files = new Map([["/phone/nb/doc.ipynb", ${JSON.stringify(NB)}], ["/phone/nb/data.csv", "a,b\\n1,2\\n"]]);
  const enc = new TextEncoder(), dec = new TextDecoder();
  const get = (p) => { if (!files.has(p)) throw new Error("no such file: " + p); return files.get(p); };
  window.__phone = { files, refused: [], fs: [] };
  const fs = (name, f) => async (...a) => { window.__phone.fs.push(name + " " + a[0]); return f(...a); };
  window.__TAURI__ = {
    core: { invoke: async (c) => {
      if (c === "startup_files") return ["/phone/nb/doc.ipynb"];
      if (/^(file|folder)_/.test(c)) { window.__phone.refused.push(c); throw new Error("Command " + c + " not found"); }
      return null;
    } },
    event: { listen: async () => () => {} },
    window: { getCurrentWindow: () => ({ setTitle: async () => {} }) },
    fs: {
      readTextFile: fs("readTextFile", (p) => get(p)),
      writeTextFile: fs("writeTextFile", (p, t) => { files.set(p, t); }),
      readDir: fs("readDir", (d) => [...files.keys()].filter((k) => k.startsWith(d + "/") && !k.slice(d.length + 1).includes("/")).map((k) => ({ name: k.slice(d.length + 1), isFile: true }))),
      stat: fs("stat", (p) => ({ size: enc.encode(get(p)).length })),
      readFile: fs("readFile", (p) => enc.encode(get(p))),
      writeFile: fs("writeFile", (p, d) => { files.set(p, dec.decode(d)); }),
    },
  };
})();`;
let code = 1;
try {
  const port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {} await sleep(100); }
  const cdp = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (cdp.onopen = r));
  let n = 0;
  const waiting = new Map();
  cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); cdp.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; };
  const until = async (expression, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expression).catch(() => false)) return true; await sleep(100); } return false; };
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: TAURI });
  await send("Page.navigate", { url });

  const opened = await until(`document.querySelector("#nbname")?.value === "doc" && [...document.querySelectorAll(".cell textarea")].some((t) => t.value.includes("print(1 + 1)"))`);
  // (the file beside it read for Python: the status line says so only until the page's next status, so the fs log)
  await until(`window.__phone.fs.includes("readFile /phone/nb/data.csv")`, 10000);
  const seen = await ev(`({ refused: window.__phone.refused, fs: window.__phone.fs })`);
  check(opened, "the notebook handed to the app opens");
  check(seen.refused.length === 0 && seen.fs.includes("readTextFile /phone/nb/doc.ipynb") && seen.fs.includes("readFile /phone/nb/data.csv"), "…from its path through the fs plugin, the file beside it read, no desktop command asked: " + JSON.stringify(seen));

  // a change saved: to the notebook's own path, through the fs plugin
  await ev(`(() => { const t = [...document.querySelectorAll(".cell textarea")].find((t) => t.value.includes("print(1 + 1)")); t.value = "print(2 + 2)"; t.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  const saved = await until(`(window.__phone.files.get("/phone/nb/doc.ipynb") ?? "").includes("print(2 + 2)")`, 20000);
  const after = await ev(`({ refused: window.__phone.refused, wrote: window.__phone.fs.filter((f) => f.startsWith("writeTextFile")) })`);
  check(saved && after.refused.length === 0 && after.wrote.every((w) => w === "writeTextFile /phone/nb/doc.ipynb"), "a change saved to the notebook's own path, by the fs plugin: " + JSON.stringify(after));

  // what Python writes, to the notebook's folder (writeDisk): by the fs plugin, beside the notebook (file changes
  // allowed first, as a person does: every notebook starts with them off)
  await allowFiles(send, ev);
  await ev(`(() => { const c = [...document.querySelectorAll(".cell")].at(-1); const ta = c.querySelector("textarea"); ta.value = "open('out.txt', 'w').write('from python')"; ta.dispatchEvent(new Event("input", { bubbles: true })); c.querySelector("[data-a=run]").click(); return 1; })()`);
  const pyWrote = await until(`window.__phone.files.get("/phone/nb/out.txt") === "from python"`, 120000);
  const last = await ev(`({ refused: window.__phone.refused, wrote: window.__phone.fs.filter((f) => f.startsWith("writeFile")), out: [...document.querySelectorAll(".cell .out")].at(-1)?.textContent.slice(0, 200) })`);
  check(pyWrote && last.refused.length === 0 && last.wrote.includes("writeFile /phone/nb/out.txt"), "what Python wrote reaches the notebook's folder, by the fs plugin: " + JSON.stringify(last));

  const fails = results.filter(([ok]) => !ok);
  console.log(fails.length ? `FAIL: ${fails.length} of ${results.length} checks` : `ok: a phone's notebook opened and saved by its path, ${results.length} checks`);
  code = fails.length ? 1 : 0;
  cdp.close();
} catch (e) {
  console.error("FAIL", e?.stack ?? e);
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(code);
