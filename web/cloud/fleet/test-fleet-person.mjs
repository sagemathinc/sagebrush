// ci: web-sync.1 order=16
// Tests for the person's own fleet routes (web/cloud/fleet/person.ts; the reads scope r4): the Worker in Miniflare on a
// real D1 with every migration, the person's session given as the mounting Worker would (test-entry.ts takes it from
// x-test-account / x-test-session) or, in P-1r, through the fleet Worker's own entry (worker.ts), which resolves the
// cookie with the site's resolver over a real SHARE_DB (person.ts shareSession; the reads scope r4 §2), and the fleet built through the real writers (writers.ts, bundled with bun). Every
// signed object a route returns is checked with the mirrored core's own verifiers, as the page checks it.
//   node web/cloud/fleet/test-fleet-person.mjs
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dispatch } from "../../miniflare-dispatch.mjs";
import { migrations as shareMigrations } from "../share/migrations.mjs";
import * as core from "../../workspace/fleet/core/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
core.useCrypto(core.webCrypto());
const SCHEMAS = { "fleet.schema.json": JSON.parse(readFileSync(join(here, "../../workspace/fleet/fleet.schema.json"), "utf8")), "reasons.json": JSON.parse(readFileSync(join(here, "../../workspace/fleet/reasons.json"), "utf8")) };
core.useSchemas((n) => SCHEMAS[n]);
const tmp = mkdtempSync(join(tmpdir(), "fleet-person-"));
for (const m of ["writers", "store"]) writeFileSync(join(tmp, `${m}.mjs`), execFileSync("bun", ["build", join(here, `${m}.ts`), "--format", "esm", "--target", "node"], { encoding: "utf8" }));
const W = await import(pathToFileURL(join(tmp, "writers.mjs")).href);
const S = await import(pathToFileURL(join(tmp, "store.mjs")).href);
rmSync(tmp, { recursive: true, force: true });

let failures = 0, count = 0;
const ok = (c, what, detail) => { count++; if (!c) { failures++; console.log("FAIL", what, detail === undefined ? "" : JSON.stringify(detail).slice(0, 500)); } };
const AUD = "https://dev.sagebrush.space", SITE = "https://fleet.test";
const NOW = Date.now();
let seedN = 1;
const key = () => core.keyFromSeed(new Uint8Array(32).fill(seedN++ & 255).map((x, i) => (i === 0 ? (seedN >> 8) & 255 : x)));
const text = (b) => new TextDecoder().decode(b);
const rand = (n) => core.b64(core.random(n));

