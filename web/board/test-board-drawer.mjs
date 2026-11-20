// ci: web-browser/board-c order=170
// A note's drawer (web/board/drawer.ts), in headless Chromium: a click on a note opens its whole content in a panel
// on the right, its card on the canvas keeping its size; a drag, a link or a question's field doesn't open it; its
// width follows its grip (drag, keys), is kept in this browser and stays within the board; Esc closes it; it follows
// the document (a write made elsewhere, the note deleted, a rerun's output) and, in Edit, the selection, its Edit
// button writing the note where it is; another page, Present and TimeTravel close it; on a phone it is a sheet at the
// bottom.  Serve web/dist first (python3 web/serve.py 8765), then
//   node web/board/test-board-drawer.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-drawer-prof-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
// (a browser that goes away is a failure that says so, with Chrome's last stderr lines, never a silent exit)
let chromeTail = "", dead = "";
chrome.stderr.on("data", (d) => { chromeTail = (chromeTail + d).slice(-2048); });
const tabs = [];
const die = (why) => { if (dead) return; dead = why; for (const t of tabs) t.dieAll(why); };
chrome.on("exit", (code, signal) => die(`Chrome exited (code ${code}, signal ${signal})`));
const port = await devtoolsPort(profile, 60_000, { child: chrome });
const fails = [];
let checks = 0;
const check = (ok, what, got) => { checks++; if (!ok) fails.push(what + (got === undefined ? "" : ": " + JSON.stringify(got))); };

/** A tab: its DevTools socket, with bounded calls that fail at once when the browser is gone. */
async function tab(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onclose = () => fail(new Error(`the DevTools socket closed before it opened; Chrome's stderr: ${chromeTail}`)); });
  let n = 0;
  const waiting = new Map(), errors = [];
  const t = {
    errors,
    dieAll(why) { for (const [, w] of waiting) { clearTimeout(w.timer); w.at.message = why; w.fail(w.at); } waiting.clear(); },
    send(method, params = {}, ms = 60000) {
      return new Promise((ok, fail) => {
        const at = new Error(dead);
        if (dead) return fail(at);
        const id = ++n;
        const timer = setTimeout(() => { waiting.delete(id); at.message = `${method}: no answer in ${ms / 1000} s`; fail(at); }, ms);
        waiting.set(id, { ok, fail, timer, at });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    async ev(expression) { const r = await t.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; },
    async until(expr, ms = 20000) { const s = Date.now(); while (Date.now() - s < ms) { if (await t.ev(expr).catch((e) => { if (dead) throw e; return false; })) return true; await sleep(80); } return false; },
  };
  ws.onclose = () => die("the DevTools socket closed");
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); clearTimeout(w.timer); w.ok(m.result ?? m.error); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
    if (m.method === "Inspector.targetCrashed") die("a page crashed");
  };
  tabs.push(t);
  for (const m of ["Page.enable", "Runtime.enable", "Inspector.enable"]) await t.send(m);
  return t;
}
const pageTarget = async (id) => {
  for (let i = 0; i < 100; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json().catch(() => []);
    const p = list.find((x) => x.type === "page" && (id ? x.id === id : true));
    if (p) return p;
    await sleep(100);
  }
  throw new Error("no page target");
};

// the paragraphs of a long note: far more than its card shows
const LONG = Array.from({ length: 40 }, (_, k) => `Paragraph ${k}: words to read at full size.`).join("\n\n");
const DOC = (o = {}) => ({
  title: "Drawer",
  pages: [
    {
      nodes: [
        { id: "long", title: "Long note", text: o.longText ?? LONG, detail: "A detail, shown in the drawer at any zoom", x: 0, y: 0, w: 260, h: 140 },
        { id: "code", title: "Many lines", code: o.code ?? 'for i in range(60):\n    print("line", i)', x: 400, y: 0, w: 360, h: 180 },
        { id: "linked", title: "A link", text: "Below, a link.", ref: "#long", x: 0, y: 420, w: 260 },
        { id: "q", kind: "ask", input: "text", text: "Name a prime", x: 400, y: 420, w: 300 },
      ].filter((n) => !(o.without ?? []).includes(n.id)),
      edges: [],
    },
    // (a note with the same id as the first page's: an id is its page's own)
    { nodes: [{ id: "long", title: "Second page", text: "Another page" }], edges: [] },
  ],
});

