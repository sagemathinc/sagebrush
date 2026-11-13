// ci: web-runner order=167 runner=bun chrome
// "Chat here" on the Agents page, end to end in headless Chromium: the built page (dist/agents,
// SAGEBRUSH_AGENTS=1), served with the site's own headers (web/dist/_headers: its CSP's connect-src 'self' is what lets
// the page reach the relay's agent leg on its own origin) by a server that also plays the relay and a runner on one
// of your computers: GET /api/remote/v1/peers, and the agent page leg, a WebSocket that answers the hello, says
// agent.ready, takes the grant, answers a chat message with a turn, and answers {"unpair":true} as the runner does
// (agent.ended "The agent stopped…", then the close). Board's words are checked word for word:
//   - the header's agent menu: your computers (the last used marked), Claude on this computer, Disconnect while
//     connected; Escape; none set up; the listing failed; and the Connect dialog's computers: the heading, a row;
//   - the header while it connects and once allowed; Remember hidden; the Disconnect button's title;
//   - Disconnect: grant.changed {} then {"unpair":true}, and only the page's own line after it;
//   - a leg lost, and a refused hello in the runner's words;
//   - after Disconnect and a reload, nothing of the runner's pairing in localStorage, sessionStorage or IndexedDB.
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && CHROME=google-chrome bun web/agents/test-agents-chat-here.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const dist = join(here, "..", "dist");
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!existsSync(join(dist, "agents", "agents.js"))) { console.error("no web/dist/agents: SAGEBRUSH_AGENTS=1 bun web/build.ts first"); process.exit(1); }

// ---- the site's headers, as web/serve.py applies them
const rules = [];
{
  let cur = null;
  for (const line of readFileSync(join(dist, "_headers"), "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (!/^\s/.test(line)) { cur = { pattern: line.trim(), headers: [] }; rules.push(cur); continue; }
    const i = line.indexOf(":");
    cur?.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
}
const headersFor = (path) => {
  const h = new Headers();
  for (const r of rules) {
    const m = r.pattern.endsWith("*") ? path.startsWith(r.pattern.slice(0, -1)) : path === r.pattern;
    if (m) for (const [k, v] of r.headers) h.set(k, v);
  }
  return h;
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

// ---- the relay and the runner
const R = { mode: "ok", peers: [{ kind: "runner", remote_id: "rid-laptop-01", name: "laptop" }], peersStatus: 200, legs: [], got: [] };
const TOKEN = "TOKEN_" + "t".repeat(40), NONCE = "NONCE_n0nce";
const rpc = (ws, method, params) => ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
const server = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/api/remote/v1/peers") {
      if (R.peersStatus !== 200) return new Response("no", { status: R.peersStatus });
      return Response.json({ peers: R.peers });
    }
    if (url.pathname === "/api/remote/v1/page") {
      if (url.searchParams.get("chan") !== "agent" || url.searchParams.get("remote") !== "rid-laptop-01") return new Response("no", { status: 400 });
      return srv.upgrade(req, { data: { helloed: false, msgs: [] } }) ? undefined : new Response("no", { status: 400 });
    }
    let p = normalize(decodeURIComponent(url.pathname));
    if (p.endsWith("/")) p += "index.html";
    const f = join(dist, p);
    if (!f.startsWith(dist) || !existsSync(f) || statSync(f).isDirectory()) return new Response("not found", { status: 404 });
    const h = headersFor(url.pathname);
    h.set("content-type", types[p.slice(p.lastIndexOf("."))] ?? "application/octet-stream");
    return new Response(Bun.file(f), { headers: h });
  },
  websocket: {
    open(ws) { R.legs.push(ws); },
    message(ws, text) {
      if (text === '{"relay":"ping"}') return ws.send('{"relay":"pong"}');
      const env = JSON.parse(text);
      const m = JSON.parse(env.m);
      if (!ws.data.helloed) {
        ws.data.helloed = true;
        ws.data.hello = m.params;
        if (R.mode === "refuse") { ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: R.refusal, data: { code: "refused", message: R.refusal } } })); return ws.close(1000); }
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocol: 1, purpose: "agent", via: "relay", token: TOKEN, nonce: NONCE, maxFrameBytes: 4 * 1024 * 1024 - 4096, limits: { frame: 4 * 1024 * 1024 - 2048 }, gen: 3, incarnation: "0123456789abcdef", remote_id: "rid-laptop-01", channels: ["agent"], resumed: false } }));
        rpc(ws, "agent.ready", { agent: { name: "Claude", client: "claude-agent-sdk", version: "0.4.0" }, features: ["notebook.edit", "permission.digest"], child: "child-laptop-1" });
        return;
      }
      ws.data.msgs.push(m);
      R.got.push(m);
      if (m.method === "chat.message") {
        const { conversation, id } = m.params, turn_id = "turn-" + id;
        const ev = (event) => rpc(ws, "turn.event", { conversation, turn_id, in_reply_to: id, event });
        ev({ type: "turn_started" });
        ev({ type: "message_revised", message: turn_id + ":1", revision: 1 });
        ev({ type: "text_delta", message: turn_id + ":1", revision: 1, text: "hello from laptop" });
        ev({ type: "turn_finished", outcome: "completed" });
      }
      // (the mode it enforces, as the agent says it: what the page asked for, unless the row says otherwise)
      if (m.method === "grant.changed" && m.params?.folders) rpc(ws, "agent.mode", { native: R.saysNative ?? m.params.native === true });
      if (m.method === "grant.changed" && m.params?.folders && R.mode === "drop") setTimeout(() => ws.close(1001), 300);
      if (m.unpair === true) {
        // (as the runner answers an unpair: its agent.ended, then the page's close)
        rpc(ws, "agent.ended", { text: "The agent stopped. Connect again to restart it." });
        setTimeout(() => ws.close(1000), 50);
      }
    },
  },
});
const site = `http://127.0.0.1:${server.port}`;

