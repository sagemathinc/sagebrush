// ci: web-artifacts.1 order=20 runner=bun chrome
// The agents page's resizable columns (William A1 + A10; the layout plan r3, PR 2): the chat list and the artifact
// pane are dragged or moved with the keys, clamped so the chat keeps 420 px and the pane 320, re-clamped on a resize
// and when the pane opens, kept in localStorage only in a valid shape, and left alone by the narrow overlay and full
// screen. Copy chat and a message's Copy put Markdown on the clipboard (C-copy-*). Switching between Files and Agents
// moves no edge (#1808, M-*): the chat list is the files panel's width, its header row theirs, the top bar the files'
// header's height, no banner above; the status's popover says what the banner said.
// The scripted agent (no pairing) opens a code artifact ("plot a Fourier series"); notebooks are
// test-agents-artifacts.mjs's (A10 there: opening a notebook leaves the pane width as it was).
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && CHROME=google-chrome bun web/agents/test-agents-layout.mjs
// Each case prints its id first ("ok   L2-side-179: ..."), so a run's FAIL set is the ids of its FAIL lines.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort, startServe } from "../test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const KEY = "sb-agents-layout-v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, checks = 0;
const ok = (id, cond, msg, detail) => {
  checks++;
  if (!cond) fails++;
  console.log(`${cond ? "ok  " : "FAIL"} ${id}: ${msg}${!cond && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 400) : ""}`);
};

