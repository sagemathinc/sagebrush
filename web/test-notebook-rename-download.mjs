// ci: web-browser/notebook order=154
// A notebook renamed, then downloaded (found in testing, Nov 21 2026): File > Download saves it under its current
// name, whichever way it was renamed: in its title, in its title with the extension typed too ("x.ipynb" names the
// file x.ipynb, never x.ipynb.ipynb), and in the Files sidebar. The notebook's own file in the workspace is checked
// too. The built page, served by web/serve.py, in headless Chrome; a download is caught as the page makes it.
// Run after `bun web/build.ts`:
//   CHROME=google-chrome node web/test-notebook-rename-download.mjs
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServe } from "./test-port.mjs";
import { browser } from "./agents/a14-cases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
const port = await startServe(() => (server = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
const B = await browser();
try {
  const P = await B.tab();
  await P.send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await P.until(`!!document.querySelector('#nbname') && document.readyState === 'complete' && !!document.querySelector('#filebtn')`, 60000);
  // (the downloads the page makes: each <a download> it clicks, its name kept and nothing saved)
  await P.ev(`(() => { window.__dl = []; const c = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl.push(this.download); return; } return c.call(this); }; return true; })()`);
  const download = async (label) => {
    const n = await P.ev(`window.__dl.length`);
    await P.ev(`(document.querySelector('#filebtn').click(), true)`);
    await P.until(`[...document.querySelectorAll('#filemenu button')].some((b) => b.textContent.trim() === ${JSON.stringify(label)})`);
    await P.ev(`[...document.querySelectorAll('#filemenu button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
    await P.until(`window.__dl.length > ${n}`);
    return P.ev(`window.__dl.at(-1)`);
  };
  const retitle = async (text) => {
    await P.ev(`(() => { const n = document.querySelector('#nbname'); n.focus(); n.select(); return true; })()`);
    await P.send("Input.insertText", { text });
    await P.ev(`(document.querySelector('#nbname').blur(), true)`);
  };
  const files = async () => {
    await P.ev(`(document.querySelector('#wssidebar')?.hidden && document.querySelector('#wsfilesbtn').click(), true)`);
    return P.ev(`[...document.querySelectorAll('#wssidebar .frow')].map((r) => r.dataset.path)`);
  };
  // (the workspace's rename of the open notebook follows its title after a moment)
  const fileIs = async (path) => { for (const t = Date.now(); Date.now() - t < 10000; await sleep(200)) if ((await files()).includes(path)) return true; return false; };

  // (the page's first notebook opened (a title typed before then is the page's to replace), then a new one, as a
  //  person starts: File > New)
  await P.until(`document.querySelector('#nbname').value !== 'Untitled' && document.querySelectorAll('#cells .cell').length > 0`, 30000);
  await sleep(1000);
  await P.ev(`(document.querySelector('#filebtn').click(), true)`);
  await P.until(`!!document.querySelector('#filemenu [data-f="new"]')`);
  await P.ev(`(document.querySelector('#filemenu [data-f="new"]').click(), true)`);
  await P.until(`document.querySelector('#nbname').value.startsWith('Untitled')`);
  let before = [];
  for (const t = Date.now(); Date.now() - t < 10000 && !before.some((p) => /^\/Untitled.*\.ipynb$/.test(p)); await sleep(200)) before = await files();
  ok(before.some((p) => /^\/Untitled.*\.ipynb$/.test(p)), "File > New: a new Untitled notebook", before);
  await retitle("matlab");
  ok(await fileIs("/matlab.ipynb"), "renamed in its title: its file is /matlab.ipynb", await files());
  ok((await download(".ipynb")) === "matlab.ipynb", "File > Download > .ipynb: matlab.ipynb");
  ok((await download(".py")) === "matlab.py", "File > Download > .py: matlab.py");

  await retitle("matlab2.ipynb");
  ok(await fileIs("/matlab2.ipynb"), "the extension typed in its title too: its file is /matlab2.ipynb, not /matlab2.ipynb.ipynb", await files());
  ok((await download(".ipynb")) === "matlab2.ipynb", "and its download is matlab2.ipynb", await P.ev(`window.__dl`));

  // (renamed in the Files sidebar: its row, F2, a new name, Enter)
  await files();
  const started = await P.ev(`(() => { const r = [...document.querySelectorAll('#wssidebar .frow')].find((r) => r.dataset.path === '/matlab2.ipynb'); if (!r) return false; r.focus(); r.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); return true; })()`);
  await P.until(`!!document.querySelector('#wssidebar input:focus')`);
  await P.ev(`(document.querySelector('#wssidebar input:focus').select(), true)`);
  await P.send("Input.insertText", { text: "fromsidebar" });
  await P.ev(`(document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), true)`);
  ok(started && (await fileIs("/fromsidebar.ipynb")), "renamed in the Files sidebar: its file is /fromsidebar.ipynb", await files());
  await P.until(`document.querySelector('#nbname').value === 'fromsidebar'`);
  ok((await download(".ipynb")) === "fromsidebar.ipynb", "and File > Download > .ipynb: fromsidebar.ipynb", await P.ev(`window.__dl`));
  ok(P.errors.length === 0, "no page errors", P.errors);
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  server.kill();
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
