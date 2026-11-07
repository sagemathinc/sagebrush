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
//   the DOM, the fonts and pictures are ready (or READY_MS passed), the frame has its
//   width (or READY_MS passed again) and the layout has
//   settled; a newer render abandons an older one, which then commits nothing.  Later
//   size changes are height messages, at most HEIGHT_HZ a second, the last always sent.
// - The frame never navigates, opens, downloads, prints or asks the host to do work:
//   the schema has no such message.  Links are inert (OUTISO-NAV-1): every
//   link the sanitizers kept (their hrefs, the "Open … in a new tab" link that stands
//   for an <iframe>) is drawn as its text alone, and a click that would still follow
//   one is cancelled; forms can't submit (no allow-forms, form-action 'none').  A host action for links is separately
//   reviewed later; until then a link here goes nowhere, not even within the frame.
import { LIMITS, decode, encode } from "./protocol.js";
import { safeHtml } from "../safe-html.ts";
import { safeSvg } from "../safe-svg.js";

// (readyMs: the font/picture readiness deadline, a measurement candidate; heightHz: height messages a second, at most)
export const SHELL_LIMITS = Object.freeze({ readyMs: 3000, heightHz: 30 });
export const READY_MS = SHELL_LIMITS.readyMs;
export const HEIGHT_HZ = SHELL_LIMITS.heightHz;

let port = null, gen = -1, area = "", committed = false;
const root = document.getElementById("root");
const post = (type, fields) => { if (port) port.postMessage(encode("to-host", type, fields)); };
const measure = () => Math.min(LIMITS.heightPx, Math.ceil(root.getBoundingClientRect().height));

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

// (a link drawn as its text: the element goes, its children stay; SVG's <a> too.  The sanitizers emit no <area>:
// safe-html.ts allows only its TAGS, and SVG has none)
function inert(el) {
  for (const a of el.querySelectorAll("a")) a.replaceWith(...a.childNodes);
  return el;
}
// (and a link's activation, should one ever be there, cancelled.  A form can't submit at all: the sandbox has no
// allow-forms and the policy's form-action is 'none')
for (const t of ["click", "auxclick"]) addEventListener(t, (e) => { if (e.target.closest?.("a, area, [href]")) e.preventDefault(); }, true);

// (the layout settled: forced now, then a frame or, where a hidden frame's frames are paused, a short timer)
const frame = () => { root.getBoundingClientRect(); return Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), deadline(50)]); };
const deadline = (ms) => new Promise((r) => setTimeout(r, ms));
// (the frame's own width, before anything is measured: an out-of-process frame learns its size from the page a
// moment after it loads, and until then its viewport is 0 wide, every word on its own line. A height measured
// then is too tall, and an offscreen frame, whose resize observations are paused, never corrects it: the area's
// placeholder would hold it and the page shift when the frame comes back (EVICT-LAYOUT-1). Bounded: a frame
// really laid out 0 wide still commits at the deadline)
// The width usually comes within a few milliseconds. Timers in an offscreen cross-origin frame run about once a
// second, so for its first 250 ms the wait yields through a MessageChannel, whose tasks aren't throttled, then
// polls every 50 ms.
const sized = (ms) => innerWidth > 0 ? Promise.resolve() : new Promise((r) => {
  const t0 = performance.now(), ch = new MessageChannel();
  const next = () => {
    const t = performance.now() - t0;
    if (innerWidth > 0 || t >= ms) { ch.port1.close(); return r(); }
    if (t < 250) ch.port2.postMessage(0); else setTimeout(next, 50);
  };
  ch.port1.onmessage = next;
  next();
});
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
      s.append(inert(draw(o)));
      return s;
    }));
  } catch {
    if (g === gen) post("error", { generation: g, reason: "the output couldn't be drawn" });
    return;
  }
  await Promise.race([Promise.all([document.fonts.ready, pictures()]), deadline(READY_MS)]);
  await sized(READY_MS);
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
