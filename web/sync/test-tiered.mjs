// ci: web-sync.2 order=60
// Chunked files on the sync server (design/tiered-files.md §4.1, §4.3, §7 PR 2): manifests registered, verified by
// the server against the whole-file hash a few chunks per call, and only then usable by an op; behind the
// SYNC_TIERED switch, DEV only.  In Miniflare with real Durable Objects (SQLite) and R2.  Last, a randomized state
// machine (§3.4's test, @sagebrush item 7, for the server's half): seeded random interleavings of uploads,
// registrations (right and wrong), verify steps (some held mid-stream), rekeys, ops and retirements, with the
// invariants checked after every step.
//
//   node web/sync/test-tiered.mjs [--seeds N] [--steps N] [--seed S]
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { dispatch } from "../miniflare-dispatch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// (the TypeScript units, bundled by bun as the Worker is, and imported from that bundle)
const units = execFileSync("bun", ["build", join(here, "test-tiered-units.ts"), "--format", "esm", "--target", "node"], { encoding: "utf8" });
const { Sha256, checkManifest, canonical, tieredOn } = await import("data:text/javascript;base64," + Buffer.from(units).toString("base64"));
const require = createRequire(join(here, "../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

let failures = 0, count = 0;
function ok(cond, what) {
  count++;
  if (!cond) {
    failures++;
    console.log("FAIL", what);
  }
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const MiB = 1 << 20;
const arg = (name, d) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};

// ---- units: the resumable SHA-256, the manifest's checks, the switch
{
  let bad = 0;
  for (let t = 0; t < 200; t++) {
    const len = t < 130 ? t : Math.floor(Math.random() * 200_000);
    const data = randomBytes(len);
    let h = new Sha256();
    for (let i = 0; i < len; ) {
      const k = Math.min(len - i, 1 + Math.floor(Math.random() * 3000));
      h.update(data.subarray(i, i + k));
      i += k;
      if (Math.random() < 0.3) h = Sha256.from(JSON.parse(JSON.stringify(h.save())));
    }
    if (h.hexDigest() !== sha(data) || h.length !== len) bad++;
  }
  ok(bad === 0, "the resumable SHA-256 matches node's on 200 inputs, saved and restored at random points: " + bad + " bad");
  let threw = 0;
  for (const s of [{ h: "x", n: 0, rest: "" }, { h: "0".repeat(64), n: 3, rest: "" }, { h: "0".repeat(64), n: 1, rest: "00".repeat(64) }]) {
    try {
      Sha256.from(s);
    } catch {
      threw++;
    }
  }
  ok(threw === 3, "a malformed saved state is refused");
  const c = (n) => ["a".repeat(64), n];
  const good = { v: 1, cdc: "fastcdc-gear-v1/1M/4M/8M", sha256: "b".repeat(64), size: 9 * MiB, chunks: [c(8 * MiB), c(MiB)] };
  const code = (m, max = 200 * MiB) => {
    try {
      checkManifest(m, max);
      return "ok";
    } catch (e) {
      return e.code;
    }
  };
  ok(code(good) === "ok", "a good manifest passes");
  ok(code({ ...good, cdc: "other" }) === "invalid", "an unknown chunker is refused");
  ok(code({ ...good, size: 8 * MiB, chunks: [c(7 * MiB), c(MiB)] }) === "invalid", "a file no larger than the largest chunk isn't chunked");
  ok(code({ ...good, chunks: [c(8 * MiB), c(MiB - 1)] }) === "invalid", "sizes that don't add up are refused");
  ok(code({ ...good, size: 9 * MiB, chunks: [c(MiB - 1), c(8 * MiB + 1)] }) === "invalid", "a chunk outside the bounds (not last) is refused");
  ok(code({ ...good, size: 8 * MiB + 1 + 0, chunks: [c(8 * MiB), c(1)] }) === "ok", "the last chunk may be shorter than the minimum");
  ok(code({ ...good, extra: 1 }) === "invalid", "an unknown field is refused");
  ok(code(good, 9 * MiB - 1) === "limit", "a file over max_file_bytes is refused (limit), at one over");
  ok(code(good, 9 * MiB) === "ok", "and at the limit it passes");
  const many = (n) => ({ ...good, size: n * MiB, chunks: Array.from({ length: n }, () => c(MiB)) });
  const lim = (m) => {
    try {
      checkManifest(m, 300 * MiB);
    } catch (e) {
      return e.detail?.limit;
    }
  };
  ok(code(many(200)) === "ok" && lim(many(257)) === "chunks" && lim(many(201)) === "max_file_bytes", "200 chunks of 1 MiB pass (the 200 MiB file limit); 257 are refused by the chunk count, 201 by the file limit");
  ok(canonical(checkManifest({ chunks: good.chunks, size: good.size, sha256: good.sha256, cdc: good.cdc, v: 1 }, 200 * MiB)) === canonical(good), "the canonical JSON doesn't depend on field order");
  ok(tieredOn({ SYNC_TIERED: "1", SHARE_DEV: "1" }) && !tieredOn({ SYNC_TIERED: "1" }) && !tieredOn({ SHARE_DEV: "1" }) && !tieredOn({ SYNC_TIERED: "0", SHARE_DEV: "1" }), "the switch is on only with SYNC_TIERED 1 on DEV (SHARE_DEV 1)");
}

// ---- the Worker
const A = "a1a1a1a1-0001-4a1a-8a1a-a1a1a1a1a101"; // the deterministic cases
const B = "a1a1a1a1-0002-4a1a-8a1a-a1a1a1a1a102"; // a small verification budget
const R = "a1a1a1a1-0003-4a1a-8a1a-a1a1a1a1a103"; // the randomized state machine
const E = "a1a1a1a1-0005-4a1a-8a1a-a1a1a1a1a105"; // CoCalc sends a malformed verify_bytes_per_day
const Z = "a1a1a1a1-0006-4a1a-8a1a-a1a1a1a1a106"; // CoCalc sends verify_bytes_per_day 0
const C = "a1a1a1a1-0004-4a1a-8a1a-a1a1a1a1a104"; // storage exactly full after one registration (daybreak3's #880 finding)
const SITE = "https://sagebrush.test";
const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8" });
const base = { modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"] };
const shareBindings = { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", COCALC_ORIGIN: "https://cocalc.test", COCALC_CLIENT_SECRET: "client-secret" };
const limits = (verify) => ({ storage_bytes: 1 << 30, max_file_bytes: 200 * MiB, sync: { enabled: true, version_bytes: 1 << 20, read_bytes_per_day: 1 << 30, ...(verify !== undefined ? { verify_bytes_per_day: verify } : {}) } });
// (C's storage: its two chunks and one manifest, exactly)
const capA = Buffer.alloc(8 * MiB, 1), capB = Buffer.alloc(2 * MiB, 2);
const capManifestBytes = (m) => Buffer.byteLength(canonical(m));
const plans = new Map([[A, limits()], [B, limits(10 * MiB)], [R, limits()], [E, limits(-1)], [Z, limits(0)]]);
const cocalc = async (req) => {
  const u = new URL(req.url);
  const l = plans.get(u.searchParams.get("account_id"));
  return l ? Response.json(l) : Response.json({ error: "no_account" }, { status: 404 });
};
const objects = { SYNC_ACCOUNT: { className: "SyncAccount", useSQLite: true }, SYNC_DOC: { className: "SyncDoc", useSQLite: true } };
const ratelimits = (id) => ({ SYNC_PREAUTH: { namespace_id: id, simple: { limit: 1_000_000, period: 60 } } });
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [
    { ...base, name: "on", bindings: { ...shareBindings, SYNC_ACCOUNTS: `${A},${B},${R},${C},${E},${Z}`, SYNC_TIERED: "1", SYNC_TEST_PIN_MS: "1000" }, durableObjects: objects, routes: ["sagebrush.test/*"], outboundService: cocalc, ratelimits: ratelimits("2001") },
    { ...base, name: "off", bindings: { ...shareBindings, SYNC_ACCOUNTS: A, SYNC_TEST_PIN_MS: "1000" }, durableObjects: objects, routes: ["off.test/*"], outboundService: cocalc, ratelimits: ratelimits("2002") },
  ],
}));
{
  const db = await mf.getD1Database("SHARE_DB", "on");
  const mig = join(here, "../share/migrations");
  for (const m of readdirSync(mig).filter((f) => f.endsWith(".sql")).sort())
    for (const s of readFileSync(join(mig, m), "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();
}
const at = (origin, path, init = {}) => dispatch(mf, origin + path, { redirect: "manual", ...init });
async function signIn(id, origin = SITE) {
  const r = await at(origin, "/auth/dev", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: "dev-token", account_id: id }) });
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));
}
const post = (s, path, body, origin = SITE) => at(origin, path, { method: "POST", headers: { cookie: s, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
const put = (s, bytes) => at(SITE, `/api/sync/v1/blob/${sha(bytes)}`, { method: "PUT", headers: { cookie: s, origin: SITE, "content-type": "application/octet-stream" }, body: bytes });
const get = (s, path, origin = SITE) => at(origin, path, { headers: { cookie: s, origin } });
const gate = (name, on) => at(SITE, `/__test/gate?name=${name}&on=${on ? 1 : 0}`);
const register = (s, m) => post(s, "/api/sync/v1/manifest", { manifest: m });
const verify = (s, h) => post(s, `/api/sync/v1/manifest/${h}/verify`, {});
const check = async (s, hashes) => (await post(s, "/api/sync/v1/blobs/check", { blobs: hashes.map((h) => ({ sha256: h, size: 1 })) })).json();
async function account(id) {
  const ns = await mf.getDurableObjectNamespace("SYNC_ACCOUNT", "on");
  const hash = createHash("sha256").update("sagebrush-account\n" + id).digest("hex");
  return ns.get(ns.idFromName("acct:" + hash));
}
/** Verify until it answers something other than `verifying`; the answers, in order. */
async function verifyAll(s, h, max = 300) {
  const out = [];
  for (let i = 0; i < max; i++) {
    const r = await verify(s, h);
    const b = await r.json();
    out.push({ status: r.status, ...b });
    if (b.state !== "verifying") break;
  }
  return out;
}
/** A socket whose `ops` asks answer. */
async function opsSocket(s, device) {
  const r = await at(SITE, "/api/sync/v1/account", { headers: { cookie: s, origin: SITE, upgrade: "websocket" } });
  const ws = r.webSocket;
  ws.accept();
  const queue = [], waiting = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    const w = waiting.findIndex((x) => x.match(m));
    if (w >= 0) waiting.splice(w, 1)[0].resolve(m);
    else queue.push(m);
  });
  const next = (match) => {
    const i = queue.findIndex(match);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve) => {
      const w = { match, resolve };
      waiting.push(w);
      setTimeout(() => {
        const j = waiting.indexOf(w);
        if (j >= 0) waiting.splice(j, 1), resolve(null);
      }, 5000);
    });
  };
  ws.send(JSON.stringify({ t: "hello", v: 2, device, name: "test", index_after: 0 }));
  await next((m) => m.t === "welcome");
  await next((m) => m.t === "index");
  let req = 0, dseq = 0;
  return {
    /** A create of a data file with this hash: its seq, or its refusal code. */
    async create(h, size) {
      const r = ++req;
      dseq++;
      ws.send(JSON.stringify({ t: "ops", req: r, ops: [{ dseq, t: dseq, by: "person", op: "create", path: `/f${dseq}.bin`, kind: "file", fid: dseq.toString(16).padStart(16, "0"), sha256: h, size }] }));
      const a = await next((m) => m.req === r);
      return a?.ops?.[0] ?? a;
    },
    close: () => ws.close(),
  };
}

