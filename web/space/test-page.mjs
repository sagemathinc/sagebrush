// ci: web-browser/space order=30 chrome
// The viewer's page in headless Chromium against the built site: what it reads and whom it tells. ?space= reads only a
// .space.json of this site (another origin, or another kind of file, is refused and said); the example loads and an
// object opens; the selection is posted to the page around only when that page embedded the viewer (?embed=1, which
// it sends the space), and only to this site: a viewer merely framed posts nothing.
//   (after a site build: bun web/build.ts)   node web/space/test-page.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 300) : "")); if (!c) failures++; };
const port = 8500 + Math.floor(Math.random() * 90);
const server = spawn("python3", [join(here, "..", "serve.py"), String(port)], { stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "space-page-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1400,900", "about:blank"], { stdio: "ignore" });
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
const until = async (expr, ms = 15000) => { for (const t = Date.now(); Date.now() - t < ms; ) { if (await ev(expr).catch(() => false)) return true; await sleep(150); } return false; };
const key = async (k, down = true, extra = {}) => send("Input.dispatchKeyEvent", { type: down ? "keyDown" : "keyUp", key: k, ...extra });

// (the whole suite bounded: past 120 s it fails, Chrome and the server killed)
setTimeout(() => { console.log("FAIL the suite didn't end in 120 s"); process.exit(1); }, 120_000).unref();
await send("Runtime.enable");
const status = () => ev(`document.querySelector('#status')?.textContent ?? ''`);
const open = async (q) => { await send("Page.navigate", { url: `http://127.0.0.1:${port}/space/${q}` }); await sleep(300); };

// ---- ?space= is read from this site only, and only a .space.json
await open(`?space=${encodeURIComponent("https://example.com/x.space.json")}`);
ok(await until(`/only files of this site/.test(document.querySelector('#status')?.textContent ?? '')`, 15000), "a space of another origin is refused", await status());
await open(`?space=${encodeURIComponent("/index.html")}`);
ok(await until(`/\.space\.json file/.test(document.querySelector('#status')?.textContent ?? '')`, 15000), "a file that isn't a .space.json is refused", await status());

// ---- the example: it loads; a click's selection; Back
await open("?space=intro.space.json");
ok(await until(`/objects/.test(document.querySelector('#status')?.textContent ?? '')`, 30000), "the example space loads", await status());
const first = await ev(`space3d.space.nodes[0].id`);
ok(await ev(`space3d.select(${JSON.stringify(first)})`) && await until(`space3d.selection?.id === ${JSON.stringify(first)} && !document.querySelector('#overlay').hidden`, 10000), "selecting an object opens it");

// ---- the selection goes to the page around only when it embedded the space, and only to this site
// (two frames of the viewer in this page, of this site: one only framed, one embedded (?embed=1), which is sent the
// space as a page of the site sends it; each is asked to select, and the messages the page gets are kept)
const space = JSON.parse(readFileSync(join(here, "examples", "intro.space.json"), "utf8"));
await ev(`(() => {
  window.__got = [];
  addEventListener("message", (e) => window.__got.push({ from: e.source === document.querySelector('#plain')?.contentWindow ? "plain" : e.source === document.querySelector('#embed')?.contentWindow ? "embed" : "?", origin: e.origin, kind: e.data?.sagebrush }));
  for (const [id, q] of [["plain", "?space=intro.space.json"], ["embed", "?embed=1"]]) { const f = document.createElement("iframe"); f.id = id; f.src = "/space/" + q; f.style.cssText = "width:400px;height:300px"; document.body.append(f); }
  return true;
})()`);
ok(await until(`window.__got.some((m) => m.from === "embed" && m.kind === "space-ready")`, 30000), "the embedded viewer says it is ready", await ev(`window.__got`));
await ev(`(document.querySelector('#embed').contentWindow.postMessage({ sagebrush: "space-load", version: 1, name: "intro", space: ${JSON.stringify(space)} }, location.origin), true)`);
ok(await until(`!!document.querySelector('#plain').contentWindow.space3d?.space && !!document.querySelector('#embed').contentWindow.space3d?.space`, 30000), "both frames show the space");
await ev(`(document.querySelector('#plain').contentWindow.space3d.select(${JSON.stringify(first)}), document.querySelector('#embed').contentWindow.space3d.select(${JSON.stringify(first)}), true)`);
ok(await until(`window.__got.some((m) => m.from === "embed" && m.kind === "space-select")`, 10000), "the embedded viewer tells the page around what is selected (the control)", await ev(`window.__got`));
await sleep(1000);
ok(await ev(`!window.__got.some((m) => m.from === "plain" && m.kind === "space-select")`), "a viewer only framed tells it nothing", await ev(`window.__got`));
ok(await ev(`window.__got.every((m) => m.origin === location.origin)`), "every message is from this site");

ok(errors.length === 0, "no page errors", errors.slice(0, 3));
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
