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
import { keyFromSeed, verifyStrict } from "../workspace/fleet/core/ed25519.mjs";
import { b64, idOfBytes, newId, random, unb64 } from "../workspace/fleet/core/bytes.mjs";
import * as E from "../workspace/e2e/core/index.mjs";
import { sealedOpMessage } from "../workspace/e2e/sealed-op.mjs";
import { hpkeDouble as hpke } from "../workspace/e2e/hpke-double.mjs";

useCrypto(webCrypto());
const J = JSON.stringify;
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
const S = "5ea1ed00-0005-4e2e-8e2e-e2e2e2e2e205"; // what a device that pulls needs: the signed fields, acks, a refusal's end
const X = "5ea1ed00-0006-4e2e-8e2e-e2e2e2e2e206"; // the agents' index of an account that becomes encrypted
const Y = "5ea1ed00-0007-4e2e-8e2e-e2e2e2e2e207"; // an account encrypted before its first grant
const Z = "5ea1ed00-0008-4e2e-8e2e-e2e2e2e2e208"; // an account encrypted while its index builds
const K = "5ea1ed00-0009-4e2e-8e2e-e2e2e2e2e209"; // releases keyed to the add they end
const L = "5ea1ed00-000a-4e2e-8e2e-e2e2e2e2e20a"; // an object made before the index's references
const F = "5ea1ed00-000b-4e2e-8e2e-e2e2e2e2e20b"; // a sealed op in flight when its session signs out (S07)
const SITE = "https://sagebrush.test";
const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8" });
const base = { modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"] };
const shareBindings = { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", COCALC_ORIGIN: "https://cocalc.test", COCALC_CLIENT_SECRET: "client-secret", PURGE_KEY, LIMITS_KEY: "limits-key" };
const plan = { storage_bytes: 1 << 30, max_file_bytes: 1 << 20, sync: { enabled: true, version_bytes: 1 << 20, read_bytes_per_day: 1 << 30 } };
const cocalc = async () => Response.json(plan);
const objects = { SYNC_ACCOUNT: { className: "SyncAccount", useSQLite: true }, SYNC_DOC: { className: "SyncDoc", useSQLite: true } };
const ratelimits = (id) => ({ SYNC_PREAUTH: { namespace_id: id, simple: { limit: 1_000_000, period: 60 } }, SYNC_INGRESS_IP: { namespace_id: "8" + id, simple: { limit: 1_000_000, period: 60 } }, SYNC_ACCOUNT_INGRESS: { namespace_id: "9" + id, simple: { limit: 1_000_000, period: 60 } }, SYNC_ADMIN_LIMIT: { namespace_id: "7" + id, simple: { limit: 1_000_000, period: 60 } }, SYNC_AGENT_FAIL: { namespace_id: id + "9", simple: { limit: 1_000_000, period: 60 } } });
const listed = [A, N, R, P, S, X, Y, Z, K, L, F].join(",");
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
  s.send({ t: "hello", v: 3, device, name: "test", index_after: 0 });
  const w = await s.next((m) => m.t === "welcome" || m.t === "error");
  await s.next((m) => m.t === "index");
  return w;
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const putBlob = (s, bytes, address = sha(bytes)) => at(SITE, `/api/sync/v1/blob/${address}`, { method: "PUT", headers: { cookie: s, origin: SITE, "content-type": "application/octet-stream", "x-sb-ct-sha256": sha(bytes) }, body: bytes });
/** A sealed op as a device makes it: an envelope (random bytes: the server never reads it), signed by E2E device `d`
 * of `W` under chain state `st` (and its generation, unless `extra.chainGen` says another), for sync device `sdev` at
 * `dseq`, in sync generation `extra.gen` (1 unless said). */
async function signed(W, d, st, sdev, dseq, extra = {}) {
  const env = random(48), adds = extra.adds ?? [], releases = extra.releases ?? [], chainGen = extra.chainGen ?? st.generation;
  const msg = await sealedOpMessage({ account: W.ctx.account, syncGeneration: extra.gen ?? 1, chainGeneration: chainGen, head: st.head, device: sdev, dseq, env, adds, releases, signer: d.id });
  return { dseq, head: st.head, chain_gen: chainGen, env: Buffer.from(env).toString("base64"), adds, releases, signer: d.id, sig: b64(await d.sign.sign(msg)) };
}
/** An envelope's hash as an ack names it: SHA-256, unpadded base64url (worked out here independently of the server). */
const envHash = (envB64) => createHash("sha256").update(Buffer.from(envB64, "base64")).digest("base64url");
const noSig = (op) => ({ ...op, sig: "A".repeat(86) });

await section("what a device signs: a fixed vector, written out by hand", async () => {
  // (independent of the encoder: the domain and the canonical body are literal text here, keys in order, and the
  // envelope's hash and the whole message's hash are pinned; only sealedOpMessage itself is under test)
  const op = { account: "acct-fixture", syncGeneration: 3, chainGeneration: "gen-fixture", head: "A".repeat(43), device: "sync-device-fixture", dseq: 7, env: new Uint8Array([1, 2, 3]), adds: ["a".repeat(64)], releases: [{ address: "b".repeat(64), add: 5 }], signer: "a".repeat(26) };
  const body = '{"account":"acct-fixture","adds":["' + "a".repeat(64) + '"],"chain_generation":"gen-fixture","device":"sync-device-fixture","dseq":7,"env":"A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc-4E","head":"' + "A".repeat(43) + '","releases":[{"add":5,"address":"' + "b".repeat(64) + '"}],"signer":"' + "a".repeat(26) + '","sync_generation":3}';
  const want = Buffer.from("sagebrush.e2e.sealed-op.v1\n" + body, "utf8");
  const got = Buffer.from(await sealedOpMessage(op));
  ok(got.equals(want), "the signed bytes are exactly the domain, a newline and the canonical body: " + got.toString("utf8").slice(0, 120));
  ok(createHash("sha256").update(got).digest("hex") === "d9309aea7d6cef498c7abfb7d949d38b9c9ee5542a929054f322032a5bf77755", "and their SHA-256 is the pinned one");
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
  await forged({ ...good, releases: [{ address: "0".repeat(64), add: 1 }] }, "references released that weren't signed");
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
  const r2 = await ws.ask({ t: "sops", ops: [await signed(W, phone, st, dev, n + 2, { releases: [{ address: sha(blob), add: r1.ops[0].seq }] })] });
  ok(Number.isInteger(r2?.ops?.[0]?.seq) && (await refs()) === 1, "another current device releases it: accepted, and the blob still held (held until the account is purged)");
  const r3 = await ws.ask({ t: "sops", ops: [await signed(W, d, st, dev, n + 3, { releases: [{ address: sha(blob), add: r1.ops[0].seq }] })] });
  ok(r3?.ops?.[0]?.code === "invalid" && (await refs()) === 1, "releasing it again, its add already ended: refused, and nothing changes");
  n += 4;

  // (e2e PR 3b-1: a versioned keyed address, "a1:" and 64 hex, as an end-to-end device sends it: added and released
  // like any address; another version or a malformed one is no address, refused)
  const kb = Buffer.from("sealed ops' keyed blob"), ka = "a1:" + sha(Buffer.from("sealed ops' keyed address"));
  ok((await putBlob(s, kb, ka)).status === 201, "(a blob held at an a1: address)");
  const krefs = async () => (await acct.inspect({ sha256: ka }))?.refs;
  const k1 = await ws.ask({ t: "sops", ops: [await signed(W, d, st, dev, n, { adds: [ka] })] });
  ok(Number.isInteger(k1?.ops?.[0]?.seq) && (await krefs()) === 1, "an op adding a blob at an a1: address: accepted, one reference");
  const k2 = await ws.ask({ t: "sops", ops: [await signed(W, d, st, dev, n + 1, { releases: [{ address: ka, add: k1.ops[0].seq }] })] });
  ok(Number.isInteger(k2?.ops?.[0]?.seq), "…and its release: accepted");
  const kBad = await ws.ask({ t: "sops", ops: [await signed(W, d, st, dev, n + 2, { adds: ["a2:" + ka.slice(3)] })] });
  ok(kBad?.ops?.[0]?.code === "invalid", "an op adding \"a2:\" and 64 hex (no version this server knows): refused, invalid");
  const kBadRel = await ws.ask({ t: "sops", ops: [await signed(W, d, st, dev, n + 3, { releases: [{ address: "a1:" + ka.slice(4), add: k1.ops[0].seq }] })] });
  ok(kBadRel?.ops?.[0]?.code === "invalid", "a release of \"a1:\" and 63 hex: refused, invalid");
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

  // (form: each refused, its dseq spent as a refusal (one per message: a refusal ends its message), the next decided)
  const h = st.head, cg = st.generation;
  const malformed = [
    { head: h, chain_gen: cg, env: "", adds: [], releases: [], signer: d.id, sig: "A".repeat(86) },
    { head: h, chain_gen: cg, env: Buffer.alloc((64 << 10) + 1).toString("base64"), signer: d.id, sig: "A".repeat(86) },
    { head: h, chain_gen: cg, env: "AAAA", adds: ["0".repeat(64), "0".repeat(64)], signer: d.id, sig: "A".repeat(86) },
    { head: "not a head", chain_gen: cg, env: "AAAA", signer: d.id, sig: "A".repeat(86) },
    { head: h, chain_gen: cg, env: "AAAA", path: "/plain.txt", signer: d.id, sig: "A".repeat(86) },
    { head: h, chain_gen: cg, env: "AAAA", adds: Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(64, "0")), signer: d.id, sig: "A".repeat(86) },
    { head: h, chain_gen: cg, env: "AAAA" },
    { head: h, env: "AAAA", signer: d.id, sig: "A".repeat(86) },
    { head: h, chain_gen: "not a generation", env: "AAAA", signer: d.id, sig: "A".repeat(86) },
  ];
  const codes = [];
  for (const [i, m] of malformed.entries()) codes.push((await ws.ask({ t: "sops", ops: [{ dseq: n + i, ...m }] }))?.ops?.[0]?.code ?? "ok");
  codes.push((await ws.ask({ t: "sops", ops: [await signed(W, d, st, dev, n + malformed.length)] }))?.ops?.[0]?.seq !== undefined ? "ok" : "refused");
  ok(JSON.stringify(codes) === JSON.stringify(["invalid", "limit", "invalid", "invalid", "invalid", "limit", "invalid", "invalid", "invalid", "ok"]),
    "an empty envelope, one over 64 KiB, an address twice, a malformed head, a plaintext field, 65 references, no signer, no chain generation, a malformed one: each refused; the next accepted: " + JSON.stringify(codes));
  n += malformed.length + 1;

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
  // (one new dseq named twice at the last free place: one row, so accepted, the second answered as its resend; the cap
  // counts distinct new dseqs, not envelopes)
  const kept2 = (await ws.ask({ t: "pull_index", after: 0 }))?.ops?.filter((o) => o.env !== undefined).length;
  await seam(A, { sealedCap: kept2 + 1 });
  const d1 = await signed(W, d, st, dev, n + 2), d2 = await signed(W, d, st, dev, n + 2);
  const dup = await ws.ask({ t: "sops", ops: [d1, d2] });
  ok(dup?.ops?.length === 2 && Number.isInteger(dup.ops[0].seq) && dup.ops[1].seq === dup.ops[0].seq, "one new dseq twice with one place left in the log: accepted once, the second answered as its resend, not limit: " + JSON.stringify(dup));
  await seam(A, { sealedCap: 1_000_000 });
  n += 3;

  // (an account with a key chain is encrypted (e2e PR 5d): its agents' index isn't rebuilt, sealed ops or not)
  const plain = await ws.ask({ t: "ops", ops: [{ dseq: n, t: Date.now(), by: "person", op: "mkdir", path: "/after-sealed", kind: "folder", fid: "00000000000005b1" }] });
  ok(Number.isInteger(plain?.ops?.[0]?.seq), "(a plaintext op after the sealed ones)");
  const rb = await at(SITE, "/api/sync/v1/index/rebuild", { method: "POST", headers: { cookie: s, origin: SITE, "content-type": "application/json" }, body: "{}" });
  const rbb = await rb.json().catch(() => ({}));
  ok(rb.status === 409 && rbb.reason === "encrypted", "the agents' index of an account with a key chain isn't rebuilt: 409, encrypted: " + J({ status: rb.status, body: rbb }));
  ws.ws.close();
});

/** An index add accepted in another account (S): its blob and seq, for a release that names it from K. */
let otherAdd = null;

await section("what a device that pulls needs: every signed value served, the envelope's hash in each ack, and a refusal ending its message", async () => {
  const s = await enabled(S);
  const W = account(S);
  const g = await W.genesis();
  ok((await post(s, S, "/api/sync/v1/e2e/chain", g.body)).status === 201, "(genesis)");
  const d = g.d, st = g.next;
  const ws = await socket(s);
  const dev = "sealed-dev-s001";
  let n = (await hello(ws, dev)).next_dseq;
  const acct = await objectOf(S);
  const logOf = async () => (await ws.ask({ t: "pull_index", after: 0 }))?.ops ?? [];

  // (the ack names the hash of the envelope the log holds, the first time and on a resend)
  const one = await signed(W, d, st, dev, n);
  const a = await ws.ask({ t: "sops", ops: [one] });
  ok(a?.ops?.[0]?.env_sha256 === envHash(one.env) && /^[A-Za-z0-9_-]{43}$/.test(a.ops[0].env_sha256), "an accepted op's ack: its seq and its envelope's SHA-256 (unpadded base64url, 43 characters): " + JSON.stringify(a?.ops?.[0]));
  const again = await ws.ask({ t: "sops", ops: [one] });
  ok(again?.ops?.[0]?.seq === a.ops[0].seq && again.ops[0].env_sha256 === envHash(one.env), "a resend (a lost ack): the same seq and the same hash");
  const other = { ...(await signed(W, d, st, dev, n)) };
  const resealed = await ws.ask({ t: "sops", ops: [other] });
  ok(resealed?.ops?.[0]?.seq === a.ops[0].seq && resealed.ops[0].env_sha256 === envHash(one.env) && envHash(other.env) !== envHash(one.env),
    "the same dseq sealed again with other bytes: answered with the log's seq and the hash of the bytes the log holds, not the new ones");
  n += 1;
  // (one message naming one new dseq twice, with two validly signed envelopes: the first is decided; the second is
  // answered as its resend, with the hash of the bytes the log holds; the row, every answer and a later resend agree)
  const x = await signed(W, d, st, dev, n), y = await signed(W, d, st, dev, n);
  const twice = await ws.ask({ t: "sops", ops: [x, y] });
  ok(twice?.ops?.length === 2 && twice.ops[0].seq === twice.ops[1].seq && twice.ops.every((o) => o.env_sha256 === envHash(x.env)),
    "one message, one new dseq twice: both answered with its seq and the first envelope's hash: " + JSON.stringify(twice?.ops));
  const xRow = (await logOf()).find((o) => o.device === dev && o.dseq === n);
  ok(xRow?.env === x.env && xRow.sig === x.sig, "…the log holds the first envelope and its signature");
  const yLater = await ws.ask({ t: "sops", ops: [y] });
  ok(yLater?.ops?.[0]?.seq === twice.ops[0].seq && yLater.ops[0].env_sha256 === envHash(x.env), "…and the second sent again later: the same seq and the first envelope's hash");
  n += 1;

  // (every signed value is served as it was signed: the signed bytes rebuilt from the served row verify, and no field can change alone)
  const row = (await logOf()).find((o) => o.device === dev && o.dseq === one.dseq);
  const rebuild = (r) => sealedOpMessage({ account: W.ctx.account, syncGeneration: 1, chainGeneration: r.chain_gen, head: r.head, device: r.device, dseq: r.dseq,
    env: new Uint8Array(Buffer.from(r.env, "base64")), adds: r.adds ?? [], releases: r.releases ?? [], signer: r.signer });
  const verifies = async (r) => verifyStrict(d.sign.raw, await rebuild(r), unb64(r.sig, 64));
  const signedBytes = await sealedOpMessage({ account: W.ctx.account, syncGeneration: 1, chainGeneration: one.chain_gen, head: one.head, device: dev, dseq: one.dseq,
    env: new Uint8Array(Buffer.from(one.env, "base64")), adds: one.adds, releases: one.releases, signer: one.signer });
  ok(row && Buffer.from(await rebuild(row)).equals(Buffer.from(signedBytes)) && row.signer === d.id && row.sig === one.sig && row.chain_gen === st.generation && (await verifies(row)),
    "the served row rebuilds the signed bytes exactly, and its signature verifies: " + JSON.stringify(row && { signer: row.signer, chain_gen: row.chain_gen, head: row.head }));
  const tampered = {
    device: "sealed-dev-s002", dseq: row.dseq + 1, head: "B".repeat(43), chain_gen: newId(), env: Buffer.from(random(48)).toString("base64"),
    adds: ["0".repeat(64)], releases: [{ address: "1".repeat(64), add: 1 }], signer: newId(), sig: b64(random(64)),
  };
  const held = {};
  for (const [k, v] of Object.entries(tampered)) held[k] = await verifies({ ...row, [k]: v });
  ok(Object.values(held).every((x) => x === false) && Object.keys(held).length === 9, "each served signed value changed alone (device, dseq, head, chain generation, envelope, adds, releases, signer, signature): the signature fails: " + JSON.stringify(held));

  // (a chain generation that isn't the chain's current one: the whole message, as a stale head)
  const rows0 = (await logOf()).length;
  const wrongGen = await ws.ask({ t: "sops", ops: [await signed(W, d, st, dev, n, { chainGen: newId() })] });
  ok(wrongGen?.code === "conflict" && wrongGen.detail?.reason === "stale_head" && (await logOf()).length === rows0, "an op naming another chain generation: refused whole, stale_head, nothing stored: " + JSON.stringify(wrongGen));

  // (the first refusal ends the message: the ops after it decide nothing, and are new when they come again)
  const blob = Buffer.from("sealed ops' undecided blob");
  ok((await putBlob(s, blob)).status === 201, "(a blob held)");
  const refs = async () => (await acct.inspect({ sha256: sha(blob) }))?.refs;
  const first = await signed(W, d, st, dev, n), bad = await signed(W, d, st, dev, n + 1, { adds: ["e".repeat(64)] });
  const later = await signed(W, d, st, dev, n + 2, { adds: [sha(blob)] }), last = await signed(W, d, st, dev, n + 3);
  const rows1 = (await logOf()).length;
  const mid = await ws.ask({ t: "sops", ops: [first, bad, later, last] });
  const shape = mid?.ops?.map((o) => (o.seq !== undefined ? "seq" : o.code ?? (o.undecided === true ? "undecided" : "?")));
  ok(JSON.stringify(shape) === JSON.stringify(["seq", "missing", "undecided", "undecided"]), "[accepted, refused, two more]: the two after the refusal are undecided: " + JSON.stringify(mid?.ops));
  ok((await logOf()).length === rows1 + 1 && (await refs()) === 0, "…only the first is in the log, and the undecided one's reference wasn't counted");
  const w2 = await hello(await socket(s), "sealed-dev-s001");
  ok(w2?.next_dseq === n + 2, "…the next dseq is the first undecided one: the refused one was spent, the undecided ones weren't (" + w2?.next_dseq + ")");
  const resent = await ws.ask({ t: "sops", ops: [later, last] });
  ok(resent?.ops?.every((o) => Number.isInteger(o.seq) && o.env_sha256 !== undefined) && (await refs()) === 1, "the undecided ones sent again: decided as new, accepted, the reference counted: " + JSON.stringify(resent?.ops));
  otherAdd = { blob, seq: resent.ops[0].seq };
  const refusedAgain = await ws.ask({ t: "sops", ops: [bad] });
  ok(refusedAgain?.ops?.[0]?.code === "missing" && refusedAgain.ops[0].undecided === undefined, "the refused one sent again: its refusal, kept");
  ws.ws.close();
});

await section("releases keyed to the add they end: exact, once, and only an index add", async () => {
  const s = await enabled(K);
  const W = account(K);
  const g = await W.genesis();
  ok((await post(s, K, "/api/sync/v1/e2e/chain", g.body)).status === 201, "(genesis)");
  const d = g.d;
  const ad = await W.add(g.next, d);
  ok((await post(s, K, "/api/sync/v1/e2e/chain", ad.body)).status === 201, "(a second device: two can release)");
  const st = ad.next, phone = ad.nd;
  const ws = await socket(s), wp = await socket(s);
  const dev = "sealed-dev-k001", pdev = "sealed-dev-k002";
  let n = (await hello(ws, dev)).next_dseq;
  let m = (await hello(wp, pdev)).next_dseq;
  const acct = await objectOf(K);
  const b1 = Buffer.from("keyed releases: one"), b2 = Buffer.from("keyed releases: two"), b3 = Buffer.from("keyed releases: shared only");
  for (const b of [b1, b2, b3, otherAdd.blob]) ok((await putBlob(s, b)).status === 201, "(a blob held)");
  const one = async (b) => (await acct.inspect({ sha256: sha(b) }))?.refs;
  // (what a refusal must leave as it was: the log, every count, the index's references, this device's next dseq)
  const state = async () => J({
    log: ((await ws.ask({ t: "pull_index", after: 0 }))?.ops ?? []).map((o) => o.seq),
    refs: [await one(b1), await one(b2), await one(b3), await one(otherAdd.blob)],
    index_refs: (await acct.inspect({}))?.index_refs,
  });
  // (a plaintext op first, so K's seqs and S's differ: its seq is no add here)
  const pl = await ws.ask({ t: "ops", ops: [{ dseq: n, t: Date.now(), by: "person", op: "create", path: "/k.txt", kind: "file", fid: "0000000000000e01", sha256: sha(b3), size: b3.length }] });
  ok(Number.isInteger(pl?.ops?.[0]?.seq) && (await one(b3)) === 1, "(a plaintext op naming b3: its shared count is 1, and no index add)");
  n += 1;
  const addOp = async (sock, by, sdev, dseq, adds) => (await sock.ask({ t: "sops", ops: [await signed(W, by, st, sdev, dseq, { adds })] }))?.ops?.[0]?.seq;
  const s1 = await addOp(ws, d, dev, n, [sha(b1)]), s2 = await addOp(ws, d, dev, n + 1, [sha(b1)]), s3 = await addOp(ws, d, dev, n + 2, [sha(b2)]), s4 = await addOp(ws, d, dev, n + 3, [sha(b2)]);
  n += 4;
  ok([s1, s2, s3, s4].every(Number.isInteger) && (await one(b1)) === 2 && (await one(b2)) === 2, "(b1 added twice, b2 added twice: two live index adds each)");
  const ix = (await acct.inspect({}))?.index_refs ?? [];
  ok(J(ix) === J([[sha(b1), s1], [sha(b1), s2], [sha(b2), s3], [sha(b2), s4]].map(([address, add_seq]) => ({ address, add_seq, released_seq: null }))),
    "each accepted add is an index reference keyed by its op's seq: " + J(ix));

  // (every wrong release: refused invalid, the message ended there, and nothing it could touch changed; its dseq is spent as any refusal's)
  const refused = async (releases, what, malformed = false, code = "invalid") => {
    const before = await state();
    // (a malformed list can't be signed: it goes in place of a signed op's, as a device that isn't ours would send it)
    const op = malformed ? { ...(await signed(W, d, st, dev, n)), releases } : await signed(W, d, st, dev, n, { releases });
    const r = await ws.ask({ t: "sops", ops: [op] });
    n += 1;
    ok(r?.ops?.[0]?.code === code && (await state()) === before, `${what}: refused, ${code}, and the log, the counts and the index's references unchanged: ` + J(r?.ops ?? r));
  };
  await refused([{ address: sha(b1), add: s3 }], "the address right, the add wrong (s3 added b2, not b1)");
  await refused([{ address: sha(b2), add: s1 }], "the add right, the address wrong (s1 added b1, not b2)");
  ok(!(otherAdd.seq === s1 || otherAdd.seq === s2), "(S's add seq names no add of its blob here)");
  await refused([{ address: sha(otherAdd.blob), add: otherAdd.seq }], "another account's add (its blob held here too, its seq S's)");
  await refused([{ address: sha(b1), add: s4 + 1000 }], "a future add seq");
  await refused([{ address: sha(b3), add: pl.ops[0].seq }], "a seq that is an op, but no index add (a plaintext op naming the blob)");
  await refused([{ address: sha(b1), add: s1 }, { address: sha(b2), add: s1 }], "one good release and one wrong one: the op whole");
  // (b3: held only by other kinds of reference, as a document's pin or a manifest holds one, never by an index add)
  await seam(K, { shareRefs: { sha256: sha(b3), n: 2 } });
  ok((await one(b3)) === 3, "(b3's shared count raised as two pins or manifests would: 3, still no index add)");
  await refused([{ address: sha(b3), add: s1 }], "a blob held only by a pin, a manifest or a plaintext op: no index add of it to end");
  // (the same add twice in one op: a form error, so the op is refused before any check of the log)
  await refused([{ address: sha(b1), add: s1 }, { address: sha(b1), add: s1 }], "the same (address, add) twice in one op");
  // (a malformed release: an old bare address, a missing or zero add, an extra field)
  await refused([sha(b1)], "a bare address, the form before releases were keyed", true);
  await refused([{ address: sha(b1) }], "a release with no add", true);
  await refused([{ address: sha(b1), add: 0 }], "an add seq of 0", true);
  await refused([{ address: sha(b1), add: s1, n: 1 }], "a release with a field it doesn't have", true);
  // (at most 64 releases an op: 65 is refused by its form, and 64 distinct ones (none live) get as far as the log)
  const many = (k) => Array.from({ length: k }, (_, i) => ({ address: sha(b1), add: s4 + 2000 + i }));
  await refused(many(65), "65 releases in one op", false, "limit");
  await refused(many(64), "64 releases in one op, none of them live: past the form, refused by the log", false, "invalid");

  // (two live adds of one address, released independently, each once)
  const rel = async (releases) => (await ws.ask({ t: "sops", ops: [await signed(W, d, st, dev, n++, { releases })] }))?.ops?.[0];
  const x1 = await rel([{ address: sha(b1), add: s2 }]);
  ok(Number.isInteger(x1?.seq) && (await one(b1)) === 2, "the second add of b1 released: accepted, b1's shared count kept at 2: " + J(x1));
  await refused([{ address: sha(b1), add: s2 }], "the same add released again");
  const x2 = await rel([{ address: sha(b1), add: s1 }]);
  ok(Number.isInteger(x2?.seq) && (await one(b1)) === 2, "the first add of b1 released: accepted, b1's shared count still 2 (no release gives one back)");
  const ix2 = (await acct.inspect({}))?.index_refs ?? [];
  ok(J(ix2.filter((r) => r.address === sha(b1))) === J([{ address: sha(b1), add_seq: s1, released_seq: x2.seq }, { address: sha(b1), add_seq: s2, released_seq: x1.seq }]),
    "each add records the op that released it: " + J(ix2));

  // (two devices racing to release one add: both pass their checks before either commits; one commits, the other is refused, one decrement)
  await seam(K, { sealedHold: 1500 });
  const ra = signed(W, d, st, dev, n, { releases: [{ address: sha(b2), add: s3 }] }), rb = signed(W, phone, st, pdev, m, { releases: [{ address: sha(b2), add: s3 }] });
  const [opA, opB] = [await ra, await rb];
  const t0 = Date.now();
  const [ansA, ansB] = await Promise.all([ws.ask({ t: "sops", ops: [opA] }), wp.ask({ t: "sops", ops: [opB] })]);
  const took = Date.now() - t0;
  await seam(K, { sealedHold: 0 });
  ok(took >= 1500 && took < 2900, "(both were held at once, past their checks, before either committed: " + took + " ms, not two holds in turn)");
  n += 1, m += 1;
  const codes = [ansA?.ops?.[0], ansB?.ops?.[0]].map((o) => (Number.isInteger(o?.seq) ? "seq" : o?.code));
  ok(J(codes.slice().sort()) === J(["invalid", "seq"]) && (await one(b2)) === 2 && ((await acct.inspect({}))?.index_refs ?? []).filter((r) => r.address === sha(b2) && r.add_seq === s3 && r.released_seq !== null).length === 1, "two devices release one add at once: one accepted, one refused invalid, the add ended once: " + J({ codes, refs: await one(b2) }));
  const x3 = await (async () => (await wp.ask({ t: "sops", ops: [await signed(W, phone, st, pdev, m++, { releases: [{ address: sha(b2), add: s4 }] })] }))?.ops?.[0])();
  ok(Number.isInteger(x3?.seq) && (await one(b2)) === 2, "the other device releases b2's other add, which this device added: accepted, its shared count kept");
  ok((await one(b3)) === 3, "b3's shared count is still the pins' and the plaintext op's, untouched by every refusal");
  ws.ws.close();
  wp.ws.close();
});

await section("an object made before the index's references: its restart makes the table, and an add and its release work", async () => {
  const s = await enabled(L);
  const ws0 = await socket(s);
  const n0 = (await hello(ws0, "sealed-dev-l001")).next_dseq;
  ok(Number.isInteger((await ws0.ask({ t: "ops", ops: [{ dseq: n0, t: Date.now(), by: "person", op: "mkdir", path: "/l", kind: "folder", fid: "0000000000000f01" }] }))?.ops?.[0]?.seq), "(a plaintext op: the object exists)");
  ws0.ws.close();
  const acct = await objectOf(L);
  ok((await acct.testOldIndexRefs()) === true, "(the table dropped, as an object made before it has none)");
  await acct.crash().catch(() => {});
  ok(await until(async () => (await (await objectOf(L)).inspect({}).catch(() => null)) !== null, 5_000), "(the object restarted)");
  const W = account(L);
  const g = await W.genesis();
  ok((await post(s, L, "/api/sync/v1/e2e/chain", g.body)).status === 201, "(genesis)");
  const ws = await socket(s);
  let n = (await hello(ws, "sealed-dev-l001")).next_dseq;
  const blob = Buffer.from("an old object's blob");
  ok((await putBlob(s, blob)).status === 201, "(a blob held)");
  const a1 = await ws.ask({ t: "sops", ops: [await signed(W, g.d, g.next, "sealed-dev-l001", n, { adds: [sha(blob)] })] });
  const r1 = Number.isInteger(a1?.ops?.[0]?.seq) ? await ws.ask({ t: "sops", ops: [await signed(W, g.d, g.next, "sealed-dev-l001", n + 1, { releases: [{ address: sha(blob), add: a1.ops[0].seq }] })] }) : null;
  const ix = (await (await objectOf(L)).inspect({}))?.index_refs ?? [];
  ok(Number.isInteger(r1?.ops?.[0]?.seq) && ix.length === 1 && ix[0].released_seq === r1.ops[0].seq, "after the restart: an add and its release accepted, the add recorded and ended: " + J({ a1: a1?.ops ?? a1, r1: r1?.ops ?? r1, ix }));
  ws.ws.close();
});

await section("an encrypted account's agents' index: off, every route that reads it refused, before and after the first sealed op", async () => {
  const agentCall = (token, verb, params) => at(SITE, "/api/agent/v1/" + verb, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(params) });
  const grant = async (s, id) => (await (await post(s, id, "/api/sync/v1/grants", { agent: "an agent", scopes: [{ path: "/", access: "read" }] })).json()).token;
  const s = await enabled(X);
  const ws = await socket(s);
  const n = (await hello(ws, "sealed-dev-x001")).next_dseq;
  const mk = await ws.ask({ t: "ops", ops: [{ dseq: n, t: Date.now(), by: "person", op: "mkdir", path: "/before", kind: "folder", fid: "0000000000000d01" }] });
  ok(Number.isInteger(mk?.ops?.[0]?.seq), "(a plaintext op, before the account has a key chain)");
  const token = await grant(s, X);
  let st = null;
  const ax = await objectOf(X);
  for (let k = 0; k < 100 && st?.status !== 200; k++) {
    await ax.testIndex({ step: true });
    st = await agentCall(token, "stat", { path: "/before" });
    if (st.status !== 200) await new Promise((r) => setTimeout(r, 50));
  }
  ok(st?.status === 200, "(before its key chain: the agents' index is built and answers)");
  const W = account(X);
  const g = await W.genesis();
  ok((await post(s, X, "/api/sync/v1/e2e/chain", g.body)).status === 201, "(its key chain made: the account is encrypted from here)");
  const refused = async (what) => {
    const r = await agentCall(token, what.verb, what.params);
    const b = await r.json().catch(() => ({}));
    return r.status === 409 && b.error === "conflict" && b.reason === "encrypted";
  };
  const verbs = [{ verb: "stat", params: { path: "/before" } }, { verb: "list", params: { folder: "/" } }, { verb: "list", params: { folder: "/", recursive: true } }];
  const before = await Promise.all(verbs.map(refused));
  ok(before.every(Boolean), "before its first sealed op: stat, list and a recursive list are refused (409 conflict, encrypted), the index it had never read: " + J(before));
  const rb = await at(SITE, "/api/sync/v1/index/rebuild", { method: "POST", headers: { ...hdr(s, X, SITE), "content-type": "application/json" }, body: "{}" });
  const rbb = await rb.json().catch(() => ({}));
  ok(rb.status === 409 && rbb.reason === "encrypted", "rebuilding the index is refused too: " + J({ status: rb.status, body: rbb }));
  const ix0 = await ax.testIndex({});
  const pl = await ws.ask({ t: "ops", ops: [{ dseq: n + 1, t: Date.now(), by: "person", op: "mkdir", path: "/after-chain", kind: "folder", fid: "0000000000000d02" }] });
  ok(Number.isInteger(pl?.ops?.[0]?.seq), "(a plaintext op after its key chain)");
  const ix1 = await ax.testIndex({});
  ok(ix1.cursor === ix0.cursor && ix1.entries === ix0.entries && ix1.max > ix0.max, "the ready index takes no op past the key chain (nothing applied live): " + J({ before: [ix0.cursor, ix0.entries], after: [ix1.cursor, ix1.entries], max: ix1.max }));
  const op = await signed(W, g.d, g.next, "sealed-dev-x001", n + 2);
  ok(Number.isInteger((await ws.ask({ t: "sops", ops: [op] }))?.ops?.[0]?.seq), "(a sealed op accepted)");
  const after = await Promise.all(verbs.map(refused));
  ok(after.every(Boolean), "after it: still refused, every one: " + J(after));
  const acct = await objectOf(X);
  const ix = await acct.testIndex({});
  ok(ix && ix.state !== "building", "the index isn't building any more for it (nothing derives from a log it can't read): " + J(ix?.state));
  ws.ws.close();
  // (an account with a key chain before its first grant: the grant starts no index; a plaintext account is unchanged)
  const sy = await enabled(Y);
  const Wy = account(Y);
  const gy = await Wy.genesis();
  ok((await post(sy, Y, "/api/sync/v1/e2e/chain", gy.body)).status === 201, "(Y: a key chain first)");
  const ty = await grant(sy, Y);
  const iy = await (await objectOf(Y)).testIndex({});
  ok((await agentCall(ty, "stat", { path: "/" })).status === 409 && (iy?.state ?? null) === null,
    "Y: its first grant starts no index, and its agents' stat is refused: " + J(iy?.state ?? null));
  // (an index still building when the key chain is made: no step builds it further, and the alarm stops waking for it)
  const sz = await enabled(Z);
  const wz = await socket(sz);
  const nz = (await hello(wz, "sealed-dev-z001")).next_dseq;
  ok(Number.isInteger((await wz.ask({ t: "ops", ops: [{ dseq: nz, t: Date.now(), by: "person", op: "mkdir", path: "/z", kind: "folder", fid: "0000000000000d03" }] }))?.ops?.[0]?.seq), "(Z: a plaintext op)");
  wz.ws.close();
  const az = await objectOf(Z);
  await az.testIndex({ manual: true });
  const tz = await grant(sz, Z);
  ok(tz && (await az.testIndex({})).state === "building", "(Z: its first grant starts the index, held at its first step)");
  const gz = await account(Z).genesis();
  ok((await post(sz, Z, "/api/sync/v1/e2e/chain", gz.body)).status === 201, "(Z: its key chain made while the index builds)");
  let iz = null;
  for (let k = 0; k < 3; k++) iz = await az.testIndex({ step: true });
  ok(iz.state === "building" && iz.cursor === 0 && iz.entries === 0, "Z: no step builds the index further once the account is encrypted: " + J({ state: iz.state, cursor: iz.cursor, entries: iz.entries }));
  await new Promise((r) => setTimeout(r, 1500));
  const za = (await az.testIndex({})).alarm;
  ok(za === null || za > Date.now() + 60_000, "Z: the alarm no longer wakes at once for an index it won't build: " + J(za === null ? null : za - Date.now()));
  const sn = await enabled(N);
  const tn = await grant(sn, N);
  const pn = await agentCall(tn, "stat", { path: "/" });
  const bn = await pn.json().catch(() => ({}));
  ok(bn.reason !== "encrypted" && [200, 503].includes(pn.status), "a plaintext account's agents' stat is answered as before: " + pn.status);
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

await section("S07: a sealed op in flight when its session signs out is not committed", async () => {
  const s = await enabled(F);
  const W = account(F);
  const g = await W.genesis();
  ok((await post(s, F, "/api/sync/v1/e2e/chain", g.body)).status === 201, "(genesis)");
  const dev = "sealed-dev-f001";
  const ws = await socket(s);
  const w = await hello(ws, dev);
  const before = await signed(W, g.d, g.next, dev, w.next_dseq);
  ok(Number.isInteger((await ws.ask({ t: "sops", ops: [before] }))?.ops?.[0]?.seq), "(one op in the log)");
  // (a signed op held between its checks and its commit; meanwhile its session signs out through /auth/logout)
  const held = await signed(W, g.d, g.next, dev, w.next_dseq + 1);
  await seam(F, { sealedHold: 1500 });
  const pending = ws.ask({ t: "sops", ops: [held] });
  await new Promise((r) => setTimeout(r, 200));
  const out = await at(SITE, "/auth/logout", { method: "POST", headers: { cookie: s, origin: SITE } });
  ok(out.status === 200, "(the op's session signs out while the op is held)");
  await pending;
  await new Promise((r) => setTimeout(r, 1600));
  await seam(F, { sealedHold: 0 });
  // (another session of the account: the log, and the device's order)
  const s2 = await signIn(F);
  const ws2 = await socket(s2);
  const w2 = await hello(ws2, dev);
  const log = (await ws2.ask({ t: "pull_index", after: 0 }))?.ops ?? [];
  ok(log.every((o) => o.env !== held.env) && log.some((o) => o.env === before.env), "an op held across its session's sign-out is not committed: the log has the op before it and not it");
  ok(w2.next_dseq === held.dseq, `and the device's order didn't move: its next dseq is still the held op's (${w2.next_dseq})`);
  // (a session that reaches its end during the hold, with no sign-out: refused at the commit, nothing stored)
  {
    const s3 = await signIn(F);
    const until = Math.floor(Date.now() / 1000) + 4;
    await db.prepare("UPDATE sessions SET expires = ?1 WHERE token_hash = ?2").bind(until, createHash("sha256").update(decodeURIComponent(s3.split("=")[1])).digest("hex")).run();
    const ws3 = await socket(s3);
    const w3 = await hello(ws3, dev);
    const late = await signed(W, g.d, g.next, dev, w3.next_dseq);
    await seam(F, { sealedHold: 6000 });
    const pend = ws3.ask({ t: "sops", ops: [late] });
    while (Date.now() < until * 1000 + 2500) await new Promise((r) => setTimeout(r, 100));
    await pend;
    await new Promise((r) => setTimeout(r, Math.max(0, until * 1000 + 3500 - Date.now())));
    await seam(F, { sealedHold: 0 });
    const log3 = (await ws2.ask({ t: "pull_index", after: 0 }))?.ops ?? [];
    ok(log3.every((o) => o.env !== late.env), "a sealed op whose session reaches its end while it's held between its checks and its commit is not committed");
  }
  // (control: the same hold with the session kept commits)
  await seam(F, { sealedHold: 600 });
  const kept = await ws2.ask({ t: "sops", ops: [await signed(W, g.d, g.next, dev, w2.next_dseq)] });
  await seam(F, { sealedHold: 0 });
  ok(Number.isInteger(kept?.ops?.[0]?.seq), "control: the same hold, its session kept, is committed");
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
