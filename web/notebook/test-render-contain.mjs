// A notebook's saved outputs stay in their place on the page (web/notebook/notebook.js, notebook.css,
// web/safe-html.ts), in headless Chromium against the built page:
//   (cd web/dist && python3 ../serve.py 8765) &   node web/notebook/test-render-contain.mjs
// - an SVG output whose style asks for the whole window (position: fixed, inset, z-index, viewport units)
//   stays within its output: the page's own buttons are still what is under the pointer;
// - the SVG's own painting styles are kept (fill, font-size);
// - HTML outputs naming tags such as constructor, __proto__ or toString show their text, and one output that
//   can't be drawn doesn't stop the others.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const url = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const profile = mkdtempSync(join(tmpdir(), "sb-contain-"));
let cdpPort = Number(process.env.CDP_PORT) || 0;
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "--window-size=1200,900", "about:blank"], { stdio: "ignore" });
if (!cdpPort) cdpPort = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
const until = async (expr, ms = 30000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); } return false; };
const done = () => { try { ws.close(); } catch {} chrome.kill(); setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500).unref(); };

try {
  await send("Page.navigate", { url });
  ok(await until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000), "the notebook page is ready");
  const cover = `<svg xmlns="http://www.w3.org/2000/svg" width="100vw" height="100vh" style="position:fixed;left:0;top:0;inset:0;width:100vw;height:100vh;z-index:2147483647;margin:0">` +
    `<rect width="100%" height="100%" style="fill:rgb(1,2,3)"/><text x="20" y="30" style="font-size:20px;fill:red" id="covertext">COVER</text></svg>`;
  const out = (data) => ({ output_type: "display_data", data, metadata: {} });
  await ev(`(async () => sagebrush.notebook.load({ mode: "python", cells: [
    { id: "c1", code: "1", outputs: [${JSON.stringify(out({ "image/svg+xml": cover, "text/plain": "cover" }))}] },
    { id: "c2", code: "2", outputs: [${JSON.stringify(out({ "text/html": "<constructor foo=bar>first</constructor>", "text/plain": "a" }))}] },
    { id: "c3", code: "3", outputs: [${JSON.stringify(out({ "text/html": "<__proto__ x=1>second</__proto__><tostring y=2>third</tostring>&constructor;", "text/plain": "b" }))}] },
    { id: "c4", code: "4", outputs: [${JSON.stringify(out({ "text/html": "<b>after</b>", "text/plain": "c" }))}] },
  ] }))()`);
  ok(await until("document.body.innerText.includes('after')", 10000), "the document loads, its last output drawn");
  // the page's own controls are still the ones under the pointer
  const hits = await ev(`(() => {
    const btns = [...document.querySelectorAll("button")].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 4 && r.height > 4 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && !b.closest(".cell .out"); });
    // (covered: what is under the pointer there is an output's own content, not the page's; a button shown only
    // on hover is not under the pointer either way)
    return { n: btns.length, covered: btns.filter((b) => { const r = b.getBoundingClientRect(), e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && !b.contains(e) && !!e.closest(".cell .out figure, .cell .out .html-out, .cell .out .md-out") && !b.closest(".cell .out"); }).map((b) => (b.textContent.trim().slice(0, 20) || b.getAttribute("aria-label")) + " under " + (document.elementFromPoint(b.getBoundingClientRect().left + 2, b.getBoundingClientRect().top + 2)?.tagName ?? "?")) };
  })()`);
  ok(hits.n > 0 && hits.covered.length === 0, `an SVG output asking for the whole window covers none of the page's ${hits.n} buttons: ${JSON.stringify(hits.covered)}`);
  const svgStyle = await ev(`(() => { const s = document.querySelector(".cell .out svg"); if (!s) return null; const c = getComputedStyle(s); return { position: c.position, z: c.zIndex, attrW: s.getAttribute("width"), style: s.getAttribute("style") }; })()`);
  ok(svgStyle && svgStyle.position !== "fixed" && svgStyle.z === "auto" && svgStyle.attrW === null && !/position|z-index|inset|vw|vh/.test(svgStyle.style ?? ""), "...its position, inset, z-index and viewport sizes are dropped: " + JSON.stringify(svgStyle));
  ok(await ev(`(() => { const t = document.querySelector(".cell .out svg text"); return !!t && getComputedStyle(t).fontSize === "20px" && /255, 0, 0/.test(getComputedStyle(t).fill); })()`), "...while its painting styles (fill, font-size) are kept");
  // tag names that are properties of every object: text, not a failure
  const text = await ev("document.body.innerText");
  ok(["first", "second", "third"].every((w) => text.includes(w)), "outputs naming constructor, __proto__ or toString show their text");
  ok(!/couldn't be shown/.test(text), "...drawn, not given up on");
  ok(!(await ev("!!document.querySelector('.cell .out constructor, .cell .out __proto__, .cell .out tostring')")), "...and no such element is made");
} catch (e) {
  ok(false, String(e?.stack ?? e));
} finally {
  done();
}
console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
