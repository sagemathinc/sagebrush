// ci: web-runner order=196 runner=bun chrome
// File > Examples…'s preview of a LaTeX example renders inside the panel (William, Nov 6: every LaTeX example's
// preview was blank there, on DEV and PROD). The panel (web/examples/panel.ts) shows an example in an
// <iframe sandbox="">, an opaque origin. A LaTeX example's page frames its rendered document, and that frame was
// refused twice over: the page's sandboxed origin isn't the document's frame-ancestors 'self' (nor X-Frame-Options'
// same origin), and under the site's COEP require-corp the cross-origin frame (Cloudflare's redirect of preview.html
// to preview first, with none of _headers' headers) had no CORP. So the panel shows the rendered document itself.
// And what an example's page loads from the site (KaTeX, the banner) is cross-origin to that sandbox: CORP
// (web/_headers). Here, in Chrome: the fixture corpus as web/build-examples.ts serves it, with the headers the site
// gives it (web/_headers and every page's policy, web/csp.ts headersFor), on a server that redirects .html as the
// host does; first a control, that this harness sees a refused frame at all.
//   CHROME=google-chrome bun web/examples/test-examples-preview.mjs
import { spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";
import { buildExamplesInto } from "../build-examples.ts";
import { headersFor } from "../csp.ts";

const here = new URL(".", import.meta.url).pathname;
const web = join(here, "..");
const FIX = join(web, "..", "test", "fixtures", "examples");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the site: the fixture corpus built, what its pages load, and a page that opens the panel
const out = mkdtempSync(join(tmpdir(), "sb-examples-preview-"));
await buildExamplesInto(out, FIX);
mkdirSync(join(out, "katex"), { recursive: true });
copyFileSync(join(web, "..", "node_modules", "katex", "dist", "katex.min.css"), join(out, "katex", "katex.min.css"));
cpSync(join(web, "..", "node_modules", "katex", "dist", "fonts"), join(out, "katex", "fonts"), { recursive: true });
copyFileSync(join(web, "alpha-banner.js"), join(out, "alpha-banner.js"));
mkdirSync(join(out, "icons"), { recursive: true });
copyFileSync(join(web, "icons", "icon-192.png"), join(out, "icons", "icon-192.png"));
const built = await Bun.build({ entrypoints: [join(here, "panel.ts")], outdir: out, naming: "panel.js", target: "browser", format: "esm" });
if (!built.success) {
  console.error(built.logs.join("\n"));
  process.exit(1);
}
writeFileSync(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><title>examples preview test</title><script type="module">import * as P from "/panel.js"; window.P = P; window.ready = true;</script>`);
// (the site's headers for these files, as web/build.ts writes them: [pattern, [[name, value]]], every matching rule's)
const rules = [];
for (const line of headersFor(out).split("\n")) {
  if (!line.trim() || line.startsWith("#")) continue;
  if (!/^\s/.test(line)) rules.push([line.trim(), []]);
  else if (rules.length) { const i = line.indexOf(":"); rules.at(-1)[1].push([line.slice(0, i).trim(), line.slice(i + 1).trim()]); }
}
// (the two rules this fix adds are just those: each CORP alone, and the rule before them, /s/og.png's, unchanged (astra,
// #777: inserted inside it, they took its Cache-Control))
{
  const block = (pat) => rules.filter(([q]) => q === pat).flatMap(([, h]) => h.map(([k, v]) => `${k}: ${v}`));
  const want = { "/s/og.png": ["Cross-Origin-Resource-Policy: cross-origin", "Cache-Control: public, max-age=86400"], "/katex/*": ["Cross-Origin-Resource-Policy: cross-origin"], "/alpha-banner.js": ["Cross-Origin-Resource-Policy: cross-origin"] };
  for (const [pat, h] of Object.entries(want)) if (JSON.stringify(block(pat)) !== JSON.stringify(h)) { console.error(`FAIL: _headers' ${pat} rule is ${JSON.stringify(block(pat))}, not ${JSON.stringify(h)}`); process.exit(1); }
}
const headersOf = (p) => Object.fromEntries(rules.filter(([pat]) => p === pat || (pat.endsWith("*") && p.startsWith(pat.slice(0, -1)))).flatMap(([, h]) => h));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2", ".zip": "application/zip" };
const COI = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" };
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = decodeURIComponent(new URL(req.url).pathname);
  // (the control: a cross-origin-isolated page whose frame's URL is redirected with no CORP, as preview.html was)
  if (p === "/control/") return new Response(`<!doctype html><iframe sandbox="" src="frame.html"></iframe>`, { headers: { ...COI, "content-type": "text/html" } });
  if (p === "/control/frame") return new Response("<p>control</p>", { headers: { ...COI, "cross-origin-resource-policy": "cross-origin", "content-type": "text/html" } });
  // (the host: x.html redirected to x, with none of _headers' headers; x served from x.html; a directory, its index)
  if (p.endsWith(".html")) return new Response(null, { status: 307, headers: { location: p.slice(0, -5) } });
  let f = join(out, p);
  if (p.endsWith("/")) f = join(f, "index.html");
  else if (!existsSync(f) && existsSync(f + ".html")) f += ".html";
  if (!f.startsWith(out) || !existsSync(f) || !statSync(f).isFile()) return new Response("not found", { status: 404 });
  return new Response(readFileSync(f), { headers: { ...headersOf(p), "content-type": TYPES[extname(f)] ?? "application/octet-stream" } });
} });