/** A file of `chunks` (Buffers), its manifest, and its true hash. */
function fileOf(chunks) {
  const all = Buffer.concat(chunks);
  return { bytes: all, sha256: sha(all), manifest: { v: 1, cdc: "fastcdc-gear-v1/1M/4M/8M", sha256: sha(all), size: all.length, chunks: chunks.map((c) => [sha(c), c.length]) } };
}

// ---- the switch: off, every new route is a 404 and blobs/check answers as before
{
  const s = await signIn(A, "https://off.test");
  ok((await post(s, "/api/sync/v1/enable", {}, "https://off.test")).status === 200, "(off) sync on");
  const r = await post(s, "/api/sync/v1/manifest", { manifest: {} }, "https://off.test");
  ok(r.status === 404, "with SYNC_TIERED unbound, POST /manifest is a 404");
  ok((await get(s, "/api/sync/v1/manifest/" + "a".repeat(64), "https://off.test")).status === 404, "and GET /manifest/<sha> too");
  ok((await post(s, `/api/sync/v1/manifest/${"a".repeat(64)}/verify`, {}, "https://off.test")).status === 404, "and verify too");
  const c = await (await post(s, "/api/sync/v1/blobs/check", { blobs: [{ sha256: "a".repeat(64), size: 1 }] }, "https://off.test")).json();
  ok(JSON.stringify(c) === JSON.stringify({ missing: ["a".repeat(64)] }), "and blobs/check's answer is unchanged: " + JSON.stringify(c));
}

