// ci: web-sync.2 order=76
// Sealed ops on the sync server (design/e2e-encryption.md §4, §4.1; e2e PR 5b), in Miniflare with real Durable
// Objects (SQLite): an index op the server can't read, decided in its device's order, sealed under the key chain's
// current head and signed by a device current in that chain (both made here with the E2E core, as a device makes
// them), and counted only by the blob references it adds and releases.  Behind SYNC_E2E, DEV only.
//
//   node web/sync/test-sealed-ops.mjs
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { dispatch } from "../miniflare-dispatch.mjs";
import { useCrypto, webCrypto } from "../workspace/fleet/core/index.mjs";
import { keyFromSeed } from "../workspace/fleet/core/ed25519.mjs";
import { b64, idOfBytes, newId, random } from "../workspace/fleet/core/bytes.mjs";
import * as E from "../workspace/e2e/core/index.mjs";
import { sealedOpMessage } from "../workspace/e2e/sealed-op.mjs";
import { hpkeDouble as hpke } from "../workspace/e2e/hpke-double.mjs";

useCrypto(webCrypto());
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

let failures = 0, count = 0;
function ok(cond, what) {
  count++;
  console.log((cond ? "ok   " : "FAIL ") + what);
  if (!cond) failures++;
}
async function section(name, fn, ms = 120_000) {
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`didn't finish within ${ms / 1000} s`)), ms)))]);
  } catch (e) {
    ok(false, `${name}: ${e?.stack ?? e}`);
  } finally {
    clearTimeout(timer);
  }
}

