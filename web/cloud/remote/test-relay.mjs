// ci: web-sync.1 order=13
// Tests for the relay (web/remote/relay.ts and its routes in server.ts, step b2a), in Miniflare with the RemoteRelay
// Durable Object bound (SQLite storage), a real D1 with web/share's migrations, sessions from /auth/dev, and runners'
// keys made by WebCrypto here (as `sagebrush remote` makes its own), their legs as Miniflare WebSockets:
//
// - the peer leg: the Worker's challenge and the enrolled key's signature, before any Durable Object; a challenge
//   once; at most 4 outstanding; an unknown or revoked remote; inert without the relay's binding;
// - the page leg: same site, signed in, an allowed account owning a live remote, a channel of its kind; none while
//   the remote isn't connected;
// - the wire (T1.4 §T2, as #774's runner speaks it): page-open {conn, kind, chan, gen}, the generation prefix added
//   and taken off, dropped for a generation with no page, page-close, close {gen}, generations never reused;
// - the control grammar at the relay (R17-CONTROL): only the exact prefix, the one serialization, each op from its
//   own side; ping answered; text only;
// - caps per channel, both ways (1009); one kernel page (the newer replaces the older, 4009, its page-close first);
//   a newer peer replaces the older (4009) and ends its pages (4001); a peer's loss ends its pages (4001);
// - receipts and windows (§5): a receiver that never reads stops its sender at its window (1013, nothing sent);
//   acks free it; unknown, repeated and cross-leg tokens close (1008);
// - revoke: {"relay":"revoked"} and 4403 to both legs, and no leg after it.
//
//   node web/cloud/remote/test-relay.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { migrations } from "../share/migrations.mjs";
import { dispatch } from "../../miniflare-dispatch.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { webcrypto } from "node:crypto";
const { subtle } = webcrypto;

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

const SITE = "https://sagebrush.test";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";
const E = "55555555-5555-4555-8555-555555555555";
const F = "66666666-6666-4666-8666-666666666666";

let failures = 0, count = 0;
function ok(cond, what) {
  count++;
  if (!cond) {
    failures++;
    console.log("FAIL", what);
  }
}
const b64url = (b) => Buffer.from(b).toString("base64url");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8" });
const bindings = { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", REMOTE_CHAL_KEY: "chal-key", REMOTE_ACCOUNTS: `${A}, ${C}, ${D}, ${E}, ${F}` };
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: "remote", modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"], bindings,
    durableObjects: { REMOTE_RELAY: { className: "TestRemoteRelay", useSQLite: true }, REMOTE_ACCOUNT: { className: "TestRemoteAccount", useSQLite: true } } }],
}));
const db = await mf.getD1Database("SHARE_DB");
for (const { path: m } of migrations())
  for (const s of readFileSync(m, "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();

const site = (path, init = {}) => dispatch(mf, SITE + path, { redirect: "manual", ...init });
const post = (path, body, headers = {}) => site(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const json = async (r) => ({ status: r.status, body: await r.json() });
async function session(account_id) {
  const r = await post("/auth/dev", { token: "dev-token", account_id }, { origin: SITE });
  return (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));
}
const form = (path, cookie, fields) =>
  site(path, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: SITE }, body: new URLSearchParams(fields).toString() });
async function key() {
  const k = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const { kty, crv, x, y } = await subtle.exportKey("jwk", k.publicKey);
  return { priv: k.privateKey, jwk: { kty, crv, x, y } };
}
const sign = async (priv, text) => b64url(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, new TextEncoder().encode(text)));

/** A runner enrolled for the account with this session: {rid, k}. */
async function enroll(cookie, name, kind = "runner") {
  const k = await key();
  const d = (await json(await post("/api/remote/v1/device", { pub: k.jwk, kind, name }))).body;
  await form("/remote/activate", cookie, { code: d.user_code, decision: "approve" });
  await db.prepare("UPDATE remote_devices SET last_poll = NULL WHERE user_code = ?1").bind(d.user_code.replace("-", "")).run();
  const p = (await json(await post("/api/remote/v1/device/poll", { device_code: d.device_code }))).body;
  return { rid: p.remote_id, k };
}

/** A leg: its messages in order, and its close. */
function leg(ws) {
  const L = { ws, got: [], waiters: [], closed: null };
  ws.accept();
  const wake = () => { for (const w of L.waiters.splice(0)) w(); };
  ws.addEventListener("message", (e) => { L.got.push(typeof e.data === "string" ? e.data : "<binary>"); wake(); });
  ws.addEventListener("close", (e) => { L.closed = e.code; wake(); });
  L.send = (t) => ws.send(t);
  L.next = async (ms = 5000) => {
    const end = Date.now() + ms;
    while (!L.got.length) {
      if (L.closed !== null || Date.now() > end) return null;
      await new Promise((r) => { L.waiters.push(r); setTimeout(r, 50); });
    }
    return L.got.shift();
  };
  L.data = async (ms = 5000) => {
    for (;;) {
      const t = await L.next(ms);
      if (t === null || !t.startsWith('{"relay":"')) return t;
    }
  };
  L.closedWith = async (ms = 5000) => {
    const end = Date.now() + ms;
    while (L.closed === null && Date.now() < end) await new Promise((r) => { L.waiters.push(r); setTimeout(r, 50); });
    return L.closed;
  };
  L.close = () => { try { ws.close(1000, "bye"); } catch {} };
  return L;
}

/** A runner's leg: a fresh challenge, signed (or as given), the upgrade. {status, leg?, c, sig} */
async function dialPeer(r, over = {}) {
  const c = over.c ?? (await json(await post("/api/remote/v1/challenge", { remote_id: r.rid }))).body.challenge;
  const sig = over.sig ?? (await sign(r.k.priv, "sb-remote-chal/1\n" + c));
  const res = await site("/api/remote/v1/runner", { headers: { upgrade: "websocket", "x-sb-remote-challenge": c, "x-sb-remote-signature": sig, ...(over.headers ?? {}) } });
  return { status: res.status, leg: res.webSocket ? leg(res.webSocket) : null, c, sig };
}
async function dialPage(cookie, rid, chan = "kernel", headers = {}) {
  const res = await site(`/api/remote/v1/page?remote=${rid}&chan=${chan}`, { headers: { upgrade: "websocket", cookie, origin: SITE, ...headers } });
  return { status: res.status, leg: res.webSocket ? leg(res.webSocket) : null };
}
const J = (t) => (t === null ? null : JSON.parse(t));
// (big page->peer messages one at a time, each sent once the one before it has reached the peer: a leg may have only one
// message waiting for the account's lease (b2b §5: a second meanwhile closes it 1013, pinned on its own with the answer
// held), so a test about something else never depends on the account's answer beating the next message)
// (an observed condition, polled until it holds (or a bound): a schedule step, never a fixed sleep)
async function until(f, tries = 250) {
  for (let i = 0; i < tries; i++) {
    if (await f()) return true;
    await sleep(20);
  }
  return false;
}
async function sendInTurn(page, peer, sizes) {
  const big = () => peer.got.filter((t) => t.length > 1000000).length;
  for (const n of sizes) {
    const before = big();
    page.send("x".repeat(n));
    for (let i = 0; i < 400 && big() === before; i++) await sleep(50);
  }
  return big();
}
// (Miniflare 5.20260930.0-alpha / workerd 1.20260930.2 doesn't deliver to the client a close the Durable Object made for
// one hibernatable socket from another socket's event or from fetch (reproduced alone: a leg closing itself is
// delivered). So for those closes the code is checked when it arrives, and the close is always checked by its effect
// at the relay; the client-visible codes are checked on the platform at b4.)
const closedOr = async (L, code) => { const c = await L.closedWith(1500); return c === code || c === null; };

const sa = await session(A), sb = await session(B), sc = await session(C);

// ---- the peer leg: authentication before any Durable Object
const r1 = await enroll(sa, "box-1");
let x = await dialPeer(r1, { headers: { "x-test-unbound": "relay" } });
ok(x.status === 404 && !x.leg, `peer: inert without the relay's binding (${x.status})`);
x = await dialPeer(r1, { sig: "A".repeat(86) });
ok(x.status === 403 && !x.leg, `peer: a bad signature -> 403 (${x.status})`);
const other = await key();
x = await dialPeer(r1, { sig: undefined, c: undefined });
const p1 = x.leg;
ok(x.status === 101 && p1, `peer: the enrolled key's signature -> 101 (${x.status})`);
const again = await dialPeer(r1, { c: x.c, sig: x.sig });
ok(again.status === 403 && !again.leg, `peer: the same challenge again -> 403, once only (${again.status})`);
x = await dialPeer(r1, { c: x.c, sig: await sign(other.priv, "sb-remote-chal/1\n" + x.c) });
ok(x.status === 403, `peer: another key's signature -> 403 (${x.status})`);
{
  // (an agent's key, validly signed, on the runner's route: its challenge names its kind, refused (403))
  const ag = await enroll(sa, "an-agent", "agent");
  const d = await dialPeer(ag);
  ok(d.status === 403 && !d.leg, `peer: an agent's key on the runner route -> 403 (${d.status})`);
}
x = await site("/api/remote/v1/runner", { headers: { "x-sb-remote-challenge": "x", "x-sb-remote-signature": "y" } });
ok(x.status === 426, `peer: not an upgrade -> 426 (${x.status})`);

