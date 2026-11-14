// ci: web-sync.1 order=18
// Sagebrush-owned identity with WorkOS AuthKit sign-in (AUTH_PROVIDER "workos"), in Miniflare with a real D1 and a
// fake WorkOS: the token check's rows in the Workers runtime; sign-in, the account mapping (never by email, never an
// orphaned account when two sign-ins race), state used once, the session's hour and absolute end; and CoCalc as no
// authority at all in this mode (no sign-in, purge call, plan or tier from it, its sessions refused, no fallback).
//
//   node web/cloud/share/test-identity.mjs
import { createHash, createHmac, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
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
const fake = { keys: [jwk(k1, "k1")], jwksDown: false, jwksFetches: 0, codes: new Map(), authDown: false, revoked: [], revokeAuthBad: 0, cocalcCalls: 0, authCalls: 0,
  // (refresh tokens: live ones map to their user and session; a refresh rotates the token, and the old one is refused)
  rts: new Map(), refreshDown: false, refreshCalls: 0, refreshGate: null, refreshAs: null, revokeDown: false, revokeCalls: 0 };
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
    if (b.grant_type === "refresh_token") {
      fake.refreshCalls++;
      if (b.client_id !== CLIENT || b.client_secret !== API_KEY) return Response.json({ error: "invalid_client" }, { status: 401 });
      if (fake.refreshGate) await fake.refreshGate;
      if (fake.refreshDown) return new Response("down", { status: 503 });
      const r = fake.rts.get(b.refresh_token);
      if (!r) return Response.json({ error: "invalid_grant" }, { status: 400 });
      fake.rts.delete(b.refresh_token);
      const next = "rt_" + randomBytes(9).toString("hex");
      fake.rts.set(next, r);
      const as = fake.refreshAs ?? r;
      return Response.json({ access_token: sign(claimsFor(as.subject, as.sid)), refresh_token: next, user: { id: r.subject } });
    }
    if (!c || b.client_id !== CLIENT || b.client_secret !== API_KEY || b.grant_type !== "authorization_code" || sha256b64url(b.code_verifier ?? "") !== c.challenge)
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    if (c.gate) await c.gate;
    // (an answer that can't be read: WorkOS may have made a session we can't name)
    if (c.garbage) return new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
    const rt = "rt_" + randomBytes(9).toString("hex");
    fake.rts.set(rt, { subject: c.subject, sid: c.sid });
    return Response.json({ access_token: c.token ?? sign(claimsFor(c.subject, c.sid)), ...(c.noRefresh ? {} : { refresh_token: rt }), authentication_method: "MagicAuth", user: { id: c.subject, email: "someone@example.com" } });
  }
  if (u.pathname === "/user_management/sessions/revoke" && req.method === "POST") {
    fake.revokeCalls++;
    if (fake.revokeDown) return new Response("down", { status: 503 });
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
const REFRESH_KEYS = `v1:${randomBytes(32).toString("base64")}`;
const bindings = { AUTH_PROVIDER: "workos", AUTH_ENV: "test", AUTH_ORIGIN: SITE, WORKOS_CLIENT_ID: CLIENT, WORKOS_ISSUER: ISSUER, WORKOS_API_KEY: API_KEY, WORKOS_API: WORKOS, REFRESH_KEYS, SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", FILES_ORIGIN: "https://files.test",
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

// ---- 1b. the key set: one fetch at a time per key, and a cooldown that counts failed attempts
{
  const good = claimsFor("user_01GOOD", "session_01GOOD");
  const t0 = Date.now();
  fake.keys = [jwk(k1, "k1")];
  fake.jwksFetches = 0;
  await verify(sign(good), { fresh: true, now: t0 });
  // (a key rotated in at WorkOS: 12 concurrent checks of a token signed with it share one refetch, and all wait for it)
  fake.keys = [jwk(k1, "k1"), jwk(k2, "k2")];
  const rotated = sign(good, { kid: "k2", key: k2.privateKey });
  const many = await Promise.all(Array.from({ length: 12 }, () => verify(rotated, { now: t0 + 61000 })));
  ok(fake.jwksFetches === 2 && many.every((v) => v.ok === true), `K1 12 concurrent checks of a newly rotated key: one refetch, all accepted (fetches ${fake.jwksFetches - 1} after the first; ${JSON.stringify(many.map((v) => v.ok ? "ok" : v.why))})`);
  const unknown = sign(good, { kid: "k7" });
  const again = await Promise.all(Array.from({ length: 12 }, () => verify(unknown, { now: t0 + 62000 })));
  ok(fake.jwksFetches === 2 && again.every((v) => v.ok === false && v.kind === "invalid"), `K1 then 12 concurrent unknown-kid checks within the minute: no fetch, all invalid (${fake.jwksFetches})`);
  fake.jwksDown = true;
  const seq = [];
  for (let i = 0; i < 4; i++) seq.push(await verify(unknown, { now: t0 + 130000 + i * 1000 }));
  ok(fake.jwksFetches === 3, `K2 4 sequential unknown-kid checks while WorkOS is down: one attempt (${fake.jwksFetches - 2})`);
  ok(seq.every((v) => v.ok === false && v.kind === "unavailable"), `K2 and each is "unavailable", never "invalid" (${JSON.stringify(seq.map((v) => v.kind))})`);
  const ok1 = await verify(sign(good), { now: t0 + 131000 });
  ok(ok1.ok === true, "K2 a known key still verifies from the cache meanwhile");
  fake.jwksFetches = 0;
  const cold = [];
  for (let i = 0; i < 4; i++) cold.push(await verify(sign(good), i === 0 ? { fresh: true, now: t0 } : { now: t0 + i * 1000 }));
  ok(fake.jwksFetches === 1 && cold.every((v) => v.kind === "unavailable"), `K3 no cache and WorkOS down: one attempt for 4 checks within the cooldown (${fake.jwksFetches})`);
  await verify(sign(good), { now: t0 + 6000 });
  ok(fake.jwksFetches === 2, `K3 after the cooldown, one new attempt (${fake.jwksFetches})`);
  fake.jwksDown = false;
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

// ---- 2b. sign-in states: remembered until they can't be accepted, bounded, and not spent by a callback without a code
{
  const b = await begin();
  const before = (await db.prepare("SELECT COUNT(*) n FROM auth_states").first()).n;
  const noCode = await fetchSite(mf, `/auth/callback?state=${b.to.searchParams.get("state")}`, { headers: { cookie: b.oauth } });
  ok(noCode.status === 400 && (await db.prepare("SELECT COUNT(*) n FROM auth_states").first()).n === before, `S9 a callback with neither code nor error: refused, its state not spent (${noCode.status})`);
  const calls = fake.authCalls;
  const badCode = await fetchSite(mf, `/auth/callback?code=not-a-code&state=${b.to.searchParams.get("state")}`, { headers: { cookie: b.oauth } });
  ok(badCode.status === 400 && fake.authCalls === calls + 1 && (await db.prepare("SELECT COUNT(*) n FROM auth_states").first()).n === before + 1, `S9 a bad code: WorkOS refuses it, and its state is spent (${badCode.status})`);
  await db.prepare("INSERT INTO auth_states (nonce_hash, expires) VALUES ('old', ?1), ('edge', ?2), ('live', ?3)").bind(nowS() - 3600, nowS() - 30, nowS() + 300).run();
  await fetchSite(mf, "/__scheduled", { method: "POST" });
  const left = (await db.prepare("SELECT nonce_hash FROM auth_states WHERE nonce_hash IN ('old', 'edge', 'live') ORDER BY nonce_hash").all()).results.map((r) => r.nonce_hash);
  ok(left.join() === "edge,live", `S10 the scheduled job removes states past their exp plus the skew, keeps the rest (${left})`);
  const small = worker({ ...bindings, AUTH_STATES_MAX: "1" });
  const sdb = await small.getD1Database("SHARE_DB");
  await migrate(sdb);
  await sdb.prepare("INSERT INTO auth_states (nonce_hash, expires) VALUES ('held', ?1)").bind(nowS() + 300).run();
  const sb = await begin(small);
  const code = b64url(Buffer.from("full"));
  fake.codes.set(code, { subject: "user_01FULL", sid: "session_01F1", challenge: sb.to.searchParams.get("code_challenge") });
  const callsFull = fake.authCalls;
  const full = await fetchSite(small, `/auth/callback?code=${code}&state=${sb.to.searchParams.get("state")}`, { headers: { cookie: sb.oauth } });
  ok(full.status === 503 && fake.authCalls === callsFull, `S11 the state table full: refused before WorkOS is asked (${full.status})`);
  ok((await sdb.prepare("SELECT COUNT(*) n FROM auth_states WHERE nonce_hash = 'held'").first()).n === 1, "S11 and no unexpired record was removed to make room");
  await small.dispose();
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
  await db.prepare("UPDATE sessions SET abs_expires = ?1, expires = ?2, validated = ?3 WHERE provider_sid = 'session_01DV'").bind(nowS() + 86400, nowS() - 1, nowS() - 3700).run();
  const calls = fake.refreshCalls;
  ok((await me(dave.session)).status === 200 && fake.refreshCalls === calls + 1, "R4 a session past its validation hour is refreshed with WorkOS first, then served");
  const dv = await db.prepare("SELECT validated, expires FROM sessions WHERE provider_sid = 'session_01DV'").first();
  ok(dv.validated >= nowS() - 5 && dv.expires > nowS() + 3500, `R4 and its validation and hour start again (${JSON.stringify(dv)})`);
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

// ---- 7. session kinds are exclusive in both modes; /auth/dev's sessions count only while its gates are on
{
  const legacyBindings = { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", FILES_ORIGIN: "https://files.test" };
  const seed = async (d, kind, opts = {}) => {
    const token = "tok-" + kind + "-" + Math.random().toString(36).slice(2);
    const acct = crypto.randomUUID();
    await d.prepare("INSERT INTO accounts (account_id, created, disabled) VALUES (?1, 1, ?2)").bind(acct, opts.disabled ? 1 : null).run();
    await d.prepare("INSERT INTO sessions (token_hash, account_id, created, expires, kind, abs_expires, validated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?3)").bind(createHash("sha256").update(token).digest("hex"), acct, nowS(), nowS() + 3600, kind, opts.abs ?? null).run();
    return `__Host-sb_session=${token}`;
  };
  const mine = (m, s) => fetchSite(m, "/api/share/mine", { headers: { cookie: s } });
  const legacy = worker(legacyBindings);
  const ldb = await legacy.getD1Database("SHARE_DB");
  await migrate(ldb);
  ok((await mine(legacy, await seed(ldb, "legacy"))).status === 200, "K-M1 CoCalc sign-in mode: a legacy session still counts");
  ok((await mine(legacy, await seed(ldb, "workos"))).status === 401, "K-M1 CoCalc sign-in mode: a WorkOS session never counts");
  ok((await mine(legacy, await seed(ldb, "legacy", { disabled: true }))).status === 401, "K-M1 CoCalc sign-in mode: a disabled account's session is refused");
  ok((await mine(legacy, await seed(ldb, "legacy", { abs: nowS() - 1 }))).status === 401, "K-M1 CoCalc sign-in mode: a session past its absolute end is refused");
  ok((await mine(legacy, await seed(ldb, "dev"))).status === 200, "K-M2 with DEV's gates on, a /auth/dev session counts");
  const ld = await fetchSite(legacy, "/auth/dev", { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify({ token: "dev-token", account_id: "55555555-5555-4555-8555-555555555555" }) });
  ok(ld.status === 200 && (await ldb.prepare("SELECT kind FROM sessions WHERE account_id = '55555555-5555-4555-8555-555555555555'").first())?.kind === "dev", "K-M2 /auth/dev in CoCalc sign-in mode makes a session of kind dev");
  await legacy.dispose();
  const ungated = worker({ ...legacyBindings, SHARE_DEV: "0" });
  const udb = await ungated.getD1Database("SHARE_DB");
  await migrate(udb);
  ok((await mine(ungated, await seed(udb, "dev"))).status === 401, "K-M3 DEV's gates off: a stale /auth/dev session no longer counts (CoCalc sign-in mode)");
  await ungated.dispose();
  const wUngated = worker(without("DEV_AUTH_TOKEN"));
  const wdb = await wUngated.getD1Database("SHARE_DB");
  await migrate(wdb);
  ok((await mine(wUngated, await seed(wdb, "dev"))).status === 401, "K-M3 DEV's gates off: a stale /auth/dev session no longer counts (WorkOS mode)");
  ok((await mine(wUngated, await seed(wdb, "workos"))).status === 200, "K-M3 while a WorkOS session there does");
  await wUngated.dispose();
}

// ---- 8. sessions: refresh before use, fencing, the outage grace, local revocation, the barrier, the revoke outbox
{
  const sess = (sid, d = db) => d.prepare("SELECT * FROM sessions WHERE provider_sid = ?1").bind(sid).first();
  const queued = async (sid, d = db) => (await d.prepare("SELECT reason, sid_unknown, attempts, exhausted FROM revoke_outbox WHERE sid = ?1").bind(sid).all()).results;
  const age = (sid, by = 3700) => db.prepare("UPDATE sessions SET validated = ?2, expires = ?3, refresh_failed = NULL WHERE provider_sid = ?1").bind(sid, nowS() - by, nowS() - 1).run();
  const post = (m, path, session, body = {}) => fetchSite(m, path, { method: "POST", headers: { "content-type": "application/json", origin: SITE, ...(session ? { cookie: session } : {}) }, body: JSON.stringify(body) });
  const accountOf = async (sid) => (await sess(sid)).account_id;
  const settle = () => new Promise((r) => setTimeout(r, 250));
  const gate = () => {
    let open;
    const p = new Promise((r) => (open = r));
    return { p, open };
  };

  // the seal itself, in workerd
  const k = () => randomBytes(32).toString("base64");
  const sl = await (await fetchSite(mf, "/__seal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ old: `v1:${k()}`, next: `v2:${k()}` }) })).json();
  ok(sl.oldVersion === "v1" && sl.newVersion === "v2" && sl.rotatedOpensOld === "rt_one" && sl.rotatedOpensNew === "rt_two", `T1 a rotation seals with the new key and still opens the old (${JSON.stringify(sl)})`);
  ok(sl.retiredOpensOld === null, "T1 a retired key's seals no longer open");
  ok(sl.otherSession === null && sl.otherIdentity === null && sl.otherEnv === null && sl.versionSwapped === null, "T1 a seal moved to another session, identity, environment or key version doesn't open");
  ok(sl.freshNonce && sl.malformed.every(Boolean), "T1 every seal has a fresh nonce; a missing, short, colon-less or repeated key is refused");

  // refresh: concurrent requests share one refresh, the token rotates, the session is served
  const e = await signIn("user_01EZRA", "session_01EZ");
  await age("session_01EZ");
  const ct0 = (await sess("session_01EZ")).refresh_ct;
  let g = gate();
  fake.refreshGate = g.p;
  const c0 = fake.refreshCalls;
  const many = Array.from({ length: 6 }, () => me(e.session));
  await settle();
  g.open();
  fake.refreshGate = null;
  const st = (await Promise.all(many)).map((r) => r.status);
  ok(st.every((s) => s === 200) && fake.refreshCalls === c0 + 1, `T2 six concurrent requests past the hour share one refresh and are all served (${st}, ${fake.refreshCalls - c0} refreshes)`);
  const e1 = await sess("session_01EZ");
  const liveE = [...fake.rts.values()].filter((r) => r.sid === "session_01EZ").length;
  ok(e1.refresh_ct !== ct0 && e1.key_version === "v1" && liveE === 1, `T2 the rotated refresh token is stored (sealed), and WorkOS holds exactly one live token for it (${e1.refresh_ct !== ct0} ${e1.key_version} ${liveE})`);
  ok(!JSON.stringify(e1).includes("rt_"), "T2 the stored row holds no refresh token in the clear");

  // a stale refusal, after another refresh rotated the token, ends nothing
  const f = await signIn("user_01FINN", "session_01F1");
  await age("session_01F1");
  const fRow = await sess("session_01F1");
  const fRt = [...fake.rts.entries()].find(([, r]) => r.sid === "session_01F1")[0];
  g = gate();
  fake.refreshGate = g.p;
  const inFlight = me(f.session);
  await settle();
  // (another isolate's refresh wins meanwhile: a new sealed token and validation are in the row; WorkOS then refuses the old token)
  await db.prepare("UPDATE sessions SET refresh_ct = 'rotated-elsewhere', validated = ?2, expires = ?3 WHERE provider_sid = ?1").bind("session_01F1", nowS(), nowS() + 3600).run();
  fake.rts.delete(fRt);
  g.open();
  fake.refreshGate = null;
  const fs = (await inFlight).status;
  ok(fs === 200 && (await sess("session_01F1")) && (await queued("session_01F1")).length === 0, `T3 a stale refusal for a rotated-away token ends nothing; the request goes on with the winner's session (${fs})`);
  ok(fRow.refresh_ct !== "rotated-elsewhere", "T3 (the row really had changed under it)");

  // a refresh that finishes after each kind of local revocation changes nothing and can't bring the session back
  for (const kind of ["logout", "everywhere", "disable"]) {
    const subj = `user_01LATE${kind.toUpperCase()}`, sid = `session_01L${kind.slice(0, 3).toUpperCase()}`;
    const s = await signIn(subj, sid);
    const other = kind === "everywhere" ? await signIn(subj, sid + "B") : null;
    const acct = await accountOf(sid);
    await age(sid);
    g = gate();
    fake.refreshGate = g.p;
    const pending = me(s.session);
    await settle();
    if (kind === "logout") await post(mf, "/auth/logout", s.session);
    if (kind === "everywhere") await post(mf, "/auth/logout-everywhere", other.session);
    if (kind === "disable") await post(mf, "/__disable", null, { account: acct });
    g.open();
    fake.refreshGate = null;
    const r = (await pending).status;
    await settle();
    const left = await db.prepare("SELECT COUNT(*) n FROM sessions WHERE account_id = ?1").bind(acct).first();
    ok(r === 401 && left.n === 0, `T4 a refresh finishing after ${kind}: refused, and no session comes back (${r}, ${left.n})`);
    const q = [...(await queued(sid)), ...(fake.revoked.includes(sid) ? ["delivered"] : [])];
    ok(q.length >= 1, `T4 ${kind}: WorkOS's session is queued for revoking or already revoked (${JSON.stringify(q)})`);
    ok((await me(s.session)).status === 401, `T4 ${kind}: the old cookie stays refused`);
  }

  // the outage grace: from the last good validation, never from a failed attempt
  const h = await signIn("user_01HOPE", "session_01H1");
  await db.prepare("UPDATE sessions SET validated = ?2 WHERE provider_sid = ?1").bind("session_01H1", nowS() - 3590).run();
  let c1 = fake.refreshCalls;
  ok((await me(h.session)).status === 200 && fake.refreshCalls === c1, "T5 inside its hour: served without asking WorkOS");
  await age("session_01H1");
  const vBefore = (await sess("session_01H1")).validated;
  fake.refreshDown = true;
  c1 = fake.refreshCalls;
  ok((await me(h.session)).status === 200 && fake.refreshCalls === c1 + 1, "T5 WorkOS down, past the hour, inside the grace: served after one failed attempt");
  const h1 = await sess("session_01H1");
  ok(h1.validated === vBefore && h1.refresh_failed !== null && h1.expires === Math.min(vBefore + 24 * 3600, h1.abs_expires), `T5 a failed attempt never moves validated; expiry becomes its grace end (${JSON.stringify({ v: h1.validated, e: h1.expires })})`);
  c1 = fake.refreshCalls;
  ok((await me(h.session)).status === 200 && fake.refreshCalls === c1, "T5 within a minute of the failure: not asked again, still served");
  await db.prepare("UPDATE sessions SET validated = ?2, refresh_failed = NULL WHERE provider_sid = ?1").bind("session_01H1", nowS() - 24 * 3600 - 5).run();
  const past = await me(h.session);
  ok(past.status === 503 && (await sess("session_01H1")), `T5 past the grace with WorkOS down: 503 "retry", and the session is kept (${past.status})`);
  await db.prepare("UPDATE sessions SET abs_expires = ?2 WHERE provider_sid = ?1").bind("session_01H1", nowS() - 1).run();
  ok((await me(h.session)).status === 401, "T5 past its absolute end: refused, grace or not");
  await db.prepare("UPDATE sessions SET abs_expires = ?2, validated = ?3, refresh_failed = ?3, expires = ?4 WHERE provider_sid = ?1").bind("session_01H1", nowS() + 86400, nowS() - 3700, nowS() + 3600).run();
  await post(mf, "/auth/logout", h.session);
  ok((await me(h.session)).status === 401 && !(await sess("session_01H1")), "T5 a local sign-out ends it at once, grace or not");
  fake.refreshDown = false;

  // WorkOS refusing, or answering for another user or session, ends the session (its revocation queued)
  const i = await signIn("user_01IRIS", "session_01I1");
  await age("session_01I1");
  for (const [rt, r] of fake.rts) if (r.sid === "session_01I1") fake.rts.delete(rt);
  ok((await me(i.session)).status === 401 && !(await sess("session_01I1")), "T6 WorkOS refusing the refresh ends the session");
  ok((await queued("session_01I1"))[0]?.reason === "refused" || fake.revoked.includes("session_01I1"), "T6 and its WorkOS session is queued for revoking");
  const j = await signIn("user_01JUDE", "session_01J1");
  await age("session_01J1");
  fake.refreshAs = { subject: "user_01SOMEONE", sid: "session_01OTHER" };
  ok((await me(j.session)).status === 401 && !(await sess("session_01J1")), "T6 a refresh answering for another user or session ends it; it never moves the session");
  fake.refreshAs = null;
  const k1s = await signIn("user_01KAI", "session_01K1");
  const k2s = await signIn("user_01KIM", "session_01K2");
  await db.prepare("UPDATE sessions SET refresh_ct = (SELECT refresh_ct FROM sessions WHERE provider_sid = 'session_01K1') WHERE provider_sid = 'session_01K2'").run();
  await age("session_01K2");
  ok((await me(k2s.session)).status === 401 && (await me(k1s.session)).status === 200, "T6 a sealed token copied into another session doesn't open there: that session ends, the original is untouched");

  // sign-out everywhere is a barrier: a sign-in that started before it can't make a session, even finishing after
  const before = await begin(mf, "/x");
  const m1 = await signIn("user_01MAYA", "session_01M1");
  await post(mf, "/auth/logout-everywhere", m1.session);
  const late = await finish(before, "user_01MAYA", "session_01M0");
  await settle();
  ok(late.status === 403 && !cookieOf(late, "__Host-sb_session"), `T7 a sign-in started before sign-out everywhere is refused, though it finishes after (${late.status})`);
  ok((await queued("session_01M0")).length === 1 || fake.revoked.includes("session_01M0"), "T7 and the session WorkOS made for it is queued for revoking");
  const after = await signIn("user_01MAYA", "session_01M2");
  ok(after.session && (await me(after.session)).status === 200, "T7 a sign-in started after the barrier stands");

  // at most SESSIONS_MAX sessions: the evicted one's WorkOS session is queued
  fake.revokeDown = true;
  for (let n = 0; n < 21; n++) await signIn("user_01NOEL", `session_01N${String(n).padStart(2, "0")}`);
  ok((await db.prepare("SELECT COUNT(*) n FROM sessions WHERE provider_sid LIKE 'session_01N%'").first()).n === 20 && (await queued("session_01N00"))[0]?.reason === "evicted", "T8 a 21st session evicts the oldest, whose WorkOS session is queued in the same batch");

  // delivery: retried with backoff, then kept as exhausted, never dropped
  for (let n = 0; n < 8; n++) {
    await db.prepare("UPDATE revoke_outbox SET next_at = 0 WHERE sid = 'session_01N00'").run();
    await fetchSite(mf, "/__drain", { method: "POST" });
  }
  const ex = (await queued("session_01N00"))[0];
  ok(ex?.attempts === 8 && ex?.exhausted === 1, `T8 a revoke failing 8 times is kept as exhausted (${JSON.stringify(ex)})`);
  const counts0 = await (await fetchSite(mf, "/__outbox")).json();
  ok(counts0.exhausted >= 1, `T8 and counted for the admin page (${JSON.stringify(counts0)})`);
  const lo = await signIn("user_01OTTO", "session_01O1");
  ok((await post(mf, "/auth/logout", lo.session)).status === 200 && (await queued("session_01O1")).length === 1, "T8 a sign-out with WorkOS down still signs out; the revoke stays queued, never claimed done");
  fake.revokeDown = false;
  await db.prepare("UPDATE revoke_outbox SET next_at = 0 WHERE sid = 'session_01O1'").run();
  await fetchSite(mf, "/__drain", { method: "POST" });
  ok((await queued("session_01O1")).length === 0 && fake.revoked.includes("session_01O1"), "T8 once WorkOS answers, the revoke is delivered and its row (its slot) goes");

  // the sweep: a session past its absolute end keeps its slot until its revoke is queued; a pending exchange that
  // never finished becomes an outbox row whose sid is unknown
  const p1 = await signIn("user_01PIA", "session_01P1");
  await db.prepare("UPDATE sessions SET abs_expires = ?2 WHERE provider_sid = ?1").bind("session_01P1", nowS() - 10).run();
  const usedBefore = (await (await fetchSite(mf, "/__outbox")).json()).used;
  ok((await me(p1.session)).status === 401 && (await sess("session_01P1")), "T9 past its absolute end it can't be used, but its row (and slot) stays until the sweep");
  ok((await (await fetchSite(mf, "/__outbox")).json()).used === usedBefore, "T9 expiry alone frees no slot");
  await db.prepare("INSERT INTO pending_exchanges (id, started, expires) VALUES ('dead-exchange', ?1, ?2)").bind(nowS() - 600, nowS() - 400).run();
  const unknownBefore = (await (await fetchSite(mf, "/__outbox")).json()).unknown;
  await fetchSite(mf, "/__scheduled", { method: "POST" });
  ok(!(await sess("session_01P1")) && fake.revoked.includes("session_01P1"), "T9 the sweep removes it, queuing (and here delivering) its revoke");
  const after9 = await (await fetchSite(mf, "/__outbox")).json();
  ok(after9.unknown === unknownBefore + 1 && !(await db.prepare("SELECT 1 FROM pending_exchanges WHERE id = 'dead-exchange'").first()), "T9 a pending exchange that never finished is kept as sid-unknown, never freed");

  // an exchange whose answer is lost after sending: a session may exist at WorkOS, so its slot is kept, sid unknown
  const u0 = (await (await fetchSite(mf, "/__outbox")).json()).unknown;
  const lost = await signIn("user_01QUIN", "session_01Q1", { garbage: true });
  ok(lost.cb.status === 503 && (await (await fetchSite(mf, "/__outbox")).json()).unknown === u0 + 1, `T10 an unreadable exchange answer: refused, its slot kept as sid-unknown (${lost.cb.status})`);
  const noRt = await signIn("user_01RAE", "session_01R1", { noRefresh: true });
  await settle();
  ok(noRt.cb.status === 401 && !noRt.session && ((await queued("session_01R1")).length === 1 || fake.revoked.includes("session_01R1")), "T10 a sign-in without a refresh token can't be kept valid: refused, its WorkOS session queued");
}

// ---- 9. capacity: no WorkOS session exists without room to revoke it
{
  const small = worker({ ...bindings, REVOKE_CAPACITY: "3" });
  const sdb = await small.getD1Database("SHARE_DB");
  await migrate(sdb);
  const used = async () => (await (await fetchSite(small, "/__outbox")).json()).used;
  const signInAt = async (subject, sid, opts = {}) => {
    const b = await begin(small, "/x");
    const code = b64url(Buffer.from(Math.random().toString()));
    fake.codes.set(code, { subject, sid, challenge: b.to.searchParams.get("code_challenge"), ...opts });
    const cb = await fetchSite(small, `/auth/callback?code=${code}&state=${b.to.searchParams.get("state")}`, { headers: { cookie: b.oauth } });
    return { cb, session: cookieOf(cb, "__Host-sb_session") };
  };
  const post = (path, session, body = {}) => fetchSite(small, path, { method: "POST", headers: { "content-type": "application/json", origin: SITE, ...(session ? { cookie: session } : {}) }, body: JSON.stringify(body) });
  fake.revokeDown = true;
  const a = await signInAt("user_01CAPA", "session_01CA");
  const b2 = await signInAt("user_01CAPB", "session_01CB");
  // (an account to disable, while it still has room)
  const c3 = await signInAt("user_01CAPC", "session_01CC");
  ok(a.session && b2.session && c3.session && (await used()) === 3, "C1 three sign-ins fill a capacity of three");
  const calls = fake.authCalls;
  const full = await signInAt("user_01CAPD", "session_01CD");
  ok(full.cb.status === 503 && fake.authCalls === calls, `C1 at capacity a sign-in is refused before WorkOS is asked (${full.cb.status})`);
  ok((await post("/auth/logout", a.session)).status === 200 && (await used()) === 3, "C2 at capacity a sign-out still signs out; its slot becomes its queued revoke");
  ok((await signInAt("user_01CAPE", "session_01CE")).cb.status === 503, "C2 so a new sign-in is still refused while the revoke is queued");
  ok((await post("/auth/logout-everywhere", b2.session)).status === 200 && (await used()) === 3, "C2 sign-out everywhere at capacity revokes locally and keeps its obligation");
  // (room for one: the reserved slot of a sign-in refused after the exchange holds its revoke)
  fake.revokeDown = false;
  await sdb.prepare("UPDATE revoke_outbox SET next_at = 0").run();
  await fetchSite(small, "/__drain", { method: "POST" });
  ok((await used()) === 1, `C3 delivered revokes free their slots (${await used()})`);
  const cAcct = (await sdb.prepare("SELECT account_id FROM sessions WHERE provider_sid = 'session_01CC'").first()).account_id;
  fake.revokeDown = true;
  await post("/__disable", null, { account: cAcct });
  const dis = await signInAt("user_01CAPC", "session_01CC2");
  ok(dis.cb.status === 403 && (await sdb.prepare("SELECT COUNT(*) n FROM revoke_outbox WHERE sid = 'session_01CC2'").first()).n === 1, `C3 a disabled account's sign-in, refused after the exchange, queues WorkOS's session in its reserved slot (${dis.cb.status})`);
  ok((await used()) <= 3, `C3 the sum never exceeds the capacity (${await used()})`);
  fake.revokeDown = false;
  await small.dispose();
}

await mf.dispose();
console.log(`${count - failures}/${count} identity checks passed`);
process.exit(failures ? 1 : 0);
