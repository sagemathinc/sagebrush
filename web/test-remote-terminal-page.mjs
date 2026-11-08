// ci: web-browser/remote-preview order=20
// The terminal on your computer in the notebook page (web/notebook/remote-terminal-view.ts, sagebrush-remote-terminal.js;
// terminals T-3), end to end in headless Chromium with its real xterm: offered only with ?remote=1; the computers from
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
  // (the peers list the next request gets, and how many were asked)
  let peers = { peers: [] }, peersAsked = 0;
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    else if (m.method === "Fetch.requestPaused") {
      peersAsked++;
      const get = m.params.request.method === "GET";
      send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: get ? 200 : 405, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(peers)).toString("base64") });
    }
  };
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result?.value;
  };
  const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(50); } throw new Error("timeout: " + expr); };
  const goto = async (url) => { await send("Page.navigate", { url }); await sleep(300); await until("!!(window.sagebrush && window.sagebrush.notebook) && /ready/.test(document.querySelector('#status').textContent)", 60000); };
  // (the relay leg: a fake WebSocket that answers the hello as a runner would; the test plays the runner's messages)
  const FAKE = `(() => {
    const leg = window.__leg = { legs: [], sent: [], opens: [], clip: 0, opened: [] };
    window.WebSocket = class {
      constructor(url) { this.url = url; this.h = { open: [], message: [], close: [], error: [] }; this.closed = null; leg.legs.push(this); leg.sock = this; setTimeout(() => this.fire("open", {}), 0); }
      addEventListener(k, f) { this.h[k].push(f); }
      fire(k, e) { for (const f of this.h[k]) f(e); }
      send(t) {
        const m = JSON.parse(t); leg.sent.push(m);
        if (m.method === "hello") setTimeout(() => this.fire("message", { data: JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { purpose: "terminal", token: "tok-" + leg.legs.length, nonce: "n0", gen: leg.legs.length, incarnation: "i1", channels: ["kernel", "terminal"] } }) }), 0);
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

  // 1. without ?remote=1: not offered
  await goto(base + "?phone=0");
  ok(await ev("document.querySelector('#rtermbtn').hidden === true"), "without ?remote=1, Terminal on your computer… isn't offered");

  // 2. with it: the computers to choose from, runners only, their names as text
  await goto(base + "?remote=1");
  ok(await ev("document.querySelector('#rtermbtn').hidden === false"), "with ?remote=1 it is offered");
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
  await out("\x1b[c");
  await until("__leg.ins().startsWith('q\\x1b[?')");
  ok(true, "a live query's answer goes to the computer");
  await until(`__leg.acks().at(-1) === ${replay.length + 3}`);
  ok(true, "live output acked, counting from this open");

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

  // 12. a phone: the extra-keys row (CoCalc's); one computer is opened at once; a remembered session is reattached
  await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 800, deviceScaleFactor: 1, mobile: true });
  await goto(base + "?remote=1&phone=1");
  peers = { peers: [{ remote_id: "r-box", kind: "runner", name: "box", jwk: {}, jkt: "c", created: 3 }] };
  await ev(FAKE);
  await ev("sessionStorage.setItem('sagebrush-rterm:r-box', 's-9'), true");
  await ev("document.querySelector('#rtermbtn').click(), true");
  await until("__leg.opens.length === 1");
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
