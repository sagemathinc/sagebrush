// ci: web-sync.2 order=75
// The E2E key chain and the enrollment mailbox on the sync server (design/e2e-encryption.md §2, PR 2c), in Miniflare
// with real Durable Objects (SQLite). Entries, keyrings and wrappers are made here with the E2E core
// (web/workspace/e2e/core), as a device makes them, and the server checks them with the same core. Behind SYNC_E2E,
// DEV only.
//
//   node web/sync/test-e2e-chain.mjs
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
const A = "e2e2e2e2-0001-4e2e-8e2e-e2e2e2e2e201"; // the main account
const B = "e2e2e2e2-0002-4e2e-8e2e-e2e2e2e2e202"; // another account
const P = "e2e2e2e2-0003-4e2e-8e2e-e2e2e2e2e203"; // a sync-data purge, then a CoCalc purge
const M = "e2e2e2e2-0004-4e2e-8e2e-e2e2e2e2e204"; // the mailbox
const R = "e2e2e2e2-0005-4e2e-8e2e-e2e2e2e2e205"; // read-only
const SITE = "https://sagebrush.test";
const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8" });
const base = { modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"] };
const shareBindings = { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", COCALC_ORIGIN: "https://cocalc.test", COCALC_CLIENT_SECRET: "client-secret", PURGE_KEY, LIMITS_KEY: "limits-key" };
const plan = { storage_bytes: 1 << 30, max_file_bytes: 1 << 20, sync: { enabled: true, version_bytes: 1 << 20, read_bytes_per_day: 1 << 30 } };
const cocalc = async () => Response.json(plan);
const objects = { SYNC_ACCOUNT: { className: "SyncAccount", useSQLite: true }, SYNC_DOC: { className: "SyncDoc", useSQLite: true } };
const ratelimits = (id) => ({ SYNC_PREAUTH: { namespace_id: id, simple: { limit: 1_000_000, period: 60 } }, SYNC_INGRESS_IP: { namespace_id: "8" + id, simple: { limit: 1_000_000, period: 60 } }, SYNC_ACCOUNT_INGRESS: { namespace_id: "9" + id, simple: { limit: 1_000_000, period: 60 } }, SYNC_ADMIN_LIMIT: { namespace_id: "7" + id, simple: { limit: 1_000_000, period: 60 } } });
const listed = [A, B, P, M, R].join(",");
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [
    { ...base, name: "on", bindings: { ...shareBindings, SYNC_ACCOUNTS: listed, SYNC_E2E: "1", SYNC_TEST_PIN_MS: "1000" }, durableObjects: objects, routes: ["sagebrush.test/*"], outboundService: cocalc, ratelimits: ratelimits("4101") },
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
const seam = async (id, v) => (await at(SITE, "/__test/e2e?account=" + id, { method: "POST", body: JSON.stringify(v) })).json();
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
      ring = await E.sealKeyring({ S, account: ctx.account, n, suite: 1, prev: state.head, secrets: new Map(W.secrets) });
      keyring = { hash: ring.hash, epochs: [...ring.epochs] };
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
  return W;
}

await section("the switch", async () => {
  const s = await enabled(A, "https://off.test");
  for (const [m, path] of [["GET", "/api/sync/v1/e2e/chain"], ["POST", "/api/sync/v1/e2e/chain"], ["GET", "/api/sync/v1/e2e/wrapper?kind=recovery"], ["GET", "/api/sync/v1/e2e/keyring/1"], ["POST", `/api/sync/v1/e2e/enroll/${newId()}/1`]])
    ok((await (m === "GET" ? get(s, A, path, "https://off.test") : post(s, A, path, {}, "https://off.test"))).status === 404, `off: ${m} ${path.split("?")[0]} is a 404`);
});

let sA, WA, stA;
await section("the chain: genesis, add, remove", async () => {
  sA = await enabled(A);
  WA = account(A);
  const empty = await answer(await get(sA, A, "/api/sync/v1/e2e/chain"));
  ok(empty.status === 200 && empty.entries.length === 0 && empty.head === null && empty.account === WA.ctx.account && empty.aud === AUD, "no chain yet: an empty page, the account's E2E id and audience");
  ok((await seam(A, {})).e2e_chain === -1, "no E2E table exists before the first append (made on first use)");
  const g = await WA.genesis();
  const r = await answer(await post(sA, A, "/api/sync/v1/e2e/chain", g.body));
  ok(r.status === 201 && r.seq === 0 && r.head === g.next.head, "genesis with its package is stored: " + r.status);
  stA = g.next;
  const ch = await answer(await get(sA, A, "/api/sync/v1/e2e/chain"));
  ok(ch.entries.length === 1 && ch.entries[0] === g.body.entry && ch.head.seq === 0 && ch.head.hash === stA.head, "the chain reads back byte for byte, with its head");
  const wd = await answer(await get(sA, A, `/api/sync/v1/e2e/wrapper?kind=device&id=${g.d.id}`));
  ok(wd.status === 200 && wd.wrapper === g.body.wrappers[0] && wd.epoch === 0, "the device's wrapper for epoch 0");
  const got = await E.openWrapper({ hpke, state: stA, ctx: WA.ctx, bytes: new TextEncoder().encode(wd.wrapper), me: { kind: "device", id: g.d.id, recipient: g.d.kem }, seen: () => false });
  ok(Buffer.from(got.S).equals(Buffer.from(g.ep.S)), "and it opens on the device to the epoch's secret");
  const wr = await answer(await get(sA, A, "/api/sync/v1/e2e/wrapper?kind=recovery"));
  ok(wr.status === 200 && wr.wrapper === g.body.wrappers[1], "the recovery key's wrapper, by account alone");
  ok((await get(sA, A, `/api/sync/v1/e2e/wrapper?kind=recovery&id=${WA.ctx.account}`)).status === 400, "a caller's id for the recovery key is refused");
  ok((await get(sA, A, `/api/sync/v1/e2e/wrapper?kind=device&id=${newId()}`)).status === 404, "no wrapper for a device that isn't current");
  ok((await get(sA, A, "/api/sync/v1/e2e/wrapper?kind=device&id=x")).status === 400, "a malformed device id is refused");

  // an add whose package lacks the new device's wrapper is refused, and nothing is stored
  const add = await WA.add(stA, g.d);
  const bad = await answer(await post(sA, A, "/api/sync/v1/e2e/chain", { ...add.body, wrappers: [] }));
  ok(bad.status === 400 && bad.reason === "bad_package", "an add without its wrapper is refused (bad_package): " + bad.status);
  ok((await seam(A, {})).e2e_chain === 1, "and nothing of it was stored");
  ok((await answer(await post(sA, A, "/api/sync/v1/e2e/chain", { ...add.body, keyring: b64(random(44)) }))).reason === "bad_package", "nor with a keyring where no epoch needs one");
  const ar = await answer(await post(sA, A, "/api/sync/v1/e2e/chain", add.body));
  ok(ar.status === 201 && ar.seq === 1, "the add with its wrapper is stored");
  stA = add.next;
  WA.devices.push(add.nd);

  // a stale append: another add, made on the head before the one just stored
  const stale = await WA.add(g.next, g.d);
  const sr = await answer(await post(sA, A, "/api/sync/v1/e2e/chain", stale.body));
  ok(sr.status === 409 && sr.reason === "chain_fork" && !JSON.stringify(sr).includes(stale.body.entry.slice(0, 40)), "an append on an old head is refused as stale (409), with no payload in the answer");

  // remove the phone: a new epoch, its keyring, wrappers to the laptop and recovery
  const rm = await WA.remove(stA, g.d, add.nd);
  const rr = await answer(await post(sA, A, "/api/sync/v1/e2e/chain", rm.body));
  ok(rr.status === 201 && rr.seq === 2, "a removal with its keyring and every wrapper is stored");
  stA = rm.next;
  WA.secrets.set(1, rm.ep.S);
  WA.devices = rm.left;
  const k1 = await answer(await get(sA, A, "/api/sync/v1/e2e/keyring/1"));
  ok(k1.status === 200 && k1.keyring === rm.body.keyring, "the current epoch's keyring");
  ok((await get(sA, A, "/api/sync/v1/e2e/keyring/2")).status === 404, "no keyring for an epoch that doesn't exist");
  ok((await get(sA, A, `/api/sync/v1/e2e/wrapper?kind=device&id=${add.nd.id}`)).status === 404, "the removed device has no wrapper any more");
  const wl = await answer(await get(sA, A, `/api/sync/v1/e2e/wrapper?kind=device&id=${g.d.id}`));
  ok(wl.epoch === 1 && wl.seq === 2, "the laptop's wrapper is the new epoch's");
  const rows = await seam(A, {});
  ok(rows.e2e_wrappers === 2 && rows.e2e_keyrings === 1 && rows.e2e_chain === 3, "only the current epoch's wrappers (laptop, recovery) and keyring are kept: " + JSON.stringify(rows));
});

await section("refusals: another account, binding, form", async () => {
  const sB = await enabled(B);
  const WB = account(B);
  // (an entry made for A's account, posted to B's chain)
  const fresh = account(A);
  const ga = await fresh.genesis();
  const r = await answer(await post(sB, B, "/api/sync/v1/e2e/chain", ga.body));
  ok(r.status === 400 && r.reason === "bad_form", "another account's entry is refused before anything is stored: " + r.reason);
  ok((await seam(B, {})).e2e_chain <= 0, "nothing stored for B");
  ok((await post(sB, B, "/api/sync/v1/e2e/chain", (await WB.genesis()).body, SITE, { "x-sync-account": hashOf(A) })).status === 403, "a binding to another account is refused (403)");
  ok((await get(sB, B, "/api/sync/v1/e2e/chain", SITE, { "x-sync-generation": "99" })).status === 409, "a binding to another generation is refused (409)");
  ok((await post(sB, B, "/api/sync/v1/e2e/chain", { entry: "x", extra: 1 })).status === 400, "an unknown field is refused");
  ok((await post(sB, B, "/api/sync/v1/e2e/chain", { entry: 5, wrappers: [] })).status === 400, "an entry that isn't text is refused");
  ok((await post(sB, B, "/api/sync/v1/e2e/chain", { entry: "{}", wrappers: Array(65).fill("x") })).status === 400, "more than 64 wrappers are refused");
  ok((await get(sB, B, "/api/sync/v1/e2e/chain?from=-1")).status === 400, "a bad page start is refused");
  ok((await at(SITE, "/api/sync/v1/e2e/chain", { headers: { cookie: sB } })).status === 403, "from another site (no Origin), refused");
  ok((await at(SITE, "/api/sync/v1/e2e/chain", { headers: { origin: SITE } })).status === 401, "without a session, refused");
});

await section("concurrency and restart", async () => {
  // two removals of different devices on one head: exactly one is stored
  const ad = await WA.add(stA, WA.devices[0]);
  ok((await post(sA, A, "/api/sync/v1/e2e/chain", ad.body)).status === 201, "(another device added)");
  stA = ad.next;
  WA.devices.push(ad.nd);
  const ad2 = await WA.add(stA, WA.devices[0]);
  ok((await post(sA, A, "/api/sync/v1/e2e/chain", ad2.body)).status === 201, "(and another)");
  stA = ad2.next;
  WA.devices.push(ad2.nd);
  const x = await WA.remove(stA, WA.devices[0], ad.nd), y = await WA.remove(stA, WA.devices[0], ad2.nd);
  // (each append held between its checks and its transaction, so both pass their checks on the same head)
  await seam(A, { hold: 400 });
  const both = await Promise.all([post(sA, A, "/api/sync/v1/e2e/chain", x.body), post(sA, A, "/api/sync/v1/e2e/chain", y.body)]);
  await seam(A, { hold: 0 });
  const st = both.map((r) => r.status).sort();
  const lost = await answer(both.find((r) => r.status !== 201) ?? both[1]);
  ok(st.join() === "201,409" && lost.reason === "chain_fork", "two appends checked on one head at once: the transaction's own head check stores one and refuses the other as stale: " + st.join());
  const won = both[0].status === 201 ? x : y;
  stA = won.next;
  WA.secrets.set(won.ep.n, won.ep.S);
  WA.devices = won.left;
  const rows = await seam(A, {});
  ok(rows.e2e_keyrings === 1, "a second new epoch: only its own keyring is kept: " + rows.e2e_keyrings);
  ok((await get(sA, A, "/api/sync/v1/e2e/keyring/1")).status === 404, "the earlier epoch's keyring isn't served");
  // (replacing the recovery code: its new wrapper replaces the old key's, for the same recipient)
  const rk2 = await E.recoveryKeys(E.newRecoverySeed(), WA.ctx.account);
  const draft = E.nextBody(stA, WA.ctx, "replace-recovery", { recovery: { sign: b64(rk2.sign.raw), kem: b64(rk2.kem.publicRaw) }, pop: null });
  const pre = await E.preEntryHash(draft);
  const chg = await E.challenge(hpke, rk2.kem.publicRaw, pre);
  const mac = await E.respond(hpke, rk2.kem, chg.enc, pre);
  await E.checkResponse(chg.secret, chg.enc, pre, mac);
  const rep = await E.sealEntry(WA.devices[0].signer, { ...draft, pop: { enc: b64(chg.enc), mac: b64(mac) } }, WA.devices[0].sign, { recovery: rk2.sign });
  const rp = await WA.pack(stA, rep, WA.devices[0], [{ kind: "recovery", id: WA.ctx.account }], won.ep.S, won.ep.n);
  const wrappersBefore = (await seam(A, {})).e2e_wrappers;
  ok((await post(sA, A, "/api/sync/v1/e2e/chain", rp.body)).status === 201, "(the recovery code replaced)");
  stA = rp.next;
  ok((await seam(A, {})).e2e_wrappers === wrappersBefore && (await answer(await get(sA, A, "/api/sync/v1/e2e/wrapper?kind=recovery"))).wrapper === rp.body.wrappers[0], "the new recovery key's wrapper replaces the old one's (one row per recipient)");
  // the object restarts: its cache is gone, and the next append replays from storage
  await (await objectOf(A)).crash().catch(() => {});
  await until(async () => (await get(sA, A, "/api/sync/v1/e2e/chain")).status === 200);
  const ch = await answer(await get(sA, A, "/api/sync/v1/e2e/chain"));
  ok(ch.head.seq === stA.seq && ch.head.hash === stA.head, "after a restart, the chain and its head are the same");
  const ad3 = await WA.add(stA, WA.devices[0]);
  ok((await post(sA, A, "/api/sync/v1/e2e/chain", ad3.body)).status === 201, "and an append after the restart is checked and stored");
  stA = ad3.next;
  WA.devices.push(ad3.nd);
  // a commit that fails after its writes: nothing is stored, and the next append is checked against storage, not a
  // cache that already counted the failed one
  const ad4 = await WA.add(stA, WA.devices[0]);
  await seam(A, { failCommit: true });
  const before = await seam(A, {});
  const failed = await post(sA, A, "/api/sync/v1/e2e/chain", ad4.body).catch(() => ({ status: 0 }));
  const after = await seam(A, {});
  ok(failed.status >= 500 || failed.status === 0, "an append whose commit fails isn't answered as stored: " + failed.status);
  ok(after.e2e_chain === before.e2e_chain && after.e2e_wrappers === before.e2e_wrappers && after.e2e_head === before.e2e_head, "and none of its rows stay");
  ok((await post(sA, A, "/api/sync/v1/e2e/chain", ad4.body)).status === 201, "the same append again is checked against storage and stored");
  stA = ad4.next;
  WA.devices.push(ad4.nd);
  const page = await answer(await get(sA, A, "/api/sync/v1/e2e/chain?from=3"));
  ok(page.from === 3 && page.entries.length === stA.seq - 2, "a page from a position");
});

await section("read-only accounts still change their chain", async () => {
  const s = await enabled(R);
  const W = account(R);
  const g = await W.genesis();
  ok((await post(s, R, "/api/sync/v1/e2e/chain", g.body)).status === 201, "(genesis)");
  // (the plan lapses: CoCalc's signed notice of a plan without sync makes the account read-only)
  const body = JSON.stringify({ request_id: crypto.randomUUID(), account_id: R, issued: Math.floor(Date.now() / 1000), limits: { ...plan, sync: { ...plan.sync, enabled: false } } });
  const n = await signedPost("limits-key", "/api/admin/limits", body);
  const st = await answer(await at(SITE, "/api/sync/v1/status", { headers: { cookie: s, origin: SITE } }));
  ok(n.status < 300 && st.state === "readonly", "the account is read-only now: " + n.status + " " + st.state);
  const ad = await W.add(g.next, g.d);
  ok((await post(s, R, "/api/sync/v1/e2e/chain", ad.body)).status === 201, "and a key-chain change still goes through (a safety action)");
  ok((await post(s, R, `/api/sync/v1/e2e/enroll/${newId()}/1`, { msg: "m" })).status === 201, "and so does the enrollment mailbox");
});

await section("the enrollment mailbox", async () => {
  const s = await enabled(M);
  const S1 = newId();
  const put = (sess, ph, msg) => post(s, M, `/api/sync/v1/e2e/enroll/${sess}/${ph}`, { msg });
  const read = (sess, ph) => get(s, M, `/api/sync/v1/e2e/enroll/${sess}/${ph}`);
  ok((await put(S1, 2, "m2")).status === 404, "phase 2 of a session that doesn't exist is refused");
  const p1 = await answer(await put(S1, 1, "m1"));
  ok(p1.status === 201 && p1.expires > Date.now() + 9 * 60_000, "phase 1 opens the session, for 10 minutes");
  ok((await put(S1, 3, "m3")).status === 400, "phase 3 before phase 2 is refused (order)");
  ok((await answer(await read(S1, 1))).msg === "m1", "phase 1 reads back");
  ok((await read(S1, 2)).status === 404, "phase 2 isn't there yet");
  const dup = await Promise.all([put(S1, 2, "a"), put(S1, 2, "b")]);
  ok(dup.map((r) => r.status).sort().join() === "201,400", "two posts of one phase at once: one is kept");
  ok((await put(S1, 1, "again")).status === 400, "a phase is written once");
  ok((await post(s, M, `/api/sync/v1/e2e/enroll/${S1}/6`, { msg: "x" })).status === 404 && (await post(s, M, `/api/sync/v1/e2e/enroll/${S1.toUpperCase()}/1`, { msg: "x" })).status === 404, "phases past 5 and non-canonical ids are not routes");
  ok((await put(newId(), 1, "x".repeat(16 << 10) + "x")).status === 400, "a message over 16 KiB is refused");
  // expiry: the server's clock moves past the deadline, and a read with no write in between is refused
  await seam(M, { shift: 11 * 60_000 });
  ok((await read(S1, 1)).status === 404, "after its deadline a session's messages aren't served (no sweep needed)");
  ok((await put(S1, 3, "late")).status === 404, "nor written");
  ok((await put(S1, 1, "reopen")).status === 404, "and its id can't be opened again (its rows stay, refusing it)");
  await seam(M, { shift: 0 });
  // the live-session bound
  const opened = [];
  for (let i = 0; i < 16; i++) opened.push((await put(newId(), 1, "m")).status);
  ok(opened.filter((x) => x === 201).length === 15 || opened.every((x) => x === 201), "(sessions opened up to the bound)");
  ok((await put(newId(), 1, "m")).status === 413, "a 17th live session is refused");
});

await section("deleting the synced data keeps the chain; deleting the account doesn't", async () => {
  const s = await enabled(P);
  const W = account(P);
  const g = await W.genesis();
  ok((await post(s, P, "/api/sync/v1/e2e/chain", g.body)).status === 201, "(genesis)");
  const ad = await W.add(g.next, g.d);
  ok((await post(s, P, "/api/sync/v1/e2e/chain", ad.body)).status === 201, "(an add)");
  ok((await post(s, P, `/api/sync/v1/e2e/enroll/${newId()}/1`, { msg: "m" })).status === 201, "(a mailbox message)");
  const gen = (await db.prepare("SELECT generation FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(P)).first())?.generation;
  const del = await at(SITE, "/api/sync/v1/delete", { method: "POST", headers: { cookie: s, origin: SITE, "content-type": "application/json" }, body: JSON.stringify({ confirm: "delete", generation: gen }) });
  ok(del.status === 202, "the synced data's deletion starts: " + del.status);
  ok((await get(s, P, "/api/sync/v1/e2e/chain")).status === 409 || (await get(s, P, "/api/sync/v1/e2e/chain")).status === 403, "while it runs, the chain is refused");
  const acct = await objectOf(P);
  ok(await until(async () => { await acct.wakeNow().catch(() => {}); return (await acct.lifecycle())?.state === null; }, 30_000), "the deletion finishes");
  const kept = await seam(P, {});
  ok(kept.e2e_chain === 2 && kept.e2e_head === 1 && kept.e2e_wrappers >= 2 && kept.e2e_mailbox === -1, "the chain, its head and its current wrappers stay; the mailbox goes: " + JSON.stringify(kept));
  const s2 = await enabled(P);
  const ch = await answer(await get(s2, P, "/api/sync/v1/e2e/chain"));
  ok(ch.head?.seq === 1 && ch.head.hash === ad.next.head, "sync on again (a new generation): the same chain and head, so every device's pin still holds");
  ok((await get(s2, P, "/api/sync/v1/e2e/wrapper?kind=recovery")).status === 200, "and recovery's wrapper is still there");
  // CoCalc deletes the account: every E2E row goes
  const rid = crypto.randomUUID();
  ok((await signedPost(PURGE_KEY, "/api/admin/purge", JSON.stringify({ account_id: P, request_id: rid }))).status === 202, "(CoCalc deletes the account)");
  ok(await until(async () => { await acct.wakeNow().catch(() => {}); return (await acct.lifecycle())?.state === null && (await acct.lifecycle())?.deleted === true; }, 30_000), "the account's deletion finishes");
  const gone = await seam(P, {});
  ok(Object.values(gone).every((n) => n === -1), "no E2E table is left: " + JSON.stringify(gone));
});

await mf.dispose();
console.log(failures ? `\n${failures} of ${count} FAILED` : `\nall ${count} passed`);
process.exit(failures ? 1 : 0);