// ---- the deterministic cases
const sa = await signIn(A);
ok((await post(sa, "/api/sync/v1/enable", {})).status === 200, "sync on");
const acct = await account(A);
const c1 = randomBytes(8 * MiB), c2 = randomBytes(3 * MiB), c3 = randomBytes(2 * MiB);
for (const c of [c1, c2, c3]) ok((await put(sa, c)).status === 201, "a chunk uploads as a blob (" + c.length + " bytes)");
{
  const f = fileOf([c1, c2]);
  // registration
  let r = await register(sa, { ...f.manifest, chunks: [[sha(c1), c1.length], [sha(c3) .replace(/./, "0"), 3 * MiB]] });
  let b = await r.json();
  ok(r.status === 404 && b.error === "missing" && b.missing?.length === 1, "a manifest naming a chunk not held: missing, naming it: " + JSON.stringify(b));
  r = await register(sa, { ...f.manifest, chunks: [[sha(c1), c1.length], [sha(c3), 3 * MiB]] });
  b = await r.json();
  ok(r.status === 400 && b.error === "invalid" && b.sizes?.[0] === sha(c3), "a listed size that isn't the held chunk's: invalid, naming it");
  r = await register(sa, f.manifest);
  b = await r.json();
  ok(r.status === 200 && b.state === "verifying" && b.position === 0 && b.chunks === 2, "a good manifest registers: verifying at 0");
  let t = await acct.testFiles({ sha256: f.sha256 });
  ok(t.refs[sha(c1)] === 1 && t.refs[sha(c2)] === 1 && t.refs[sha(c3)] === 0, "each distinct chunk gets one reference, owned by the row");
  const reg0 = t.row.reg;
  r = await register(sa, f.manifest);
  t = await acct.testFiles({ sha256: f.sha256 });
  ok(r.status === 200 && t.refs[sha(c1)] === 1 && t.row.reg === reg0, "the same manifest again (a lost answer) takes no second reference and keeps the registration");
  r = await register(sa, { ...f.manifest, cdc: "fastcdc-gear-v1/1M/4M/8M", chunks: [[sha(c1), c1.length], [sha(c2), c2.length]].reverse() });
  ok(r.status === 400 || r.status === 409, "another manifest for the same hash is refused while a row exists");
  r = await register(sa, { ...fileOf([c2, c1]).manifest, sha256: f.sha256 });
  ok(r.status === 409 && (await r.json()).error === "conflict", "a competing manifest (other order, same claimed hash): conflict");
  // blobs/check, and an op, while verifying
  let c = await check(sa, [f.sha256]);
  ok(c.missing?.[0] === f.sha256 && c.verifying?.[0] === f.sha256, "blobs/check: the whole file is missing and verifying");
  ok((await get(sa, "/api/sync/v1/manifest/" + f.sha256)).status === 404, "GET /manifest while verifying: 404");
  const ws = await opsSocket(sa, "device-tier-0001");
  let op = await ws.create(f.sha256, f.bytes.length);
  ok(op.code === "missing", "an op naming a file still verifying is refused (missing): " + JSON.stringify(op));
  // verify, with a held stream and a racing call
  await gate("verify-stream", true);
  const held = verify(sa, f.sha256);
  await new Promise((r) => setTimeout(r, 200));
  const racer = await verify(sa, f.sha256);
  ok(racer.status === 429 && (await racer.json()).limit === "verify_at_once", "a second verify call while one runs: rate (one at a time per account)");
  await gate("verify-stream", false);
  const hr = await held;
  b = await hr.json();
  ok(hr.status === 200 && b.state === "verified" && b.position === 2, "the verification streams both chunks and verifies: " + JSON.stringify(b));
  c = await check(sa, [f.sha256]);
  ok(JSON.stringify(c) === JSON.stringify({ missing: [] }), "blobs/check: a verified file isn't missing (the client skips the upload)");
  const gm = await get(sa, "/api/sync/v1/manifest/" + f.sha256);
  ok(gm.status === 200 && canonical((await gm.json()).manifest) === canonical(f.manifest), "GET /manifest answers the manifest once verified");
  op = await ws.create(f.sha256, f.bytes.length);
  t = await acct.testFiles({ sha256: f.sha256 });
  ok(Number.isInteger(op.seq) && t.row.state === "live" && t.row.refs === 1, "an op naming the verified file is accepted; the row is live, with one reference");
  ok((await verify(sa, f.sha256).then((r) => r.json())).state === "live", "a verified row isn't verified again");
  ws.close();
}
{
  // wrong order: valid chunks, claimed under the true hash of the other order
  const right = fileOf([c1, c3]);
  const wrongOrder = { ...right.manifest, chunks: [[sha(c3), c3.length], [sha(c1), c1.length]] };
  // (the last chunk may be short, but here the first would be 2 MiB, under nothing: a valid form, a wrong order)
  let r = await register(sa, wrongOrder);
  ok(r.status === 200, "a manifest with the chunks in the wrong order registers (its form is valid)");
  let v = await verifyAll(sa, right.sha256);
  let last = v[v.length - 1];
  let t = await acct.testFiles({ sha256: right.sha256 });
  ok(last.status === 400 && last.reason === "order or hash" && t.row === null && t.refs[sha(c3)] === 0, "wrong order: invalid, and the row retired at once with its references (" + JSON.stringify(last) + ")");
  // a wrong whole-file hash
  const lie = { ...fileOf([c1, c3]).manifest, sha256: "c".repeat(64) };
  ok((await register(sa, lie)).status === 200, "a manifest under a wrong whole-file hash registers");
  v = await verifyAll(sa, lie.sha256);
  last = v[v.length - 1];
  ok(last.status === 400 && last.reason === "order or hash", "and is invalid at the end of its verification");
  const ws = await opsSocket(sa, "device-tier-0002");
  ok((await ws.create(lie.sha256, right.bytes.length)).code === "missing", "an op naming it is refused");
  ws.close();
}
{
  // a rekey mid-verification: the partial hash is discarded and verification restarts from zero (astra's c085569f note)
  const chunks = Array.from({ length: 10 }, () => randomBytes(MiB + 7));
  for (const c of chunks) await put(sa, c);
  const f = fileOf(chunks);
  ok((await register(sa, f.manifest)).status === 200, "a 10-chunk file registers");
  let r = await (await verify(sa, f.sha256)).json();
  ok(r.state === "verifying" && r.position === 8, "the first call streams 8 chunks (the per-call bound)");
  await acct.testFiles({ rekey: sha(chunks[0]) });
  const t0 = await acct.testFiles({ sha256: f.sha256 });
  await gate("verify-stream", true);
  const held = verify(sa, f.sha256);
  await new Promise((r) => setTimeout(r, 200));
  const t1 = await acct.testFiles({ sha256: f.sha256 });
  ok(t1.row.position === 0 && t1.row.vinc !== t0.row.vinc && t1.row.reg === t0.row.reg, "a rekeyed chunk restarts the verification: position 0, a new incarnation, the same registration");
  await gate("verify-stream", false);
  r = await (await held).json();
  ok(r.state === "verifying" && r.position === 8, "and streams again from the start");
  r = (await verifyAll(sa, f.sha256)).pop();
  ok(r.state === "verified", "then verifies");
  // a held call whose row is restarted under it can't checkpoint
  const g = fileOf([randomBytes(5 * MiB), randomBytes(5 * MiB)]);
  for (const c of [g.bytes.subarray(0, 5 * MiB), g.bytes.subarray(5 * MiB)]) await put(sa, c);
  await register(sa, g.manifest);
  await gate("verify-stream", true);
  const stale = verify(sa, g.sha256);
  await new Promise((r) => setTimeout(r, 200));
  await acct.testFiles({ rekey: g.manifest.chunks[1][0], endLease: true });
  const fresh = verify(sa, g.sha256);
  await new Promise((r) => setTimeout(r, 200));
  await gate("verify-stream", false);
  const [s1, s2] = await Promise.all([stale, fresh]);
  const b1 = await s1.json(), b2 = await s2.json();
  ok(s1.status === 409 && b1.error === "conflict", "a stale call (its incarnation replaced meanwhile) changes nothing: conflict");
  ok(b2.state === "verified", "the fresh call verifies");
}
{
  // retirement at the end of the hold, and renewal
  const f = fileOf([c2, c1]);
  const before = (await acct.testFiles({})).refs;
  await acct.testFiles({ holdMs: 400 });
  ok((await register(sa, f.manifest)).status === 200, "a registration with a 400 ms hold");
  let t = await acct.testFiles({ sha256: f.sha256 });
  ok(t.refs[sha(c2)] === before[sha(c2)] + 1 && t.refs[sha(c1)] === before[sha(c1)] + 1, "it takes one reference to each chunk: " + JSON.stringify([before[sha(c1)], before[sha(c2)], t.refs[sha(c1)], t.refs[sha(c2)], t.row?.state]));
  await new Promise((r) => setTimeout(r, 700));
  t = await acct.testFiles({ sha256: f.sha256 });
  ok(t.row === null, "unused past its hold: retired by the alarm, which the registration armed for its end");
  ok(t.refs[sha(c2)] === before[sha(c2)] && t.refs[sha(c1)] === before[sha(c1)], "its chunk references released, the live file's kept");
  await acct.testFiles({ holdMs: 0 });
  ok((await register(sa, f.manifest)).status === 200, "registering again after retirement makes a fresh row");
  t = await acct.testFiles({ sha256: f.sha256 });
  ok(t.refs[sha(c2)] === before[sha(c2)] + 1 && t.row.state === "verifying", "with fresh references");
}
{
  // the verification budget, debited before streaming
  const sb = await signIn(B);
  await post(sb, "/api/sync/v1/enable", {});
  const parts = [randomBytes(6 * MiB), randomBytes(6 * MiB)];
  for (const c of parts) await put(sb, c);
  const f = fileOf(parts);
  await register(sb, f.manifest);
  const r = await verify(sb, f.sha256);
  const b = await r.json();
  ok(r.status === 429 && b.limit === "verify_bytes_per_day" && b.max === 10 * MiB, "a call whose chunks exceed today's verification budget is refused before streaming: " + JSON.stringify(b));
}

