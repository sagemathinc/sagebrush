// Download as HTML (web/board/export.ts): each board exported from the
// site opens from a file, offline (the network off), with its pages, math
// (KaTeX's fonts inline) and printing; exported again from that file, it is
// the same file.  A board with code says, in the file, that its code doesn't
// run there; the menu doesn't promise that the file works offline.  Serve web/dist first (python3 web/serve.py 8765), then
//   node web/board/test-export.mjs [doc.json ...]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const docs = process.argv.slice(2).length ? process.argv.slice(2) : ["examples/primes.json", "examples/sagebrush.json", "examples/mermaid.md", "examples/live.json"];
const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = Number(process.env.CDP_PORT ?? 9453), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), "sb-export-")), profile = mkdtempSync(join(tmpdir(), "sb-export-prof-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); let errors = [], requests = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/favicon/.test(m.params.entry.url ?? "")) errors.push(m.params.entry.text + " " + (m.params.entry.url ?? ""));
  if (m.method === "Network.requestWillBeSent" && !/^(data|blob|file):/.test(m.params.request.url)) requests.push(m.params.request.url);
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return; await sleep(50); } throw new Error("timeout: " + expr); };
const fails = [];
const check = (ok, what) => { if (!ok) fails.push(what); };
try {
  for (const m of ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"]) await send(m);
  for (const doc of docs) {
    errors = [];
    await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent(doc)}` });
    await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
    const html = await ev("window.sagebrush.board.exportHtml()");
    const s0 = await ev("(() => { const s = window.sagebrush.board.snapshot(); return { pages: s.pages, items: s.items.length, math: JSON.stringify(s.doc).includes('$'), code: JSON.stringify(s.doc).includes('\"code\":') }; })()");
    check(!/offline/i.test(await ev("document.getElementById('html').textContent")), `${doc}: the menu says the file works offline`);
    const file = join(dir, doc.split("/").pop().replace(/\.\w+$/, "") + ".html");
    writeFileSync(file, html);
    // the file, offline
    await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    requests = [];
    await send("Page.navigate", { url: "file://" + file });
    await until("window.sagebrush?.board?.snapshot().items.length > 0", 30000);
    await sleep(500);
    const s1 = await ev("(() => { const s = window.sagebrush.board.snapshot(); return { pages: s.pages, items: s.items.length, title: document.title }; })()");
    check(s1.pages === s0.pages && s1.items === s0.items, `${doc}: the file shows ${s1.items} items on ${s1.pages} pages, not ${s0.items} on ${s0.pages}`);
    check(!(await ev("document.getElementById('examples').hidden === false")), `${doc}: Examples shown in the file`);
    // code: shown, not run, and the file says so (only when there is code)
    const said = await ev("!document.getElementById('tour').hidden && /doesn't run/.test(document.getElementById('say').textContent)");
    check(said === s0.code, s0.code ? `${doc}: the file doesn't say its code doesn't run` : `${doc}: the file says code doesn't run, with no code`);
    // math, typeset with KaTeX's own fonts (inline)
    if (s0.math) {
      const id = await ev("(() => { const d = window.sagebrush.board.snapshot(); const p = d.doc.pages ? d.doc.pages[d.page] : d.doc; const walk = (ns) => { for (const n of ns) { if (n.kind === 'group') { const r = walk(n.children); if (r) return r; } else if (/\\$/.test((n.text ?? '') + (n.detail ?? ''))) return n.id; } }; return walk(p.nodes); })()");
      if (id) {
        await ev(`window.board.focus([${JSON.stringify(id)}], true)`);
        await until("document.querySelectorAll('.board-note .katex').length > 0", 10000).catch(() => {});
        check(await ev("document.querySelectorAll('.board-note .katex').length > 0"), `${doc}: no math typeset in the file`);
        await ev("document.fonts.ready");
        check(await ev("[...document.fonts].some((f) => f.family.includes('KaTeX') && f.status === 'loaded')"), `${doc}: KaTeX's fonts not loaded from the file`);
      }
    }
    if (s0.pages > 1) {
      await ev("window.sagebrush.board.page(1)");
      check((await ev("window.sagebrush.board.snapshot().page")) === 1, `${doc}: the file's second page`);
      await ev("window.sagebrush.board.page(0)");
    }
    // printing
    const sheets = await ev("window.sagebrush.board.print({ dialog: false })");
    const pdf = await send("Page.printToPDF", { preferCSSPageSize: true, printBackground: true });
    const pages = (Buffer.from(pdf.data ?? "", "base64").toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
    check(sheets === s0.pages && pages === sheets, `${doc}: the file printed ${sheets} sheets, ${pages} PDF pages, for ${s0.pages} pages`);
    await ev("document.getElementById('board-print')?.remove()");
    // exported again, from the file: the same file
    const again = await ev("window.sagebrush.board.exportHtml()");
    check(again === html, `${doc}: exported again from the file, ${again.length} bytes, not the same ${html.length}`);
    check(!requests.length, `${doc}: the file asked the network for ${requests.slice(0, 3).join(", ")}`);
    check(!errors.length, `${doc}: errors in the file: ${errors.slice(0, 3).join(" | ")}`);
    console.log(`${doc}: ${(html.length / 1024).toFixed(0)} KB, ${s1.items} items, ${s1.pages} page(s), ${sheets} sheet(s)`);
  }
} catch (e) {
  fails.push(String(e?.stack ?? e));
  if (errors.length) fails.push("page errors: " + errors.join(" | "));
} finally {
  ws.close();
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true }); else console.log("files in", dir); } catch {}
}
if (fails.length) { console.log("FAIL\n  " + fails.join("\n  ")); process.exit(1); }
console.log("ok");
