// ci: web-sync.1 order=15
// Tests for the relay's engine channel (remote r3.3, step P1: design/remote-r3.md), in Miniflare with the RemoteRelay
// Durable Object, the account object and a sync account object (TestSyncAccount: one answer for every account, set
// by /__sync) bound:
//
// - who may open one: the Worker's form checks (notebook, entry, attempt, cgen), a runner that says engine/1 (an older
//   one: 503 in words), the sync namespace derived from the session (never the page's);
// - H1 and H4: the identity in page-open (nb, entry, sgen, cgen) and in the page's {"relay":"engine"}; the attempt id
//   once; the notebook's newer page (any entry) replaces the older (4009, its page-close first) with a higher sgen;
//   other notebooks coexist;
// - the engine pages' service budget, a deployment setting: pages (exact, one more, replacement, close and reopen),
//   the frames waiting across them (queueBytes, 1013), used attempt ids (exact, one more, never evicted early);
//   a misconfigured budget admits none (503);
// - H5: sync read before each open (off, readonly, no plan, no binding: 403; unreachable or a failed read: 503) and
//   every RELAY_SYNC.everyMs while an engine page is attached (the alarm): a definitive change, or a new sync
//   generation, advances the connection generation (pages end 4412, the runner told {"relay":"cgen"}); a transient
//   failure leaves the pages be; the kernel and terminal channels aren't gated;
// - H2: /api/remote/v1/disconnect advances the connection generation (4410); a page presenting the old one is refused
//   (409), the current one or none admitted;
// - binary frames on the engine channel only, with the same ASCII generation prefix; elsewhere 1003 or 1008.
//
//   node web/cloud/remote/test-relay-engine.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { migrations } from "../share/migrations.mjs";
import { dispatch } from "../../miniflare-dispatch.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
const { subtle } = webcrypto;

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

const SITE = "https://sagebrush.test";
const A = "11111111-1111-4111-8111-111111111111";
const C = "33333333-3333-4333-8333-333333333333";

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
async function until(f, tries = 250) {
  for (let i = 0; i < tries; i++) {
    if (await f()) return true;
    await sleep(20);
  }
  return false;
}

const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8" });
const bindings = { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", REMOTE_CHAL_KEY: "chal-key", REMOTE_ACCOUNTS: `${A}, ${C}` };
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: "remote", modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"], bindings,
    durableObjects: {
      REMOTE_RELAY: { className: "TestRemoteRelay", useSQLite: true },
      REMOTE_ACCOUNT: { className: "TestRemoteAccount", useSQLite: true },
      SYNC_ACCOUNT: { className: "TestSyncAccount", useSQLite: true },
    } }],
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
async function enroll(cookie, name) {
  const k = await key();
  const d = (await json(await post("/api/remote/v1/device", { pub: k.jwk, kind: "runner", name }))).body;
  await form("/remote/activate", cookie, { code: d.user_code, decision: "approve" });
  await db.prepare("UPDATE remote_devices SET last_poll = NULL WHERE user_code = ?1").bind(d.user_code.replace("-", "")).run();
  const p = (await json(await post("/api/remote/v1/device/poll", { device_code: d.device_code }))).body;
  return { rid: p.remote_id, k };
}