// ---- the verify slot is owned by one attempt (astra's #880 SEC 1)
{
  const parts = [randomBytes(5 * MiB), randomBytes(5 * MiB)];
  for (const c of parts) await put(sa, c);
  const f = fileOf(parts);
  await register(sa, f.manifest);
  await acct.testFiles({ verifyMs: 60 });
  const b1 = await acct.verifyBegin({ account: A, sha256: f.sha256 });
  await new Promise((r) => setTimeout(r, 120));
  await acct.testFiles({ verifyMs: 0 });
  const b2 = await acct.verifyBegin({ account: A, sha256: f.sha256 });
  ok(b1.ok?.attempt && b2.ok?.attempt && b1.ok.attempt !== b2.ok.attempt, "after a slot's end, a new call takes the slot with its own attempt id");
  const e1 = await acct.verifyEnd({ account: A, sha256: f.sha256, reg: b1.ok.reg, vinc: b1.ok.vinc, mdigest: b1.ok.mdigest, attempt: b1.ok.attempt, from: 0, to: 2, keys: b1.ok.chunks.map((c) => c.key), sha_state: { h: "0".repeat(64), n: 0, rest: "" } });
  let t = await acct.testFiles({ sha256: f.sha256 });
  ok(e1.error?.code === "conflict" && t.slot?.attempt === b2.ok.attempt && t.row.position === 0, "the expired call's completion records nothing and doesn't free the newer call's slot");
  const b3 = await acct.verifyBegin({ account: A, sha256: f.sha256 });
  ok(b3.error?.code === "rate" && b3.error.detail?.limit === "verify_at_once", "so a third call still gets rate while the newer call owns the slot (daybreak3's pin)");
  await acct.testFiles({ endLease: true });
  // the Worker stops at its slot's end: a stream held past it is not recorded
  await acct.testFiles({ verifyMs: 600 });
  await gate("verify-stream", true);
  const held = verify(sa, f.sha256);
  await new Promise((r) => setTimeout(r, 900));
  await gate("verify-stream", false);
  const hr = await held;
  t = await acct.testFiles({ sha256: f.sha256, verifyMs: 0 });
  ok(hr.status === 503 && t.row.position === 0, "a call held past its slot's end stops and records nothing (" + hr.status + ")");
  // a read already pending when the deadline comes is cancelled at it, before the slot ends (daybreak3's r2 note)
  const g2 = fileOf([randomBytes(5 * MiB), randomBytes(5 * MiB)]);
  for (const c of [g2.bytes.subarray(0, 5 * MiB), g2.bytes.subarray(5 * MiB)]) await put(sa, c);
  await register(sa, g2.manifest);
  await acct.testFiles({ verifyMs: 600 });
  const before = (await (await at(SITE, "/__test/stall-cancels")).json()).n;
  await gate("verify-read-stall", true);
  const t0 = Date.now();
  const stalled = await verify(sa, g2.sha256);
  const took = Date.now() - t0;
  const cancels = (await (await at(SITE, "/__test/stall-cancels")).json()).n - before;
  const slotNow = (await acct.testFiles({ sha256: g2.sha256 })).slot;
  await gate("verify-read-stall", false);
  ok(stalled.status === 503 && cancels === 1 && took < 600, `a read stalled across the deadline is cancelled at it, before the slot ends (${stalled.status}, ${cancels} cancelled, ${took} ms)`);
  ok(slotNow !== null && slotNow.until > Date.now() - 1000, "and its slot is still held (nobody else streamed meanwhile) until it ends");
  await acct.testFiles({ endLease: true, verifyMs: 0 });
  ok((await verifyAll(sa, g2.sha256)).pop().state === "verified", "then the next call verifies it");
  ok((await verifyAll(sa, f.sha256)).pop().state === "verified", "and the next call verifies");
}

