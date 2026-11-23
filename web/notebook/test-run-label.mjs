// ci: web-browser/notebook order=248
// A cell's ▶ is labelled (William, Nov 20 2026, #1549: the agent said "click Run" and the button was an unlabeled play
// icon): a "Run" caption under it, "Stop" while the cell runs or waits, shown and hidden with the button, inside the
// cell and its gutter at the page's widths (desktop, narrow); the button's own text (▶ / ■, which the Stop guard reads)
// and its accessible name are unchanged. The built page, served by web/serve.py, in headless Chrome.
// Run after `bun web/build.ts`:
//   CHROME=google-chrome node web/notebook/test-run-label.mjs
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServe } from "../test-port.mjs";
import { browser } from "../agents/a14-cases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };

let server;
const port = await startServe(() => (server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
const B = await browser();
// (the first code cell's button and its caption: the caption's box measured from its font, as the pseudo-element has
//  no box of its own to ask for)
const STATE = `(() => {
  const c = sagebrush.notebook.cells().find((x) => x.type === "code"), b = c.runb, cap = getComputedStyle(b, "::after");
  const r = b.getBoundingClientRect(), cell = c.el.getBoundingClientRect(), g = c.el.querySelector(".gutter").getBoundingClientRect();
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = cap.fontWeight + " " + cap.fontSize + " " + cap.fontFamily;
  const text = cap.content.replace(/^"|"$/g, ""), w = ctx.measureText(text).width, h = parseFloat(cap.lineHeight) || parseFloat(cap.fontSize) * 1.2;
  const left = r.left + r.width / 2 - w / 2, top = r.bottom + parseFloat(cap.marginTop || "0");
  return { text, visible: getComputedStyle(b).visibility === "visible", btn: b.textContent, label: b.getAttribute("aria-label"), title: b.title,
    inCell: top + h <= cell.bottom + 0.5 && left >= cell.left - 0.5, inGutter: left >= g.left - 0.5 && left + w <= g.right + 0.5, w: Math.round(w), gw: Math.round(g.width) };
})()`;
try {
  const P = await B.tab();
  for (const [width, what] of [[1280, "desktop"], [600, "narrow"]]) {
    await P.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await P.send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    await P.until(`typeof sagebrush !== "undefined" && !!sagebrush.notebook?.cells?.().some((x) => x.type === "code") && document.readyState === "complete"`, 60000);
    // (the cell made active, as a click into it does: its button shows)
    await P.ev(`(() => { const c = sagebrush.notebook.cells().find((x) => x.type === "code"); c.ta.focus(); c.el.classList.add("active"); return true; })()`);
    const s = await P.ev(STATE);
    ok(s.visible && s.text === "Run", `${what}: the active cell's ▶ has the caption Run`, s);
    ok(s.btn === "▶" && /^Run cell \d+$/.test(s.label ?? "") && /^Run \(Shift\+Enter\)$/.test(s.title), `${what}: the button's own text, accessible name and title are unchanged`, s);
    ok(s.inCell && s.inGutter, `${what}: the caption fits under the button, inside the cell and its gutter (${s.w}px in ${s.gw}px)`, s);
    // (running, then waiting: the button is Stop, and so is its caption)
    for (const cls of ["running", "queued"]) {
      const t = await P.ev(`(() => { const c = sagebrush.notebook.cells().find((x) => x.type === "code"); c.el.classList.add(${JSON.stringify(cls)}); const v = getComputedStyle(c.runb, "::after").content; c.el.classList.remove(${JSON.stringify(cls)}); return v; })()`);
      ok(t === '"Stop"', `${what}: while the cell is ${cls}, the caption says Stop`, t);
    }
    // (a cell neither active nor hovered: no button, and so no caption)
    const hidden = await P.ev(`(() => { const c = sagebrush.notebook.cells().find((x) => x.type === "code"); c.el.classList.remove("active"); c.ta.blur(); document.activeElement?.blur?.(); return getComputedStyle(c.runb).visibility; })()`);
    ok(hidden === "hidden", `${what}: an inactive cell shows neither the button nor its caption`, hidden);
  }
  ok(P.errors.length === 0, "no page errors", P.errors);
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  server.kill();
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
