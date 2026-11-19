// ci: web-browser/notebook order=122
// The notebook's ⋯ ▸ Figures choice (Auto, SVG, PNG) in headless Chrome: kept in the notebook's metadata
// (sagebrush.figures, only when it isn't Auto), given to the interpreter with each run in every language
// (lib/_graphics.py figures), and shown checked for the notebook open.  Its own server (web/serve.py) and Chrome:
//   node web/test-notebook-figures-menu.mjs
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
const profile = mkdtempSync(join(tmpdir(), "sb-figures-menu-"));
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
  await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/?phone=0` });
  ok(await until("!!window.sagebrush?.notebook?.cells && document.querySelector('#status')?.textContent.startsWith('ready')"), "the notebook page");
  await until("sagebrush.notebook.cells().length > 0", 30_000);
  await sleep(1500);

  // the menu: ⋯ ▸ Figures ▸ its three rows, the notebook's one checked
  // (⋯ opened afresh each time, as a person does: closed first if it is open)
  const openFigures = () => ev(`(() => {
    const more = document.getElementById("moremenu");
    if (!more.hidden) document.getElementById("morebtn").click();
    document.getElementById("morebtn").click();
    const g = document.querySelector('button[data-group="figures"]');
    if (g.getAttribute("aria-expanded") !== "true") g.click();
    return [...g.nextElementSibling.querySelectorAll('[role="menuitemradio"]')].filter((b) => !b.hidden)
      .map((b) => [b.textContent, b.getAttribute("aria-checked")]);
  })()`);
  const pick = (label) => ev(`(async () => {
    const g = document.querySelector('button[data-group="figures"]');
    const b = [...g.nextElementSibling.querySelectorAll('[role="menuitemradio"]')].find((x) => x.textContent === ${JSON.stringify(label)});
    b.click();
    return 1;
  })()`);
  const rows = await openFigures();
  ok(JSON.stringify(rows) === JSON.stringify([["Auto", "true"], ["SVG", "false"], ["PNG", "false"]]), "⋯ ▸ Figures: Auto, SVG and PNG, Auto checked: " + JSON.stringify(rows));

  const C = (id) => `sagebrush.notebook.cells().find((c) => c.id === ${JSON.stringify(id)})`;
  const shown = (id) => ev(`(() => { const o = ${C(id)}?.out; if (!o) return null;
    return { svg: !!o.querySelector("figure svg"), png: !!o.querySelector("figure img"), note: /Shown as a PNG/.test(o.textContent) }; })()`);
  const figMeta = () => ev("JSON.stringify(sagebrush.notebook.snapshot().metadata?.sagebrush?.figures ?? null)");
  const runAll = () => ev("sagebrush.notebook.runAll().then(() => 1)");
  const SMALL = "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3]);";
  const BIG = "import numpy as np\nimport matplotlib.pyplot as plt\nrng = np.random.default_rng(1)\nfig, ax = plt.subplots()\nax.plot(rng.random(30000), rng.random(30000), 'k.', ms=1);";

  // PNG chosen: kept in the notebook; a small figure shown as a PNG
  await ev(`sagebrush.notebook.load(${JSON.stringify({ mode: "python", cells: [{ id: "a", code: SMALL, outputs: [] }] })}), 1`);
  await openFigures();
  await pick("PNG");
  ok(await figMeta() === '"png"', "PNG chosen: kept in the notebook's metadata (sagebrush.figures)");
  ok(JSON.stringify(await openFigures()) === JSON.stringify([["Auto", "false"], ["SVG", "false"], ["PNG", "true"]]), "...and shown checked");
  await runAll();
  await until(`(() => { const s = ${C("a")}?.out.querySelector("figure img, figure svg"); return !!s; })()`);
  ok(JSON.stringify(await shown("a")) === JSON.stringify({ svg: false, png: true, note: false }), "...a small figure is a PNG: " + JSON.stringify(await shown("a")));

  // a notebook kept with SVG: its choice shown checked, and a figure of 30,000 points is its SVG, nothing said
  await ev(`sagebrush.notebook.load(${JSON.stringify({ mode: "python", metadata: { sagebrush: { figures: "svg" } }, cells: [{ id: "b", code: BIG, outputs: [] }] })}), 1`);
  ok(JSON.stringify(await openFigures()) === JSON.stringify([["Auto", "false"], ["SVG", "true"], ["PNG", "false"]]), "a notebook kept with SVG: SVG checked");
  await runAll();
  await until(`!!${C("b")}?.out.querySelector("figure img, figure svg")`);
  ok(JSON.stringify(await shown("b")) === JSON.stringify({ svg: true, png: false, note: false }), "...a figure of 30,000 points is its SVG: " + JSON.stringify(await shown("b")));

  // Auto chosen: nothing kept (the default); the big figure a PNG, said under it
  await pick("Auto");
  ok(await figMeta() === "null", "Auto chosen: nothing kept in the notebook");
  await runAll();
  await until(`!!${C("b")}?.out.querySelector("figure img")`);
  ok(JSON.stringify(await shown("b")) === JSON.stringify({ svg: false, png: true, note: true }), "...the big figure is a PNG, said under it: " + JSON.stringify(await shown("b")));

  // a document from elsewhere (another tab, sync) with no choice: Auto, the old choice not kept
  ok(await ev(`(() => { const nb = sagebrush.notebook; nb.setFigures("svg"); const d = nb.snapshot(); delete d.metadata; nb.applyRemote(d, false); return nb.figures(); })()`) === "auto",
    "a document from elsewhere without a choice clears it: Auto");
  ok(await ev(`(() => { const nb = sagebrush.notebook; const d = nb.snapshot(); d.metadata = { sagebrush: { figures: "png" } }; nb.applyRemote(d, false); return nb.figures(); })()`) === "png",
    "...and one with a choice brings it");

  // an @interact redrawn after the choice changed: drawn with the choice it has now
  const INTERACT = "import matplotlib.pyplot as plt\nfrom ipywidgets import interact\n@interact(n=(2, 6))\ndef f(n=2):\n    plt.figure(figsize=(2, 1)); plt.plot(range(n)); plt.show()";
  await ev(`sagebrush.notebook.load(${JSON.stringify({ mode: "python", cells: [{ id: "i", code: INTERACT, outputs: [] }] })}), 1`);
  await ev(`(() => { window.__runs = []; sagebrush.kernel.on("execute", (r) => window.__runs.push(JSON.parse(JSON.stringify(r)))); return 1; })()`);
  await runAll();
  ok(await until(`!!${C("i")}?.out.querySelector("figure svg")`), "an @interact's figure, Auto: its SVG");
  await openFigures();
  await pick("PNG");
  await ev(`(() => { const r = ${C("i")}.out.querySelector('input[type="range"]'); r.value = "5"; r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()`);
  ok(await until(`!!${C("i")}?.out.querySelector("figure img")`, 30_000), "...moved after PNG was chosen: redrawn as a PNG");

  // the runs as TimeTravel records them, to replay them as they were shown: the choice with each
  const runs = await ev("JSON.stringify(window.__runs.map((r) => [r.kind, r.figures ?? null]))");
  ok(JSON.parse(runs).some(([k, f]) => k === "code" && f === "auto") && JSON.parse(runs).some(([k, f]) => k === "interact" && f === "png"),
    "each run recorded with its choice (the cell's Auto, the redraw's PNG): " + runs);
  const journaled = await ev(`(() => { const e = [...sagebrush.kernels.values()].find((x) => x.kernel === sagebrush.kernel); const s = e?.journal?.session;
    return s ? JSON.stringify(s.events.filter((x) => x.rec?.type === "run").map((x) => [x.rec.kind, x.rec.figures ?? null])) : null; })()`);
  ok(journaled !== null && JSON.parse(journaled).some(([k, f]) => k === "interact" && f === "png"), "...and in the journal's run records, which a replay sends again: " + journaled);

  // on a remote kernel the choice isn't given yet: its rows disabled, saying so
  await ev(`(() => { document.getElementById("kernelpick").value = "paired"; return 1; })()`);
  const remote = await ev(`(() => { document.getElementById("morebtn").click(); if (document.getElementById("moremenu").hidden) document.getElementById("morebtn").click();
    const g = document.querySelector('button[data-group="figures"]'); if (g.getAttribute("aria-expanded") !== "true") g.click();
    return [...g.nextElementSibling.querySelectorAll('[role="menuitemradio"]')].map((b) => [b.disabled, b.title]); })()`);
  ok(remote.every(([d, t]) => d && t === "Not available for remote kernels yet"), "on a remote kernel: the rows disabled, saying so: " + JSON.stringify(remote));
  await pick("SVG");
  ok(await ev("sagebrush.notebook.figures()") === "png", "...and choosing one does nothing");
  await ev(`(() => { document.getElementById("kernelpick").value = "local"; return 1; })()`);
  ok(JSON.stringify((await openFigures()).map(([l]) => l)) === JSON.stringify(["Auto", "SVG", "PNG"]) && await ev(`[...document.querySelectorAll('button[data-group="figures"] + div [role="menuitemradio"]')].every((b) => !b.disabled)`), "this browser again: the rows enabled");

  // in MATLAB too: a notebook kept with PNG shows its figure as a PNG
  await ev(`sagebrush.notebook.load(${JSON.stringify({ mode: "matlab", metadata: { sagebrush: { figures: "png" } }, cells: [{ id: "m", code: "plot(1:3)", outputs: [] }] })}), 1`);
  await runAll();
  ok(await until(`!!${C("m")}?.out.querySelector("figure img, figure svg")`, 90_000), "a MATLAB notebook's figure");
  ok(JSON.stringify(await shown("m")) === JSON.stringify({ svg: false, png: true, note: false }), "...kept with PNG: a PNG: " + JSON.stringify(await shown("m")));
} catch (e) {
  ok(false, "threw: " + (e?.stack ?? e));
} finally {
  kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(fails.length ? `${fails.length} of ${checks} failed` : `${checks}/${checks} checks passed`);
process.exit(fails.length ? 1 : 0);
