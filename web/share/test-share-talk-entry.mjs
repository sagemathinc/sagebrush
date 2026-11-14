// ci: web-browser/latex order=62 chrome
// A talk's Share… from its real entry: the LaTeX editor's File menu on the notebook page, with the page's own Share
// (index.html's openTalkShare through latexBoot's `share`; no test hook), in headless Chromium on web/dist built with
// the LaTeX editor on loopback (SAGEBRUSH_LATEX_PREVIEW=test), served by web/serve.py (no share server):
//   - File ▸ Share… is enabled, and opens Share folder for the talk's folder, which, with no share server here, says
//     sharing isn't available on this site;
//   - an edit the editor can't save (signed in, as the test makes it): Share… stops at the save, nothing listed;
//   - under LOCAL (the CLI's page, which a build turns the editor on for only in a test build): disabled, saying why.
//   SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts && node web/share/test-share-talk-entry.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "../test-port.mjs";

const WHY = "Sharing isn't available here: upload this file, and the files it uses, to sagebrush.space and share it there";
const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = spawn("python3", [join(web, "serve.py"), "0"], { stdio: ["ignore", "pipe", "ignore"] });
const port = await new Promise((r) => server.stdout.once("data", (d) => r(Number(String(d).match(/\d+/)[0]))));
const site = `http://127.0.0.1:${port}/`;
const profile = mkdtempSync(join(tmpdir(), "sb-talk-entry-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", "--window-size=1200,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const J = JSON.stringify;

try {
  const cdpPort = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map();
  // (requests the test answers itself (Fetch.requestPaused), through `route`)
  let route = null;
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } if (m.method === "Fetch.requestPaused") void (route ? route(m.params) : send("Fetch.continueRequest", { requestId: m.params.requestId })); };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
  const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
  const item = () => ev(`(() => { const b = document.querySelector('.tex-filemenu [data-item="share"]'); return b ? { text: b.textContent, disabled: b.disabled, title: b.title } : null; })()`);
  const openEditor = async (fid) => {
    await send("Page.navigate", { url: site + "?tex=" + encodeURIComponent(fid) });
    await until(`!!document.querySelector(".tex-page .tex-filebtn") && !!document.querySelector(".tex-src")`, 60000);
    await ev(`(document.querySelector(".tex-filebtn").click(), true)`);
    await until(`!!document.querySelector('.tex-filemenu [data-item="share"]')`);
  };

  await send("Page.enable");
  await send("Page.navigate", { url: site });
  await until("!!window.sagebrush?.workspace", 60000);
  await ev(`window.sagebrush.workspace.mkdir("/talks").then(() => true)`);
  const fid = await ev(`window.sagebrush.workspace.create("/talks/st.tex", { content: new TextEncoder().encode(${J("\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n")}) }).then((e) => e.fid)`);
  ok(typeof fid === "string" && fid.length > 0, "(a talk in a folder, with its id)");

  // ---- the page's own Share, through the editor's File menu
  await openEditor(fid);
  const a = await item();
  ok(a && a.text === "Share…" && a.disabled === false && a.title === "", "the page passes its Share: File ▸ Share… is enabled (" + J(a) + ")");
  await ev(`(document.querySelector('.tex-filemenu [data-item="share"]').click(), true)`);
  await until("document.querySelector('#sbfolderdlg')?.open", 20000);
  ok((await ev("document.querySelector('#sbfolderdlg b').textContent")) === "Share “st.tex”", "…and it opens the Share dialog for the document");
  await until("!/^Checking/.test(document.querySelector('#sbfolderdlg [role=status]').textContent)", 20000);
  ok(/^Publishing a link needs Sagebrush's share service, which this site doesn't have\. On sagebrush\.space, sign in/.test(await ev("document.querySelector('#sbfolderdlg [role=status]').textContent")) && (await ev("document.querySelector('#sbfolderdlg a.btn')?.getAttribute('href')")) === "https://sagebrush.space", "…which, with no share server here, says what sharing needs and where it works, with a way there (never a dead end)");
  // (and the share that needs no service (William, Nov 12): the document and what it uses, downloaded as one .zip)
  await until("[...document.querySelectorAll('#sbfolderdlg button')].some((b) => b.textContent === 'Download as .zip')", 20000);
  const dlNote = await ev("[...document.querySelectorAll('#sbfolderdlg p.note')].map((p) => p.textContent).find((t) => /^Or download/.test(t)) ?? ''");
  ok(/^Or download it and the files it uses \(\d+ files?\) as one \.zip, and send that: anyone can open it\.$/.test(dlNote), "…and offers it as a download instead: " + J(dlNote));
  const dlDir = mkdtempSync(join(tmpdir(), "sb-talk-dl-"));
  await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dlDir });
  await ev("([...document.querySelectorAll('#sbfolderdlg button')].find((b) => b.textContent === 'Download as .zip').click(), true)");
  let zipped = null;
  for (let i = 0; i < 100 && !zipped; i++) { const f = readdirSync(dlDir).find((n) => n === "st.zip"); if (f) zipped = readFileSync(join(dlDir, f)); else await sleep(100); }
  ok(!!zipped && zipped.length > 0 && zipped.subarray(0, 2).toString() === "PK" && zipped.includes(Buffer.from("st.tex")), "…which downloads st.zip, a .zip holding st.tex (" + (zipped?.length ?? 0) + " bytes)");
  rmSync(dlDir, { recursive: true, force: true });
  // (the top bar's Share (William, round 2): shown while File ▸ Share… is, and it opens the same dialog, anchored under it)
  await ev("(document.querySelector('#sbfolderdlg').close(), true)");
  ok(await ev("!document.querySelector('.tex-head .tex-sharebtn').hidden"), "the top bar's Share is shown while File ▸ Share… is enabled");
  await ev("(document.querySelector('.tex-head .tex-sharebtn').click(), true)");
  await until("document.querySelector('#sbfolderdlg')?.open", 20000);
  const an = await ev("(() => { const d = document.querySelector('#sbfolderdlg'), r = d.getBoundingClientRect(), b = document.querySelector('.tex-head .tex-sharebtn').getBoundingClientRect(); return { title: d.querySelector('b').textContent, anchored: d.classList.contains('sb-anchored'), below: r.top >= b.bottom, right: Math.abs(r.right - b.right) <= 2 }; })()");
  ok(an.title === "Share “st.tex”" && an.anchored && an.below && an.right, "…and opens the same Share dialog, hanging under it at its right edge (" + J(an) + ")");
  await ev("(document.querySelector('#sbfolderdlg').close(), true)");

  // ---- the talk's save failing, through the real entry: signed in (the share API's answer given by the test), an
  // edit the editor can't write (its test build's write hook): the dialog says so, and lists nothing
  const me = J({ account_id: "44444444-4444-4444-8444-444444444444", usage: 0, limits: { storage_bytes: 1e8, max_file_bytes: 1e7 } });
  route = (p) => (/\/api\/share\/me/.test(p.request.url)
    ? send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(me).toString("base64") })
    : send("Fetch.continueRequest", { requestId: p.requestId }));
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/share/me*", requestStage: "Request" }] });
  await openEditor(fid);
  await ev(`(() => { globalThis.__sbTexSaveWrite = async () => { throw new Error("the test's failed write"); }; const t = document.querySelector(".tex-src"); t.value = t.value.replace("Hello", "Hello, unsaved"); t.dispatchEvent(new Event("input")); return true; })()`);
  await ev(`(document.querySelector('.tex-filemenu [data-item="share"]').click(), true)`);
  await until("document.querySelector('#sbfolderdlg')?.open", 20000);
  await until("!/^Checking|^Listing/.test(document.querySelector('#sbfolderdlg [role=status]').textContent)", 20000);
  const sf = await ev("({ status: document.querySelector('#sbfolderdlg [role=status]').textContent, rows: document.querySelectorAll('#sbfolderdlg .row').length })");
  ok(sf.status === "Couldn't save the document, so nothing was shared. Try again in a moment." && sf.rows === 0, "an edit the editor can't save: Share… stops at the save, board's line, nothing listed (" + J(sf) + ")");
  await ev("(delete globalThis.__sbTexSaveWrite, document.querySelector('#sbfolderdlg').close(), true)");
  await send("Fetch.disable");
  route = null;

  // ---- LOCAL: no Share
  const s = (await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__SAGEBRUSH_LOCAL__ = { path: "/tmp/sb-talk-entry.ipynb", name: "sb-talk-entry.ipynb" };` })).identifier;
  await openEditor(fid);
  const b = await item();
  ok(b && b.disabled === true && b.title === WHY, "under LOCAL (the CLI's page): File ▸ Share… is disabled, saying why (" + J(b) + ")");
  ok(await ev("document.querySelector('.tex-head .tex-sharebtn').hidden"), "…and the top bar's Share isn't shown");
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: s });
} catch (e) {
  ok(false, "the test failed: " + (e?.stack ?? e));
} finally {
  const exited = new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once("exit", r)));
  chrome.kill();
  server.kill();
  await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failures ? `${failures} FAILED` : "all ok");
process.exit(failures ? 1 : 0);