// ---- the page leg: who may open one
let pg = await dialPage(sa, r1.rid, "kernel", { origin: "https://evil.test" });
ok(pg.status === 403 && !pg.leg, `page: another site -> 403 (${pg.status})`);
pg = await dialPage("", r1.rid);
ok(pg.status === 401, `page: signed out -> 401 (${pg.status})`);
pg = await dialPage(sb, r1.rid);
ok(pg.status === 403, `page: an account not allowed -> 403 (${pg.status})`);
pg = await dialPage(sc, r1.rid);
ok(pg.status === 404, `page: another account's remote -> 404 (${pg.status})`);
// (a runner serves kernel, terminal and, with --serve-agents, agent pages: every channel in its row of the caps table)
pg = await dialPage(sa, r1.rid, "nope");
ok(pg.status === 400, `page: a channel not in the runner's row -> 400 (${pg.status})`);
pg = await dialPage(sa, "r" + "Z".repeat(20));
ok(pg.status === 404, `page: an unknown remote -> 404 (${pg.status})`);
// (channels are the table's own entries only, never inherited names (astra's B109-CHAN-2, daybreak3's #1): refused
// by the Worker, and by the relay's own lookup, the same function)
for (const chan of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
  pg = await dialPage(sa, r1.rid, chan);
  ok(pg.status === 400 && !pg.leg, `page: chan=${chan} -> 400 (${pg.status})`);
}
{
  const caps = async (kind, chan) => (await json(await post("/__caps", { kind, chan }))).body;
  const k = await caps("runner", "kernel"), t = await caps("runner", "terminal"), g = await caps("agent", "agent"), ra = await caps("runner", "agent");
  ok(JSON.stringify(k.r) === JSON.stringify({ legs: 1, pageToPeer: 2424832, peerToPage: 1048576, window: 8388608 }) && k.w === 8388608
    && t.r.legs === 4 && t.r.window === 1048576 && g.r.window === 16777216 && g.w === 16777216
    // (a runner's agent channel, `sagebrush remote --serve-agents`: one page, 4 MiB less 2 KiB either way, in the runner's 8 MiB window)
    && JSON.stringify(ra.r) === JSON.stringify({ legs: 1, pageToPeer: 4192256, peerToPage: 4192256, window: 8388608 }) && ra.w === 8388608,
    `caps: the table's own entries, exactly (${JSON.stringify([k, t, g, ra])})`);
  let none = true;
  for (const [kind, chan] of [["runner", "constructor"], ["runner", "__proto__"], ["runner", "toString"], ["constructor", "kernel"], ["__proto__", "kernel"], ["agent", "kernel"], ["agent", "terminal"],
    ["constructor", "name"], ["constructor", "prototype"], ["constructor", "length"], ["__proto__", "hasOwnProperty"]])
    none &&= (await caps(kind, chan)).r === null;
  for (const kind of ["constructor", "__proto__", "toString", "page"]) none &&= (await caps(kind, "x")).w === null;
  ok(none, "caps: inherited names and other kinds' channels -> none, in the lookup both layers use");
}
{
  // (grader's A2: the grammar compares a control's keys in order, not as a set.  Both tables' ops have at most one
  // field after `relay`, so there a set and an order agree; a two-field op, given to parseControl here, tells them
  // apart.  And the guard: an op of two or more fields added to either table needs its own reorder case at its side.)
  const { ops } = (await json(await site("/__limits"))).body;
  const widest = Math.max(...[ops.peer, ops.page].flatMap((t) => Object.values(t).map((f) => f.length)));
  ok(widest <= 1 && Object.keys(ops.peer).sort().join() === "ack,close,ping" && Object.keys(ops.page).sort().join() === "ack,ping",
    `control: the op tables, each op one field at most (widest ${widest}; a wider one needs its own reorder case) (${JSON.stringify(ops)})`);
  const two = { two: ["gen", "r"] }, r = "A".repeat(22);
  const control = async (text) => (await json(await post("/__control", { text, ops: two }))).body.r;
  const inOrder = await control(`{"relay":"two","gen":1,"r":"${r}"}`), reordered = await control(`{"relay":"two","r":"${r}","gen":1}`);
  ok(inOrder?.relay === "two" && reordered === null, `control: a two-field op in its table's order -> accepted, its fields swapped -> refused (${JSON.stringify([inOrder, reordered])})`);
}
{
  // (grader's H16: a receiver's outstanding receipts are at most its window over the receipt interval (receiptEvery,
  // or a quarter of the window if less), so the token cap never binds while that is within it, for every receiver:
  // each channel's page window and each kind's peer window.  A limit change past it fails here, not in the field.)
  const { limits, caps, peerWindow } = (await json(await site("/__limits"))).body;
  const windows = [...Object.entries(caps).flatMap(([kind, byChan]) => Object.entries(byChan).map(([chan, c]) => [`${kind}/${chan}`, c.window])),
    ...Object.entries(peerWindow).map(([kind, w]) => [`${kind} peer`, w])];
  const due = windows.map(([what, w]) => [what, Math.floor(w / Math.min(limits.receiptEvery, w / 4))]);
  // (a runner's lease is its largest message rounded up to 4 MiB: its agent channel stays below 4 MiB, so the lease
  // stays exactly 4 MiB for every runner, kernel-only ones included; raising that channel's cap fails here)
  const { leases: lb } = (await json(await site("/__limits"))).body;
  ok(caps.runner.agent && caps.runner.agent.pageToPeer === 4 * 1024 * 1024 - 2048 && lb.runner === 4 * 1024 * 1024,
    `leases: a runner with its agent channel still leases exactly 4 MiB (${JSON.stringify([caps.runner.agent, lb])})`);
  // (the runner reads and refuses by its own literal, AGENT_FRAME in agent_child.py: it must equal this channel's cap
  // both ways, or one side cuts a message the other passed; changing either literal alone fails here)
  const childSrc = readFileSync(join(here, "../../../engine/py/python/sagebrush/remote/agent_child.py"), "utf8");
  const frameExpr = (childSrc.match(/^AGENT_FRAME = ([^#\n]+)/m) || [])[1]?.trim().replace(/\bMiB\b/g, "(1024 * 1024)") ?? "";
  const childFrame = /^[0-9 ()*+-]+$/.test(frameExpr) ? Function(`return (${frameExpr});`)() : NaN;
  ok(/^MiB = 1024 \* 1024$/m.test(childSrc) && childFrame === caps.runner.agent.pageToPeer && childFrame === caps.runner.agent.peerToPage,
    `caps: the runner's AGENT_FRAME (${frameExpr} = ${childFrame}) equals the runner/agent cap both ways (${caps.runner.agent.pageToPeer})`);
  ok(windows.length === 6 && due.every(([, n]) => n >= 1 && n <= limits.tokens),
    `receipts: window / receipt interval <= ${limits.tokens} tokens for every receiver (${JSON.stringify(due)})`);
}

// ---- the wire
pg = await dialPage(sa, r1.rid);
const g1 = pg.leg;
ok(pg.status === 101 && g1, `page: signed in, own remote, connected -> 101 (${pg.status})`);
let m = await p1.next();
const open1 = J(m);
ok(open1 && Object.keys(open1).join() === "relay,conn,kind,chan,gen" && open1.relay === "page-open" && open1.kind === "runner" && open1.chan === "kernel" && open1.gen === 1 && /^[A-Za-z0-9_-]{16}$/.test(open1.conn),
  `wire: page-open {conn, kind, chan, gen}, in that order (${m})`);
g1.send('{"id":"t1","rpc":"g.bind"}');
m = await p1.next();
ok(m === '1\n{"id":"t1","rpc":"g.bind"}', `wire: a page's message reaches the peer with its generation prefix (${JSON.stringify(m)})`);
p1.send('1\n{"id":"t1","status":200}');
m = await g1.next();
ok(m === '{"id":"t1","status":200}', `wire: the peer's message reaches the page without its prefix (${JSON.stringify(m)})`);
p1.send('1\n\n{"a":"1\\n2"}');
m = await g1.next();
ok(m === '\n{"a":"1\\n2"}', "wire: the payload's own bytes after the prefix, untouched");
p1.send('9\n{"x":1}');
m = J(await p1.next());
ok(m && m.relay === "dropped" && m.gen === 9 && m.bytes === 7 && Object.keys(m).join() === "relay,gen,bytes", `wire: a generation with no page -> dropped {gen, bytes} (${JSON.stringify(m)})`);
p1.send('{"relay":"ping"}');
m = await p1.next();
ok(m === '{"relay":"pong"}', `wire: ping answered pong (${m})`);
g1.send('{"relay":"ping"}');
m = await g1.next();
ok(m === '{"relay":"pong"}', `wire: a page's ping answered too (${m})`);

// (one kernel page: a newer one replaces the older (4009); the peer hears page-close for it, then page-open)
pg = await dialPage(sa, r1.rid);
const g2 = pg.leg;
ok(await closedOr(g1, 4009), `wire: a second kernel page replaces the first (4009 when delivered) (${g1.closed})`);
const a1 = J(await p1.next()), a2 = J(await p1.next());
ok(a1?.relay === "page-close" && a1.gen === 1 && a1.conn === open1.conn && a2?.relay === "page-open" && a2.gen === 2 && Object.keys(a1).join() === "relay,conn,gen",
  `wire: page-close {conn, gen} for the older, then page-open for the newer (${JSON.stringify([a1, a2])})`);
p1.send('1\n{"late":1}');
m = J(await p1.next());
ok(m?.relay === "dropped" && m.gen === 1, "wire: a message for the replaced page is dropped, not sent to the newer");

// (close {gen}: the peer ends that page; the relay answers page-close; a terminal page meanwhile is its own)
pg = await dialPage(sa, r1.rid, "terminal");
const t3 = pg.leg;
m = J(await p1.next());
ok(pg.status === 101 && m?.relay === "page-open" && m.chan === "terminal" && m.gen === 3, `wire: a terminal page, its own channel and generation (${JSON.stringify(m)})`);
p1.send('{"relay":"close","gen":3}');
ok(await closedOr(t3, 4000), `wire: close {gen} ends that page (4000 when delivered) (${t3.closed})`);
m = J(await p1.next());
ok(m?.relay === "page-close" && m.gen === 3, "wire: and the peer gets its page-close");
ok(g2.closed === null, "wire: the kernel page is untouched by the terminal's close");
p1.send('3\n{"after":1}');
m = J(await p1.next());
ok(m?.relay === "dropped" && m.gen === 3, `wire: the closed page is gone at the relay (a message for it -> dropped) (${JSON.stringify(m)})`);
t3.send('{"from-closed":1}');
await sleep(150);
ok(!p1.got.some((t) => t.includes("from-closed")), "wire: and nothing the closed page still sends is taken");
p1.send('{"relay":"close","gen":77}');
await sleep(100);
ok(p1.closed === null && g2.closed === null, "wire: close for a generation with no page is ignored");
// (a page's own close: page-close to the peer)
g2.close();
m = J(await p1.next());
ok(m?.relay === "page-close" && m.gen === 2, `wire: a page that leaves -> page-close (${JSON.stringify(m)})`);

// ---- the control grammar at the relay: forged or malformed controls close the sender (1008); the full list through
// the relay's own classifier (the functions its Durable Object calls), a few on real legs
const classify = async (side, text) => (await json(await post("/__classify", { side, text }))).body.r;
for (const bad of [' {"relay":"close","gen":1}', '{"relay" :"close","gen":1}', '{"relay":"close","gen":1,"x":1}', '{"gen":1,"relay":"close"}',
  '{"relay":"close","gen":1.0}', '{"relay":"close","gen":1.5}', '{"relay":"close","gen":0}', '{"relay":"close","gen":9007199254740992}', '{"relay":"pong"}',
  '{"relay":"page-open","conn":"c","kind":"runner","chan":"kernel","gen":5}', '{"relay":"close","gen":1,"relay":"close"}',
  '{"relay":"cl\\u006fse","gen":1}', '{"relay":"ack","r":"short"}', '{"relay":"ack","r":"' + "A".repeat(22) + '","x":1}',
  '01\n{}', '0\n{}', '{"id":"x"}', '1{"id":"x"}', '1 \n{}', '+1\n{}', '9007199254740992\n{}', '18446744073709551616\n{}', '\n{}', '']) {
  ok((await classify("peer", bad)) === null, `grammar: peer ${JSON.stringify(bad)} refused`);
}
for (const good of ['{"relay":"close","gen":1}', '{"relay":"ack","r":"' + "A".repeat(22) + '"}', "1\n{}", "9007199254740991\n", '12\n{"relay":"x"}']) {
  ok((await classify("peer", good)) !== null, `grammar: peer ${JSON.stringify(good)} accepted`);
}
ok((await classify("page", '{"relay":"close","gen":1}')) === null && (await classify("page", '{"relay":"ack","r":"' + "A".repeat(22) + '"}')) !== null,
  "grammar: a page may only ack");
for (const bad of [' {"relay":"close","gen":1}', '{"relay":"pong"}', '01\n{}']) {
  const d = await dialPeer(r1);
  if (!d.leg) { ok(false, `grammar: a leg to try ${JSON.stringify(bad)} (${d.status})`); continue; }
  d.leg.send(bad);
  ok((await d.leg.closedWith()) === 1008, `grammar: peer leg ${JSON.stringify(bad)} -> 1008 (${d.leg.closed})`);
}
const r2 = await enroll(sa, "box-2");
let peer = (await dialPeer(r2)).leg;
for (const bad of ['{"relay":"close","gen":1}', '{"relay":"ack","r":"short"}', '{"relay" :"ping"}x']) {
  const pp = (await dialPage(sa, r2.rid)).leg;
  await peer.next();
  pp.send(bad);
  const code = await pp.closedWith();
  ok(code === 1008 || (bad.startsWith('{"relay" :') && code === null), `grammar: page ${JSON.stringify(bad)} -> 1008 (${code})`);
  while (peer.got.length) peer.got.shift();
}
{
  // (a page's application message that looks like a control is the runner's to refuse: the relay passes it, prefixed)
  const pp = (await dialPage(sa, r2.rid)).leg;
  await peer.next();
  pp.send('{"relay" :"page-close","conn":"c","gen":1}');
  m = await peer.data();
  ok(typeof m === "string" && /^\d+\n\{"relay" :"page-close"/.test(m), `grammar: a page's look-alike is forwarded prefixed, never acted on (${JSON.stringify(m)})`);
  // (binary: 1003)
  pp.ws.send(new Uint8Array([1, 2, 3]));
  ok((await pp.closedWith()) === 1003, "text only: a page's binary message -> 1003");
  await peer.next();
}

// ---- caps per channel (1009)
{
  const pp = (await dialPage(sa, r2.rid)).leg;
  const o = J(await peer.next());
  pp.send("x".repeat(Math.round(2.25 * 1024 * 1024) + 64 * 1024 + 1));
  ok((await pp.closedWith()) === 1009, "caps: a kernel page's message over 2.25 MiB + 64 KiB -> 1009");
  await peer.next();
  const pq = (await dialPage(sa, r2.rid)).leg;
  const oq = J(await peer.next());
  pq.send("y".repeat(Math.round(2.25 * 1024 * 1024) + 64 * 1024));
  m = await peer.data(10000);
  ok(m?.length === String(oq.gen).length + 1 + Math.round(2.25 * 1024 * 1024) + 64 * 1024, "caps: exactly at the cap is forwarded");
  peer.send(`${oq.gen}\n` + "z".repeat(1024 * 1024 + 1));
  const pc = await peer.closedWith();
  ok(pc === 1009, `caps: the runner's message over 1 MiB -> 1009 (${pc})`);
  ok((await pq.closedWith()) === 4001, "a peer's loss ends its pages (4001)");
}

// ---- receipts and windows (§5): a page that never reads stops its sender at 8 MiB (1013), nothing sent past it
const r3 = await enroll(sa, "box-3");
{
  peer = (await dialPeer(r3)).leg;
  const pp = (await dialPage(sa, r3.rid)).leg;
  const o = J(await peer.next());
  const chunk = "w".repeat(1000 * 1000);
  const tokens = [];
  // (8 messages of 1,000,000 bytes: 8,000,000 <= 8 MiB, all forwarded, with receipts after each MiB; the page reads
  // them but acks nothing)
  // (each sent once the one before has arrived: a leg may have only one message waiting for the account's lease (b2b
  // §5), so this test, about windows, never races the account's answer to the kept-ahead lease request)
  let data = 0;
  for (let i = 0; i < 8 && data === i; i++) {
    peer.send(`${o.gen}\n${chunk}`);
    while (data === i) {
      const t = await pp.next(10000);
      if (t === null) break;
      if (t.startsWith('{"relay":"receipt"')) tokens.push(J(t));
      else data++;
    }
  }
  // (a receipt once a MiB has gone since the last: after each second message of 1,000,000 bytes)
  ok(data === 8 && tokens.length >= 3 && tokens.every((t) => Object.keys(t).join() === "relay,r,upto" && /^[A-Za-z0-9_-]{22}$/.test(t.r)),
    `window: 8 MB forwarded, receipts behind the data (${data}, ${tokens.length})`);
  // (each message is charged its bytes and 256 more, so a receipt after each second message: 2 x 1,000,256)
  ok(tokens.slice(0, 3).map((t) => t.upto).join() === "2000512,4001024,6001536", `window: receipts' upto are cumulative charged bytes (${tokens.map((t) => t.upto)})`);
  // (the next 1,000,000 bytes would put 9,000,000 unacknowledged over 8 MiB: the sender closes 1013, nothing sent)
  peer.send(`${o.gen}\n${chunk}`);
  ok((await peer.closedWith()) === 1013, "window: past the receiver's window the sender is closed 1013");
  // (b5: that frame was paid, then refused by the window: recorded once as paid and unsent (B5-PAID-UNSENT-2))
  let pu = 0;
  for (let i = 0; i < 50 && pu !== 1000000; i++) { await sleep(20); pu = (await site(`/__relay/__leases?remote=${r3.rid}`).then((r) => r.json())).paidUnsent; }
  ok(pu === 1000000, `window: the refused frame recorded paid and unsent (${pu})`);
  await sleep(100);
  ok(!pp.got.some((t) => t === chunk), "window: and nothing past it reached the page");
}
{
  // (acks free the window: a page acking its receipts lets the runner keep sending; an unknown, a repeated, or another
  // leg's token closes (1008))
  peer = (await dialPeer(r3)).leg;
  const pp = (await dialPage(sa, r3.rid)).leg;
  const o = J(await peer.next());
  const chunk = "v".repeat(1000 * 1000);
  let acked = 0, got = 0;
  for (let i = 0; i < 20; i++) {
    peer.send(`${o.gen}\n${chunk}`);
    for (;;) {
      const t = await pp.next(10000);
      if (t === null) break;
      if (t.startsWith('{"relay":"receipt"')) {
        pp.send(JSON.stringify({ relay: "ack", r: J(t).r }));
        acked++;
        continue;
      }
      got++;
      break;
    }
  }
  ok(got === 20 && peer.closed === null && acked >= 9, `window: with acks, 20 MB flow through an 8 MiB window (${got}, ${acked})`);
  // (the page's messages to the runner: receipts to the runner, acked by it; the page can't ack the runner's token)
  const big = "u".repeat(2 * 1024 * 1024);
  pp.send(big);
  let rt = null;
  for (;;) {
    const t = await peer.next(10000);
    if (t === null || t.startsWith('{"relay":"receipt"')) { rt = J(t); break; }
  }
  ok(rt && rt.relay === "receipt", "window: the runner gets receipts for the page's bytes");
  pp.send(JSON.stringify({ relay: "ack", r: rt.r }));
  ok((await pp.closedWith()) === 1008, "window: a token issued to the other leg -> 1008");
  const pq = (await dialPage(sa, r3.rid)).leg;
  await peer.next();
  peer.send(JSON.stringify({ relay: "ack", r: rt.r }));
  await sleep(100);
  ok(peer.closed === null, "window: the runner acks its own token");
  peer.send(JSON.stringify({ relay: "ack", r: rt.r }));
  ok((await peer.closedWith()) === 1008, "window: the same token twice -> 1008");
  ok(await closedOr(pq, 4001), `and its pages end (4001 when delivered) (${pq.closed})`);
  pq.send('{"after-peer":1}');
  peer = (await dialPeer(r3)).leg;
  await sleep(150);
  ok(!peer.got.some((t) => t.includes("after-peer")), "and nothing that page still sends reaches the next peer");
  peer.send(JSON.stringify({ relay: "ack", r: "A".repeat(22) }));
  ok((await peer.closedWith()) === 1008, "window: an unknown token -> 1008");
}

// ---- a newer peer replaces the older (4009) and ends its pages (4001); a page needs a connected remote
const r4 = await enroll(sa, "box-4");
{
  pg = await dialPage(sa, r4.rid);
  ok(pg.status === 503 && !pg.leg, `page: the remote not connected -> 503 (${pg.status})`);
  const q1 = (await dialPeer(r4)).leg;
  const pp = (await dialPage(sa, r4.rid)).leg;
  await q1.next();
  const q2 = (await dialPeer(r4)).leg;
  ok(await closedOr(q1, 4009), `peer: a newer leg with the key replaces the older (4009 when delivered) (${q1.closed})`);
  ok(await closedOr(pp, 4001), `peer: and the pages paired with the older end (4001 when delivered) (${pp.closed})`);
  pp.send('{"from-old-page":1}');
  q1.send('1\n{"from-old-peer":1}');
  const pq = (await dialPage(sa, r4.rid)).leg;
  m = J(await q2.next());
  ok(m?.relay === "page-open" && m.gen > 1, `peer: the newer leg gets the next page, a newer generation (${JSON.stringify(m)})`);
  await sleep(150);
  ok(!q1.got.some((t) => t.includes("page-open")) && !q2.got.some((t) => t.includes("from-old-page")) && !pq.got.some((t) => t.includes("from-old-peer")),
    "peer: the replaced leg gets nothing more, and nothing it or its pages still send is taken");
  // ---- revoke: the relay first (the linearization point), then D1; both legs get 4403; none after
  const rv = await post("/api/remote/v1/revoke", { remote_id: r4.rid }, { cookie: sa, origin: SITE });
  ok(rv.status === 200, `revoke: ok (${rv.status})`);
  const last = await q2.next();
  ok(last === '{"relay":"revoked"}', `revoke: the peer is told (${last})`);
  ok((await closedOr(q2, 4403)) && (await closedOr(pq, 4403)), `revoke: both legs closed (4403 when delivered) (${q2.closed}, ${pq.closed})`);
  q2.send('1\n{"after-revoke":1}');
  await sleep(150);
  ok(!pq.got.some((t) => t.includes("after-revoke")), "revoke: nothing the peer still sends after it is forwarded");
  const after = await dialPeer(r4);
  ok(after.status !== 101 && !after.leg, `revoke: no leg after it (${after.status})`);
  const rv2 = await post("/api/remote/v1/revoke", { remote_id: r4.rid }, { cookie: sa, origin: SITE });
  ok(rv2.status === 404, `revoke: twice -> 404 (${rv2.status})`);
  // (another account's revoke reaches neither D1 nor the relay: the remote still connects and serves a page)
  const rv3 = await post("/api/remote/v1/revoke", { remote_id: r2.rid }, { cookie: sc, origin: SITE });
  const still = await dialPeer(r2);
  const sp = still.leg ? await dialPage(sa, r2.rid) : { status: 0 };
  ok(rv3.status === 404 && still.status === 101 && sp.status === 101, `revoke: another account's remote -> 404, and the remote untouched (${rv3.status}, ${still.status}, ${sp.status})`);
}

// ---- every send is charged (astra's B109-BOUND-3, daybreak3's #2): empty messages, dropped answers and the relay's
// own lifecycle controls count against their receiver's window, so a receiver that never acks stops its sender
const rb = await enroll(sc, "c-bounds");
{
  // (Each flood is small: a terminal page's 1 MiB window, or a peer's 8 MiB window first filled to within ~85 KiB by
  // a page's few large messages it never acks; so a few hundred to a few thousand sends cross it, and each wait is
  // for the 1013 itself, not a count.)
  let peer = (await dialPeer(rb)).leg;
  const pp = (await dialPage(sc, rb.rid, "terminal")).leg;
  const o = J(await peer.next());
  // (empty messages to a terminal page that never acks: each charged 256, so the 4,097th can't be sent: 1013)
  const N = 4200;
  let t0 = Date.now();
  for (let i = 0; i < N; i++) peer.send(`${o.gen}\n`);
  ok((await peer.closedWith(20000)) === 1013, `bounds: ${N} empty messages to a terminal page that never acks -> 1013 (${Date.now() - t0} ms)`);
  // (once what was sent has all arrived: the count settles)
  let empties = -1;
  for (let last = -2; empties !== last; await sleep(300)) [last, empties] = [empties, pp.got.filter((t) => t === "").length];
  ok(empties > 1000 && empties <= 1048576 / 256, `bounds: the page got at most its window's worth (${empties} <= ${1048576 / 256})`);
  // (a fresh peer whose window a kernel page fills to within ~85 KiB: 3 x 2,400,000 + 1,100,000 bytes, each charged
  // its bytes + 256, and the receipts behind them; it never acks)
  const filled = async () => {
    const p = (await dialPeer(rb)).leg;
    const q = (await dialPage(sc, rb.rid)).leg;
    await p.next(); // (page-open)
    return { p, q, big: await sendInTurn(q, p, [2400000, 2400000, 2400000, 1100000]) };
  };
  // (dropped answers to that peer: charged against its own window: 1013 within a few hundred)
  let f = await filled();
  peer = f.p;
  t0 = Date.now();
  for (let i = 0; i < 3000; i++) peer.send("999\n");
  ok(f.big === 4 && (await peer.closedWith(20000)) === 1013, `bounds: a flood for no page, its dropped answers never acked -> 1013 (filled with ${f.big}; ${Date.now() - t0} ms)`);
  const drops = peer.got.filter((t) => t.startsWith('{"relay":"dropped"')).length;
  ok(drops > 50 && drops < 400, `bounds: dropped answers stop at the peer's window, what the fill left (${drops})`);
  // (pings answered by the relay itself, each pong charged: a leg that pings without reading its pongs stops (1013))
  f = await filled();
  peer = f.p;
  t0 = Date.now();
  for (let i = 0; i < 3000; i++) peer.send('{"relay":"ping"}');
  ok(f.big === 4 && (await peer.closedWith(20000)) === 1013, `bounds: a ping flood, its pongs never acked -> 1013 (no unaccounted auto-response; ${Date.now() - t0} ms)`);
  const pongs = peer.got.filter((t) => t === '{"relay":"pong"}').length;
  ok(pongs > 50 && pongs <= 98304 / (16 + 256), `bounds: pongs stop at the leg's window, what the fill left (${pongs} <= ${Math.floor(98304 / 272)})`);
  // (the relay's lifecycle controls are charged too: page-open and page-close to the peer)
  peer = (await dialPeer(rb)).leg;
  const st0 = (await json(await site(`/__state?remote=${rb.rid}`))).body.find((a) => a.leg === "peer" && !a.ended);
  for (let i = 0; i < 5; i++) {
    const q = (await dialPage(sc, rb.rid)).leg;
    await peer.next();
    q.close();
    await peer.next();
  }
  const st1 = (await json(await site(`/__state?remote=${rb.rid}`))).body.find((a) => a.leg === "peer" && !a.ended);
  const ctl = peer.got.length;
  ok(st0 && st1 && st1.rx.sent - st0.rx.sent >= 10 * 256 + 10 * 30, `bounds: 5 page-opens and 5 page-closes charged to the peer (${st1?.rx.sent - st0?.rx.sent} bytes)`);
}

// ---- 4 challenges at most outstanding per remote: the 5th connection within their life -> 429
{
  const rc = await enroll(sc, "c-box");
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await dialPeer(rc)).status);
  ok(codes.join() === "101,101,101,101,429", `peer: 4 connections, then 429 while their challenges are unexpired (${codes})`);
}

// ---- an account's purge revokes its remotes in their relays before their rows go (astra's B109-PURGE-1,
// daybreak3's #3): a relay that can't be reached keeps the purge (and the rows) for a retry; a completed purge leaves
// no leg forwarding either way, and an admission authenticated before it but reaching the relay after it is refused
const r5 = await enroll(sa, "box-5");
{
  const peer = (await dialPeer(r5)).leg;
  const pp = (await dialPage(sa, r5.rid)).leg;
  const o = J(await peer.next());
  // (an admission authenticated by the Worker before the purge begins, held there until after it: astra's r2 note)
  const late = dialPeer(r5, { headers: { "x-test-hold-admission": "1" } });
  for (let i = 0; i < 100 && (await json(await site("/__held"))).body.holding !== 1; i++) await sleep(20);
  ok((await json(await site("/__held"))).body.holding === 1, "purge: an admission past the Worker's checks is held before the purge begins");
  const PIDA = "88888888-8888-4888-8888-888888888888";
  ok((await json(await post("/__bindpurge", { account: A, rid: PIDA, kind: "admin" }))).body.r === "accepted", "purge: bound (admin, A)");
  await post("/__scheduled", {}, { "x-test-relay-fail": "1" });
  let st = await db.prepare("SELECT status FROM purges WHERE request_id = ?1").bind(PIDA).first();
  const nA = (await db.prepare("SELECT COUNT(*) AS n FROM remotes WHERE account = ?1").bind(A).first()).n;
  ok(st.status === "running" && nA > 0, `purge: a relay that can't revoke keeps the purge running and the rows there (${st.status}, ${nA})`);
  pp.send('{"before":1}');
  ok((await peer.data()) === `${o.gen}\n{"before":1}`, "purge: (until it completes, the legs still work)");
  await db.prepare("UPDATE purges SET lease = 1 WHERE request_id = ?1").bind(PIDA).run();
  await post("/__scheduled", {});
  st = await db.prepare("SELECT status FROM purges WHERE request_id = ?1").bind(PIDA).first();
  const nA2 = (await db.prepare("SELECT COUNT(*) AS n FROM remotes WHERE account = ?1").bind(A).first()).n;
  ok(st.status === "done" && nA2 === 0, `purge: retried, done, no remote left (${st.status}, ${nA2})`);
  ok(peer.got.includes('{"relay":"revoked"}'), "purge: the peer is told revoked");
  pp.send('{"after-purge-page":1}');
  peer.send(`${o.gen}\n{"after-purge-peer":1}`);
  await sleep(200);
  ok(!peer.got.some((t) => t.includes("after-purge-page")) && !pp.got.some((t) => t.includes("after-purge-peer")), "purge: nothing forwarded either way after it");
  const rel = (await json(await post("/__release", {}))).body.released;
  const l = await late;
  ok(rel === 1 && l.status === 403 && !l.leg, `purge: the one admission authenticated before it, held across it, reaching the relay after it -> 403 (released ${rel}, ${l.status})`);
}
{
  // (a self purge (C deleting its shared data) the same way, its live legs revoked)
  const rs = await enroll(sc, "c-self");
  const peer = (await dialPeer(rs)).leg;
  const pp = (await dialPage(sc, rs.rid)).leg;
  const o = J(await peer.next());
  const PIDC = "99999999-9999-4999-8999-999999999999";
  await post("/__bindpurge", { account: C, rid: PIDC });
  await post("/__scheduled", {});
  const st = await db.prepare("SELECT status FROM purges WHERE request_id = ?1").bind(PIDC).first();
  pp.send('{"after-self":1}');
  await sleep(200);
  ok(st.status === "done" && peer.got.includes('{"relay":"revoked"}') && !peer.got.some((t) => t.includes("after-self")), `purge (self): done, the remote revoked, nothing forwarded (${st.status})`);
}


// ---- b2b: the account's authority (§5): connected slots, byte leases before every forward, the leg's rate, dead legs
// (r1.11).  The relay and the account run on one logical clock (test-entry.ts); alarms run through /__relay/__alarm.
{
  const R = (op, rid, q = "") => site(`/__relay/${op}?remote=${rid}${q}`).then((r) => r.json());
  const A = (op, acct, q = "") => site(`/__account/${op}?account=${acct}${q}`).then((r) => r.json());
  const clockAt = (ms) => R("__clock", "rAAAAAAAAAAAAAAAAAAAA", `&ms=${ms}`);
  const T0 = Date.UTC(2030, 0, 15, 12, 0, 0);
  // (an account enrolls at most 4 runners (#106): each part revokes its remotes once done)
  const done = async (...rs) => { for (const r of rs) await post("/api/remote/v1/revoke", { remote_id: r.rid }, { cookie: sd, origin: SITE }); };
  const sd = await session(D);
  const live = (atts) => atts.filter((x) => !x.ended);
  await clockAt(T0);

  // slots: at most 2 connected per account; a third refused (429, before any leg); a replacement keeps its own slot;
  // a leg's end gives it back
  await A("__cap", D, "&real=1");
  const [s1, s2, s3] = [await enroll(sd, "slot-1"), await enroll(sd, "slot-2"), await enroll(sd, "slot-3")];
  const p1 = await dialPeer(s1), p2 = await dialPeer(s2), p3 = await dialPeer(s3);
  ok(p1.status === 101 && p2.status === 101 && p3.status === 429, `slots: two connect, a third is refused 429 (${p1.status} ${p2.status} ${p3.status})`);
  const p2b = await dialPeer(s2);
  ok(p2b.status === 101, `slots: the same remote's newer connection takes its own slot (${p2b.status})`);
  p1.leg.ws.close(1000, "bye");
  let p3b = { status: 0 };
  for (let i = 0; i < 50 && p3b.status !== 101; i++) {
    await sleep(100);
    p3b = await dialPeer(s3);
  }
  ok(p3b.status === 101, `slots: a peer's end gives its slot back: the third then connects (${p3b.status})`);
  let st = await A("__state", D);
  ok(st.slots.length === 2 && st.slots.some((x) => x.remote_id === s3.rid), `slots: the account holds exactly two (${JSON.stringify(st.slots.map((x) => x.remote_id.slice(0, 6)))})`);
  await A("__cap", D, "&real=0");
  await done(s1, s2, s3);

  // leases: one reserved as the peer connects; each forward consumes its bytes (written before the send)
  const l1 = await enroll(sd, "lease-1");
  let peer = (await dialPeer(l1)).leg;
  let pg = (await dialPage(sd, l1.rid)).leg;
  let o = J(await peer.next());
  let lz = await R("__leases", l1.rid);
  for (let i = 0; i < 40 && !lz.leases.length; i++) { await sleep(50); lz = await R("__leases", l1.rid); }
  ok(lz.leases.length === 1 && lz.leases[0].granted === 4 * 1024 * 1024 && lz.leases[0].consumed === 0, `leases: one reserved as the peer connects (${JSON.stringify(lz.leases)})`);
  pg.send("x".repeat(1000));
  const got = await peer.next();
  lz = await R("__leases", l1.rid);
  ok(got === `${o.gen}\n` + "x".repeat(1000) && lz.leases[0].consumed === 1000 + `${o.gen}\n`.length, `leases: a forward consumes its bytes (${lz.leases[0]?.consumed})`);
  peer.send(`${o.gen}\nyy`);
  await pg.next();
  lz = await R("__leases", l1.rid);
  ok(lz.leases[0].consumed === 1000 + `${o.gen}\n`.length + 2, "leases: both directions count, the payload's bytes");
  {
    // (a runner's agent page: a message of exactly the channel's cap reaches the peer and is paid; one byte more is
    // refused (1009) before anything is paid, and the leg and the peer are kept)
    const ka = await enroll(sd, "agent-cap");
    const pa = (await dialPeer(ka)).leg;
    const ga = (await dialPage(sd, ka.rid, "agent")).leg;
    const oa = J(await pa.next());
    const capA = 4 * 1024 * 1024 - 2048;
    await until(async () => (await R("__leases", ka.rid)).leases.length === 1);
    const c0 = (await R("__consumed", ka.rid)).consumed;
    ga.send("a".repeat(capA));
    const gotA = await pa.next();
    const c1 = (await R("__consumed", ka.rid)).consumed;
    ok(oa.chan === "agent" && gotA === `${oa.gen}\n` + "a".repeat(capA) && c1 - c0 === capA + `${oa.gen}\n`.length,
      `agent page: a message of exactly the cap (${capA} bytes) delivered and paid (${c1 - c0})`);
    ga.send("b".repeat(capA + 1));
    const closedA = await ga.closedWith(20000);
    const c2 = (await R("__consumed", ka.rid)).consumed;
    ok(closedA === 1009 && c2 === c1 && pa.closed === null, `agent page: one byte over the cap -> 1009, nothing paid, the peer kept (${closedA}, ${c2 - c1})`);
    await done(ka);
  }

  // midnight: yesterday's lease is void (settled with the account, never spent); today's is reserved first
  await clockAt(Date.UTC(2030, 0, 16, 0, 0, 1));
  pg.send("after midnight");
  const am = await peer.next();
  lz = await R("__leases", l1.rid);
  st = await A("__state", D);
  ok(am === `${o.gen}\nafter midnight` && lz.leases.length >= 1 && lz.leases.every((l) => l.day === "2030-01-16") && lz.leases[0].consumed === `${o.gen}\nafter midnight`.length,
    `leases: after midnight, a new day's lease pays (${JSON.stringify(lz.leases.map((l) => l.day))})`);
  ok(st.leases.some((l) => l.day === "2030-01-15" && l.settled === 1), "leases: yesterday's was settled with the account");
  await clockAt(T0);
  await done(l1);

  // the day's budget used up: the message is refused (4429 to its sender), nothing reaches the other side
  const b1 = await enroll(sd, "budget-1");
  await A("__budget", D, `&granted=${2 * 1024 * 1024 * 1024}`);
  const bp = await dialPeer(b1);
  peer = bp.leg;
  pg = (await dialPage(sd, b1.rid)).leg;
  await peer.next(); // (page-open)
  pg.send("over budget");
  pg.send("also over budget"); // (queued behind it: dropped with the queue, never forwarded)
  const bc = await pg.closedWith(3000);
  await sleep(200);
  const bst = (await json(await site(`/__state?remote=${b1.rid}`))).body.find((x) => x.leg === "page");
  // (closed from its own event after an await: delivered here (4429) or, as Miniflare may not, seen at the relay)
  ok((bc === 4429 || (bc === null && bst?.ended)) && !peer.got.some((t) => t.endsWith("\nover budget") || t.endsWith("\nalso over budget")) && (await R("__waiting", b1.rid)).queues === 0,
    `budget: used up, the sender is closed 4429 and nothing is forwarded (${bc}, ended ${bst?.ended})`);
  await A("__budget", D, "&granted=0");
  await done(b1);

  // (b5) messages waiting for a lease queue in order: two sent while the answer is held both wait, then both arrive, in order
  const w1 = await enroll(sd, "wait-1");
  await A("__hold", D, "&on=1");
  peer = (await dialPeer(w1)).leg;
  pg = (await dialPage(sd, w1.rid)).leg;
  await peer.next();
  pg.send("first");
  pg.send("second");
  const wq = await until(async () => (await R("__waiting", w1.rid)).frames === 2);
  await A("__hold", D, "&on=0");
  const wd = await until(() => peer.got.filter((t) => !t.startsWith('{"relay":')).length === 2);
  const wgot = peer.got.filter((t) => !t.startsWith('{"relay":'));
  ok(wq && wd && wgot[0].endsWith("\nfirst") && wgot[1].endsWith("\nsecond") && pg.closed === null, `waiting (b5): two queued while the answer is held, then both sent in order (${JSON.stringify(wgot)})`);
  await done(w1);

  // a revoke while a message waits for its lease: never sent
  const v1 = await enroll(sd, "revoke-wait");
  await A("__hold", D, "&on=1");
  peer = (await dialPeer(v1)).leg;
  pg = (await dialPage(sd, v1.rid)).leg;
  await peer.next();
  pg.send("never");
  await sleep(100);
  const rvw = await post("/api/remote/v1/revoke", { remote_id: v1.rid }, { cookie: sd, origin: SITE });
  await A("__hold", D, "&on=0");
  await sleep(300);
  ok(rvw.status === 200 && !peer.got.includes(`${2}\nnever`) && !peer.got.some((t) => t.endsWith("\nnever")), "revoke during the lease's await: the message is never sent");

  // the rate: 200 at once, the 201st closes the leg 4008; refilled at 50/s
  const q1 = await enroll(sd, "rate-1");
  await R("__rate", q1.rid, "&real=1");
  peer = (await dialPeer(q1)).leg;
  for (let i = 0; i < 200; i++) peer.send('{"relay":"ping"}');
  let pongs = 0;
  for (let i = 0; i < 200; i++) if ((await peer.next(2000)) === '{"relay":"pong"}') pongs++;
  ok(pongs === 200 && peer.closed === null, `rate: a burst of 200 is answered (${pongs})`);
  peer.send('{"relay":"ping"}');
  ok((await peer.closedWith(3000)) === 4008, "rate: the 201st closes the leg 4008");
  peer = (await dialPeer(q1)).leg;
  for (let i = 0; i < 200; i++) peer.send('{"relay":"ping"}');
  for (let i = 0; i < 200; i++) await peer.next(2000);
  await clockAt(T0 + 1000); // (one second: 50 more)
  for (let i = 0; i < 50; i++) peer.send('{"relay":"ping"}');
  let more = 0;
  for (let i = 0; i < 50; i++) if ((await peer.next(2000)) === '{"relay":"pong"}') more++;
  peer.send('{"relay":"ping"}');
  ok(more === 50 && (await peer.closedWith(3000)) === 4008, `rate: refilled at 50/s, then closed again (${more})`);
  await clockAt(T0);
  await done(q1);

  // dead legs (r1.11): one alarm at the earliest last ping + 40 s while a page is attached; each leg rereads its own
  const d1 = await enroll(sd, "dead-1");
  peer = (await dialPeer(d1)).leg;
  ok((await R("__leases", d1.rid)).alarm === null, "dead legs: no alarm without a page");
  pg = (await dialPage(sd, d1.rid)).leg;
  await peer.next();
  ok((await R("__leases", d1.rid)).alarm === T0 + 40_000, "dead legs: a page attached arms the alarm at the earliest deadline (the accept + 40 s: no ping yet)");
  const legs = async () => (await json(await site(`/__state?remote=${d1.rid}`))).body.filter((x) => !x.ended).map((x) => x.leg).sort().join();
  // (a ping just before the alarm runs: the peer's deadline moves; the page, with none, is closed at 40 s; a stale alarm
  // never closes a leg whose own time is fresh)
  await clockAt(T0 + 39_999);
  await R("__alarm", d1.rid);
  ok((await legs()) === "page,peer", "dead legs: at 39.999 s, nothing is closed");
  peer.send('{"relay":"ping"}');
  await peer.next();
  await clockAt(T0 + 40_000);
  const al = await R("__alarm", d1.rid);
  ok((await legs()) === "peer" && al.alarm === null, `dead legs: at 40 s the page that never pinged is closed; the peer, just pinged, stays; no page, no alarm (${await legs()}, ${al.alarm})`);
  pg = (await dialPage(sd, d1.rid)).leg;
  await peer.next();
  ok((await R("__leases", d1.rid)).alarm === T0 + 39_999 + 40_000, "dead legs: a new page re-arms at the earliest deadline (the peer's last ping + 40 s)");
  pg.send('{"relay":"ping"}');
  await pg.next();
  await clockAt(T0 + 39_999 + 40_000);
  await R("__alarm", d1.rid);
  ok((await legs()) === "", `dead legs: the peer silent 40 s is closed, and its page with it (4001), though the page's own time is fresh (${await legs()})`);
  await done(d1);
  // (a malformed ping refreshes nothing: it closes the leg (1008))
  const m1 = await enroll(sd, "dead-2");
  peer = (await dialPeer(m1)).leg;
  peer.send('{"relay":"ping" }');
  ok((await peer.closedWith(3000)) === 1008, "dead legs: a malformed ping is a violation, never a refresh");
  await clockAt(T0);

  // ---- the b2b mutants' pins
  // (M19) a page gone while the peer's message to it waits for a lease: nothing is sent, and the peer goes on
  const k19 = await enroll(sd, "m19");
  await A("__hold", D, "&on=1");
  peer = (await dialPeer(k19)).leg;
  pg = (await dialPage(sd, k19.rid)).leg;
  o = J(await peer.next());
  // (each step observed: the message waiting for the held answer; the page gone at the relay; then the answer, and
  // the wait settled)
  const st19 = async () => live((await json(await site(`/__state?remote=${k19.rid}`))).body);
  peer.send(`${o.gen}\nto a page about to go`);
  const w19 = await until(async () => { const w = await R("__waiting", k19.rid); return w.waiting === 1 && w.fetching; });
  pg.ws.close(1000, "gone");
  const g19 = await until(async () => !(await st19()).some((x) => x.leg === "page"));
  await A("__hold", D, "&on=0");
  const d19 = await until(async () => { const w = await R("__waiting", k19.rid); return w.waiting === 0 && !w.fetching; });
  ok(w19 && g19 && d19, `M19: the schedule as observed: waiting, the page gone, then settled (${w19} ${g19} ${d19})`);
  const s19 = live((await json(await site(`/__state?remote=${k19.rid}`))).body);
  ok(peer.closed === null && s19.some((x) => x.leg === "peer"), `M19: the page gone while the message waited: not sent, the peer still up (${peer.closed}, ${JSON.stringify(s19.map((x) => x.leg))})`);
  // (and the handler returned cleanly: without the receiver's re-find it would reach a gone page's attachment and throw
  // (grader's r110 M19))
  const t19 = (await R("__thrown", k19.rid)).thrown;
  ok(t19 === 0 && !peer.got.some((t) => t.includes("to a page about to go")), `M19: nothing thrown out of the handler, nothing forwarded (${t19})`);
  await done(k19);
  // (M20) a page's message waiting for a lease while its peer is replaced: the page ends with the old peer, nothing
  // reaches either peer, nothing throws, and the new peer stays
  const k20 = await enroll(sd, "m20");
  await A("__hold", D, "&on=1");
  const old20 = (await dialPeer(k20)).leg;
  pg = (await dialPage(sd, k20.rid)).leg;
  await old20.next();
  const st20 = async () => live((await json(await site(`/__state?remote=${k20.rid}`))).body);
  pg.send("to a peer about to be replaced");
  const w20 = await until(async () => { const w = await R("__waiting", k20.rid); return w.waiting === 1 && w.fetching; });
  const new20 = (await dialPeer(k20)).leg;
  const g20 = await until(async () => { const s = await st20(); return s.filter((x) => x.leg === "peer").length === 1 && !s.some((x) => x.leg === "page"); });
  await A("__hold", D, "&on=0");
  const d20 = await until(async () => { const w = await R("__waiting", k20.rid); return w.waiting === 0 && !w.fetching; });
  ok(w20 && g20 && d20, `M20: the schedule as observed: waiting, the peer replaced and the page ended, then settled (${w20} ${g20} ${d20})`);
  const t20 = (await R("__thrown", k20.rid)).thrown;
  const s20 = live((await json(await site(`/__state?remote=${k20.rid}`))).body);
  ok(t20 === 0 && ![...old20.got, ...new20.got].some((t) => t.endsWith("\nto a peer about to be replaced")) && s20.filter((x) => x.leg === "peer").length === 1 && !s20.some((x) => x.leg === "page"),
    `M20: the peer replaced while a page's message waited: nothing sent to either, nothing thrown, the new peer up, the page gone (${t20}, ${JSON.stringify(s20.map((x) => x.leg))})`);
  await done(k20);
  // (b5: the burst that b2b §5 closed 1013) with the account's answer held, a page's 2.4/2.4/2.4/1.1 MB burst: the
  // first paid from the opening lease and forwarded, the other three queued (admission: prefix + payload + 256 each);
  // once the answer comes, all arrive in order, and exactly their payable bytes are consumed (prefix + payload)
  const kb = await enroll(sd, "burst");
  peer = (await dialPeer(kb)).leg;
  pg = (await dialPage(sd, kb.rid)).leg;
  o = J(await peer.next());
  const lb0 = await until(async () => (await R("__leases", kb.rid)).leases.length === 1);
  const c0 = (await R("__consumed", kb.rid)).consumed;
  await A("__hold", D, "&on=1");
  const sizes = [2400000, 2400000, 2400000, 1100000];
  sizes.forEach((n, i) => pg.send(String.fromCharCode(97 + i).repeat(n)));
  const head = `${o.gen}\n`.length;
  let wb;
  const q3 = await until(async () => { wb = await R("__waiting", kb.rid); return wb.frames === 3 && wb.fetching && peer.got.filter((t) => t.length > 1000000).length === 1; });
  const admitted = sizes.slice(1).reduce((t, n) => t + head + n + 256, 0);
  ok(lb0 && q3 && wb.bytes === admitted && peer.got.filter((t) => t.length > 1000000).length === 1 && pg.closed === null,
    `burst (b5): msg1 sent, three queued, charged prefix + payload + 256 each (${JSON.stringify(wb)} vs ${admitted})`);
  await A("__hold", D, "&on=0");
  const all4 = await until(() => peer.got.filter((t) => t.length > 1000000).length === 4);
  const bigs = peer.got.filter((t) => t.length > 1000000);
  const inOrder = bigs.every((t, i) => t === `${o.gen}\n` + String.fromCharCode(97 + i).repeat(sizes[i]));
  const settled = await until(async () => { const w = await R("__waiting", kb.rid); return w.queues === 0 && w.bytes === 0; });
  const paid = (await R("__consumed", kb.rid)).consumed - c0;
  ok(all4 && inOrder && settled && paid === sizes.reduce((t, n) => t + head + n, 0) && pg.closed === null && (await R("__thrown", kb.rid)).thrown === 0,
    `burst (b5): after the answer, all four in order, the queue empty, exactly their payable bytes consumed (${paid})`);
  await done(kb);

  // ---- b5: the queue's bounds and endings, every schedule observed with the account's answers held (no credit at all:
  // held from before the peer connects, so even the opening lease waits)
  const W = (rid) => R("__waiting", rid);
  const heldPage = async (name, chan = "kernel") => {
    const k = await enroll(sd, name);
    await A("__hold", D, "&on=1");
    const p = (await dialPeer(k)).leg;
    const g = (await dialPage(sd, k.rid, chan)).leg;
    const op = J(await p.next());
    return { k, p, g, gen: op.gen, head: `${op.gen}\n`.length };
  };
  // (exact allowance) a kernel page's frames filling its 8 MiB allowance to the byte are all admitted; one more (even
  // empty) closes it 1013, its queue dropped: nothing of it is ever forwarded
  {
    const h = await heldPage("b5-exact");
    const cost = (n) => h.head + n + 256;
    const three = 3 * cost(2400000);
    const last = 8 * 1024 * 1024 - three - h.head - 256;
    for (let i = 0; i < 3; i++) h.g.send("x".repeat(2400000));
    h.g.send("y".repeat(last));
    let w;
    const full = await until(async () => { w = await W(h.k.rid); return w.frames === 4; });
    ok(full && w.bytes === 8 * 1024 * 1024 && h.g.closed === null, `allowance: filled to the byte (${w.bytes}), all four admitted, still open`);
    h.g.send("");
    const c = await h.g.closedWith(3000);
    const gone = await until(async () => (await W(h.k.rid)).queues === 0);
    await A("__hold", D, "&on=0");
    await until(async () => !(await W(h.k.rid)).fetching);
    ok(c === 1013 && gone && !h.p.got.some((t) => t.length > 100000), `allowance: one frame more (empty) -> 1013, the queue dropped, nothing forwarded (${c})`);
    await done(h.k);
  }
  // (tiny frames) a terminal page's empty frames are charged prefix + 256 each: floor(1 MiB / that) admitted, the next 1013
  {
    const h = await heldPage("b5-tiny", "terminal");
    const per = h.head + 256;
    const N = Math.floor(1024 * 1024 / per);
    for (let i = 0; i < N; i++) h.g.send("");
    let w;
    const all = await until(async () => { w = await W(h.k.rid); return w.frames === N; });
    ok(all && w.bytes === N * per && h.g.closed === null, `tiny frames: ${N} empty frames admitted at ${per} each (${w.frames}, ${w.bytes})`);
    h.g.send("");
    const c = await h.g.closedWith(3000);
    await A("__hold", D, "&on=0");
    await until(async () => !(await W(h.k.rid)).fetching);
    ok(c === 1013 && (await W(h.k.rid)).queues === 0, `tiny frames: the next -> 1013 (${c})`);
    await done(h.k);
  }
  // (the peer: one kind-wide allowance) its frames to two terminal pages share the runner's 8 MiB; the frame that would
  // pass it closes the peer 1013, though neither page's share is near it
  {
    const k = await enroll(sd, "b5-peer");
    await A("__hold", D, "&on=1");
    const p = (await dialPeer(k)).leg;
    const t1 = (await dialPage(sd, k.rid, "terminal")).leg;
    const g1 = J(await p.next()).gen;
    const t2 = (await dialPage(sd, k.rid, "terminal")).leg;
    const g2 = J(await p.next()).gen;
    let total = 0, sent = 0;
    for (;;) {
      const g = sent % 2 ? g2 : g1;
      const text = `${g}\n` + "z".repeat(65536);
      if (total + text.length + 256 > 8 * 1024 * 1024) break;
      p.send(text);
      total += text.length + 256;
      sent++;
    }
    let w;
    const q = await until(async () => { w = await W(k.rid); return w.frames === sent; });
    ok(q && w.bytes === total && w.waiting === 1 && p.closed === null, `peer: ${sent} frames to two pages share one allowance (${w.bytes} of ${8 * 1024 * 1024}), the peer open`);
    p.send(`${g1}\n` + "z".repeat(65536));
    const c = await p.closedWith(3000);
    const gone = await until(async () => (await W(k.rid)).queues === 0);
    await A("__hold", D, "&on=0");
    await until(async () => !(await W(k.rid)).fetching);
    ok(c === 1013 && gone && t1.got.concat(t2.got).every((t) => t.length < 65536), `peer: the frame past the kind-wide allowance -> 1013, the queue dropped, nothing forwarded (${c})`);
    await done(k);
  }
  // (endings while queued) a page closed, the peer replaced, the remote revoked: each drops the queued frames; after the
  // answer nothing stale is forwarded anywhere, nothing throws, and the queues are gone
  for (const how of ["page-close", "replace", "revoke"]) {
    const h = await heldPage(`b5-end-${how}`);
    for (let i = 0; i < 3; i++) h.g.send(`stale ${i}`);
    h.p.send(`${h.gen}\nstale to the page`);
    const q = await until(async () => (await W(h.k.rid)).frames === 4);
    let p2 = null;
    if (how === "page-close") h.g.ws.close(1000, "gone");
    else if (how === "replace") p2 = (await dialPeer(h.k)).leg;
    else await post("/api/remote/v1/revoke", { remote_id: h.k.rid }, { cookie: sd, origin: SITE });
    const dropped = await until(async () => { const w = await W(h.k.rid); return (how === "page-close" ? w.frames === 1 : w.queues === 0); });
    // (and nothing retained by what was dropped, while the answer is still held: no frames, no bytes, no drain waiting
    // (astra's B5-RETAIN-1))
    const wr = await W(h.k.rid);
    ok(wr.detachedFrames === 0 && wr.detachedBytes === 0 && wr.detachedDraining === 0, `ending (${how}): the dropped queue retains nothing before the answer (${JSON.stringify(wr)})`);
    await A("__hold", D, "&on=0");
    const settled = await until(async () => { const w = await W(h.k.rid); return w.queues === 0 && !w.fetching; });
    const stale = [...h.p.got, ...h.g.got, ...(p2?.got ?? [])].filter((t) => t.includes("stale"));
    // (a page closed: only its own frames go; the peer's frame to it then finds no page: not sent either)
    ok(q && dropped && settled && stale.length === 0 && (await R("__thrown", h.k.rid)).thrown === 0, `ending (${how}) while queued: dropped, nothing stale forwarded, nothing thrown (${JSON.stringify(stale)})`);
    if (how !== "revoke") await done(h.k);
  }
  // (repeated replacement and close, all while the answer stays held: each dropped queue retains nothing; only the
  // current legs' queues hold frames (B5-RETAIN-1))
  {
    const k = await enroll(sd, "b5-retain");
    await A("__hold", D, "&on=1");
    let rounds = 0, clean = true, detail = "";
    for (let i = 0; i < 3; i++) {
      const p = (await dialPeer(k)).leg;
      const g = (await dialPage(sd, k.rid)).leg;
      const gen = J(await p.next()).gen;
      for (let j = 0; j < 3; j++) g.send("x".repeat(100000));
      p.send(`${gen}\n` + "y".repeat(100000));
      if (!(await until(async () => (await W(k.rid)).frames === 4))) { clean = false; detail = `round ${i}: not queued`; break; }
      if (i % 2) g.ws.close(1000, "gone"); // (alternately: the page closes, or the next round's peer replaces this one)
      const w = await (async () => { let x; await until(async () => { x = await W(k.rid); return x.detachedFrames === 0 && x.detachedDraining === 0 && (i % 2 ? x.frames <= 1 : true); }); return x; })();
      if (w.detachedFrames || w.detachedBytes || w.detachedDraining) { clean = false; detail = JSON.stringify(w); break; }
      rounds++;
    }
    const last = await W(k.rid);
    await A("__hold", D, "&on=0");
    await until(async () => !(await W(k.rid)).fetching);
    ok(clean && rounds === 3 && last.detachedFrames === 0 && last.detachedBytes === 0 && last.detachedDraining === 0 && (await R("__thrown", k.rid)).thrown === 0,
      `retention: three replacements and closes with the answer held: nothing retained by a dropped queue (${rounds} ${detail} ${JSON.stringify(last)})`);
    await done(k);
  }
  // (B5-CANCEL-PAY-1) cancelled payments: three pages in turn, each with a frame waiting on the held answer, each ended
  // (closed, or replaced by the next): each one's payment ends at once (at most one in flight, one lease waiter); after
  // the answer, the cancelled frames are never charged and make no lease request
  {
    const h = await heldPage("b5-cancel-pay");
    const c0 = (await R("__consumed", h.k.rid)).consumed;
    let g = h.g, worst = { paying: 0, leaseWaiters: 0 }, ended = true;
    for (let i = 0; i < 3; i++) {
      g.send(`cancelled ${i}`);
      await until(async () => { const w = await W(h.k.rid); return w.frames === 1 && w.paying === 1 && w.leaseWaiters === 1; });
      if (i < 2) {
        g = (await dialPage(sd, h.k.rid)).leg; // (the next page replaces this one: the relay ends it)
        await h.p.next();
        await h.p.next();
      } else g.ws.close(1000, "gone");
      ended = ended && (await until(async () => { const w = await W(h.k.rid); worst = { paying: Math.max(worst.paying, w.paying), leaseWaiters: Math.max(worst.leaseWaiters, w.leaseWaiters) }; return w.paying === 0 && w.leaseWaiters === 0 && w.queues === 0; }));
    }
    const calls0 = await A("__calls", D);
    await A("__hold", D, "&on=0");
    await until(async () => !(await W(h.k.rid)).fetching);
    const calls1 = await A("__calls", D);
    const paid = (await R("__consumed", h.k.rid)).consumed - c0;
    ok(ended && worst.paying <= 1 && worst.leaseWaiters <= 1 && paid === 0 && calls1.lease === calls0.lease && !h.p.got.some((t) => t.includes("cancelled ")) && (await R("__thrown", h.k.rid)).thrown === 0,
      `cancelled payments: each ended at once (at most ${worst.paying} in flight, ${worst.leaseWaiters} waiter); after the answer nothing charged (${paid}) and no lease asked for (${calls1.lease - calls0.lease})`);
    await done(h.k);
  }
  // (the payment's own last checks, inside its leased() turn: a leg ended, or a revoke begun, between the credit read
  // and the consumption: nothing charged, nothing sent)
  for (const what of ["drop", "revoke"]) {
    const k = await enroll(sd, `b5-midpay-${what}`);
    const p = (await dialPeer(k)).leg;
    const g = (await dialPage(sd, k.rid)).leg;
    await p.next();
    await until(async () => (await R("__leases", k.rid)).leases.length === 1 && !(await W(k.rid)).fetching);
    const c0 = (await R("__consumed", k.rid)).consumed;
    await R("__midpay", k.rid, `&do=${what}`);
    g.send(`mid-payment ${what}`);
    const gone = await until(async () => (await W(k.rid)).queues === 0 && (await W(k.rid)).paying === 0);
    const paid = (await R("__consumed", k.rid)).consumed - c0;
    ok(gone && paid === 0 && !p.got.some((t) => t.includes("mid-payment")), `a payment stopped by a ${what} between its credit and its consumption: nothing charged (${paid}), nothing sent`);
    await done(k);
  }
  // (B5-CANCEL-LEASED-1, B5-CONSUME-CANCEL-1) one payment's debit write held (/__holdput) while three pages in turn replace
  // the paying one, each with a frame whose payment turn waits behind the held one: WHILE held, at most one turn waits
  // (each dropped page's turn is removed unrun) and, the last page closed too, none; after the write, the held frame (its
  // page ended during its debit) is recorded paid and unsent, the others are never charged, and nothing is forwarded
  {
    const k = await enroll(sd, "b5-held-debit");
    const p = (await dialPeer(k)).leg;
    let g = (await dialPage(sd, k.rid)).leg;
    const gen0 = J(await p.next()).gen;
    await until(async () => (await R("__leases", k.rid)).leases.length === 1 && !(await W(k.rid)).fetching);
    const c0 = (await R("__consumed", k.rid)).consumed;
    const u0 = (await R("__leases", k.rid)).paidUnsent;
    await R("__holdput", k.rid, "&on=1");
    g.send("held 0");
    const held = await until(async () => { const w = await W(k.rid); return w.heldPuts === 1 && w.paying === 1; });
    let worst = 0, each = true;
    for (let i = 1; i <= 3; i++) {
      g = (await dialPage(sd, k.rid)).leg; // (replaces the page before: the relay ends it, dropping its queue and turn)
      await p.next();
      await p.next();
      g.send(`held ${i}`);
      each = each && (await until(async () => { const w = await W(k.rid); worst = Math.max(worst, w.leaseJobs); return w.frames === 1 && w.leaseJobs === 1; }));
    }
    g.ws.close(1000, "gone");
    let w;
    const none = await until(async () => { w = await W(k.rid); return w.leaseJobs === 0 && w.queues === 0 && w.heldPuts === 1; });
    const whileHeld = { ...w };
    await R("__holdput", k.rid, "&on=0");
    const settled = await until(async () => { const x = await W(k.rid); return x.paying === 0 && x.leaseJobs === 0 && x.heldPuts === 0; });
    const n0 = `${gen0}\nheld 0`.length;
    const unsent = await until(async () => (await R("__leases", k.rid)).paidUnsent - u0 === n0);
    const paid = (await R("__consumed", k.rid)).consumed - c0;
    ok(held && each && worst <= 1 && none && settled && unsent && paid === n0 && !p.got.some((t) => /\nheld \d$/.test(t)) && (await R("__thrown", k.rid)).thrown === 0,
      `a held debit: while held at most ${worst} turn waits behind it, then none (${JSON.stringify(whileHeld)}); after it, the held frame recorded paid-unsent (${n0}), nothing else charged (${paid}), nothing sent`);
    await done(k);
  }
  // (B5-PAID-UNSENT-2) the peer's frame paid while its page disappears during the debit (the peer stays): recorded paid
  // and unsent, exactly its bytes; and frames still queued for a page already gone before their debit: never charged
  {
    const k = await enroll(sd, "b5-target-gone");
    const p = (await dialPeer(k)).leg;
    const g = (await dialPage(sd, k.rid)).leg;
    const gen = J(await p.next()).gen;
    await until(async () => (await R("__leases", k.rid)).leases.length === 1 && !(await W(k.rid)).fetching);
    const c0 = (await R("__consumed", k.rid)).consumed, u0 = (await R("__leases", k.rid)).paidUnsent;
    await R("__holdput", k.rid, "&on=1");
    p.send(`${gen}\nto a page that goes`);
    const held = await until(async () => (await W(k.rid)).heldPuts === 1);
    g.ws.close(1000, "gone");
    await until(async () => !live((await json(await site(`/__state?remote=${k.rid}`))).body).some((x) => x.leg === "page"));
    await R("__holdput", k.rid, "&on=0");
    const n = "to a page that goes".length;
    const rec = await until(async () => (await R("__leases", k.rid)).paidUnsent - u0 === n);
    const paid = (await R("__consumed", k.rid)).consumed - c0;
    ok(held && rec && paid === n && p.closed === null && !g.got.some((t) => t.includes("a page that goes")),
      `the receiver gone during the debit, the sender live: paid ${paid}, recorded paid-unsent (${rec}), nothing sent`);
    // (two frames queued for a page, the answer held; the page goes; once the answer comes they are dropped unpaid)
    const g2 = (await dialPage(sd, k.rid)).leg;
    const gen2 = J(await p.next()).gen;
    const k0 = (await R("__consumed", k.rid)).consumed, v0 = (await R("__leases", k.rid)).paidUnsent;
    await A("__hold", D, "&on=1");
    await R("__holdput", k.rid, "&on=1"); // (no credit change while they queue: the leases' writes held too)
    p.send(`${gen2}\nstale one`);
    p.send(`${gen2}\nstale two`);
    await until(async () => (await W(k.rid)).frames >= 1);
    g2.ws.close(1000, "gone");
    await until(async () => !live((await json(await site(`/__state?remote=${k.rid}`))).body).some((x) => x.leg === "page"));
    await R("__holdput", k.rid, "&on=0");
    await A("__hold", D, "&on=0");
    const empty = await until(async () => { const w = await W(k.rid); return w.queues === 0 && w.paying === 0 && !w.fetching; });
    const k1 = (await R("__consumed", k.rid)).consumed, v1 = (await R("__leases", k.rid)).paidUnsent;
    ok(empty && k1 === k0 && v1 === v0 && p.closed === null && !g2.got.some((t) => t.startsWith("stale")),
      `frames queued for a page gone before their debit: never charged (${k1 - k0}), none recorded, the peer stays`);
    await done(k);
  }
  // (the target checked right before the debit too: the peer's frame's page ended between the credit read and the debit
  // (/__midpay?do=page): dropped unpaid, nothing recorded, the peer stays)
  {
    const k = await enroll(sd, "b5-midpay-target");
    const p = (await dialPeer(k)).leg;
    const g = (await dialPage(sd, k.rid)).leg;
    const gen = J(await p.next()).gen;
    await until(async () => (await R("__leases", k.rid)).leases.length === 1 && !(await W(k.rid)).fetching);
    const c0 = (await R("__consumed", k.rid)).consumed, u0 = (await R("__leases", k.rid)).paidUnsent;
    await R("__midpay", k.rid, "&do=page");
    p.send(`${gen}\nits page ends mid-payment`);
    // (a paid-unsent record, were there one, is a leased turn: read once the lease FIFO is idle)
    const done1 = await until(async () => { const w = await W(k.rid); return w.queues === 0 && w.paying === 0 && w.leaseJobs === 0 && !w.leaseBusy; });
    const c1 = (await R("__consumed", k.rid)).consumed, u1 = (await R("__leases", k.rid)).paidUnsent;
    ok(done1 && c1 === c0 && u1 === u0 && p.closed === null && !g.got.some((t) => t.includes("mid-payment")), `the target ended between the credit and the debit: never charged (${c1 - c0}), nothing recorded (${u1 - u0}), the peer stays`);
    await done(k);
  }
  // (B5-SEND-ACCOUNT-1) a paid frame whose send fails locally (/__failsend): recorded paid-unsent once, and nothing of it is
  // the receiver's: its counters and tokens unchanged, no receipt; the next frame goes on from the same counters
  {
    const k = await enroll(sd, "b5-send-fails");
    const p = (await dialPeer(k)).leg;
    const g = (await dialPage(sd, k.rid)).leg;
    const gen = J(await p.next()).gen;
    await until(async () => (await R("__leases", k.rid)).leases.length === 1 && !(await W(k.rid)).fetching);
    const rx = async () => live((await json(await site(`/__state?remote=${k.rid}`))).body).find((x) => x.leg === "page").rx;
    const rx0 = await rx(), u0 = (await R("__leases", k.rid)).paidUnsent;
    await R("__failsend", k.rid, "&on=1");
    p.send(`${gen}\nthis one fails`);
    const rec = await until(async () => (await R("__leases", k.rid)).paidUnsent - u0 === "this one fails".length);
    const rx1 = await rx();
    p.send(`${gen}\nthis one goes`);
    const went = await until(() => g.got.includes("this one goes"));
    const rx2 = await rx();
    ok(rec && JSON.stringify(rx1) === JSON.stringify(rx0) && went && rx2.sent === rx0.sent + "this one goes".length + 256 && !g.got.includes("this one fails") && p.closed === null,
      `a payload's send failing: recorded paid-unsent once, the receiver's counters unchanged (${rx0.sent} -> ${rx1.sent}), the next from them (${rx2.sent})`);
    await done(k);
  }
  // ---- grader's r113 pins (B13, B14, B16, B18)
  const twoLeases = async (k, g, p) => {
    await sendInTurn(g, p, []); // (nothing; then one small frame, so the refill asks for the second lease)
    g.send("warm");
    await until(() => p.got.some((t) => t.endsWith("\nwarm")));
    return until(async () => (await R("__leases", k.rid)).leases.length === 2 && !(await W(k.rid)).fetching);
  };
  // (B13) a frame for a page gone before its turn, the credit short and no lease request out: dropped at its turn's start,
  // asking the account for nothing (and with two leases open, no refill either)
  {
    const k = await enroll(sd, "b13-stale-short");
    const p = (await dialPeer(k)).leg;
    const gq = (await dialPage(sd, k.rid, "terminal")).leg;
    await p.next();
    const gp = (await dialPage(sd, k.rid, "terminal")).leg;
    const genP = J(await p.next()).gen;
    const two = await twoLeases(k, gq, p);
    await R("__holdput", k.rid, "&on=1");
    gq.send("held ahead"); // (its debit held: the peer's frame below waits its turn behind it)
    await until(async () => (await W(k.rid)).heldPuts === 1);
    p.send(`${genP}\nto a page about to go`);
    await until(async () => (await W(k.rid)).leaseJobs === 1);
    gp.ws.close(1000, "gone");
    await until(async () => !live((await json(await site(`/__state?remote=${k.rid}`))).body).some((x) => x.leg === "page" && x.gen === genP));
    await R("__zerocredit", k.rid, "&on=1");
    const calls0 = await A("__calls", D);
    await R("__holdput", k.rid, "&on=0");
    const idle = await until(async () => { const w = await W(k.rid); return w.queues === 0 && w.leaseJobs === 0 && !w.leaseBusy && !w.fetching && w.paying === 0; });
    const calls1 = await A("__calls", D);
    await R("__zerocredit", k.rid, "&on=0");
    ok(two && idle && calls1.lease === calls0.lease && !gp.got.some((t) => t.includes("about to go")), `B13: a frame whose page went before its turn, credit short: no lease asked for (${calls1.lease - calls0.lease})`);
    await done(k);
  }
  // (B14) a skipped frame's allowance is freed: the peer's frame for a gone page skipped, the next one (to a live page)
  // then held at its debit: the queue charges only that one
  {
    const k = await enroll(sd, "b14-skip-frees");
    const p = (await dialPeer(k)).leg;
    const gq = (await dialPage(sd, k.rid, "terminal")).leg;
    const genQ = J(await p.next()).gen;
    const gp = (await dialPage(sd, k.rid, "terminal")).leg;
    const genP = J(await p.next()).gen;
    const two = await twoLeases(k, gq, p);
    await R("__holdput", k.rid, "&on=1");
    gq.send("held ahead");
    await until(async () => (await W(k.rid)).heldPuts === 1);
    const x = `${genP}\n` + "x".repeat(50000), y = `${genQ}\nafter the skip`;
    p.send(x);
    p.send(y);
    await until(async () => (await W(k.rid)).frames >= 2);
    gp.ws.close(1000, "gone");
    await until(async () => !live((await json(await site(`/__state?remote=${k.rid}`))).body).some((z) => z.leg === "page" && z.gen === genP));
    await R("__holdput", k.rid, "&release=leases"); // (the one ahead goes; the next debit (y's) is held in its turn)
    let w;
    const held = await until(async () => { w = await W(k.rid); return w.frames === 1 && w.heldPuts >= 1 && w.leaseBusy; });
    const bytes = w.bytes;
    await R("__holdput", k.rid, "&on=0");
    const went = await until(() => gq.got.includes("after the skip"));
    ok(two && held && bytes === y.length + 256 && went, `B14: the skipped frame's allowance freed: the queue charges only the next (${bytes} = ${y.length + 256})`);
    await done(k);
  }
  // (B16) a revoke begun during a held debit (its own durable write held too, so the sender's queue is still owned): the
  // paid frame recorded paid and unsent, nothing sent
  {
    const k = await enroll(sd, "b16-revoke-held");
    const p = (await dialPeer(k)).leg;
    const g = (await dialPage(sd, k.rid)).leg;
    const gen = J(await p.next()).gen;
    await until(async () => (await R("__leases", k.rid)).leases.length === 1 && !(await W(k.rid)).fetching);
    const u0 = (await R("__leases", k.rid)).paidUnsent;
    await R("__holdput", k.rid, "&on=1&keys=leases,revoked");
    p.send(`${gen}\npaid as the revoke begins`);
    await until(async () => (await W(k.rid)).heldPuts === 1);
    const rv = post("/api/remote/v1/revoke", { remote_id: k.rid }, { cookie: sd, origin: SITE });
    await until(async () => (await W(k.rid)).heldPuts === 2); // (the revoke's write held: revoking, its drops not yet)
    await R("__holdput", k.rid, "&release=leases");
    const n = "paid as the revoke begins".length;
    const rec = await until(async () => (await R("__leases", k.rid)).paidUnsent - u0 === n);
    await R("__holdput", k.rid, "&on=0");
    const r = await rv;
    ok(rec && r.status === 200 && !g.got.some((t) => t.includes("revoke begins")), `B16: a revoke during the held debit: the frame recorded paid-unsent (${n}), nothing sent`);
  }
  // (B18) the day turning during a held debit: the frame paid from yesterday's lease recorded paid and unsent, not sent;
  // the next frame paid today
  {
    const k = await enroll(sd, "b18-midnight");
    const p = (await dialPeer(k)).leg;
    const g = (await dialPage(sd, k.rid)).leg;
    const gen = J(await p.next()).gen;
    await until(async () => (await R("__leases", k.rid)).leases.length === 1 && !(await W(k.rid)).fetching);
    const u0 = (await R("__leases", k.rid)).paidUnsent;
    await R("__holdput", k.rid, "&on=1");
    p.send(`${gen}\npaid yesterday`);
    await until(async () => (await W(k.rid)).heldPuts === 1);
    await clockAt(Date.UTC(2030, 0, 16, 0, 0, 1));
    await R("__holdput", k.rid, "&on=0");
    const n = "paid yesterday".length;
    const rec = await until(async () => (await R("__leases", k.rid)).paidUnsent - u0 === n);
    p.send(`${gen}\npaid today`);
    const today = await until(() => g.got.includes("paid today"));
    const days = (await R("__leases", k.rid)).leases.map((l) => l.day);
    await clockAt(T0);
    ok(rec && today && !g.got.includes("paid yesterday") && days.every((d) => d === "2030-01-16"), `B18: the day turned during the debit: recorded paid-unsent (${n}), not sent; the next paid today (${JSON.stringify(days)})`);
    await done(k);
  }
  // (B5-SETTLE-REFILL-1) a lease spent while the account is slow to hear its settlement: the refill waits for that
  // settlement, so the account never counts it outstanding and never refuses the refill; the frame waiting for it is
  // sent once the settlement lands, never closed 4429 (no lease request while the settlement is held)
  {
    const k = await enroll(sd, "b5-settle");
    const p = (await dialPeer(k)).leg;
    const g = (await dialPage(sd, k.rid)).leg;
    await p.next();
    const big = () => p.got.filter((t) => t.length > 1000000).length;
    await sendInTurn(g, p, [2400000]);
    const two = await until(async () => (await R("__leases", k.rid)).leases.length === 2 && !(await W(k.rid)).fetching);
    await A("__hold", D, "&settle=1");
    const calls0 = await A("__calls", D);
    for (let i = 0; i < 3; i++) g.send("s".repeat(2400000));
    let w;
    const held = await until(async () => { w = await W(k.rid); return big() === 3 && w.frames === 1 && w.fetching; });
    const calls1 = await A("__calls", D);
    // (the peer reads what it got, as a runner does: its latest receipt acked, so the fourth fits its window; and the
    // relay has that ack before the settlement is let go, or the fourth, paid, would find the window still full and
    // close the page 1013: the ack and the lease come on different connections, in either order)
    const last = p.got.filter((t) => t.startsWith('{"relay":"receipt"')).map(J).at(-1);
    p.send(JSON.stringify({ relay: "ack", r: last.r }));
    const acked = await until(async () => (await json(await site(`/__state?remote=${k.rid}`))).body.some((x) => x.leg === "peer" && !x.ended && x.rx.acked === last.upto));
    await A("__hold", D, "&settle=0");
    const sent = await until(() => big() === 4);
    const calls2 = await A("__calls", D);
    ok(two && held && acked && calls1.lease === calls0.lease && sent && g.closed === null && calls2.refused === calls0.refused && calls2.lease > calls0.lease,
      `settle before refill: no lease request while the spent lease's settlement is held; then granted (none refused), and the waiting frame sent (${held} ${acked} ${calls1.lease - calls0.lease} ${calls2.lease - calls0.lease} refused ${calls2.refused - calls0.refused}; ${g.closed})`);
    await done(k);
  }
  // (Q5) a page the relay ends (replaced by a newer kernel page) while its frame waits: dropped at once, so when the
  // answer comes nothing of it reaches the peer, though the page's own close handler may not have run yet
  {
    const h = await heldPage("b5-page-replaced");
    h.g.send("from the replaced page");
    await until(async () => (await W(h.k.rid)).frames === 1);
    await R("__holdclose", h.k.rid, "&on=1"); // (the old page's close handler, if it runs, waits: only endPage can drop)
    const g2 = (await dialPage(sd, h.k.rid)).leg;
    await h.p.next(); // (page-close for the old, then page-open for the new)
    const dropped = await until(async () => { const w = await W(h.k.rid); return w.frames === 0 && w.detachedFrames === 0 && w.detachedDraining === 0; }, 50);
    await A("__hold", D, "&on=0");
    await until(async () => !(await W(h.k.rid)).fetching);
    await sendInTurn(g2, h.p, []); // (nothing; the answer is in: what was going to be sent has been)
    await R("__holdclose", h.k.rid, "&on=0");
    ok(dropped && !h.p.got.some((t) => t.endsWith("\nfrom the replaced page")) && g2.closed === null, "a page replaced while its frame waits: the frame dropped at once, never sent");
    await done(h.k);
  }
  // (Q11) a revoke's durable write landing between a drain's payment and its next check, before the revoke's own drops
  // (forced here by /__revokegate): the drain rereads "revoked" after its awaits and sends nothing
  {
    const k = await enroll(sd, "b5-revoke-gap");
    const p = (await dialPeer(k)).leg;
    const g = (await dialPage(sd, k.rid)).leg;
    await p.next();
    await until(async () => (await R("__leases", k.rid)).leases.length === 1);
    await R("__revokegate", k.rid, "&on=1");
    g.send("paid before the revoke landed");
    const fired = await until(async () => (await R("__revokegatestate", k.rid)).fired);
    const settled = await until(async () => (await W(k.rid)).queues === 0);
    ok(fired && settled && !p.got.some((t) => t.endsWith("\npaid before the revoke landed")) && (await R("__thrown", k.rid)).thrown === 0,
      "a revoke's write between payment and the check: the reread stops the frame, nothing sent");
    await done(k);
  }
  // (controls bypass the queue) a page whose frame waits still pings and is answered at once
  {
    const h = await heldPage("b5-ctl", "terminal");
    h.g.send("waits");
    await until(async () => (await W(h.k.rid)).frames === 1);
    h.g.send('{"relay":"ping"}');
    const pong = await h.g.next(3000);
    ok(pong === '{"relay":"pong"}' && (await W(h.k.rid)).frames === 1, `controls: a ping answered while a frame waits (${pong})`);
    await A("__hold", D, "&on=0");
    await until(async () => h.p.got.some((t) => t.endsWith("\nwaits")));
    await done(h.k);
  }
  // (refill) one lease at accept, never a second on an idle connection; the first message's refill asks for the second
  // (credit under one lease + the largest message); never more than two
  {
    const k = await enroll(sd, "b5-refill");
    const rc0 = await A("__calls", D);
    const p = (await dialPeer(k)).leg;
    const one = await until(async () => { const [l, w] = [await R("__leases", k.rid), await W(k.rid)]; return l.leases.length === 1 && !w.fetching; });
    const acct = async () => (await A("__state", D)).leases.filter((l) => l.remote_id === k.rid).length;
    ok(one && (await acct()) === 1, "refill: one lease at accept, no second on an idle connection");
    const g = (await dialPage(sd, k.rid)).leg;
    await p.next();
    g.send("a small one");
    const two = await until(async () => { const [l, w] = [await R("__leases", k.rid), await W(k.rid)]; return l.leases.length === 2 && !w.fetching; });
    for (let i = 0; i < 3; i++) await sendInTurn(g, p, [2400000]);
    await until(async () => !(await W(k.rid)).fetching);
    const most = (await R("__leases", k.rid)).leases.length;
    const rc1 = await A("__calls", D);
    ok(two && most <= 2 && rc1.refused === rc0.refused, `refill: the first message's refill asks for the second; never more than two, and the account never refuses one (${most}; refused ${rc1.refused - rc0.refused})`);
    await done(k);
  }
  // (M24) a newer peer admitted while an older one waits for its slot: the older is refused (409), the newer stays
  const k24 = await enroll(sd, "m24");
  // (both wait for their slots; the older's request is answered first, so the newer is still waiting, then the newer's:
  // the older resumes overtaken (a newer generation stored), whatever the account answered it)
  const st24 = await A("__state", D);
  await A("__hold", D, "&acquire=1");
  const older = dialPeer(k24);
  await sleep(300);
  const newer = dialPeer(k24);
  await sleep(300);
  void st24;
  await A("__hold", D, "&step=1");
  await sleep(300);
  await A("__hold", D, "&acquire=0");
  const [po, pn] = await Promise.all([older, newer]);
  ok(po.status === 409 && pn.status === 101, `M24: the older admission, overtaken while it waited for its slot, is refused (${po.status}, ${pn.status})`);
  await done(k24);
  // (M26) a relay without the account's binding admits nothing (503)
  const k26 = await enroll(sd, "m26");
  await R("__noacct", k26.rid, "&on=1");
  const p26 = await dialPeer(k26);
  await R("__noacct", k26.rid, "&on=0");
  const p26b = await dialPeer(k26);
  ok(p26.status === 503 && p26b.status === 101, `M26: without accounting, no admission (${p26.status}); with it, admitted (${p26b.status})`);
  await done(k26);
  // (M29) the rate counts application messages too, its bucket kept between them: a page's 201st message at once: 4008
  const k29 = await enroll(sd, "m29");
  await R("__rate", k29.rid, "&real=1");
  peer = (await dialPeer(k29)).leg;
  pg = (await dialPage(sd, k29.rid)).leg;
  await peer.next();
  for (let i = 0; i < 201; i++) pg.send(`m${i}`);
  const c29 = await pg.closedWith(5000);
  await sleep(200);
  const got29 = peer.got.filter((t) => /\nm\d+$/.test(t)).length;
  ok(c29 === 4008 && got29 === 200, `M29: a page's 201st message in its burst closes it 4008; 200 were forwarded (${c29}, ${got29})`);
  await done(k29);
  // (M36) a revoke gives the peer's slot back at once
  await A("__cap", D, "&real=1");
  const [x1, x2, x3] = [await enroll(sd, "m36-1"), await enroll(sd, "m36-2"), await enroll(sd, "m36-3")];
  const y1 = await dialPeer(x1), y2 = await dialPeer(x2), y3 = await dialPeer(x3);
  await post("/api/remote/v1/revoke", { remote_id: x1.rid }, { cookie: sd, origin: SITE });
  const y3b = await dialPeer(x3);
  ok(y1.status === 101 && y2.status === 101 && y3.status === 429 && y3b.status === 101, `M36: a revoke releases the slot: the third then connects (${y3.status} -> ${y3b.status})`);
  await A("__cap", D, "&real=0");
  await done(x2, x3);

  // ---- the #110 review's races (daybreak3's ENGINE-1..4, astra's SLOT-1, LEASE-1, ALARM-1)
  // (ENGINE-1/SLOT-1) a revoke while an admission waits for its slot: the admission is refused (403) and the slot it was
  // granted afterwards goes back: the account holds none for that remote
  const e1 = await enroll(sd, "engine-1");
  await A("__hold", D, "&acquire=1");
  const e1p = dialPeer(e1);
  await sleep(300);
  const e1r = await post("/api/remote/v1/revoke", { remote_id: e1.rid }, { cookie: sd, origin: SITE });
  await A("__hold", D, "&step=1");
  const e1s = (await e1p).status;
  await A("__hold", D, "&acquire=0");
  const e1slots = (await A("__state", D)).slots.filter((x) => x.remote_id === e1.rid);
  ok(e1r.status === 200 && e1s === 403 && e1slots.length === 0, `ENGINE-1: revoked during the slot's await: refused 403, no slot left (${e1r.status} ${e1s} ${JSON.stringify(e1slots)})`);
  // (and an overtaken admission gives back only its own generation: the newer peer's slot stays, at its gen)
  const e1b = await enroll(sd, "engine-1b");
  await A("__hold", D, "&acquire=1");
  const ob = dialPeer(e1b);
  await sleep(300);
  const nb = dialPeer(e1b);
  await sleep(300);
  await A("__hold", D, "&step=1");
  await sleep(300);
  await A("__hold", D, "&acquire=0");
  const [obs, nbs] = [(await ob).status, (await nb).status];
  const e1bslots = (await A("__state", D)).slots.filter((x) => x.remote_id === e1b.rid);
  ok(obs === 409 && nbs === 101 && e1bslots.length === 1 && e1bslots[0].gen === 2, `ENGINE-1: the overtaken admission's slot is released, the newer's held at its own gen (${obs} ${nbs} ${JSON.stringify(e1bslots)})`);
  await done(e1b);
  // (ENGINE-2) a revoke while a lease request is out: the lease granted after it is never installed, and is settled
  const e2 = await enroll(sd, "engine-2");
  await A("__hold", D, "&on=1");
  peer = (await dialPeer(e2)).leg;
  pg = (await dialPage(sd, e2.rid)).leg;
  await peer.next();
  pg.send("never");
  await sleep(100);
  const e2r = await post("/api/remote/v1/revoke", { remote_id: e2.rid }, { cookie: sd, origin: SITE });
  await A("__hold", D, "&on=0");
  let e2acct = [];
  for (let i = 0; i < 40; i++) {
    await sleep(50);
    e2acct = (await A("__state", D)).leases.filter((l) => l.remote_id === e2.rid);
    if (e2acct.length && e2acct.every((l) => l.settled === 1)) break;
  }
  const e2relay = (await R("__leases", e2.rid)).leases;
  ok(e2r.status === 200 && e2relay.length === 0 && e2acct.length === 1 && e2acct[0].settled === 1 && !peer.got.some((t) => t.endsWith("\nnever")),
    `ENGINE-2: the lease granted after the revoke: not installed at the relay, settled at the account, nothing sent (${JSON.stringify(e2relay)} ${JSON.stringify(e2acct)})`);
  // (ENGINE-3/LEASE-1) two legs resuming together from one lease request: every forwarded byte is consumed
  const e3 = await enroll(sd, "engine-3");
  await A("__hold", D, "&on=1");
  peer = (await dialPeer(e3)).leg;
  const ta = (await dialPage(sd, e3.rid, "terminal")).leg;
  const ga = J(await peer.next());
  const tb = (await dialPage(sd, e3.rid, "terminal")).leg;
  const gb = J(await peer.next());
  ta.send("first");
  tb.send("second!");
  await sleep(200);
  await A("__hold", D, "&on=0");
  const fwd = [`${ga.gen}\nfirst`, `${gb.gen}\nsecond!`];
  for (let i = 0; i < 40 && !fwd.every((f) => peer.got.includes(f)); i++) await sleep(50);
  const e3l = (await R("__leases", e3.rid)).leases;
  const e3c = e3l.reduce((s, l) => s + l.consumed, 0);
  ok(fwd.every((f) => peer.got.includes(f)) && e3c === fwd.join("").length, `ENGINE-3: both forwarded, and the leases consumed all ${fwd.join("").length} bytes (${e3c}; ${JSON.stringify(e3l)})`);
  await done(e3);
  // (ENGINE-4/ALARM-1) an alarm firing after the last page left (set before it went) closes nothing
  await clockAt(T0);
  const e4 = await enroll(sd, "engine-4");
  peer = (await dialPeer(e4)).leg;
  pg = (await dialPage(sd, e4.rid)).leg;
  await peer.next();
  pg.ws.close(1000, "gone");
  let e4legs = "";
  for (let i = 0; i < 40; i++) {
    await sleep(50);
    e4legs = live((await json(await site(`/__state?remote=${e4.rid}`))).body).map((x) => x.leg).join();
    if (e4legs === "peer") break;
  }
  await clockAt(T0 + 40_000);
  const e4a = await R("__alarm", e4.rid);
  const e4after = live((await json(await site(`/__state?remote=${e4.rid}`))).body).map((x) => x.leg).join();
  ok(e4legs === "peer" && e4after === "peer" && e4a.alarm === null, `ENGINE-4: a stale alarm with no page left closes nothing, and no alarm stays (${e4legs} -> ${e4after}, ${e4a.alarm})`);
  await clockAt(T0);
  await done(e4);
}

// ---- grader's #109 pins (r109r3 at b74f4185)
{
  const se = await session(E);
  const st = async (rid) => (await json(await site(`/__state?remote=${rid}`))).body;
  const live = (atts) => atts.filter((x) => !x.ended);
  const done = async (...rs) => { for (const r of rs) await post("/api/remote/v1/revoke", { remote_id: r.rid }, { cookie: se, origin: SITE }); };

  // G7, G8: a terminal page (1 MiB window) that never acks: its first receipt after a quarter of the window (1024
  // empty messages of 256 charged bytes each), and the window's exact fit: the 4096th (exactly 1 MiB) is sent
  const t1 = await enroll(se, "g7");
  let peer = (await dialPeer(t1)).leg;
  let pg = (await dialPage(se, t1.rid, "terminal")).leg;
  let o = J(await peer.next());
  for (let i = 0; i < 4096; i++) peer.send(`${o.gen}\n`);
  let n = -1;
  for (let last = -2; n !== last; await sleep(300)) [last, n] = [n, pg.got.length];
  const firstReceipt = pg.got.findIndex((t) => t.startsWith('{"relay":"receipt"'));
  const empties = pg.got.filter((t) => t === "").length;
  ok(empties === 4096 && peer.closed === null, `G7: the window's exact fit is sent: all 4096, the sender still open (${empties}, ${peer.closed})`);
  ok(firstReceipt === 1024, `G8: the first receipt after a quarter of the window, before receiptEvery (${firstReceipt})`);
  // G9: an ack is cumulative: acking the 2nd receipt retires the 1st too
  const receipts = pg.got.filter((t) => t.startsWith('{"relay":"receipt"')).map(J);
  pg.send(JSON.stringify({ relay: "ack", r: receipts[1].r }));
  await sleep(200);
  const pa = (await st(t1.rid)).find((x) => x.leg === "page" && !x.ended);
  ok(receipts.length >= 3 && pa && pa.rx.tokens.length === receipts.length - 2 && pa.rx.acked === receipts[1].upto,
    `G9: an ack retires its token and every earlier one (${receipts.length} receipts, ${pa?.rx.tokens.length} left, acked ${pa?.rx.acked})`);
  // (and one more past what the ack freed than fits: the boundary on the other side)
  const freeAfterAck = 1048576 - (4096 * 256 - receipts[1].upto);
  for (let i = 0; i < freeAfterAck / 256 + 1; i++) peer.send(`${o.gen}\n`);
  ok((await peer.closedWith(20000)) === 1013, `G7: one past the window: 1013`);
  await done(t1);

  // H9: a page's pongs are charged too: a terminal page pinging without reading them stops at its window (1013)
  const h9 = await enroll(se, "h9");
  peer = (await dialPeer(h9)).leg;
  pg = (await dialPage(se, h9.rid, "terminal")).leg;
  await peer.next();
  for (let i = 0; i < 4000; i++) pg.send('{"relay":"ping"}');
  ok((await pg.closedWith(20000)) === 1013, "H9: a page's ping flood, its pongs never acked -> 1013");
  await done(h9);

  // H7: the control window counts what was acked: a peer whose window a page filled, once it acks, gets its pongs
  const h7 = await enroll(se, "h7");
  peer = (await dialPeer(h7)).leg;
  const q = (await dialPage(se, h7.rid)).leg;
  await peer.next();
  await sendInTurn(q, peer, [2400000, 2400000, 2400000, 1100000]);
  const pr = peer.got.filter((t) => t.startsWith('{"relay":"receipt"')).map(J);
  peer.send(JSON.stringify({ relay: "ack", r: pr.at(-1).r }));
  const had = peer.got.filter((t) => t === '{"relay":"pong"}').length;
  for (let i = 0; i < 400; i++) peer.send('{"relay":"ping"}');
  for (let i = 0; i < 100 && peer.got.filter((t) => t === '{"relay":"pong"}').length < had + 400; i++) await sleep(50);
  const pongs = peer.got.filter((t) => t === '{"relay":"pong"}').length - had;
  ok(pr.length >= 1 && pongs === 400 && peer.closed === null, `H7: after its ack, a peer that keeps up gets every pong (${pongs}, closed ${peer.closed})`);
  await done(h7);

  // G11: at the cap (4 terminal pages), the oldest gives way
  const g11 = await enroll(se, "g11");
  peer = (await dialPeer(g11)).leg;
  const tp = [];
  for (let i = 0; i < 5; i++) tp.push((await dialPage(se, g11.rid, "terminal")).leg);
  await sleep(300);
  const opens = peer.got.map(J).filter((m) => m?.relay === "page-open").map((m) => m.gen);
  const closes = peer.got.map(J).filter((m) => m?.relay === "page-close").map((m) => m.gen);
  const liveGens = live(await st(g11.rid)).filter((x) => x.leg === "page").map((x) => x.gen).sort((a, b) => a - b);
  ok(opens.length === 5 && JSON.stringify(closes) === JSON.stringify([Math.min(...opens)]) && JSON.stringify(liveGens) === JSON.stringify(opens.slice(1).sort((a, b) => a - b)),
    `G11: at the cap the oldest terminal page gives way (closed ${JSON.stringify(closes)}, live ${JSON.stringify(liveGens)} of ${JSON.stringify(opens)})`);

  // A21: a leg the relay ended (that oldest page) has no effect: what it still sends never reaches the peer
  const mark = peer.got.length;
  try { tp[0].send("from an ended page"); } catch {}
  tp[1].send("from a live page");
  for (let i = 0; i < 60 && !peer.got.slice(mark).some((t) => t.endsWith("\nfrom a live page")); i++) await sleep(50);
  await sleep(200);
  const after21 = peer.got.slice(mark);
  ok(after21.some((t) => t.endsWith("\nfrom a live page")) && !after21.some((t) => t.endsWith("\nfrom an ended page")),
    `A21: an ended page's message isn't taken, a live one's is (${JSON.stringify(after21.map((t) => t.slice(0, 30)))})`);
  await done(g11);

  // A22: a revoke ends the open pages too (4403), not only the peer
  const a22 = await enroll(se, "a22");
  peer = (await dialPeer(a22)).leg;
  await dialPage(se, a22.rid, "terminal");
  await dialPage(se, a22.rid, "terminal");
  await peer.next();
  await peer.next();
  const beforeRv = live(await st(a22.rid)).map((x) => x.leg).sort().join();
  await done(a22);
  const after = live(await st(a22.rid));
  ok(beforeRv === "page,page,peer" && after.length === 0, `A22: a revoke ends the peer and both pages (${beforeRv} -> ${JSON.stringify(after.map((x) => x.leg))})`);

  // A18: the relay's own check: a page of another kind than the peer attached is refused (503), whatever the Worker sent
  const a18 = await enroll(se, "a18");
  peer = (await dialPeer(a18)).leg;
  const up = { headers: { upgrade: "websocket" } };
  const wrongKind = await site(`/__dopage?remote=${a18.rid}&account=${E}&kind=agent&chan=agent`, up);
  const rightKind = await site(`/__dopage?remote=${a18.rid}&account=${E}&kind=runner&chan=terminal`, up);
  ok(wrongKind.status === 503 && rightKind.status === 101, `A18: a page for another kind than its peer's: 503 (${wrongKind.status}; the control ${rightKind.status})`);
  // A32: an unknown channel is the Worker's own 400: no request reaches the relay
  await site("/__relaycalls");
  const unk = await site(`/api/remote/v1/page?remote=${a18.rid}&chan=constructor`, { headers: { upgrade: "websocket", cookie: se, origin: SITE, "x-test-relay-count": "1" } });
  const calls = (await (await site("/__relaycalls")).json()).n;
  const known = await site(`/api/remote/v1/page?remote=${a18.rid}&chan=terminal`, { headers: { upgrade: "websocket", cookie: se, origin: SITE, "x-test-relay-count": "1" } });
  const calls2 = (await (await site("/__relaycalls")).json()).n;
  ok(unk.status === 400 && calls === 0 && known.status === 101 && calls2 === 1, `A32: an unknown channel: 400 with no relay request (${unk.status}, ${calls}); a known one reaches it (${known.status}, ${calls2})`);
  await done(a18);

  // G14: the Worker's revoke waits for the relay's: if the relay can't revoke, the row stays (503), and the remote works
  const g14 = await enroll(se, "g14");
  const rv = await post("/api/remote/v1/revoke", { remote_id: g14.rid }, { cookie: se, origin: SITE, "x-test-relay-fail": "1" });
  const row = await db.prepare("SELECT revoked FROM remotes WHERE remote_id = ?1").bind(g14.rid).first();
  const still = await dialPeer(g14);
  ok(rv.status === 503 && row && row.revoked === null && still.status === 101, `G14: a relay that can't revoke: 503, the row as it was, the remote still connects (${rv.status}, ${row?.revoked}, ${still.status})`);
  await done(g14);

  // H17: remoteDeletes (the purge's completion) revokes every remote still there in its relay before its statements
  const h17 = await enroll(se, "h17");
  const p17 = await dialPeer(h17);
  const rd = await (await post("/__remotedeletes", { account: E })).json();
  const again = await dialPeer(h17);
  ok(p17.status === 101 && rd.ok && again.status === 403, `H17: remoteDeletes revokes in the relay first: the remote can't connect after (${again.status})`);
}

// ---- a runner's agent kinds (x-sb-remote-agents): written with their time only once the relay admitted its leg, read
// back in the account's peer list (a hint for the page; its hello decides).  (Each case on a computer of its own,
// revoked after: the relay holds at most 4 used challenges per computer until they expire)
{
  const sf = await session(F);
  const peersF = async (cookie = sf) => (await json(await site("/api/remote/v1/peers", { headers: { cookie } }))).body.peers ?? [];
  async function computer(name, kind = "runner") {
    const r = await enroll(sf, name, kind);
    const legs = [];
    r.row = () => db.prepare("SELECT agents, agents_at FROM remotes WHERE remote_id = ?1").bind(r.rid).first();
    r.peer = async (cookie) => (await peersF(cookie)).find((p) => p.remote_id === r.rid);
    r.dial = async (over) => { const d = await dialPeer(r, over); if (d.leg) legs.push(d.leg); return d; };
    r.done = async () => { for (const L of legs) L.close(); await post("/api/remote/v1/revoke", { remote_id: r.rid }, { cookie: sf, origin: SITE }); };
    return r;
  }
  {
    const r = await computer("kinds-a");
    let p = await r.peer();
    ok(JSON.stringify(p.agents) === "[]" && p.agents_at === null, `agents: none reported yet: [] and null (${JSON.stringify(p)})`);
    const t0 = Date.now();
    const d = await r.dial({ headers: { "x-sb-remote-agents": "claude,codex" } });
    const t1 = Date.now();
    p = await r.peer();
    ok(d.status === 101 && JSON.stringify(p.agents) === '["claude","codex"]' && p.agents_at >= t0 && p.agents_at <= t1,
      `agents: an admitted leg's list, in its order, with the time it was admitted (${d.status}, ${JSON.stringify(p)})`);
    // (refused legs change nothing: the same challenge again with another list (the relay refuses it), a bad
    // signature, and another key's signature)
    const kept = JSON.stringify(await r.row());
    const replay = await r.dial({ c: d.c, sig: d.sig, headers: { "x-sb-remote-agents": "other" } });
    const badSig = await r.dial({ sig: "A".repeat(86), headers: { "x-sb-remote-agents": "other" } });
    const other = await key();
    const c2 = (await json(await post("/api/remote/v1/challenge", { remote_id: r.rid }))).body.challenge;
    const otherKey = await r.dial({ c: c2, sig: await sign(other.priv, "sb-remote-chal/1\n" + c2), headers: { "x-sb-remote-agents": "other" } });
    ok(replay.status === 403 && badSig.status === 403 && otherKey.status === 403 && JSON.stringify(await r.row()) === kept,
      `agents: a replayed challenge, a bad signature and another key's, each with another list: refused, list and time unchanged (${replay.status}, ${badSig.status}, ${otherKey.status})`);
    // (another account never sees this computer)
    const resA = await json(await site("/api/remote/v1/peers", { headers: { cookie: await session(D) } }));
    ok(resA.status === 200 && Array.isArray(resA.body.peers) && !resA.body.peers.some((p) => p.remote_id === r.rid) && (await r.peer()) !== undefined,
      `agents: another account's peer list doesn't have this computer, its own does (${resA.status})`);
    await r.done();
  }
  // (lists that aren't one valid list, on admitted legs: stored as none, the leg admitted all the same)
  const bad = [["a,b,c,d,e", "five names"], ["Claude", "an upper-case letter"], ["a,a", "a name twice"], ["a,,b", "an empty name"],
    ["a,b,", "a trailing comma"], ["a, b", "a space"], ["1a", "a name starting with a digit"], ["a".repeat(17), "17 characters"],
    ["a-b_c", "an underscore"], [("x".repeat(16) + ",").repeat(6).slice(0, 101), "101 bytes"], ["caf\u00e9", "a non-ASCII byte"]];
  for (const [h, what] of bad) {
    const r = await computer("kinds-bad");
    await r.dial({ headers: { "x-sb-remote-agents": "claude" } });
    const was = await r.peer();
    const t2 = Date.now();
    const b = await r.dial({ headers: { "x-sb-remote-agents": h } });
    const now = await r.peer(), row = await r.row();
    ok(JSON.stringify(was.agents) === '["claude"]' && b.status === 101 && JSON.stringify(now.agents) === "[]" && now.agents_at === null
      && row.agents === null && row.agents_at >= t2, `agents: ${what}: the leg admitted, stored as none (${b.status}, ${JSON.stringify(now.agents)}, ${JSON.stringify(row)})`);
    await r.done();
  }
  {
    // (the longest valid list, four names of 16 (67 bytes); then a leg with no header clears it)
    const r = await computer("kinds-four");
    const four = ["a", "b", "c", "d"].map((c) => c.repeat(16));
    let d = await r.dial({ headers: { "x-sb-remote-agents": four.join(",") } });
    let p = await r.peer();
    ok(d.status === 101 && JSON.stringify(p.agents) === JSON.stringify(four), `agents: four names of 16 characters (${JSON.stringify(p.agents)})`);
    d = await r.dial();
    p = await r.peer();
    ok(d.status === 101 && JSON.stringify(p.agents) === "[]" && p.agents_at === null && (await r.row()).agents === null, `agents: a leg with no header clears them (${JSON.stringify(p.agents)})`);
    // (read back defensively: a stored value that isn't a valid list, or a time that isn't, reads as none or no time)
    for (const [agents, at, what, want] of [["not json", 5, "not JSON", "[]"], ['["Claude"]', 5, "an invalid name", "[]"], ['["a","b","c","d","e"]', 5, "five names", "[]"],
      ['{"a":1}', 5, "an object", "[]"], ['["claude,codex"]', 5, "one element with a comma", "[]"], ['["a,b","c,d"]', 5, "two elements with commas", "[]"],
      ['["a","a"]', 5, "a name twice", "[]"], ["[]", 5, "an empty list", "[]"], ['[1]', 5, "a number", "[]"], ['["claude"]', -1, "a negative time", '["claude"]'], ['["claude"]', 1.5, "a fractional time", '["claude"]']]) {
      await db.prepare("UPDATE remotes SET agents = ?2, agents_at = ?3 WHERE remote_id = ?1").bind(r.rid, agents, at).run();
      const q = await r.peer();
      ok(JSON.stringify(q.agents) === want && q.agents_at === null, `agents: a stored value with ${what}: read as ${want} and no time (${JSON.stringify(q.agents)}, ${q.agents_at})`);
    }
    await r.done();
  }
  {
    // (an agent's key reads [] and null, whatever is stored)
    const ag = await computer("kinds-agent", "agent");
    await db.prepare("UPDATE remotes SET agents = ?2, agents_at = ?3 WHERE remote_id = ?1").bind(ag.rid, '["claude"]', 5).run();
    const p = await ag.peer();
    ok(JSON.stringify(p.agents) === "[]" && p.agents_at === null, `agents: an agent's key reads [] and null (${JSON.stringify(p)})`);
    await ag.done();
  }
  {
    // (a revoked runner: its legs are refused, and its row isn't written)
    const r = await computer("kinds-revoked");
    await r.dial({ headers: { "x-sb-remote-agents": "claude" } });
    const before = JSON.stringify(await r.row());
    await post("/api/remote/v1/revoke", { remote_id: r.rid }, { cookie: sf, origin: SITE });
    const gone = await r.dial({ headers: { "x-sb-remote-agents": "codex" } });
    const after = await db.prepare("SELECT agents, agents_at, revoked FROM remotes WHERE remote_id = ?1").bind(r.rid).first();
    ok(gone.status !== 101 && JSON.stringify({ agents: after.agents, agents_at: after.agents_at }) === before && after.revoked !== null,
      `agents: a revoked runner's leg is refused and its row not written (${gone.status})`);
    await r.done();
  }
}

{
  // (a database before the agents columns' migration: the peer list as before, with agents [] and null, and a runner's
  // leg with the header admitted all the same; last, since it takes the columns away)
  const sf = await session(F);
  const r = await enroll(sf, "kinds-old-db");
  await db.prepare("ALTER TABLE remotes DROP COLUMN agents_at").run();
  await db.prepare("ALTER TABLE remotes DROP COLUMN agents").run();
  const d = await dialPeer(r, { headers: { "x-sb-remote-agents": "claude" } });
  const pe = await json(await site("/api/remote/v1/peers", { headers: { cookie: sf } }));
  const p = (pe.body.peers ?? []).find((x) => x.remote_id === r.rid);
  ok(d.status === 101 && pe.status === 200 && p && JSON.stringify(p.agents) === "[]" && p.agents_at === null,
    `agents: a database without the agents columns: the leg admitted, the peer list with [] and null (${d.status}, ${pe.status}, ${JSON.stringify(p)})`);
  d.leg?.close();
}

await mf.dispose();
console.log(`${count - failures}/${count} relay tests passed`);
process.exit(failures ? 1 : 0);
