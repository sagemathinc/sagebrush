// Sync 2c-3 (notebooks' contents on the wire) in headless Chromium: two devices of one account, each its own browser
// context (its own IndexedDB and Web Locks), against core's reference server (web/sync-protocol/reference-server.ts)
// behind a small front here.  The front serves the page, carries each device's account socket to the server with
// that device's session (the session cookie is __Host-, which a page on http://127.0.0.1 can't hold), and can rewrite
// what the server sends one device (a chain, an owner, a snapshot), as a broken server would.  The cases are below:
// each drives the two devices (test-doc-sync.page.js) and checks the server and both devices.
//   CHROME=chromium bun web/workspace/test-doc-sync.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReferenceServer, SESSION_COOKIE } from "../sync-protocol/reference-server.ts";
import { devtoolsPort } from "../test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, what) => results.push([!!ok, what]);
let code = 1;

// ---- the page: one bundle (the workspace, the journal, the history, doc-sync, the protocol), the device module
const site = mkdtempSync(join(tmpdir(), "sb-ds-site-")), src = mkdtempSync(join(here, ".test-doc-sync-"));
writeFileSync(join(src, "entry.js"), [
  `export * as W from ${J(join(here, "index.ts"))};`,
  `export * as N from ${J(join(here, "../notebook/journal.js"))};`,
  `export * as H from ${J(join(here, "../notebook/history.js"))};`,
  `export * as DS from ${J(join(here, "doc-sync.ts"))};`,
  `export * as P from ${J(join(here, "../sync-protocol/protocol.ts"))};`,
].join("\n"));
const b = await Bun.build({ entrypoints: [join(src, "entry.js")], outdir: site, naming: "all.js", target: "browser", format: "esm" });
rmSync(src, { recursive: true, force: true });
if (!b.success) { console.error(b.logs.join("\n")); process.exit(1); }
copyFileSync(join(here, "test-doc-sync.page.js"), join(site, "device.js"));
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>doc sync test</title><script type="module" src="./device.js"></script>`);

// ---- the server, and the front
const ref = new ReferenceServer();
const ACCOUNT = "d5d5d5d5-0000-4d5d-8d5d-d5d5d5d5d5d5";
const sessions = { A: ref.signIn(ACCOUNT), B: ref.signIn(ACCOUNT) };
// (sync on for the account, as its first device's enable does: off, the server refuses every hello `readonly`)
const enabled = await (await ref.fetch(new Request("http://ref/api/sync/v1/enable", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${sessions.A}` } }))).json();
if (enabled.state !== "active") { console.error("FAIL: enable: " + J(enabled)); process.exit(1); }
// (what the front does to the next `batches` sent to a device: rewrite its chain, its owner, or add a snapshot)
const tamper = { A: null, B: null };
const front = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch(req, server) {
    const u = new URL(req.url);
    if (u.pathname === "/api/sync/v1/account") return server.upgrade(req, { data: { dev: u.searchParams.get("dev") } }) ? undefined : new Response("no", { status: 400 });
    const f = { "/": "index.html", "/all.js": "all.js", "/device.js": "device.js" }[u.pathname];
    if (!f) return new Response("not found", { status: 404 });
    return new Response(Bun.file(join(site, f)), { headers: { "content-type": f.endsWith(".js") ? "text/javascript" : "text/html" } });
  },
  websocket: {
    async open(ws) {
      const s = await ref.connect(`${SESSION_COOKIE}=${sessions[ws.data.dev]}`);
      if (!s.send) return ws.close(4401, "no session");
      ws.data.s = s;
      s.onmessage = (text) => {
        const t = tamper[ws.data.dev];
        if (t) {
          const m = JSON.parse(text);
          if (m.t === "batches" && m.items?.length) {
            tamper[ws.data.dev] = null;
            if (t === "chain") m.items[0].chain = "0".repeat(64);
            if (t === "owner") m.owner = "f".repeat(64);
            if (t === "snapshot") m.snapshot = { at_seq: 1, sha256: "0".repeat(64) };
            text = J(m);
          }
        }
        try { ws.send(text); } catch {}
      };
      s.onclose = (c) => { try { ws.close(c); } catch {} };
      for (const m of ws.data.queue ?? []) s.send(m);
    },
    message(ws, m) { if (ws.data.s) ws.data.s.send(String(m)); else (ws.data.queue ??= []).push(String(m)); },
    close(ws) { ws.data.s?.close(); },
  },
});

