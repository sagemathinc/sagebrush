// A long line's pages and the clipboard (the long-line design: pages; board's B-LL-4): with the panel's own CSS, a
// line of 16 pages as web/shell/panel.ts paints it (the first 4 Ki inline, then inline-block page boxes, the line end
// after the last box), between two short lines.  Selecting the output must give the long line as ONE line, every
// character in order: no break at any join.  And a slice's chunks (board's R4-2), most off screen in a short log
// (content-visibility): plain lines, chunks of whole lines, a chunk ending inside a line that goes on in page boxes,
// then another chunk: the selection copies exactly the text.  No shell needed, so it runs in every engine:
//   node web/shell/test-panel-pages-copy.mjs                                  (Chromium, CHROME=... for the browser)
//   BROWSER=webkit|firefox PLAYWRIGHT=<playwright's dir> node web/shell/test-panel-pages-copy.mjs   (CI: WebKit)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "panel.css"), "utf8");
const ENGINE = process.env.BROWSER ?? "chromium";
const PAGE = 4096;
const html = `<!doctype html><meta charset="utf-8"><style>${css}</style><div class="sb-term-log" style="width:900px"><pre class="sb-term-out"></pre></div><div class="sb-term-log" style="width:900px;height:200px;overflow:auto"><pre class="sb-term-out" id="ck"></pre></div>`;
// (the probe, in the page: the long line built as the painter builds it, then the selection's text)
const probe = `(() => {
  const out = document.querySelector(".sb-term-out");
  const ck = document.getElementById("ck");
  const box = (cls, t) => { const b = document.createElement("span"); b.className = cls; b.textContent = t; return b; };
  const ls = (k, n) => Array.from({ length: n }, (_, i) => k + i + " " + "z".repeat(i % 70) + "\\n").join("");
  const long = "q\\u0301".repeat(3 * ${PAGE});
  const want = ls("plain", 40) + ls("chunk-a", 300) + ls("chunk-b", 200) + long + "\\n" + ls("chunk-c", 300);
  ck.appendChild(document.createTextNode(ls("plain", 40)));
  ck.appendChild(box("sb-term-chunk", ls("chunk-a", 300)));
  ck.appendChild(box("sb-term-chunk", ls("chunk-b", 200) + long.slice(0, ${PAGE})));
  for (let i = 1; i < 6; i++) ck.appendChild(box("sb-term-page", long.slice(i * ${PAGE}, (i + 1) * ${PAGE})));
  ck.appendChild(document.createTextNode("\\n"));
  ck.appendChild(box("sb-term-chunk", ls("chunk-c", 300)));
  const s2 = getSelection(); s2.selectAllChildren(ck); const c2 = s2.toString(); s2.removeAllRanges();
  const chunked = { same: c2.replace(/\\n$/, "") === want.replace(/\\n$/, ""), len: c2.length, want: want.length,
    at: (() => { for (let i = 0; i < want.length; i++) if (c2[i] !== want[i]) return i; return -1; })() };
  const glyphs = "\\u241b[2J\\u2401x\\u00e9"; // (visible escapes and a 2-byte scalar)
  const line = glyphs.repeat(Math.ceil(16 * ${PAGE} / glyphs.length)).slice(0, 16 * ${PAGE});
  out.appendChild(document.createTextNode("before\\n" + line.slice(0, ${PAGE})));
  for (let i = 1; i < 16; i++) {
    const p = document.createElement("span");
    p.className = "sb-term-page";
    p.textContent = line.slice(i * ${PAGE}, (i + 1) * ${PAGE});
    out.appendChild(p);
  }
  out.appendChild(document.createTextNode("\\nafter\\n"));
  const sel = getSelection(); sel.selectAllChildren(out); const copied = sel.toString(); sel.removeAllRanges();
  const lines = copied.replace(/\\n$/, "").split("\\n");
  return { lines: lines.length, before: lines[0], after: lines[2], same: lines[1] === line, len: (lines[1] || "").length, want: line.length, chunked };
})()`;

let result, chrome = null, browser = null, profile = null;
try {
  if (ENGINE === "chromium") {
    const { devtoolsPort } = await import(join(here, "..", "test-port.mjs"));
    profile = mkdtempSync(join(tmpdir(), "sb-test-pages-copy-"));
    chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
    const port = await devtoolsPort(profile);
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    let seq = 0;
    const waiting = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m), waiting.delete(m.id)); };
    const send = (method, params = {}) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const tree = await send("Page.getFrameTree");
    await send("Page.setDocumentContent", { frameId: tree.result.frameTree.frame.id, html });
    const ev = (await send("Runtime.evaluate", { expression: probe, returnByValue: true })).result;
    if (ev?.exceptionDetails) console.log("probe threw:", JSON.stringify(ev.exceptionDetails).slice(0, 400));
    result = ev?.result?.value;
    ws.close();
  } else {
    const require = createRequire(join(process.env.PLAYWRIGHT ?? process.cwd(), "package.json"));
    const pw = require("playwright");
    browser = await pw[ENGINE].launch();
    const page = await browser.newPage();
    await page.setContent(html);
    result = await page.evaluate(probe);
  }
} finally {
  await browser?.close();
  try { if (chrome?.pid) process.kill(-chrome.pid, "SIGKILL"); } catch {}
  if (profile) rmSync(profile, { recursive: true, force: true });
}
const ok = result && result.lines === 3 && result.before === "before" && result.after === "after" && result.same;
console.log(`${ok ? "ok" : "FAIL"} ${ENGINE}: a 16-page line copies as one line, every character in order (${JSON.stringify({ ...result, chunked: undefined })})`);
const ok2 = result?.chunked?.same === true;
console.log(`${ok2 ? "ok" : "FAIL"} ${ENGINE}: chunks, most off screen, and a line going on from a chunk into pages copy exactly the text (${JSON.stringify(result?.chunked)})`);
process.exit(ok && ok2 ? 0 : 1);