let server;
const port = await startServe(() => (server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
const origin = `http://127.0.0.1:${port}`;
const profile = mkdtempSync(join(tmpdir(), "sb-agents-layout-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
let code = 1;
try {
  const cdpPort = await devtoolsPort(profile, undefined, { child: chrome });
  let targets;
  for (let i = 0; i < 300 && !targets; i++) targets = await fetch(`http://127.0.0.1:${cdpPort}/json`).then((r) => r.json(), () => sleep(100).then(() => undefined));
  const cdp = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (cdp.onopen = r));
  let n = 0;
  const waiting = new Map();
  let exceptions = [];
  cdp.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m.result ?? m.error), waiting.delete(m.id));
    else if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); cdp.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result?.value; };
  const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } throw new Error("timeout: " + expr); };
  const size = (width, height = 900) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await send("Runtime.enable");
  await send("Page.enable");

  /** A fresh page at `width`: chats and the stored layout cleared, then `stored` (a raw string) put back if given. */
  const fresh = async (width, { stored = null, query = "" } = {}) => {
    await size(width);
    const url = `${origin}/agents/?speed=20${query}`;
    await send("Page.navigate", { url });
    await until(`location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete'`);
    await ev(`(() => { localStorage.clear(); ${stored == null ? "" : `localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(stored)});`} })()`);
    exceptions = [];
    await send("Page.navigate", { url });
    await sleep(300);
    // (the page loaded with its editor, as before, AND either the layout mounted (its separators wired and valued: apply()
    // writes aria-valuenow only after mountLayout wires them) OR a page exception since this navigate (a mount that throws
    // never values the separators; the case's own checks must then fail it, not this wait); 20 s)
    const loaded = `document.readyState === 'complete' && !!document.querySelector('#editor .mb')`;
    const mounted = `document.getElementById('sep-side').hasAttribute('aria-valuenow')`;
    for (const t = Date.now(); ; await sleep(50)) {
      if ((await ev(loaded).catch(() => false)) && (exceptions.length > 0 || (await ev(mounted).catch(() => false)))) break;
      if (Date.now() - t > 20000) throw new Error("timeout: the page's load with the layout's mount (or a page exception) at " + url);
    }
    await sleep(300);
  };
  /** The scripted agent's turn that opens a code artifact (through the page's own artifact path, renderArtifacts). */
  const openPane = async () => {
    if (!(await ev(`!!document.querySelector('#editor textarea')`))) {
      const [x, y] = await ev(`(() => { const r = document.querySelector('#editor .mb-block').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
    await until(`!!document.querySelector('#editor textarea')`);
    await ev(`document.querySelector('#editor textarea').focus()`);
    await send("Input.insertText", { text: "plot a Fourier series" });
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", modifiers: 8, windowsVirtualKeyCode: 13 });
    await until(`!!document.querySelector('#artifacts [data-tab]') && document.querySelector('#stop').hidden`, 30000);
    await sleep(300);
  };
  const w = () => ev(`(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return { side: r('nav.side').width, sideRight: r('nav.side').right, chat: r('main').width, pane: r('#artifacts').width, vw: innerWidth }; })()`);
  const aria = (id) => ev(`(() => { const e = document.getElementById('${id}'); return { now: e.getAttribute('aria-valuenow'), min: e.getAttribute('aria-valuemin'), max: e.getAttribute('aria-valuemax') }; })()`);
  const sepX = (id) => ev(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  /** A drag of a separator: pressed at its middle, moved to x in one jump (off the handle: pointer capture), released. */
  const drag = async (id, x) => {
    const [x0, y] = await sepX(id);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    await sleep(100);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(200);
  };
  const key = async (k) => { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code: k }); await sleep(80); };
  const near = (a, b) => Math.abs(a - b) < 1;

  // ---- the sidebar's clamps (1600 px, no pane: 200-640, the files panel's)
  for (const [id, x, want] of [["L2-side-199", 199, 200], ["L2-side-200", 200, 200], ["L2-side-640", 640, 640], ["L2-side-641", 641, 640]]) {
    await fresh(1600);
    await drag("sep-side", x);
    const m = await w();
    ok(id, near(m.side, want), `the chat list dragged to ${x} px is ${want} px wide`, m);
  }

  // ---- the chat keeps 420 px; the pane keeps 320 (1600 px, a code artifact open)
  await fresh(1600);
  await openPane();
  await drag("sep-pane", 1600 - 931);
  {
    const m = await w();
    ok("L2-chat-419", near(m.chat, 420), "a pane drag that would leave the chat 419 px leaves it 420", m);
  }
  {
    // (O-2: the chat at its 420 px minimum: the header's name, help link and Connect button on one line, the name cut
    //  rather than pushing the buttons out of the header)
    const h = await ev(`(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(), top = r('.top'), who = r('#who'), how = r('#howto'), con = r('#connect');
      return { chat: r('main').width, whoTop: who.top, howTop: how.top, conTop: con.top, whoRight: who.right, howLeft: how.left, conRight: con.right, topRight: top.right, topH: top.height, conH: con.height }; })()`);
    const al = await ev(`(() => { const t = document.querySelector('.top'), cs = getComputedStyle(t), g = document.querySelector('.top .top-actions').getBoundingClientRect(), r = t.getBoundingClientRect(); return { gap: (r.right - parseFloat(cs.paddingRight)) - g.right }; })()`);
    ok("L2-header-actions-right", Math.abs(al.gap) < 1.5, "with the chat at 420 px the header's actions keep to its right edge (#1793)", al);
    // (and room to spare on that line: another browser's or system's font (CI's google-chrome) draws the same words a
    //  few px wider, and the merge queue once saw the line wrap there by ~7 px)
    const sp = await ev(`(() => { const t = document.querySelector('.top'), who = document.querySelector('#who').getBoundingClientRect(), g = document.querySelector('.top .top-actions'), kids = [...g.children].filter((b) => !b.hidden).map((b) => b.getBoundingClientRect());
      const need = kids.reduce((s, k) => s + k.width, 0) + parseFloat(getComputedStyle(g).columnGap) * (kids.length - 1);
      return { spare: (t.getBoundingClientRect().right - parseFloat(getComputedStyle(t).paddingRight)) - need - parseFloat(getComputedStyle(t).columnGap) - who.right, need, kids: kids.length }; })()`);
    ok("L2-header-spare", sp.kids === 2 && sp.spare >= 24, "with the chat at 420 px and both actions shown, the header's line has at least 24 px to spare (for wider fonts)", sp);
    ok("L2-header-one-line", near(h.chat, 420) && Math.abs(h.conTop - h.howTop) < 2 && Math.abs(h.conTop - h.whoTop) < 6 && h.topH < 2 * h.conH && h.whoRight <= h.howLeft + 1 && h.conRight <= h.topRight + 1, "with the chat at 420 px the header is one line: the name gives way, the buttons stay in the header", h);
    // (board's B-O2-1: "on your computer" either whole or visually hidden, never cut to a letter; the name itself whole,
    //  its own characters measured, not the space after it)
    const l = await ev(`(() => { const who = document.querySelector('#who'), sm = who.querySelector('small'), w = who.getBoundingClientRect(), s = sm.getBoundingClientRect(), cs = getComputedStyle(sm);
      const name = [...who.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim()), rg = document.createRange(), t = name.textContent, i0 = t.length - t.trimStart().length; rg.setStart(name, i0); rg.setEnd(name, i0 + t.trim().length); const nr = rg.getBoundingClientRect();
      return { name: name.textContent.trim(), nameRight: nr.right, whoRight: w.right, smallRight: s.right, smallW: s.width, clip: cs.clipPath, display: cs.display, visibility: cs.visibility, smallText: sm.textContent }; })()`);
    const whole = l.smallW > 1 && l.smallRight <= l.whoRight + 0.5, hidden = l.smallW <= 1 && l.clip !== "none" && l.display !== "none" && l.visibility === "visible";
    const cv = await ev(`(() => { const w = document.querySelector('#who'), a = getComputedStyle(w, '::after'), r = w.getBoundingClientRect(), top = document.querySelector('.top').getBoundingClientRect();
      return { content: a.content, pos: a.position, right: a.right, pad: getComputedStyle(w).paddingRight, whoRight: r.right, howLeft: document.querySelector('#howto').getBoundingClientRect().left, topRight: top.right }; })()`);
    ok("M-chevron-narrow", cv.content === '""' && cv.pos === "absolute" && parseFloat(cv.right) + 5 < parseFloat(cv.pad) && cv.whoRight <= cv.howLeft + 1 && cv.whoRight <= cv.topRight, "with the chat at 420 px the status's chevron is still drawn, in the status's own right padding, before the next button", cv);
    ok("L2-header-label", (whole || hidden) && l.nameRight <= l.whoRight + 0.5 && l.smallText.trim() !== "", "with the chat at 420 px the agent's name is whole, and the where-it-runs label is either whole or visually hidden (still read by screen readers), never cut", l);
  }
  {
    // (#1793: all four of the header's actions shown (Use your own Claude, Review changes, Delegate, Connected) with the
    //  chat at its 420 px minimum: they wrap within the header, and none is drawn past the chat over the pane's tabs)
    const h4 = await ev(`(() => {
      document.querySelector('#howto').hidden = false;
      document.querySelector('#review').hidden = false;
      const con = document.querySelector('#connect'); con.hidden = false; con.textContent = 'Connected';
      let sw = document.querySelector('#delegate-switch');
      if (!sw) { sw = Object.assign(document.createElement('button'), { id: 'delegate-switch', className: 'link', type: 'button' }); con.before(sw); }
      sw.hidden = false; sw.textContent = 'Delegate: on';
      const r = (e) => e.getBoundingClientRect(), main = r(document.querySelector('main')), pane = r(document.querySelector('#artifacts'));
      const btns = ['#howto', '#review', '#delegate-switch', '#connect'].map((s) => { const b = r(document.querySelector(s)); return { s, left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width, h: b.height }; });
      return { mainRight: main.right, paneLeft: pane.left, btns };
    })()`);
    const apart = (a, b) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
    const noOverlap = h4.btns.every((a, i) => h4.btns.every((b, j) => i === j || apart(a, b)));
    ok("L2-header-actions-fit", h4.btns.every((b) => b.w > 0 && b.h > 0 && b.right <= h4.mainRight + 0.5 && b.right <= h4.paneLeft + 0.5 && b.left >= 0) && noOverlap, "with the chat at 420 px and all four header actions shown (each drawn), none runs past the chat over the pane's tabs, and none overlaps another (#1793)", h4);
    await ev(`(() => { document.querySelector('#review').hidden = true; const con = document.querySelector('#connect'); con.hidden = true; const sw = document.querySelector('#delegate-switch'); if (sw) sw.hidden = true; return true; })()`);
  }
  for (const [id, pane] of [["L2-pane-319", 319], ["L2-pane-320", 320]]) {
    await drag("sep-pane", 1600 - pane);
    const m = await w();
    ok(id, near(m.pane, 320), `the pane dragged to ${pane} px is 320 px wide`, m);
  }

  // ---- too narrow for 200 + 420 + 320 beside an open pane: the chat list collapses (910 px)
  await fresh(910);
  await openPane();
  {
    const m = await w();
    ok("L2-narrow-collapse", m.sideRight <= 0 && m.chat >= 419.5, "at 910 px with a pane open the chat list collapses and the chat keeps 420 px", m);
  }

  // ---- the keys, and the separator's values
  await fresh(1600);
  await ev(`document.getElementById('sep-side').focus()`);
  {
    await key("ArrowRight");
    const a = await w(), aa = await aria("sep-side");
    await key("ArrowLeft");
    const b = await w(), ba = await aria("sep-side");
    ok("L2-key-arrows", near(a.side, 288) && aa.now === "288" && near(b.side, 272) && ba.now === "272", "the arrows move the chat list's edge 16 px, and aria-valuenow follows", { a, aa, b, ba });
    await key("Home");
    const h = await w(), ha = await aria("sep-side");
    await key("End");
    const e = await w(), ea = await aria("sep-side");
    ok("L2-key-home-end", near(h.side, 200) && ha.now === "200" && near(e.side, 640) && ea.now === "640", "Home and End take the chat list to 200 and 640 px", { h, ha, e, ea });
  }
  await fresh(1600);
  await openPane();
  await size(1100);
  await sleep(400);
  {
    const m = await w(), ap = await aria("sep-pane"), as = await aria("sep-side");
    ok("L2-aria-resize", ap.min === "320" && ap.max === String(Math.round(1100 - m.side - 420)) && ap.now === String(Math.round(m.pane)) && as.max === "360" && as.now === String(Math.round(m.side)), "after a resize from 1600 to 1100 px the separators' valuemin/max/now are current", { m, ap, as });
  }
  await fresh(1000);
  await openPane();
  {
    const m = await w(), ap = await aria("sep-pane");
    ok("L2-aria-clamped", near(m.pane, 320) && ap.now === "320" && m.chat >= 419.5, "the default pane re-clamped to keep the chat at 420 px: aria-valuenow is the width shown (320)", { m, ap });
  }

  // ---- pointer capture: a drag that ends far from the handle
  await fresh(1600);
  await drag("sep-side", 400);
  {
    const m = await w();
    ok("L2-capture", near(m.side, 400), "a drag ending off the handle (400 px) still moves and ends", m);
  }

  // ---- 900 and 901 px: no separators in the narrow overlay
  await fresh(900);
  {
    const a = await ev(`[getComputedStyle(document.getElementById('sep-side')).display, document.querySelector('nav.side').getBoundingClientRect().right]`);
    await size(901);
    await sleep(300);
    const b = await ev(`getComputedStyle(document.getElementById('sep-side')).display`);
    ok("L2-900-901", a[0] === "none" && a[1] <= 0 && b === "block", "the separators are hidden at 900 px (the overlay unchanged) and shown at 901", { a, b });
  }

  // ---- the pane's default, min(46vw, 760px)
  for (const [id, vw, want] of [["L2-default-below", 1400, 0.46 * 1400], ["L2-default-above", 1800, 760]]) {
    await fresh(vw);
    await openPane();
    const m = await w();
    ok(id, near(m.pane, want), `at ${vw} px the pane opens ${Math.round(want)} px wide`, m);
  }

  // ---- the stored layout: only exactly {side, pane}, finite numbers in 0..4096; anything else -> the defaults
  for (const [id, raw] of [
    ["L2-shape-nan", '{"side":1e999,"pane":500}'],
    ["L2-shape-string", '{"side":"300","pane":500}'],
    ["L2-shape-negative", '{"side":-5,"pane":500}'],
    ["L2-shape-huge", '{"side":300,"pane":99999}'],
    ["L2-shape-missing", '{"side":300}'],
    ["L2-shape-nonobject", "[300,500]"],
    ["L2-shape-notjson", "{side:300"],
    ["L2-shape-extrakey", '{"side":300,"pane":500,"x":1}'],
  ]) {
    await fresh(1600, { stored: raw });
    await openPane();
    const m = await w();
    ok(id, near(m.side, 272) && near(m.pane, 736) && exceptions.length === 0, `stored ${raw}: the defaults (272, 736 px), no page exception`, { m, exceptions });
  }
  // (storage that throws for this key: the page mounts and the drag works)
  {
    const s = await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const g = Storage.prototype.getItem, p = Storage.prototype.setItem; Storage.prototype.getItem = function (k) { if (k === ${JSON.stringify(KEY)}) throw new Error("storage off"); return g.call(this, k); }; Storage.prototype.setItem = function (k, v) { if (k === ${JSON.stringify(KEY)}) throw new Error("storage off"); return p.call(this, k, v); }; })()` });
    await fresh(1600);
    await drag("sep-side", 300);
    const m = await w();
    ok("L2-storage-fail", near(m.side, 300) && exceptions.length === 0, "with localStorage throwing for the layout key, the page mounts and the drag works", { m, exceptions });
    await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: s.identifier });
  }

  // ---- the narrow overlay and full screen ignore the stored widths
  await fresh(800, { stored: '{"side":400,"pane":500}' });
  await openPane();
  {
    const m = await w();
    ok("L2-overlay-800", near(m.pane, 800) && m.sideRight <= 0, "at 800 px the pane covers the page and the chat list is the overlay's, whatever is stored", m);
  }
  await fresh(1600, { stored: '{"side":400,"pane":500}' });
  await openPane();
  await ev(`document.querySelector('#full').click()`);
  await sleep(300);
  {
    const m = await w();
    ok("L2-fullscreen", near(m.pane, 1600), "in full screen the pane covers the page, whatever is stored", m);
  }

  // ---- re-clamping: on a resize, and when the agent opens the pane
  await fresh(1600, { stored: '{"side":300,"pane":700}' });
  await openPane();
  await size(1100);
  await sleep(400);
  {
    const m = await w();
    ok("L2-resize-reclamp", near(m.pane, 380) && m.chat >= 419.5, "stored 300/700 at 1600 px, resized to 1100: the pane 380 px, the chat 420", m);
  }
  await fresh(1000, { stored: '{"side":480,"pane":460}' });
  await openPane();
  {
    const m = await w();
    ok("L2-agent-open-1000", m.chat >= 419.5, "at 1000 px (480 px chat list stored), the pane the agent opens leaves the chat 420 px", m);
  }

  // ---- one layout update per animation frame; one write per drag
  await fresh(1600, { query: "&layout-test" });
  {
    await ev(`(window.__fr = [], window.__sbLayout.setFrame((cb) => window.__fr.push(cb)))`);
    const [x0, y] = await sepX("sep-side");
    const a0 = await ev(`window.__sbLayout.stats.applies`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 0; i < 50; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 260 + i, y, button: "left", buttons: 1 });
    const a1 = await ev(`window.__sbLayout.stats.applies`);
    await ev(`window.__fr.splice(0).forEach((f) => f())`);
    const a2 = await ev(`window.__sbLayout.stats.applies`);
    const m = await w();
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 309, y, button: "left", buttons: 0, clickCount: 1 });
    ok("L2-apply-drag", a1 - a0 === 0 && a2 - a0 === 1 && near(m.side, 309), "50 pointer moves before the frame: no layout update, then exactly one, at the 50th position", { a0, a1, a2, side: m.side });
    const r0 = await ev(`window.__sbLayout.stats.applies`);
    await ev(`(() => { for (let i = 0; i < 50; i++) dispatchEvent(new Event('resize')); })()`);
    const r1 = await ev(`window.__sbLayout.stats.applies`);
    await ev(`window.__fr.splice(0).forEach((f) => f())`);
    const r2 = await ev(`window.__sbLayout.stats.applies`);
    ok("L2-apply-resize", r1 - r0 === 0 && r2 - r0 === 1, "50 resize events before the frame: no layout update, then exactly one", { r0, r1, r2 });
  }
  await fresh(1600, { query: "&layout-test" });
  {
    const [x0, y] = await sepX("sep-side");
    const w0 = await ev(`window.__sbLayout.stats.writes`);
    // (moves off the handle from the first, 300 to 398 px: pointer capture carries them, and the release)
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 0; i < 50; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300 + 2 * i, y, button: "left", buttons: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 398, y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(200);
    const w1 = await ev(`window.__sbLayout.stats.writes`);
    ok("L2-write-count", w1 - w0 === 1, "one drag of 50 moves writes the stored layout once", { w0, w1 });
  }
  {
    // Copy (decided Nov 19 2026): the header's Copy chat puts the whole chat on the clipboard as Markdown, and a
    // message's Copy that message; the button is there only once the chat has something in it
    await fresh(1400);
    ok("C-copy-empty", await ev(`document.querySelector('#log-tools').hidden`), "an empty chat: no Copy chat");
    await openPane();
    await ev(`(() => { window.__clip = []; navigator.clipboard.writeText = (t) => (window.__clip.push(t), Promise.resolve()); return true; })()`);
    ok("C-copy-shown", await ev(`!document.querySelector('#log-tools').hidden && !!document.querySelector('#copychat').offsetParent`), "with a turn in it: Copy chat is offered");
    await ev(`(document.querySelector('#copychat').click(), true)`);
    await until(`window.__clip.length === 1`);
    const all = await ev(`window.__clip[0]`);
    ok("C-copy-chat", /^# /.test(all) && all.includes("**You:**\n\nplot a Fourier series") && /\*\*Claude:\*\*/.test(all) && /\n- `[^`]+`/.test(all) && /\n- file: /.test(all), "Copy chat: the title, what the person wrote, the agent's turn with a line per tool call and its file", all.slice(0, 600));
    await ev(`(document.querySelector('#log .user .copy-msg').click(), true)`);
    await until(`window.__clip.length === 2`);
    ok("C-copy-message", (await ev(`window.__clip[1]`)) === "**You:**\n\nplot a Fourier series", "a message's Copy: that message", await ev(`window.__clip[1]`));
    await ev(`(document.querySelector('#log .turn .copy-msg').click(), true)`);
    await until(`window.__clip.length === 3`);
    const t = await ev(`window.__clip[2]`);
    ok("C-copy-turn", /^\*\*Claude:\*\*/.test(t) && !t.includes("plot a Fourier series\n\n**Claude") && t.length > 20, "a turn's Copy: the agent's turn only", t.slice(0, 300));
    ok("C-copy-quiet", exceptions.length === 0, "no page errors", exceptions);
  }
  // (Files…, at the foot of the chat list: big, visible in the chat view, and it opens the notebook page with its file
  //  browser shown, even where this browser had hidden it)
  await fresh(1600);
  {
    const b = await ev(`(() => { const b = document.getElementById('files-big'), r = b?.getBoundingClientRect(), nav = document.querySelector('nav.side').getBoundingClientRect(); return b && { text: b.textContent.trim(), w: r.width, h: r.height, fromBottom: nav.bottom - r.bottom, inNav: !!b.closest('nav.side'), shown: r.width > 0 && getComputedStyle(b).visibility === 'visible', font: parseFloat(getComputedStyle(b).fontSize) }; })()`);
    ok("L2-files-button", b && b.text === "Files…" && b.inNav && b.shown && b.w >= 200 && b.h >= 36 && b.font >= 15 && b.fromBottom < 120, "a big Files… button at the foot of the chat list", b);
    await ev(`localStorage.setItem("sagebrush-files-sidebar", "0")`);
    await ev(`document.getElementById('files-big').click()`);
    await until(`location.pathname === "/" && document.readyState === "complete"`);
    await until(`!document.getElementById('wssidebar').hidden`, 30000).catch(() => {});
    const side = await ev(`({ path: location.pathname, shown: !document.getElementById('wssidebar').hidden, pref: localStorage.getItem("sagebrush-files-sidebar") })`);
    ok("L2-files-button-opens", side.path === "/" && side.shown && side.pref === "1", "Files… opens the notebook page with its file browser shown (though it had been hidden)", side);
  }
  // ---- while a turn runs, the composer's primary action queues: Shift+Enter and the primary button never interrupt the
  //  agent; only Send now (and Stop) do. The scripted agent slowed down, so its turn is still running meanwhile
  {
    await fresh(1600);
    await send("Page.navigate", { url: `${origin}/agents/?speed=0.05` });
    await until(`document.readyState === 'complete' && !!document.querySelector('#editor .mb')`);
    await sleep(300);
    const type = async (text) => {
      if (!(await ev(`!!document.querySelector('#editor textarea')`))) {
        const [x, y] = await ev(`(() => { const r = document.querySelector('#editor .mb-block').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
        for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
      await until(`!!document.querySelector('#editor textarea')`);
      await ev(`document.querySelector('#editor textarea').focus()`);
      await send("Input.insertText", { text });
    };
    const shiftEnter = async () => { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", modifiers: 8, windowsVirtualKeyCode: 13 }); };
    const state = () => ev(`(() => { const q = (s) => document.querySelector(s); return { running: !q('#stop').hidden, primary: q('#send').textContent, keys: q('#keys').textContent, now: !q('#send-now').hidden && q('#send-now').textContent, queued: q('#queued').textContent, interrupted: [...document.querySelectorAll('.status')].filter((x) => x.textContent === 'Interrupted').length, users: [...document.querySelectorAll('.user')].map((u) => u.className) }; })()`);
    const idle = await state();
    ok("Q1-idle", idle.primary === "Send" && idle.keys === "send" && idle.now === false && !idle.running, "with no turn running: Send, Shift+Enter sends, no Send now", idle);
    // (#1806: the keys aren't said three times: no sidebar line, a plain placeholder, and the row under the prompt only
    //  once there's text; Send's tooltip says its key)
    const keysOf = () => ev(`(() => { const ph = [...document.querySelectorAll('#editor [data-placeholder], #editor textarea')].map((e) => e.dataset?.placeholder || e.placeholder || '').filter(Boolean); return { hint: getComputedStyle(document.querySelector('.composer .hint')).visibility, side: document.querySelector('nav.side').innerText, ph, sendTitle: document.querySelector('#send').title }; })()`);
    const k0 = await keysOf();
    ok("K1-empty", k0.hint === "hidden" && !/Shift\+Enter/.test(k0.side) && k0.ph.length > 0 && k0.ph.every((p) => /^Message .+…$/.test(p) && !/Enter/.test(p)) && /Shift\+Enter/.test(k0.sendTitle), "with nothing typed: no keys under the prompt, none in the chat list, the placeholder plain; Send's tooltip says Shift+Enter (#1806)", k0);
    await type("plot a Fourier series");
    const k1 = await keysOf();
    ok("K1-typed", k1.hint === "visible", "once there's text, the keys row shows (#1806)", k1);
    await shiftEnter();
    await until(`!document.querySelector('#stop').hidden`, 10000);
    await until(`getComputedStyle(document.querySelector('.composer .hint')).visibility === 'hidden'`, 3000).catch(() => {});
    ok("K1-sent", (await keysOf()).hint === "hidden", "after a send clears the prompt, the keys row goes again (#1806)", await keysOf());
    const run0 = await state();
    ok("Q2-running", run0.primary === "Queue" && run0.keys === "queue" && run0.now === "Send now", "while a turn runs: the primary button is Queue, Shift+Enter queues, Send now beside it", run0);
    await type("and a square wave too");
    await shiftEnter();
    await sleep(300);
    const run1 = await state();
    ok("Q3-shift-enter", run1.running && run1.interrupted === 0 && run1.queued === "1 queued" && /queued/.test(run1.users.at(-1) ?? ""), "Shift+Enter during a turn queues the message: the turn goes on, 1 queued", run1);
    await type("label the axes");
    await ev(`document.querySelector('#send').click()`);
    await sleep(300);
    const run2 = await state();
    ok("Q4-primary", run2.running && run2.interrupted === 0 && run2.queued === "2 queued", "the primary button during a turn queues too: the turn goes on, 2 queued", run2);
    await type("stop and do this instead");
    await ev(`document.querySelector('#send-now').click()`);
    const stopped = await until(`[...document.querySelectorAll('.status')].some((x) => x.textContent === 'Interrupted')`, 10000).then(() => true, () => false);
    ok("Q5-send-now", stopped, "Send now interrupts the turn and sends", await state());
  }
  // ---- Files <-> Agents (#1808): nothing moves. The same edge, header row, top bar height and wordmark in both modes,
  //      switched by the switch itself, there and back; no banner above the Agents page
  {
    const FW = "sagebrush-files-width";
    const filesShown = `!!document.querySelector('#wssidebar:not([hidden]) .sbfiles .fh .sb-mode') && !!document.querySelector('header .title')`;
    const agentsShown = `document.readyState === 'complete' && !!document.querySelector('#editor .mb') && document.getElementById('sep-side').hasAttribute('aria-valuenow')`;
    const r = (s) => `(() => { const b = document.querySelector(${JSON.stringify(s)})?.getBoundingClientRect(); return b ? [b.left, b.top, b.width, b.height].map(Math.round) : null; })()`;
    const filesRects = async () => ({ edge: (await ev(r("#wssidebar")))?.[2], sw: await ev(r("#wssidebar .sb-mode")), toggle: await ev(r(".sb-files-toggle")), label: await ev(r(".sbfiles .fh > b")), top: (await ev(r("header")))?.[3], word: (await ev(r("header .title")))?.[0] });
    const agentsRects = async () => ({ edge: (await ev(r("nav.side")))?.[2], sw: await ev(r("nav.side .sb-mode")), toggle: await ev(r("#sidetoggle")), label: await ev(r("nav.side .brand-name")), top: (await ev(r(".top")))?.[3], word: (await ev(r(".top .wordmark")))?.[0], sideTop: (await ev(r("nav.side")))?.[1], banner: await ev(`!!document.querySelector('#banner, .banner')`) });
    const same = (f, a) => f.edge === a.edge && JSON.stringify(f.sw) === JSON.stringify(a.sw) && JSON.stringify(f.toggle) === JSON.stringify(a.toggle) && Math.abs(f.label[0] - a.label[0]) <= 1 && Math.abs((f.label[1] + f.label[3] / 2) - (a.label[1] + a.label[3] / 2)) <= 1 && f.top === a.top && f.word === a.word;
    await fresh(1400);
    await ev(`(localStorage.setItem("sagebrush-files-sidebar", "1"), true)`);
    await send("Page.navigate", { url: `${origin}/` });
    await until(filesShown, 60000);
    await sleep(500);
    const f0 = await filesRects();
    await ev(`(document.querySelector('#wssidebar .sb-mode [data-mode="agents"]').click(), true)`);
    await until(`location.pathname === '/agents/'`, 20000);
    await until(agentsShown, 30000);
    await sleep(500);
    const a = await agentsRects();
    ok("M-files-to-agents", same(f0, a) && a.edge === 272 && a.sideTop === 0 && !a.banner, "Files -> Agents by the switch: the panel's edge (272 px), the switch, the toggle, the panel's name, the top bar's height and the wordmark stay where they were; no banner", { f0, a });
    await ev(`(document.querySelector('nav.side .sb-mode [data-mode="files"]').click(), true)`);
    await until(`location.pathname === '/'`, 20000);
    await until(filesShown, 60000);
    await sleep(500);
    const f1 = await filesRects();
    ok("M-agents-to-files", JSON.stringify(f1) === JSON.stringify(f0), "and Agents -> Files puts the files back exactly as they were", { f0, f1 });

    // (one width for both: a drag of the chat list's edge is the files' width; the files' width is the chat list's)
    await fresh(1400);
    await drag("sep-side", 360);
    const kept = await ev(`localStorage.getItem(${JSON.stringify(FW)})`);
    await ev(`(localStorage.setItem("sagebrush-files-sidebar", "1"), true)`);
    await send("Page.navigate", { url: `${origin}/` });
    await until(filesShown, 60000);
    await sleep(500);
    const fw = (await ev(r("#wssidebar")))?.[2];
    ok("M-width-to-files", kept === "360" && fw === 360, "the chat list dragged to 360 px: the files open 360 px wide", { kept, fw });
    await ev(`(localStorage.setItem(${JSON.stringify(FW)}, "300"), true)`);
    await send("Page.navigate", { url: `${origin}/agents/` });
    await until(agentsShown, 30000);
    await sleep(300);
    const aw = (await ev(r("nav.side")))?.[2];
    ok("M-width-from-files", aw === 300, "the files' width (300 px) is the chat list's", { aw });
    // (a width this page kept before they shared one, and none for the files yet: it stays, and becomes the files')
    await fresh(1400, { stored: '{"side":330,"pane":600}' });
    const mig = { side: (await ev(r("nav.side")))?.[2], files: await ev(`localStorage.getItem(${JSON.stringify(FW)})`) };
    ok("M-width-migrated", mig.side === 330 && mig.files === "330", "a chat list width kept before (330 px) stays, and the files take it", mig);

    // (the status's popover: what the banner said; the status opens it, Escape and a click elsewhere close it)
    await fresh(1400);
    const pop = () => ev(`(() => { const w = document.querySelector('#who'), i = document.querySelector('#who-info'); return { shown: !i.hidden && i.getBoundingClientRect().height > 0, expanded: w.getAttribute('aria-expanded'), text: i.textContent, focus: document.activeElement === w, below: i.getBoundingClientRect().top >= document.querySelector('.top').getBoundingClientRect().bottom }; })()`);
    const p0 = await pop();
    await ev(`(document.querySelector('#who').click(), true)`);
    const p1 = await pop();
    ok("M-popover-open", !p0.shown && p0.expanded === "false" && p1.shown && p1.expanded === "true" && p1.below && /scripted/.test(p1.text) && p1.text.endsWith("Chats are kept in this browser only."), "the status opens its popover, under the top bar: the scripted preview, and where the chats are kept", { p0, p1 });
    // (the chevron: always there, pointing down at rest and up while open, and still there when the status's children
    //  are replaced, as whoText replaces them)
    const chev = () => ev(`(() => { const a = getComputedStyle(document.querySelector('#who'), '::after'); return { content: a.content, w: a.width, border: a.borderRightWidth, transform: a.transform }; })()`);
    const cOpen = await chev();
    ok("M-chevron", p1.shown && cOpen.content === '""' && cOpen.w === "5px" && parseFloat(cOpen.border) > 0, "the status shows a small chevron (a pseudo-element, no text)", cOpen);
    await key("Escape");
    const cRest = await chev();
    await ev(`(document.querySelector('#who').replaceChildren(document.createTextNode('Claude on laptop')), true)`);
    const cNew = await chev();
    ok("M-chevron-states", cRest.content === '""' && cRest.transform !== cOpen.transform && cNew.content === '""' && cNew.transform === cRest.transform, "it points another way while the popover is open, and stays when the status's text is replaced", { cOpen, cRest, cNew });
    const p2 = await pop();
    ok("M-popover-escape", !p2.shown && p2.expanded === "false" && p2.focus, "Escape closes it, back to the status", p2);
    await ev(`(document.querySelector('#who').click(), true)`);
    const [lx, ly] = await ev(`(() => { const b = document.querySelector('#log').getBoundingClientRect(); return [b.left + b.width / 2, b.bottom - 40]; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: lx, y: ly, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    await sleep(100);
    const p3 = await pop();
    ok("M-popover-away", !p3.shown && p3.expanded === "false", "a click elsewhere closes it", p3);

    // (it stays inside the window and the top bar: on a phone, after a resize while open, and beside a pane with the chat
    //  at its 420 px; where it fits, right under the status, the control)
    const place = () => ev(`(() => { const i = document.querySelector('#who-info').getBoundingClientRect(), w = document.querySelector('#who').getBoundingClientRect(), t = document.querySelector('.top').getBoundingClientRect();
      return { left: Math.round(i.left), right: Math.round(i.right), whoLeft: Math.round(w.left), topLeft: Math.round(t.left), topRight: Math.round(t.right), vw: innerWidth, scroll: document.documentElement.scrollWidth, shown: !document.querySelector('#who-info').hidden }; })()`);
    const inside = (q) => q.shown && q.left >= q.topLeft && q.right <= q.topRight && q.right <= q.vw && q.scroll <= q.vw;
    await ev(`(document.querySelector('#who').click(), true)`);
    const wide = await place();
    ok("M-popover-fits", inside(wide) && wide.left === wide.whoLeft, "at 1400 px it opens right under the status (the control)", wide);
    await size(390);
    await sleep(400);
    const resized = await place();
    ok("M-popover-resize", inside(resized), "resized to 390 px while open: still inside the window, no sideways scroll", resized);
    await fresh(390);
    await ev(`(document.querySelector('#who').click(), true)`);
    const phone = await place();
    ok("M-popover-390", inside(phone), "opened at 390 px: inside the window, no sideways scroll", phone);
    await fresh(1600);
    await openPane();
    await drag("sep-pane", 1600 - 931);
    await ev(`(document.querySelector('#who').click(), true)`);
    const tight = await place();
    ok("M-popover-tight", inside(tight) && (await w()).chat < 421, "beside a pane, the chat at 420 px: inside the top bar", tight);
  }
  console.log(`${checks - fails}/${checks} passed${fails ? "" : ", all passed"}`);
  code = fails ? 1 : 0;
} finally {
  chrome.kill("SIGKILL");
  server?.kill("SIGKILL");
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(code);