// ---- Chrome, with every frame's target attached (a sandboxed frame is its own process: its loads are reported there)
let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-exprev-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
try {
  if (!port) port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some((x) => x.type === "page")) break; } catch {} await sleep(100); }
  const ws = new WebSocket(targets.find((x) => x.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map(), frames = new Map(), blocked = [], sessions = new Map(), errors = [];
  const send = (method, params = {}, sessionId) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const local = (u) => u.replace(/^http:\/\/127\.0\.0\.1:\d+/, "");
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Network.loadingFailed" && m.params.blockedReason) blocked.push(`${m.params.blockedReason} (${m.params.type})`);
    if (m.method === "Page.frameNavigated") frames.set(m.params.frame.id, local(m.params.frame.url));
    if (m.method === "Runtime.exceptionThrown" && !m.sessionId) errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    if (m.method === "Target.attachedToTarget") {
      const sid = m.params.sessionId;
      sessions.set(sid, m.params.targetInfo);
      for (const x of ["Page.enable", "Network.enable", "Runtime.enable"]) send(x, {}, sid);
      send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid).then(() => send("Runtime.runIfWaitingForDebugger", {}, sid));
    }
    if (m.method === "Target.targetInfoChanged") for (const [sid, t] of sessions) if (t.targetId === m.params.targetInfo.targetId) sessions.set(sid, m.params.targetInfo);
  };
  for (const x of ["Page.enable", "Network.enable", "Runtime.enable", "Target.setDiscoverTargets"]) await send(x, x === "Target.setDiscoverTargets" ? { discover: true } : {});
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const ev = async (expression, sid) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid); if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r?.result?.value; };
  const until = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(100); } return false; };
  const fresh = () => { frames.clear(); blocked.length = 0; };
  await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
  await until(() => ev("window.ready === true").catch(() => false), 30000);

  // the control: this harness sees a frame refused under COEP (a refused frame is chrome-error://, its load blocked)
  fresh();
  await ev(`(() => { const f = document.createElement("iframe"); f.setAttribute("sandbox", ""); f.src = "/control/"; f.id = "control"; document.body.append(f); return 1; })()`);
  check(await until(() => [...frames.values()].includes("chrome-error://chromewebdata/") && blocked.length > 0, 10000), "control: a sandboxed page's frame, redirected with no CORP, is seen refused: " + JSON.stringify({ frames: [...frames.values()], blocked }));
  await ev(`(() => { document.getElementById("control").remove(); return 1; })()`);

  // a LaTeX example in the panel: its page, its preview frame and what they load, none refused; the preview's text
  fresh();
  await ev(`(() => { window.P.openExamplesPanel({ ws: {}, open() {} }, { kind: "latex" }); return 1; })()`);
  const shown = () => [...frames.values()];
  const PV = "/examples/latex/article/preview";
  check(await until(() => shown().includes(PV), 15000), "the panel shows a LaTeX example's rendered document (preview.html, as the host serves it): " + JSON.stringify(shown()));
  await sleep(1000);
  check(!shown().some((u) => u.startsWith("chrome-error:")), "no frame refused: " + JSON.stringify(shown()));
  check(blocked.length === 0, "nothing is refused: " + JSON.stringify(blocked));
  let text = null;
  for (const [sid, t] of sessions) if (t.type === "iframe" && local(t.url) === PV) text = await ev("document.body.innerText", sid).catch((e) => "error: " + e.message);
  check(typeof text === "string" && /A small article/.test(text) && /Sums/.test(text), "the preview renders inside the panel, the document's text: " + JSON.stringify(text?.slice(0, 120)));
  // a notebook example there too: its page's KaTeX stylesheet not refused
  fresh();
  await ev(`(() => { const d = document.querySelector("dialog.sb-examples"); d.querySelector('button[data-kind="notebook"]').click(); return 1; })()`);
  check(await until(() => shown().some((u) => /^\/examples\/notebook\/[a-z0-9-]+\/$/.test(u)), 15000), "a notebook example's page shows: " + JSON.stringify(shown()));
  await sleep(1000);
  check(blocked.length === 0, "nothing a notebook example's page loads is refused: " + JSON.stringify(blocked));
  for (const e of errors) fails.push("page error: " + e);
  ws.close();
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  chrome.kill();
  server.stop(true);
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(out, { recursive: true, force: true });
}
if (fails.length) {
  console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`ok: an example's preview in the Examples panel, ${checks} checks`);
process.exit(0);
