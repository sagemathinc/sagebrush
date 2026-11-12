// ci: web-browser/remote-preview order=20
// The terminal on your computer in the notebook page (web/notebook/remote-terminal-view.ts, sagebrush-remote-terminal.js;
// terminals T-3), end to end in headless Chromium with its real xterm: offered only when the peers answer says the account
// can use it (asked once, at the first ⋯ open; never on the CLI's page or in the app); the computers from
// GET /api/remote/v1/peers (runners only, names as text); the page leg's URL and its open (a DPoP proof over the
// synthetic open URL with its query); replay, live, acks once drawn; xterm's answers to the replay's queries not sent,
// to a live one sent; typing; the OUT-ISO rules (OSC 52 swallowed, a title as text, links http(s) only, opened on a
// click with noopener); the extra-keys row on a phone; a reattach to the remembered session; exit; a lost leg; ✕.
// The relay leg is a fake WebSocket in the page; the peers request is answered through CDP.  It serves web/dist itself:
//   bun web/build.ts && node web/test-remote-terminal-page.mjs      (CHROME=... for another browser binary)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort, startServe } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };
const profile = mkdtempSync(join(tmpdir(), "sb-remote-terminal-"));
const b64 = (s) => Buffer.from(s, "latin1").toString("base64");
const unb64url = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
let server = null, chrome = null, ws = null;
try {
  const serve = startServe(() => (server = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] })));
  const port = await serve.port;
  const base = `http://127.0.0.1:${port}/`;
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const cdpPort = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map();
  // (the peers list the next request gets, and how many were asked; `reply` can answer otherwise: { status, body }, "fail"
  // for a network error, or "hold" to keep the request in `held` until the test answers it)
  let peers = { peers: [] }, peersAsked = 0, reply = null;
  const held = [];
  const answer = (requestId, a = { status: 200, body: JSON.stringify({ ...peers, available: true }) }) => a === "fail"
    ? send("Fetch.failRequest", { requestId, errorReason: "Failed" })
    : send("Fetch.fulfillRequest", { requestId, responseCode: a.status, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(a.body).toString("base64") });
  // (a dialog the page opens, dismissed and counted: xterm's own OSC 8 handling, without the page's, asks with confirm())
  const dialogs = [];
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    else if (m.method === "Page.javascriptDialogOpening") {
      dialogs.push(m.params.message);
      send("Page.handleJavaScriptDialog", { accept: false });
    } else if (m.method === "Fetch.requestPaused") {
      peersAsked++;
      const r = reply?.();
      if (m.params.request.method !== "GET") answer(m.params.requestId, { status: 405, body: "{}" });
      else if (r === "hold") held.push(m.params.requestId);
      else answer(m.params.requestId, r ?? undefined);
    }
  };
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result?.value;
  };
  const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(50); } throw new Error("timeout: " + expr); };
  const goto = async (url) => { await send("Page.navigate", { url }); await sleep(300); await until("!!(window.sagebrush && window.sagebrush.notebook) && /ready/.test(document.querySelector('#status').textContent)", 60000); };
  // (⋯ opened or closed by its button, as a person does; whether the item is offered; the terminal chunk not loaded yet)
  const more = () => ev("document.querySelector('#morebtn').click(), !document.querySelector('#moremenu').hidden");
  const offered = () => ev("document.querySelector('#rtermbtn').hidden === false");
  const chunkLoaded = () => ev("performance.getEntriesByType('resource').some((e) => e.name.includes('sagebrush-remote-terminal.js'))");
  // (a fresh page, its ⋯ opened once and closed with the peers request answered by `a`, and how many requests it made)
  const firstOpen = async (url, a) => {
    reply = () => a;
    await goto(url);
    peersAsked = 0;
    await more();
    await sleep(300);
    await more();
    return peersAsked;
  };
  // (the relay leg: a fake WebSocket that answers the hello as a runner would; the test plays the runner's messages)
  const FAKE = `(() => {
    const leg = window.__leg = { legs: [], sent: [], opens: [], clip: 0, opened: [] };
    window.WebSocket = class {
      constructor(url) { this.url = url; this.h = { open: [], message: [], close: [], error: [] }; this.closed = null; leg.legs.push(this); leg.sock = this; setTimeout(() => this.fire("open", {}), 0); }
      addEventListener(k, f) { this.h[k].push(f); }
      fire(k, e) { for (const f of this.h[k]) f(e); }
      send(t) {
        const m = JSON.parse(t); leg.sent.push(m);
        if (m.method === "hello" && leg.refuse) setTimeout(() => this.fire("message", { data: JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: leg.refuse } }) }), 0);
        else if (m.method === "hello") setTimeout(() => this.fire("message", { data: JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { purpose: "terminal", token: "tok-" + leg.legs.length, nonce: "n0", gen: leg.legs.length, incarnation: "i1", channels: ["kernel", "terminal"] } }) }), 0);
        if (m.t === "open") leg.opens.push(m);
      }
      close(code, why) { this.closed = [code, why]; }
    };
    leg.push = (m) => leg.sock.fire("message", { data: JSON.stringify(m) });
    leg.drop = (code, why) => leg.sock.fire("close", { code, reason: why });
    leg.ins = () => leg.sent.filter((m) => m.t === "in").map((m) => atob(m.b)).join("");
    leg.acks = () => leg.sent.filter((m) => m.t === "ack").map((m) => m.upto);
    navigator.clipboard && (navigator.clipboard.writeText = async () => { leg.clip++; });
    window.open = (...a) => { leg.opened.push(a); return null; };
    return true;
  })()`;
  const push = (m) => ev(`__leg.push(${JSON.stringify(m)}), true`);
  const out = (s) => push({ t: "out", b: b64(s) });
  const status = () => ev("document.querySelector('#rterm .rstatus')?.textContent ?? null");
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/remote/v1/peers*", requestStage: "Request" }] });

  // 1. offered only for an account that can use it: asked once, at the first ⋯ open, never at load
  reply = () => ({ status: 200, body: JSON.stringify({ peers: [], available: false }) });
  peersAsked = 0;
  await goto(base + "?phone=0");
  await sleep(500);
  ok(peersAsked === 0 && !(await offered()), `nothing asked at load, the item not offered (${peersAsked})`);
  ok((await ev("document.querySelector('#rtermbtn').title")) === "A shell on one of your own computers, set up with sagebrush remote login", "its title, no longer a preview");
  { const t = await (await fetch(base + "agents/connect/")).text(); ok(t.includes("choose ⋯ → “Terminal on your computer…”") && !t.includes("remote=1"), "the Connect page sends no one to ?remote=1"); }
  await more();
  await sleep(300);
  ok(peersAsked === 1 && !(await offered()), `the first ⋯ open asks once; available false: not offered (${peersAsked})`);
  await more();
  await more();
  await sleep(300);
  ok(peersAsked === 1, `reopening ⋯ asks nothing more (${peersAsked})`);
  ok((await firstOpen(base + "?remote=1", { status: 200, body: JSON.stringify({ peers: [], available: false }) })) === 1 && !(await offered()), "?remote=1 no longer offers it: available false is hidden");
  // (only a literal true offers it; anything else, an error or a network failure hides it, and nothing is asked again)
  for (const [what, a] of [["\"true\"", { status: 200, body: JSON.stringify({ peers: [], available: "true" }) }], ["1", { status: 200, body: JSON.stringify({ peers: [], available: 1 }) }],
    ["no field", { status: 200, body: JSON.stringify({ peers: [] }) }], ["bad JSON", { status: 200, body: "{\"available\": tru" }],
    ["401", { status: 401, body: JSON.stringify({ error: "not signed in" }) }], ["404", { status: 404, body: JSON.stringify({ error: "not found" }) }],
    ["500 saying true", { status: 500, body: JSON.stringify({ available: true }) }], ["a network error", "fail"]]) {
    const n = await firstOpen(base + "?phone=0", a);
    await more();
    await sleep(200);
    ok(n === 1 && peersAsked === 1 && !(await offered()), `${what}: not offered, and not asked again at the next open (${peersAsked})`);
  }
  // (the CLI's page and the app: no request, no item.  The app's stand-in answers what the page asks of it at load, so
  // the page's script runs to the end, as it must for the row to mean anything: the notebook up is required)
  const tauri = `window.__TAURI__ = { core: { invoke: async (c) => (c === "startup_files" ? [] : null) }, event: { listen: async () => () => {} },
    window: { getCurrentWindow: () => ({ setTitle: async () => {} }) }, fs: {}, dialog: {} }`;
  for (const [what, init] of [["the CLI's page", "window.__SAGEBRUSH_LOCAL__ = { token: 't' }"], ["the app", tauri]]) {
    const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", { source: init });
    reply = null;
    peersAsked = 0;
    await send("Page.navigate", { url: base + "?phone=0" });
    await sleep(300);
    await until("document.readyState === 'complete' && !!(window.sagebrush && window.sagebrush.notebook)", 60000);
    await sleep(500);
    await ev("document.querySelector('#morebtn').click(), document.querySelector('#morebtn').click(), true");
    await sleep(500);
    ok(peersAsked === 0 && !(await offered()), `${what}: ⋯ opened, nothing asked, not offered (${peersAsked})`);
    await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
  // (a slow true: ⋯ opens and works while it is out; it comes while ⋯ is open: the item is added to the open menu)
  reply = () => "hold";
  await goto(base + "?phone=0");
  peersAsked = 0;
  ok(await more(), "⋯ opens while the answer is out");
  await sleep(300);
  ok(peersAsked === 1 && held.length === 1 && !(await offered()), "one request out, the item not offered yet");
  ok(await ev("document.activeElement?.closest('#moremenu') !== null && !document.querySelector('#termbtn').closest('[hidden]')"), "the menu is usable meanwhile (a row focused, Terminal there)");
  await more();
  await more();
  await sleep(200);
  ok(peersAsked === 1, `opening ⋯ again while it is out asks nothing more (${peersAsked})`);
  await answer(held.shift());
  await until("document.querySelector('#rtermbtn').hidden === false");
  ok(await ev("!document.querySelector('#moremenu').hidden && !document.querySelector('button[data-group=\"terminal\"]').hidden && document.querySelector('button[data-group=\"terminal\"]').nextElementSibling.contains(document.querySelector('#rtermbtn'))"),
    "a true answer while ⋯ is open adds the item to it then (under Terminal ▸)");
  ok(!(await chunkLoaded()), "the terminal's own chunk isn't loaded by offering it");
  await more();
  // (a slow true that comes after ⋯ was closed: there at the next open)
  await goto(base + "?phone=0");
  ok(await more(), "⋯ opened");
  await sleep(200);
  ok(await more() === false && held.length === 1, "and closed before the answer");
  await answer(held.shift());
  await until("document.querySelector('#rtermbtn').hidden === false");
  ok(await more() && (await ev("!document.querySelector('button[data-group=\"terminal\"]').hidden")), "a true answer after ⋯ was closed: the item is there at the next open");
  await more();

  // 2. offered, without any flag: the computers to choose from, runners only, their names as text
  reply = null;
  await goto(base + "?phone=0");
  await more();
  await until("document.querySelector('#rtermbtn').hidden === false");
  await more();
  peersAsked = 0;
  peers = { peers: [
    { remote_id: "r-laptop", kind: "runner", name: "laptop <b id=pwn>x</b>", jwk: {}, jkt: "a", created: 1 },
    { remote_id: "a-agent", kind: "agent", name: "an agent", jwk: {}, jkt: "b", created: 2 },
    { remote_id: "r-box", kind: "runner", name: "box", jwk: {}, jkt: "c", created: 3 },
  ] };
  await ev(FAKE);
  await ev("document.querySelector('#rtermbtn').click(), true");
  await until("document.querySelectorAll('#rterm .rpick button').length > 0");
  const names = await ev("[...document.querySelectorAll('#rterm .rpick button')].map((b) => b.textContent)");
  ok(JSON.stringify(names) === JSON.stringify(["laptop <b id=pwn>x</b>", "box"]), `runners only, names as text: ${JSON.stringify(names)}`);
  ok(await ev("!document.getElementById('pwn')"), "a name's markup is not markup");
  ok(peersAsked === 1, `one peers request (${peersAsked})`);

  // 3. the open: the leg's URL, the body, the proof over the synthetic URL with its query
  await ev("document.querySelectorAll('#rterm .rpick button')[1].click(), true");
  await until("__leg.opens.length === 1");
  const legUrl = await ev("__leg.sock.url");
  ok(legUrl === `ws://127.0.0.1:${port}/api/remote/v1/page?remote=r-box&chan=terminal`, `the page leg: ${legUrl}`);
  const hello = await ev("__leg.sent[0]");
  ok(hello.method === "hello" && hello.params.purpose === "terminal" && hello.params.protocol === 1 && hello.params.jwk?.crv === "P-256" && typeof hello.params.jkt === "string", "a terminal hello with the page's P-256 key");
  const open = await ev("__leg.opens[0]");
  const body = JSON.parse(open.body);
  ok(Number.isInteger(body.rows) && Number.isInteger(body.cols) && body.rows > 5 && body.cols > 20 && !("session" in body), `a new session at the panel's size (${body.rows}x${body.cols})`);
  ok(open.auth === "DPoP tok-1", "the hello's token");
  const [h, c] = open.dpop.split(".").map((p, i) => (i < 2 ? unb64url(p) : p));
  const want = `https://local.sagebrush.invalid/api/compute/v1/terminal/open?remote=r-box&gen=1&body=${Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(open.body))).toString("base64url")}`;
  ok(h.typ === "dpop+jwt" && h.alg === "ES256" && JSON.stringify(h.jwk) === JSON.stringify(hello.params.jwk), "the proof's header: dpop+jwt, ES256, the hello's key");
  ok(c.htm === "POST" && c.htu === want && c.nonce === "n0" && typeof c.ath === "string" && typeof c.jti === "string", `the proof binds the remote, the generation and the body (htu ${c.htu.slice(0, 90)}…)`);

  // 4. replay, then live: drawn, acked, and xterm's answer to a replayed query is not sent
  await push({ t: "opened", session: "s-1", nonce: "n1" });
  await push({ t: "replay" });
  const replay = "\x1bcold line\r\n\x1b[c";
  await out(replay);
  // (a key typed during the replay still goes, through onKey: CoCalc's dropped "4")
  await ev("document.querySelector('#rterm .xterm-helper-textarea').focus(), true");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "q", code: "KeyQ", windowsVirtualKeyCode: 81, text: "q" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "q", code: "KeyQ", windowsVirtualKeyCode: 81 });
  await until("__leg.ins() === 'q'");
  ok(true, "a key typed during the replay is sent");
  await push({ t: "live" });
  await until(`__leg.acks().at(-1) === ${replay.length}`);
  ok(true, `the replay acked once drawn (upto ${replay.length})`);
  await sleep(200);
  ok((await ev("__leg.ins()")) === "q", "xterm's answer to the replay's query is not sent");
  ok(await ev("sessionStorage.getItem('sagebrush-rterm:r-box') === 's-1'"), "the session is remembered in this tab");
  ok(await ev("/old line/.test(document.querySelector('#rterm .xterm-rows').textContent)"), "the replay is on the screen");
  // (room below the notebook for the panel, so its last cells stay reachable: agents-ui's n1)
  const pad = () => ev("[document.body.style.paddingBottom, (document.getElementById('rterm')?.offsetHeight ?? 0) + 'px', document.querySelector('#console').hidden ? 0 : document.querySelector('#console').offsetHeight]");
  { const [p, h] = await pad(); ok(p === h && h !== "0px", `the page makes room below the notebook for the panel (${p})`); }
  await out("\x1b[c");
  await until("__leg.ins().startsWith('q\\x1b[?')");
  ok(true, "a live query's answer goes to the computer");
  await until(`__leg.acks().at(-1) === ${replay.length + 3}`);
  ok(true, "live output acked, counting from this open");
  // (the relay's receipt, as relay.ts sends it: the page acks its token at once, and stays)
  await ev(`__leg.sock.fire("message", { data: '{"relay":"receipt","r":"Rr0123456789abcdefgh_-","upto":262400}' }), true`);
  await until("__leg.sent.some((m) => m.relay === 'ack')");
  ok((await ev("JSON.stringify(__leg.sent.filter((m) => 'relay' in m && m.relay !== 'ping'))")) === JSON.stringify([{ relay: "ack", r: "Rr0123456789abcdefgh_-" }]) && (await ev("__leg.sock.closed === null")),
    "the relay's receipt is acked with its token; the page stays");

  // 5. typing
  await ev("document.querySelector('#rterm .xterm-helper-textarea').focus(), true");
  const before = (await ev("__leg.ins()")).length;
  await send("Input.insertText", { text: "ls -l" });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await until(`__leg.ins().slice(${before}) === "ls -l\\r"`);
  ok(true, "typing goes to the computer");

  // 6. OUT-ISO: OSC 52 swallowed, a title as text
  await out("\x1b]52;c;aGVsbG8=\x07after52\r\n");
  await until("/after52/.test(document.querySelector('#rterm .xterm-rows').textContent)");
  ok((await ev("__leg.clip")) === 0, "OSC 52 doesn't write the clipboard");
  const evil = "<img src=x onerror=\"window.__pwn=1\">title";
  await out(`\x1b]0;${evil}\x07`);
  await until(`document.querySelector('#rterm .rtitle').textContent === ${JSON.stringify(evil)}`);
  ok(await ev("!document.querySelector('#rterm img') && window.__pwn === undefined"), "a title is text in the header, never markup");

  // 7. links: http(s) only, opened on a click, noopener
  await out("\x1b[2J\x1b[H\x1b]8;;javascript:window.__pwn2=1\x07JSLINK\x1b]8;;\x07   \x1b]8;;https://example.com/osc8\x07WEBLINK\x1b]8;;\x07   see https://example.org/plain.\r\n");
  await until("/WEBLINK/.test(document.querySelector('#rterm .xterm-rows').textContent)");
  const clickText = async (word) => {
    // (the word's own box on the screen: a range over its text, wherever xterm's spans split the row)
    const r = await ev(`(() => {
      const w = ${JSON.stringify(word)}, it = document.createTreeWalker(document.querySelector('#rterm .xterm-rows'), NodeFilter.SHOW_TEXT);
      for (let t; (t = it.nextNode());) {
        const i = t.data.indexOf(w);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(t, i + 1);
        range.setEnd(t, i + 2);
        const b = range.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }
      return null;
    })()`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y });
    await sleep(250);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
    await sleep(250);
  };
  await clickText("JSLINK");
  ok((await ev("__leg.opened.length")) === 0 && (await ev("window.__pwn2 === undefined")), "a javascript: OSC 8 link does nothing");
  await clickText("WEBLINK");
  const o1 = await ev("__leg.opened.at(-1) ?? null");
  ok(JSON.stringify(o1) === JSON.stringify(["https://example.com/osc8", "_blank", "noopener,noreferrer"]), `an https OSC 8 link opens on a click, noopener: ${JSON.stringify(o1)}`);
  await clickText("example.org");
  const o2 = await ev("__leg.opened.at(-1) ?? null");
  ok(JSON.stringify(o2) === JSON.stringify(["https://example.org/plain", "_blank", "noopener,noreferrer"]), `a plain web address opens on a click, without the sentence's period: ${JSON.stringify(o2)}`);
  ok((await ev("__leg.opened.length")) === 2, "nothing opened without a click");
  ok(dialogs.length === 0, `no dialog (${JSON.stringify(dialogs).slice(0, 120)})`);
  // (the module's own check, under xterm's OSC 8 filter: http(s) only, whatever the link came from)
  const hrefs = await ev(`(async () => {
    const m = await import(new URL("sagebrush-remote-terminal.js", location.href).href);
    return ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "file:///etc/passwd", "vbscript:x", "blob:https://a/b", "//example.com/x", "https://example.com/a b", "http://example.com/", "HTTPS://Example.com/x"].map((u) => m.webHref(u));
  })()`);
  ok(JSON.stringify(hrefs) === JSON.stringify([null, null, null, null, null, null, null, "https://example.com/a%20b", "http://example.com/", "https://example.com/x"]), `webHref: http(s) only (${JSON.stringify(hrefs)})`);

  // 8. a resize goes to the computer
  await send("Emulation.setDeviceMetricsOverride", { width: 800, height: 700, deviceScaleFactor: 1, mobile: false });
  await until(`__leg.sent.some((m) => m.t === 'resize' && m.cols < ${body.cols})`);
  const rs = await ev("__leg.sent.filter((m) => m.t === 'resize').at(-1)");
  ok(rs.cols < body.cols && Number.isInteger(rs.rows), `a resize (${rs.rows}x${rs.cols})`);

  // 8b. the console and this panel share the bottom: the one chosen last is in front (agents-ui A1)
  const z = (sel) => ev(`Number(getComputedStyle(document.querySelector(${JSON.stringify(sel)})).zIndex)`);
  await ev("document.querySelector('#consolebtn').click(), true");
  await until("!document.querySelector('#console').hidden");
  ok((await z("#console")) > (await z("#rterm")), "the console, chosen after, is in front of the terminal");
  { const [p, h, c] = await pad(); ok(p === Math.max(parseInt(h), c) + "px", `both open: room for the taller (${p}; terminal ${h}, console ${c}px)`); }
  // (the console made the taller, with its own grip: the room follows it)
  await ev(`(() => { const g = document.querySelector('#console .grip'); for (let i = 0; i < 6; i++) g.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); return true; })()`);
  { const [p, h, c] = await pad(); ok(c > parseInt(h) && p === c + "px", `the console made taller: room for it (${p}; terminal ${h}, console ${c}px)`); }
  await ev("document.querySelector('#rtermbtn').click(), true");
  await until(`Number(getComputedStyle(document.querySelector('#rterm')).zIndex) > Number(getComputedStyle(document.querySelector('#console')).zIndex)`);
  ok(true, "choosing the terminal again brings it in front");
  await ev("document.querySelector('#consolebtn').click(), true"); // (the console closed again)
  await until("document.querySelector('#console').hidden");
  // 8c. the page's theme reaches the terminal (agents-ui A2): its background is the page's --code, before and after
  const bg = () => ev(`(() => {
    const probe = Object.assign(document.createElement("div"), { style: "background: var(--code)" });
    document.body.append(probe);
    const want = getComputedStyle(probe).backgroundColor;
    probe.remove();
    // (xterm 6 paints the theme's background on its scrollable element)
    return [want, getComputedStyle(document.querySelector('#rterm .xterm-scrollable-element')).backgroundColor];
  })()`);
  const setTheme = (t) => ev(`(() => { const s = document.querySelector('#theme'); s.value = ${JSON.stringify(t)}; s.dispatchEvent(new Event('change')); return true; })()`);
  await setTheme("light");
  await sleep(100);
  const [wantL, gotL] = await bg();
  await setTheme("dark");
  await sleep(100);
  const [wantD, gotD] = await bg();
  ok(wantL !== wantD && gotL === wantL && gotD === wantD, `the theme follows the page: light ${gotL} (${wantL}), dark ${gotD} (${wantD})`);
  await setTheme("system");

  // 9. the leg lost: said, with Reconnect; Reconnect reattaches to the session with a fresh hello and proof
  await ev("__leg.drop(1006, 'runner not connected'), true");
  await until("/Not connected to box/.test(document.querySelector('#rterm .rstatus').textContent)");
  ok(/runner not connected/.test(await status()), `a lost leg is said: ${JSON.stringify(await status())}`);
  ok(await ev("[...document.querySelectorAll('#rterm .rhead button')].some((b) => b.textContent === 'Reconnect' && !b.hidden)"), "with Reconnect");
  await ev("[...document.querySelectorAll('#rterm .rhead button')].find((b) => b.textContent === 'Reconnect').click(), true");
  await until("__leg.opens.length === 2");
  const open2 = await ev("__leg.opens[1]");
  const c2 = unb64url(open2.dpop.split(".")[1]);
  ok(JSON.parse(open2.body).session === "s-1" && open2.auth === "DPoP tok-2" && c2.jti !== c.jti && c2.htu.includes("gen=2"), "a reattach: the remembered session, a fresh hello and proof");

  // 10. exit: said, forgotten, New session
  await push({ t: "opened", session: "s-1", nonce: "n2" });
  await push({ t: "replay" });
  await push({ t: "live" });
  await push({ t: "exit", code: 0, signal: null });
  await until("/The shell ended/.test(document.querySelector('#rterm .rstatus').textContent)");
  ok((await status()) === "The shell ended (exit code 0).", `an exit is said: ${JSON.stringify(await status())}`);
  ok(await ev("sessionStorage.getItem('sagebrush-rterm:r-box') === null"), "an ended session is forgotten");

  // 11. ✕: the panel and its leg go
  await ev("document.querySelector('#rterm .rhead button[aria-label=\"Close the terminal\"]').click(), true");
  ok(await ev("!document.getElementById('rterm') && __leg.sock.closed !== null"), "✕ removes the panel and closes its leg");
  ok((await ev("document.body.style.paddingBottom")) === "", "and the room below the notebook goes with it");

  // 12. a phone: the extra-keys row (CoCalc's); one computer is opened at once; a remembered session is reattached
  await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 800, deviceScaleFactor: 1, mobile: true });
  await goto(base + "?phone=1");
  peers = { peers: [{ remote_id: "r-box", kind: "runner", name: "box", jwk: {}, jkt: "c", created: 3 }] };
  await more();
  await until("document.querySelector('#rtermbtn').hidden === false");
  await more();
  await ev(FAKE);
  await ev("sessionStorage.setItem('sagebrush-rterm:r-box', 's-9'), true");
  // (the console open first: a terminal opened now comes in front of it)
  await ev("document.querySelector('#consolebtn').click(), true");
  await until("!document.querySelector('#console').hidden");
  await ev("document.querySelector('#rtermbtn').click(), true");
  await until("__leg.opens.length === 1");
  ok((await z("#rterm")) > (await z("#console")), "a terminal opened while the console is open comes in front of it");
  await ev("document.querySelector('#consolebtn').click(), true");
  await until("document.querySelector('#console').hidden");
  ok(JSON.parse(await ev("__leg.opens[0].body")).session === "s-9", "one computer: opened at once, reattaching to this tab's session");
  const keys = await ev("[...document.querySelectorAll('#rterm .rkeys button')].map((b) => b.textContent + '|' + b.title)");
  ok(JSON.stringify(keys) === JSON.stringify(["Esc|Escape", "Tab|Tab", "^C|Control+C", "`|Backtick", "←|Left arrow", "↑|Up arrow", "↓|Down arrow", "→|Right arrow"]), `the extra-keys row: ${keys.join(" ")}`);
  await push({ t: "opened", session: "s-9", nonce: "n1" });
  await push({ t: "replay" });
  await push({ t: "live" });
  await sleep(100);
  for (const k of ["Escape", "Tab", "Control+C", "Backtick", "Left arrow", "Up arrow", "Down arrow", "Right arrow"]) await ev(`document.querySelector('#rterm .rkeys button[data-key="${k}"]').click(), true`);
  await until("__leg.ins().length >= 16");
  ok((await ev("__leg.ins()")) === "\x1b\t\x03`\x1b[D\x1b[A\x1b[B\x1b[C", "each extra key sends its bytes");
  // (an unknown session: forgotten, and a new one opened)
  await ev("sessionStorage.setItem('sagebrush-rterm:r-box', 's-gone'), true");
  await ev("document.querySelector('#rterm .rhead button[aria-label=\"Close the terminal\"]').click(), true");
  await ev(FAKE);
  await ev("document.querySelector('#rtermbtn').click(), true");
  await until("__leg.opens.length === 1");
  await push({ t: "error", error: "unknown_session" });
  await until("__leg.opens.length === 2 && __leg.legs.length === 2");
  ok(!("session" in JSON.parse(await ev("__leg.opens[1].body"))) && (await ev("__leg.legs[0].closed !== null")), "a session gone from the computer: a new one, on a new leg");
  // (a computer whose Sagebrush doesn't take terminals: its hello refused, said in words, nothing opened)
  await ev("document.querySelector('#rterm .rhead button[aria-label=\"Close the terminal\"]').click(), true");
  await ev(FAKE);
  await ev("__leg.refuse = 'no terminal channel', true");
  await ev("document.querySelector('#rtermbtn').click(), true");
  await until("/didn't accept/.test(document.querySelector('#rterm .rstatus')?.textContent ?? '')");
  ok((await status()) === "box didn't accept a terminal. Its Sagebrush may predate terminals: update it, then Reconnect. (no terminal channel)" && (await ev("__leg.opens.length")) === 0, `a refused hello is said: ${JSON.stringify(await status())}`);
  // (a computer at its session limit: the runner's own number in the sentence)
  await ev("document.querySelector('#rterm .rhead button[aria-label=\"Close the terminal\"]').click(), true");
  await ev(FAKE);
  await ev("sessionStorage.removeItem('sagebrush-rterm:r-box'), true");
  await ev("document.querySelector('#rtermbtn').click(), true");
  await until("__leg.opens.length === 1");
  await push({ t: "error", error: "sessions", limit: 3 });
  await until("/already runs/.test(document.querySelector('#rterm .rstatus')?.textContent ?? '')");
  ok((await status()) === "box already runs 3 terminals. End one there, then Reconnect.", `the session limit is the runner's: ${JSON.stringify(await status())}`);
  await push({ t: "error", error: "sessions", limit: 1 });
  await until("/1 terminal\\./.test(document.querySelector('#rterm .rstatus')?.textContent ?? '')");
  ok((await status()) === "box already runs 1 terminal. End one there, then Reconnect.", `a limit of 1, singular: ${JSON.stringify(await status())}`);
  await push({ t: "error", error: "sessions" });
  await until("/as many/.test(document.querySelector('#rterm .rstatus')?.textContent ?? '')");
  ok((await status()) === "box already runs as many terminals as it allows. End one there, then Reconnect.", `no limit sent: ${JSON.stringify(await status())}`);
  // (the relay stops answering pings: the page gives up with its own sentence, no reason after it, and offers Reconnect;
  // the page's 15 s ping interval runs at 30 ms here, and this fake leg never answers a ping)
  await ev("document.querySelector('#rterm .rhead button[aria-label=\"Close the terminal\"]').click(), true");
  await ev(FAKE);
  await ev("(() => { const si = window.setInterval; window.__si = si; window.setInterval = (f, ms, ...a) => si(f, ms === 15000 ? 30 : ms, ...a); return true; })()");
  await ev("document.querySelector('#rtermbtn').click(), true");
  await until("/isn't answering/.test(document.querySelector('#rterm .rstatus')?.textContent ?? '')");
  ok((await status()) === "box isn't answering: the connection went quiet. Reconnect.", `the relay gone quiet: the sentence alone, no "(no pong)": ${JSON.stringify(await status())}`);
  ok(await ev("[...document.querySelectorAll('#rterm .rhead button')].some((b) => b.textContent === 'Reconnect' && !b.hidden) && __leg.sent.filter((m) => m.relay === 'ping').length === 2 && __leg.sock.closed?.[0] === 4002"),
    "two pings unanswered: the leg closed 4002, Reconnect offered");
  await ev("window.setInterval = window.__si, true");
  await goto(base + "?phone=0");
} catch (e) {
  ok(false, "the test stopped: " + (e?.stack ?? e));
} finally {
  ws?.close();
  chrome?.kill();
  server?.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
console.log(process.exitCode ? "FAILED" : "all passed");