// ---- Chromium
const profile = mkdtempSync(join(tmpdir(), "sb-chat-here-"));
let cdp = Number(process.env.CDP_PORT || 0);
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${cdp}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
try {
  if (!cdp) cdp = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
  const sock = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (sock.onopen = r));
  let n = 0;
  const waiting = new Map();
  const violations = [];
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    if (m.method === "Runtime.consoleAPICalled" || m.method === "Log.entryAdded") { const t = JSON.stringify(m.params); if (/Content Security Policy|Refused to connect/.test(t)) violations.push(t.slice(0, 300)); }
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); sock.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
  const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  const open = async () => { await send("Page.navigate", { url: site + "/agents/" }); await sleep(300); return until(`document.readyState === 'complete' && !!document.querySelector('#editor .mb') && !document.querySelector('#connect').hidden`, 30000); };
  const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
  const dialogText = () => ev(`[...document.querySelectorAll('.sbag-dlg')].at(-1)?.textContent ?? ''`);
  const bar = () => ev(`({ alert: document.querySelector('#conn-alert').textContent, status: document.querySelector('#conn-status').textContent })`);
  const menuText = () => ev(`document.querySelector('.pick-menu')?.textContent ?? ''`);
  const menuItems = () => ev(`[...document.querySelectorAll('.pick-menu [role=menuitem]')].map((b) => b.textContent)`);
  const closeMenu = () => ev(`document.querySelector('.pick-menu') && document.querySelector('.pick-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  // (the header's agent menu: Claude on laptop)
  const chatHere = async () => {
    await ev(`document.querySelector('#connect').click()`);
    if (!(await until(`[...document.querySelectorAll('.pick-menu [role=menuitem]')].some((b) => b.textContent.startsWith('Claude on laptop'))`))) return false;
    await ev(`[...document.querySelectorAll('.pick-menu [role=menuitem]')].find((b) => b.textContent.startsWith('Claude on laptop')).click()`);
    return true;
  };

  ok(await open(), "the Agents page opens");
  // (the header's agent menu: your computers, then Claude on this computer; nothing to disconnect yet)
  ok((await text("#connect")) === "Connect ▾" && (await ev(`document.querySelector('#connect').getAttribute('aria-haspopup')`)) === "menu", "the header's button: \"Connect ▾\", a menu");
  await ev(`document.querySelector('#connect').click()`);
  ok(await until(`[...document.querySelectorAll('.pick-menu [role=menuitem]')].length === 2`), "the agent menu lists your computers", await menuItems());
  ok(JSON.stringify(await menuItems()) === JSON.stringify(["Claude on laptop", "Claude on this computer…"]) && (await menuText()).startsWith("Your computers"), "…\"Your computers\": Claude on laptop, then Claude on this computer…; no Disconnect", await menuItems());
  ok(await ev(`document.activeElement?.textContent === 'Claude on laptop' && document.querySelector('#connect').getAttribute('aria-expanded') === 'true'`), "…its first item has the focus, and the button says it's open");
  await closeMenu();
  ok(await ev(`!document.querySelector('.pick-menu') && document.activeElement === document.querySelector('#connect') && document.querySelector('#connect').getAttribute('aria-expanded') === 'false'`), "Escape closes the menu, and the focus goes back to its button");
  // (the Connect dialog, from "Claude on this computer…": your computers there too, in their reviewed words)
  await ev(`document.querySelector('#connect').click()`);
  await until(`[...document.querySelectorAll('.pick-menu [role=menuitem]')].some((b) => b.textContent === 'Claude on this computer…')`);
  await ev(`[...document.querySelectorAll('.pick-menu [role=menuitem]')].find((b) => b.textContent === 'Claude on this computer…').click()`);
  ok(await until(`[...document.querySelectorAll('.sbag-dlg .runner')].length === 1`), "Claude on this computer… opens the Connect dialog, which lists your computers too");
  const d = await dialogText();
  ok(d.includes("Or chat with an agent on one of your computers:") && d.includes("laptop") && d.includes("Chat here"), "…under \"Or chat with an agent on one of your computers:\", a row: laptop, Chat here", d);
  ok(d.includes("Code") && d.includes("Port"), "…with the code and port still there, for the agent on this computer");
  await ev(`[...document.querySelectorAll('.sbag-dlg button')].find((b) => b.textContent === 'Cancel').click()`);

  // Chat here: connecting, then the grant dialog (no Remember), then the agent on laptop
  await ev(`(() => { window.__whoSeen = []; new MutationObserver(() => window.__whoSeen.push(document.querySelector('#who').textContent)).observe(document.querySelector('#who'), { childList: true, subtree: true, characterData: true }); return true; })()`);
  ok(await chatHere(), "Chat here");
  ok(await until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Allow')`), "…then the grant dialog");
  ok(await ev(`window.__whoSeen.some((t) => t.includes('Connecting to laptop…'))`), "the header said \"Connecting to laptop…\" meanwhile", await ev(`window.__whoSeen`));
  const leg = R.legs.at(-1);
  ok(leg.data.hello?.fresh === true && leg.data.hello?.purpose === "agent" && !("remember" in leg.data.hello) && !("resume" in leg.data.hello), "the hello asks a fresh agent and remembers nothing", leg.data.hello);
  ok(!(await ev(`[...document.querySelectorAll('.sbag-dlg label')].some((l) => l.textContent.startsWith('Remember'))`)), "Remember this agent isn't offered for a computer's agent");
  // (the shell-and-files switch: offered for a computer's agent, on by default, with its one line of scope)
  const sw = await ev(`(() => { const l = [...document.querySelectorAll('.sbag-dlg label')].find((l) => l.textContent === 'Allow shell and files on laptop'); return l ? { checked: l.querySelector('input').checked, note: l.nextElementSibling?.textContent } : null; })()`);
  ok(sw?.checked === true && sw.note === "Claude runs as you on laptop: it can run commands and read and change files there, asking first as it does in a terminal.", "the switch \"Allow shell and files on laptop\", on, and its scope line", sw);
  await ev(`[...document.querySelectorAll('.sbag-dlg button')].find((b) => b.textContent === 'Allow').click()`);
  ok(await until(`document.querySelector('#who').textContent.includes('Claude') && document.querySelector('#who').textContent.includes('on laptop')`), "allowed: \"Claude on laptop\"", await text("#who"));
  ok((await text("#connect")) === "Connected ▾", "the button says \"Connected ▾\"");
  ok(leg.data.msgs.some((m) => m.method === "grant.changed" && m.params?.folders && m.params.native === true), "the grant asks for shell and files (native: true)", leg.data.msgs.filter((m) => m.method === "grant.changed"));
  ok(await until(`(document.querySelector('.sbag-bar')?.textContent ?? '').includes('Claude on laptop: read and write everywhere · may run code · 0 changes · shell and files on')`), "the bar: on laptop, and the mode the agent says it enforces", await ev(`document.querySelector('.sbag-bar')?.textContent`));
  ok(await ev(`localStorage.getItem('sagebrush-agents-last-computer') === JSON.stringify({ remote_id: 'rid-laptop-01', name: 'laptop' })`), "the computer is remembered as the last one used: its id and name only", await ev(`localStorage.getItem('sagebrush-agents-last-computer')`));
  await ev(`document.querySelector('#connect').click()`);
  ok(await until(`[...document.querySelectorAll('.pick-menu [role=menuitem]')].length === 3`) && JSON.stringify(await menuItems()) === JSON.stringify(["Claude on laptoplast used", "Claude on this computer…", "Disconnect"]), "connected: the menu marks laptop as last used, and offers Disconnect", await menuItems());
  await closeMenu();
  ok(leg.data.msgs.some((m) => m.method === "grant.changed" && m.params?.folders) && leg.data.msgs.some((m) => m.method === "page.features" && m.params.features.includes("permission.digest")), "the grant is told to the agent, and permission.digest among the page's features");
  ok(violations.length === 0, "no Content Security Policy refusal: connect-src 'self' covers the page's own wss origin", violations);
  const title = await ev(`[...document.querySelectorAll('.sbag-bar button')].find((b) => b.textContent === 'Disconnect')?.title ?? null`);
  ok(title === "Disconnect and stop the agent on laptop", "the bar's Disconnect: \"Disconnect and stop the agent on laptop\"", title);

  // a chat turn through the leg
  await ev(`document.querySelector('#new').click()`);
  await until(`!!document.querySelector('[data-try]')?.offsetParent`);
  await ev(`document.querySelector('[data-try]').click()`);
  ok(await until(`document.body.innerText.includes('hello from laptop')`), "a message goes to the agent on laptop, and its turn comes back");
  ok(await ev(`[...document.querySelectorAll('.demo.live')].some((t) => t.textContent === 'on laptop') && ![...document.querySelectorAll('.demo.live')].some((t) => t.textContent === 'on your computer')`), "its turn is tagged \"on laptop\", not \"on your computer\"");
  ok(await ev(`document.querySelector('#banner').textContent === 'Connected to Claude on laptop. Its files are in this browser\\'s workspace; chats are kept in this browser.'`), "the banner: \"Connected to Claude on laptop. …\"", await text("#banner"));

  // Disconnect: the drain's order, then only the page's own line (never the runner's "The agent stopped")
  const before = leg.data.msgs.length;
  await ev(`[...document.querySelectorAll('.sbag-bar button')].find((b) => b.textContent === 'Disconnect').click()`);
  ok(await until(`document.querySelector('#conn-status').textContent.length > 0`), "Disconnect: the bar says so");
  const after = leg.data.msgs.slice(before);
  ok(JSON.stringify(after) === JSON.stringify([{ jsonrpc: "2.0", method: "grant.changed", params: {} }, { unpair: true }]), "…grant.changed {}, then {\"unpair\":true}", after);
  await sleep(300);
  const b1 = await bar();
  ok(b1.status === "Disconnected. The agent on laptop may keep running for up to 5 minutes." && !b1.alert && !(await ev(`document.body.innerText.includes('The agent stopped')`)), "…only \"Disconnected. The agent on laptop may keep running for up to 5 minutes.\" (the runner's agent.ended isn't shown)", b1);

  // after Disconnect and a reload: nothing of the runner's pairing kept in any store
  await send("Page.reload", {});
  await sleep(300);
  await until(`document.readyState === 'complete' && !!document.querySelector('#editor .mb')`, 30000);
  const stores = await ev(`(async () => {
    const out = { local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }), idb: "" };
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise((ok, no) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
      for (const s of db.objectStoreNames) {
        const all = await new Promise((ok) => { const r = db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => ok([]); });
        out.idb += JSON.stringify(all, (k, v) => (v instanceof Blob || ArrayBuffer.isView(v) ? "(bytes)" : v));
      }
      db.close();
    }
    return out;
  })()`);
  const all = stores.local + stores.session + stores.idb;
  ok(!all.includes(TOKEN) && !all.includes(NONCE) && !all.includes("child-laptop-1") && !all.includes("rid-laptop-01") && !stores.session.includes("sb-agent-reload"), "after Disconnect and a reload: no token, nonce, agent child, computer or reload record in localStorage, sessionStorage or IndexedDB", { local: stores.local.length, session: stores.session.slice(0, 200), idb: stores.idb.length });
  ok(!/"grant":\{[^}]*"folders"/.test(stores.idb.replace(/\s/g, "")) || !stores.idb.includes("laptop"), "…and no grant kept for it");

  // a leg lost: the lost line, with how to connect again
  R.mode = "drop";
  ok(await chatHere(), "Chat here again");
  ok(await until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Allow')`), "…its grant dialog");
  await ev(`[...document.querySelectorAll('.sbag-dlg button')].find((b) => b.textContent === 'Allow').click()`);
  ok(await until(`document.querySelector('#conn-alert').textContent.startsWith('Not connected to laptop')`), "the leg lost: the bar's alert", await bar());
  const b2 = await bar();
  ok(/^Not connected to laptop(: .+)?\. Choose Chat here to connect again\.$/.test(b2.alert), "…\"Not connected to laptop[: why]. Choose Chat here to connect again.\"", b2);
  ok(await ev(`localStorage.getItem('sagebrush-agents-last-computer') === JSON.stringify({ remote_id: 'rid-laptop-01', name: 'laptop' })`), "a lost leg keeps the computer as the last one used (only the person's own Disconnect forgets it)");

  // a refused hello: the runner's words, as they are
  R.mode = "refuse";
  R.refusal = "The agent is already open in another page or tab. Close it there, then connect again here.";
  ok(await chatHere(), "Chat here, while another tab holds the agent");
  ok(await until(`document.querySelector('#conn-alert').textContent === ${JSON.stringify(R.refusal)}`), "the runner's refusal, in its own words", await bar());

  // none set up; the listing failed
  R.mode = "ok";
  R.peers = [];
  await ev(`document.querySelector('#connect').click()`);
  ok(await until(`(document.querySelector('.pick-menu')?.textContent ?? '').includes('None of your computers is set up for this. On one, run: sagebrush remote login')`), "none set up: \"None of your computers is set up for this. On one, run: sagebrush remote login\"");
  await closeMenu();
  // signed out (401 or 403): the reason, and the site's sign-in, back to this page (its query too)
  await ev(`history.replaceState(null, "", location.pathname + "?from=a b&x=1")`);
  for (const status of [401, 403]) {
    R.peersStatus = status;
    await ev(`document.querySelector('#connect').click()`);
    ok(await until(`(document.querySelector('.pick-menu')?.textContent ?? '').includes('Your computers: sign in to see them')`), `${status}: "Your computers: sign in to see them"`);
    const signIn = await ev(`(() => { const a = document.querySelector('.pick-menu')?.querySelector('a.sign-in'); return a ? { text: a.textContent, href: a.getAttribute('href') } : null; })()`);
    const back = await ev(`location.pathname + location.search`);
    ok(back.includes("?from=") && signIn?.text === "Sign in with CoCalc" && signIn?.href === "/auth/login?return=" + encodeURIComponent(back), `${status}: a "Sign in with CoCalc" link to the site's sign-in, back to this page and its query`, { signIn, back });
    await closeMenu();
  }
  R.peersStatus = 500;
  await ev(`document.querySelector('#connect').click()`);
  ok(await until(`(document.querySelector('.pick-menu')?.textContent ?? '').includes("Your computers: this site can't list your computers (HTTP 500)")`), "another failure: its reason");
  ok(await ev(`!(document.querySelector('.pick-menu')?.querySelector('a.sign-in'))`), "…and no sign-in link");

  // the switch's effects: the bar shows what the agent says it enforces, and unticked, the grant asks for none
  R.peersStatus = 200;
  R.peers = [{ kind: "runner", remote_id: "rid-laptop-01", name: "laptop" }];
  R.mode = "ok";
  R.saysNative = false; // (the agent says it isn't using shell and files, whatever was asked)
  await closeMenu(); // (the menu the last row left open)
  const disconnect = async () => { await ev(`[...document.querySelectorAll('.sbag-bar button')].find((b) => b.textContent === 'Disconnect')?.click()`); await until(`!document.querySelector('.sbag-bar')`); };
  ok(await chatHere(), "Chat here, the agent saying it runs without shell and files");
  ok(await until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Allow')`), "…its grant dialog");
  await ev(`[...document.querySelectorAll('.sbag-dlg button')].find((b) => b.textContent === 'Allow').click()`);
  ok(await until(`(document.querySelector('.sbag-bar')?.textContent ?? '').includes('Sagebrush files only')`), "the bar shows the mode the agent says, not the one asked for", await ev(`document.querySelector('.sbag-bar')?.textContent`));
  await disconnect();
  R.saysNative = undefined;
  ok(await chatHere(), "Chat here again, the switch turned off");
  ok(await until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Allow')`), "…its grant dialog");
  await ev(`(() => { const l = [...document.querySelectorAll('.sbag-dlg label')].find((l) => l.textContent === 'Allow shell and files on laptop'); l.querySelector('input').click(); })()`);
  await ev(`[...document.querySelectorAll('.sbag-dlg button')].find((b) => b.textContent === 'Allow').click()`);
  const leg3 = R.legs.at(-1);
  ok(await until(`(document.querySelector('.sbag-bar')?.textContent ?? '').includes('Sagebrush files only')`), "unticked: the bar says Sagebrush files only", await ev(`document.querySelector('.sbag-bar')?.textContent`));
  ok(leg3.data.msgs.some((m) => m.method === "grant.changed" && m.params?.folders && m.params.native === false) && !leg3.data.msgs.some((m) => m.method === "grant.changed" && m.params?.native === true), "unticked: the grant asks for none (native: false)", leg3.data.msgs.filter((m) => m.method === "grant.changed"));
  await disconnect();
} finally {
  chrome.kill();
  server.stop(true);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(failures ? `test-agents-chat-here: ${failures} failed` : "test-agents-chat-here: all passed");
process.exit(failures ? 1 : 0);
