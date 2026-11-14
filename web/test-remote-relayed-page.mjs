// ci: web-browser/remote-preview order=30
// A notebook's code on one of your computers, through the relay, in the notebook page (web/notebook/remote-ui.js
// relayedStarter; the run target's menu next to Run all, #runsinbtn, over the hidden select #kernelpick), end to end in
// headless Chromium:
//   1. the button shows only the target ("Browser"); nothing is asked at load; the menu's first open asks for the peers
//      answer once and shows "Finding your computers…" until it comes; then Browser (checked), one "Remote: NAME" per
//      computer (runners only, the name as text), a divider and About…; no paired choice (still offered only with
//      ?remote=1 or a pairing link); no help text in the menu; ⋯ afterwards asks nothing more (one answer, shared);
//      About… opens the dialog with the limits and the way to connect a computer;
//   2. choosing one: the button says "Remote: NAME"; that computer's kernel page leg on this site's relay (its URL:
//      chan=kernel and its id) pairs with the page's public key (no code, no session) and binds: "Remote: NAME · ready";
//   3. a person's Run sends the cell to the computer (a run frame on the leg, its code); a run without the gesture is
//      never sent (the page's gate, as for the paired kernel);
//   4. the leg ending (as when another notebook or tab chooses that computer) is said with its likely cause, and offers
//      Retry and Switch to browser, never switching on its own; Switch to browser gives Browser back, on the button too;
//      a Run while a computer is still connecting goes nowhere, and a superseded choice's late bind installs nothing;
//   5. an account the peers answer doesn't let use them, or one with none: "Connect a computer…" (/remote/connect);
//   7. the menu closed before the answer comes stays closed and empty; opening it again makes no second option for a
//      computer; choosing the computer that is ready again opens no leg; and when the remote chunk can't load, the
//      choice says so and goes back to Browser (a computer put in the select directly stands in for the menu, which
//      can't list one without that chunk).
// The relay leg is a fake WebSocket in the page that answers as a runner on the relay would; the peers request is
// answered through CDP.  The real runner over the relay protocol: engine/py/test_remote_kernel_page.py.
//   bun web/build.ts && node web/test-remote-relayed-page.mjs      (CHROME=... for another browser binary)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort, startServe } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };
const profile = mkdtempSync(join(tmpdir(), "sb-remote-relayed-"));
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
  // (the peers answer the next request gets, and how many were asked; `hold`: kept until the test releases it)
  let peersBody = null, peersAsked = 0, hold = false, failChunk = false;
  const held = [];
  const changes = [];
  const reply = (requestId, status, body) => send("Fetch.fulfillRequest", { requestId, responseCode: status, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(body)).toString("base64") });
  const changeComputer = ({ requestId, request }) => {
    const b = JSON.parse(request.postData ?? "{}");
    const what = /rename/.test(request.url) ? "rename" : "revoke";
    changes.push({ what, ...b, origin: Object.entries(request.headers).find(([k]) => k.toLowerCase() === "origin")?.[1] ?? null });
    const peers = peersBody.peers ?? [];
    const it = peers.find((p) => p.remote_id === b.remote_id);
    if (!it) return reply(requestId, 404, { error: "unknown_remote" });
    if (what === "revoke") { peersBody = { ...peersBody, peers: peers.filter((p) => p !== it) }; return reply(requestId, 200, { ok: true }); }
    const name = String(b.name ?? "").trim();
    if (!name || name.length > 64) return reply(requestId, 400, { error: "invalid_name", why: "length", max: 64 });
    if (/[\u0000-\u001f]/.test(name)) return reply(requestId, 400, { error: "invalid_name", why: "chars", max: 64 });
    if (peers.some((p) => p !== it && p.name.toLowerCase() === name.toLowerCase())) return reply(requestId, 409, { error: "name_taken" });
    it.name = name;
    return reply(requestId, 200, { ok: true, name });
  };
  const answerPeers = (requestId) => send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(peersBody)).toString("base64") });
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    else if (m.method === "Fetch.requestPaused" && /sagebrush-remote\.js/.test(m.params.request.url)) {
      if (failChunk) send("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "Failed" });
      else send("Fetch.continueRequest", { requestId: m.params.requestId });
    } else if (m.method === "Fetch.requestPaused") {
      const url = m.params.request.url;
      // (renaming and removing, as the site answers them, on this test's list: peersBody)
      if (/\/api\/remote\/v1\/(rename|revoke)/.test(url)) return changeComputer(m.params);
      peersAsked++;
      if (hold) held.push(m.params.requestId);
      else answerPeers(m.params.requestId);
    }
  };
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result?.value;
  };
  const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(50); } throw new Error("timeout: " + expr); };
  const status = () => ev("document.querySelector('#status').textContent");
  const untilStatus = async (expr, ms) => { try { return await until(expr, ms); } catch (e) { throw new Error(`${e.message} (status ${JSON.stringify(await status())})`); } };
  // (the relay leg: a fake WebSocket answering as a runner on the relay does: the hello, then a bind; runs recorded)
  const FAKE = `(() => {
    const leg = window.__leg = { legs: [], sent: [], hold: false, held: [], localRuns: [] };
    // (the browser's own interpreter, watched: every execute it is asked for, still run as asked)
    const k = sagebrush.kernel, ex = k.execute.bind(k);
    k.execute = (...a) => { leg.localRuns.push(a[0]); return ex(...a); };
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; leg.legs.push(this); leg.sock = this; setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0); }
      send(t) {
        const m = JSON.parse(t); m.__leg = leg.legs.indexOf(this); leg.sent.push(m);
        const say = (o) => setTimeout(() => this.onmessage?.({ data: JSON.stringify(o) }), 0);
        if (m.method === "hello") say({ jsonrpc: "2.0", id: m.id, result: { protocol: 1, purpose: "kernel", via: "relay", token: "T".repeat(43), nonce: "n1", incarnation: "0123456789abcdef", limits: { frame: 4194304 }, channels: ["kernel", "terminal"] } });
        else if (m.rpc === "g.bind" && leg.hold) leg.held.push(() => say({ id: m.id, status: 200, headers: { "content-type": "application/json", "dpop-nonce": "n2" }, body: JSON.stringify({ binding: "b1", epoch: 1, incarnation: 1, state: "ready" }) }));
        else if (m.rpc === "g.bind") say({ id: m.id, status: 200, headers: { "content-type": "application/json", "dpop-nonce": "n2" }, body: JSON.stringify({ binding: "b1", epoch: 1, incarnation: 1, state: "ready" }) });
      }
      close(code) { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.onclose?.({ code }), 0); }
    };
    leg.drop = () => { leg.sock.readyState = 3; leg.sock.onclose?.({ code: 1000 }); };
    leg.runs = () => leg.sent.filter((m) => m.rpc === "g.run");
    // (a run frame and the leg it went on)
    leg.runLegs = () => leg.legs.map((l, i) => [i, l.url]).filter(([i]) => leg.sent.some((m) => m.rpc === "g.run" && m.__leg === i));
    return true;
  })()`;
  // (a fresh page with the fake leg; how many peers requests its load made)
  const fresh = async (url, body) => {
    peersBody = body;
    await send("Page.navigate", { url });
    await sleep(300);
    await until("!!(window.sagebrush && window.sagebrush.notebook) && /ready/.test(document.querySelector('#status').textContent)", 60000);
    await ev(FAKE);
    peersAsked = 0;
    await sleep(300);
    return peersAsked;
  };
  const button = () => ev("document.querySelector('#runsinbtn').textContent");
  const menuButtons = "[...document.querySelectorAll('#runsinmenu button')].filter((b) => b.getAttribute('role') === 'menuitemradio')";
  const menuText = () => ev("document.querySelector('#runsinmenu').hidden ? null : document.querySelector('#runsinmenu').innerText");
  const openRuns = () => ev("document.querySelector('#runsinbtn').click(), true");
  const items = () => ev("[...document.querySelectorAll('#runsinmenu button')].map((b) => [b.textContent, b.getAttribute('aria-checked')])");
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Fetch.enable", { patterns: ["peers", "rename", "revoke"].map((r) => ({ urlPattern: `*/api/remote/v1/${r}*`, requestStage: "Request" })) });

  // 1. the button; nothing at load; the menu's first open asks once, says it's finding them, then lists them
  const NAME = "lite <b>x</b>";
  const atLoad = await fresh(base + "?phone=0", { available: true, peers: [{ remote_id: "r-one", kind: "runner", name: NAME }, { remote_id: "r-two", kind: "runner", name: "big box" }, { remote_id: "a-1", kind: "agent", name: "not a runner" }] });
  ok(atLoad === 0, `nothing asked at load (${atLoad})`);
  ok((await ev("!document.querySelector('#runsinbtn').hidden")) && (await button()) === "Browser", `the bar shows where code runs, the target only (${await button()})`);
  ok(await ev("document.querySelector('#kernelpick').hidden === true"), "the More tools select stays hidden (no ?remote=1)");
  hold = true;
  await openRuns();
  await until("!document.querySelector('#runsinmenu').hidden");
  await sleep(300);
  ok(/Finding your computers…/.test(await menuText()) && JSON.stringify(await items()) === JSON.stringify([["Browser", "true"], ["About…", null]]), `while the answer comes: Browser, "Finding your computers…" and About… (${JSON.stringify(await menuText())})`);
  ok(peersAsked === 1, `the first open asks once (${peersAsked})`);
  hold = false;
  for (const id of held.splice(0)) await answerPeers(id);
  await until("[...document.querySelectorAll('#runsinmenu button')].length === 5");
  const its = await items();
  ok(JSON.stringify(its) === JSON.stringify([["Browser", "true"], [`Remote: ${NAME}`, "false"], ["Remote: big box", "false"], ["Your computers…", null], ["About…", null]]), `then: Browser (checked), one "Remote: NAME" per computer, runners only, no paired choice, then Your computers… and About… (${JSON.stringify(its)})`);
  ok(await ev("!document.querySelector('#runsinmenu b')"), "a computer's name is text, never markup");
  const menu = await menuText();
  ok(!/Finding/.test(menu) && !/folder|one notebook at a time|hidden notebook/.test(menu) && peersAsked === 1, "the finding line goes; no help text in the menu; no second request");
  ok(await ev("[...document.querySelectorAll('#runsinmenu button')].every((b) => !b.title)"), "nor in the items' titles");
  await ev("[...document.querySelectorAll('#runsinmenu button')].find((b) => b.textContent === 'About…').click(), true");
  await until("document.querySelector('#runsdlg').open");
  const about = await ev("document.querySelector('#runsdlg').innerText");
  ok(/^Where code runs/.test(about) && /Browser: this notebook's code runs in this browser tab/.test(about) && /in the folder sagebrush remote started in/.test(about) && /one notebook at a time/.test(about) && /keeps that computer chosen: choose Retry, or Switch to browser to run here. It never switches back on its own./.test(about) && !/hidden notebook/.test(about), `About…: the dialog with the targets and the limits (${JSON.stringify(about.slice(0, 80))}…)`);
  ok(await ev("document.querySelector('#runsdlg a[href=\"/remote/connect\"]')?.textContent.startsWith('Connect a computer') && document.querySelector('#runsinmenu').hidden"), "its last line links Connect a computer; the menu closed");
  await ev("document.querySelector('#runsdlg').close(), true");
  await ev("document.querySelector('#runsinbtn').click(), true"); // (closed)
  await ev("document.querySelector('#morebtn').click(), true");
  await sleep(400);
  await ev("document.querySelector('#morebtn').click(), true");
  await openRuns();
  await until("[...document.querySelectorAll('#runsinmenu button')].length === 5");
  ok(peersAsked === 1, `⋯ and a second open ask nothing more: one answer, shared (${peersAsked})`);
  ok(await ev("document.querySelector('#rtermbtn').hidden === false"), "⋯ ▸ Terminal on your computer is offered from the same answer");

  // 2. choosing a computer: its kernel leg on this site's relay, paired with the page's public key, bound
  const C = await ev("(() => { const nb = sagebrush.notebook; nb.addCell('', null, false, 'code'); return nb.cells().length - 1; })()");
  await ev(`[...document.querySelectorAll('#runsinmenu button')].find((b) => b.textContent === ${JSON.stringify("Remote: " + NAME)}).click(), true`);
  ok(await ev("document.querySelector('#runsinmenu').hidden") && (await button()) === NAME, `choosing closes the menu; the button names the computer (${await button()})`);
  await untilStatus(`document.querySelector('#status').textContent.startsWith(${JSON.stringify(`Remote: ${NAME} · ready`)})`, 20000);
  const leg = await ev("({ url: __leg.legs[0]?.url, n: __leg.legs.length, hello: __leg.sent.find((m) => m.method === 'hello')?.params })");
  const u = new URL(leg.url);
  ok((await ev("document.querySelector('#runsinbtn').title")) === `Runs on ${NAME}`, "the button shows just the computer's name; its title says \"Runs on NAME\" in full");
  ok((await ev("document.querySelector('#runsinbtn').getAttribute('aria-label')")) === `Where this notebook's code runs: ${NAME}`, "its accessible name says the computer too");
  ok(leg.n === 1 && u.protocol === "ws:" && u.host === new URL(base).host && u.pathname === "/api/remote/v1/page" && u.searchParams.get("remote") === "r-one" && u.searchParams.get("chan") === "kernel", `one leg: this site's relay, the chosen computer's kernel channel (${leg.url})`);
  ok(leg.hello?.via === "relay" && leg.hello.purpose === "kernel" && !("code" in leg.hello) && !("session" in leg.hello) && !("d" in (leg.hello.jwk ?? {})), "the hello: relay, kernel, the page's public key only");
  ok(/· ready/.test(await status()), `the status line: ${await status()}`);

  // 3. a person's Run goes to the computer; a run without the gesture is never sent
  await ev(`(() => { const nb = sagebrush.notebook, c = nb.cells()[${C}]; nb.setInput(c, "print(6 * 7)"); return true; })()`);
  await ev(`(async () => { await sagebrush.notebook.run(sagebrush.notebook.cells()[${C}]); return true; })()`);
  await sleep(800);
  ok((await ev("__leg.runs().length")) === 0, "a run without the person's Run gesture is not sent");
  await ev(`(() => { sagebrush.notebook.cells()[${C}].runb.click(); return true; })()`);
  await until("__leg.runs().length === 1", 10000);
  const run = await ev("__leg.runs()[0]");
  // (the reactive notebook sends a wave: the cell's code is in one of its entries)
  ok(String(run.body ?? "").includes(JSON.stringify("print(6 * 7)").slice(1, -1)) && /"kind":"wave"/.test(run.body), `a person's Run sends that cell's code to the computer, as a wave (${String(run.body).slice(0, 60)}…)`);

  // 4. the leg ends: said with its likely cause, Retry and Switch to browser; Switch to browser is This browser again
  await ev("__leg.drop(), true");
  await untilStatus("/disconnected/.test(document.querySelector('#status').textContent)", 10000);
  ok((await status()).startsWith(`Remote: ${NAME} · disconnected (`) && /another notebook or tab may have chosen this computer/.test(await status()), `the lost leg: named as the button names it, with its likely cause (${await status()})`);
  ok((await button()) === NAME && (await ev("document.querySelector('#kernelpick').value")) === "relay:r-one", "and it doesn't switch back to this browser on its own");
  ok(await ev("[...document.querySelectorAll('#remoteacts button')].map((b) => b.textContent).join('|') === 'Retry|Switch to browser'"), "Retry and Switch to browser are offered");
  await ev("document.querySelector('#remoteacts button:last-child').click(); true");
  await until("document.querySelector('#kernelpick').value === 'local'");
  ok((await button()) === "Browser", `Switch to browser: Browser again, on the button too (${await button()})`);
  // 4b. a Run while the chosen computer is still connecting (its bind held): sent nowhere, the browser's interpreter
  // untouched; once ready, a fresh Run reaches that computer only.  A newer choice supersedes a held one: the held
  // one's late bind installs nothing, and Runs go to the newer computer only.
  const runCell = (code) => ev(`(() => { const nb = sagebrush.notebook, c = nb.cells()[${C}]; nb.setInput(c, ${JSON.stringify(code)}); c.runb.click(); return true; })()`);
  const cellOut = () => ev(`sagebrush.notebook.cells()[${C}].el.querySelector('.out')?.textContent ?? ''`);
  const choose = (name) => ev(`(async () => { document.querySelector('#runsinbtn').click(); for (let i = 0; i < 100 && ![...document.querySelectorAll('#runsinmenu button')].some((b) => b.textContent === ${JSON.stringify("Remote: " + name)}); i++) await new Promise((r) => setTimeout(r, 50)); [...document.querySelectorAll('#runsinmenu button')].find((b) => b.textContent === ${JSON.stringify("Remote: " + name)}).click(); return true; })()`);
  await ev("__leg.hold = true, __leg.localRuns.length = 0, true");
  const runsBefore = await ev("__leg.runs().length");
  await choose(NAME);
  await until("__leg.held.length === 1", 10000);
  await runCell("print('WRONG_TARGET')");
  await until(`/Not run: connecting to/.test(sagebrush.notebook.cells()[${C}].el.querySelector('.out')?.textContent ?? '')`, 10000);
  ok((await ev("__leg.localRuns.length")) === 0 && (await ev("__leg.runs().length")) === runsBefore, `a Run while connecting: not run in the browser, nothing sent (${JSON.stringify(await cellOut())})`);
  ok((await button()) === NAME, "the button names the computer being connected");
  await ev("__leg.hold = false, __leg.held.splice(0).forEach((f) => f()), true");
  await untilStatus(`document.querySelector('#status').textContent.startsWith(${JSON.stringify(`Remote: ${NAME} · ready`)})`, 20000);
  await runCell("print('RIGHT_TARGET')");
  await until(`__leg.runs().length === ${runsBefore + 1}`, 10000);
  ok((await ev("__leg.localRuns.length")) === 0 && JSON.stringify(await ev("__leg.runs().at(-1).body")).includes("RIGHT_TARGET"), "once ready, a fresh Run reaches that computer only");
  // (superseded: A held, then B chosen; A's bind released late must not install)
  await ev("__leg.hold = true, true");
  const legsBefore = await ev("__leg.legs.length");
  await choose("big box");
  await until("__leg.held.length === 1", 10000);
  await choose(NAME);
  await until("__leg.held.length === 2", 10000);
  await ev("__leg.held.shift()(), true"); // (big box's bind, late)
  await sleep(600);
  ok(!/big box · ready/.test(await status()) && (await button()) === NAME, `the superseded computer's late bind installs nothing (${await status()})`);
  await runCell("print('STILL_PENDING')");
  await until(`/Not run: connecting to/.test(sagebrush.notebook.cells()[${C}].el.querySelector('.out')?.textContent ?? '')`, 10000);
  ok((await ev("__leg.localRuns.length")) === 0 && !(await ev("__leg.sent.some((m) => m.rpc === 'g.run' && /STILL_PENDING/.test(m.body ?? ''))")), "and a Run meanwhile goes nowhere");
  await ev("__leg.hold = false, __leg.held.splice(0).forEach((f) => f()), true");
  await untilStatus(`document.querySelector('#status').textContent.startsWith(${JSON.stringify(`Remote: ${NAME} · ready`)})`, 20000);
  await runCell("print('NEWER_TARGET')");
  await until("__leg.sent.some((m) => m.rpc === 'g.run' && /NEWER_TARGET/.test(m.body ?? ''))", 10000);
  const where = await ev("(() => { const m = __leg.sent.find((m) => m.rpc === 'g.run' && /NEWER_TARGET/.test(m.body ?? '')); return __leg.legs[m.__leg].url; })()");
  ok(new URL(where).searchParams.get("remote") === "r-one" && (await ev("__leg.localRuns.length")) === 0 && legsBefore >= 1, `then Runs go to the newer computer only (${where})`);

  // (on a computer, another notebook opened: it runs in this browser, and the button says so)
  await openRuns();
  await until("[...document.querySelectorAll('#runsinmenu button')].length === 5");
  await ev(`[...document.querySelectorAll('#runsinmenu button')].find((b) => b.textContent === ${JSON.stringify("Remote: " + NAME)}).click(), true`);
  await untilStatus("/· ready/.test(document.querySelector('#status').textContent)", 20000);
  await ev("document.querySelector('#filebtn').click(), true");
  await until("!!document.querySelector('#filemenu [data-f=\"new\"]')");
  await ev("document.querySelector('#filemenu [data-f=\"new\"]').click(), true");
  await until("document.querySelector('#kernelpick').value === 'local'");
  ok((await button()) === "Browser", `another notebook opened: it runs in this browser, and the button says so (${await button()})`);

  // (a long computer name: cut with an ellipsis in the button, which stays within its width; the title has it whole)
  {
    const LONG = "a-very-long-computer-name-for-the-lab-cluster-node-07-east";
    await fresh(base + "?phone=0", { available: true, peers: [{ remote_id: "r-long", kind: "runner", name: LONG }] });
    await openRuns();
    await until("[...document.querySelectorAll('#runsinmenu button')].length === 4");
    await ev("[...document.querySelectorAll('#runsinmenu button')][1].click(), true");
    await until(`document.querySelector('#runsinbtn').title === ${JSON.stringify('Runs on ' + LONG)}`);
    const w = await ev("(() => { const b = document.querySelector('#runsinbtn'), n = b.querySelector('.rtname'); return { btn: Math.round(b.getBoundingClientRect().width), cut: n.scrollWidth > n.clientWidth, em: parseFloat(getComputedStyle(n).fontSize) }; })()");
    ok(w.cut && w.btn <= 8 * w.em + 60, `a long name is cut, the button stays narrow (${JSON.stringify(w)})`);
  }
  // 6. Your computers…: rename (enabled once the name differs; a duplicate refused, said), remove (asked once; the
  // computer this notebook runs on: back to the browser, said); the list asked again after each change, the menu and
  // the button following; with none left, the way to connect one
  {
    await fresh(base + "?phone=0", { available: true, peers: [{ remote_id: "r-one", kind: "runner", name: "lite" }, { remote_id: "r-two", kind: "runner", name: "big box" }] });
    changes.length = 0;
    await openRuns();
    await until("[...document.querySelectorAll('#runsinmenu button')].length === 5");
    await ev("[...document.querySelectorAll('#runsinmenu button')][1].click(), true"); // (on lite)
    await untilStatus("/· ready/.test(document.querySelector('#status').textContent)", 20000);
    await openRuns();
    await until("[...document.querySelectorAll('#runsinmenu button')].some((b) => b.textContent === 'Your computers…')");
    await ev("[...document.querySelectorAll('#runsinmenu button')].find((b) => b.textContent === 'Your computers…').click(), true");
    await until("document.querySelector('#computersdlg').open && document.querySelectorAll('#computerslist .comprow').length === 2");
    const dlg = await ev("document.querySelector('#computersdlg').innerText");
    ok(/^Your computers/.test(dlg) && /A computer's own terminal shows its new name the next time it connects\./.test(dlg), `the dialog: its title, and the muted line (${JSON.stringify(dlg.slice(0, 60))}…)`);
    const rowState = () => ev("[...document.querySelectorAll('#computerslist .comprow')].map((r) => [r.querySelector('input')?.value, r.querySelector('button')?.disabled, r.querySelector('.compmsg')?.textContent])");
    ok(JSON.stringify(await rowState()) === JSON.stringify([["lite", true, ""], ["big box", true, ""]]), "a row per computer, its name in the field; Rename disabled until it changes");
    const type = (i, v) => ev(`(() => { const f = document.querySelectorAll('#computerslist .comprow input')[${i}]; f.value = ${JSON.stringify(v)}; f.dispatchEvent(new Event('input')); return true; })()`);
    const click = (i, label) => ev(`[...document.querySelectorAll('#computerslist .comprow')[${i}].querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(label)} && !b.closest('[hidden]')).click(), true`);
    await type(1, "LITE");
    ok((await rowState())[1][1] === false, "Rename enabled once the name differs");
    await click(1, "Rename");
    await until("document.querySelectorAll('#computerslist .compmsg')[1]?.textContent.length > 0");
    ok((await rowState())[1][2] === "You already have a computer named LITE.", `a duplicate, in another case: refused, said (${(await rowState())[1][2]})`);
    const asked = peersAsked;
    await type(0, "lab box");
    await click(0, "Rename");
    await until("document.querySelector('#computerslist .comprow input')?.value === 'lab box' && document.querySelector('#runsinbtn').textContent === 'lab box'");
    ok(changes.some((c) => c.what === "rename" && c.remote_id === "r-one" && c.name === "lab box") && peersAsked > asked, "Rename: sent, and the list asked again");
    ok((await ev("document.querySelector('#runsinbtn').title")) === "Runs on lab box", "the button, on that computer, takes the new name");
    // (remove the computer this notebook runs on: asked once, Cancel keeps it)
    await click(0, "Remove");
    const askText = await ev("document.querySelector('#computerslist .compask p')?.textContent");
    ok(askText === "Remove lab box? Sagebrush stops sending it code. To use it again, run sagebrush remote login on it.", `Remove asks once (${askText})`);
    ok((await ev("document.querySelector('#computerslist .compask p code')?.textContent")) === "sagebrush remote login", "the command in code style");
    ok(await ev("getComputedStyle(document.querySelector('#computerslist .compline')).display === 'none'"), "while it asks, the row's own field and buttons are out of sight");
    await ev("[...document.querySelectorAll('#computerslist .compask button')].find((b) => b.textContent === 'Cancel').click(), true");
    ok(!(await ev("!!document.querySelector('#computerslist .compask')")) && !changes.some((c) => c.what === "revoke"), "Cancel: nothing removed");
    await click(0, "Remove");
    await ev("[...document.querySelectorAll('#computerslist .compask button')].find((b) => b.textContent === 'Remove').click(), true");
    await until("document.querySelectorAll('#computerslist .comprow').length === 1");
    ok(changes.some((c) => c.what === "revoke" && c.remote_id === "r-one") && changes.every((c) => c.origin === new URL(base).origin), "Remove: sent from this site, the list without it");
    ok((await button()) === "Browser" && (await status()) === "Remote: lab box · removed. Back to Browser.", `the notebook ran there: back in the browser, said (${await status()})`);
    await click(0, "Remove");
    await ev("[...document.querySelectorAll('#computerslist .compask button')].find((b) => b.textContent === 'Remove').click(), true");
    await until("/No computers yet/.test(document.querySelector('#computerslist').innerText)");
    ok(await ev("document.querySelector('#computerslist a')?.getAttribute('href') === '/remote/connect' && document.querySelector('#computerslist').innerText.trim() === 'No computers yet. Connect a computer'"), "with none left: No computers yet. Connect a computer");
    await ev("document.querySelector('#computersdlg').close(), true");
  }
  // 5. an account the answer doesn't let use them, or one with none: the way to connect one, and no computer
  for (const [what, body] of [["available false", { available: false, peers: [{ remote_id: "r-one", kind: "runner", name: "lite" }] }], ["no computers", { available: true, peers: [] }]]) {
    await fresh(base + "?phone=0", body);
    await openRuns();
    await until("!!document.querySelector('#runsinmenu a')");
    const a = await ev("({ text: document.querySelector('#runsinmenu a').textContent, href: document.querySelector('#runsinmenu a').getAttribute('href'), n: document.querySelectorAll('#runsinmenu button').length })");
    ok(a.text === "Connect a computer…" && a.href === "/remote/connect" && a.n === 2, `${what}: Browser, Connect a computer… and About… (${JSON.stringify(a)})`);
  }

  // 7. the menu's edges: closed before the answer, opened twice, the ready computer chosen again
  {
    await fresh(base + "?phone=0", { available: true, peers: [{ remote_id: "r-one", kind: "runner", name: "lite" }, { remote_id: "r-two", kind: "runner", name: "big box" }] });
    const relayOptions = () => ev("[...document.querySelectorAll('#kernelpick option')].filter((o) => o.value.startsWith('relay:')).length");
    hold = true;
    await openRuns();
    await until("/Finding your computers…/.test(document.querySelector('#runsinmenu').innerText)");
    await ev("document.querySelector('#runsinbtn').click(), true"); // (closed while the answer is still coming)
    await until("document.querySelector('#runsinmenu').hidden");
    hold = false;
    for (const id of held.splice(0)) await answerPeers(id);
    await sleep(600);
    const stale = await ev("({ hidden: document.querySelector('#runsinmenu').hidden, rows: [...document.querySelectorAll('#runsinmenu button')].filter((b) => b.textContent.startsWith('Remote:')).length })");
    ok(stale.hidden && stale.rows === 0, `a menu closed before the answer came stays closed, and nothing is drawn into it (${JSON.stringify(stale)})`);
    await openRuns();
    await until("[...document.querySelectorAll('#runsinmenu button')].some((b) => b.textContent === 'Remote: lite')");
    await ev("document.querySelector('#runsinbtn').click(), true");
    await openRuns();
    await until("[...document.querySelectorAll('#runsinmenu button')].some((b) => b.textContent === 'Remote: lite')");
    ok((await relayOptions()) === 2, `opened twice: one choice per computer in the select (${await relayOptions()})`);
    await ev(`[...document.querySelectorAll('#runsinmenu button')].find((b) => b.textContent === "Remote: lite").click(), true`);
    await untilStatus("document.querySelector('#status').textContent.startsWith('Remote: lite · ready')", 20000);
    const legsReady = await ev("__leg.legs.length");
    await openRuns();
    await until("[...document.querySelectorAll('#runsinmenu button')].some((b) => b.textContent === 'Remote: lite')");
    await ev(`[...document.querySelectorAll('#runsinmenu button')].find((b) => b.textContent === "Remote: lite").click(), true`);
    await sleep(800);
    ok((await ev("__leg.legs.length")) === legsReady && (await status()).startsWith("Remote: lite · ready"), `the ready computer chosen again: no new leg, still ready (${await ev("__leg.legs.length")} legs, ${JSON.stringify(await status())})`);
  }
  // 7b. the remote chunk can't load: the choice is said, with the computer's name, and the notebook is back in Browser
  {
    await send("Network.enable");
    await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/remote/v1/peers*", requestStage: "Request" }, { urlPattern: "*sagebrush-remote.js*", requestStage: "Request" }] });
    failChunk = true;
    await fresh(base + "?phone=0", { available: true, peers: [] });
    await ev(`(() => { const k = document.querySelector('#kernelpick'), o = Object.assign(document.createElement('option'), { value: 'relay:r-z', textContent: 'Remote: zed' }); o.dataset.name = 'zed'; k.append(o); k.value = 'relay:r-z'; k.dispatchEvent(new Event('change')); return true; })()`);
    await untilStatus("document.querySelector('#kernelpick').value === 'local'", 20000); // (the fallback, whatever it says)
    const st = await status();
    ok(/^Remote: zed · couldn't connect \(.+\)\. Back to Browser\.$/.test(st) && (await button()) === "Browser" && (await ev("document.querySelector('#kernelpick').value")) === "local", `a start that fails: "Remote: NAME · couldn't connect (…). Back to Browser.", and Browser on the button (${JSON.stringify(st)}, ${await button()})`);
    failChunk = false;
  }
} catch (e) {
  ok(false, `the test itself failed: ${e?.message ?? e}`);
} finally {
  try { ws?.close(); } catch {}
  chrome?.kill("SIGKILL");
  server?.kill();
  // (the browser may still be writing its profile as it dies: retried, and never the test's verdict)
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}
console.log(process.exitCode ? "FAILED" : "all passed");
