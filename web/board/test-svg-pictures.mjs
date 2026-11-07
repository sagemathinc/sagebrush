// ci: web-browser/board-a order=130 runner=bun
// SVG pictures (P9a) are only ever images, in a real browser (astra's SEC conditions): a board with an
// ordinary plot, a hostile SVG (a script, an onload handler, remote images by href and xlink:href, a CSS
// @import, a web font, a paint server, a foreignObject's <img>, and a nested SVG data: image with its own
// script and remote image), one past MAX_SIDE, and a code item whose stored preview is that hostile SVG.
// On the board page, in its print (PDF) and in the board's exported SVG file opened by the browser: the plot
// and the hostile picture are drawn, the one past the bounds is not, nothing runs (window.__pwned stays
// unset) and nothing is requested from the "canary" server the hostile SVG names.  A control: the page
// itself asking the canary for an image is seen, so the count can see a request.
//   bun web/board/test-svg-pictures.mjs     (with web/dist served: python3 web/serve.py 8765; SB_URL, CHROME)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "../test-port.mjs";
import { svgDataUrl } from "../image-size.ts";
import { boardSvg } from "./svg.ts";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

// the canary: every request it gets, by path
const hits = [];
const canary = createServer((req, res) => { hits.push(req.url); res.writeHead(200, { "access-control-allow-origin": "*" }); res.end(""); });
await new Promise((r) => canary.listen(0, "127.0.0.1", r));
const C = `http://127.0.0.1:${canary.address().port}`;

const b64 = (t) => Buffer.from(t, "utf8").toString("base64");
const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
const plot = `<svg ${NS} width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="#fff"/><path d="M0 100L50 20L100 70L150 10L200 60" stroke="#2a6f2f" stroke-width="4" fill="none"/></svg>`;
const inner = `<svg ${NS} width="10" height="10" onload="window.top.__pwned='inner-onload';fetch('${C}/inner-onload')"><script>window.top.__pwned='inner-script';fetch('${C}/inner-script')</script><image href="${C}/inner-img.png" width="5" height="5"/></svg>`;
const hostile = `<svg ${NS} width="200" height="100" onload="window.top.__pwned='onload';fetch('${C}/onload')">` +
  `<style>@import url(${C}/import.css); @font-face { font-family: x; src: url(${C}/font.woff) } text { font-family: x }</style>` +
  `<script>window.top.__pwned='script';fetch('${C}/script');new Image().src='${C}/script-img.png'</script>` +
  `<image href="${C}/img.png" width="10" height="10"/><image xlink:href="${C}/xlink.png" x="20" width="10" height="10"/>` +
  `<image href="data:image/svg+xml;base64,${b64(inner)}" x="40" width="10" height="10"/>` +
  `<foreignObject x="60" width="50" height="50"><img xmlns="http://www.w3.org/1999/xhtml" src="${C}/fo.png"/></foreignObject>` +
  `<rect y="60" width="200" height="40" fill="url(${C}/paint.svg#p)"/><text y="50">hostile</text></svg>`;
const huge = `<svg ${NS} width="9000" height="10"/>`;
const at = "2026-11-07T00:00:00Z";
const doc = {
  format: "sagebrush-board", version: 1, mode: "python",
  images: { plot: { w: 200, h: 100, src: svgDataUrl(plot) }, bad: { w: 200, h: 100, src: svgDataUrl(hostile) }, huge: { w: 900, h: 1, src: svgDataUrl(huge) } },
  nodes: [
    { id: "p", image: "plot", x: 0, y: 0, w: 220 }, { id: "h", image: "bad", x: 300, y: 0, w: 220 }, { id: "g", image: "huge", x: 0, y: 260, w: 220 },
    { id: "c", code: "1", x: 300, y: 260, w: 320, preview: { at, ms: 12000, total: 12000, outputs: [{ output_type: "display_data", data: { "image/svg+xml": hostile, "text/plain": "a picture" }, metadata: {} }] } },
  ],
};
check(!!doc.images.plot.src && !!doc.images.bad.src && !!doc.images.huge.src, "the pictures, in their one form");

