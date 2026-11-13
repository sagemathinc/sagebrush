// ci: web-browser/remote-preview order=30
// A notebook's code on one of your computers, through the relay, in the notebook page (web/notebook/remote-ui.js
// relayedStarter; the "Where code runs" picker, #kernelpick), end to end in headless Chromium:
//   1. nothing asked at load; your computers come from the same peers answer as ⋯ ▸ Terminal on your computer, at the
//      first ⋯ open, and only a literal available: true offers them; then the picker shows one "On NAME" per computer,
//      the name as text, with the help's three limits, and without the paired choice (still offered only with
//      ?remote=1 or a pairing link);
//   2. choosing one opens that computer's kernel page leg on this site's relay (its URL: chan=kernel and its id), pairs
//      with the page's public key (no code, no session) and binds: the status line says "On NAME · ready";
//   3. a person's Run sends the cell to the computer (a run frame on the leg, its code); a run without the gesture is
//      never sent (the page's gate, as for the paired kernel);
//   4. the leg ending (as when another notebook or tab chooses that computer) is said with its likely cause, and offers
//      Retry and Switch to browser; Switch to browser gives This browser back;
//   5. an account the peers answer doesn't let use them: no option, and the picker stays hidden.
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
  // (the peers answer the next request gets, and how many were asked)
  let peersBody = null, peersAsked = 0;
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    else if (m.method === "Fetch.requestPaused") {
      peersAsked++;
      send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(peersBody)).toString("base64") });
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
    const leg = window.__leg = { legs: [], sent: [] };
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; leg.legs.push(this); leg.sock = this; setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0); }
      send(t) {
        const m = JSON.parse(t); leg.sent.push(m);
        const say = (o) => setTimeout(() => this.onmessage?.({ data: JSON.stringify(o) }), 0);
        if (m.method === "hello") say({ jsonrpc: "2.0", id: m.id, result: { protocol: 1, purpose: "kernel", via: "relay", token: "T".repeat(43), nonce: "n1", incarnation: "0123456789abcdef", limits: { frame: 4194304 }, channels: ["kernel", "terminal"] } });
        else if (m.rpc === "g.bind") say({ id: m.id, status: 200, headers: { "content-type": "application/json", "dpop-nonce": "n2" }, body: JSON.stringify({ binding: "b1", epoch: 1, incarnation: 1, state: "ready" }) });
      }
      close(code) { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.onclose?.({ code }), 0); }
    };
    leg.drop = () => { leg.sock.readyState = 3; leg.sock.onclose?.({ code: 1000 }); };
    leg.runs = () => leg.sent.filter((m) => m.rpc === "g.run");
    return true;
  })()`;
  // (a fresh page with the fake leg; ⋯ opened once and closed, with the peers request answered by `body`)
  const fresh = async (url, body) => {
    peersBody = body;
    await send("Page.navigate", { url });
    await sleep(300);
    await until("!!(window.sagebrush && window.sagebrush.notebook) && /ready/.test(document.querySelector('#status').textContent)", 60000);
    await ev(FAKE);
    peersAsked = 0;
    await sleep(300);
    const atLoad = peersAsked;
    await ev("document.querySelector('#morebtn').click(), true");
    await sleep(400);
    await ev("document.querySelector('#morebtn').click(), true");
    return atLoad;
  };
  const options = () => ev("[...document.querySelectorAll('#kernelpick option')].map((o) => [o.value, o.textContent])");
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/remote/v1/peers*", requestStage: "Request" }] });

  // 1. offered from the first ⋯ open's peers answer, one option per computer, names as text
  const NAME = "lite <b>x</b>";
  const atLoad = await fresh(base + "?phone=0", { available: true, peers: [{ remote_id: "r-one", kind: "runner", name: NAME }, { remote_id: "r-two", kind: "runner", name: "big box" }, { remote_id: "a-1", kind: "agent", name: "not a runner" }] });
  ok(atLoad === 0, `nothing asked at load (${atLoad})`);
  await until("document.querySelector('#kernelpick').hidden === false");
  const opts = await options();
  ok(peersAsked === 1, `one peers request, the one ⋯ ▸ Terminal on your computer already makes (${peersAsked})`);
  ok(JSON.stringify(opts) === JSON.stringify([["local", "This browser"], ["relay:r-one", `On ${NAME}`], ["relay:r-two", "On big box"]]), `the picker: This browser, then one "On NAME" per computer (runners only), no paired choice (${JSON.stringify(opts)})`);
  ok(await ev("!document.querySelector('#kernelpick b')"), "a computer's name is text, never markup");
  const help = await ev("document.querySelector('#kernelpick option[value=\"relay:r-one\"]').title");
  ok(/in the folder sagebrush remote started in/.test(help) && /one notebook at a time/.test(help) && /board's hidden notebook still runs in this browser/.test(help), "each option's help says the three limits");

  // 2. choosing a computer: its kernel leg on this site's relay, paired with the page's public key, bound
  const C = await ev("(() => { const nb = sagebrush.notebook; nb.addCell('', null, false, 'code'); return nb.cells().length - 1; })()");
  await ev("(() => { const p = document.querySelector('#kernelpick'); p.value = 'relay:r-one'; p.dispatchEvent(new Event('change')); return true; })()");
  await untilStatus(`document.querySelector('#status').textContent.startsWith(${JSON.stringify(`On ${NAME} · ready`)})`, 20000);
  const leg = await ev("({ url: __leg.legs[0]?.url, n: __leg.legs.length, hello: __leg.sent.find((m) => m.method === 'hello')?.params })");
  const u = new URL(leg.url);
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
  ok(/another notebook or tab may have chosen this computer/.test(await status()), `the lost leg says its likely cause (${await status()})`);
  ok(await ev("[...document.querySelectorAll('#remoteacts button')].map((b) => b.textContent).join('|') === 'Retry|Switch to browser'"), "Retry and Switch to browser are offered");
  await ev("document.querySelector('#remoteacts button:last-child').click(); true");
  await until("document.querySelector('#kernelpick').value === 'local'");
  ok(true, "Switch to browser: This browser again");

  // 5. an account the answer doesn't let use them: no option, the picker hidden
  for (const [what, body] of [["available false", { available: false, peers: [{ remote_id: "r-one", kind: "runner", name: "lite" }] }], ["no computers", { available: true, peers: [] }]]) {
    await fresh(base + "?phone=0", body);
    await sleep(400);
    ok(await ev("document.querySelector('#kernelpick').hidden === true && !document.querySelector('#kernelpick option[value^=\"relay:\"]')"), `${what}: nothing offered, the picker hidden`);
  }
} catch (e) {
  ok(false, `the test itself failed: ${e?.message ?? e}`);
} finally {
  try { ws?.close(); } catch {}
  chrome?.kill("SIGKILL");
  server?.kill();
  rmSync(profile, { recursive: true, force: true });
}
console.log(process.exitCode ? "FAILED" : "all passed");
