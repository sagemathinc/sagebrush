// ci: web-browser/terminal.4 order=70 runner=bun
// The LaTeX editor in the desktop app: the app's page, app/dist from app/build-frontend.mjs, served as the app serves it
// (app/serve-app.py), in headless Chromium with window.__TAURI__ before the page's scripts, as the app's web view has
// it, and __SB_DESKTOP_APP__ as the desktop build sets it (app/src-tauri/src/lib.rs, cfg(desktop)). There File ▸ New ▸
// LaTeX document makes a .tex and opens the editor; the preview draws its title and a formula; and what the app
// doesn't offer is said, not done: Share disabled with its reason, no Agent; Run (its button, then Shift+Enter) runs the
// SageTeX item in the app's interpreter (#1540: its engine, here the page's own worker, as where the engine doesn't
// start, this bridge having none), \sage{1+1} shown as 2; the banner's article on sagebrush.space. Then as the phone apps have it (no
// __SB_DESKTOP_APP__): no LaTeX document under New, and the same .tex's ?tex= link says the editor isn't on here.
//   bun web/build.ts && node app/build-frontend.mjs && bun web/latex/test-latex-app.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "../test-port.mjs";

const root = join(import.meta.dir, "..", "..");
if (!existsSync(join(root, "app", "dist", "sagebrush-latex.js"))) throw new Error("build app/dist first (node app/build-frontend.mjs)");
let checks = 0;
const fails = [];
const check = (ok, what) => {
  checks++;
  if (!ok) fails.push(what);
  console.log(`${ok ? "ok" : "FAIL"} ${what}`);
};
const TEX = "\\documentclass{article}\n\\usepackage{sagetex}\n\\begin{document}\n\\section{Hello from the app}\nTwo is $\\sage{1+1}$, and $x^2 + 1$.\n\\end{document}\n";
const TAURI = `window.__calls = []; window.__TAURI__ = { core: { invoke: async (c, a, o) => { window.__calls.push({ c, a: a instanceof Uint8Array ? null : a, h: o?.headers ?? null }); return c === "startup_files" ? [] : null; } }, event: { listen: async () => () => {} } };`;
let chrome = null, server = null;
const profile = mkdtempSync(join(tmpdir(), "sb-latex-app-"));
try {
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", "--window-size=1100,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
  const dport = await devtoolsPort(profile);
  const target = (await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m), waiting.delete(m.id)); };
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  const until = async (expr, ms = 30000) => {
    for (const t = Date.now(); ; await new Promise((r) => setTimeout(r, 100))) {
      const v = await evaluate(expr);
      if (v && !v.error) return v;
      if (Date.now() - t > ms) return null;
    }
  };
  const started = () => until(`(() => { const b = document.querySelector('[data-f="openfile"]'); return !!window.__TAURI__ && !!b && !b.hidden; })()`, 60000);
  const latexItem = `(() => { const b = document.querySelector('#filemenu [data-item="newLatex"]'); return b ? (b.hidden ? "hidden" : b.disabled ? "disabled" : "shown") : "none"; })()`;
  await send("Page.enable");
  server = spawn("python3", [join(root, "app", "serve-app.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] });
  const port = await startServe(() => server).port;
  const base = `http://127.0.0.1:${port}/`;

  // ---- the desktop app
  const desk = await send("Page.addScriptToEvaluateOnNewDocument", { source: TAURI + " window.__SB_DESKTOP_APP__ = true;" });
  await send("Page.navigate", { url: base });
  check(!!(await started()), "desktop: the app's page started");
  check((await evaluate(latexItem)) === "shown", `desktop: File ▸ New ▸ LaTeX document is offered (${await evaluate(latexItem)})`);
  await evaluate(`document.querySelector('#filemenu [data-f="newlatex"]').click()`);
  const opened = await until(`!!document.querySelector(".tex-src") && /[?&]tex=[0-9a-f]+/.test(location.search)`, 60000);
  check(!!opened, `desktop: New ▸ LaTeX document opened the editor (${await evaluate("location.search")})`);
  const texUrl = await evaluate("location.href");
  await evaluate(`(() => { const t = document.querySelector(".tex-src"); t.value = ${JSON.stringify(TEX)}; t.dispatchEvent(new Event("input")); return true; })()`);
  const drawn = await until(`(() => { const p = document.querySelector(".tex-preview"); return !!p && /Hello from the app/.test(p.textContent) && !!p.querySelector(".katex"); })()`, 60000);
  check(!!drawn, "desktop: the preview draws the section title and the formula");
  const share = await evaluate(`(() => { const b = document.querySelector('.tex-page [data-item="share"]'); return b ? { disabled: b.disabled, title: b.title, btn: document.querySelector(".tex-sharebtn")?.hidden } : null; })()`);
  check(!!share && share.disabled && /^Sharing isn't available here: upload this file/.test(share.title) && share.btn === true, `desktop: Share is disabled with its reason, and its button hidden (${JSON.stringify(share)})`);
  check((await evaluate(`(() => { const b = document.querySelector(".tex-agent"); return !b || b.hidden; })()`)) === true, "desktop: no Agent button");
  const link = await evaluate(`[...document.querySelectorAll(".tex-banner a")].map((a) => a.href)[0] ?? null`);
  check(link === "https://sagebrush.space/articles/latex/02-how-it-differs", `desktop: the banner's article is sagebrush.space's (${link})`);
  const runShown = await until(`(() => { const b = document.querySelector(".tex-run"); return !!b && !b.hidden; })()`, 30000);
  const runTitle = await evaluate(`document.querySelector(".tex-run").title`);
  check(!!runShown && /on this computer/.test(runTitle) && !/isn't available/.test(runTitle), `desktop: Run is shown for the SageTeX item, its title about this computer (${JSON.stringify(runTitle)})`);
  const preview = `document.querySelector(".tex-preview")?.textContent ?? ""`;
  check(!/Two is\s*2\b/.test(await evaluate(preview)), "desktop: before Run, the item has no result");
  await evaluate(`document.querySelector(".tex-run").click()`);
  const ran = await until(`/Two is\\s*2\\b/.test(${preview}) && document.querySelector(".tex-run").textContent === "Run"`, 180000);
  check(!!ran && !/isn't available/.test(await evaluate(`document.querySelector(".tex-status")?.textContent ?? ""`)), `desktop: Run runs it: \\sage{1+1} shown as 2 (${JSON.stringify((await evaluate(preview)).replace(/\s+/g, " ").slice(0, 80))}; status ${JSON.stringify(await evaluate(`document.querySelector(".tex-status")?.textContent`))})`);
  // (Shift+Enter runs it again, an edited item: 2+3 shown as 5)
  await evaluate(`(() => { const t = document.querySelector(".tex-src"); t.value = t.value.replace("1+1", "2+3"); t.dispatchEvent(new Event("input")); return true; })()`);
  await until(`!/Two is\\s*2\\b/.test(${preview})`, 20000);
  await evaluate(`(() => { const t = document.querySelector(".tex-src"); t.focus(); t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true })); return true; })()`);
  const keyed = await until(`/Two is\\s*5\\b/.test(${preview})`, 120000);
  check(!!keyed, `desktop: Shift+Enter runs it too (${JSON.stringify((await evaluate(preview)).replace(/\s+/g, " ").slice(0, 80))})`);
  // (Run's code may change no file in the app either (run-core.mjs tells its interpreter so first): a write is refused,
  //  in the preview, and nothing reaches the app's disk (no disk_write asked of it))
  await evaluate(`(() => { const t = document.querySelector(".tex-src"); t.value = t.value.replace("2+3", "open('/written-by-tex.txt', 'w').write('x')"); t.dispatchEvent(new Event("input")); return true; })()`);
  await until(`!/Two is\\s*5\\b/.test(${preview})`, 20000);
  await evaluate(`document.querySelector(".tex-run").click()`);
  const refused = await until(`/PermissionError|Errno 13|isn't allowed/.test(${preview} + (document.querySelector(".tex-status")?.textContent ?? ""))`, 120000);
  const wrote = await evaluate(`(window.__calls ?? []).some((c) => c.c === "disk_write" && /written-by-tex/.test(JSON.stringify(c.a ?? "")))`);
  check(!!refused && wrote === false, `desktop: Run's code can't write a file: refused, nothing written (${JSON.stringify((await evaluate(preview)).replace(/\s+/g, " ").slice(0, 120))})`);
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: desk.result.identifier });

  // ---- a phone app: __TAURI__ without the desktop build's flag
  await send("Page.addScriptToEvaluateOnNewDocument", { source: TAURI });
  await send("Page.navigate", { url: base });
  check(!!(await started()), "phone: the app's page started");
  const phoneItem = await evaluate(latexItem);
  check(phoneItem === "none" || phoneItem === "hidden", `phone: no LaTeX document under New (${phoneItem})`);
  await send("Page.navigate", { url: texUrl });
  const off = await until(`/The LaTeX editor isn't enabled here/.test(document.body.textContent) && !document.querySelector(".tex-src")`, 30000);
  check(!!off, "phone: the .tex's link says the editor isn't on here, and no editor opens");
  ws.close();
} finally {
  try { if (chrome?.pid) process.kill(-chrome.pid, "SIGKILL"); } catch {}
  server?.kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
}
if (fails.length) {
  console.log(`test-latex-app: ${fails.length} of ${checks} FAILED`);
  process.exit(1);
}
console.log(`test-latex-app: all ${checks} checks pass`);
