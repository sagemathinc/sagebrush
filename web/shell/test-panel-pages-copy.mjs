// A long line's pages and the clipboard (the long-line design: pages; board's B-LL-4): with the panel's own CSS, a
// line of 16 pages as web/shell/panel.ts paints it (the first 4 Ki inline, then inline-block page boxes, the line end
// after the last box), between two short lines.  Selecting the output must give the long line as ONE line, every
// character in order: no break at any join.  No shell needed, so it runs in every engine:
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
const html = `<!doctype html><meta charset="utf-8"><style>${css}</style><div class="sb-term-log" style="width:900px"><pre class="sb-term-out"></pre></div>`;
// (the probe, in the page: the long line built as the painter builds it, then the selection's text)
const probe = `(() => {
  const out = document.querySelector(".sb-term-out");
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
  return { lines: lines.length, before: lines[0], after: lines[2], same: lines[1] === line, len: (lines[1] || "").length, want: line.length };
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
    result = (await send("Runtime.evaluate", { expression: probe, returnByValue: true })).result?.result?.value;
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
console.log(`${ok ? "ok" : "FAIL"} ${ENGINE}: a 16-page line copies as one line, every character in order (${JSON.stringify(result)})`);
process.exit(ok ? 0 : 1);
