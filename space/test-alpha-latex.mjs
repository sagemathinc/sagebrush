// The alpha's LaTeX editor, as space.sagebrush.cloud serves it: headless Chrome reaches the built site (web/dist, from
// space/build-alpha.sh) under that very hostname (mapped to a local server), since the editor is on only on the hosts
// its build names.  A .tex from the examples (examples/latex/article/article.tex) is made in the workspace, opened in
// the editor (/?tex=<fid>), and its preview shown.
//   (after space/build-alpha.sh)   node space/test-alpha-latex.mjs [screenshot-prefix]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const out = process.argv[2];
const HOST = "space.sagebrush.cloud";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 300) : "")); if (!c) failures++; };
const port = 8600 + Math.floor(Math.random() * 300);
const server = spawn("python3", [join(here, "..", "web", "serve.py"), String(port)], { stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "space-latex-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1400,900",
  `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${port}`, `--unsafely-treat-insecure-origin-as-secure=http://${HOST}`, "about:blank"], { stdio: "ignore" });
process.on("exit", () => { chrome.kill("SIGKILL"); server.kill("SIGKILL"); });
let cdpPort;
for (let i = 0; i < 200 && !cdpPort; i++) { try { cdpPort = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch {} await sleep(100); }
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map(), errors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description?.slice(0, 300) ?? m.params.exceptionDetails.text);
});
const send = (method, params = {}, ms = 30000) => Promise.race([new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }), sleep(ms).then(() => ({ timeout: method }))]);
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
const until = async (expr, ms = 15000) => { for (const t = Date.now(); Date.now() - t < ms; ) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } return false; };
const shot = async (name) => { if (!out) return; const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${out}-${name}.png`, Buffer.from(r.result.data, "base64")); };
await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: `http://${HOST}/` });
ok(await until(`!!window.sagebrush?.workspace`, 60000), `the notebook page loads, as ${HOST}`);
ok(await ev(`crossOriginIsolated`), "cross-origin isolated (COOP/COEP from _headers)");
const tex = readFileSync(join(here, "..", "examples", "latex", "article", "article.tex"), "utf8");
const fid = await ev(`window.sagebrush.workspace.create("/latex-check/article.tex", { content: ${JSON.stringify(tex)} }).then((e) => e.fid)`);
ok(typeof fid === "string", "the example's .tex is made in the workspace", fid);
await send("Page.navigate", { url: `http://${HOST}/?tex=${encodeURIComponent(fid)}` });
ok(await until(`!!document.querySelector(".tex-page")`, 60000), "it opens in the LaTeX editor");
const shown = await until(`(document.querySelector(".tex-preview")?.textContent ?? "").length > 200`, 90000);
const preview = await ev(`(document.querySelector(".tex-preview")?.textContent ?? "").replace(/\\s+/g, " ").slice(0, 160)`);
ok(shown, "its preview renders", preview);
await sleep(800);
await shot("latex");
ok(errors.length === 0, "no page errors", errors.slice(0, 3));
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
