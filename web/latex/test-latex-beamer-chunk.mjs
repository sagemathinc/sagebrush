// ci: web-browser/latex order=30 chrome
// The LaTeX worker's beamer chunk (dist/sagebrush-latex-beamer.js) in a real browser (astra, #637): the built worker
// (dist/sagebrush-latex-worker.js) in headless Chrome, a beamer document rendered twice, from a server that serves
// web/dist under /ok/ and the same with the chunk a 404 under /bad/:
//   - /ok/: one request for the chunk, the slides on both renders, the first in one pass (the worker fetches the chunk
//     of a document that declares beamer before its first render: its stats' mode "cold", not the second pass's
//     "unchanged");
//   - an article from /art/ (the same dist): no request for the chunk;
//   - from /fb/, a beamer document whose class isn't the first thing (\listfiles before it): not fetched early, so its
//     slides come from needBeamer, the second pass ("unchanged"), with one request;
//   - /bad/: one request for the chunk (a browser keeps a module that failed to load as failed: no second one), and
//     each render the document without slides, with the notice that says why and to reload.
//   SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts && CHROME=google-chrome node web/latex/test-latex-beamer-chunk.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "../test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url)), dist = join(here, "..", "dist");
if (!existsSync(join(dist, "sagebrush-latex-worker.js"))) { console.error("no web/dist/sagebrush-latex-worker.js: SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts first"); process.exit(2); }
let checks = 0; const fails = [];
const check = (ok, what, detail) => { checks++; if (!ok) { fails.push(what); console.log("FAIL", what, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// (the server: /ok/ and /bad/ are web/dist; under /bad/ the chunk is a 404; each mode's chunk requests counted)
const asks = { ok: 0, bad: 0, art: 0, fb: 0 };
const server = createServer((req, res) => {
  const m = /^\/(ok|bad|art|fb)\/([^?]*)/.exec(new URL(req.url, "http://x").pathname);
  if (!m) return res.writeHead(404).end();
  const [, mode, name] = m;
  if (name === "blank.html") return res.writeHead(200, { "Content-Type": "text/html" }).end("<title>beamer chunk</title>");
  if (name === "sagebrush-latex-beamer.js") { asks[mode]++; if (mode === "bad") return res.writeHead(404, { "Cache-Control": "no-store" }).end(); }
  const f = normalize(join(dist, name));
  if (!f.startsWith(dist) || !existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": f.endsWith(".js") ? "text/javascript" : "application/octet-stream", "Cache-Control": "no-store" }).end(readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const profile = mkdtempSync("/tmp/sb-bch-");
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
try {
  const port = await devtoolsPort(profile, 60_000, { child: chrome });
  let targets;
  for (let k = 0; k < 300 && !targets?.some((t) => t.type === "page"); k++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch {} await sleep(100); }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value; };
  const doc = "\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}{Hello}\nA \\pause B\n\\end{frame}\n\\end{document}\n";
  // (a worker of mode's dist, the document rendered twice: rev 1, then rev 2 with one more character)
  const run = async (mode, src = doc) => {
    await send("Page.navigate", { url: base + mode + "/blank.html" });
    for (let k = 0; k < 100 && (await ev("location.pathname").catch(() => "")) !== "/" + mode + "/blank.html"; k++) await sleep(100);
    return ev(`(async () => {
      const w = new Worker("/${mode}/sagebrush-latex-worker.js", { type: "module" });
      const one = (rev, text) => new Promise((r) => { w.onmessage = (e) => r(e.data); w.postMessage({ doc: 1, rev, text }); });
      const text = ${JSON.stringify(src)};
      const a = await one(1, text), b = await one(2, text.replace("B", "BC"));
      w.terminate();
      const sum = (x) => ({ ok: x.ok, html: (x.items || []).map((i) => i.h).join(""), problems: (x.check?.problems || []).map((p) => p.kind + ":" + p.name), frames: (x.check?.frames || []).length, mode: x.stats?.mode });
      return [sum(a), sum(b)];
    })()`);
  };
  const ok = await run("ok");
  check(asks.ok === 1, "served: the chunk fetched once for both renders", asks);
  check(ok.every((r) => r.ok && r.frames === 1 && r.html.includes('class="slide') && !r.html.includes("could not be loaded")), "served: both renders have the slide", ok);
  check(ok[0].mode === "cold", "served: the first render in one pass (the chunk fetched before it)", ok.map((r) => r.mode));
  const art = await run("art", "\\documentclass{article}\n\\begin{document}\nPlain.\n\\end{document}\n");
  check(asks.art === 0 && art.every((r) => r.ok && r.html.includes("Plain.")), "an article: no request for the chunk", { asks, art });
  const fb = await run("fb", "\\listfiles\n" + doc);
  check(asks.fb === 1 && fb[0].mode === "unchanged" && fb.every((r) => r.ok && r.frames === 1 && r.html.includes('class="slide')), "a beamer class not first: its slides by needBeamer's second pass", { asks, fb: fb.map((r) => [r.mode, r.frames]) });
  const bad = await run("bad");
  check(asks.bad === 1, "a 404: the chunk asked for once, not again on the next render", asks);
  check(bad.every((r) => r.ok && !r.html.includes('class="slide') && r.html.includes("Beamer's slides could not be loaded (") && r.html.includes("reload the page to try again") && r.problems.some((p) => p.startsWith("beamer:"))), "a 404: each render without slides, the notice saying why and to reload", bad);
} finally {
  chrome.kill(); server.close(); await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(fails.length ? `FAIL: the LaTeX worker's beamer chunk, ${fails.length} of ${checks}` : `ok: the LaTeX worker's beamer chunk, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