// ---- Chromium: one browser, a context per device
let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-ds-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
const errors = [];
// (its own deadline: a hang anywhere ends the run here, the browser killed, saying where it was)
let step = "start";
const t0 = Date.now();
const progress = (what) => { step = what; console.log(`step ${((Date.now() - t0) / 1000).toFixed(1)}s: ${what}`); };
const deadline = setTimeout(() => {
  console.error(`FAIL: the run's deadline passed at step: ${step}`);
  for (const e of errors) console.error("page error: " + e);
  try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); rmSync(site, { recursive: true, force: true }); } catch {}
  process.exit(2);
}, Number(process.env.DEADLINE_MS) || 240_000);
try {
  if (!port) port = await devtoolsPort(profile);
  let version;
  for (let i = 0; i < 300; i++) { try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(100); } }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.error ? { error: m.error } : m.result); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? J(m.params.exceptionDetails));
  };
  const send = (method, params = {}, sessionId) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(J({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  // (a device: a browser context of its own, a page in it, its session for evaluating there)
  async function device(dev) {
    const { browserContextId } = await send("Target.createBrowserContext");
    const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Runtime.enable", {}, sessionId);
    await send("Page.navigate", { url: `http://127.0.0.1:${front.port}/` }, sessionId);
    const ev = async (expression) => {
      const r = await Promise.race([send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId), sleep(45_000).then(() => ({ error: `timed out: ${expression.slice(0, 80)}` }))]);
      if (r?.exceptionDetails || r?.error) throw new Error(`${dev}: ` + J(r.exceptionDetails ?? r.error).slice(0, 600));
      return r.result?.value;
    };
    for (let i = 0; i < 200 && !(await ev("window.ready === true").catch(() => false)); i++) await sleep(50);
    await ev(`T.init(${J(dev)})`);
    return { dev, ev, call: (f, ...args) => { progress(`${dev}.${f}`); return ev(`T.${f}(${args.map((a) => J(a)).join(", ")})`); } };
  }
  progress("devices");
  const A = await device("A"), B = await device("B");
  const both = async (f, ...args) => Promise.all([A.call(f, ...args), B.call(f, ...args)]);
  const settle = async () => { for (let i = 0; i < 3; i++) await both("idle"); };
  await A.call("connect", "A", ACCOUNT);
  await B.call("connect", "B", ACCOUNT);

  progress("case 1");
  // 1. A new notebook on A reaches B: claimed first, its root sent with kind and owner, pulled by B (changed), and B's
  // record made from the history's head
  const N1 = "11111111-2222-4333-8444-555555555555";
  await A.call("open", N1, [["a", "A1"], ["b", "B1"]]);
  await A.call("kick", N1);
  await settle();
  const sd = ref.controls.doc(ACCOUNT, N1), clients = ref.controls.clients(ACCOUNT, N1), aj = await A.call("journal", N1);
  check(sd && sd.head >= 1 && clients && Object.keys(clients).length === 1 && aj.lrows === 0 && aj.slot?.claimed?.client === aj.slot?.client, "1: A's new notebook: its client claimed before its batch, the batch acked, its l rows released: " + J({ head: sd?.head, clients: clients && Object.keys(clients).length, lrows: aj.lrows }));
  const bj = await B.call("journal", N1);
  const bo = await B.call("open", N1);
  check(bj.start && bj.cursor?.after === sd.head && bo.row === "from-server" && bo.codes === J([["a", "A1"], ["b", "B1"]]), "1: …B, told `changed`, pulls it (the chain checked), and its record is the history's head: " + J({ row: bo.row, codes: bo.codes, cursor: bj.cursor?.after }));

  progress("case 2");
  // 2. B edits; A (its notebook open, the writer) merges it into its record
  check(await B.call("edit", N1, [["a", "A1"], ["b", "B2"]]) === true, "2: B's edit saved");
  await settle();
  const ar2 = await A.call("record", N1);
  check(ar2.codes === J([["a", "A1"], ["b", "B2"]]) && ar2.mark === null, "2: …it reaches A, whose record becomes the merge, unmarked: " + ar2.codes);

  progress("case 3");
  // 3. Offline on both, separate cells: both kept, both devices the same
  await B.call("disconnect");
  await A.call("edit", N1, [["a", "A3"], ["b", "B2"]]);
  await B.call("edit", N1, [["a", "A1"], ["b", "B3"]]);
  await settle();
  await B.call("connect", "B", ACCOUNT);
  await settle();
  await settle();
  const [ar3, br3] = [await A.call("record", N1), await B.call("record", N1)];
  check(ar3.codes === J([["a", "A3"], ["b", "B3"]]) && br3.codes === ar3.codes, "3: edits of separate cells made apart: both kept, the two devices the same: " + J({ A: ar3.codes, B: br3.codes }));

  progress("case 4");
  // 4. A clash (the same cell, apart): the later patch is kept on both devices
  await B.call("disconnect");
  await A.call("edit", N1, [["a", "X"], ["b", "B3"]]);
  await sleep(20);
  await B.call("edit", N1, [["a", "Y"], ["b", "B3"]]);
  await settle();
  await B.call("connect", "B", ACCOUNT);
  await settle();
  await settle();
  const [ar4, br4] = [await A.call("record", N1), await B.call("record", N1)];
  check(ar4.codes === J([["a", "Y"], ["b", "B3"]]) && br4.codes === ar4.codes, "4: the same cell changed apart: the later patch kept, the same on both devices: " + J({ A: ar4.codes, B: br4.codes }));

  progress("case 5");
  // 5. order with next_cseq: the rows below it acknowledged, the rest sent again; then unknown_client: claimed again
  const aj5 = await A.call("journal", N1);
  ref.controls.fake("batch", { error: { code: "order", detail: { client: aj5.slot.client, next_cseq: aj5.slot.cseq } } });
  await A.call("edit", N1, [["a", "Y5"], ["b", "B3"]]);
  await settle();
  ref.controls.fake("batch", { error: { code: "unknown_client", detail: {} } });
  await A.call("edit", N1, [["a", "Y6"], ["b", "B3"]]);
  await settle();
  const [aj6, br6] = [await A.call("journal", N1), await B.call("record", N1)];
  check(aj6.lrows === 0 && br6.codes === J([["a", "Y6"], ["b", "B3"]]) && !Object.keys(await A.call("stopped")).length, "5: `order` (next_cseq) and `unknown_client` answered: nothing left unsent, B has the last edit: " + J({ lrows: aj6.lrows, B: br6.codes }));

  progress("case 6");
  // 6. a transient refusal waits and sends again; a final one stops the notebook, its rows kept
  ref.controls.fake("batch", { error: { code: "rate", detail: { retry_after: 1 } } });
  await A.call("edit", N1, [["a", "Y7"], ["b", "B3"]]);
  await settle();
  await sleep(400);
  await settle();
  const [br7, aj7] = [await B.call("record", N1), await A.call("journal", N1)];
  check(br7.codes === J([["a", "Y7"], ["b", "B3"]]) && aj7.lrows === 0, "6: a transient refusal (rate): sent again after its wait and acknowledged (A's rows released), B has it: " + J({ B: br7.codes, lrows: aj7.lrows }));
  // (readonly: no resend on a timer (cloud's server says it unasked when a plan lapses), the rows kept unacknowledged,
  // sent again at the next connection.  The reference server's fake replaces the answer only, the batch stored: so
  // this is told by A's rows and events, not by B)
  await A.call("events");
  ref.controls.fake("batch", { error: { code: "readonly", detail: {} } });
  await A.call("edit", N1, [["a", "Y7r"], ["b", "B3"]]);
  await settle();
  await sleep(400);
  await A.call("kick", N1);
  await settle();
  const [ajR, evR] = [await A.call("journal", N1), await A.call("events")];
  await A.call("disconnect");
  await A.call("connect", "A", ACCOUNT);
  await settle();
  await settle();
  const [ajR2, evR2, stR, brR] = [await A.call("journal", N1), await A.call("events"), await A.call("stopped"), await B.call("record", N1)];
  const refusedR = evR.filter((e) => e.t === "refused" && e.code === "readonly").length, ackedR = evR.filter((e) => e.t === "ack").length;
  check(ajR.lrows >= 1 && refusedR === 1 && ackedR === 0 && ajR2.lrows === 0 && evR2.some((e) => e.t === "ack") && !stR[N1] && brR.codes === J([["a", "Y7r"], ["b", "B3"]]), "6: `readonly`: refused once, nothing resent on a timer or a kick, the rows kept; sent at the next connection and acknowledged; not stopped: " + J({ lrows: ajR.lrows, refused: refusedR, acked: ackedR, after: ajR2.lrows, stopped: stR[N1]?.code ?? null }));
  const N2 = "22222222-3333-4444-8555-666666666666";
  ref.controls.fake("batch", { error: { code: "forbidden", detail: {} } });
  await A.call("open", N2, [["a", "Z"]]);
  await A.call("kick", N2);
  await settle();
  const [stopped2, aj8] = [await A.call("stopped"), await A.call("journal", N2)];
  check(stopped2[N2]?.code === "forbidden" && aj8.lrows === 1, "6: a final refusal (forbidden): the notebook stops here, its rows kept: " + J({ stop: stopped2[N2]?.code, lrows: aj8.lrows }));

  progress("case 7");
  // 7. what the server sends, checked: a chain that differs, another owner, a snapshot: B stops, its cursor unchanged
  for (const [t, codeWant] of [["chain", "chain"], ["owner", "invalid"], ["snapshot", "snapshot"]]) {
    const id = `33333333-4444-4555-8666-77777777777${"cos".indexOf(t[0])}`;
    await B.call("disconnect");
    await A.call("open", id, [["a", t]]);
    await A.call("kick", id);
    await settle();
    tamper.B = t;
    await B.call("connect", "B", ACCOUNT);
    // (B missed the `changed` while away: it pulls the notebook, starting it here)
    await B.call("kick", id, true);
    await settle();
    const [st, bj7] = [await B.call("stopped"), await B.call("journal", id)];
    check(st[id]?.code === codeWant && !bj7.cursor, `7: a page with ${t === "chain" ? "a chain that differs" : t === "owner" ? "another owner" : "a snapshot"}: never applied, the notebook stops on B, no cursor: ` + J({ stop: st[id]?.code, cursor: bj7.cursor }));
    tamper.B = null;
  }

  progress("case 8");
  // 8. A1: B's notebook closed while A edits: B's pull stores the page and no record is written then; B's next open
  // merges it (recovery), never reverting it
  await B.call("close", N1);
  await A.call("edit", N1, [["a", "Y8"], ["b", "B3"]]);
  await settle();
  const before8 = await B.call("record", N1);
  const bo8 = await B.call("open", N1);
  const after8 = await B.call("record", N1);
  check(before8.codes === J([["a", "Y7r"], ["b", "B3"]]) && bo8.row === "merged" && after8.codes === J([["a", "Y8"], ["b", "B3"]]), "8: a page stored with B's notebook closed (no T2): B's next load merges it, never reverting it: " + J({ before: before8.codes, row: bo8.row, after: after8.codes }));

  const fails = results.filter(([ok]) => !ok).map(([, what]) => what);
  for (const e of errors) fails.push("page error: " + e);
  if (fails.length) console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  "));
  else {
    console.log(`ok: notebooks' contents between two devices, ${results.length} checks`);
    if (process.env.SHOW) for (const [, what] of results) console.log("  " + what);
    code = 0;
  }
  ws.close();
} catch (e) {
  console.error("FAIL: " + (e?.stack ?? e));
} finally {
  try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
  front.stop(true);
  await sleep(200);
  for (const d of [profile, site]) rmSync(d, { recursive: true, force: true });
}
clearTimeout(deadline);
process.exit(code);