// ---- CoCalc's verify_bytes_per_day: malformed keeps nothing new (an outage, not the fallback); 0 is 0 (astra's #880 SEC 2)
{
  const se = await signIn(E);
  const r = await post(se, "/api/sync/v1/enable", {});
  ok(r.status === 503, "a malformed verify_bytes_per_day makes CoCalc's limits malformed: treated as an outage, not the 16 GiB fallback (" + r.status + ")");
  const sz = await signIn(Z);
  ok((await post(sz, "/api/sync/v1/enable", {})).status === 200, "(zero) sync on");
  const parts = [randomBytes(5 * MiB), randomBytes(5 * MiB)];
  for (const c of parts) await put(sz, c);
  const f = fileOf(parts);
  await register(sz, f.manifest);
  const v = await verify(sz, f.sha256);
  const b = await v.json();
  ok(v.status === 429 && b.max === 0, "verify_bytes_per_day 0: no verification at all (" + JSON.stringify(b) + ")");
}

// ---- registration at the storage cap (daybreak3's #880 finding): a resent or competing manifest, or one with missing
// chunks, is answered without asking for room; only a new row needs it
{
  const capFile = fileOf([capA, capB]);
  const total = capA.length + capB.length + capManifestBytes(capFile.manifest);
  plans.set(C, { ...limits(), storage_bytes: total });
  const sc = await signIn(C);
  ok((await post(sc, "/api/sync/v1/enable", {})).status === 200, "(cap) sync on");
  for (const c of [capA, capB]) ok((await put(sc, c)).status === 201, "(cap) a chunk uploads");
  let r = await register(sc, capFile.manifest);
  ok(r.status === 200 && (await r.json()).state === "verifying", "(cap) the manifest registers, filling the storage exactly");
  r = await register(sc, capFile.manifest);
  let b = await r.json();
  ok(r.status === 200 && b.state === "verifying", "(cap) the same manifest again, at the cap: the existing row, not storage_full: " + JSON.stringify(b));
  r = await register(sc, { ...fileOf([capB, capA]).manifest, sha256: capFile.sha256 });
  ok(r.status === 409, "(cap) a competing manifest at the cap: conflict, not storage_full (" + r.status + ")");
  r = await register(sc, { ...capFile.manifest, sha256: "d".repeat(64), chunks: [[sha(capA), capA.length], ["e".repeat(64), capB.length]] });
  b = await r.json();
  ok(r.status === 404 && b.error === "missing", "(cap) a manifest with a missing chunk at the cap: missing, not storage_full (" + r.status + ")");
  r = await register(sc, { ...fileOf([capB, capA]).manifest });
  ok(r.status === 507 || (r.status === 503 && (await r.clone().json()).error === "busy"), "(cap) a new manifest when no room is left: refused for room (" + r.status + ")");
}

