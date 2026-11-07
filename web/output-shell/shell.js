// The isolated output renderer (OUT-ISO plan r3, phase 1): the one script that runs in
// an output frame.  The frame is sandbox="allow-scripts" only (an opaque origin: no
// storage, cookies or parent DOM) and its CSP admits only this script, by hash.
//
// - It takes ONE MessagePort, from its parent window, in a message {sbOutIso: 1}, and
//   then stops listening to window messages: everything after goes on that port.
// - Every message is decoded by protocol.js (size first, then schema); anything else
//   is ignored.
// - A render replaces what the frame shows.  Each output is checked again here, with
//   the same code the host uses (safe-html.ts, safe-svg.js), before it is shown.
// - RENDER-COMMIT-1: one committed per accepted generation, after the outputs are in
//   the DOM, the fonts and pictures are ready (or READY_MS passed) and the layout has
//   settled; a newer render abandons an older one, which then commits nothing.  Later
//   size changes are height messages, at most HEIGHT_HZ a second, the last always sent.
// - The frame never navigates, opens, downloads, prints or asks the host to do work:
//   the schema has no such message.
import { BOUNDS, decode, encode } from "./protocol.js";
import { safeHtml } from "../safe-html.ts";
import { safeSvg } from "../safe-svg.js";

export const READY_MS = 3000; // (the font/picture readiness deadline: a measurement candidate)
export const HEIGHT_HZ = 30; // (height messages a second, at most)

let port = null, gen = -1, area = "", committed = false;
const root = document.getElementById("root");
const post = (type, fields) => { if (port) port.postMessage(encode("to-host", type, fields)); };
const measure = () => Math.min(BOUNDS.heightPx, Math.ceil(root.getBoundingClientRect().height));

addEventListener("message", function adopt(e) {
  if (port || e.source !== parent || !e.data || e.data.sbOutIso !== 1 || e.ports.length !== 1) return;
  removeEventListener("message", adopt);
  port = e.ports[0];
  port.onmessage = (m) => receive(decode("to-frame", m.data));
  post("ready", {});
});

function receive(m) {
  if (!m) return;
  if (m.type === "render") return render(m);
  if (m.type === "theme") { document.documentElement.dataset.theme = m.theme; return; }
  if (m.type === "dispose") { gen = -1; committed = false; root.replaceChildren(); port.close(); port = null; }
}

function draw(o) {
  if (o.kind === "text") return Object.assign(document.createElement("pre"), { textContent: o.body });
  if (o.kind === "svg") return safeSvg(o.body) ?? Object.assign(document.createElement("pre"), { textContent: "(a picture that couldn't be shown)" });
  const d = document.createElement("div");
  d.innerHTML = safeHtml(o.body);
  return d;
}

// (the layout settled: forced now, then a frame or, where a hidden frame's frames are paused, a short timer)
const frame = () => { root.getBoundingClientRect(); return Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), deadline(50)]); };
const deadline = (ms) => new Promise((r) => setTimeout(r, ms));
const pictures = () => Promise.all([...root.querySelectorAll("img")].map((i) => i.decode().catch(() => {})));

async function render(m) {
  if (m.generation <= gen) return; // (stale or repeated)
  const g = (gen = m.generation);
  area = m.area;
  committed = false;
  try {
    root.replaceChildren(...m.outputs.map((o) => {
      const s = document.createElement("section");
      s.className = "out";
      s.dataset.id = o.id;
      s.append(draw(o));
      return s;
    }));
  } catch {
    if (g === gen) post("error", { generation: g, reason: "the output couldn't be drawn" });
    return;
  }
  await Promise.race([Promise.all([document.fonts.ready, pictures()]), deadline(READY_MS)]);
  await frame();
  if (g !== gen) return; // (replaced meanwhile: this generation commits nothing)
  committed = true;
  lastSent = measure();
  post("committed", { generation: g, area, ids: m.outputs.map((o) => o.id), height: lastSent });
}

// (heights after the commit: coalesced, the latest always sent)
let lastSent = -1, timer = null, lastAt = 0;
new ResizeObserver(() => {
  if (!committed || timer) return;
  const wait = Math.max(0, lastAt + 1000 / HEIGHT_HZ - performance.now());
  timer = setTimeout(() => {
    timer = null;
    lastAt = performance.now();
    const h = measure();
    if (committed && h !== lastSent) { lastSent = h; post("height", { generation: gen, height: h }); }
  }, wait);
}).observe(root);
