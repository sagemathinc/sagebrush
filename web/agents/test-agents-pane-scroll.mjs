// ci: web-artifacts.1 order=45 runner=bun chrome
// The artifact pane has one vertical scrollbar (William's QA, Nov 21 2026): a long notebook the agent made, open beside
// the chat, scrolls in one place, not in the pane's body and its host both. The built page (SAGEBRUSH_AGENTS=1),
// served by web/serve.py, paired as a person pairs it with the stand-in agent (test-delegate-host.mjs), which writes
// the notebook with the workspace verb and shows it as its turn's artifact, as sagebrush-agent does. Checked at the
// window's own size and after the window is made shorter.
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && CHROME=google-chrome bun web/agents/test-agents-pane-scroll.mjs
import { spawn } from "node:child_process";
import { join } from "node:path";
import { startServe } from "../test-port.mjs";
import { browser } from "./a14-cases.mjs";
import { delegateHost } from "./test-delegate-host.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 800) : "")); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
const sitePort = await startServe(() => (server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
const site = `http://127.0.0.1:${sitePort}`;
const H = delegateHost();
const B = await browser();
// (what scrolls vertically under the pane: an element whose content is taller than it, by even one pixel (a browser
//  with real scrollbars, not overlay ones, then draws one), and whose overflow lets it scroll)
const SCROLLERS = `(() => [document.querySelector('#artifacts'), ...document.querySelectorAll('#artifacts *')].filter((e) => {
  const s = getComputedStyle(e);
  return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight && e.clientHeight > 0;
}).map((e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').join('.') : '')))()`;
try {
  const P = await B.tab();
  await P.navigate(`${site}/agents/?pair=123-456&port=${H.port}`);
  await P.until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Connect')`, 30000);
  await P.ev(`[...document.querySelectorAll('.sbag-dlg button')].find((b) => b.textContent === 'Connect').click()`);
  await P.until(`[...document.querySelectorAll('.sbag-box h2')].some((h) => h.textContent === 'Allow this agent?')`, 30000);
  await P.ev(`(() => { const d = [...document.querySelectorAll('.sbag-box')].at(-1); [...d.querySelectorAll('label')].find((l) => /^May run code/.test(l.textContent))?.querySelector('input')?.click(); d.querySelector('button.primary').click(); return true; })()`);
  await P.until(`document.querySelector('#connect').textContent === 'Connected'`);
  // (the person asks; the agent writes a long notebook and shows it as its turn's artifact)
  await P.draft("make a long notebook");
  await P.ev(`(document.querySelector('#send').click(), true)`);
  for (const t = Date.now(); !H.got.some((m) => m.method === "chat.message") && Date.now() - t < 10000; ) await sleep(50);
  const conversation = H.got.find((m) => m.method === "chat.message")?.params?.conversation;
  ok(!!conversation, "the person's message reached the agent");
  const path = "/long.ipynb";
  const cells = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, type: "code", code: `x${i} = ${i}\nprint(x${i})` }));
  const made = await H.call("workspace.create", { path, mode: "python", content: { json: { mode: "python", cells } } });
  ok(!made.error, "the agent wrote " + path, made.error);
  const turn = "t-scroll";
  for (const event of [{ type: "turn_started" }, { type: "artifact", id: path, kind: "notebook", title: "long.ipynb", body: "", path }, { type: "turn_finished", outcome: "completed" }]) H.sock.send(JSON.stringify({ jsonrpc: "2.0", method: "turn.event", params: { conversation, turn_id: turn, event } }));
  await P.until(`document.querySelectorAll('#artifacts .nb-root .cell').length >= 60`, 30000);
  for (const [w, h, what] of [[1280, 900, "the window as it is"], [1280, 560, "a shorter window"]]) {
    await P.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await P.ev(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
    const s = await P.ev(SCROLLERS);
    if (process.env.DETAIL) console.log(JSON.stringify(await P.ev(`[...document.querySelectorAll('#artifacts, #artifacts .pane-body, #artifacts .pane-host, #artifacts .file-body, #artifacts .nb-artifact, #artifacts .nb-root')].map((e) => [e.className || e.id, getComputedStyle(e).overflowY, getComputedStyle(e).display, e.clientHeight, e.scrollHeight])`)));
    ok(s.length === 1, `${what}: the long notebook in the pane scrolls in exactly one place`, s);
  }
  ok(P.errors.length === 0, "no page errors", P.errors);
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  H.stop();
  server.kill();
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
