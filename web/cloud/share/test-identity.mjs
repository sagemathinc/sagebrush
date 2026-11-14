// ci: web-sync.1 order=18
// Sagebrush-owned identity with WorkOS AuthKit sign-in (AUTH_PROVIDER "workos"), in Miniflare with a real D1 and a
// fake WorkOS: the token check's rows in the Workers runtime; sign-in, the account mapping (never by email, never an
// orphaned account when two sign-ins race), state used once, the session's hour and absolute end; and CoCalc as no
// authority at all in this mode (no sign-in, purge call, plan or tier from it, its sessions refused, no fallback).
//
//   node web/cloud/share/test-identity.mjs
import { createHash, createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { migrations } from "./migrations.mjs";
import { dispatch } from "../../miniflare-dispatch.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

const SITE = "https://sagebrush.test";
const WORKOS = "https://api.workos.test";
const CLIENT = "client_01TESTCLIENT";
const ISSUER = `${WORKOS}/user_management/${CLIENT}`;
const API_KEY = "sk_test_identity_rows";
const COCALC = "https://cocalc.test";

let failures = 0, count = 0;
function ok(cond, what) {
  count++;
  if (!cond) {
    failures++;
    console.log("FAIL", what);
  }
}
const b64url = (b) => Buffer.from(b).toString("base64url");
const sha256b64url = (s) => b64url(createHash("sha256").update(s).digest());

// ---- a fake WorkOS: the client's JWKS, the code exchange (with PKCE), and session revocation
const k1 = generateKeyPairSync("rsa", { modulusLength: 2048 });
const k2 = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = (k, kid) => ({ ...k.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" });
const fake = { keys: [jwk(k1, "k1")], jwksDown: false, jwksFetches: 0, codes: new Map(), authDown: false, revoked: [], revokeAuthBad: 0, cocalcCalls: 0, authCalls: 0 };
const nowS = () => Math.floor(Date.now() / 1000);
function sign(claims, { kid = "k1", key = k1.privateKey, alg = "RS256" } = {}) {
  const h = b64url(JSON.stringify({ alg, kid, typ: "JWT" })), p = b64url(JSON.stringify(claims));
  const s = alg === "RS256" ? createSign("RSA-SHA256").update(`${h}.${p}`).sign(key).toString("base64url") : "";
  return `${h}.${p}.${s}`;
}
const claimsFor = (subject, sid, extra = {}) => ({ iss: ISSUER, sub: subject, sid, client_id: CLIENT, iat: nowS(), exp: nowS() + 300, ...extra });

async function outbound(req) {
  const u = new URL(req.url);
  if (u.origin !== WORKOS) {
    fake.cocalcCalls++;
    return new Response("not found", { status: 404 });
  }
  if (u.pathname === `/sso/jwks/${CLIENT}` || u.pathname.startsWith("/sso/jwks/")) {
    fake.jwksFetches++;
    if (fake.jwksDown) return new Response("down", { status: 503 });
    return Response.json({ keys: fake.keys });
  }
  if (u.pathname === "/user_management/authenticate" && req.method === "POST") {
    fake.authCalls++;
    if (fake.authDown) return new Response("down", { status: 500 });
    const b = await req.json();
    const c = fake.codes.get(b.code);
    fake.codes.delete(b.code);
    if (!c || b.client_id !== CLIENT || b.client_secret !== API_KEY || b.grant_type !== "authorization_code" || sha256b64url(b.code_verifier ?? "") !== c.challenge)
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    if (c.gate) await c.gate;
    return Response.json({ access_token: c.token ?? sign(claimsFor(c.subject, c.sid)), refresh_token: "rt_" + c.sid, authentication_method: "MagicAuth", user: { id: c.subject, email: "someone@example.com" } });
  }
  if (u.pathname === "/user_management/sessions/revoke" && req.method === "POST") {
    if (req.headers.get("authorization") !== `Bearer ${API_KEY}`) {
      fake.revokeAuthBad++;
      return new Response("no", { status: 401 });
    }
    fake.revoked.push((await req.json()).session_id);
    return Response.json({});
  }
  return new Response("not found", { status: 404 });
}

const script = execFileSync("bun", ["build", join(here, "test-identity-entry.ts"), "--format", "esm", "--target", "browser"], { encoding: "utf8" });
const bindings = { AUTH_PROVIDER: "workos", AUTH_ENV: "test", AUTH_ORIGIN: SITE, WORKOS_CLIENT_ID: CLIENT, WORKOS_ISSUER: ISSUER, WORKOS_API_KEY: API_KEY, WORKOS_API: WORKOS, SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", FILES_ORIGIN: "https://files.test",
  // (CoCalc configured too, as on a deployment moving over: with AUTH_PROVIDER "workos" none of it may be used)
  COCALC_ORIGIN: COCALC, COCALC_CLIENT_SECRET: "client-secret", PURGE_KEY: "purge-key" };
const worker = (b) => new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "share", modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"], bindings: b, outboundService: outbound }] }));
const without = (k) => Object.fromEntries(Object.entries(bindings).filter(([n]) => n !== k));
const mf = worker(bindings);
const db = await mf.getD1Database("SHARE_DB");
async function migrate(d) {
  for (const { path: m } of migrations())
    for (const s of readFileSync(m, "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await d.prepare(s).run();
}
await migrate(db);

const fetchSite = (m, path, init = {}) => dispatch(m, (path.startsWith("http") ? "" : SITE) + path, { redirect: "manual", ...init });
const cookieOf = (r, name) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith(name + "="));
const setCookieLine = (r, name) => (r.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(name + "="));
const verify = async (token, extra = {}) => (await fetchSite(mf, "/__verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, ...extra }) })).json();

/** A sign-in up to the callback: login, a code at the fake, and the callback (unless `hold`). */
async function begin(m = mf, ret = "/x") {
  const r = await fetchSite(m, `/auth/login?return=${encodeURIComponent(ret)}`);
  const loc = r.headers.get("location");
  const to = loc ? new URL(loc) : null;
  return { r, to, oauth: cookieOf(r, "__Host-sb_oauth") };
}
async function finish(b, subject, sid, opts = {}) {
  const code = b64url(Buffer.from(Math.random().toString()));
  fake.codes.set(code, { subject, sid, challenge: b.to.searchParams.get("code_challenge"), ...opts });
  return fetchSite(mf, `/auth/callback?code=${code}&state=${b.to.searchParams.get("state")}`, { headers: { cookie: b.oauth } });
}
async function signIn(subject, sid, opts = {}) {
  const b = await begin(mf, opts.ret ?? "/x");
  const cb = await finish(b, subject, sid, opts);
  return { ...b, cb, session: cookieOf(cb, "__Host-sb_session") };
}
const me = (session) => fetchSite(mf, "/api/share/me", { headers: { cookie: session } });
const counts = async () => (await db.prepare("SELECT (SELECT COUNT(*) FROM accounts) a, (SELECT COUNT(*) FROM identities) i, (SELECT COUNT(*) FROM accounts WHERE account_id NOT IN (SELECT account_id FROM identities)) orphans").first());

// ---- 1. the token check, in workerd (the spike's rows, and the review's probes)
{
  const good = claimsFor("user_01GOOD", "session_01GOOD");
  const rows = [
    ["a valid token", sign(good), true],
    ["a tampered payload", (() => { const t = sign(good).split("."); t[1] = b64url(JSON.stringify({ ...good, sub: "user_01EVIL" })); return t.join("."); })(), "ERR_JWS_SIGNATURE_VERIFICATION_FAILED"],
    ["signed by another key under the same kid", sign(good, { key: stranger.privateKey }), "ERR_JWS_SIGNATURE_VERIFICATION_FAILED"],
    ["alg none", sign(good, { alg: "none" }), "ERR_JOSE_ALG_NOT_ALLOWED"],
    ["HS256 with the public key as its secret", (() => { const h = b64url(JSON.stringify({ alg: "HS256", kid: "k1" })), p = b64url(JSON.stringify(good)); return `${h}.${p}.${createHmac("sha256", k1.publicKey.export({ format: "pem", type: "spki" })).update(`${h}.${p}`).digest("base64url")}`; })(), "ERR_JOSE_ALG_NOT_ALLOWED"],
    ["expired", sign({ ...good, exp: nowS() - 120 }), "ERR_JWT_EXPIRED"],
    ["issued in the future", sign({ ...good, iat: nowS() + 600 }), "future"],
    ["a lookalike issuer (prefix of ours)", sign({ ...good, iss: "https://api.workos.test.attacker.invalid/user_management/" + CLIENT }), "ERR_JWT_CLAIM_VALIDATION_FAILED"],
    ["another client's issuer, client_id omitted", sign((({ client_id, ...r }) => r)({ ...good, iss: `${WORKOS}/user_management/client_OTHER` })), "ERR_JWT_CLAIM_VALIDATION_FAILED"],
    ["our issuer, client_id omitted", sign((({ client_id, ...r }) => r)(good)), "ERR_JWT_CLAIM_VALIDATION_FAILED"],
    ["another client's token", sign({ ...good, client_id: "client_OTHER" }), "client"],
    ["no iat", sign((({ iat, ...r }) => r)(good)), "ERR_JWT_CLAIM_VALIDATION_FAILED"],
    ["an empty sid", sign({ ...good, sid: "" }), "session"],
    ["a future nbf", sign({ ...good, nbf: nowS() + 600 }), "ERR_JWT_CLAIM_VALIDATION_FAILED"],
    ["a subject that isn't a WorkOS user id", sign({ ...good, sub: "admin" }), "subject"],
    ["not a JWT", "abc.def", "shape"],
    ["not a string", 42, "shape"],
    ["an unknown kid", sign(good, { kid: "k9" }), "ERR_JWKS_NO_MATCHING_KEY"],
  ];
  let first = true;
  for (const [name, tok, want] of rows) {
    const v = await verify(tok, first ? { fresh: true } : {});
    first = false;
    ok(want === true ? v.ok === true && v.subject === "user_01GOOD" && v.sid === "session_01GOOD" : v.ok === false && v.kind === "invalid" && v.why === want, `T1 token check: ${name} -> ${JSON.stringify(v.ok ? "accepted" : v)}`);
  }
  // (keys: cached per environment, client and issuer; an unknown kid refetches at most once a minute)
  const t0 = Date.now();
  fake.jwksFetches = 0;
  await verify(sign(good), { fresh: true, now: t0 });
  ok(fake.jwksFetches === 1, `T2 keys fetched once (${fake.jwksFetches})`);
  await verify(sign(good), { now: t0 + 1000 });
  ok(fake.jwksFetches === 1, `T2 then cached (${fake.jwksFetches})`);
  fake.keys = [jwk(k1, "k1"), jwk(k2, "k2")];
  const rotated = await verify(sign(claimsFor("user_01GOOD", "session_01GOOD", { iat: Math.floor((t0 + 61000) / 1000), exp: Math.floor((t0 + 61000) / 1000) + 300 }), { kid: "k2", key: k2.privateKey }), { now: t0 + 61000 });
  ok(rotated.ok === true && fake.jwksFetches === 2, `T3 a rotated key: one refetch, accepted (${JSON.stringify(rotated)}, fetches ${fake.jwksFetches})`);
  await verify(sign(claimsFor("user_01GOOD", "session_01GOOD"), { kid: "k9" }), { now: t0 + 70000 });
  ok(fake.jwksFetches === 2, `T3 an unknown kid within the minute: no refetch (${fake.jwksFetches})`);
  await verify(sign(good), { now: t0 + 1000, env: "other-env" });
  ok(fake.jwksFetches === 3, `T4 another environment has its own cache (${fake.jwksFetches})`);
  fake.jwksDown = true;
  const down = await verify(sign(good), { fresh: true });
  ok(down.ok === false && down.kind === "unavailable", `T5 JWKS down: unavailable, never invalid (${JSON.stringify(down)})`);
  fake.jwksDown = false;
  fake.keys = [jwk(k1, "k1")];
  await verify(sign(good), { fresh: true });
}

// ---- 2. sign-in: the redirect, the callback, the account mapping, the session
{
  const b = await begin(mf, "/after?x=1");
  ok(b.r.status === 302 && b.to && b.to.origin === WORKOS && b.to.pathname === "/user_management/authorize", `S1 login goes to AuthKit (${b.r.status} ${b.to})`);
  ok(b.to?.searchParams.get("client_id") === CLIENT && b.to?.searchParams.get("redirect_uri") === `${SITE}/auth/callback` && b.to?.searchParams.get("code_challenge_method") === "S256" && b.to?.searchParams.get("provider") === "authkit", "S1 with our client, our pinned callback and PKCE S256");
  ok(b.r.headers.get("referrer-policy") === "no-referrer" && b.r.headers.get("cache-control") === "no-store", "S1 no referrer, no caching");
  ok(/HttpOnly/.test(setCookieLine(b.r, "__Host-sb_oauth") ?? "") && /Secure/.test(setCookieLine(b.r, "__Host-sb_oauth") ?? ""), "S1 the state cookie is __Host-, Secure, HttpOnly");
  const other = await fetchSite(mf, "https://other.test/auth/login");
  ok(other.status === 404 && !other.headers.get("location"), `S2 another origin: refused (${other.status})`);

  const cb = await finish(b, "user_01ALICE", "session_01A1");
  const s = cookieOf(cb, "__Host-sb_session");
  ok(cb.status === 302 && cb.headers.get("location") === "/after?x=1" && !!s, `S3 the callback signs in and returns (${cb.status} ${cb.headers.get("location")})`);
  ok(cb.headers.get("referrer-policy") === "no-referrer", "S3 the callback sends no referrer");
  ok(/Max-Age=3600/.test(setCookieLine(cb, "__Host-sb_session") ?? ""), "S3 the session cookie lasts the validation hour");
  const m = await (await me(s)).json();
  ok(/^[0-9a-f-]{36}$/.test(m.account_id ?? "") && m.account_id !== "user_01ALICE", `S4 the account id is ours, not WorkOS's (${m.account_id})`);
  ok(m.limits?.tier === "free" && m.limits?.storage_bytes === 256 * 1024 * 1024, `S4 Sagebrush's free plan (${JSON.stringify(m.limits)})`);
  ok(m.email == null, "S4 no email is stored");
  const row = await db.prepare("SELECT s.kind, s.provider_sid, s.expires - s.created AS life, s.abs_expires - s.created AS abs, i.issuer, i.subject, i.account_id FROM sessions s JOIN identities i ON i.identity_id = s.identity_id").first();
  ok(row?.kind === "workos" && row?.provider_sid === "session_01A1" && row?.life === 3600 && row?.abs === 30 * 86400 && row?.issuer === ISSUER && row?.subject === "user_01ALICE" && row?.account_id === m.account_id, `S5 the session row: kind, sid, hour, absolute end, identity (${JSON.stringify(row)})`);

  // (state once: the same callback again, with its own cookie, is refused)
  const code = b64url(Buffer.from("again"));
  fake.codes.set(code, { subject: "user_01ALICE", sid: "session_01A2", challenge: b.to.searchParams.get("code_challenge") });
  const replay = await fetchSite(mf, `/auth/callback?code=${code}&state=${b.to.searchParams.get("state")}`, { headers: { cookie: b.oauth } });
  ok(replay.status === 400 && !cookieOf(replay, "__Host-sb_session"), `S6 a replayed state: refused (${replay.status})`);

  const again = await signIn("user_01ALICE", "session_01A3");
  ok((await (await me(again.session)).json()).account_id === m.account_id, "S7 the same identity signs in to the same account");
  const bob = await signIn("user_01BOB", "session_01B1");
  const mb = await (await me(bob.session)).json();
  ok(mb.account_id && mb.account_id !== m.account_id, "S7 another identity has another account");

  const b2 = await begin();
  const wrong = await fetchSite(mf, `/auth/callback?code=x&state=nope`, { headers: { cookie: b2.oauth } });
  ok(wrong.status === 400, `S8 a state that doesn't match: refused (${wrong.status})`);
  const tampered = await fetchSite(mf, `/auth/callback?code=x&state=${b2.to.searchParams.get("state")}`, { headers: { cookie: b2.oauth.replace(/.$/, (c) => (c === "a" ? "b" : "a")) } });
  ok(tampered.status === 400, `S8 a tampered state cookie: refused (${tampered.status})`);
  const noCookie = await fetchSite(mf, `/auth/callback?code=x&state=${b2.to.searchParams.get("state")}`);
  ok(noCookie.status === 400, `S8 no state cookie: refused (${noCookie.status})`);
  const huge = await fetchSite(mf, `/auth/callback?code=x&state=y`, { headers: { cookie: "__Host-sb_oauth=" + "a".repeat(5000) + ".b" } });
  ok(huge.status === 400, `S8 an oversized state cookie: refused (${huge.status})`);
}

// ---- 3. the mapping can't leave an orphaned account
{
  const before = await counts();
  // (two sign-ins of one new identity at once)
  const [x, y] = [await begin(), await begin()];
  const [cx, cy] = await Promise.all([finish(x, "user_01RACE", "session_01R1"), finish(y, "user_01RACE", "session_01R2")]);
  const sx = cookieOf(cx, "__Host-sb_session"), sy = cookieOf(cy, "__Host-sb_session");
  const ax = (await (await me(sx)).json()).account_id, ay = (await (await me(sy)).json()).account_id;
  const after = await counts();
  ok(!!sx && !!sy && ax === ay, `M1 two parallel sign-ins of one identity: one account (${ax} ${ay})`);
  ok(after.a - before.a === 1 && after.i - before.i === 1 && after.orphans === 0, `M1 exactly one account and one identity added, no orphan (${JSON.stringify(before)} -> ${JSON.stringify(after)})`);
  const sids = await db.prepare("SELECT COUNT(DISTINCT s.identity_id) n FROM sessions s JOIN identities i ON i.identity_id = s.identity_id WHERE i.subject = 'user_01RACE'").first();
  ok(sids?.n === 1, "M1 both sessions reference the winning identity");
  // (the loser's batch itself, exactly as the server writes it: its candidate account is rolled back with it)
  let threw = false;
  try {
    await db.batch([
      db.prepare("INSERT INTO accounts (account_id, created, last_login) VALUES ('99999999-9999-4999-8999-999999999999', 1, 1)"),
      db.prepare("INSERT INTO identities (identity_id, issuer, subject, account_id, created, last_used) VALUES ('loser', ?1, 'user_01RACE', '99999999-9999-4999-8999-999999999999', 1, 1)").bind(ISSUER),
    ]);
  } catch {
    threw = true;
  }
  const loser = await db.prepare("SELECT COUNT(*) n FROM accounts WHERE account_id = '99999999-9999-4999-8999-999999999999'").first();
  ok(threw && loser?.n === 0, `M2 a losing batch fails on UNIQUE and leaves no candidate account (${threw} ${loser?.n})`);
}

// ---- 4. refusals: invalid tokens, WorkOS down, disabled accounts, sessions past their end
{
  const before = await counts();
  const b = await begin();
  const bad = await finish(b, "user_01MALLORY", "session_01M1", { token: sign(claimsFor("user_01MALLORY", "session_01M1", { client_id: "client_OTHER" })) });
  ok(bad.status === 401 && !cookieOf(bad, "__Host-sb_session"), `R1 another client's token at the callback: refused (${bad.status})`);
  const b2 = await begin();
  const none = await finish(b2, "user_01MALLORY", "session_01M2", { token: sign(claimsFor("user_01MALLORY", "session_01M2"), { alg: "none" }) });
  ok(none.status === 401, `R1 alg none at the callback: refused (${none.status})`);
  ok((await counts()).a === before.a, "R1 no account made for a refused token");

  fake.authDown = true;
  const b3 = await begin();
  const down = await finish(b3, "user_01ALICE", "session_01D1");
  ok(down.status === 503 && !down.headers.get("location"), `R2 WorkOS down at the exchange: unavailable, no redirect anywhere (${down.status})`);
  fake.authDown = false;

  const carol = await signIn("user_01CAROL", "session_01C1");
  const cid = (await (await me(carol.session)).json()).account_id;
  await db.prepare("UPDATE accounts SET disabled = 1 WHERE account_id = ?1").bind(cid).run();
  ok((await me(carol.session)).status === 401, "R3 a disabled account's session is refused");
  fake.revoked = [];
  const again = await signIn("user_01CAROL", "session_01C2");
  await new Promise((r) => setTimeout(r, 200));
  ok(again.cb.status === 403 && !again.session, `R3 a disabled account can't sign in (${again.cb.status})`);
  ok(fake.revoked.includes("session_01C2"), `R3 and WorkOS's new session for it is revoked (${fake.revoked})`);

  const dave = await signIn("user_01DAVE", "session_01DV");
  await db.prepare("UPDATE sessions SET abs_expires = ?1 WHERE provider_sid = 'session_01DV'").bind(nowS() - 1).run();
  ok((await me(dave.session)).status === 401, "R4 a session past its absolute end is refused");
  await db.prepare("UPDATE sessions SET abs_expires = ?1, expires = ?2 WHERE provider_sid = 'session_01DV'").bind(nowS() + 86400, nowS() - 1).run();
  ok((await me(dave.session)).status === 401, "R4 a session past its validation hour is refused");
}

// ---- 5. CoCalc is no authority: no sign-in, no purge call, no plans or tiers, its sessions refused, no fallback
{
  const legacyToken = "legacy-token-123";
  const lh = createHash("sha256").update(legacyToken).digest("hex");
  await db.prepare("INSERT INTO accounts (account_id, created) VALUES ('33333333-3333-4333-8333-333333333333', 1)").run();
  await db.prepare("INSERT INTO sessions (token_hash, account_id, created, expires) VALUES (?1, '33333333-3333-4333-8333-333333333333', ?2, ?3)").bind(lh, nowS(), nowS() + 86400).run();
  ok((await me(`__Host-sb_session=${legacyToken}`)).status === 401, "C1 a CoCalc sign-in's session (kind legacy) is refused");
  const body = JSON.stringify({ account_id: "33333333-3333-4333-8333-333333333333", request_id: "11111111-2222-4333-8444-555555555555" });
  const purge = await fetchSite(mf, "/api/admin/purge", { method: "POST", headers: { "content-type": "application/json" }, body });
  ok(purge.status === 404, `C2 CoCalc's purge call is gone (${purge.status})`);
  const status = await fetchSite(mf, "/api/admin/purge/11111111-2222-4333-8444-555555555555");
  ok(status.status === 404, `C2 and its status (${status.status})`);
  ok(fake.cocalcCalls === 0, `C3 CoCalc was never asked anything: no sign-in, plan or tier (${fake.cocalcCalls} calls)`);
  const login = await fetchSite(mf, "/auth/login");
  ok(!(login.headers.get("location") ?? "").startsWith(COCALC), "C4 sign-in never goes to CoCalc");

  // (WorkOS configuration missing: unavailable, never CoCalc's sign-in)
  const half = worker(without("WORKOS_ISSUER"));
  const hdb = await half.getD1Database("SHARE_DB");
  await migrate(hdb);
  const hl = await fetchSite(half, "/auth/login");
  ok(hl.status === 503 && !hl.headers.get("location"), `C5 WorkOS not configured: sign-in unavailable, no redirect (${hl.status})`);
  const hc = await fetchSite(half, "/auth/callback?code=x&state=y");
  ok(hc.status === 503, `C5 and its callback (${hc.status})`);
  await half.dispose();
}

// ---- 6. sign-out and /auth/dev
{
  const erin = await signIn("user_01ERIN", "session_01E1");
  fake.revoked = [];
  const out = await fetchSite(mf, "/auth/logout", { method: "POST", headers: { cookie: erin.session, origin: SITE } });
  await new Promise((r) => setTimeout(r, 200));
  ok(out.status === 200 && /Max-Age=0/.test(setCookieLine(out, "__Host-sb_session") ?? ""), `O1 sign-out clears the cookie (${out.status})`);
  ok((await db.prepare("SELECT COUNT(*) n FROM sessions WHERE provider_sid = 'session_01E1'").first())?.n === 0, "O1 the session row is gone");
  ok(fake.revoked.includes("session_01E1") && fake.revokeAuthBad === 0, `O1 WorkOS asked to end its session, with our key (${fake.revoked})`);
  ok((await me(erin.session)).status === 401, "O1 the cookie no longer works");
  const xsite = await signIn("user_01ERIN", "session_01E2");
  const cross = await fetchSite(mf, "/auth/logout", { method: "POST", headers: { cookie: xsite.session, origin: "https://evil.test" } });
  ok(cross.status === 403 && (await me(xsite.session)).status === 200, `O2 a cross-site sign-out is refused (${cross.status})`);

  const dev = await fetchSite(mf, "/auth/dev", { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify({ token: "dev-token", account_id: "44444444-4444-4444-8444-444444444444" }) });
  const ds = cookieOf(dev, "__Host-sb_session");
  ok(dev.status === 200 && !!ds && (await me(ds)).status === 200, `D1 /auth/dev still makes a DEV test session (${dev.status})`);
  ok((await db.prepare("SELECT kind FROM sessions WHERE account_id = '44444444-4444-4444-8444-444444444444'").first())?.kind === "dev", "D1 of kind dev");
  const noTok = await fetchSite(mf, "/auth/dev", { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify({ token: "nope", account_id: "44444444-4444-4444-8444-444444444444" }) });
  ok(noTok.status === 403, `D2 /auth/dev without its token: refused (${noTok.status})`);
  const prodLike = worker(without("SHARE_DEV"));
  await migrate(await prodLike.getD1Database("SHARE_DB"));
  const pd = await fetchSite(prodLike, "/auth/dev", { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify({ token: "dev-token", account_id: "44444444-4444-4444-8444-444444444444" }) });
  ok(pd.status === 404, `D3 without SHARE_DEV, /auth/dev doesn't exist even with its token bound (${pd.status})`);
  await prodLike.dispose();
}

await mf.dispose();
console.log(`${count - failures}/${count} identity checks passed`);
process.exit(failures ? 1 : 0);
