// ci: web-browser/notebook order=152
// The notebook's compact ⋯ menu: its approved Help and conditional Terminal
// groups, desktop and phone geometry, and real-key keyboard navigation.
// Run after `bun web/build.ts`:
//   CHROME=google-chrome node web/test-notebook-more-menu.mjs
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
const profile = mkdtempSync(join(tmpdir(), "sb-notebook-more-menu-"));
let server, chrome, ws;

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
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result?.value;
  };
  const until = async (expr, ms = 20_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(50); } throw new Error("timeout: " + expr); };
  const key = async (key, modifiers = 0) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, modifiers });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, modifiers });
  };
  const goto = async (query) => {
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/${query}` });
    await until("document.querySelector('#status')?.textContent.startsWith('ready')", 60_000);
  };
  // (the terminal on your computer offered as the page offers it: the peers answer, here stubbed, says the account can
  // use it, asked at this first ⋯ open)
  const showEverything = () => ev(`(async () => {
    for (const id of ["installbtn", "moreagent", "termendbtn"]) document.getElementById(id).hidden = false;
    const f = window.fetch;
    window.fetch = (u, o) => String(u).includes("/api/remote/v1/peers") ? Promise.resolve(new Response('{"peers":[],"available":true}', { headers: { "content-type": "application/json" } })) : f(u, o);
    document.getElementById("morebtn").click();
    for (let i = 0; i < 100 && document.getElementById("rtermbtn").hidden; i++) await new Promise((r) => setTimeout(r, 20));
    window.fetch = f;
    return !document.getElementById("moremenu").hidden && !document.getElementById("rtermbtn").hidden;
  })()`);

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  await goto("?phone=0");

  ok(await ev(`(() => {
    const g = document.querySelector('button[data-group="help"]');
    return g?.textContent === "Help ▸" && g.title === "Keyboard shortcuts, how cells run, tips, and where to get help"
      && JSON.stringify([...g.nextElementSibling.children].map((x) => x.id)) === JSON.stringify(["keysbtn", "howruns", "tipslink", "aboutlink", "llmslink", "supportlink"]);
  })()`), "Help has the approved label, title and six rows in order");
  ok(await ev(`(() => {
    const ids = [...document.querySelectorAll('#moremenu > button, #moremenu > a')].map((x) => x.id || x.dataset.group);
    return ids.indexOf("installbtn") === ids.indexOf("moresearch") + 1 && !ids.includes("moretools") && !document.getElementById("toolrow") && document.getElementById("filesbtn").textContent === "Python's files";
  })()`), "Install follows Search functions, with no More tools (its row is gone), and Files is named Python's files");
  ok(await ev(`(() => {
    const a = Object.fromEntries(["howruns", "tipslink", "aboutlink", "llmslink", "supportlink"].map((id) => [id, document.getElementById(id).getAttribute("href")]));
    return JSON.stringify(a) === JSON.stringify({ howruns: "/articles/notebook/01-how-cells-run", tipslink: "/?home#tips", aboutlink: "/?home", llmslink: "/llms.txt", supportlink: "https://cocalc.ai/support/new" });
  })()`), "every Help link keeps its destination");

  // With every conditional row offered, the closed groups keep an 800x600
  // menu wholly visible without a scrollbar.
  ok(await showEverything(), "the desktop ⋯ menu opens with every conditional row offered");
  const desktop = await ev(`(() => { const m = document.getElementById("moremenu"), r = m.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: innerHeight, scroll: m.scrollHeight, client: m.clientHeight }; })()`);
  ok(desktop.top >= 0 && desktop.bottom <= desktop.h && desktop.scroll <= desktop.client + 1, `at 800x600 the complete compact menu fits without scrolling (${JSON.stringify(desktop)})`);
  ok(await ev(`(() => {
    const g = document.querySelector('button[data-group="terminal"]');
    return !g.hidden && g.textContent === "Terminal ▸" && JSON.stringify([...g.nextElementSibling.children].map((x) => x.id)) === JSON.stringify(["termbtn", "termendbtn", "rtermbtn"]);
  })()`), "Terminal is a three-row group when another Terminal action is offered");

  // These are real CDP key events.  Right enters a group, Left leaves and
  // closes it, and Escape closes the whole menu and returns to its button.
  await ev(`(() => { const m = document.getElementById("moremenu"); m.tabIndex = -1; m.focus(); })()`);
  await key("ArrowUp");
  ok(await ev(`(() => {
    const m = document.getElementById("moremenu"), items = [...m.querySelectorAll('button:not([hidden]), a:not([hidden])')].filter((x) => !x.closest('[hidden]'));
    return document.activeElement === items.at(-1);
  })()`), "ArrowUp with no menu row focused wraps to the last visible row");

  const closedVisible = await ev(`(() => {
    document.querySelector('button[data-group="help"]').click();
    document.querySelector('button[data-group="help"]').click();
    const m = document.getElementById("moremenu");
    window.__closedVisible = [...m.querySelectorAll('button:not([hidden]), a:not([hidden])')].filter((x) => !x.closest('[hidden]'));
    window.__closedVisited = [];
    window.__closedVisible[0].focus();
    return window.__closedVisible.length;
  })()`);
  for (let i = 0; i < closedVisible; i++) {
    await key("ArrowDown");
    await ev(`window.__closedVisited.push(document.activeElement)`);
  }
  ok(await ev(`(() => {
    const expected = [...window.__closedVisible.slice(1), window.__closedVisible[0]];
    return window.__closedVisited.length === expected.length
      && window.__closedVisited.every((x, i) => x === expected[i])
      && document.activeElement === window.__closedVisible[0];
  })()`), "ArrowDown visits every visible row and wraps without entering a closed group");

  await ev(`document.querySelector('button[data-group="help"]').focus(), true`);
  await key("ArrowRight");
  ok(await ev(`document.activeElement.id === "keysbtn" && document.querySelector('button[data-group="help"]').getAttribute("aria-expanded") === "true"`), "ArrowRight opens Help and enters its first row");
  await ev(`document.querySelector('button[data-group="help"]').focus(), true`);
  await key("ArrowRight");
  ok(await ev(`document.activeElement.id === "keysbtn" && document.querySelector('button[data-group="help"]').getAttribute("aria-expanded") === "true"`), "ArrowRight on open Help enters it without closing it");
  await key("ArrowLeft");
  ok(await ev(`document.activeElement === document.querySelector('button[data-group="help"]') && document.activeElement.getAttribute("aria-expanded") === "false"`), "ArrowLeft leaves and closes Help");
  await ev(`document.querySelector('button[data-group="terminal"]').focus(), true`);
  await key("ArrowRight");
  ok(await ev(`document.activeElement.id === "termbtn" && document.querySelector('button[data-group="terminal"]').getAttribute("aria-expanded") === "true"`), "ArrowRight opens Terminal and enters its first row");
  await key("ArrowLeft");
  ok(await ev(`document.activeElement === document.querySelector('button[data-group="terminal"]') && document.activeElement.getAttribute("aria-expanded") === "false"`), "ArrowLeft leaves and closes Terminal");
  await key("Escape");
  ok(await ev(`document.getElementById("moremenu").hidden && document.activeElement.id === "morebtn"`), "Escape closes ⋯ and returns focus to its button");

  // H remains the command-mode shortcut even though the row moved.
  await ev(`document.querySelector('#cells .cell').focus(), true`);
  await key("h");
  ok(await ev(`document.querySelector('dialog.sbnb-keys')?.open === true`), "H in command mode still opens Keyboard shortcuts");
  await ev(`document.querySelector('dialog.sbnb-keys').close(), true`);

  // With no secondary action, the group disappears and Terminal is the plain
  // top-level row again.
  const ungroupedTerminal = await ev(`(() => {
    const e = document.getElementById("termendbtn"), r = document.getElementById("rtermbtn"), g = document.querySelector('button[data-group="terminal"]');
    e.hidden = true; r.hidden = false; dispatchEvent(new Event("sb-term-place")); g.click();
    r.hidden = true; dispatchEvent(new Event("sb-term-place"));
    return { plain: g.hidden && document.getElementById("termbtn").parentElement.id === "moremenu",
      closed: g.getAttribute("aria-expanded") === "false" && g.nextElementSibling.hidden };
  })()`);
  ok(ungroupedTerminal.plain, "ending the only secondary Terminal action restores its plain row");
  ok(ungroupedTerminal.closed, "ungrouping Terminal leaves its group closed");

  // The phone sheet bounds its height; every top-level and child row can be
  // focused and scrolled wholly into the sheet.
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await goto("?phone=1");
  ok(await showEverything(), "the phone ⋯ sheet opens with every conditional row offered");
  const phone = await ev(`(() => { const m = document.getElementById("moremenu"), r = m.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: innerHeight, overflow: getComputedStyle(m).overflowY }; })()`);
  ok(phone.top >= 0 && phone.bottom <= phone.h && phone.overflow === "auto", `at 390x844 the ⋯ menu is a bounded scrolling sheet (${JSON.stringify(phone)})`);
  for (const name of ["help", "terminal"]) {
    await ev(`document.querySelector('button[data-group=${JSON.stringify(name)}]').click(), true`);
    const reached = await ev(`(() => {
      const m = document.getElementById("moremenu"), items = [...m.querySelectorAll('button:not([hidden]), a:not([hidden])')].filter((x) => !x.closest('[hidden]'));
      for (const x of items) { x.focus({ preventScroll: true }); x.scrollIntoView({ block: "nearest" }); const r = x.getBoundingClientRect(), q = m.getBoundingClientRect(); if (r.top < q.top - .5 || r.bottom > q.bottom + .5) return false; }
      return true;
    })()`);
    ok(reached, `on a phone every visible ${name} menu row is reachable`);
    await ev(`document.querySelector('button[data-group=${JSON.stringify(name)}]').click(), true`);
  }
} finally {
  try { ws?.close(); } catch {}
  const gone = chrome?.exitCode !== null ? Promise.resolve() : new Promise((r) => chrome?.once("exit", r));
  chrome?.kill(); server?.kill();
  await Promise.race([gone, sleep(5000)]);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(fails.length ? `${fails.length} of ${checks} failed` : `${checks}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
