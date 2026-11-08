// ci: web-browser/terminal.2 order=10
// ci: inline (ci.yml)
// A long line and the clipboard (the long-line design's B-LL-4, kept for the Terminal on xterm: plan-term-xterm r2.7
// PR 2): the screen the Terminal uses (upstream @xterm/xterm 6.0, the lockfile's, with the panel's own CSS), a line of
// 16 pages of 4 096 characters (combining marks and visible-escape glyphs included) written between two short lines,
// wrapping over hundreds of rows.  The screen's selection must give the long line as ONE line, every character in
// order: no break where a row wraps.  No shell needed, so it runs in every engine:
//   node web/shell/test-panel-pages-copy.mjs                                  (Chromium, CHROME=... for the browser)
//   BROWSER=webkit|firefox PLAYWRIGHT=<playwright's dir> node web/shell/test-panel-pages-copy.mjs   (CI: WebKit)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const css = readFileSync(join(here, "panel.css"), "utf8") + readFileSync(join(root, "node_modules", "@xterm", "xterm", "css", "xterm.css"), "utf8");
const xterm = readFileSync(join(root, "node_modules", "@xterm", "xterm", "lib", "xterm.mjs")).toString("base64");
const ENGINE = process.env.BROWSER ?? "chromium";
const PAGE = 4096;
const html = `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="t" style="width:900px;height:400px"></div>
<script type="module">import { Terminal } from "data:text/javascript;base64,${xterm}"; window.__Terminal = Terminal;</script>`;
// (the probe, in the page: the line written to the screen as the Terminal writes output, then the selection's text)
const probe = `(async () => {
  for (let i = 0; i < 100 && !window.__Terminal; i++) await new Promise((r) => setTimeout(r, 50));
  const t = new window.__Terminal({ cols: 80, rows: 24, scrollback: 6000, convertEol: true });
  t.open(document.getElementById("t"));
  const glyphs = "\\u241b[2J\\u2401x\\u00e9q\\u0301";
  const cells = [...glyphs.matchAll(/.\\u0301?/gu)].map((m) => m[0]);
  let line = "";
  for (let i = 0; line.length < 16 * ${PAGE}; i++) line += cells[i % cells.length];
  await new Promise((r) => t.write("before\\n" + line + "\\nafter\\n", r));
  t.selectAll();
  const copied = t.getSelection();
  t.dispose();
  const lines = copied.replace(/\\n+$/, "").split("\\n");
  const at = (() => { const c = lines[1] || ""; for (let i = 0; i < line.length; i++) if (c[i] !== line[i]) return i; return -1; })();
  return { lines: lines.length, before: lines[0], after: lines[2], same: lines[1] === line, len: (lines[1] || "").length, want: line.length, at };
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
    const ev = (await send("Runtime.evaluate", { expression: probe, returnByValue: true, awaitPromise: true })).result;
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
console.log(`${ok ? "ok" : "FAIL"} ${ENGINE}: a 16-page line on the Terminal's screen copies as one line, every character in order (${JSON.stringify(result)})`);
process.exit(ok ? 0 : 1);