// ---- the randomized state machine
{
  const sr = await signIn(R);
  await post(sr, "/api/sync/v1/enable", {});
  const ar = await account(R);
  // (a pool of chunks, uploaded once; files are made of them, in random orders)
  const pool = [randomBytes(8 * MiB), randomBytes(4 * MiB), randomBytes(MiB), randomBytes(2 * MiB + 3), randomBytes(MiB + 1)];
  for (const c of pool) await put(sr, c);
  const seeds = arg("--seeds", 12), steps = arg("--steps", 25), only = arg("--seed", -1);
  let viol = 0, ran = 0;
  /** the files made so far, across sequences (rows outlive a sequence): sha -> {manifest, truth: whether its chunks make that hash} */
  const files = new Map();
  const accepted = [];
  const ws = await opsSocket(sr, "device-tier-0003");
  for (let seed = only >= 0 ? only : 1; seed <= (only >= 0 ? only : seeds); seed++) {
    let x = seed * 2654435761 >>> 0;
    const rnd = (n) => ((x = (x * 1664525 + 1013904223) >>> 0) % n);
    const fail = (what) => {
      viol++;
      console.log(`FAIL seed ${seed}: ${what}`);
    };
    for (let step = 0; step < steps; step++) {
      ran++;
      const kind = rnd(7);
      if (process.env.TIERED_DEBUG) console.log(`seed ${seed} step ${step} kind ${kind}`);
      const known = [...files.keys()];
      const pick = () => known[rnd(known.length)];
      if (kind === 0 || known.length === 0) {
        // a manifest: 2-3 chunks from the pool, the first two at least 1 MiB; true, or a lie about the order or hash
        const n = 2 + rnd(2);
        const parts = Array.from({ length: n }, () => pool[rnd(pool.length)]);
        const f = fileOf(parts);
        if (f.bytes.length <= 8 * MiB) continue;
        const lie = rnd(4);
        let m = f.manifest, truth = true;
        if (lie === 0) (m = { ...m, sha256: sha(randomBytes(8)) }), (truth = false);
        if (lie === 1 && n === 3 && parts[0] !== parts[1]) (m = { ...m, chunks: [m.chunks[1], m.chunks[0], m.chunks[2]] }), (truth = sha(Buffer.concat([parts[1], parts[0], parts[2]])) === m.sha256);
        await ar.testFiles({ holdMs: rnd(3) === 0 ? 1 : 0 });
        const r = await register(sr, m);
        // (a 200 means the row's manifest is this one: new, or the same one again)
        if (r.status === 200) files.set(m.sha256, { m, truth });
      } else if (kind <= 2) {
        await verify(sr, pick());
      } else if (kind === 3) {
        // a verify call held mid-stream while its row is retired and registered again
        const h = pick();
        await gate("verify-stream", true);
        const p = verify(sr, h);
        await new Promise((r) => setTimeout(r, 50));
        await ar.testFiles({ holdMs: 1 });
        await new Promise((r) => setTimeout(r, 5));
        await ar.testFiles({ retire: true, endLease: true });
        await ar.testFiles({ holdMs: 0 });
        if (rnd(2)) await register(sr, files.get(h).m);
        await gate("verify-stream", false);
        await p;
      } else if (kind === 4) {
        await ar.testFiles({ rekey: sha(pool[rnd(pool.length)]) });
      } else if (kind === 5) {
        const h = pick();
        const o = await ws.create(h, files.get(h).m.size);
        if (Number.isInteger(o?.seq)) accepted.push(h);
      } else {
        await new Promise((r) => setTimeout(r, 3));
        await ar.testFiles({ retire: true });
      }
      // the invariants, after every step
      const rows = new Map();
      let refs = {};
      for (const h of files.keys()) {
        const t = await ar.testFiles({ sha256: h });
        refs = t.refs;
        if (t.row) rows.set(h, t.row);
      }
      for (const [h, row] of rows) {
        const f = files.get(h);
        if ((row.state === "verified" || row.state === "live") && !f.truth) fail(`a row verified for chunks that don't make its hash (${row.state})`);
        if (row.refs > 0 && row.state !== "live") fail("a referenced row that isn't live");
      }
      for (const h of accepted) {
        if (!files.get(h).truth) fail("an op accepted for a file whose chunks don't make it");
        if (!rows.has(h) || rows.get(h).state !== "live") fail("an accepted op's file isn't a live row");
      }
      // each chunk's references: one per row (in any state) that lists it, counted once per row
      const want = {};
      for (const c of pool) want[sha(c)] = 0;
      for (const [h] of rows) for (const c of new Set(files.get(h).m.chunks.map((x) => x[0]))) want[c]++;
      for (const c of Object.keys(want)) if ((refs[c] ?? 0) !== want[c]) fail(`chunk ${c.slice(0, 8)}: refs ${refs[c]}, rows hold ${want[c]}`);
      if (viol) break;
    }
    if (viol) {
      console.log(`(replay with: node web/sync/test-tiered.mjs --seed ${seed})`);
      break;
    }
  }
  ws.close();
  ok(viol === 0, `the randomized state machine: ${ran} steps, every invariant held after every step`);
}

await mf.dispose();
console.log(`${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