// the board, served from web/dist for this run
const name = `sb-test-svg-pictures-${process.pid}.board.json`, file = fileURLToPath(new URL(`../dist/${name}`, import.meta.url));
writeFileSync(file, JSON.stringify(doc));
const out = mkdtempSync(join(tmpdir(), "sb-svgp-")), svgFile = join(out, "board.svg");
const exported = boardSvg(doc).svg;
writeFileSync(svgFile, exported);
check(!/<script|onload|<foreignObject|<style|import\.css|font\.woff/.test(exported) && !exported.includes(C), "the exported file's markup has none of the picture's");

let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-svgp-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
try {
  if (!port) port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0, step = "start";
  const waiting = new Map();
  const failAll = (why) => { for (const [, w] of waiting) w.fail(new Error(`${why} (during: ${step})`)); waiting.clear(); };
  ws.onclose = () => failAll("the DevTools socket closed");
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); clearTimeout(w.timer); w.ok(m.result ?? m.error); }
    if (m.method === "Inspector.targetCrashed") failAll("the page crashed");
  };
  const send = (method, params = {}, ms = method === "Page.printToPDF" ? 120000 : 60000) => new Promise((ok, fail) => {
    const id = ++n;
    const timer = setTimeout(() => { waiting.delete(id); fail(new Error(`${method}: no answer in ${ms / 1000} s (during: ${step})`)); }, ms);
    waiting.set(id, { ok, fail, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; };
  const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } return false; };
  await send("Page.enable");
  await send("Runtime.enable");

  // the board page
  step = "the board";
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("/" + name)}` });
  check(await until("window.sagebrush?.board?.snapshot?.().items.length >= 4"), "the board opened");
  // (the pictures loaded: two drawn, the one past the bounds not)
  const loaded = "[...document.querySelectorAll('img.board-img')].filter((i) => i.complete && i.naturalWidth > 0).length";
  check(await until(`${loaded} >= 2`, 20000), "the plot and the hostile picture are drawn");
  await sleep(2500);
  check((await ev(loaded)) === 2, "the picture past MAX_SIDE isn't drawn: " + (await ev(loaded)));
  check((await ev("window.__pwned ?? null")) === null, "nothing in a picture ran: " + (await ev("String(window.__pwned)")));

  // its print (as PDF)
  step = "print";
  const pdf = await send("Page.printToPDF", { printBackground: true });
  check(!!pdf?.data, "printed");
  await sleep(1000);

  // the exported SVG, opened as a document by the browser (its pictures are <image>s: image mode, nested too)
  step = "the exported SVG";
  await send("Page.navigate", { url: "file://" + svgFile });
  check(await until("document.documentElement?.localName === 'svg' && document.querySelectorAll('image').length >= 3", 10000), "the exported SVG opened, its pictures as <image>s");
  await sleep(2500);
  check((await ev("window.__pwned ?? null")) === null, "nothing ran in the exported SVG");

  check(hits.length === 0, "no request reached the canary: " + JSON.stringify(hits));
  // (the control: the page asking the canary itself is seen)
  step = "control";
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("/" + name)}` });
  await until("!!window.sagebrush?.board", 20000);
  await ev(`new Promise((r) => { const i = new Image(); i.onload = i.onerror = () => r(1); i.src = '${C}/control.png'; })`);
  await sleep(300);
  check(hits.join() === "/control.png", "the control reached the canary: " + JSON.stringify(hits));
  ws.close();
} catch (e) {
  fails.push("error: " + (e?.stack ?? e));
} finally {
  chrome.kill();
  canary.close();
  rmSync(file, { force: true });
  rmSync(out, { recursive: true, force: true });
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
if (fails.length) {
  console.log(`FAIL\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
console.log(`${checks}/${checks} checks passed`);
process.exit(0);