let A;
try {
  // the board, made in tab A (a board of the workspace, editable here)
  A = await tab((await pageTarget()).webSocketDebuggerUrl);
  await A.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await A.send("Page.navigate", { url: `${base}board/?new=python` });
  if (!(await A.until("/doc=local:/.test(location.search) && !!window.sagebrush?.board?.snapshot?.()?.doc", 60000))) throw new Error("the board page made no board");
  await A.ev("localStorage.removeItem('sagebrush-board:drawer-width'), 1");
  const id = await A.ev("new URLSearchParams(location.search).get('doc').slice('local:'.length)");
  const W = "window.sagebrush.workspace";
  if (!(await A.until(`${W}.list("/").then((l) => l.some((e) => e.kind === "board" && e.ref === ${JSON.stringify(id)}))`, 20000))) throw new Error("the board isn't in the workspace");
  const path = await A.ev(`${W}.list("/").then((l) => l.find((e) => e.kind === "board" && e.ref === ${JSON.stringify(id)}).path)`);
  // tab B, another page of this browser, writes the board (as an agent, or another of the person's tabs)
  const created = await A.send("Target.createTarget", { url: "about:blank" });
  const B = await tab((await pageTarget(created.targetId)).webSocketDebuggerUrl);
  await B.send("Page.navigate", { url: base });
  if (!(await B.until(`!!${W}`, 60000))) throw new Error("tab B has no workspace");
  const write = (doc) => B.ev(`${W}.read(${JSON.stringify(path)}).then((r) => ${W}.write(${JSON.stringify(path)}, ${JSON.stringify(doc)}, { base: r.rev })).then((r) => r.rev)`);
  await write(DOC());
  // (tab A in front again: a tab behind gets no animation frames, which the camera's flights and the drawer use)
  await A.send("Page.bringToFront");
  check(await A.until("window.board?.item('long') && window.board.item('code') && window.sagebrush.board.snapshot().page === 0", 20000), "the board is shown in tab A");
  // (a board made here opens in Edit: read it in View)
  await A.ev("window.sagebrush.board.editing(false), 1");
  // (its code: run by the person, as a board written elsewhere waits for)
  await A.ev(`(document.querySelector("[data-sbb=runpaused]:not([hidden])")?.click(), 1)`);
  check(await A.until("window.sagebrush.board.outputs().then((os) => /line 59/.test(os.find((o) => o.id === 'code')?.output ?? ''))", 90000), "its code runs: 60 lines of output");

  const mouse = (type, x, y, extra = {}) => A.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
  // (a click on a note is told 250 ms after it, when no second click has come: the first of a double-click opens nothing)
  const click = async (x, y) => { await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); await sleep(400); };
  const key = (k, extra = {}) => A.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: extra.code ?? k, windowsVirtualKeyCode: { Enter: 13, Escape: 27, ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, Home: 36, End: 35, o: 79 }[k] ?? 0, ...extra });
  const rect = (nid) => A.ev(`window.board.clientRect(${JSON.stringify(nid)})`);
  const look = (nid, sx = 200, sy = 200, z = 1) => A.ev(`(() => { const it = window.board.item(${JSON.stringify(nid)}); window.board.setCamera({ x: it.x - ${sx} / ${z}, y: it.y - ${sy} / ${z}, z: ${z} }); window.board.render(); return 1; })()`).then(() => sleep(200));
  const D = `document.querySelector("[data-sbb=drawer]")`;
  const open = () => A.ev(`!${D}.hidden`);
  const drawerText = () => A.ev(`${D}.querySelector(".sbb-drawer-body").textContent`);
  const heading = () => A.ev(`${D}.querySelector("h2").textContent`);
  const width = () => A.ev(`${D}.getBoundingClientRect().width`);
  const cardBox = (nid) => A.ev(`(() => { const el = window.board.element(${JSON.stringify(nid)}); const it = window.board.item(${JSON.stringify(nid)}); return el && it ? { w: it.w, h: it.h, ow: el.offsetWidth, oh: el.offsetHeight, clips: el.scrollHeight > el.clientHeight + 4 } : null; })()`);
  const esc = async () => { await key("Escape"); await sleep(150); };

  // ---- a click on a note, in View: its whole content beside the board, the card as it was
  await look("long", 1000, 200); // (the card where the drawer will be: the camera moves it into view beside it)
  const card0 = await cardBox("long");
  check(card0?.clips, "the long note's card cuts its text off (the case for the drawer)", card0);
  const r0 = await rect("long");
  await click(Math.min(r0.left + 40, 1260), r0.top + 60);
  check(await open(), "a click on a note opens the drawer");
  check((await heading()) === "Long note", "…its title is the drawer's heading", await heading());
  const t0 = await drawerText();
  check(/Paragraph 0:/.test(t0) && /Paragraph 39:/.test(t0) && /A detail, shown/.test(t0), "…with all of the note: every paragraph, and its detail");
  check(JSON.stringify(await cardBox("long")) === JSON.stringify(card0), "…and the card keeps its size", [card0, await cardBox("long")]);
  // (the camera flies there)
  const beside = await A.until(`(() => { const r = window.board.clientRect("long"); return r.left + r.width <= ${D}.getBoundingClientRect().left + 1; })()`, 3000);
  check(beside, "…moved into view beside the drawer, not under it", { card: await rect("long"), drawerLeft: await A.ev(`${D}.getBoundingClientRect().left`) });
  check(Math.abs((await A.ev("window.board.insets.right")) - ((await width()) + 12)) <= 1, "the camera keeps clear of the drawer (its inset)", [await A.ev("window.board.insets.right"), await width()]);
  check(await A.ev(`!${D}.contains(document.activeElement)`), "opened by a click: the focus stays where it was");
  check((await A.ev(`document.querySelector(".sbb .sbb-sr").textContent`)) === "Opened: Long note", "…and the opening is said to a screen reader", await A.ev(`document.querySelector(".sbb .sbb-sr").textContent`));
  check(Math.round(await width()) === 480, "its usual width: 480 px on a 1280 px board", await width());

  // another note, clicked: shown in its place; its whole output, which its card cuts off
  await look("code", 200, 150);
  const rc = await rect("code");
  await click(rc.left + 30, rc.top + 30);
  check((await heading()) === "Many lines" && /line 0\b/.test(await drawerText()) && /line 59\b/.test(await drawerText()), "a click on another note shows it: all 60 lines of its output");
  check((await cardBox("code"))?.clips, "…which its card cuts off");
  check(await A.ev(`!!${D}.querySelector(".board-code-run")`), "…with its Run button");
  await esc();
  check(!(await open()), "Esc closes it");
  check((await A.ev("window.board.insets.right")) === 0, "…and the camera has the whole board again");
  // a double-click is still a double-click (the camera flies to the note): no drawer
  const rdc = await rect("long");
  await mouse("mousePressed", rdc.left + 40, rdc.top + 60);
  await mouse("mouseReleased", rdc.left + 40, rdc.top + 60);
  await mouse("mousePressed", rdc.left + 40, rdc.top + 60, { clickCount: 2 });
  await mouse("mouseReleased", rdc.left + 40, rdc.top + 60, { clickCount: 2 });
  await sleep(500);
  check(!(await open()), "a double-click on a note is the board's (it flies there): no drawer");

  // what doesn't open it: a drag on a note (the board pans), its link, a question's field
  await look("long", 200, 200);
  const rd = await rect("long");
  await mouse("mousePressed", rd.left + 40, rd.top + 50);
  for (let k = 1; k <= 5; k++) await mouse("mouseMoved", rd.left + 40 + 30 * k, rd.top + 50 + 10 * k);
  await mouse("mouseReleased", rd.left + 190, rd.top + 100);
  await sleep(400);
  check(!(await open()), "a drag on a note pans the board: no drawer");
  // a click, then another page before it is told: nothing opens there (the same id is another note)
  const rpc = await rect("long");
  await mouse("mousePressed", rpc.left + 40, rpc.top + 60);
  await mouse("mouseReleased", rpc.left + 40, rpc.top + 60);
  await A.ev("window.sagebrush.board.page(1).then(() => 1)");
  await sleep(500);
  check(!(await open()), "a click followed at once by another page: nothing opens on that page");
  await A.ev("window.sagebrush.board.page(0).then(() => 1)");
  await A.until("window.board.item('long')?.h === 140", 10000);
  await look("linked", 200, 200);
  const link = await A.ev(`(() => { const a = window.board.element("linked")?.querySelector("a.board-ref"); if (!a) return null; const r = a.getBoundingClientRect(); return { x: r.left + 8, y: r.top + r.height / 2 }; })()`);
  if (link) await click(link.x, link.y);
  check(link && !(await open()), "a click on a note's link follows the link: no drawer");
  await look("q", 200, 200);
  const field = await A.ev(`(() => { const f = window.board.element("q")?.querySelector("input, textarea"); if (!f) return null; const r = f.getBoundingClientRect(); return { x: r.left + 8, y: r.top + r.height / 2 }; })()`);
  if (field) await click(field.x, field.y);
  check(field && !(await open()), "a click in a question's field is the field's: no drawer");
  const rq = await rect("q");
  await click(rq.left + 6, rq.top + 6);
  check(!(await open()), "…nor a question elsewhere (step 1: notes only)");

  // ---- its width: the grip (drag), kept in this browser; the keys; within the board
  await look("long", 200, 200);
  const rw = await rect("long");
  await click(rw.left + 40, rw.top + 60);
  const g = await A.ev(`(() => { const r = ${D}.querySelector(".sbb-drawer-grip").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await mouse("mousePressed", g.x, g.y);
  for (let k = 1; k <= 4; k++) await mouse("mouseMoved", g.x - 25 * k, g.y);
  await mouse("mouseReleased", g.x - 100, g.y);
  await sleep(100);
  const w1 = Math.round(await width());
  check(Math.abs(w1 - 580) <= 2, "dragging its grip 100 px left widens it to about 580 px", w1);
  const kept = await A.ev("localStorage.getItem('sagebrush-board:drawer-width')");
  check(Math.abs(Number(kept) - w1 / 1280) < 0.001, "…kept in this browser, as a fraction of the board's width", kept);
  await A.ev(`${D}.querySelector(".sbb-drawer-grip").focus(), 1`);
  check(await A.ev(`(() => { const s = ${D}.querySelector(".sbb-drawer-grip"); return s.getAttribute("role") === "separator" && s.getAttribute("aria-orientation") === "vertical" && s.getAttribute("aria-valuenow") === String(${w1}) && s.getAttribute("aria-valuemin") === "280" && s.getAttribute("aria-valuemax") === "1024"; })()`), "the grip is a vertical separator with its width and bounds");
  await key("ArrowLeft");
  check(Math.round(await width()) === w1 + 16, "← widens it by 16 px", await width());
  await key("ArrowRight", { modifiers: 8 });
  check(Math.round(await width()) === w1 + 16 - 64, "Shift+→ narrows it by 64 px", await width());
  await key("Home");
  check(Math.round(await width()) === 280, "Home: its least width, 280 px", await width());
  await key("End");
  check(Math.round(await width()) === 1024, "End: its most, 80% of the board's width", await width());
  await A.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
  check(await A.until(`Math.round(${D}.getBoundingClientRect().width) === 720`, 5000), "the board narrowed to 900 px: the drawer within 80% of it", await width());
  await A.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  await A.ev(`${D}.querySelector(".sbb-drawer-grip").focus(), 1`);
  await key("Home");
  await A.send("Emulation.setDeviceMetricsOverride", { width: 650, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  check(Math.round(await width()) === 280, "at its least width, the board narrowed to 650 px: still 280 px (its fraction would be 142)", await width());
  await A.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  // (a reload: the width kept)
  await A.ev(`${D}.querySelector(".sbb-drawer-grip").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), 1`);
  check(Math.round(await width()) === 480, "a double-click on the grip puts the usual width back", await width());
  await A.ev(`${D}.querySelector(".sbb-drawer-grip").focus(), 1`);
  await key("ArrowLeft", { modifiers: 8 });
  check(Math.round(await width()) === 544, "(widened to 544 px)", await width());
  await A.send("Page.reload");
  check(await A.until("window.board?.item('long') && !!document.querySelector('[data-sbb=drawer]')", 60000), "the page reloaded");
  await A.ev("window.sagebrush.board.editing(false), 1");
  await look("long", 200, 200);
  const rr = await rect("long");
  await click(rr.left + 40, rr.top + 60);
  check((await open()) && Math.round(await width()) === 544, "after a reload, the drawer opens at the width kept", await width());

  // ---- a link in the drawer to a note of the board: the drawer shows that note
  await look("linked", 200, 200);
  const rl = await rect("linked");
  await click(rl.left + 30, rl.top + 12);
  check((await heading()) === "A link", "(the linked note's drawer)", await heading());
  await A.ev(`${D}.querySelector("a.board-ref").click(), 1`);
  check(await A.until(`${D}.querySelector("h2").textContent === "Long note"`, 3000), "a link in the drawer to a note shows that note in the drawer", await heading());

  // ---- it follows the document: a write made elsewhere, then the note deleted
  await write(DOC({ longText: "Rewritten elsewhere: one short paragraph." }));
  check(await A.until(`/Rewritten elsewhere/.test(${D}.querySelector(".sbb-drawer-body").textContent)`, 15000), "a write made elsewhere shows in the open drawer at once", await drawerText());
  await write(DOC({ without: ["long"] }));
  check(await A.until(`/This note was deleted/.test(${D}.querySelector(".sbb-drawer-body").textContent)`, 15000), "the note deleted elsewhere: the drawer says so", await drawerText());
  check(await open(), "…and stays open until it is closed");
  await esc();
  await write(DOC());
  await A.until("!!window.board.item('long')", 15000);
  // ...and a rerun's output
  await look("code", 200, 150);
  const rc2 = await rect("code");
  await click(rc2.left + 30, rc2.top + 30);
  await A.ev(`window.sagebrush.board.edit((d) => { d.pages[0].nodes.find((n) => n.id === "code").code = 'print("rerun", 6 * 7)'; }).then(() => 1)`);
  await A.ev(`(document.querySelector("[data-sbb=runpaused]:not([hidden])")?.click(), 1)`);
  check(await A.until(`/rerun 42/.test(${D}.querySelector(".sbb-drawer-body").textContent) && !/line 59/.test(${D}.querySelector(".sbb-drawer-body").textContent)`, 60000), "the code changed and rerun: the drawer shows the new output", await drawerText());

  // ---- another page, Present and TimeTravel close it
  await A.ev("window.sagebrush.board.page(1).then(() => 1)");
  check(await A.until(`${D}.hidden`, 5000), "another page closes it (an id is its page's own)");
  await A.ev("window.sagebrush.board.page(0).then(() => 1)");
  await A.until("!!window.board.item('long')", 10000);
  await look("long", 200, 200);
  const rp = await rect("long");
  await click(rp.left + 40, rp.top + 60);
  check(await open(), "(open again)");
  await A.ev("window.sagebrush.board.present(true).then(() => 1)");
  check(await A.until(`${D}.hidden`, 5000), "Present closes it");
  await A.ev("window.sagebrush.board.present(false).then(() => 1)");
  await sleep(300);
  await look("long", 200, 200);
  const rt = await rect("long");
  await click(rt.left + 40, rt.top + 60);
  check(await open(), "(open again)");
  await A.ev(`document.querySelector("[data-sbb=timetravel]").click(), 1`);
  check(await A.until(`${D}.hidden && !document.querySelector("[data-sbb=tt]").hidden`, 10000), "TimeTravel closes it");
  await look("long", 200, 200);
  const rt2 = await rect("long");
  await click(rt2.left + 40, rt2.top + 60);
  check(!(await open()), "…and a click in TimeTravel opens nothing");
  await A.ev(`document.querySelector("[data-sbb=ttclose]")?.click(), 1`);
  await A.until(`document.querySelector("[data-sbb=tt]").hidden`, 5000);

  // ---- in Edit: O opens it (the focus goes to it), it follows the selection, its Edit button writes the note in place
  await A.ev("window.sagebrush.board.editing(true), 1");
  await look("long", 200, 200);
  const re = await rect("long");
  await click(re.left + 40, re.top + 60);
  check(!(await open()), "in Edit a click selects: no drawer");
  await key("o", { code: "KeyO", text: "o" });
  check(await A.until(`!${D}.hidden`, 3000), "O, one note selected: its drawer");
  check(await A.ev(`document.activeElement === ${D}.querySelector("h2")`), "…opened from the keyboard, the focus is on its heading");
  check(await A.ev(`!${D}.querySelector(".sbb-drawer-edit").hidden`), "…and in Edit it has an Edit button");
  // keys pressed in the drawer are its own: never the board's shortcuts on the note selected
  const before = JSON.stringify(await A.ev("(() => { const n = window.sagebrush.board.snapshot().doc.pages[0].nodes.find((x) => x.id === 'long'); return n ? [n.x, n.y] : null; })()"));
  for (const k of ["ArrowDown", "ArrowRight", "Delete", "Backspace"]) await key(k);
  await key("a", { modifiers: 2, code: "KeyA" });
  await sleep(300);
  const after = JSON.stringify(await A.ev("(() => { const n = window.sagebrush.board.snapshot().doc.pages[0].nodes.find((x) => x.id === 'long'); return n ? [n.x, n.y] : null; })()"));
  check(after !== "null" && after === before, "arrows, Delete, Backspace and Ctrl+A in the drawer neither move nor delete the note", [before, after]);
  check(await open() && (await heading()) === "Long note", "…and the drawer stays on it");
  const rs = await rect("code");
  await click(rs.left + 30, rs.top + 12);
  check(await A.until(`${D}.querySelector("h2").textContent === "Many lines"`, 3000), "another note selected: the drawer follows it", await heading());
  await A.ev(`${D}.querySelector(".sbb-drawer-edit").click(), 1`);
  check(await A.until("window.board.editing === 'code'", 3000), "Edit writes the note where it is, in its card", await A.ev("window.board.editing"));
  check(await A.ev(`!!document.querySelector(".ip-bar .ip-drawer")`), "the in-place toolbar has the drawer's button");
  await A.ev(`(() => { const t = document.querySelector(".board-editing .be-codebox textarea"); t.value = 'print("written in place")'; t.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  await click(30, 380); // (a click outside, on the board: what was written is kept)
  check(await A.until(`/written in place/.test(${D}.querySelector(".sbb-drawer-body").textContent)`, 5000), "what was written in place, kept, shows in the drawer", await drawerText());
  await A.ev(`${D}.querySelector("h2").focus(), 1`);
  await esc();
  check(!(await open()) && await A.ev(`document.activeElement === document.querySelector(".sbb .board")`), "Esc in the drawer closes it, the focus back on the board", await A.ev("document.activeElement?.className"));
  // the note deleted here (Delete, on the board), then undone: said, then shown again
  await look("linked", 200, 200);
  const rx = await rect("linked");
  await click(rx.left + 30, rx.top + 12);
  await key("o", { code: "KeyO", text: "o" });
  check(await A.until(`!${D}.hidden && ${D}.querySelector("h2").textContent === "A link"`, 3000), "(its drawer, by O)");
  await A.ev("document.querySelector('.sbb .board').focus(), 1");
  await key("Delete");
  check(await A.until(`/This note was deleted/.test(${D}.querySelector(".sbb-drawer-body").textContent)`, 5000), "the note deleted here: the drawer says so", await drawerText());
  await key("z", { modifiers: 2, code: "KeyZ" });
  check(await A.until(`/Below, a link/.test(${D}.querySelector(".sbb-drawer-body").textContent)`, 5000), "…undone: the drawer shows it again", await drawerText());
  // a note that is no longer one the drawer shows (made a question): closed, not said to be deleted
  await A.ev(`window.sagebrush.board.edit((d) => { const n = d.pages[0].nodes.find((x) => x.id === "linked"); n.kind = "ask"; n.input = "text"; delete n.ref; }).then(() => 1)`);
  check(await A.until(`${D}.hidden`, 5000), "the note made a question: the drawer closes (it isn't deleted)", await drawerText());
  await A.ev(`window.sagebrush.board.edit((d) => { const n = d.pages[0].nodes.find((x) => x.id === "linked"); delete n.kind; delete n.input; n.ref = "#long"; }).then(() => 1)`);
  await A.ev("window.sagebrush.board.editing(false), 1");

  // ---- on a phone: a sheet at the bottom; dragged down, closed
  await A.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  await look("long", 60, 120);
  const rm = await rect("long");
  await click(rm.left + 30, rm.top + 50);
  check(await open(), "on a phone a tap opens it");
  const sheet = await A.ev(`(() => { const r = ${D}.getBoundingClientRect(), b = document.querySelector(".sbb").getBoundingClientRect(); return { cls: ${D}.classList.contains("sbb-sheet"), left: r.left, width: r.width, bottom: r.bottom, height: r.height, boardBottom: b.bottom, boardHeight: b.height }; })()`);
  check(sheet.cls && sheet.left === 0 && Math.round(sheet.width) === 390 && Math.abs(sheet.bottom - sheet.boardBottom) <= 1 && Math.abs(sheet.height - 0.45 * sheet.boardHeight) <= 2, "…as a sheet at the bottom of the board, its whole width, 45% of its height", sheet);
  check((await A.ev("window.board.insets.bottom")) >= sheet.height && (await A.ev("window.board.insets.right")) === 0, "…the camera keeping clear of it below", await A.ev("window.board.insets"));
  await A.ev(`${D}.querySelector(".sbb-drawer-grip").focus(), 1`);
  const h0 = Math.round(sheet.height);
  await key("ArrowUp");
  check(Math.round(await A.ev(`${D}.getBoundingClientRect().height`)) === h0 + 16 && (await A.ev(`${D}.querySelector(".sbb-drawer-grip").getAttribute("aria-orientation")`)) === "horizontal", "its grip, a horizontal separator: ↑ makes it 16 px taller", await A.ev(`${D}.getBoundingClientRect().height`));
  const sg = await A.ev(`(() => { const r = ${D}.querySelector(".sbb-drawer-grip").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await mouse("mousePressed", sg.x, sg.y);
  for (let k = 1; k <= 6; k++) await mouse("mouseMoved", sg.x, sg.y + 50 * k);
  await mouse("mouseReleased", sg.x, sg.y + 300);
  await sleep(150);
  check(!(await open()), "dragged down, the sheet closes");
  check((await A.ev("window.board.insets.bottom")) < 100, "…and the camera has the board again", await A.ev("window.board.insets"));
  // a finger: a tap opens it; a double tap is the board's (it flies there), and opens nothing
  await A.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  const tap = async (x, y) => { await A.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] }); await A.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); };
  await look("long", 60, 120);
  const rt3 = await rect("long");
  await tap(rt3.left + 30, rt3.top + 50);
  await sleep(150);
  await tap(rt3.left + 30, rt3.top + 50);
  await sleep(600);
  check(!(await open()), "a double tap on a note opens nothing");
  await look("long", 60, 120);
  const rt4 = await rect("long");
  await tap(rt4.left + 30, rt4.top + 50);
  check(await A.until(`!${D}.hidden`, 3000), "a tap opens it");

  check(!A.errors.length && !B.errors.length, "no errors", [...A.errors, ...B.errors]);
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
