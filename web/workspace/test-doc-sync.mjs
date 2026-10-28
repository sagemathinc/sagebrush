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
import { accountHash } from "../sync-protocol/protocol.ts";
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
  `export * as NB from ${J(join(here, "../notebook/notebook.js"))};`,
].join("\n"));
const b = await Bun.build({ entrypoints: [join(src, "entry.js")], outdir: site, naming: "all.js", target: "browser", format: "esm" });
rmSync(src, { recursive: true, force: true });
if (!b.success) { console.error(b.logs.join("\n")); process.exit(1); }
copyFileSync(join(here, "test-doc-sync.page.js"), join(site, "device.js"));
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>doc sync test</title><script type="module" src="./device.js"></script>`);

// ---- the server, and the front
const ref = new ReferenceServer();
const ACCOUNT = "d5d5d5d5-0000-4d5d-8d5d-d5d5d5d5d5d5";
const sessions = { A: ref.signIn(ACCOUNT), B: ref.signIn(ACCOUNT), C: ref.signIn(ACCOUNT), D: ref.signIn(ACCOUNT) };
// (sync on for the account, as its first device's enable does: off, the server refuses every hello `readonly`)
const enabled = await (await ref.fetch(new Request("http://ref/api/sync/v1/enable", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${sessions.A}` } }))).json();
if (enabled.state !== "active") { console.error("FAIL: enable: " + J(enabled)); process.exit(1); }
// (what the front does to the next `batches` sent to a device: rewrite its chain, its owner, or add a snapshot)
const tamper = { A: null, B: null };
const front = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(req, server) {
    const u = new URL(req.url);
    // (a socket without `dev` is device D's: case 14's pages, whose real SyncClients open it as a page does)
    if (u.pathname === "/api/sync/v1/account") return server.upgrade(req, { data: { dev: u.searchParams.get("dev") ?? "D" } }) ? undefined : new Response("no", { status: 400 });
    // (case 14's real owners and Sync panel: the session's account, and the sync API with device D's session, as the
    // site serves them on its own origin)
    if (u.pathname === "/api/share/me") return Response.json({ account_id: ACCOUNT });
    if (u.pathname.startsWith("/api/sync/")) {
      const h = new Headers({ cookie: `${SESSION_COOKIE}=${sessions.D}` });
      for (const k of ["content-type", "x-sync-account", "x-sync-generation"]) { const v = req.headers.get(k); if (v) h.set(k, v); }
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
      return ref.fetch(new Request("http://ref" + u.pathname + u.search, { method: req.method, headers: h, body }));
    }
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
}, Number(process.env.DEADLINE_MS) || 480_000);
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

  const owner = await accountHash(ACCOUNT);

  progress("case 9");
  // 9. CORR-2C3-1 (astra): a flight sends nothing after a pull that waits or stops, nor on a connection that's gone.  A
  // notebook claimed and sent, then edited offline (one row unsent); a DocSync of its own over a deferred link answers
  // its pull, and nothing may follow it: no claim, no batch, the row kept, the notebook held or stopped as the answer says
  const N9 = "99999999-1111-4222-8333-444444444444";
  await A.call("open", N9, [["a", "n9"]]);
  await A.call("kick", N9);
  await settle();
  const aj9 = await A.call("journal", N9);
  check(aj9.slot?.claimed?.client === aj9.slot?.client && aj9.lrows === 0, "9: N9 claimed and sent: " + J({ claimed: aj9.slot?.claimed, lrows: aj9.lrows }));
  await A.call("disconnect");
  await A.call("edit", N9, [["a", "n9b"]]);
  const after9 = (await A.call("journal", N9)).cursor?.after ?? 0, head9 = { epoch: 1, seq: after9, chain: null };
  const pulls9 = [
    ["readonly", { t: "error", code: "readonly", detail: { message: "m" } }, null],
    ["rate", { t: "error", code: "rate", detail: { message: "m", retry_after: 1 } }, null],
    ["a snapshot", { t: "batches", owner, doc: N9, epoch: 1, head: head9, items: [], more: false, snapshot: { at_seq: 1 } }, "snapshot"],
    ["a chain that differs", { t: "batches", owner, doc: N9, epoch: 1, head: head9, items: [{ seq: after9 + 1, recv: 1, author: "person", writer: "session:x", device: "x", chain: "0".repeat(64), patches: [], body: "" }], more: false }, "chain"],
    ["another owner", { t: "batches", owner: "f".repeat(64), doc: N9, epoch: 1, head: head9, items: [], more: false }, "invalid"],
    ["a final refusal", { t: "error", code: "forbidden", detail: { message: "m" } }, "forbidden"],
  ];
  for (const [what, frame, stopCode] of pulls9) {
    await A.call("fakeStart", ACCOUNT, N9);
    await A.call("fakeConnect");
    const p = await A.call("fakeWait", "pull");
    await A.call("fakeAnswer", "pull", frame, 300);
    // (and a kick after it: still nothing asked, held or stopped as it is)
    await A.call("fakeKick");
    await sleep(300);
    const [st, j] = [await A.call("fakeState"), await A.call("journal", N9)];
    const state = stopCode ? st.stopped === stopCode : st.held && st.stopped === null;
    check(!!p && J(st.sent) === J(["pull"]) && j.lrows === 1 && state, `9: a pull answered with ${what}: no claim or batch after it, the row kept, ${stopCode ? "stopped " + stopCode : "held"}: ` + J({ sent: st.sent, lrows: j.lrows, stopped: st.stopped, held: st.held }));
  }
  // (the connection dropped while the pull waits: its answer busy, the link gone: a wait, never an invalid stop)
  await A.call("fakeStart", ACCOUNT, N9);
  await A.call("fakeConnect");
  await A.call("fakeWait", "pull");
  await A.call("fakeDisconnect");
  const [sd9, jd9] = [await A.call("fakeState"), await A.call("journal", N9)];
  check(sd9.stopped === null && !sd9.held && J(sd9.sent) === J(["pull"]) && jd9.lrows === 1, "9: the connection dropped while a pull waits: nothing sent after it, neither stopped nor held (the next connection asks again): " + J({ sent: sd9.sent, stopped: sd9.stopped, held: sd9.held, lrows: jd9.lrows }));
  // (answers that go on to another request (order with next_cseq; unknown_client, a claim again), the connection
  // dropped as they arrive: that next request waits for a new connection)
  for (const [what, frame, next] of [["order", { t: "error", code: "order", detail: { message: "m", client: aj9.slot.client, next_cseq: aj9.slot.cseq } }, "batch"], ["unknown_client", { t: "error", code: "unknown_client", detail: { message: "m" } }, "doc_claim"]]) {
    await A.call("fakeStart", ACCOUNT, N9);
    await A.call("fakeConnect");
    await A.call("fakeWait", "pull");
    await A.call("fakeAnswer", "pull", { t: "batches", owner, doc: N9, epoch: 1, head: head9, items: [], more: false }, 50);
    await A.call("fakeWait", "batch");
    await A.call("fakeAnswerDrop", "batch", frame);
    const sx = await A.call("fakeState");
    check(J(sx.sent) === J(["pull", "batch"]) && sx.stopped === null, `9: ${what} answered as the connection drops: no ${next} on the connection that's gone: ` + J({ sent: sx.sent, stopped: sx.stopped }));
  }
  // (a flight of an older connection: its pull waits, the link connects again, then its answer comes: nothing more
  // asked by that flight; the new connection's own flight pulls again)
  await A.call("fakeStart", ACCOUNT, N9);
  await A.call("fakeConnect");
  await A.call("fakeWait", "pull");
  await A.call("fakeConnect");
  await A.call("fakeAnswer", "pull", { t: "batches", owner, doc: N9, epoch: 1, head: head9, items: [], more: false }, 300);
  const sr9 = await A.call("fakeState");
  check(J(sr9.sent) === J(["pull", "pull"]) && J(sr9.waiting) === J(["pull"]), "9: a flight of an older connection asks nothing after its answer; the newer connection pulls again: " + J({ sent: sr9.sent, waiting: sr9.waiting }));
  // (D3-4c: a kick while the batch waits, then the batch refused (rate): held, no second lap)
  await A.call("fakeStart", ACCOUNT, N9);
  await A.call("fakeConnect");
  await A.call("fakeWait", "pull");
  await A.call("fakeAnswer", "pull", { t: "batches", owner, doc: N9, epoch: 1, head: head9, items: [], more: false }, 50);
  // (the unknown_client case above forgot N9's claim: claimed again first, then the batch)
  const c9 = await A.call("fakeWait", "doc_claim", 500);
  if (c9) await A.call("fakeAnswer", "doc_claim", { t: "ack", claim: { client: c9.client, fgen: 0, next_cseq: aj9.slot.cseq } }, 50);
  const b9 = await A.call("fakeWait", "batch");
  await A.call("fakeKick");
  await A.call("fakeAnswer", "batch", { t: "error", code: "rate", detail: { message: "m", retry_after: 1 } }, 300);
  const sk9 = await A.call("fakeState");
  check(!!b9 && J(sk9.sent.filter((t) => t !== "doc_claim")) === J(["pull", "batch"]) && sk9.held && sk9.waiting.length === 0, "9 (D3-4c): a kick during the flight, then the batch refused for a while: held, no second lap: " + J({ sent: sk9.sent, held: sk9.held, waiting: sk9.waiting }));
  // (an older hold's timer never lifts a newer one: rate (its timer 400 ms), a new connection, readonly)
  await A.call("fakeStart", ACCOUNT, N9, 400);
  await A.call("fakeConnect");
  await A.call("fakeWait", "pull");
  await A.call("fakeAnswer", "pull", { t: "error", code: "rate", detail: { message: "m", retry_after: 1 } }, 50);
  await A.call("fakeConnect");
  await A.call("fakeWait", "pull");
  await A.call("fakeAnswer", "pull", { t: "error", code: "readonly", detail: { message: "m" } }, 50);
  await sleep(700);
  const so9 = await A.call("fakeState");
  check(J(so9.sent) === J(["pull", "pull"]) && so9.held && so9.waiting.length === 0, "9: the rate hold's old timer doesn't lift the readonly hold after it: " + J({ sent: so9.sent, held: so9.held }));
  // (r3, astra's r2 report on CORR-2C3-1: nothing an older connection's flight learns or fails at may act on the
  // newer one.  (a) markSent's write held while the connection is replaced, then committed: no batch from the old flight)
  const empty9 = { t: "batches", owner, doc: N9, epoch: 1, head: head9, items: [], more: false };
  await A.call("fakeStart", ACCOUNT, N9);
  await A.call("fakeGateTx");
  await A.call("fakeConnect");
  await A.call("fakeWait", "pull");
  await A.call("fakeAnswer", "pull", empty9, 50);
  const g9 = await A.call("fakeWaitGated");
  await A.call("fakeConnect");
  await A.call("fakeReleaseTx", false);
  const sa9 = await A.call("fakeState");
  check(g9 && J(sa9.sent.filter((t) => t !== "doc_claim")) === J(["pull", "pull"]) && J(sa9.waiting) === J(["pull"]) && sa9.stopped === null, "9 (r3 a): a batch's write held while the connection is replaced: the old flight sends no batch after it; the new one pulls: " + J({ gated: g9, sent: sa9.sent, waiting: sa9.waiting, stopped: sa9.stopped }));
  // ((b) an older connection's pull answered after the reconnect with what would stop the notebook: not stopped, and
  // the new connection pulls)
  for (const [what, frame] of [["a snapshot", { ...empty9, snapshot: { at_seq: 1 } }], ["another owner", { ...empty9, owner: "f".repeat(64) }]]) {
    await A.call("fakeStart", ACCOUNT, N9);
    await A.call("fakeConnect");
    await A.call("fakeWait", "pull");
    await A.call("fakeConnect");
    await A.call("fakeAnswer", "pull", frame, 300);
    const sb = await A.call("fakeState");
    check(sb.stopped === null && J(sb.sent) === J(["pull", "pull"]) && J(sb.waiting) === J(["pull"]), `9 (r3 b): an older connection's pull answered with ${what} after a reconnect: no stop; the new connection pulls: ` + J({ sent: sb.sent, waiting: sb.waiting, stopped: sb.stopped }));
  }
  // ((b) an older connection's history write failing after the reconnect: no stop; the new connection pulls)
  await A.call("fakeStart", ACCOUNT, N9);
  await A.call("fakeGateTx");
  await A.call("fakeConnect");
  await A.call("fakeWait", "pull");
  await A.call("fakeAnswer", "pull", empty9, 50);
  const g9b = await A.call("fakeWaitGated");
  await A.call("fakeConnect");
  await A.call("fakeReleaseTx", true);
  const sc9 = await A.call("fakeState");
  check(g9b && sc9.stopped === null && J(sc9.sent.filter((t) => t !== "doc_claim")) === J(["pull", "pull"]) && J(sc9.waiting) === J(["pull"]), "9 (r3 b): an older connection's history write failing after a reconnect: no stop; the new connection pulls: " + J({ sent: sc9.sent, waiting: sc9.waiting, stopped: sc9.stopped }));
  await A.call("connect", "A", ACCOUNT);
  await settle();

  progress("case 10");
  // 10. CORR-2C3-2 (astra): a marked value (saved with no room for its version, so in no version) is never replaced by
  // a later remote change: B's edit marked, A's later change to the same cell arrives: B's record keeps B's whole value
  // (an unrelated cell too), still marked; and so after a reload
  const N10 = "aaaaaaaa-1111-4222-8333-444444444444";
  await A.call("open", N10, [["a", "a0"], ["u", "u0"]]);
  await A.call("kick", N10);
  await settle();
  await B.call("kick", N10, true);
  await settle();
  await B.call("open", N10);
  await B.call("setDebt", "docCount", 0);
  await B.call("edit", N10, [["a", "B"], ["u", "Bu"]]);
  const bm10 = await B.call("record", N10);
  await sleep(20);
  await A.call("edit", N10, [["a", "C"], ["u", "u0"]]);
  await settle();
  await settle();
  const b10 = await B.call("record", N10);
  await B.call("close", N10);
  await B.call("open", N10);
  const b10r = await B.call("record", N10);
  await B.call("resetDebt");
  const want10 = J([["a", "B"], ["u", "Bu"]]);
  check(bm10.mark === true && b10.codes === want10 && b10.mark === true && b10r.codes === want10, "10: a marked value meets a later remote change of the same cell: kept whole, still marked, and after a reload: " + J({ marked: bm10.mark, after: b10.codes, mark: b10.mark, reloaded: b10r.codes }));

  progress("case 11");
  // 11. CORR-2C3-3 (astra): an ack over the wire resumes a writer's history paused for want of room: the next save is a
  // version again (unmarked, sent), with no reload; by a plain ack, and by `order` with next_cseq
  for (const [k, how] of [["bbbbbbbb", "ack"], ["dddddddd", "order"]]) {
    const id = `${k}-1111-4222-8333-444444444444`;
    await A.call("open", id, [["a", "x0"]]);
    await A.call("kick", id);
    await settle();
    await A.call("disconnect");
    await A.call("edit", id, [["a", "x1"]]);
    const d = (await A.call("journal", id)).slot.debt.count;
    await A.call("setDebt", "docCount", d);
    await A.call("edit", id, [["a", "x2"]]);
    const m = await A.call("record", id);
    await A.call("resetDebt");
    if (how === "order") ref.controls.fake("batch", { error: { code: "order", detail: { client: (await A.call("journal", id)).slot.client, next_cseq: (await A.call("journal", id)).slot.cseq } } });
    await A.call("connect", "A", ACCOUNT);
    await settle();
    await A.call("edit", id, [["a", "x3"]]);
    await settle();
    const [r, j] = [await A.call("record", id), await A.call("journal", id)];
    check(m.mark === true && r.mark === null && r.codes === J([["a", "x3"]]) && j.lrows === 0, `11: the writer paused for want of room, then an ${how} over the wire: its next save a version again, sent, unmarked: ` + J({ paused: m.mark, mark: r.mark, codes: r.codes, lrows: j.lrows }));
  }

  progress("case 12");
  // 12. CORR-2C3-5 (astra): the notebook page itself (notebook.js) on B: A's change reaches it with nothing typed here:
  // shown, and saved (the record, its j and hash agree with what's shown); then a change from A while B types another
  // cell: both kept, saved
  const N12 = "cccccccc-1111-4222-8333-444444444444";
  await A.call("open", N12, [["a", "p0"], ["b", "q0"]]);
  await A.call("kick", N12);
  await settle();
  await B.call("kick", N12, true);
  await settle();
  const shown12 = await B.call("mount", N12);
  await A.call("edit", N12, [["a", "p1"], ["b", "q0"]]);
  await settle();
  await sleep(900);
  await settle();
  const [bs12, br12] = [await B.call("shown"), await B.call("record", N12)];
  check(shown12 === J([["a", "p0"], ["b", "q0"]]) && bs12 === J([["a", "p1"], ["b", "q0"]]) && br12.codes === bs12 && br12.hashOk && br12.mark === null, "12: the page shows a remote change and saves it (record, j and hash agree): " + J({ shown: bs12, record: br12.codes, hashOk: br12.hashOk, mark: br12.mark }));
  await A.call("edit", N12, [["a", "p2"], ["b", "q0"]]);
  await B.call("type", "b", "q-typed");
  await settle();
  await sleep(900);
  await settle();
  const [bs12b, br12b] = [await B.call("shown"), await B.call("record", N12)];
  check(bs12b === J([["a", "p2"], ["b", "q-typed"]]) && br12b.codes === bs12b && br12b.hashOk, "12: a remote change while this page types another cell: both kept, saved: " + J({ shown: bs12b, record: br12b.codes, hashOk: br12b.hashOk }));

  progress("case 13");
  // 13. (astra's DEVSW-1) One device, two pages of one browser context (one IndexedDB, one set of Web Locks and
  // channels): a board page whose DocSync (followDocSync) is on this harness's minimal socket, and the notebook page,
  // a follower, that turns the switch on.  The board's page carries the notebook: what the notebook page saves reaches
  // B (no kick of its own: the switch's DOC_SYNC.saved, on the channel), B's edit reaches the notebook page, the board
  // never closed; then the board page closes and the harness connects the notebook page's DocSync.  The transport
  // only: the real owners, their sender lock and the automatic takeover are case 14 (astra's DEVSW-1-R2)
  const { browserContextId: cctx } = await send("Target.createBrowserContext");
  async function pageIn(label, ctx = cctx) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId: ctx });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Runtime.enable", {}, sessionId);
    await send("Page.navigate", { url: `http://127.0.0.1:${front.port}/` }, sessionId);
    const ev = async (expression) => {
      const r = await Promise.race([send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId), sleep(45_000).then(() => ({ error: `timed out: ${expression.slice(0, 80)}` }))]);
      if (r?.exceptionDetails || r?.error) throw new Error(`${label}: ` + J(r.exceptionDetails ?? r.error).slice(0, 600));
      return r.result?.value;
    };
    for (let i = 0; i < 200 && !(await ev("window.ready === true").catch(() => false)); i++) await sleep(50);
    return { targetId, ev, call: (f, ...args) => { progress(`${label}.${f}`); return ev(`T.${f}(${args.map((a) => J(a)).join(", ")})`); } };
  }
  // (a failed check ends the case right after it is recorded (the rest depends on it), and a throw is recorded as this
  // case's failed check: the run goes on and prints every verdict (#266 r6b's run: R-14d and B-1o made case 13's
  // C1.connect throw after its failed check, and the run ended with no verdict)
  const STOP13 = Symbol("stop");
  const need13 = (ok, what) => { check(ok, what); if (!ok) throw STOP13; };
  const case13 = async () => {
    const C1 = await pageIn("C1"), C2 = await pageIn("C2");
    const act13 = await C1.call("openWs", "C"), f13 = await C1.call("follow");
    need13(act13 === false && f13 === 0, "13: a board page on a device whose journal isn't active yet: no DocSync of its own: " + J({ act13, f13 }));
    await C2.call("openWs", "C");
    const N13 = "13131313-2222-4333-8444-555555555555";
    const en13 = await C2.call("enable", N13, [["a", "c0"], ["b", "d0"]]);
    need13(en13.out === "on" && en13.on === true && en13.saved === "function" && en13.synced && en13.writer && J(en13.ro) === J([true, false]), "13: the notebook page's switch: on, DOC_SYNC on with its save hook, the notebook reopened as its synced writer, read-only only meanwhile: " + J(en13));
    let joined13 = 0;
    for (let i = 0; i < 100 && !(joined13 = await C1.call("followedCount")); i++) await sleep(50);
    need13(joined13 === 1, "13: the board page, told the switch is on, hands one DocSync to its own connection: " + joined13);
    await C1.call("connect", "C", ACCOUNT);
    const settle13 = async () => { for (let i = 0; i < 3; i++) await Promise.all([C1.call("idle"), C2.call("idle"), B.call("idle")]); };
    await settle13();
    await B.call("kick", N13, true);
    await settle13();
    const bo13 = await B.call("open", N13);
    need13(bo13.codes === J([["a", "c0"], ["b", "d0"]]), "13: the notebook made in the notebook page reaches B through the board page's connection: " + J(bo13));
    need13((await C2.call("editOnly", N13, [["a", "c1"], ["b", "d0"]])) === true, "13: the notebook page (a follower) saves an edit");
    await settle13();
    const br13 = await B.call("record", N13);
    need13(br13.codes === J([["a", "c1"], ["b", "d0"]]), "13: …it reaches B, the board page still open and holding: " + br13.codes);
    await B.call("edit", N13, [["a", "c1"], ["b", "d2"]]);
    await settle13();
    await sleep(300);
    await settle13();
    const cr13 = await C2.call("record", N13);
    need13(cr13.codes === J([["a", "c1"], ["b", "d2"]]) && cr13.mark === null, "13: B's edit arrives in the notebook page through the board page's connection: " + J(cr13));
    const w13 = [...(await C1.call("warnings")), ...(await C2.call("warnings"))];
    need13(w13.length === 0, "13: no warnings on either page: " + J(w13).slice(0, 300));
    await send("Target.closeTarget", { targetId: C1.targetId });
    await sleep(300);
    need13((await C2.call("editOnly", N13, [["a", "c3"], ["b", "d2"]])) === true, "13: the board page closed: the notebook page saves with no page holding the connection");
    await C2.call("connect", "C", ACCOUNT);
    for (let i = 0; i < 3; i++) await Promise.all([C2.call("idle"), B.call("idle")]);
    const br13b = await B.call("record", N13);
    need13(br13b.codes === J([["a", "c3"], ["b", "d2"]]), "13: …then its own connection (the holder now) sends what was saved meanwhile: " + br13b.codes);
  };
  // (the outcome tagged, never tested for truthiness: a throw of false, 0 or "" is recorded too (astra's DEVSW-R6C-1);
  // STOP13, already recorded as its failed check, is not counted again)
  const r13 = await case13().then(() => ({ ok: true }), (e) => ({ ok: false, e }));
  if (!r13.ok && r13.e !== STOP13) check(false, "13: the case stopped: " + String(r13.e?.message ?? r13.e).slice(0, 300));

  progress("case 14");
  // (the whole case within a budget that ends before the run's deadline: past it, or on a throw, this case records
  // a failed check and the run goes on to print every verdict)
  const budget14 = Math.min(240_000, (Number(process.env.DEADLINE_MS) || 480_000) - (Date.now() - t0) - 30_000);
  const LATECASE = Symbol("late");
  // (a failed check ends the case there (recorded first): the rest depends on it, and a mutant's run stays short)
  const STOP14 = Symbol("stop");
  const need14 = (ok, what) => { check(ok, what); if (!ok) throw STOP14; };
  const case14 = async () => {
    // 14. (astra's DEVSW-1-R2, r5) The real owners: one device (D), two pages of one browser context, each with its own
    // SyncOwner and SyncClient on the namespace's sender lock, against this reference server (device D's session, through
    // the front).  The board page's owner already holds (sync turned on with the Sync panel's button, the journal active
    // from an earlier load) and carries notebooks (followDocSync); the notebook page's owner waits while the switch turns
    // on there (enableDocSync).  B (the minimal socket) gets the notebook and its edits, and B's edits reach the notebook
    // page, all through the board's connection; then the board page closes (its owner suspended, as pagehide does) and the
    // notebook page's owner takes the lock by itself: both directions again, nothing connected by hand
    const { browserContextId: dctx } = await send("Target.createBrowserContext");
    const D1 = await pageIn("D1", dctx), D2 = await pageIn("D2", dctx);
    // (every await of this case bounded (astra's DEVSW-R6-1): a hung page call ends as this case's failed check, its
    // verdict printed, never as the run's deadline)
    const LATE14 = Symbol("late");
    const bound14 = (p, ms) => {
    p.catch(() => {});
    let timer;
    const late = new Promise((r) => { timer = setTimeout(() => r(LATE14), Math.max(1, ms)); });
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
  };
    const read14 = async (p, what = "no answer in 10 s") => { const v = await bound14(p, 10_000).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) })); return v === LATE14 ? { codes: `(${what})` } : v; };
    const ownerOf = async (P) => { const v = await bound14(P.ev("T.ownerState()"), 10_000); return v === LATE14 ? { late: true } : v; };
    const waitOwner = async (P, ok, ms = 20_000) => { let st; for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (ok((st = await ownerOf(P)))) return st; return st; };
    const N14 = "14141414-2222-4333-8444-555555555555";
    need14((await D1.call("ownerOpen", "D", true)) === true, "14: device D's journal active (an earlier load of the notebook page); the board page's owner started");
    const on14 = await D1.call("turnOn");
    need14(on14.holder === true && on14.state === "synced", "14: sync turned on with the Sync panel's button: the board page's owner holds the sender lock and syncs: " + J(on14));
    await D1.call("boardFollow");
    const b14 = await waitOwner(D1, (st) => st.holder && st.state === "synced" && st.connected >= 1);
    need14(b14.holder && b14.connected >= 1, "14: the board page (followDocSync): its owner's client made again with a DocSync, connected, the holder still: " + J(b14));
    need14((await D2.call("ownerOpen", "D", false)) === true && (await D2.call("clientRunning", 15_000)) === true, "14: the notebook page's owner runs a client");
    const w14 = await ownerOf(D2);
    need14(w14.holder === false && (await ownerOf(D1)).holder === true, "14: …that waits for the lock the board page holds: " + J(w14));
    const en14 = await D2.call("nbEnable", N14, [["a", "d0"]]);
    await sleep(1000);
    const [d1a, d2a] = [await ownerOf(D1), await ownerOf(D2)];
    need14(en14.out === "on" && en14.on && en14.synced && en14.writer && d1a.holder && !d2a.holder && d2a.connected === 0, "14: the notebook page's switch on, its notebook the synced writer; the board still holds, the notebook page's owner still waits, its DocSync never connected: " + J({ en14, d1a, d2a }));
    // (each wait bounded at 45 s, so a failing case prints its own checks well before the run's deadline; the product
    // assertion is unchanged: B's pull is kicked too, but only a notebook the board's DocSync sent can arrive)
    const settle14 = async () => { await Promise.all([D1.call("idle"), D2.call("idle"), B.call("idle")]); };
    const until14 = async (f, ms = 45_000) => {
      for (const end = Date.now() + ms; Date.now() < end; ) {
        // (one settle and one read, raced against what is left of the 45 s: a call that hangs ends the wait)
        const v = await bound14((async () => { await settle14(); return f(); })(), end - Date.now()).catch(() => null);
        if (v === LATE14) return null;
        if (v) return v;
      }
      return null;
    };
    // (#266 r5's case 14 failed here: the board's DocSync connected before this notebook's synced history started (in the
    // switch's reopen, before any save was told), so nothing kicked it until an edit; r6: the notebook page's `on` makes
    // the board's DocSync kick every notebook started.  Asserted before any edit and with no reconnect)
    const got14 = await until14(async () => { await B.call("kick", N14, true); const j = await B.call("journal", N14); return j?.start ? j : null; });
    need14(!!got14?.start, "14: the notebook made in the notebook page reaches B before any edit and with no reconnect, sent on the board page's connection (the notebook page's owner waiting)");
    const bo14 = await read14(B.call("open", N14));
    need14(bo14.codes === J([["a", "d0"]]), "14: …B's record is it: " + J(bo14));
    need14((await D2.call("editOnly", N14, [["a", "d1"]])) === true, "14: the notebook page (its owner waiting) saves an edit");
    const br14 = await until14(async () => { const r = await B.call("record", N14); return r?.codes === J([["a", "d1"]]) ? r : null; }) ?? (await read14(B.call("record", N14)));
    need14(br14?.codes === J([["a", "d1"]]) && (await ownerOf(D1)).holder && !(await ownerOf(D2)).holder, "14: …it reaches B through the board page's connection, the board still holding: " + br14?.codes);
    await B.call("edit", N14, [["a", "d1"], ["b", "e1"]]);
    const dr14 = await until14(async () => { const r = await D2.call("record", N14); return r?.codes === J([["a", "d1"], ["b", "e1"]]) ? r : null; }) ?? (await read14(D2.call("record", N14)));
    need14(dr14?.codes === J([["a", "d1"], ["b", "e1"]]) && dr14.mark === null, "14: B's edit arrives in the notebook page through the board page's connection: " + J(dr14));
    // (another `on` (a notebook page reloaded): the holder kicks every started notebook again: nothing changes, nothing
    // is stopped or sent twice over (a kick runs one flight per notebook, and an acked notebook has nothing unsent))
    need14((await D2.call("postOn")) === true, "14: a second notebook page's `on`");
    await settle14();
    await sleep(500);
    await settle14();
    const [rb14, rd14, st14] = [await read14(B.call("record", N14)), await read14(D2.call("record", N14)), await read14(D1.call("stopped"))];
    need14(rb14.codes === J([["a", "d1"], ["b", "e1"]]) && rd14.codes === rb14.codes && J(st14) === "{}", "14: …is safe: both records unchanged, nothing stopped on the board's DocSync: " + J({ B: rb14.codes, D2: rd14.codes, stopped: st14 }));
    // (the board page closes: its owner suspended for good, its client and lock let go)
    await D1.call("closeOwner");
    const t14 = await waitOwner(D2, (st) => st.holder && st.state === "synced" && st.connected >= 1);
    need14(t14.holder && t14.connected >= 1 && t14.state === "synced", "14: the board page closed: the notebook page's owner takes the lock by itself, and its DocSync is connected: " + J(t14));
    need14((await D2.call("editOnly", N14, [["a", "d3"], ["b", "e1"]])) === true, "14: the notebook page saves an edit");
    const br14b = await until14(async () => { const r = await B.call("record", N14); return r?.codes === J([["a", "d3"], ["b", "e1"]]) ? r : null; }) ?? (await read14(B.call("record", N14)));
    need14(br14b?.codes === J([["a", "d3"], ["b", "e1"]]), "14: …it reaches B on the notebook page's own connection: " + br14b?.codes);
    await B.call("edit", N14, [["a", "d3"], ["b", "e4"]]);
    const dr14b = await until14(async () => { const r = await D2.call("record", N14); return r?.codes === J([["a", "d3"], ["b", "e4"]]) ? r : null; }) ?? (await read14(D2.call("record", N14)));
    need14(dr14b?.codes === J([["a", "d3"], ["b", "e4"]]), "14: …and B's next edit arrives in it: " + dr14b?.codes);
    const w14b = [...(await D1.call("warnings")), ...(await D2.call("warnings"))];
    need14(w14b.length === 0, "14: no warnings on either page: " + J(w14b).slice(0, 300));

  };
  const run14 = case14();
  run14.catch(() => {});
  let timer14;
  // (tagged as case 13's: a throw of any value is recorded, the budget's expiry too, STOP14 not counted again)
  const r14 = await Promise.race([run14.then(() => ({ ok: true }), (e) => ({ ok: false, e })), new Promise((r) => { timer14 = setTimeout(() => r(LATECASE), Math.max(1, budget14)); })]).finally(() => clearTimeout(timer14));
  if (r14 === LATECASE) check(false, `14: the case didn't finish within its ${Math.round(budget14 / 1000)} s budget, at step: ${step}`);
  else if (!r14.ok && r14.e !== STOP14) check(false, "14: the case stopped: " + String(r14.e?.message ?? r14.e).slice(0, 300));
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
