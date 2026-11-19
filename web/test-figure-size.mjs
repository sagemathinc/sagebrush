// ci: web-browser/notebook order=121
// A figure shown as a PNG drawn at twice its size (lib/_graphics.py figures) in the notebook page, in headless
// Chrome: shown at the size its display's metadata gives (web/notebook/notebook.js pictureShownSize), so it is sharp
// on a dense screen and no bigger than its SVG would be; that size saved with the output and taken again when the
// notebook is opened; a size that isn't two finite positive numbers ignored, and not saved.  Its own server
// (web/serve.py) and Chrome:   node web/test-figure-size.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort, startServe } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0;
const fails = [];
const ok = (c, what) => { checks++; console.log((c ? "ok   " : "FAIL ") + what); if (!c) fails.push(what); };
const profile = mkdtempSync(join(tmpdir(), "sb-figure-size-"));
let server, chrome, ws;
const kill = () => { try { ws?.close(); } catch {} try { chrome?.kill("SIGKILL"); } catch {} try { server?.kill("SIGKILL"); } catch {} };
process.on("exit", kill);

try {
  const serve = startServe(() => (server = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] })));
  const port = await serve.port;
  let cdpPort = Number(process.env.CDP_PORT) || 0;
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  if (!cdpPort) cdpPort = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {} await sleep(100); }
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  // (each call bounded: a Chrome that went away fails the test, not hangs it)
  const send = (method, params = {}) => Promise.race([new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); }),
    sleep(60_000).then(() => { throw new Error("no answer to " + method); })]);
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result?.value;
  };
  const until = async (expr, ms = 60_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 2, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/?phone=0` });
  ok(await until("!!window.sagebrush?.notebook?.cells && document.querySelector('#status')?.textContent.startsWith('ready')"), "the notebook page");
  await until("sagebrush.notebook.cells().length > 0", 30_000);
  await sleep(1500);

  const C = (id) => `sagebrush.notebook.cells().find((c) => c.id === ${JSON.stringify(id)})`;
  const img = (id) => ev(`(() => { const i = ${C(id)}?.out.querySelector("figure img"); if (!i) return null; const r = i.getBoundingClientRect();
    return { natural: [i.naturalWidth, i.naturalHeight], shown: [Math.round(r.width), Math.round(r.height)] }; })()`);
  const saved = (id) => ev(`JSON.stringify(sagebrush.notebook.snapshot().cells.find((c) => c.id === ${JSON.stringify(id)}).outputs)`);

  // a figure of 2 by 1 inches forced to PNG: drawn at 400 by 200 pixels, shown at 200 by 100
  const code = 'import sagebrush\nimport matplotlib.pyplot as plt\nsagebrush.figures("png")\nfig, ax = plt.subplots(figsize=(2, 1))\nax.plot([1, 2]);';
  await ev(`sagebrush.notebook.load(${JSON.stringify({ mode: "python", cells: [{ id: "fig", code, outputs: [] }] })}), 1`);
  await ev("sagebrush.notebook.runAll().then(() => 1)");
  ok(await until(`!!${C("fig")}?.out.querySelector("figure img")?.naturalWidth`), "the figure is shown as a picture");
  const live = await img("fig");
  ok(JSON.stringify(live?.natural) === "[400,200]" && JSON.stringify(live?.shown) === "[200,100]", "drawn at twice its size, shown at its size: " + JSON.stringify(live));
  const outs = JSON.parse(await saved("fig"));
  const md = outs.find((o) => o.data?.["image/png"])?.metadata;
  ok(JSON.stringify(md) === JSON.stringify({ "image/png": { width: 200, height: 100 } }), "its size is saved with the output: " + JSON.stringify(md));

  // the notebook opened again: shown at that size from what was saved
  await ev(`sagebrush.notebook.load(${JSON.stringify({ mode: "python", cells: [{ id: "again", code, outputs: outs }] })}), 1`);
  ok(await until(`!!${C("again")}?.out.querySelector("figure img")?.naturalWidth`, 20_000), "opened again: the picture");
  const back = await img("again");
  ok(JSON.stringify(back?.natural) === "[400,200]" && JSON.stringify(back?.shown) === "[200,100]", "...shown at its size again: " + JSON.stringify(back));
  ok(JSON.parse(await saved("again")).find((o) => o.data?.["image/png"])?.metadata?.["image/png"]?.width === 200, "...and saved again with it");

  // a size that isn't two finite positive numbers (a string, a negative, too large): the picture at its own size,
  // and nothing of it saved
  const png = outs.find((o) => o.data?.["image/png"]).data;
  const bad = [{ width: "200", height: 100 }, { width: 200, height: -1 }, { width: 1e9, height: 100 }, { width: 200 }];
  await ev(`sagebrush.notebook.load(${JSON.stringify({ mode: "python", cells: bad.map((s, i) => ({ id: "bad" + i, code: "", outputs: [{ output_type: "display_data", data: png, metadata: { "image/png": s } }] })) })}), 1`);
  await until(`!!${C("bad3")}?.out.querySelector("figure img")?.naturalWidth`, 20_000);
  for (let i = 0; i < bad.length; i++) {
    const r = await img("bad" + i);
    ok(JSON.stringify(r?.shown) === "[400,200]", `metadata ${JSON.stringify(bad[i])}: ignored, the picture at its own size: ${JSON.stringify(r)}`);
  }
  // (an output loaded from a file and not changed is saved as it was read: its metadata, valid or not, isn't
  // the page's to rewrite)
  ok(JSON.parse(await saved("bad0"))[0].metadata?.["image/png"]?.width === "200", "an output kept as it was read is saved as it was");
} catch (e) {
  ok(false, "threw: " + (e?.stack ?? e));
} finally {
  kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(fails.length ? `${fails.length} of ${checks} failed` : `${checks}/${checks} checks passed`);
process.exit(fails.length ? 1 : 0);
