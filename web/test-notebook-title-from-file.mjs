// ci: web-browser/notebook order=156
// A notebook whose stored title isn't its file's name (found in testing, Nov 2026: older stored data, or a rename that
// didn't retitle it): opened, its title is its file's name, File > Download saves it under that name, and the stored
// title is set to it. The built page, served by web/serve.py, in headless Chrome. The mismatch is made as stored data
// would have it: the notebook's record in the browser's database given another title while no page is open.
// Run after `bun web/build.ts`:
//   CHROME=google-chrome node web/test-notebook-title-from-file.mjs
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServe } from "./test-port.mjs";
import { browser } from "./agents/a14-cases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// (the notebook's record in the page's database, read or retitled, from any page of the site)
const RECORD = (id, title) => `new Promise((res, rej) => { const o = indexedDB.open("sagebrush"); o.onerror = () => rej(o.error); o.onsuccess = () => {
  const db = o.result, tx = db.transaction("notebooks", "readwrite"), st = tx.objectStore("notebooks"), g = st.get(${JSON.stringify(id)});
  g.onsuccess = () => { const r = g.result; if (!r) { db.close(); return res(null); } ${title === undefined ? "" : `r.name = ${JSON.stringify(title)}; st.keyPath ? st.put(r) : st.put(r, ${JSON.stringify(id)});`} tx.oncomplete = () => { db.close(); res(r.name ?? null); }; };
}; })`;

let server;
const port = await startServe(() => (server = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
const site = `http://127.0.0.1:${port}`;
const B = await browser();
try {
  const P = await B.tab();
  const load = async (url) => { await P.send("Page.navigate", { url }); await sleep(300); await P.until(`document.readyState === 'complete'`, 60000); };
  const appReady = () => P.until(`!!document.querySelector('#nbname') && !!document.querySelector('#filebtn') && document.querySelectorAll('#cells .cell').length > 0 && document.querySelector('#nbname').value !== 'Untitled'`, 60000);
  const files = async () => {
    await P.ev(`(document.querySelector('#wssidebar')?.hidden && document.querySelector('#wsfilesbtn').click(), true)`);
    return P.ev(`[...document.querySelectorAll('#wssidebar .frow')].map((r) => r.dataset.path)`);
  };
  const fileIs = async (path) => { for (const t = Date.now(); Date.now() - t < 10000; await sleep(200)) if ((await files()).includes(path)) return true; return false; };

  // (a notebook named "real", its file /real.ipynb)
  await load(`${site}/`);
  await appReady();
  await sleep(1000);
  await P.ev(`(document.querySelector('#filebtn').click(), true)`);
  await P.until(`!!document.querySelector('#filemenu [data-f="new"]')`);
  await P.ev(`(document.querySelector('#filemenu [data-f="new"]').click(), true)`);
  await P.until(`document.querySelector('#nbname').value.startsWith('Untitled')`);
  await P.ev(`(() => { const n = document.querySelector('#nbname'); n.focus(); n.select(); return true; })()`);
  await P.send("Input.insertText", { text: "real" });
  await P.ev(`(document.querySelector('#nbname').blur(), true)`);
  ok(await fileIs("/real.ipynb"), "a notebook titled real, its file /real.ipynb", await files());
  const id = await P.ev(`localStorage.getItem('sagebrush-current')`);
  await sleep(1500); // (its title saved)

  // (with no page of the app open: its stored title made another, as older data has it)
  await load(`${site}/llms.txt`);
  const was = await P.ev(RECORD(id, "Untitled (3)"));
  ok(was === "Untitled (3)", "its stored title made \"Untitled (3)\" while the app isn't open", was);

  // (opened again: the file's name wins)
  await load(`${site}/`);
  await P.until(`!!document.querySelector('#nbname') && document.querySelectorAll('#cells .cell').length > 0`, 60000);
  await P.until(`localStorage.getItem('sagebrush-current') === ${JSON.stringify(id)}`);
  let shown = "";
  for (const t = Date.now(); Date.now() - t < 10000; await sleep(200)) { shown = await P.ev(`document.querySelector('#nbname').value`); if (shown === "real") break; }
  ok(shown === "real", "opened again: its title is its file's name, real (not the stored \"Untitled (3)\")", shown);
  await P.ev(`(() => { window.__dl = []; const c = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl.push(this.download); return; } return c.call(this); }; return true; })()`);
  await P.ev(`(document.querySelector('#filebtn').click(), true)`);
  await P.until(`[...document.querySelectorAll('#filemenu button')].some((b) => b.textContent.trim() === '.ipynb')`);
  await P.ev(`[...document.querySelectorAll('#filemenu button')].find((b) => b.textContent.trim() === '.ipynb').click()`);
  await P.until(`window.__dl.length > 0`);
  ok((await P.ev(`window.__dl[0]`)) === "real.ipynb", "File > Download > .ipynb: real.ipynb", await P.ev(`window.__dl`));
  ok((await files()).includes("/real.ipynb") && !(await files()).some((p) => /Untitled \(3\)/.test(p)), "its file is still /real.ipynb (nothing renamed after the stored title)", await files());
  let stored = null;
  for (const t = Date.now(); Date.now() - t < 10000; await sleep(300)) { stored = await P.ev(RECORD(id)); if (stored === "real") break; }
  ok(stored === "real", "and its stored title is now real", stored);
  ok(P.errors.length === 0, "no page errors", P.errors);
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  server.kill();
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