const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser"], { encoding: "utf8" });
// (AUTH_PROVIDER "local": the site's sessions of kind 'local', written straight into SHARE_DB as a deployment's own
// sign-in would, as share/test-local-sessions.mjs does)
const worker = (d1, bindings = { FLEET_AUD: AUD }, src = script) => new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "fleet", modules: true, script: src, compatibilityDate: "2026-10-01", d1Databases: d1, bindings }] }));
// (the fleet Worker's own entry, as a deployment would run it: no test header reaches the session)
const entry = execFileSync("bun", ["build", join(here, "worker.ts"), "--format", "esm", "--target", "browser"], { encoding: "utf8" });
const deployed = (d1, bindings = { FLEET_AUD: AUD, AUTH_PROVIDER: "local" }) => worker(d1, bindings, entry);
const run = async (d, files) => { for (const f of files) for (const stmt of readFileSync(f, "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean)) await d.prepare(stmt).run(); };
const FLEET_MIGRATIONS = ["0001_fleet_leases.sql", "0002_fleet_writers_chain_hosts.sql", "0003_fleet_writers_grants_transfers.sql", "0004_fleet_request_nonces.sql", "0005_fleet_accounts_and_bytes.sql"].map((m) => join(here, "migrations", m));
const mf = worker(["FLEET_DB"]);
const db = await mf.getD1Database("FLEET_DB");
await run(db, FLEET_MIGRATIONS);
const all = async (sql, ...v) => (await db.prepare(sql).bind(...v).all()).results;
const exec = (sql, ...v) => db.prepare(sql).bind(...v).run();
const snapshot = async () => JSON.stringify(await Promise.all(["fleet_accounts", "fleet_chain_entries", "fleet_chain_hashes", "fleet_hosts", "fleet_host_certs"].map((t) => all(`SELECT * FROM ${t} ORDER BY 1, 2`))));

/** A request as the account (null: no session; "none" / "unavailable" / "throw": the session's own answer). */
async function as(account, path, { method = "GET", body, session } = {}) {
  const headers = {};
  if (account) headers["x-test-account"] = account;
  if (session) headers["x-test-session"] = session;
  const r = await dispatch(mf, SITE + path, { method, headers, ...(body ? { body } : {}) });
  const bytes = new Uint8Array(await r.arrayBuffer());
  let json = null;
  try { json = bytes.length ? JSON.parse(text(bytes)) : null; } catch { /* (not JSON) */ }
  return { status: r.status, bytes, json, cache: r.headers.get("cache-control") };
}
const errorOf = (r) => r.json?.error ?? null;

/** A person's fleet in the making: its native device N, a browser device B, and the entries their app signs. */
function fleetOf(account = core.newId()) {
  const f = { fleet: core.newId(), account, seq: 0, head: "", keys: [] };
  f.init = async () => {
    f.N = await key(); f.nId = core.newId(); f.R = await key();
    f.sN = { kind: "device", id: f.nId, alg: "ed25519", key: f.N.key };
    f.by = { s: f.sN, k: f.N };
    return f;
  };
  f.body = (op, extra) => ({ fleet: f.fleet, aud: AUD, seq: f.seq, prev: f.head, op, at_ms: NOW, auth_time_ms: NOW, ...extra });
  f.entry = (op, extra, by = f.by) => core.seal("sb.device-chain.v1", by.s, f.body(op, extra), by.k);
  f.genesisBytes = () => f.entry("genesis", { device: { id: f.nId, alg: "ed25519", key: core.b64(f.N.raw), name: "mac", tier: "native" }, recovery_key: { alg: "ed25519", key: core.b64(f.R.raw) } });
  /** Append through the person's route; on ok, track the head. */
  f.post = async (bytes, account = f.account) => {
    const r = await as(account, "/api/fleet/v1/chain", { method: "POST", body: bytes });
    if (r.status === 200) { const st = await W.loadChain(db, core, f.fleet, AUD); f.seq = st.head.seq + 1; f.head = st.head.hash; }
    return r;
  };
  return f;
}
/** A fleet created through the route, with a browser device and the native policy. */
async function created(account) {
  const f = await fleetOf(account).init();
  const g = await f.post(await f.genesisBytes());
  if (g.status !== 200) throw new Error(`genesis: ${JSON.stringify(g.json)}`);
  f.B = await key(); f.bId = core.newId();
  await f.post(await core.sealAdd(f.sN, f.body("add", { device: { id: f.bId, alg: "ed25519", key: core.b64(f.B.raw), name: "browser", tier: "browser" } }), f.N, f.B));
  f.browser = { s: { kind: "device", id: f.bId, alg: "ed25519", key: f.B.key }, k: f.B };
  await f.post(await f.entry("policy", { policy: { require_native_for_widening: true } }));
  return f;
}
async function pairOf(f) {
  const host = core.newId(), H = await key(), encRaw = core.random(32);
  const fingerprint = core.b64(await core.hostFingerprint(host, H.raw, encRaw));
  const bytes = await core.seal("sb.host-cert.v1", f.sN, { fleet: f.fleet, aud: AUD, chain_seq: f.seq - 1, host, sign_key: core.b64(H.raw), enc_key: core.b64(encRaw), fingerprint, name: "box", at_ms: NOW }, f.N);
  const r = await W.pairHost(db, core, { fleet: f.fleet, aud: AUD, bytes });
  return { host, H, fingerprint, bytes, r, cert: (await all("SELECT cert FROM fleet_host_certs WHERE fleet = ?1 AND host = ?2", f.fleet, host))[0]?.cert };
}
const revocationOf = (f, what, id) => core.seal("sb.revocation.v1", f.sN, { fleet: f.fleet, aud: AUD, chain_seq: f.seq - 1, what, id, host: id, gen: 1, at_ms: NOW }, f.N);
const agentEntry = (agent, extra = {}) => ({ agent, name: "worker", client: "claude", root: false, tags: [], workspace: [{ path: "/Algebra", access: "write" }], broker: ["messages"],
  spend_cap_cents: 0, config_schema: 1, config: {}, ...extra });
const grantOf = (f, h, gen, agents, { by = f.by, ...extra } = {}) => core.seal("sb.host-grant.v1", by.s, { fleet: f.fleet, aud: AUD, host: h.host, gen, cert: h.cert, chain_seq: f.seq - 1,
  at_ms: NOW - 1000, not_before_ms: NOW - 1000, not_after_ms: NOW + 3_600_000, auth_time_ms: NOW, agents, tags: [], subscriptions: [], offline: { revocation_check_s: 900, horizon_s: 3600 }, ...extra }, by.k);
const grant = (f, bytes) => W.applyGrant(db, core, { fleet: f.fleet, aud: AUD, grant: bytes, transfers: [], now: NOW, serviceKeys: [] });

// ---- P-1: the session
{
  for (const path of ["/api/fleet/v1/fleet", "/api/fleet/v1/chain", "/api/fleet/v1/hosts", `/api/fleet/v1/hosts/${core.newId()}/grants`]) {
    const none = await as(null, path);
    ok(none.status === 401 && errorOf(none) === "unauthenticated" && none.cache === "no-store", `P-1: ${path} with no session: 401`, none);
    ok((await as("acct", path, { session: "none" })).status === 401, `P-1: ${path} with an ended session: 401`);
    ok((await as("acct", path, { session: "unavailable" })).status === 503, `P-1: ${path} with a session that can't be checked: 503`);
    ok((await as("acct", path, { session: "throw" })).status === 503, `P-1: ${path} with a failing session store: 503`);
  }
  ok((await as("acct", "/api/fleet/v1/chain", { method: "POST", body: "{}", session: "none" })).status === 401, "P-1: an append with no session: 401");
  ok((await as("acct", "/api/fleet/v1/hosts", { method: "POST", body: "{}" })).status === 405, "P-1: a POST to a read route: 405");
  ok((await as("bad account!", "/api/fleet/v1/fleet")).status === 500, "P-1: a session account outside the id grammar: 500, nothing read");
}

// ---- P-1r: the session resolved for real, through the fleet Worker's entry: the site's own resolver (the cookie, then
// the SHARE_DB primary; r4 §2), on two D1s, FLEET_DB and SHARE_DB
{
  const live2 = deployed(["FLEET_DB", "SHARE_DB"]);
  const fdb = await live2.getD1Database("FLEET_DB");
  await run(fdb, FLEET_MIGRATIONS);
  const shareDb = await live2.getD1Database("SHARE_DB");
  await run(shareDb, shareMigrations().map((m) => m.path));
  const nowS = Math.floor(Date.now() / 1000);
  const sha = (x) => createHash("sha256").update(x).digest("hex");
  /** A session row as a sign-in writes it (kind 'local' unless given), for a new account unless one is named. */
  const sessionRow = async (opts = {}) => {
    const account = opts.account ?? crypto.randomUUID(), token = randomBytes(32).toString("base64url");
    await shareDb.prepare("INSERT OR IGNORE INTO accounts (account_id, email, name, created, last_login) VALUES (?1, ?2, 'X', ?3, ?3)").bind(account, `${account}@example.com`, nowS).run();
    const kind = opts.kind ?? "local", abs = nowS + 30 * 86400;
    const expires = opts.expires ?? nowS + 86400;
    await shareDb.prepare("INSERT INTO sessions (token_hash, account_id, created, expires, kind, abs_expires, validated, idle_s, last_used) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8)")
      .bind(sha(token), account, nowS, expires, kind, kind === "local" ? abs : null, kind === "local" ? 86400 : null, kind === "local" ? nowS : null).run();
    return { account, token };
  };
  const real = async (m, cookie, path, { method = "GET", body } = {}) => {
    const headers = cookie === null ? {} : { cookie: `__Host-sb_session=${cookie}` };
    const r = await dispatch(m, SITE + path, { method, headers, ...(body ? { body } : {}) });
    const bytes = new Uint8Array(await r.arrayBuffer());
    let json = null;
    try { json = bytes.length ? JSON.parse(text(bytes)) : null; } catch { /* (not JSON) */ }
    return { status: r.status, json };
  };
  const live = await sessionRow();
  const r0 = await real(live2, live.token, "/api/fleet/v1/fleet");
  ok(r0.status === 404 && r0.json?.error === "no_fleet", "P-1r: a live session, read for real: authenticated (no_fleet), not 401", r0);
  // (its account is the session row's own: a genesis through the cookie binds THAT account, and the injected seam for the
  // same id then sees the same fleet)
  const f = await fleetOf(live.account).init();
  const g = await real(live2, live.token, "/api/fleet/v1/chain", { method: "POST", body: await f.genesisBytes() });
  ok(g.status === 200, "P-1r: a genesis through the real session", g);
  const bound = (await fdb.prepare("SELECT account FROM fleet_accounts WHERE fleet = ?1").bind(f.fleet).all()).results;
  ok(bound.length === 1 && bound[0].account === live.account, "P-1r: the fleet is bound to the session row's account", bound);
  const seen = await real(live2, live.token, "/api/fleet/v1/fleet");
  ok(seen.status === 200 && seen.json?.fleet === f.fleet, "P-1r: /fleet through the real session shows it", seen);
  ok((await real(live2, null, "/api/fleet/v1/fleet")).status === 401 && (await real(live2, (await sessionRow()).token, "/api/fleet/v1/fleet")).status === 404, "P-1r: the fleet is that account's alone: no cookie is 401, another live account has none");
  for (const path of ["/api/fleet/v1/fleet", "/api/fleet/v1/chain", "/api/fleet/v1/hosts", `/api/fleet/v1/hosts/${core.newId()}/grants`]) {
    ok((await real(live2, null, path)).status === 401, `P-1r: ${path} with no cookie: 401`);
    ok((await real(live2, "not-a-token", path)).status === 401, `P-1r: ${path} with a malformed token: 401`);
    ok((await real(live2, randomBytes(32).toString("base64url"), path)).status === 401, `P-1r: ${path} with a token no row has: 401`);
  }
  const expired = await sessionRow({ expires: nowS - 1 });
  ok((await real(live2, expired.token, "/api/fleet/v1/fleet")).status === 401, "P-1r: an expired session row: 401");
  // (and a session with no idle limit, whose end only the primary's own read checks, as no idle touch re-reads it: a
  // 'legacy' session, counted where no provider is set)
  {
    const leg = deployed(["FLEET_DB", "SHARE_DB"], { FLEET_AUD: AUD });
    await run(await leg.getD1Database("FLEET_DB"), FLEET_MIGRATIONS);
    const ldb = await leg.getD1Database("SHARE_DB");
    await run(ldb, shareMigrations().map((m) => m.path));
    const legacyRow = async (expires) => {
      const account = crypto.randomUUID(), token = randomBytes(32).toString("base64url");
      await ldb.prepare("INSERT INTO accounts (account_id, email, name, created, last_login) VALUES (?1, ?2, 'X', ?3, ?3)").bind(account, `${account}@example.com`, nowS).run();
      await ldb.prepare("INSERT INTO sessions (token_hash, account_id, created, expires, kind) VALUES (?1, ?2, ?3, ?4, 'legacy')").bind(sha(token), account, nowS, expires).run();
      return token;
    };
    ok((await real(leg, await legacyRow(nowS - 1), "/api/fleet/v1/fleet")).status === 401, "P-1r: an expired session with no idle limit: 401");
    const fresh = await real(leg, await legacyRow(nowS + 86400), "/api/fleet/v1/fleet");
    ok(fresh.status === 404 && fresh.json?.error === "no_fleet", "P-1r: control, the same session unexpired: authenticated", fresh);
    await leg.dispose();
  }
  const leaving = await sessionRow();
  await shareDb.prepare("UPDATE accounts SET deleting = ?2 WHERE account_id = ?1").bind(leaving.account, nowS).run();
  ok((await real(live2, leaving.token, "/api/fleet/v1/fleet")).status === 401, "P-1r: an account being deleted: 401");
  const legacy = await sessionRow({ kind: "legacy" });
  ok((await real(live2, legacy.token, "/api/fleet/v1/fleet")).status === 401, "P-1r: a session of a kind this deployment's provider doesn't count: 401");
  ok((await real(live2, live.token, "/api/fleet/v1/chain", { method: "POST", body: "{}" })).status !== 401, "P-1r: an append with the live session is past the session check");
  // (no SHARE_DB binding: the session can't be checked, 503, never signed out)
  const noShare = deployed(["FLEET_DB"]);
  ok((await real(noShare, live.token, "/api/fleet/v1/fleet")).status === 503, "P-1r: no SHARE_DB binding: 503");
  await noShare.dispose();
  // (a SHARE_DB whose read fails: 503, and nothing of the fleet is read)
  const broken = deployed(["FLEET_DB", "SHARE_DB"]);
  ok((await real(broken, live.token, "/api/fleet/v1/fleet")).status === 503, "P-1r: a failing SHARE_DB read: 503");
  await broken.dispose();
  // (the primary's own "unavailable": a WorkOS session past its grace whose last refresh just failed, so WorkOS can't be
  // asked again yet. 503, never signed out. Its control, the same row inside the grace, is served)
  const wos = deployed(["FLEET_DB", "SHARE_DB"], { FLEET_AUD: AUD, AUTH_PROVIDER: "workos" });
  await run(await wos.getD1Database("FLEET_DB"), FLEET_MIGRATIONS);
  const wdb = await wos.getD1Database("SHARE_DB");
  await run(wdb, shareMigrations().map((m) => m.path));
  const workosRow = async (validatedAgo) => {
    const account = crypto.randomUUID(), token = randomBytes(32).toString("base64url");
    await wdb.prepare("INSERT INTO accounts (account_id, email, name, created, last_login) VALUES (?1, ?2, 'X', ?3, ?3)").bind(account, `${account}@example.com`, nowS).run();
    await wdb.prepare("INSERT INTO sessions (token_hash, account_id, created, expires, kind, abs_expires, validated, refresh_failed) VALUES (?1, ?2, ?3, ?4, 'workos', ?5, ?6, ?7)")
      .bind(sha(token), account, nowS - validatedAgo, nowS - validatedAgo + 3600, nowS + 30 * 86400, nowS - validatedAgo, nowS - 10).run();
    return token;
  };
  ok((await real(wos, await workosRow(2 * 86400), "/api/fleet/v1/fleet")).status === 503, "P-1r: the primary says unavailable (WorkOS past its grace, its refresh just failed): 503");
  const inGrace = await real(wos, await workosRow(2 * 3600), "/api/fleet/v1/fleet");
  ok(inGrace.status === 404 && inGrace.json?.error === "no_fleet", "P-1r: control, the same inside its grace: authenticated", inGrace);
  await wos.dispose();
  await live2.dispose();
}

// ---- P-2 and P-3: /fleet, and the genesis binding (SEC H1, H2)
{
  const A = core.newId(), B = core.newId();
  let r = await as(A, "/api/fleet/v1/fleet");
  ok(r.status === 404 && errorOf(r) === "no_fleet", "P-2: no fleet yet: 404 no_fleet", r.json);
  ok(errorOf(await as(A, "/api/fleet/v1/hosts")) === "no_fleet" && errorOf(await as(A, "/api/fleet/v1/chain")) === "no_fleet", "P-2: and the other reads say so too");
  const fa = await fleetOf(A).init();
  r = await fa.post(await fa.genesisBytes());
  ok(r.status === 200 && r.json.seq === 0, "P-3: A's genesis: ok, seq 0", r.json);
  r = await as(A, "/api/fleet/v1/fleet");
  ok(r.status === 200 && r.json.fleet === fa.fleet && r.json.aud === AUD, "P-2: /fleet is A's fleet and the Worker's audience", r.json);
  // A's second fleet
  let before = await snapshot();
  const fa2 = await fleetOf(A).init();
  r = await fa2.post(await fa2.genesisBytes());
  ok(r.status === 403 && errorOf(r) === "not_granted" && (await snapshot()) === before, "P-3: A's genesis for a new fleet: not_granted, no binding, no entry", r.json);
  // B on A's fleet: not_found, the same bytes as for a fleet nobody owns
  const fb = await fleetOf(B).init();
  fb.fleet = fa.fleet;
  const onA = await fb.post(await fb.genesisBytes());
  const ghost = await fleetOf(B).init();
  ghost.seq = 1; ghost.head = rand(32);
  const onNothing = await ghost.post(await ghost.entry("policy", { policy: { require_native_for_widening: true } }));
  ok(onA.status === 404 && errorOf(onA) === "not_found" && text(onA.bytes) === text(onNothing.bytes) && (await snapshot()) === before,
    "P-3: B's genesis for A's fleet id: not_found, byte-identical to B's append to a fleet nobody owns, nothing written", [onA.json, onNothing.json]);
  const fbx = await fleetOf(B).init();
  fbx.fleet = fa.fleet; fbx.seq = 1; fbx.head = rand(32);
  ok(errorOf(await fbx.post(await fbx.entry("policy", { policy: { require_native_for_widening: true } }))) === "not_found" && (await snapshot()) === before, "P-3: B's append to A's fleet: not_found");
  // A's own second genesis
  const again = await fleetOf(A).init();
  again.fleet = fa.fleet;
  ok(errorOf(await again.post(await again.genesisBytes())) === "chain_fork" && (await snapshot()) === before, "P-3: A's own second genesis on its fleet: chain_fork");
  // refused geneses bind nothing
  const C = core.newId();
  const bad = await fleetOf(C).init();
  const g = JSON.parse(text(await bad.genesisBytes()));
  g.sig = g.sig.slice(0, -2) + (g.sig.endsWith("AA") ? "BA" : "AA");
  ok((await bad.post(core.enc(core.canonText(g)))).status !== 200 && (await snapshot()) === before, "P-3: a genesis with a bad signature: refused, no binding");
  const stale = await fleetOf(C).init();
  r = await stale.post(await core.seal("sb.device-chain.v1", stale.sN, { ...stale.body("genesis", { device: { id: stale.nId, alg: "ed25519", key: core.b64(stale.N.raw), name: "mac", tier: "native" }, recovery_key: { alg: "ed25519", key: core.b64(stale.R.raw) } }), auth_time_ms: NOW - 300_001 }, stale.N));
  ok(errorOf(r) === "stale_auth" && (await snapshot()) === before, "P-3: a genesis with a stale sign-in: stale_auth, no binding", r.json);
  ok(errorOf(await as(C, "/api/fleet/v1/chain", { method: "POST", body: "not json" })) === "bad_form", "P-3: a body that isn't canonical JSON: bad_form");
  // a failure at each statement of the genesis batch writes neither the binding nor the entry
  const failing = (i) => ({ prepare: (s) => db.prepare(s), batch: (stmts) => { const b = [...stmts]; b[i] = db.prepare("SELECT json_extract('broken', '$')"); return db.batch(b); } });
  for (let i = 0; i < 4; i++) {
    const f = await fleetOf(core.newId()).init();
    before = await snapshot();
    let threw = false;
    try { await W.appendChainEntry(failing(i), core, { fleet: f.fleet, aud: AUD, bytes: await f.genesisBytes(), now: NOW, account: f.account }); } catch { threw = true; }
    ok(threw && (await snapshot()) === before, `P-3: the genesis batch's statement ${i + 1} failing: no binding, no entry`);
  }
  // races: one account and two new fleets; two accounts and one fleet id
  const D = core.newId();
  const d1 = await fleetOf(D).init(), d2 = await fleetOf(D).init();
  const rs = await Promise.all([d1.post(await d1.genesisBytes()), d2.post(await d2.genesisBytes())]);
  const won = rs.filter((x) => x.status === 200).length, lost = rs.find((x) => x.status !== 200);
  const bound = await all("SELECT fleet FROM fleet_accounts WHERE account = ?1", D);
  const orphan = await all("SELECT fleet FROM fleet_chain_entries WHERE fleet IN (?1, ?2) AND fleet NOT IN (SELECT fleet FROM fleet_accounts)", d1.fleet, d2.fleet);
  ok(won === 1 && errorOf(lost) === "not_granted" && bound.length === 1 && orphan.length === 0, "P-3: one account racing two new fleets: one bound, the other not_granted, no orphan entry", { won, lost: lost?.json, bound, orphan });
  const E1 = core.newId(), E2 = core.newId();
  const e1 = await fleetOf(E1).init(), e2 = await fleetOf(E2).init();
  e2.fleet = e1.fleet;
  const es = await Promise.all([e1.post(await e1.genesisBytes()), e2.post(await e2.genesisBytes())]);
  const owners = await all("SELECT account FROM fleet_accounts WHERE fleet = ?1", e1.fleet);
  ok(es.filter((x) => x.status === 200).length === 1 && es.some((x) => errorOf(x) === "not_found") && owners.length === 1
    && (await all("SELECT COUNT(*) AS n FROM fleet_chain_entries WHERE fleet = ?1", e1.fleet))[0].n === 1, "P-3: two accounts racing one fleet id: one owner and one genesis, the other not_found", es.map((x) => x.json));
  // (the same race, decided by the batch itself: another account's genesis lands between this one's checks and its batch)
  const F1 = core.newId(), F2 = core.newId();
  const f1 = await fleetOf(F1).init(), f2 = await fleetOf(F2).init();
  f2.fleet = f1.fleet;
  const theirs = await f2.genesisBytes();
  const mine = await W.appendChainEntry(db, core, { fleet: f1.fleet, aud: AUD, bytes: await f1.genesisBytes(), now: NOW, account: F1 },
    { beforeBatch: async () => { await W.appendChainEntry(db, core, { fleet: f1.fleet, aud: AUD, bytes: theirs, now: NOW, account: F2 }); } });
  const owner = await all("SELECT account FROM fleet_accounts WHERE fleet = ?1", f1.fleet);
  ok(mine.refused === "not_found" && owner.length === 1 && owner[0].account === F2, "P-3: another account's genesis between this one's checks and its batch: the batch answers not_found", mine);
}

// ---- P-4: /chain is the host route's page, byte for byte
{
  const f = await created(core.newId());
  const h = await pairOf(f);
  for (const after of [null, 0, 1, 2, 9]) {
    const q = after === null ? "" : `?after=${after}`;
    const mine = await as(f.account, `/api/fleet/v1/chain${q}`);
    const target = core.chainTarget(after);
    const fields = { host: h.host, agent: "-", cap: "-", gen: "1", ts: String(Date.now()), nonce: rand(16), idem: "-", op: "-" };
    const sig = await h.H.sign(core.requestBytes(AUD, "GET", target, await core.sha256b64(new Uint8Array(0)), fields));
    const header = `v1 ${core.SIG_KEYS.map((k) => `${k}=${k === "sig" ? core.b64(sig) : fields[k]}`).join("; ")}`;
    const theirs = await dispatch(mf, SITE + target, { headers: { "sagebrush-sig": header } });
    const tb = new Uint8Array(await theirs.arrayBuffer());
    ok(mine.status === 200 && theirs.status === 200 && text(mine.bytes) === text(tb), `P-4: after ${after}: the person's page equals the host's byte for byte`, [mine.status, theirs.status]);
  }
  const p = core.parseChainPage((await as(f.account, "/api/fleet/v1/chain")).bytes, -1);
  let st = null;
  for (const e of p.entries) st = (await core.applyChainEntry(st, e, { aud: AUD, fleet: f.fleet })).state;
  ok(st && st.head === f.head, "P-4: the page replays to the stored head");
  ok(errorOf(await as(f.account, "/api/fleet/v1/chain?after=01")) === "bad_form", "P-4: the target grammar is the host route's");
  await exec("DELETE FROM fleet_chain_entries WHERE fleet = ?1 AND seq = 1", f.fleet);
  const gap = await as(f.account, "/api/fleet/v1/chain");
  ok(gap.status === 500 && gap.bytes.length === 0, "P-4: a gap in the stored chain: 500, nothing served");
}

// ---- P-5: /hosts
{
  const f = await created(core.newId());
  const h1 = await pairOf(f), h2 = await pairOf(f);
  ok(h1.r.ok && h2.r.ok, "P-5: two hosts paired");
  // h1 revoked twice (the first stays); an agent's revocation with h2's id string is not h2's
  const rev1 = await revocationOf(f, "host", h1.host);
  await W.revoke(db, core, { fleet: f.fleet, aud: AUD, bytes: rev1 });
  await W.revoke(db, core, { fleet: f.fleet, aud: AUD, bytes: await core.seal("sb.revocation.v1", f.sN, { fleet: f.fleet, aud: AUD, chain_seq: f.seq - 1, what: "host", id: h1.host, host: h1.host, gen: 1, at_ms: NOW + 1 }, f.N) });
  await W.revoke(db, core, { fleet: f.fleet, aud: AUD, bytes: await revocationOf(f, "agent", h2.host) });
  ok((await grant(f, await grantOf(f, h2, 1, [agentEntry(core.newId())]))).ok, "P-5: a grant at gen 1 on h2");
  ok((await grant(f, await grantOf(f, h2, 2, [agentEntry(core.newId())]))).ok, "P-5: and at gen 2");
  const r = await as(f.account, "/api/fleet/v1/hosts");
  const byHost = Object.fromEntries((r.json?.hosts ?? []).map((x) => [x.host, x]));
  ok(r.status === 200 && r.cache === "no-store" && r.json.hosts.length === 2 && JSON.stringify(Object.keys(byHost)) === JSON.stringify([h1.host, h2.host].sort()), "P-5: both hosts, ordered by id", r.json);
  ok(byHost[h1.host].cert === text(h1.bytes) && byHost[h2.host].cert === text(h2.bytes), "P-5: each certificate byte-equal to what was paired");
  ok(byHost[h1.host].revocation === text(rev1), "P-5: h1's FIRST revocation, byte-equal");
  ok(byHost[h2.host].revocation === null, "P-5: an agent's revocation with h2's id string is never h2's");
  ok(byHost[h1.host].grant_gen === null && byHost[h2.host].grant_gen === 2 && byHost[h1.host].ack === null, "P-5: grant_gen is the max (null with none); ack null", byHost);
  const st = (await W.loadChain(db, core, f.fleet, AUD)).state;
  const cert = await core.verifyHostCert(core.enc(byHost[h2.host].cert), { aud: AUD, fleet: f.fleet, chain: st });
  const rv = await core.verifyRevocation(core.enc(byHost[h1.host].revocation), { aud: AUD, fleet: f.fleet, chain: st });
  ok(cert.body.host === h2.host && rv.id === h1.host && rv.what === "host", "P-5: the page's own verifiers accept them");
  // the snapshot: each read is the state at its statement, before, between and after two separate commits
  const g3 = await grantOf(f, h2, 3, [agentEntry(core.newId())]);
  const rev2 = await revocationOf(f, "host", h2.host);
  const state = async () => { const x = (await as(f.account, "/api/fleet/v1/hosts")).json.hosts.find((y) => y.host === h2.host); return [x.revocation !== null, x.grant_gen]; };
  const s0 = await state();
  await W.revoke(db, core, { fleet: f.fleet, aud: AUD, bytes: rev2 });
  const s1 = await state();
  await exec("INSERT INTO fleet_grants (fleet, host, gen, hash, bytes) VALUES (?1, ?2, 3, ?3, ?4)", f.fleet, h2.host, rand(32), text(g3));
  const s2 = await state();
  ok(JSON.stringify([s0, s1, s2]) === JSON.stringify([[false, 2], [true, 2], [true, 3]]), "P-5: before, between and after the two commits: exactly each state", [s0, s1, s2]);
}

// ---- P-6: the encoded cap on /hosts, at the exact byte
{
  const f = await created(core.newId());
  const cap = 1_048_576;
  // (escape-heavy and multibyte certificate text stored directly: a store fault, never a valid certificate)
  const filler = (n) => `"é`.repeat(Math.floor(n / 3)) + "a".repeat(n % 3);
  const hostIds = Array.from({ length: 14 }, () => core.newId()).sort();
  for (const h of hostIds) {
    await exec("INSERT INTO fleet_hosts (host, fleet, sign_key, fingerprint, revoked) VALUES (?1, ?2, ?3, ?4, 0)", h, f.fleet, rand(32), rand(32));
    await exec("INSERT INTO fleet_host_certs (fleet, host, cert, bytes) VALUES (?1, ?2, ?3, ?4)", f.fleet, h, rand(32), filler(50000));
  }
  const size = async () => { const r = await as(f.account, "/api/fleet/v1/hosts"); return [r.status, r.bytes.length]; };
  let [st, n] = await size();
  ok(st === 200 && n < cap, "P-6: 14 escape-heavy, multibyte certificates fit", [st, n]);
  // (grow them with ASCII, one encoded byte per stored byte, within each certificate's 64 KiB, to exactly the cap)
  let room = cap - n;
  for (const h of hostIds) {
    if (room === 0) break;
    const take = Math.min(room, 65536 - 50000);
    await exec("UPDATE fleet_host_certs SET bytes = bytes || ?2 WHERE host = ?1", h, "a".repeat(take));
    room -= take;
  }
  ok(room === 0, "P-6: (the growth fitted)", room);
  [st, n] = await size();
  ok(st === 200 && n === cap, "P-6: a body of exactly FLEET_HOSTS_BYTES is served", [st, n]);
  const spare = (await all("SELECT host FROM fleet_host_certs WHERE fleet = ?1 AND length(CAST(bytes AS BLOB)) < 65536 LIMIT 1", f.fleet))[0].host;
  await exec("UPDATE fleet_host_certs SET bytes = bytes || 'a' WHERE host = ?1", spare);
  [st, n] = await size();
  ok(st === 500 && n === 0, "P-6: one byte more is a 500, nothing served", [st, n]);
}

// ---- P-7: the 64-host bound, inside the pairing batch
{
  const f = await created(core.newId());
  for (let i = 0; i < 62; i++) await exec("INSERT INTO fleet_hosts (host, fleet, sign_key, fingerprint, revoked) VALUES (?1, ?2, ?3, ?4, 0)", core.newId(), f.fleet, rand(32), rand(32));
  const h63 = await pairOf(f);
  ok(h63.r.ok, "P-7: the 63rd host pairs", h63.r);
  const x = await pairOf(f);
  ok(x.r.ok, "P-7: the 64th host pairs", x.r);
  const over = await pairOf(f);
  ok(over.r.refused === "limit" && (await all("SELECT COUNT(*) AS n FROM fleet_hosts WHERE fleet = ?1", f.fleet))[0].n === 64, "P-7: the 65th: limit, nothing written", over.r);
  // two pairings racing for the last slot
  const g = await created(core.newId());
  for (let i = 0; i < 63; i++) await exec("INSERT INTO fleet_hosts (host, fleet, sign_key, fingerprint, revoked) VALUES (?1, ?2, ?3, ?4, 0)", core.newId(), g.fleet, rand(32), rand(32));
  const race = await Promise.all([pairOf(g), pairOf(g)]);
  ok(race.filter((p) => p.r.ok).length === 1 && race.filter((p) => p.r.refused === "limit").length === 1
    && (await all("SELECT COUNT(*) AS n FROM fleet_hosts WHERE fleet = ?1", g.fleet))[0].n === 64, "P-7: two pairings racing for the 64th slot: exactly one", race.map((p) => p.r));
}

// ---- P-8: /hosts/<id>/grants: the lineage, its cursors, and an in-order verification on the page's side
{
  const f = await created(core.newId());
  const h = await pairOf(f);
  // a lineage: G1 native, then two browser narrowings (verified by the writer against each predecessor)
  const a = core.newId();
  const g1 = await grantOf(f, h, 1, [agentEntry(a)]);
  const g2 = await grantOf(f, h, 2, [agentEntry(a, { workspace: [{ path: "/Algebra", access: "read" }] })], { by: f.browser });
  const g3 = await grantOf(f, h, 3, [agentEntry(a, { workspace: [{ path: "/Algebra", access: "read" }] })], { by: f.browser, not_after_ms: NOW + 1_800_000 });
  for (const g of [g1, g2, g3]) ok((await grant(f, g)).ok, "P-8: a grant of the lineage is accepted");
  const r = await as(f.account, `/api/fleet/v1/hosts/${h.host}/grants`);
  ok(r.status === 200 && r.json.head === 3 && JSON.stringify(r.json.grants) === JSON.stringify([g1, g2, g3].map(text)), "P-8: no cursor: the whole short lineage, ascending, byte-equal", r.json);
  const st = (await W.loadChain(db, core, f.fleet, AUD)).state;
  const certR = { body: { host: h.host }, hash: h.cert };
  let current = null, verified = 0;
  for (const t of r.json.grants) {
    const v = await core.verifyGrant(core.enc(t), { aud: AUD, fleet: f.fleet, chain: st, cert: certR, current, now: NOW });
    current = { gen: v.body.gen, bytes: core.enc(t), body: v.body };
    verified++;
  }
  ok(verified === 3, "P-8: verified in order, each against the previous verified grant (two browser narrowings included)");
  let threw = null;
  try { await core.verifyGrant(core.enc(text(g3)), { aud: AUD, fleet: f.fleet, chain: st, cert: certR, current: null, now: NOW }); } catch (e) { threw = e.code; }
  ok(threw === "device_tier", "P-8: the last narrowing on its own is a widening (device_tier): the walk needs its predecessors", threw);
  // 40 generations, paged both ways (rows stored directly: the cursors are the route's, not the writer's)
  const k = await pairOf(f);
  for (let gen = 1; gen <= 40; gen++) await exec("INSERT INTO fleet_grants (fleet, host, gen, hash, bytes) VALUES (?1, ?2, ?3, ?4, ?5)", f.fleet, k.host, gen, rand(32), `g${gen}`);
  const page = async (q) => { const x = await as(f.account, `/api/fleet/v1/hosts/${k.host}/grants${q}`); return x.status === 200 ? x.json.grants.map((s) => Number(s.slice(1))) : errorOf(x); };
  const p1 = await page(""), p2 = await page("?before=25"), p3 = await page("?before=9");
  ok(JSON.stringify(p1) === JSON.stringify(Array.from({ length: 16 }, (_, i) => 25 + i)), "P-8: no cursor: 25-40, head included", p1);
  ok(JSON.stringify(p2) === JSON.stringify(Array.from({ length: 16 }, (_, i) => 9 + i)) && JSON.stringify(p3) === JSON.stringify(Array.from({ length: 8 }, (_, i) => 1 + i)), "P-8: before 25 then before 9", [p2, p3]);
  ok(JSON.stringify([...p3, ...p2, ...p1]) === JSON.stringify(Array.from({ length: 40 }, (_, i) => i + 1)), "P-8: the union is exactly 1-40, no duplicate, nothing omitted");
  ok(JSON.stringify(await page("?after=0")) === JSON.stringify(Array.from({ length: 16 }, (_, i) => 1 + i)) && JSON.stringify(await page("?after=16")) === JSON.stringify(Array.from({ length: 16 }, (_, i) => 17 + i)), "P-8: after 0, then after 16");
  for (const q of ["?before=1&after=1", "?before=0", "?before=01", "?after=9007199254740992", "?x=1", "?before="]) ok((await page(q)) === "bad_form", `P-8: ${q}: bad_form`);
  ok(JSON.stringify(await page("?before=1")) === "[]", "P-8: before the first: an empty page");
  const top = Number.MAX_SAFE_INTEGER;
  await exec("INSERT INTO fleet_grants (fleet, host, gen, hash, bytes) VALUES (?1, ?2, ?3, ?4, 'gtop')", f.fleet, k.host, top, rand(32));
  const tp = await as(f.account, `/api/fleet/v1/hosts/${k.host}/grants`);
  ok(tp.json.head === top && tp.json.grants.at(-1) === "gtop", "P-8: head at 2^53 - 1 is on the no-cursor page, with no arithmetic", tp.json?.head);
  ok(errorOf(await as(f.account, `/api/fleet/v1/hosts/${core.newId()}/grants`)) === "not_found" && errorOf(await as(f.account, "/api/fleet/v1/hosts/nope/grants")) === "not_found", "P-8: a host not in the fleet, or not an id: not_found");
}

// ---- P-9: isolation between two accounts' fleets
{
  const fa = await created(core.newId()), fb = await created(core.newId());
  const ha = await pairOf(fa), hb = await pairOf(fb);
  await grant(fb, await grantOf(fb, hb, 1, [agentEntry(core.newId())]));
  const ra = await as(fa.account, "/api/fleet/v1/hosts");
  ok(ra.json.hosts.length === 1 && ra.json.hosts[0].host === ha.host, "P-9: A's hosts are A's only");
  ok(errorOf(await as(fa.account, `/api/fleet/v1/hosts/${hb.host}/grants`)) === "not_found", "P-9: B's host through A's session: not_found");
  const ca = core.parseChainPage((await as(fa.account, "/api/fleet/v1/chain")).bytes, -1).entries.map(text);
  ok(ca.every((e) => JSON.parse(e).body.fleet === fa.fleet), "P-9: A's chain is A's entries only");
}

// ---- P-10: the rate, per account, before any fleet data is read
{
  const f = await created(core.newId());
  for (let i = 0; i < 120 - 3; i++) await as(f.account, "/api/fleet/v1/fleet");
  const r = await as(f.account, "/api/fleet/v1/hosts");
  ok(r.status === 429 && JSON.stringify(r.json) === JSON.stringify({ error: "rate", retry_after_s: 60 }), "P-10: request 121 in a minute: rate, retry_after_s 60", r.json);
  ok((await as(core.newId(), "/api/fleet/v1/fleet")).status === 404, "P-10: another account is unaffected");
}

await mf.dispose();
console.log(`${count - failures}/${count} passed`);
if (failures) process.exit(1);