/** A leg: its messages in order (text as strings, binary as Uint8Array), and its close. */
function leg(ws) {
  const L = { ws, got: [], waiters: [], closed: null };
  ws.accept();
  const wake = () => { for (const w of L.waiters.splice(0)) w(); };
  ws.addEventListener("message", (e) => { L.got.push(typeof e.data === "string" ? e.data : new Uint8Array(e.data)); wake(); });
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
  // (the next message other than a pong or a receipt)
  L.msg = async (ms = 5000) => {
    for (;;) {
      const t = await L.next(ms);
      if (t === null || typeof t !== "string" || !/^\{"relay":"(pong|receipt)"/.test(t)) return t;
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
async function dialPeer(r, caps = "engine/1") {
  const c = (await json(await post("/api/remote/v1/challenge", { remote_id: r.rid }))).body.challenge;
  const sig = await sign(r.k.priv, "sb-remote-chal/1\n" + c);
  const headers = { upgrade: "websocket", "x-sb-remote-challenge": c, "x-sb-remote-signature": sig };
  if (caps !== null) headers["x-sb-remote-caps"] = caps;
  const res = await site("/api/remote/v1/runner", { headers });
  return { status: res.status, leg: res.webSocket ? leg(res.webSocket) : null };
}
const attempt = () => b64url(webcrypto.getRandomValues(new Uint8Array(16)));
/** An engine page: {status, error?, leg?, attempt}. */
async function dialEngine(cookie, rid, { nb = "nb1", entry = "sagebrush-magma", att = attempt(), cgen, extra = "" } = {}) {
  const q = `remote=${rid}&chan=engine&nb=${nb}&entry=${entry}&attempt=${att}${cgen === undefined ? "" : `&cgen=${cgen}`}${extra}`;
  const res = await site(`/api/remote/v1/page?${q}`, { headers: { upgrade: "websocket", cookie, origin: SITE } });
  const out = { status: res.status, leg: res.webSocket ? leg(res.webSocket) : null, attempt: att };
  if (!res.webSocket) out.error = (await res.json().catch(() => ({}))).error;
  return out;
}
async function dialPage(cookie, rid, chan) {
  const res = await site(`/api/remote/v1/page?remote=${rid}&chan=${chan}`, { headers: { upgrade: "websocket", cookie, origin: SITE } });
  return { status: res.status, leg: res.webSocket ? leg(res.webSocket) : null };
}
const J = (t) => (t === null || typeof t !== "string" ? null : JSON.parse(t));
const setSync = (q) => site(`/__sync?${q}`);
let clockMs = Date.UTC(2030, 0, 15, 12, 0, 0);
const tick = async (rid, ms) => {
  clockMs += ms;
  await site(`/__relay/__clock?remote=${rid}&ms=${clockMs}`);
};
const alarm = (rid) => site(`/__relay/__alarm?remote=${rid}`);
// (as in test-relay.mjs: Miniflare doesn't always deliver to the client a close made from another socket's event, so
// a close is checked when it arrives, and always by its effect at the relay or the peer)
const closedOr = async (L, code) => { const c = await L.closedWith(1500); return c === code || c === null; };
const engineState = async (rid) => (await json(await site(`/__state?remote=${rid}`))).body.filter((a) => a.leg === "page" && a.chan === "engine" && !a.ended);

const sa = await session(A), sc = await session(C);
const r1 = await enroll(sa, "box-1");
const syncName = "acct:" + createHash("sha256").update("sagebrush-account\n" + A).digest("hex");
await site(`/__syncname?name=${syncName}`);
await setSync("state=active&gen=7");

// ---- who may open one
let x = await dialEngine(sa, r1.rid);
ok(x.status === 503 && !x.leg, `engine: no runner connected -> 503 (${x.status})`);
let old = await dialPeer(r1, null);
ok(old.status === 101, `peer: a runner without x-sb-remote-caps -> 101 (${old.status})`);
x = await dialEngine(sa, r1.rid);
ok(x.status === 503 && /older sagebrush/.test(x.error ?? ""), `engine: a runner that doesn't say engine/1 -> 503, in words (${x.status} ${x.error})`);
old.leg.close();
await sleep(100);
old = await dialPeer(r1, "nonsense,engine/2,agent");
x = await dialEngine(sa, r1.rid);
ok(x.status === 503, `engine: unknown caps are dropped, never passed on -> 503 (${x.status})`);
old.leg.close();
await sleep(100);
const p = (await dialPeer(r1)).leg;
ok(!!p, "peer: an engine/1 runner -> 101");
for (const [what, o] of [
  ["a notebook id with a slash", { nb: "a/b" }], ["an empty notebook id", { nb: "" }], ["a 44-character notebook id", { nb: "n".repeat(44) }],
  ["an unknown entry", { entry: "sagebrush-gap" }], ["an inherited name as entry", { entry: "constructor" }], ["no attempt", { att: "" }],
  ["a short attempt", { att: "A".repeat(21) }], ["cgen 0", { cgen: 0 }], ["cgen not a number", { cgen: "x" }],
]) {
  x = await dialEngine(sa, r1.rid, o);
  ok(x.status === 400 && !x.leg, `engine: ${what} -> 400 (${x.status})`);
}
x = await dialEngine(sc, r1.rid);
ok(x.status === 404, `engine: another account's remote -> 404 (${x.status})`);
{
  const res = await site(`/api/remote/v1/page?remote=${r1.rid}&chan=engine&nb=nb1&entry=python&attempt=${attempt()}`, { headers: { upgrade: "websocket", cookie: sa, origin: "https://evil.test" } });
  ok(res.status === 403, `engine: another site -> 403 (${res.status})`);
}

// ---- H1 and H4: the identity
await site("/__synccalls");
const e1 = await dialEngine(sa, r1.rid, { nb: "nbA", entry: "sagebrush-magma" });
ok(e1.status === 101 && e1.leg, `engine: an engine/1 runner, sync active -> 101 (${e1.status} ${e1.error})`);
let open = J(await p.msg());
ok(open?.relay === "page-open" && open.chan === "engine" && open.nb === "nbA" && open.entry === "sagebrush-magma" && open.sgen === 1 && open.cgen === 1 && open.kind === "runner"
  && Object.keys(open).join() === "relay,conn,kind,chan,gen,nb,entry,sgen,cgen", `engine: page-open names the identity, in order (${JSON.stringify(open)})`);
const hello = J(await e1.leg.msg());
ok(hello?.relay === "engine" && hello.sgen === 1 && hello.cgen === 1, `engine: the page is told its generations (${JSON.stringify(hello)})`);
{
  const calls = (await json(await site("/__synccalls"))).body.calls;
  ok(calls.length >= 1 && calls.every((c) => c.name === syncName && c.account === A), `engine: sync read for the session's account, in its own namespace (${JSON.stringify(calls)})`);
}
x = await dialEngine(sa, r1.rid, { nb: "nbZ", att: e1.attempt });
ok(x.status === 403 && x.error === "attempt used", `engine: the same attempt id again -> 403 (${x.status} ${x.error})`);
// (the same notebook, same entry: the newer replaces the older, its page-close first, a higher sgen)
const e2 = await dialEngine(sa, r1.rid, { nb: "nbA", entry: "sagebrush-magma" });
ok(e2.status === 101, `engine: the notebook in another page -> 101 (${e2.status})`);
let close = J(await p.msg()), open2 = J(await p.msg());
ok(close?.relay === "page-close" && close.gen === open.gen && open2?.relay === "page-open" && open2.sgen === 2 && open2.nb === "nbA",
  `engine: the older page's page-close, then the newer's page-open with sgen 2 (${JSON.stringify([close, open2])})`);
ok(await closedOr(e1.leg, 4009), "engine: the older page -> 4009");
// (the same notebook, another entry (H4): also a replacement, sgen 3; never the other entry's page)
const e3 = await dialEngine(sa, r1.rid, { nb: "nbA", entry: "python" });
close = J(await p.msg());
const open3 = J(await p.msg());
ok(e3.status === 101 && close?.relay === "page-close" && close.gen === open2.gen && open3?.entry === "python" && open3.sgen === 3,
  `engine: another entry for the notebook replaces its page, sgen 3 (${JSON.stringify([close, open3])})`);
ok(await closedOr(e2.leg, 4009), "engine: the other entry's page -> 4009");
// (another notebook coexists)
const f1 = await dialEngine(sa, r1.rid, { nb: "nbB", entry: "sagebrush-sage" });
const openB = J(await p.msg());
ok(f1.status === 101 && openB?.nb === "nbB" && openB.sgen === 1, `engine: another notebook coexists, its own sgen (${JSON.stringify(openB)})`);
ok((await engineState(r1.rid)).map((a) => a.engine.nb).sort().join() === "nbA,nbB", "engine: two engine pages at the relay");
await e3.leg.msg();
await f1.leg.msg();

// ---- the wire: text and binary, with the generation prefix
e3.leg.send("hello");
let got = await p.msg();
ok(got === `${open3.gen}\nhello`, `engine: a page's text gets its generation prefix (${JSON.stringify(got)})`);
e3.leg.send(new Uint8Array([0, 1, 2, 255]));
got = await p.msg();
ok(got instanceof Uint8Array && Buffer.from(got).toString("latin1") === `${open3.gen}\n\x00\x01\x02\xff`, `engine: a page's binary gets the same ASCII prefix (${got})`);
p.send(new Uint8Array([...Buffer.from(`${open3.gen}\n`), 9, 8, 7]));
got = await e3.leg.msg();
ok(got instanceof Uint8Array && got.join() === "9,8,7", `engine: a runner's binary reaches the page without its prefix (${got})`);
p.send(`${openB.gen}\nto B`);
got = await f1.leg.msg();
ok(got === "to B", `engine: a runner's text to the other notebook (${got})`);
{
  // (a binary message the runner sends for a kernel page: 1008; a kernel page's binary: 1003)
  const kp = await dialPage(sa, r1.rid, "kernel");
  ok(kp.status === 101, `kernel: a kernel page beside engine pages -> 101 (${kp.status})`);
  const kopen = J(await p.msg());
  kp.leg.send(new Uint8Array([1]));
  ok(await closedOr(kp.leg, 1003), "kernel: a kernel page's binary -> 1003");
  ok(J(await p.msg())?.relay === "page-close", "kernel: its page-close reaches the runner");
  ok(kopen?.chan === "kernel", `kernel: its page-open (${JSON.stringify(kopen)})`);
}

// ---- H2: disconnect
{
  const r = await post("/api/remote/v1/disconnect", { remote_id: r1.rid }, { cookie: sa, origin: "https://evil.test" });
  ok(r.status === 403, `disconnect: another site -> 403 (${r.status})`);
  const r2 = await post("/api/remote/v1/disconnect", { remote_id: r1.rid }, { cookie: sc, origin: SITE });
  ok(r2.status === 404, `disconnect: another account's remote -> 404 (${r2.status})`);
}
let d = await json(await post("/api/remote/v1/disconnect", { remote_id: r1.rid }, { cookie: sa, origin: SITE }));
ok(d.status === 200 && d.body.cgen === 2, `disconnect: the connection generation advances to 2 (${JSON.stringify(d)})`);
{
  const seen = [J(await p.msg()), J(await p.msg()), J(await p.msg())];
  ok(seen.filter((m) => m?.relay === "page-close").length === 2 && seen.some((m) => m?.relay === "cgen" && m.cgen === 2),
    `disconnect: both engine pages' page-close and {"relay":"cgen","cgen":2} reach the runner (${JSON.stringify(seen)})`);
}
ok(await closedOr(e3.leg, 4410) && await closedOr(f1.leg, 4410), "disconnect: the engine pages -> 4410");
ok((await engineState(r1.rid)).length === 0, "disconnect: no engine page left at the relay");
x = await dialEngine(sa, r1.rid, { nb: "nbA", cgen: 1 });
ok(x.status === 409 && !x.leg, `H2: a page presenting the old generation -> 409 (${x.status} ${x.error})`);
x = await dialEngine(sa, r1.rid, { nb: "nbA", cgen: 3 });
ok(x.status === 409 && !x.leg, `H2: a generation from the future -> 409 (${x.status})`);
const g1 = await dialEngine(sa, r1.rid, { nb: "nbA", cgen: 2 });
const gopen = J(await p.msg());
ok(g1.status === 101 && gopen?.cgen === 2 && gopen.sgen === 4, `H2: the current generation -> 101, cgen 2, the notebook's sgen goes on (${JSON.stringify(gopen)})`);
await g1.leg.msg();

// ---- H5: sync before each open; a definitive "not active" read by an open fences the transition too
/** An engine page at the current generation: {leg, cgen, sgen} (the page's hello), its page-open taken off the runner. */
async function openAt(nb, cgen) {
  const e = await dialEngine(sa, r1.rid, { nb, cgen });
  if (e.status !== 101) return { status: e.status, error: e.error };
  J(await p.msg());
  const h = J(await e.leg.msg());
  return { status: 101, leg: e.leg, cgen: h.cgen, sgen: h.sgen };
}
let cur = 2; // (after the disconnect above)
{
  // (the control SEC asked for: off seen only by an open, active again before any alarm: the old generation is fenced)
  await setSync("state=off");
  x = await dialEngine(sa, r1.rid, { nb: "nbQ" });
  ok(x.status === 403 && x.error === "sync_off", `H5: an open while sync is off -> 403 sync_off (${x.status} ${x.error})`);
  {
    const seen = [J(await p.msg()), J(await p.msg())];
    ok(seen.some((m) => m?.relay === "page-close") && seen.some((m) => m?.relay === "cgen" && m.cgen === cur + 1),
      `H5: that refused open alone advanced the generation: the open page's page-close and cgen ${cur + 1} at the runner (${JSON.stringify(seen)})`);
  }
  ok(await closedOr(g1.leg, 4412) && (await engineState(r1.rid)).length === 0, "H5: ... and the open engine page ended (4412)");
  cur++;
  await setSync("state=active&gen=7");
  x = await dialEngine(sa, r1.rid, { nb: "nbA", cgen: cur - 1 });
  ok(x.status === 409, `H5: sync active again before any alarm: the old generation -> 409 (${x.status} ${x.error})`);
  const back = await openAt("nbA", cur);
  ok(back.status === 101 && back.cgen === cur, `H5: the new generation -> 101 (${JSON.stringify([back.status, back.cgen])})`);
  back.leg.close();
  J(await p.msg());
}
{
{
  // (the control: a transient failure read by an open leaves an attached page and its generation be)
  const t1 = await openAt("nbT", cur);
  for (const q of ["throw=1", "reason=cocalc_unreachable"]) {
    await setSync(q);
    x = await dialEngine(sa, r1.rid, { nb: "nbU" });
    ok(x.status === 503, `H5: an open reading ${q} -> 503 (${x.status} ${x.error})`);
  }
  await sleep(200);
  const st = await engineState(r1.rid);
  ok(st.length === 1 && st[0].engine.nb === "nbT" && st[0].engine.cgen === cur && t1.leg.closed === null && p.got.length === 0,
    `H5: ... the attached page stays, at the same generation, and the runner hears nothing (${JSON.stringify([st.map((a) => a.engine), p.got])})`);
  await setSync("state=active&gen=7");
  t1.leg.close();
  J(await p.msg());
}
{
  // (durability: the marker and the generation are one write.  A failed write leaves neither: the next definitive read
  // advances and ends the page.  A stop right after the write (the pages not yet ended): the next definitive read ends
  // them, never mistaking the marker for a finished advance.  Control: without a fault, the first read does it all.)
  await tick(r1.rid, 121_000);
  for (const [fault, what] of [["failput", "the write fails once"], ["skipstale", "a stop between the write and the ends"], [null, "control: no fault"]]) {
    const f = await openAt(`nbD${fault ?? "x"}`, cur);
    ok(f.status === 101, `durability (${what}): a page attached at cgen ${cur} (${f.status} ${f.error})`);
    if (fault === "failput") await site(`/__relay/__failput?remote=${r1.rid}&key=cgen`);
    if (fault === "skipstale") await site(`/__relay/__skipstale?remote=${r1.rid}&on=1`);
    await setSync("state=off");
    const first = await dialEngine(sa, r1.rid, { nb: "nbQ" });
    await sleep(150);
    const after1 = (await engineState(r1.rid)).length;
    if (fault) {
      ok(first.status === (fault === "failput" ? 500 : 403) && after1 === 1, `durability (${what}): the first off read leaves the page (${first.status}, ${after1} attached)`);
      const second = await dialEngine(sa, r1.rid, { nb: "nbQ" });
      ok(second.status === 403, `durability (${what}): the next definitive read -> 403 (${second.status} ${second.error})`);
    } else {
      ok(first.status === 403, `durability (${what}): the first off read -> 403 (${first.status})`);
    }
    ok(await until(async () => (await engineState(r1.rid)).length === 0), `durability (${what}): the old page ended`);
    const seen = [];
    while (p.got.length) seen.push(J(p.got.shift()));
    ok(seen.some((m) => m?.relay === "cgen" && m.cgen === cur + 1) && !seen.some((m) => m?.relay === "cgen" && m.cgen > cur + 1),
      `durability (${what}): advanced exactly once, to ${cur + 1} (${JSON.stringify(seen)})`);
    cur++;
    await setSync("state=active&gen=7");
    x = await dialEngine(sa, r1.rid, { nb: "nbQ", cgen: cur - 1 });
    ok(x.status === 409, `durability (${what}): the old generation -> 409 (${x.status})`);
    await tick(r1.rid, 121_000);
  }
}
{
  // (recovery when sync turns active again after a stop between the write and the ends: the open that reads "active"
  // ends the old page (4412) before it clears the marker, and the old generation is refused)
  await tick(r1.rid, 121_000);
  for (const via of ["an active open", "the alarm"]) {
    const f = await openAt(`nbR${via.length}`, cur);
    ok(f.status === 101, `recovery (${via}): a page attached at cgen ${cur} (${f.status} ${f.error})`);
    await site(`/__relay/__skipstale?remote=${r1.rid}&on=1`);
    await setSync("state=off");
    x = await dialEngine(sa, r1.rid, { nb: "nbQ" });
    ok(x.status === 403 && (await engineState(r1.rid)).length === 1, `recovery (${via}): off commits, the stop leaves the old page (${x.status})`);
    await setSync("state=active&gen=7");
    if (via === "the alarm") {
      p.send('{"relay":"ping"}');
      f.leg.send('{"relay":"ping"}');
      await until(async () => p.got.includes('{"relay":"pong"}'));
      await tick(r1.rid, 5000);
      await alarm(r1.rid);
    } else {
      const fresh = await openAt(`nbS${via.length}`, cur + 1);
      ok(fresh.status === 101, `recovery (${via}): the active open at the new generation -> 101 (${fresh.status} ${fresh.error})`);
      fresh.leg.close();
    }
    ok(await closedOr(f.leg, 4412) && await until(async () => !(await engineState(r1.rid)).some((a) => a.engine.cgen === cur)),
      `recovery (${via}): the old generation's page ended`);
    cur++;
    x = await dialEngine(sa, r1.rid, { nb: "nbQ", cgen: cur - 1 });
    ok(x.status === 409, `recovery (${via}): the old generation -> 409 (${x.status})`);
    await sleep(100);
    while (p.got.length) p.got.shift();
    await tick(r1.rid, 121_000);
  }
}
  await tick(r1.rid, 121_000); // (the attempt ids so far expire)
  // (the same transition read again, by opens, advances nothing more; an "active" read ends the transition)
  await setSync("state=off");
  x = await dialEngine(sa, r1.rid, { nb: "nbQ" });
  J(await p.msg());
  cur++;
  for (const [q, status, what] of [
    ["state=off", 403, "sync off"], ["state=readonly", 403, "sync read-only"], ["state=registering", 403, "sync registering"],
    ["reason=plan_has_no_sync", 403, "a plan without sync"], ["reason=not_allowlisted", 403, "an account not allowed"],
    ["reason=cocalc_unreachable", 503, "CoCalc unreachable"], ["throw=1", 503, "a failed status read"],
  ]) {
    await setSync(q);
    x = await dialEngine(sa, r1.rid, { nb: "nbQ" });
    ok(x.status === status && !x.leg, `H5: ${what} -> ${status} (${x.status} ${x.error})`);
  }
  ok(p.got.length === 0, `H5: later reads of the same transition advance nothing (${JSON.stringify(p.got)})`);
  await setSync("state=active&gen=7");
  const again = await openAt("nbA", cur);
  ok(again.status === 101 && again.cgen === cur, `H5: one advance for the whole transition (cgen ${cur}) (${JSON.stringify([again.status, again.cgen])})`);
  again.leg.close();
  J(await p.msg());
}
{
  await tick(r1.rid, 121_000); // (the attempt ids so far expire)
  // (the kernel and terminal channels aren't gated by sync: they are the earlier remote's)
  await setSync("state=off");
  const kp = await dialPage(sa, r1.rid, "terminal");
  ok(kp.status === 101, `H5: a terminal page while sync is off -> 101 (${kp.status})`);
  J(await p.msg());
  kp.leg.close();
  J(await p.msg());
}
await site(`/__relay/__nosync?remote=${r1.rid}&on=1`);
await setSync("state=active&gen=7");
x = await dialEngine(sa, r1.rid, { nb: "nbQ" });
ok(x.status === 403 && x.error === "sync_unavailable", `H5: no sync binding (production) -> 403 sync_unavailable (${x.status} ${x.error})`);
await site(`/__relay/__nosync?remote=${r1.rid}&on=0`);
// (no binding fenced the generation too: an active read then clears the transition)
{
  const seen = [];
  while (p.got.length) seen.push(J(p.got.shift()));
  ok(seen.some((m) => m?.relay === "cgen" && m.cgen === cur + 1), `H5: no binding is definitive: cgen ${cur + 1} (${JSON.stringify(seen)})`);
  cur++;
}

await tick(r1.rid, 121_000); // (the attempt ids so far expire: their bound is its own rows')
// ---- H5: every RELAY_SYNC.everyMs while an engine page is attached
const { syncEvery } = (await json(await site("/__engine"))).body;
ok(syncEvery === 5000, `H5: the window is 5 s (${syncEvery})`);
const w1 = await openAt("nbA", cur);
ok(w1.status === 101, `H5: an engine page for the alarm's rows (${w1.status} ${w1.error})`);
// (both legs ping now: the logical clock moved past the dead-leg deadline while attempts expired, and the alarm below
// also closes a leg whose last ping is that old)
p.send('{"relay":"ping"}');
w1.leg.send('{"relay":"ping"}');
await until(async () => p.got.includes('{"relay":"pong"}') && w1.leg.got.includes('{"relay":"pong"}'));
// (a transient failure leaves the pages be, and refuses new opens)
await setSync("throw=1");
await tick(r1.rid, syncEvery);
await site("/__synccalls");
await alarm(r1.rid);
ok((await json(await site("/__synccalls"))).body.calls.length === 1, "H5: the alarm read sync once");
ok((await engineState(r1.rid)).length === 1 && w1.leg.closed === null, "H5: a failed read leaves the engine page attached");
await setSync("reason=cocalc_unreachable");
await tick(r1.rid, syncEvery);
await alarm(r1.rid);
ok((await engineState(r1.rid)).length === 1, "H5: cocalc_unreachable leaves it attached too");
// (not due yet: no read)
await setSync("state=off");
await tick(r1.rid, 1000);
await site("/__synccalls");
await alarm(r1.rid);
ok((await json(await site("/__synccalls"))).body.calls.length === 0 && (await engineState(r1.rid)).length === 1, "H5: before the next read is due, nothing is read or ended");
// (definitive: off ends the pages, 4412, and the runner is told the next generation)
await tick(r1.rid, syncEvery);
await alarm(r1.rid);
{
  const seen = [J(await p.msg()), J(await p.msg())];
  ok(seen.some((m) => m?.relay === "page-close") && seen.some((m) => m?.relay === "cgen" && m.cgen === cur + 1), `H5: sync off at the alarm -> page-close and cgen ${cur + 1} (${JSON.stringify(seen)})`);
  cur++;
}
ok(await closedOr(w1.leg, 4412) && (await engineState(r1.rid)).length === 0, "H5: sync off ends the engine page (4412)");
// (a new sync generation while active: a reset, also ends the pages)
await setSync("state=active&gen=7");
const h1 = await openAt("nbA", cur);
ok(h1.status === 101, `H5: active again, the current generation -> 101 (${h1.status} ${h1.error})`);
await setSync("state=active&gen=8");
await tick(r1.rid, syncEvery);
await alarm(r1.rid);
{
  const seen = [J(await p.msg()), J(await p.msg())];
  ok(seen.some((m) => m?.relay === "cgen" && m.cgen === cur + 1), `H5: a new sync generation -> cgen ${cur + 1} (${JSON.stringify(seen)})`);
  cur++;
}
ok(await closedOr(h1.leg, 4412) && (await engineState(r1.rid)).length === 0, "H5: a sync reset ends the engine page (4412)");
// (and an open finding a new generation ends the pages of the old one first)
const i1 = await openAt("nbA", cur);
await setSync("state=active&gen=9");
const i2 = await dialEngine(sa, r1.rid, { nb: "nbB", cgen: cur });
ok(i2.status === 409, `H5: an open that finds a new sync generation advances it first, so its cgen is stale -> 409 (${i2.status} ${i2.error})`);
ok(await closedOr(i1.leg, 4412) && (await engineState(r1.rid)).length === 0, "H5: ... and the old generation's page ended");
while (p.got.length) p.got.shift();
cur++;

// ---- the engine pages' service budget (relay-caps.ts engineBudget): a deployment setting, with its defaults
const budgetSet = (q) => site(`/__relay/__enginebudget?remote=${r1.rid}&${q}`);
const expire = () => tick(r1.rid, 121_000); // (the attempt ids so far expire)
{
  const { budget } = (await json(await site("/__engine"))).body;
  ok(JSON.stringify(budget) === JSON.stringify({ pages: 64, queueBytes: 48 * 1024 * 1024, attempts: 16 }), `budget: the defaults (${JSON.stringify(budget)})`);
  // (a set value outside its range, or not a plain integer: no engine page at all, never a silent default)
  for (const q of ["pages=0", "pages=4097", "pages=abc", "pages=03", "queue=1024", "queue=200000000", "attempts=0", "attempts=1.5"]) {
    await expire();
    await budgetSet(q);
    x = await dialEngine(sa, r1.rid, { nb: "nbC" });
    ok(x.status === 503 && /misconfigured/.test(x.error ?? ""), `budget: ${q} -> 503, in words (${x.status} ${x.error})`);
    await budgetSet("pages=&queue=&attempts=");
  }
  // (the values together: each in its range, but their envelope past the object's memory -> 503; exactly at it -> admitted)
  const { envelope: E, range, defaultsNeed } = (await json(await site("/__engine"))).body;
  const fixed = E.channels + E.runtime + E.copies;
  ok(defaultsNeed <= E.memory && fixed + 48 * 1024 * 1024 + 64 * E.perPage === defaultsNeed, `budget: the defaults fit the envelope (${defaultsNeed} of ${E.memory})`);
  const room = E.memory - fixed; // (for queueBytes + pages * perPage)
  const pagesAt = Math.floor((room - range.queueBytes[0]) / E.perPage);
  const exactQueue = room - pagesAt * E.perPage;
  ok(pagesAt <= range.pages[1] && exactQueue >= range.queueBytes[0] && exactQueue <= range.queueBytes[1], `budget: an exact fit within the ranges (${pagesAt} pages, ${exactQueue} bytes)`);
  for (const [q, status, what] of [
    [`pages=${pagesAt}&queue=${exactQueue}`, 101, "exactly the envelope"],
    [`pages=${pagesAt}&queue=${exactQueue + 1}`, 503, "one byte past it"],
    [`pages=${pagesAt + 1}&queue=${exactQueue}`, 503, "one page past it"],
    [`pages=${range.pages[1]}&queue=${range.queueBytes[0]}`, 503, "the most pages with the least queue: each valid alone"],
    [`pages=1&queue=${range.queueBytes[1]}`, 101, "the most queue with one page"],
    [`pages=${range.pages[1]}&queue=${range.queueBytes[1]}&attempts=${range.attempts[1]}`, 503, "every maximum at once"],
  ]) {
    await expire();
    await budgetSet(q);
    x = await dialEngine(sa, r1.rid, { nb: "nbE" });
    ok(x.status === status, `budget: ${what} (${q}) -> ${status} (${x.status} ${x.error})`);
    if (x.leg) {
      J(await p.msg());
      x.leg.close();
      J(await p.msg());
    }
    await budgetSet("pages=&queue=&attempts=");
  }
}
{
  // (attempts: exact and one more, a used id never evicted, an expired one forgotten)
  await expire();
  await budgetSet("attempts=3");
  await setSync("state=off"); // (each fresh attempt then fails after it is recorded)
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await dialEngine(sa, r1.rid, { nb: "nbF" })).attempt);
  await setSync("state=active&gen=9");
  while (p.got.length) p.got.shift();
  cur++;
  x = await dialEngine(sa, r1.rid, { nb: "nbF" });
  ok(x.status === 429 && /too many/.test(x.error ?? ""), `attempts: a 4th fresh attempt while 3 are unexpired -> 429, in words (${x.status} ${x.error})`);
  x = await dialEngine(sa, r1.rid, { nb: "nbF", att: ids[0] });
  ok(x.status === 403 && x.error === "attempt used", `attempts: a used one is still refused, never evicted to make room (${x.status} ${x.error})`);
  await expire();
  const fresh = await openAt("nbF", cur);
  ok(fresh.status === 101, `attempts: once they expire, a fresh attempt -> 101 (${fresh.status} ${fresh.error})`);
  fresh.leg?.close();
  J(await p.msg());
  await expire();
  x = await dialEngine(sa, r1.rid, { nb: "nbF", att: ids[0] });
  ok(x.status === 101, `attempts: an expired id is forgotten (${x.status} ${x.error})`);
  J(await p.msg());
  x.leg?.close();
  J(await p.msg());
  await budgetSet("attempts=");
}
{
  // (pages: a configured 3, exact and one more, replacement at capacity, close and reopen)
  await expire();
  await budgetSet("pages=3");
  const legs = [];
  for (const nb of ["c1", "c2", "c3"]) legs.push(await openAt(nb, cur));
  ok(legs.every((l) => l.status === 101), `pages: 3 notebooks with pages=3 -> 101 (${legs.map((l) => l.status)})`);
  x = await dialEngine(sa, r1.rid, { nb: "c4" });
  ok(x.status === 429 && /3 notebooks open/.test(x.error ?? ""), `pages: a 4th notebook -> 429, in words (${x.status} ${x.error})`);
  const again = await dialEngine(sa, r1.rid, { nb: "c2", entry: "python" });
  ok(again.status === 101, `pages: an open notebook replacing its own page at capacity -> 101 (${again.status} ${again.error})`);
  J(await p.msg()), J(await p.msg());
  legs[0].leg.close();
  ok(await until(async () => (await engineState(r1.rid)).length === 2), "pages: one closed, two left");
  J(await p.msg());
  const c4 = await openAt("c4", cur);
  ok(c4.status === 101, `pages: after a close, another notebook -> 101 (${c4.status} ${c4.error})`);
  x = await dialEngine(sa, r1.rid, { nb: "c5" });
  ok(x.status === 429, `pages: and at 3 again, the next -> 429 (${x.status})`);
  // (the default, 64, exact and one more)
  await budgetSet("pages=");
  for (const l of [legs[1].leg, legs[2].leg, again.leg, c4.leg]) l?.close();
  await until(async () => (await engineState(r1.rid)).length === 0);
  while (p.got.length) p.got.shift();
  const many = [];
  let all = true;
  for (let i = 0; i < 64; i++) {
    if (i % 15 === 0) await expire();
    const e = await dialEngine(sa, r1.rid, { nb: `n${i}` });
    all &&= e.status === 101;
    many.push(e.leg);
  }
  ok(all, "pages: 64 notebooks at the default -> 101");
  await expire();
  x = await dialEngine(sa, r1.rid, { nb: "one-more" });
  ok(x.status === 429 && /64 notebooks open/.test(x.error ?? ""), `pages: a 65th at the default -> 429, in words (${x.status} ${x.error})`);
  for (const l of many) l?.close();
  await until(async () => (await engineState(r1.rid)).length === 0);
  while (p.got.length) p.got.shift();
}
{
  // (queueBytes: the engine pages' frames waiting for the account's lease, all together; one past it closes 1013)
  await expire();
  await budgetSet("queue=8388608");
  const qa = await openAt("qa", cur), qb = await openAt("qb", cur);
  await site(`/__relay/__holdput?remote=${r1.rid}&on=1`); // (the debit write held: frames wait in their queues)
  const big = new Uint8Array(3 * 1024 * 1024);
  qa.leg.send(big);
  qb.leg.send(big);
  await sleep(300);
  qa.leg.send(big); // (6 MiB waiting, and 3 more: past 8 MiB across the two pages)
  ok(await closedOr(qa.leg, 1013) && await until(async () => !(await engineState(r1.rid)).some((a) => a.engine.nb === "qa"), 100),
    "queue: a frame past the engine pages' waiting total closes its page 1013 (gone at the relay)");
  ok((await engineState(r1.rid)).some((a) => a.engine.nb === "qb"), "queue: the other page stays");
  await site(`/__relay/__holdput?remote=${r1.rid}&on=0`);
  qb.leg.close();
  await budgetSet("queue=");
  while (p.got.length) p.got.shift();
}

// ---- the old channels are unchanged: the relay's own test suite (test-relay.mjs) runs them; here, one check
{
  const { entries } = (await json(await site("/__engine"))).body;
  ok(entries.join() === "sagebrush-python,sagebrush-sage,sagebrush-magma,sagebrush-matlab,python", `entries: the five, in order (${entries})`);
}

await mf.dispose();
console.log(failures ? `${failures}/${count} engine relay tests FAILED` : `${count}/${count} engine relay tests passed`);
process.exit(failures ? 1 : 0);