const hashOf = (id) => createHash("sha256").update("sagebrush-account\n" + id).digest("hex");
const e2eIdOf = (id) => idOfBytes(Uint8Array.from(Buffer.from(hashOf(id).slice(0, 32), "hex")));
const text = (b) => new TextDecoder().decode(b);
const PURGE_KEY = "purge-key";
const A = "5ea1ed00-0001-4e2e-8e2e-e2e2e2e2e201"; // the main account
const N = "5ea1ed00-0002-4e2e-8e2e-e2e2e2e2e202"; // no key chain yet
const R = "5ea1ed00-0003-4e2e-8e2e-e2e2e2e2e203"; // read-only
const P = "5ea1ed00-0004-4e2e-8e2e-e2e2e2e2e204"; // the sync generation: deleting the synced data, and after
const SITE = "https://sagebrush.test";
const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8" });
const base = { modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"] };
const shareBindings = { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", COCALC_ORIGIN: "https://cocalc.test", COCALC_CLIENT_SECRET: "client-secret", PURGE_KEY, LIMITS_KEY: "limits-key" };
const plan = { storage_bytes: 1 << 30, max_file_bytes: 1 << 20, sync: { enabled: true, version_bytes: 1 << 20, read_bytes_per_day: 1 << 30 } };
const cocalc = async () => Response.json(plan);
const objects = { SYNC_ACCOUNT: { className: "SyncAccount", useSQLite: true }, SYNC_DOC: { className: "SyncDoc", useSQLite: true } };
const ratelimits = (id) => ({ SYNC_PREAUTH: { namespace_id: id, simple: { limit: 1_000_000, period: 60 } }, SYNC_INGRESS_IP: { namespace_id: "8" + id, simple: { limit: 1_000_000, period: 60 } }, SYNC_ACCOUNT_INGRESS: { namespace_id: "9" + id, simple: { limit: 1_000_000, period: 60 } }, SYNC_ADMIN_LIMIT: { namespace_id: "7" + id, simple: { limit: 1_000_000, period: 60 } } });
const listed = [A, N, R, P].join(",");
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [
    { ...base, name: "on", bindings: { ...shareBindings, SYNC_ACCOUNTS: listed, SYNC_E2E: "1", SYNC_AGENT: "1", GRANT_TAG_KEY: "grant-tag-key", SYNC_TEST_PIN_MS: "1000" }, durableObjects: objects, routes: ["sagebrush.test/*"], outboundService: cocalc, ratelimits: ratelimits("4101") },
    { ...base, name: "off", bindings: { ...shareBindings, SYNC_ACCOUNTS: listed, SYNC_TEST_PIN_MS: "1000" }, durableObjects: objects, routes: ["off.test/*"], outboundService: cocalc, ratelimits: ratelimits("4102") },
  ],
}));
const db = await mf.getD1Database("SHARE_DB", "on");
{
  const mig = join(here, "../share/migrations");
  for (const m of readdirSync(mig).filter((f) => f.endsWith(".sql")).sort())
    for (const s of readFileSync(join(mig, m), "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();
}
const at = (origin, path, init = {}) => dispatch(mf, origin + path, { redirect: "manual", ...init });
async function signIn(id, origin = SITE) {
  const r = await at(origin, "/auth/dev", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: "dev-token", account_id: id }) });
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));
}
const hdr = (s, id, origin, extra = {}) => ({ cookie: s, origin, "x-sync-account": hashOf(id), ...extra });
const post = (s, id, path, body, origin = SITE, extra = {}) => at(origin, path, { method: "POST", headers: { ...hdr(s, id, origin, extra), "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (s, id, path, origin = SITE, extra = {}) => at(origin, path, { headers: hdr(s, id, origin, extra) });
const answer = async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) });
async function enabled(id, origin = SITE) {
  const s = await signIn(id, origin);
  const e = await at(origin, "/api/sync/v1/enable", { method: "POST", headers: { cookie: s, origin, "content-type": "application/json" }, body: "{}" });
  ok(e.status === 200, `enable ${id.slice(-2)} on ${origin}: ${e.status}`);
  return s;
}
const objectOf = async (id) => {
  const ns = await mf.getDurableObjectNamespace("SYNC_ACCOUNT", "on");
  return ns.get(ns.idFromName("acct:" + hashOf(id)));
};
const seamAll = async (id, v) => (await at(SITE, "/__test/e2e?account=" + id, { method: "POST", body: JSON.stringify(v) })).json();
// (the E2E tables' row counts only; seamAll also has the store's work counters)
const seam = async (id, v) => { const r = await seamAll(id, v); return r && Object.fromEntries(Object.entries(r).filter(([k]) => k.startsWith("e2e_"))); };
async function until(f, ms = 15_000) {
  for (const t = Date.now(); Date.now() - t < ms; ) {
    if (await f()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
const signedPost = (key, path, body, ts = Math.floor(Date.now() / 1000)) => at(SITE, path, {
  method: "POST",
  headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "x-sagebrush-timestamp": String(ts), "x-sagebrush-signature": "sha256=" + createHmac("sha256", key).update(`${ts}\nPOST\n${path}\n${body}`).digest("hex") },
  body,
});

// ---- a device's side, with the E2E core
const AUD = "https://dev.sagebrush.space";
function account(id) {
  const ctx = { aud: AUD, account: e2eIdOf(id) };
  const W = { ctx, state: null, secrets: new Map(), devices: [] };
  W.device = async (name) => {
    const did = newId();
    const sign = await keyFromSeed(random(32));
    const kem = await E.newKem();
    return { id: did, sign, kem, rec: { id: did, name, kind: "browser", sign: b64(sign.raw), kem: b64(kem.publicRaw) }, signer: E.deviceSigner(did, sign) };
  };
  W.epoch = async (state) => {
    const n = state ? state.epoch.n + 1 : 0;
    const S = E.newEpochSecret();
    let keyring = null, ring = null;
    if (n > 0) {
      ring = await E.sealKeyring({ S, account: ctx.account, meta: { epoch: n, generation: W.nextGeneration ?? state.generation, suite: 1, prev: state.head, prev_ring: state.epoch.keyring?.hash ?? "" }, secret: W.secrets.get(n - 1) });
      keyring = { hash: ring.hash };
    }
    return { n, S, ring, epoch: { n, suite: 1, commit: await E.epochCommit(S, ctx.account, n), keyring } };
  };
  /** An append's body for `entry` after `state`, with wrappers of S to `who` made by `by` at the new head. */
  W.pack = async (state, entry, by, who, S, n, ring = null) => {
    const next = (await E.applyChainEntry(state, entry, ctx)).state;
    const wrappers = [];
    for (const r of who) wrappers.push(text(await E.wrapEpoch({ hpke, state: next, ctx, sender: by, recipient: r, n, S })));
    return { body: { entry: text(entry), keyring: ring ? b64(ring.bytes) : null, wrappers }, next };
  };
  W.genesis = async () => {
    const d = await W.device("laptop");
    const rk = await E.recoveryKeys(E.newRecoverySeed(), ctx.account);
    const ep = await W.epoch(null);
    const entry = await E.sealEntry(d.signer, E.nextBody(null, ctx, "genesis", { device: d.rec, recovery: { sign: b64(rk.sign.raw), kem: b64(rk.kem.publicRaw) }, epoch: ep.epoch }), d.sign, { recovery: rk.sign });
    const p = await W.pack(null, entry, d, [{ kind: "device", id: d.id }, { kind: "recovery", id: ctx.account }], ep.S, 0);
    W.secrets.set(0, ep.S);
    W.devices.push(d);
    W.rk = rk;
    return { ...p, d, ep };
  };
  W.add = async (state, by) => {
    const nd = await W.device("phone");
    const draft = E.nextBody(state, ctx, "add", { device: nd.rec, pop: null });
    const pre = await E.preEntryHash(draft);
    const ch = await E.challenge(hpke, nd.kem.publicRaw, pre);
    const mac = await E.respond(hpke, nd.kem, ch.enc, pre);
    await E.checkResponse(ch.secret, ch.enc, pre, mac);
    const entry = await E.sealEntry(by.signer, { ...draft, pop: { enc: b64(ch.enc), mac: b64(mac) } }, by.sign, { device: nd.sign });
    const n = state.epoch.n;
    return { ...(await W.pack(state, entry, by, [{ kind: "device", id: nd.id }], W.secrets.get(n), n)), nd };
  };
  W.remove = async (state, by, gone) => {
    const ep = await W.epoch(state);
    const entry = await E.sealEntry(by.signer, E.nextBody(state, ctx, "remove", { remove: gone.id, epoch: ep.epoch }), by.sign);
    const left = W.devices.filter((d) => d.id !== gone.id);
    const p = await W.pack(state, entry, by, [...left.map((d) => ({ kind: "device", id: d.id })), { kind: "recovery", id: ctx.account }], ep.S, ep.n, ep.ring);
    return { ...p, ep, left };
  };
  W.recover = async (state) => {
    const nd = await W.device("new laptop");
    const rk2 = await E.recoveryKeys(E.newRecoverySeed(), ctx.account);
    const ep = await W.epoch(state);
    const body = E.nextBody(state, ctx, "recover", { device: nd.rec, recovery: { sign: b64(rk2.sign.raw), kem: b64(rk2.kem.publicRaw) }, epoch: ep.epoch });
    const entry = await E.sealEntry(E.recoverySigner(ctx.account, W.rk.sign), body, W.rk.sign, { device: nd.sign, recovery: rk2.sign });
    const next = (await E.applyChainEntry(state, entry, ctx)).state;
    const who = [...[...next.devices.values()].filter((d) => d.removed === null).map((d) => ({ kind: "device", id: d.id })), { kind: "recovery", id: ctx.account }];
    const wrappers = [];
    for (const r of who) wrappers.push(text(await E.wrapEpoch({ hpke, state: next, ctx, sender: nd, recipient: r, n: ep.n, S: ep.S })));
    return { body: { entry: text(entry), keyring: b64(ep.ring.bytes), wrappers }, next, nd, rk2, ep };
  };
  /** The person's reset: under the current recovery key, a new device and recovery key, a fresh generation, the next
   * epoch; wrappers to the new device and the new recovery key, made by the new device. */
  W.reset = async (state, opts = {}) => {
    const nd = await W.device("recovered");
    const rk2 = await E.recoveryKeys(E.newRecoverySeed(), ctx.account);
    const generation = newId();
    W.nextGeneration = generation;
    const ep = await W.epoch(state);
    W.nextGeneration = null;
    const body = E.nextBody(state, ctx, "reset", { generation, device: nd.rec, recovery: { sign: b64(rk2.sign.raw), kem: b64(rk2.kem.publicRaw) }, epoch: ep.epoch, min_suite: 1, ...(opts.body ?? {}) });
    const key = opts.signWith ?? W.rk.sign;
    const signer = opts.signer ?? E.recoverySigner(ctx.account, key);
    const entry = await E.sealEntry(signer, body, key, { device: nd.sign, recovery: rk2.sign });
    let next = null;
    try { next = (await E.applyChainEntry(state, entry, ctx)).state; } catch { /* (refused ones are posted anyway) */ }
    const wrappers = [];
    if (next) for (const r of [{ kind: "device", id: nd.id }, { kind: "recovery", id: ctx.account }]) wrappers.push(text(await E.wrapEpoch({ hpke, state: next, ctx, sender: nd, recipient: r, n: ep.n, S: ep.S })));
    return { body: { entry: text(entry), keyring: b64(ep.ring.bytes), wrappers }, next, nd, rk2, ep, generation };
  };
  return W;
}

// ---- the account socket, as test-sync.mjs speaks it
async function socket(session, origin = SITE) {
  const r = await at(origin, "/api/sync/v1/account", { headers: { cookie: session, origin, upgrade: "websocket" } });
  if (r.status !== 101) return { status: r.status };
  const ws = r.webSocket;
  ws.accept();
  const queue = [], waiting = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    const w = waiting.findIndex((x) => x.match(m));
    if (w >= 0) waiting.splice(w, 1)[0].resolve(m);
    else queue.push(m);
  });
  let req = 0;
  const s = {
    status: 101, ws,
    send: (m) => ws.send(JSON.stringify(m)),
    next(match = () => true) {
      const i = queue.findIndex(match);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve) => {
        const w = { match, resolve };
        waiting.push(w);
        setTimeout(() => { const j = waiting.indexOf(w); if (j >= 0) waiting.splice(j, 1), resolve(null); }, 5000);
      });
    },
    async ask(m) { const n = ++req; s.send({ ...m, req: n }); return s.next((x) => x.req === n); },
  };
  return s;
}
async function hello(s, device) {
  s.send({ t: "hello", v: 2, device, name: "test", index_after: 0 });
  const w = await s.next((m) => m.t === "welcome" || m.t === "error");
  await s.next((m) => m.t === "index");
  return w;
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const putBlob = (s, bytes) => at(SITE, `/api/sync/v1/blob/${sha(bytes)}`, { method: "PUT", headers: { cookie: s, origin: SITE, "content-type": "application/octet-stream", "x-sb-ct-sha256": sha(bytes) }, body: bytes });
/** A sealed op as a device makes it: an envelope (random bytes: the server never reads it), signed by E2E device `d`
 * of `W` under chain state `st`, for sync device `sdev` at `dseq`, in sync generation `extra.gen` (1 unless said). */
async function signed(W, d, st, sdev, dseq, extra = {}) {
  const env = random(48), adds = extra.adds ?? [], releases = extra.releases ?? [];
  const msg = await sealedOpMessage({ account: W.ctx.account, syncGeneration: extra.gen ?? 1, chainGeneration: st.generation, head: st.head, device: sdev, dseq, env, adds, releases, signer: d.id });
  return { dseq, head: st.head, env: Buffer.from(env).toString("base64"), adds, releases, signer: d.id, sig: b64(await d.sign.sign(msg)) };
}
const noSig = (op) => ({ ...op, sig: "A".repeat(86) });

await section("what a device signs: a fixed vector, written out by hand", async () => {
  // (independent of the encoder: the domain and the canonical body are literal text here, keys in order, and the
  // envelope's hash and the whole message's hash are pinned; only sealedOpMessage itself is under test)
  const op = { account: "acct-fixture", syncGeneration: 3, chainGeneration: "gen-fixture", head: "A".repeat(43), device: "sync-device-fixture", dseq: 7, env: new Uint8Array([1, 2, 3]), adds: ["a".repeat(64)], releases: ["b".repeat(64)], signer: "a".repeat(26) };
  const body = '{"account":"acct-fixture","adds":["' + "a".repeat(64) + '"],"chain_generation":"gen-fixture","device":"sync-device-fixture","dseq":7,"env":"A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc-4E","head":"' + "A".repeat(43) + '","releases":["' + "b".repeat(64) + '"],"signer":"' + "a".repeat(26) + '","sync_generation":3}';
  const want = Buffer.from("sagebrush.e2e.sealed-op.v1\n" + body, "utf8");
  const got = Buffer.from(await sealedOpMessage(op));
  ok(got.equals(want), "the signed bytes are exactly the domain, a newline and the canonical body: " + got.toString("utf8").slice(0, 120));
  ok(createHash("sha256").update(got).digest("hex") === "22ce4fad31c32ba833b0ea7f44cadb4160dfb8c452f87a23213df21bb297ecf5", "and their SHA-256 is the pinned one");
});

await section("no key chain: sealed ops are refused for the whole message", async () => {
  const s = await enabled(N);
  const ws = await socket(s);
  const w = await hello(ws, "sealed-dev-n001");
  const op = { dseq: w.next_dseq, head: "A".repeat(43), env: "AAAA", signer: "a".repeat(26), sig: "A".repeat(86) };
  const a = await ws.ask({ t: "sops", ops: [op] });
  ok(a?.code === "conflict" && a.detail?.reason === "no_chain", "before the chain's genesis: conflict, no_chain: " + JSON.stringify(a));
  const again = await ws.ask({ t: "sops", ops: [op] });
  ok(again?.code === "conflict", "and no dseq was spent (the same one is refused the same way)");
  ws.ws.close();
});

await section("sealed ops: signed by a current device, under the current head", async () => {
  const s = await enabled(A);
  const W = account(A);
  const g = await W.genesis();
  ok((await post(s, A, "/api/sync/v1/e2e/chain", g.body)).status === 201, "(genesis)");
  const d = g.d;
  let st = g.next;
  const ws = await socket(s);
  const dev = "sealed-dev-a001";
  const w = await hello(ws, dev);
  let n = w.next_dseq;
  const acct = await objectOf(A);
  const logRows = async () => (await ws.ask({ t: "pull_index", after: 0 }))?.ops?.length ?? -1;

  const one = await signed(W, d, st, dev, n), two = await signed(W, d, st, dev, n + 1);
  const a = await ws.ask({ t: "sops", ops: [one, two] });
  ok(a?.t === "ack" && a.ops?.length === 2 && a.ops.every((o) => Number.isInteger(o.seq)), "two signed ops under the current head: accepted: " + JSON.stringify(a));
  const resend = await ws.ask({ t: "sops", ops: [one] });
  ok(resend?.ops?.[0]?.seq === a.ops[0].seq, "a resend is answered with its seq, once");
  const ix = await ws.ask({ t: "pull_index", after: 0 });
  const mine = ix?.ops?.filter((o) => o.device === dev);
  ok(mine?.length === 2 && mine[0].env === one.env && mine[0].head === st.head && JSON.stringify(mine[0].adds) === "[]" && mine[0].op === undefined && mine[0].path === undefined,
    "the log serves each as it came: its envelope, head and references, and nothing the server can read: " + JSON.stringify(mine?.[0]));
  n += 2;

  // (signatures: refused for the whole message, spending no dseq and changing nothing)
  const before = await logRows();
  const good = await signed(W, d, st, dev, n);
  const forged = async (op, what) => {
    const r = await ws.ask({ t: "sops", ops: [op] });
    ok(r?.code === "forbidden" && (await logRows()) === before, `${what}: forbidden, nothing stored: ` + JSON.stringify(r));
  };
  await forged(noSig(good), "a signature that isn't one");
  await forged({ ...good, signer: newId() }, "a signer that isn't a device of the chain");
  await forged({ ...good, env: Buffer.from(random(48)).toString("base64") }, "another envelope under the signature");
  await forged({ ...good, adds: ["0".repeat(64)] }, "references added that weren't signed");
  await forged({ ...good, releases: ["0".repeat(64)] }, "references released that weren't signed");
  await forged(await (async () => { const o = await signed(W, d, st, dev, n + 5); return { ...o, dseq: n }; })(), "a signature made for another dseq");
  await forged(await signed(W, d, st, "sealed-dev-other1", n), "a signature made for another sync device");
  const second = await ws.ask({ t: "sops", ops: [good, noSig(await signed(W, d, st, dev, n + 1))] });
  ok(second?.code === "forbidden" && second.detail?.dseq === n + 1 && (await logRows()) === before, "a signed op, then a forged one: the whole message forbidden, naming the forged dseq; nothing stored: " + JSON.stringify(second));
  const ok1 = await ws.ask({ t: "sops", ops: [good] });
  ok(Number.isInteger(ok1?.ops?.[0]?.seq), "the untampered op, the same dseq: accepted (none was spent)");
  n += 1;

  // (the mixed message: a current-head op followed by a stale-head one is refused whole)
  const ad = await W.add(st, d);
  ok((await post(s, A, "/api/sync/v1/e2e/chain", ad.body)).status === 201, "(a device added: the head moves)");
  const old = st;
  st = ad.next;
  const rowsMixed = await logRows();
  const mixed = await ws.ask({ t: "sops", ops: [await signed(W, d, st, dev, n), await signed(W, d, old, dev, n + 1)] });
  ok(mixed?.code === "conflict" && mixed.detail?.reason === "stale_head" && (await logRows()) === rowsMixed, "[current head, stale head]: the whole message refused, stale_head, nothing stored: " + JSON.stringify(mixed));
  const staleAlone = await ws.ask({ t: "sops", ops: [await signed(W, d, old, dev, n)] });
  ok(staleAlone?.code === "conflict" && staleAlone.detail?.reason === "stale_head" && staleAlone.detail.head?.hash === st.head, "an op under the old head: stale_head, naming the current one");
  const reused = await ws.ask({ t: "sops", ops: [await signed(W, d, st, dev, n)] });
  ok(Number.isInteger(reused?.ops?.[0]?.seq), "re-sealed under the current head, the same dseq: accepted");
  n += 1;

  // (another current device may release a reference the first one added)
  const blob = Buffer.from("sealed ops' blob");
  ok((await putBlob(s, blob)).status === 201, "(a blob held)");
  const refs = async () => (await acct.inspect({ sha256: sha(blob) }))?.refs;
  const r1 = await ws.ask({ t: "sops", ops: [await signed(W, d, st, dev, n, { adds: [sha(blob)] })] });
  ok(Number.isInteger(r1?.ops?.[0]?.seq) && (await refs()) === 1, "an op adding a held blob: accepted, one reference");
  const missing = await ws.ask({ t: "sops", ops: [await signed(W, d, st, dev, n + 1, { adds: ["e".repeat(64)] })] });
  ok(missing?.ops?.[0]?.code === "missing", "an op adding a blob not held: refused, missing");
  const phone = ad.nd;
  const r2 = await ws.ask({ t: "sops", ops: [await signed(W, phone, st, dev, n + 2, { releases: [sha(blob)] })] });
  ok(Number.isInteger(r2?.ops?.[0]?.seq) && (await refs()) === 0, "another current device releases it: accepted, the reference given back");
  const r3 = await ws.ask({ t: "sops", ops: [await signed(W, d, st, dev, n + 3, { releases: [sha(blob)] })] });
  ok(r3?.ops?.[0]?.code === "invalid" && (await refs()) === 0, "releasing it again, with no reference left: refused, and nothing changes");
  n += 4;

  // (a removed device: the head is public, so it can seal under the new one, but its signature no longer counts)
  const rm = await W.remove(st, d, phone);
  ok((await post(s, A, "/api/sync/v1/e2e/chain", rm.body)).status === 201, "(the phone removed: the head moves again)");
  st = rm.next;
  const rowsRm = await logRows();
  const gone = await ws.ask({ t: "sops", ops: [await signed(W, phone, st, dev, n)] });
  ok(gone?.code === "forbidden" && (await logRows()) === rowsRm, "the removed device, signing under the new head: forbidden, nothing stored: " + JSON.stringify(gone));
  const prior = await ws.ask({ t: "sops", ops: [await signed(W, d, old, dev, n)] });
  ok(prior?.code === "conflict" && prior.detail?.reason === "stale_head", "an op sealed before the removal: refused, stale_head");

  // (form: each refused alone, its dseq spent as a refusal, the next decided)
  const h = st.head;
  const form = await ws.ask({ t: "sops", ops: [
    { dseq: n, head: h, env: "", adds: [], releases: [], signer: d.id, sig: "A".repeat(86) },
    { dseq: n + 1, head: h, env: Buffer.alloc((64 << 10) + 1).toString("base64"), signer: d.id, sig: "A".repeat(86) },
    { dseq: n + 2, head: h, env: "AAAA", adds: ["0".repeat(64), "0".repeat(64)], signer: d.id, sig: "A".repeat(86) },
    { dseq: n + 3, head: "not a head", env: "AAAA", signer: d.id, sig: "A".repeat(86) },
    { dseq: n + 4, head: h, env: "AAAA", path: "/plain.txt", signer: d.id, sig: "A".repeat(86) },
    { dseq: n + 5, head: h, env: "AAAA", adds: Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(64, "0")), signer: d.id, sig: "A".repeat(86) },
    { dseq: n + 6, head: h, env: "AAAA" },
    await signed(W, d, st, dev, n + 7),
  ] });
  const codes = form?.ops?.map((o) => o.code ?? "ok");
  ok(JSON.stringify(codes) === JSON.stringify(["invalid", "limit", "invalid", "invalid", "invalid", "limit", "invalid", "ok"]),
    "an empty envelope, one over 64 KiB, an address twice, a malformed head, a plaintext field, 65 references, no signer: each refused; the next accepted: " + JSON.stringify(codes));
  n += 8;

  // (the log's cap counts new ops only: a lost ack's retry at a full log is still answered with its seq)
  const kept = (await ws.ask({ t: "pull_index", after: 0 }))?.ops?.filter((o) => o.env !== undefined).length;
  await seam(A, { sealedCap: kept + 1 });
  const fill = await signed(W, d, st, dev, n);
  const filled = await ws.ask({ t: "sops", ops: [fill] });
  ok(Number.isInteger(filled?.ops?.[0]?.seq), "(the last place in the log taken)");
  const retry = await ws.ask({ t: "sops", ops: [fill] });
  ok(retry?.ops?.[0]?.seq === filled.ops[0].seq, "at exactly the cap, the lost ack's retry: its seq, not limit: " + JSON.stringify(retry));
  const over = await signed(W, d, st, dev, n + 1);
  const full = await ws.ask({ t: "sops", ops: [fill, over] });
  ok(full?.code === "limit" && full.detail?.limit === "sealed_log", "a retry with one new op past the cap: refused whole, limit sealed_log: " + JSON.stringify(full));
  await seam(A, { sealedCap: kept + 2 });
  const mixedRetry = await ws.ask({ t: "sops", ops: [fill, over] });
  ok(mixedRetry?.ops?.[0]?.seq === filled.ops[0].seq && Number.isInteger(mixedRetry?.ops?.[1]?.seq), "with room for the new one: the old one answered with its seq, the new one accepted, the same dseq");
  await seam(A, { sealedCap: 1_000_000 });
  n += 2;

  // (the agents' index passes sealed ops by: built through a plaintext op after them, to the log's end)
  const plain = await ws.ask({ t: "ops", ops: [{ dseq: n, t: Date.now(), by: "person", op: "mkdir", path: "/after-sealed", kind: "folder", fid: "00000000000005b1" }] });
  ok(Number.isInteger(plain?.ops?.[0]?.seq), "(a plaintext op after the sealed ones)");
  const rb = await at(SITE, "/api/sync/v1/index/rebuild", { method: "POST", headers: { cookie: s, origin: SITE, "content-type": "application/json" }, body: "{}" });
  ok(rb.status === 200, "(the agents' index rebuilt from the first op)");
  let ixs = null;
  for (let k = 0; k < 40; k++) {
    ixs = await acct.testIndex({ step: true });
    if (ixs?.state === "ready") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  ok(ixs?.state === "ready" && ixs.cursor === ixs.max && ixs.max === plain.ops[0].seq, "the agents' index is built past the sealed ops, through the plaintext op after them, to the log's end: " + JSON.stringify(ixs));
  ws.ws.close();
});

await section("the sync generation: an op in flight when the synced data is deleted, and a replay after", async () => {
  const s = await enabled(P);
  const W = account(P);
  const g = await W.genesis();
  ok((await post(s, P, "/api/sync/v1/e2e/chain", g.body)).status === 201, "(genesis)");
  const dev = "sealed-dev-p001";
  const ws = await socket(s);
  const w = await hello(ws, dev);
  const gen1 = (await db.prepare("SELECT generation FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(P)).first())?.generation;
  ok(gen1 === 1, "(sync generation 1)");
  // (a signed op held between its checks and its commit; meanwhile the synced data is deleted, sync is turned on
  // again (generation 2) and the same sync device comes back at the same dseq: the held op must not land there)
  const held = await signed(W, g.d, g.next, dev, w.next_dseq, { gen: 1 });
  await seam(P, { sealedHold: 12_000 });
  const sent = Date.now();
  const pending = ws.ask({ t: "sops", ops: [held] });
  await new Promise((r) => setTimeout(r, 200));
  const del = await at(SITE, "/api/sync/v1/delete", { method: "POST", headers: { cookie: s, origin: SITE, "content-type": "application/json" }, body: JSON.stringify({ confirm: "delete", generation: gen1 }) });
  ok(del.status === 202, "(the synced data's deletion starts while the op is held)");
  const acct = await objectOf(P);
  ok(await until(async () => { await acct.wakeNow().catch(() => {}); return (await acct.lifecycle())?.state === null; }, 8_000), "(the deletion finishes, still within the hold)");
  const s2 = await enabled(P);
  const gen2 = (await db.prepare("SELECT generation FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(P)).first())?.generation;
  ok(gen2 === 2, "(sync generation 2)");
  const ws2 = await socket(s2);
  const w2 = await hello(ws2, dev);
  ok(w2.next_dseq === held.dseq, `(the same sync device is back at the same dseq, ${w2.next_dseq}, before the held op's commit)`);
  const ans = await pending;
  // (until the hold is over and the held op's commit has run, whichever way it went)
  await new Promise((r) => setTimeout(r, Math.max(0, sent + 13_000 - Date.now())));
  await seam(P, { sealedHold: 0 });
  const log2 = (await ws2.ask({ t: "pull_index", after: 0 }))?.ops ?? [];
  ok(!Number.isInteger(ans?.ops?.[0]?.seq) && log2.every((o) => o.env !== held.env), "the held op lands in neither generation: refused at its commit, generation 2's log without it: " + JSON.stringify({ ans, log2: log2.length }));
  try { ws.ws.close(); } catch {}
  // (the exact generation-1 op, replayed in generation 2 at the same device and dseq; then a fresh signature)
  const replay = await ws2.ask({ t: "sops", ops: [held] });
  ok(replay?.code === "forbidden", "generation 1's exact signed op, replayed in generation 2 at the same device and dseq: forbidden: " + JSON.stringify(replay));
  const fresh = await ws2.ask({ t: "sops", ops: [await signed(W, g.d, g.next, dev, w2.next_dseq, { gen: 2 })] });
  ok(Number.isInteger(fresh?.ops?.[0]?.seq), "a fresh generation-2 signature at that dseq: accepted");
  ws2.ws.close();
});

await section("read-only, and the switch off", async () => {
  const s = await enabled(R);
  const W = account(R);
  const g = await W.genesis();
  ok((await post(s, R, "/api/sync/v1/e2e/chain", g.body)).status === 201, "(genesis)");
  const ws = await socket(s);
  const w = await hello(ws, "sealed-dev-r001");
  await (await objectOf(R)).testAgent({ readonly: true });
  const ro = await ws.ask({ t: "sops", ops: [await signed(W, g.d, g.next, "sealed-dev-r001", w.next_dseq)] });
  ok(ro?.code === "readonly", "a read-only account takes no sealed ops (they are content, unlike the key chain's own writes): " + JSON.stringify(ro));
  ws.ws.close();
  const so = await signIn(A, "https://off.test");
  await at("https://off.test", "/api/sync/v1/enable", { method: "POST", headers: { cookie: so, origin: "https://off.test", "content-type": "application/json" }, body: "{}" });
  const off = await socket(so, "https://off.test");
  const wo = off.status === 101 ? await hello(off, "sealed-dev-o001") : null;
  const o = wo ? await off.ask({ t: "sops", ops: [{ dseq: wo.next_dseq, head: "A".repeat(43), env: "AAAA", signer: "a".repeat(26), sig: "A".repeat(86) }] }) : null;
  ok(o?.code === "forbidden", "with SYNC_E2E off: forbidden: " + JSON.stringify(o));
  if (off.ws) off.ws.close();
});

await mf.dispose();
console.log(failures ? `\n${failures} of ${count} FAILED` : `\nall ${count} passed`);
process.exit(failures ? 1 : 0);
