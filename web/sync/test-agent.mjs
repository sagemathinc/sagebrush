// ci: web-sync.2 order=70
// Agents' grants and their requests on the sync server (design/agent-endpoint.md §1-§3, §7, §8; fs-sync step 1a):
// the person's grants from a session, the token's form and tag checked by the Worker before any object, no Origin,
// the grant's check, its rates and the account's, scope on whole segments, and the access log.  Every verb answers
// 404 not_built, but list and stat, which read the server's index (step 1a2, test-index.mjs).  Behind the SYNC_AGENT switch,
// DEV only.  In Miniflare with real Durable Objects (SQLite).
//
//   node web/sync/test-agent.mjs
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { dispatch } from "../miniflare-dispatch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const units = execFileSync("bun", ["build", join(here, "test-agent-units.ts"), "--format", "esm", "--target", "node"], { encoding: "utf8" });
const U = await import("data:text/javascript;base64," + Buffer.from(units).toString("base64"));
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
async function section(name, fn, ms = 60_000) {
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`didn't finish within ${ms / 1000} s`)), ms)))]);
  } catch (e) {
    ok(false, `${name}: ${e?.stack ?? e}`);
  } finally {
    clearTimeout(timer);
  }
}
const KEY = "test-grant-key";
const b64url = (b) => Buffer.from(b).toString("base64url");
const hashOf = (id) => createHash("sha256").update("sagebrush-account\n" + id).digest("hex");
// (node's own HMAC, so the Worker's tag is checked against an independent computation)
const tag = (hash, id, key = KEY) => b64url(createHmac("sha256", key).update(`sbg1.${hash}.${id}`).digest().subarray(0, 16));
const parts = (token) => token.split(".");

// ---- units: the token's form and tag, scopes, names, the switch
await section("units", async () => {
  const hash = "a".repeat(64), id = "abcdefghij23", secret = b64url(Buffer.alloc(32, 7));
  const t = await U.makeToken(KEY, hash, id, secret);
  ok(t === `sbg1.${hash}.${id}.${secret}.${tag(hash, id)}`, "a token's tag is HMAC-SHA256(key, \"sbg1.\" + hash + \".\" + id), its first 16 bytes in base64url");
  const good = await U.tokenOf("Bearer " + t, KEY);
  ok(good && good.hash === hash && good.id === id && good.secret === secret, "a good token is read back");
  const flip = (s, i) => s.slice(0, i) + (s[i] === "a" ? "b" : "a") + s.slice(i + 1);
  const p = parts(t);
  const bad = [
    ["no header", null], ["not Bearer", "Basic " + t], ["lower-case bearer", "bearer " + t], ["two spaces", "Bearer  " + t], ["a trailing space", "Bearer " + t + " "],
    ["another version", "Bearer sbg2" + t.slice(4)], ["the tag altered", "Bearer " + [...p.slice(0, 4), flip(p[4], 0)].join(".")],
    ["the hash altered", "Bearer " + [p[0], flip(p[1], 3), ...p.slice(2)].join(".")], ["the grant id altered", "Bearer " + [p[0], p[1], flip(p[2], 0), ...p.slice(3)].join(".")],
    ["another key's tag", "Bearer " + [...p.slice(0, 4), tag(hash, id, "other")].join(".")], ["a short secret", "Bearer " + [p[0], p[1], p[2], p[3].slice(1), p[4]].join(".")],
    ["an upper-case hash", "Bearer " + [p[0], p[1].toUpperCase(), ...p.slice(2)].join(".")], ["a fifth dot", "Bearer " + t + ".x"],
  ];
  const h63 = "a".repeat(63), h65 = "a".repeat(65);
  bad.push(["no Bearer at all", t], ["a 63-hex hash, its tag right for it", `Bearer sbg1.${h63}.${id}.${secret}.${tag(h63, id)}`], ["a 65-hex hash, its tag right for it", `Bearer sbg1.${h65}.${id}.${secret}.${tag(h65, id)}`]);
  for (const [what, h] of bad) ok((await U.tokenOf(h, KEY)) === null, "a token is refused by its form or tag: " + what);
  // (the secret alone isn't checked here: it is the account object's, so a token differing only in its secret passes the Worker)
  ok((await U.tokenOf("Bearer " + [p[0], p[1], p[2], b64url(Buffer.alloc(32, 8)), p[4]].join("."), KEY)) !== null, "the secret isn't the Worker's to check");
  const sc = (v) => {
    try {
      return U.checkScopes(v);
    } catch (e) {
      return "refused";
    }
  };
  const s = (path, access = "read") => ({ path, access });
  // (the shipped bounds of the access log, as literals: every other row lowers them through the seam)
  ok(U.AGENT.logDays === 7 && U.AGENT.logRows === 100_000, "the access log is kept 7 days and at most 100,000 rows: " + U.AGENT.logDays + ", " + U.AGENT.logRows);
  ok(sc([]) === "refused" && sc(Array.from({ length: 33 }, (_, i) => s("/f" + i))) === "refused" && Array.isArray(sc(Array.from({ length: 32 }, (_, i) => s("/f" + i)))), "1 to 32 scopes: 32 pass, 0 and 33 are refused");
  ok(sc([{ path: "/A", access: "admin" }]) === "refused" && sc([{ path: "/A" }]) === "refused" && sc([{ path: "/A", access: "read", x: 1 }]) === "refused" && sc(["/A"]) === "refused", "a scope is exactly {path, access}, access read or write");
  ok(sc([s("/A/../B")]) === "refused" && sc([s("A")]) === "refused" && sc([s("/A/./B")]) === "refused" && sc([s("/A\u0000")]) === "refused", "a path normPath refuses is refused (.., relative, ., NUL)");
  ok(sc([s("/A"), s("/A", "write")]) === "refused", "a path twice is refused");
  const sco = sc([s("/Algebra", "write"), s("/Notes")]);
  ok(U.inScope(sco, "/Algebra", "write") && U.inScope(sco, "/Algebra/x.tex", "write") && !U.inScope(sco, "/Algebra2", "read") && !U.inScope(sco, "/Algebra2/x", "read"), "/Algebra covers itself and what's under it, never /Algebra2");
  ok(U.inScope(sco, "/Notes/a", "read") && !U.inScope(sco, "/Notes/a", "write") && !U.inScope(sco, "/", "read"), "read access is read only, and a scope doesn't cover its parent");
  ok(U.inScope(sc([s("/")]), "/Trash/x", "read") && !U.inScope(sc([s("/")]), "/x", "write"), "/ covers the whole workspace");
  const nm = (v) => {
    try {
      return U.checkAgentName(v);
    } catch {
      return "refused";
    }
  };
  ok(nm("x".repeat(64)) === "x".repeat(64) && nm("x".repeat(65)) === "refused" && nm("") === "refused" && nm("a\nb") === "refused" && nm(7) === "refused", "an agent's name: 1 to 64 characters, no control characters");
  ok(U.agentOn({ SYNC_AGENT: "1", SHARE_DEV: "1", GRANT_TAG_KEY: "k" }) && !U.agentOn({ SYNC_AGENT: "1", GRANT_TAG_KEY: "k" }) && !U.agentOn({ SYNC_AGENT: "1", SHARE_DEV: "1" }) && !U.agentOn({ SHARE_DEV: "1", GRANT_TAG_KEY: "k" }), "the switch is on only with SYNC_AGENT 1, on DEV (SHARE_DEV 1), with a tag key");
});

// ---- the Worker
const A = "a9a9a9a9-0001-4a9a-8a9a-a9a9a9a9a901"; // the deterministic cases
const B = "a9a9a9a9-0002-4a9a-8a9a-a9a9a9a9a902"; // another account, with its own grant
const L = "a9a9a9a9-0003-4a9a-8a9a-a9a9a9a9a903"; // the 50-grant limit
const RT = "a9a9a9a9-0004-4a9a-8a9a-a9a9a9a9a904"; // the rates
const LG = "a9a9a9a9-0005-4a9a-8a9a-a9a9a9a9a905"; // the log's bounds
const DL = "a9a9a9a9-0006-4a9a-8a9a-a9a9a9a9a906"; // a grant of an account whose synced data is deleted
const NS = "a9a9a9a9-0007-4a9a-8a9a-a9a9a9a9a907"; // never synced
const NA = "a9a9a9a9-0008-4a9a-8a9a-a9a9a9a9a908"; // signed in, not allowlisted
const SITE = "https://sagebrush.test";
const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8" });
const base = { modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"] };
const shareBindings = { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", COCALC_ORIGIN: "https://cocalc.test", COCALC_CLIENT_SECRET: "client-secret" };
const plan = { storage_bytes: 1 << 30, max_file_bytes: 1 << 20, sync: { enabled: true, version_bytes: 1 << 20, read_bytes_per_day: 1 << 30 } };
const cocalc = async () => Response.json(plan);
const objects = { SYNC_ACCOUNT: { className: "SyncAccount", useSQLite: true }, SYNC_DOC: { className: "SyncDoc", useSQLite: true } };
const ratelimits = (id, fails = 1_000_000) => ({ SYNC_PREAUTH: { namespace_id: id, simple: { limit: 1_000_000, period: 60 } }, SYNC_AGENT_FAIL: { namespace_id: id + "9", simple: { limit: fails, period: 60 } } });
const RO = "a9a9a9a9-0009-4a9a-8a9a-a9a9a9a9a909"; // read-only
const FA = "a9a9a9a9-000b-4a9a-8a9a-a9a9a9a9a90b"; // the first logged row's alarm
const FB = "a9a9a9a9-000c-4a9a-8a9a-a9a9a9a9a90c"; // a grant's expiry armed by its make
const WK = "a9a9a9a9-000d-4a9a-8a9a-a9a9a9a9a90d"; // an alarm already due, and a later wake
const listed = [A, B, L, RT, LG, DL, NS, RO, FA, FB, WK].join(",");
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [
    { ...base, name: "on", bindings: { ...shareBindings, SYNC_ACCOUNTS: listed, SYNC_AGENT: "1", GRANT_TAG_KEY: KEY, SYNC_TEST_PIN_MS: "1000" }, durableObjects: objects, routes: ["sagebrush.test/*"], outboundService: cocalc, ratelimits: ratelimits("3001") },
    { ...base, name: "off", bindings: { ...shareBindings, SYNC_ACCOUNTS: listed, GRANT_TAG_KEY: KEY, SYNC_TEST_PIN_MS: "1000" }, durableObjects: objects, routes: ["off.test/*"], outboundService: cocalc, ratelimits: ratelimits("3002") },
    { ...base, name: "nokey", bindings: { ...shareBindings, SYNC_ACCOUNTS: listed, SYNC_AGENT: "1", SYNC_TEST_PIN_MS: "1000" }, durableObjects: objects, routes: ["nokey.test/*"], outboundService: cocalc, ratelimits: ratelimits("3003") },
    { ...base, name: "noip", bindings: { ...shareBindings, SYNC_ACCOUNTS: listed, SYNC_AGENT: "1", GRANT_TAG_KEY: KEY, SYNC_TEST_PIN_MS: "1000" }, durableObjects: objects, routes: ["noip.test/*"], outboundService: cocalc, ratelimits: { ...ratelimits("3004"), SYNC_PREAUTH: { namespace_id: "3004", simple: { limit: 2, period: 60 } } } },
    // (§7's 10 failed authentications a minute per IP, on its own Worker; and a Worker without that binding)
    { ...base, name: "fail", bindings: { ...shareBindings, SYNC_ACCOUNTS: listed, SYNC_AGENT: "1", GRANT_TAG_KEY: KEY, SYNC_TEST_PIN_MS: "1000" }, durableObjects: objects, routes: ["fail.test/*"], outboundService: cocalc, ratelimits: ratelimits("3005", 10) },
    { ...base, name: "nofail", bindings: { ...shareBindings, SYNC_ACCOUNTS: listed, SYNC_AGENT: "1", GRANT_TAG_KEY: KEY, SYNC_TEST_PIN_MS: "1000" }, durableObjects: objects, routes: ["nofail.test/*"], outboundService: cocalc, ratelimits: { SYNC_PREAUTH: { namespace_id: "3006", simple: { limit: 1_000_000, period: 60 } } } },
  ],
}));
{
  // (one D1 for all four Workers)
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
const get = (s, path, origin = SITE) => at(origin, path, { headers: { cookie: s, origin } });
const agent = (token, verb, params = {}, headers = {}, origin = SITE) =>
  at(origin, "/api/agent/v1/" + verb, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", ...headers }, body: typeof params === "string" ? params : JSON.stringify(params) });
const objectOf = async (id) => {
  const ns = await mf.getDurableObjectNamespace("SYNC_ACCOUNT", "on");
  return ns.get(ns.idFromName("acct:" + hashOf(id)));
};
// (the account object restarted, its storage kept: what it held in memory is gone)
// (it answers again before the test goes on: a call that reached it while it stopped would be lost)
const restart = async (id) => {
  await (await objectOf(id)).crash().catch(() => {});
  for (let i = 0; i < 50; i++) {
    const r = await seam(id, {}).catch(() => null);
    if (r?.status === 200) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("the account object didn't come back after its restart");
};
const seam = (id, v) => at(SITE, "/__test/agent?account=" + id, { method: "POST", body: JSON.stringify(v) });
const make = async (s, scopes, more = {}, origin = SITE) => {
  const r = await post(s, "/api/sync/v1/grants", { agent: "Claude Code on laptop", scopes, ...more }, origin);
  return { status: r.status, ...(await r.json()) };
};
const logOf = async (s, q = "") => (await get(s, "/api/sync/v1/grants/log" + q)).json();
async function enabled(id, origin = SITE) {
  const s = await signIn(id, origin);
  const e = await post(s, "/api/sync/v1/enable", {}, origin);
  ok(e.status === 200, `enable ${id.slice(-2)} on ${origin}: ${e.status}`);
  return s;
}
const answer = async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) });

await section("the switch", async () => {
  for (const origin of ["https://off.test", "https://nokey.test", "https://nofail.test"]) {
    const s = await enabled(A, origin);
    if (origin !== "https://nofail.test") {
      ok((await post(s, "/api/sync/v1/grants", { agent: "x", scopes: [{ path: "/", access: "read" }] }, origin)).status === 404, `${origin}: making a grant is a 404 while the switch is off`);
      ok((await get(s, "/api/sync/v1/grants", origin)).status === 404, `${origin}: and so is the list`);
    }
    const t = `sbg1.${hashOf(A)}.abcdefghij23.${b64url(Buffer.alloc(32))}.${tag(hashOf(A), "abcdefghij23")}`;
    ok((await agent(t, "stat", { path: "/" }, {}, origin)).status === 404, `${origin}: an agent's request is a 404`);
  }
});

let sA, gA, tA;
await section("grants from a session", async () => {
  sA = await enabled(A);
  const m = await make(sA, [{ path: "/Algebra", access: "write" }, { path: "/Notes/", access: "read" }]);
  ok(m.status === 201 && /^sbg1\.[0-9a-f]{64}\.[a-z2-7]{12}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{22}$/.test(m.token), "a grant is made from the session, its token answered once: " + m.status);
  gA = m.grant, tA = m.token;
  const [, h, id, secret, tg] = parts(tA);
  ok(h === hashOf(A) && id === gA.id && tg === tag(h, id), "the token names the account's hash and the grant, and its tag is the server's");
  ok(JSON.stringify(gA.scopes) === JSON.stringify([{ path: "/Algebra", access: "write" }, { path: "/Notes", access: "read" }]) && gA.run_code === false && gA.revoked === null, "its scopes are normalized; it can't run code");
  ok(Math.abs(gA.expires - gA.created - 30 * 86400_000) < 1000, "it expires in 30 days by default");
  const list = await (await get(sA, "/api/sync/v1/grants")).json();
  ok(list.grants.length === 1 && list.grants[0].id === gA.id && !JSON.stringify(list).includes(secret) && !("token_hash" in list.grants[0]), "the list shows the grant, never its secret or hash");
  ok((await make(sA, [{ path: "/", access: "read" }], { days: 90 })).status === 201, "90 days is allowed");
  for (const [what, scopes, more] of [["91 days", [{ path: "/", access: "read" }], { days: 91 }], ["0 days", [{ path: "/", access: "read" }], { days: 0 }], ["no scopes", [], {}], ["a bad path", [{ path: "/a/../b", access: "read" }], {}], ["an unknown field", [{ path: "/", access: "read" }], { run_code: true }]]) {
    ok((await make(sA, scopes, more)).status === 400, "a grant is refused: " + what);
  }
  ok((await post(sA, "/api/sync/v1/grants", { agent: "x".repeat(65), scopes: [{ path: "/", access: "read" }] })).status === 400, "an agent's name over 64 characters is refused");
  ok((await at(SITE, "/api/sync/v1/grants", { method: "POST", headers: { cookie: sA, "content-type": "application/json" }, body: JSON.stringify({ agent: "x", scopes: [{ path: "/", access: "read" }] }) })).status === 403, "a grant is made only from this site's pages (Origin)");
  const sNA = await signIn(NA);
  ok((await make(sNA, [{ path: "/", access: "read" }])).status === 403, "an account not allowlisted can't make one");
  const sNS = await signIn(NS);
  ok((await make(sNS, [{ path: "/", access: "read" }])).status === 403, "nor one that never turned sync on");
});

await section("before any object: the Worker", async () => {
  const p = parts(tA);
  const altered = [...p.slice(0, 4), p[4].slice(0, -1) + (p[4].endsWith("A") ? "B" : "A")].join(".");
  const r = await answer(await agent(altered, "stat", { path: "/Algebra/x" }));
  ok(r.status === 401 && r.error === "unauthorized", "a token whose secret is right but whose tag is altered gets 401 (from the Worker: the object would take it): " + r.status);
  ok((await agent("x", "stat", { path: "/" })).status === 401, "a malformed token gets 401");
  ok((await at(SITE, "/api/agent/v1/stat", { method: "POST", headers: { authorization: tA, "content-type": "application/json" }, body: JSON.stringify({ path: "/Algebra/x" }) })).status === 401, "a good token without \"Bearer \" gets 401");
  const [, hh, ii, ss] = parts(tA);
  ok((await agent(`sbg1.${hh.slice(1)}.${ii}.${ss}.${tag(hh.slice(1), ii)}`, "stat", { path: "/Algebra/x" })).status === 401, "a 63-hex hash with its own right tag gets 401 from the Worker");
  ok((await at(SITE, "/api/agent/v1/stat", { method: "POST", headers: { "content-type": "application/json", cookie: sA }, body: "{}" })).status === 401, "a session cookie is never read: without a token, 401");
  const made = `sbg1.${hashOf("someone-else")}.abcdefghij23.${b64url(Buffer.alloc(32))}.${b64url(Buffer.alloc(16))}`;
  ok((await agent(made, "stat", { path: "/" })).status === 401, "a made-up account hash with a made-up tag gets 401");
  const o = await answer(await agent(tA, "stat", { path: "/Algebra/x" }, { origin: SITE }));
  ok(o.status === 403 && o.error === "cross-site request", "a request with an Origin header is refused, even its own site's, with a good token: " + o.status);
  ok((await agent(tA, "stat", { path: "/Algebra/x" }, { origin: "https://evil.test" })).status === 403, "and from another site");
  ok((await at(SITE, "/api/agent/v1/stat", { headers: { authorization: "Bearer " + tA } })).status === 405, "a GET is refused");
  ok((await agent(tA, "Stat", { path: "/" })).status === 404 && (await at(SITE, "/api/agent/v2/stat", { method: "POST", headers: { authorization: "Bearer " + tA, "content-type": "application/json" }, body: "{}" })).status === 404, "an unknown route is a 404");
  ok((await agent(tA, "stat", "{}", { "content-type": "text/plain" })).status === 415, "the body is JSON");
  // (the token comes before the body: a bad one is 401 whatever the body is)
  ok((await agent("x", "stat", "{}", { "content-type": "text/plain" })).status === 401 && (await agent(altered, "stat", JSON.stringify({ pad: "x".repeat(U.AGENT.bodyBytes) }))).status === 401, "a bad token is refused before its body is looked at (401, not 415 or 413)");
  ok((await agent(tA, "stat", "{")).status === 400, "and parses");
  const big = JSON.stringify({ path: "/Algebra/x", pad: "x".repeat(U.AGENT.bodyBytes) });
  const t = await answer(await agent(tA, "stat", big));
  ok(t.status === 413 && t.limit === "body_bytes", "a body over 64 KiB is refused before the object: " + t.status);
  // the IP's pre-authentication limit comes first (2 a minute on this Worker)
  const n = [];
  for (let i = 0; i < 3; i++) n.push((await agent("x", "stat", {}, {}, "https://noip.test")).status);
  ok(n[0] === 401 && n[1] === 401 && n[2] === 429, "the IP's pre-authentication limit stops a flood: " + n);
});

await section("the grant's check, scope, and the verbs (not built)", async () => {
  const st = await answer(await agent(tA, "stat", { path: "/Algebra/x.tex" }));
  ok(st.status === 200 && st.entry === null, "stat in scope passes every check, and answers from the index (nothing there): " + JSON.stringify(st));
  const ls = await answer(await agent(tA, "list", { folder: "/Notes" }));
  ok(ls.status === 404 && ls.error === "missing", "list of a read scope too, of a folder the index doesn't have: missing");
  const out = await answer(await agent(tA, "stat", { path: "/Algebra2" }));
  ok(out.status === 403 && out.error === "scope" && out.path === "/Algebra2" && out.access === "read", "/Algebra doesn't cover /Algebra2: 403 scope, with the path and the access needed");
  ok((await answer(await agent(tA, "list", { folder: "/" }))).error === "scope", "nor the folder above it");
  ok((await answer(await agent(tA, "stat", { path: "/Notes/../Algebra2" }))).status === 400, "a path normPath refuses is refused, never resolved into scope");
  ok((await answer(await agent(tA, "stat", { folder: "/Algebra" }))).status === 400 && (await answer(await agent(tA, "stat", []))).status === 400, "stat needs its path");
  // (the workspace API's own schema, schema.json: a field it doesn't know, or the wrong type, is refused before scope)
  ok((await answer(await agent(tA, "stat", { path: "/Algebra/x", extra: true }))).status === 400, "stat with a field the schema doesn't have is refused");
  ok((await answer(await agent(tA, "list", { folder: "/Notes", recursive: "yes" }))).status === 400, "list with recursive not a boolean is refused");
  ok((await answer(await agent(tA, "list", { folder: "/Notes", cursor: 5 }))).status === 400, "list with cursor not a string is refused");
  ok((await answer(await agent(tA, "list", { folder: "/Notes", recursive: true, cursor: "c" }))).error === "missing", "list with both options well typed passes its checks (to missing)");
  ok((await answer(await agent(tA, "stat", { path: "/Algebra2", extra: 1 }))).status === 400, "the schema is checked before scope (a bad call out of scope is 400, not 403)");
  for (const v of ["read", "write", "mkdir", "remove", "rename", "history"]) ok((await answer(await agent(tA, v, { path: "/Algebra/x" }))).error === "not_built", v + " isn't built: not_built");
  const u = await answer(await agent(tA, "frob", {}));
  ok(u.status === 404 && u.error === "unknown_verb", "an unknown verb is a 404");
  ok((await answer(await agent(tA, "log", {}))).error === "unknown_verb", "an agent can't read the access log");
  // the same 401 for each (§3: the answer never says which)
  const [, h, id, , tg] = parts(tA);
  const wrong = [h, id, b64url(Buffer.alloc(32, 9)), tg].join(".");
  const sB = await enabled(B);
  const gB = await make(sB, [{ path: "/", access: "read" }]);
  const pB = parts(gB.token);
  const mixed = ["sbg1", h, pB[2], pB[3], tag(h, pB[2])].join(".");
  const noGrant = ["sbg1", h, "zzzzzzzzzzzz", pB[3], tag(h, "zzzzzzzzzzzz")].join(".");
  const NSh = hashOf(NS);
  const neverSynced = ["sbg1", NSh, id, pB[3], tag(NSh, id)].join(".");
  const bodies = [];
  for (const [what, t] of [["a wrong secret", "sbg1." + wrong], ["another account's grant, under this account's hash", mixed], ["no such grant", noGrant], ["an account that never synced", neverSynced]]) {
    const r = await answer(await agent(t, "stat", { path: "/Algebra/x" }));
    ok(r.status === 401, `401: ${what}: ${r.status}`);
    bodies.push(JSON.stringify(r));
  }
  const g2 = await make(sA, [{ path: "/Algebra", access: "read" }]);
  await seam(A, { expire: g2.grant.id });
  bodies.push(JSON.stringify(await answer(await agent(g2.token, "stat", { path: "/Algebra/x" }))));
  const g3 = await make(sA, [{ path: "/Algebra", access: "read" }]);
  ok((await answer(await agent(g3.token, "stat", { path: "/Algebra/x" }))).status === 200, "a grant works before it is revoked");
  const rv = await answer(await post(sA, `/api/sync/v1/grants/${g3.grant.id}/revoke`, {}));
  ok(rv.status === 200 && rv.grant.revoked !== null && rv.grant.revoked_reason === "person", "the person revokes it");
  bodies.push(JSON.stringify(await answer(await agent(g3.token, "stat", { path: "/Algebra/x" }))));
  ok(bodies.every((b) => b === JSON.stringify({ status: 401, error: "unauthorized" })), "a wrong secret, another account's grant, no grant, no account, an expired grant and a revoked one get the same 401: " + [...new Set(bodies)]);
  ok((await post(sA, `/api/sync/v1/grants/${g3.grant.id}/revoke`, {})).status === 200, "revoking twice changes nothing");
  ok((await post(sA, "/api/sync/v1/grants/zzzzzzzzzzzz/revoke", {})).status === 404 && (await post(sB, `/api/sync/v1/grants/${gA.id}/revoke`, {})).status === 404, "a grant is revoked only by its own account");
  // rotation: the old token stops at once
  const ro = await answer(await post(sA, `/api/sync/v1/grants/${gA.id}/rotate`, {}));
  ok(ro.status === 200 && ro.token !== tA && parts(ro.token)[2] === gA.id, "\"New token\" makes another secret for the same grant");
  ok((await agent(tA, "stat", { path: "/Algebra/x" })).status === 401 && (await answer(await agent(ro.token, "stat", { path: "/Algebra/x" }))).status === 200, "the old token stops at once; the new one works");
  tA = ro.token;
  ok((await post(sA, `/api/sync/v1/grants/${g3.grant.id}/rotate`, {})).status === 409 && (await post(sA, `/api/sync/v1/grants/${g2.grant.id}/rotate`, {})).status === 409, "a revoked or expired grant isn't rotated");
  const list = await (await get(sA, "/api/sync/v1/grants")).json();
  ok(list.grants.find((g) => g.id === gA.id).last_used !== null, "a request marks the grant used");
});

await section("50 live grants at most", async () => {
  const s = await enabled(L);
  const ids = [], made = [];
  for (let i = 0; i < 50; i++) {
    const m = await make(s, [{ path: "/f" + i, access: "read" }]);
    made.push(m);
    ids.push(m.grant?.id);
  }
  ok(ids.every(Boolean), "50 grants are made");
  // (the first one makes a request, so it has rate rows; it is also the first revoked, so the first trimmed)
  ok((await answer(await agent(made[0].token, "stat", { path: "/f0/x" }))).status === 200, "(the first grant makes a request)");
  ok((await (await seam(L, {})).json()).rates === 3, "(its two buckets and the account's)");
  const over = await make(s, [{ path: "/x", access: "read" }]);
  ok(over.status === 413 && over.limit === "grants" && over.max === 50, "a 51st is refused: " + over.status);
  await post(s, `/api/sync/v1/grants/${ids[0]}/revoke`, {});
  ok((await make(s, [{ path: "/x", access: "read" }])).status === 201, "revoking one makes room");
  for (let i = 1; i < 50; i++) await post(s, `/api/sync/v1/grants/${ids[i]}/revoke`, {});
  for (let i = 0; i < 49; i++) await make(s, [{ path: "/y" + i, access: "read" }]);
  const all = (await (await get(s, "/api/sync/v1/grants")).json()).grants;
  ok(all.filter((g) => g.revoked === null).length === 50 && all.filter((g) => g.revoked !== null).length === 50, "revoked grants stay listed: " + all.length);
  // a 51st revoked: the next grant made drops the oldest revoked one
  const oldest = all.filter((g) => g.revoked !== null).sort((x, y) => x.revoked - y.revoked)[0].id;
  await post(s, `/api/sync/v1/grants/${all.find((g) => g.revoked === null).id}/revoke`, {});
  ok((await make(s, [{ path: "/z", access: "read" }])).status === 201, "a grant is made beside 51 revoked ones");
  const after = (await (await get(s, "/api/sync/v1/grants")).json()).grants;
  ok(after.filter((g) => g.revoked !== null).length === 50 && !after.some((g) => g.id === oldest), "only the newest 50 revoked grants are kept: the oldest is gone: " + after.filter((g) => g.revoked !== null).length);
  // (grader's P4) the trimmed grant's rate rows went with it: only the account's is left
  const rows4 = JSON.parse((await (await seam(L, {})).json()).rateRows);
  ok(oldest === ids[0] && rows4.length === 1 && rows4[0].key === "account", "the trimmed grant's rate rows are deleted with it: " + rows4.map((r) => r.key));
  // (daybreak2's L1) and with no grant made after: revoking every live one, then one expiring, still lists 50 dead
  const live = after.filter((g) => g.revoked === null);
  for (const g of live.slice(1)) await post(s, `/api/sync/v1/grants/${g.id}/revoke`, {});
  const r1 = (await (await get(s, "/api/sync/v1/grants")).json()).grants;
  ok(r1.length === 51 && r1.filter((g) => g.revoked !== null).length === 50, "revoking 49 live grants, with no grant made, lists 1 live and 50 dead: " + r1.length);
  ok((await (await seam(L, {})).json()).grants === 51, "and revoking trims the table itself to them");
  // (the list's own bound) the last one expired with no alarm armed for it: 51 dead stored, the newest 50 listed
  await seam(L, { expireIn: { id: live[0].id, ms: 0 } });
  const r15 = (await (await get(s, "/api/sync/v1/grants")).json()).grants;
  ok((await (await seam(L, {})).json()).grants === 51 && r15.length === 50 && r15.some((g) => g.id === live[0].id), "an expired grant not yet trimmed: the list still shows only the newest 50: " + r15.length);
  await seam(L, { expire: live[0].id });
  const r2 = (await (await get(s, "/api/sync/v1/grants")).json()).grants;
  ok(r2.length === 50 && r2.some((g) => g.id === live[0].id), "and once the last expires, 50 dead, the newly expired one among them: " + r2.length);
  // (the alarm at that expiry trims the table to them: no make, revoke or list needed)
  const settled = async (id, want) => {
    let n = -1;
    for (let i = 0; i < 40 && n !== want; i++) {
      n = (await (await seam(id, {})).json()).grants;
      if (n !== want) await new Promise((res) => setTimeout(res, 50));
    }
    return n;
  };
  const held = await settled(L, 50);
  ok(held === 50, "and the alarm at its expiry trims the table to exactly those 50 (trimmed at each revoke too): " + held);
  // (daybreak2's L1 pin) 50 live and 50 dead, every live one expiring, with nothing else done: 50 rows, the newest
  for (let i = 0; i < 50; i++) await make(s, [{ path: "/e" + i, access: "read" }]);
  const full = (await (await get(s, "/api/sync/v1/grants")).json()).grants;
  ok(full.filter((g) => g.revoked === null && g.expires > Date.now()).length === 50 && (await settled(L, 100)) === 100, "(50 live and 50 dead)");
  const liveIds = full.filter((g) => g.revoked === null && g.expires > Date.now()).map((g) => g.id).sort();
  await seam(L, { expireLive: true });
  ok((await settled(L, 50)) === 50, "all 50 live expiring, with nothing else done, leaves 50 rows");
  const left = (await (await get(s, "/api/sync/v1/grants")).json()).grants;
  ok(left.length === 50 && left.map((g) => g.id).sort().join() === liveIds.join(), "and they are the newest 50 dead: the ones that just expired");
  const rr = JSON.parse((await (await seam(L, {})).json()).rateRows);
  ok(rr.every((r) => r.key === "account" || liveIds.includes(r.key.slice(2))), "and the rate rows of the trimmed grants went with them");
  // (arm() schedules a live grant's expiry) one set to expire in 0.3 s with no alarm armed, the object restarted: its
  // own arm() has the alarm trim the table at that expiry
  const one = await make(s, [{ path: "/last", access: "read" }]);
  ok((await settled(L, 51)) === 51, "(one more grant: 51 rows)");
  await seam(L, { expireIn: { id: one.grant.id, ms: 300 } });
  await restart(L);
  await new Promise((res) => setTimeout(res, 500));
  ok((await settled(L, 50)) === 50, "after it expires, the alarm arm() set trims the table to 50 again");
  // (and one that expired before the object restarted, with no alarm armed for it: arm() at the start finds 51 dead
  // and has the alarm trim them at once)
  const two = await make(s, [{ path: "/past", access: "read" }]);
  ok((await settled(L, 51)) === 51, "(one more grant: 51 rows again)");
  await seam(L, { expireIn: { id: two.grant.id, ms: 0 } });
  await restart(L);
  ok((await settled(L, 50)) === 50, "a grant that expired before the restart, with no alarm armed: arm() at the start trims the table to 50");
  // (exactly 50 dead, the bound itself, and a restart: arm() arms no wake for them, so the alarm can't fire again and
  // again at the bound; nothing else here is due within a minute)
  await restart(L);
  const cap = await (await seam(L, {})).json();
  ok(cap.grants === 50 && (cap.alarm === null || cap.alarm > Date.now() + 60_000), "exactly 50 dead and a restart: no wake armed for them: " + cap.grants + ", " + (cap.alarm === null ? null : cap.alarm - Date.now()));
  // (and one over by a revoked grant, revoked with no trim and no alarm: arm() at the start counts it as dead too)
  const three = await make(s, [{ path: "/revoked", access: "read" }]);
  ok((await settled(L, 51)) === 51, "(one more grant: 51 rows again)");
  await seam(L, { revokeQuiet: three.grant.id });
  await restart(L);
  ok((await settled(L, 50)) === 50, "51 dead, one of them revoked, and a restart: arm() at the start trims the table to 50");
}, 120_000);

await section("rates: the grant's, then the account's", async () => {
  const s = await enabled(RT);
  const g1 = await make(s, [{ path: "/", access: "read" }]), g2 = await make(s, [{ path: "/", access: "read" }]);
  await seam(RT, { perMinute: 3, perHour: 1000, accountPerMinute: 1000 });
  for (let i = 0; i < 5; i++) await agent(["sbg1", ...parts(g1.token).slice(1, 3), b64url(Buffer.alloc(32, i)), parts(g1.token)[4]].join("."), "stat", { path: "/x" });
  const r = [];
  for (let i = 0; i < 4; i++) r.push(await answer(await agent(g1.token, "stat", { path: "/x" })));
  ok(r.slice(0, 3).every((x) => x.status === 200), "wrong secrets don't use the grant's requests (each is refused before its rates)");
  ok(r[3].status === 429 && r[3].error === "rate" && r[3].limit === "requests_per_minute" && r[3].retry_after > 0, "the 4th in a minute, with 3 a minute: 429 requests_per_minute, with retry_after: " + JSON.stringify(r[3]));
  ok((await answer(await agent(g2.token, "stat", { path: "/x" }))).status === 200, "another grant has its own");
  // (grader's P3) making or revoking another grant trims only removed grants' rows: the spent bucket stays spent
  const g3 = await make(s, [{ path: "/", access: "read" }]);
  ok((await answer(await agent(g1.token, "stat", { path: "/x" }))).limit === "requests_per_minute", "a spent grant stays refused after another grant is made");
  await post(s, `/api/sync/v1/grants/${g3.grant.id}/revoke`, {});
  ok((await answer(await agent(g1.token, "stat", { path: "/x" }))).limit === "requests_per_minute", "and after one is revoked");
  // (kept, not in memory: daybreak2's L3) the object restarted on its storage still refuses, then refills with time
  await restart(RT);
  await seam(RT, { perMinute: 3, perHour: 1000, accountPerMinute: 1000 });
  const after = await answer(await agent(g1.token, "stat", { path: "/x" }));
  ok(after.status === 429 && after.limit === "requests_per_minute" && after.retry_after > 0, "after the object restarts, the spent minute is still spent: " + JSON.stringify(after));
  await seam(RT, { minuteMs: 600 });
  await new Promise((res) => setTimeout(res, 400));
  ok((await answer(await agent(g1.token, "stat", { path: "/x" }))).status === 200, "and it refills as time passes (3 a 0.6 s window here)");
  // (grader S4b) both the minute and the hour spent: the answer names the first in §7's order, the minute
  await seam(RT, { perMinute: 1, perHour: 1, accountPerMinute: 1000, minuteMs: 60_000, resetRates: true });
  ok((await answer(await agent(g1.token, "stat", { path: "/x" }))).status === 200, "(one request spends both)");
  ok((await answer(await agent(g1.token, "stat", { path: "/x" }))).limit === "requests_per_minute", "with the minute and the hour both spent, the refusal names the minute's limit");
  // (grader S4c) retry_after is the time until one request refills: 2 a 2 s window here, so about 1 s after the second
  await seam(RT, { perMinute: 2, perHour: 1000, minuteMs: 2000, resetRates: true });
  await agent(g1.token, "stat", { path: "/x" }), await agent(g1.token, "stat", { path: "/x" });
  const ra = await answer(await agent(g1.token, "stat", { path: "/x" }));
  ok(ra.limit === "requests_per_minute" && ra.retry_after > 700 && ra.retry_after <= 1000, "retry_after is the time until a request refills (about 1 s here): " + ra.retry_after);
  await seam(RT, { perMinute: 100, perHour: 2, accountPerMinute: 1000, minuteMs: 60_000, resetRates: true });
  await agent(g1.token, "stat", { path: "/x" }), await agent(g1.token, "stat", { path: "/x" });
  const h = await answer(await agent(g1.token, "stat", { path: "/x" }));
  ok(h.status === 429 && h.limit === "requests_per_hour", "the hour's limit too: " + JSON.stringify(h));
  // (astra S4) a refusal by a later bucket writes nothing: not the minute's, which had a request left
  const before = (await (await seam(RT, {})).json()).rateRows;
  const h2 = await answer(await agent(g1.token, "stat", { path: "/x" }));
  const after2 = (await (await seam(RT, {})).json()).rateRows;
  ok(h2.limit === "requests_per_hour" && after2 === before, "a later bucket's refusal leaves every bucket as it was: " + (after2 === before));
  await restart(RT);
  await seam(RT, { perMinute: 100, perHour: 2, accountPerMinute: 1000 });
  const h3 = await answer(await agent(g1.token, "stat", { path: "/x" }));
  ok(h3.limit === "requests_per_hour" && (await (await seam(RT, {})).json()).rateRows === before, "and so after a restart");
  await seam(RT, { perMinute: 100, perHour: 1000, accountPerMinute: 3, resetRates: true });
  const a = [];
  for (const t of [g1.token, g2.token, g1.token, g2.token]) a.push(await answer(await agent(t, "stat", { path: "/x" })));
  ok(a.slice(0, 3).every((x) => x.status === 200) && a[3].status === 429 && a[3].limit === "account_requests_per_minute", "all of an account's grants together: " + JSON.stringify(a[3]));
  const ab = (await (await seam(RT, {})).json()).rateRows;
  ok((await answer(await agent(g1.token, "stat", { path: "/x" }))).limit === "account_requests_per_minute" && (await (await seam(RT, {})).json()).rateRows === ab, "the account's refusal leaves the grant's own buckets as they were (astra S4)");
  await restart(RT);
  await seam(RT, { perMinute: 100, perHour: 1000, accountPerMinute: 3 });
  ok((await answer(await agent(g2.token, "stat", { path: "/x" }))).limit === "account_requests_per_minute", "the account's too, across a restart");
});

await section("10 failed authentications a minute per IP", async () => {
  const F = "https://fail.test";
  const s = await enabled(A, F);
  const g = await make(s, [{ path: "/", access: "read" }], {}, F);
  ok(g.status === 201, "a grant on this Worker");
  const wrongSecret = ["sbg1", ...parts(g.token).slice(1, 3), b64url(Buffer.alloc(32, 3)), parts(g.token)[4]].join(".");
  const codes = [];
  // (failures at the Worker, a bad tag, and at the object, a wrong secret, count alike)
  for (let i = 0; i < 11; i++) codes.push((await agent(i % 2 ? wrongSecret : "x", "stat", { path: "/x" }, {}, F)).status);
  ok(codes.slice(0, 10).every((c) => c === 401) && codes[10] === 429, "10 failures a minute from one IP get 401, the 11th 429: " + codes);
  const r = await answer(await agent(wrongSecret, "stat", { path: "/x" }, {}, F));
  ok(r.status === 429 && r.limit === "failed_auth_per_ip", "past it, a failure says which limit: " + JSON.stringify(r));
  ok((await answer(await agent(g.token, "stat", { path: "/x" }, {}, F))).status === 200, "a request that authenticates is never refused by it");
});

await section("the access log", async () => {
  const s = await enabled(LG);
  const g = await make(s, [{ path: "/A", access: "read" }]), g2 = await make(s, [{ path: "/", access: "read" }]);
  await agent(g.token, "stat", { path: "/A/x" });
  await agent(g.token, "list", { folder: "/B" });
  await agent(g.token, "mkdir", { path: "/A/y" });
  const wrong = ["sbg1", ...parts(g.token).slice(1, 3), b64url(Buffer.alloc(32, 1)), parts(g.token)[4]].join(".");
  for (let i = 0; i < 5; i++) await agent(wrong, "stat", { path: "/A/x" });
  // (astra S1: when a refusal was last logged is kept with the grant, so a restart of the object doesn't reset it)
  await restart(LG);
  for (let i = 0; i < 5; i++) await agent(wrong, "stat", { path: "/A/x" });
  await agent(g2.token, "stat", { path: "/A/x" });
  const l = await logOf(s);
  const mine = l.rows.filter((r) => r.grant_id === g.grant.id).reverse();
  ok(mine.length === 4, "a row for each request of the grant, and one for its ten refusals in a minute, across a restart of the object: " + mine.length);
  ok(mine[0].verb === "stat" && mine[0].paths === '["/A/x"]' && mine[0].result === "ok" && mine[0].agent === "Claude Code on laptop", "a row says the verb, its path, the answer and the agent");
  ok(mine[1].result === "scope" && mine[1].paths === '["/B"]' && mine[2].verb === "mkdir" && mine[2].paths === null && mine[3].result === "unauthorized", "a refusal of scope, a verb not built, and a refused secret are rows too");
  const all = JSON.stringify(l);
  ok(!all.includes(parts(g.token)[3]) && !all.includes(parts(wrong)[3]) && !all.includes(g.token.slice(0, 40)), "the log never holds a token or a secret");
  const only = await logOf(s, "?grant=" + g2.grant.id);
  ok(only.rows.length === 1 && only.rows[0].grant_id === g2.grant.id, "the log per grant");
  await seam(LG, { logRows: 5 });
  for (let i = 0; i < 7; i++) await agent(g2.token, "stat", { path: "/z" + i });
  const kept = await logOf(s);
  ok(kept.rows.length === 5 && kept.rows[0].paths === '["/z6"]' && kept.rows[4].paths === '["/z2"]', "past its bound, the oldest rows go first: " + kept.rows.map((r) => r.paths));
  const p1 = await logOf(s, "?before=" + kept.rows[2].id);
  ok(p1.rows.length === 2 && p1.rows[0].id === kept.rows[3].id && p1.more === false, "it pages, newest first");
  // (a page of 2 here; 100 by default)
  await seam(LG, { logPage: 2 });
  const q1 = await logOf(s), q2 = await logOf(s, "?before=" + q1.rows[1].id), q3 = await logOf(s, "?before=" + q2.rows[1].id);
  ok(q1.rows.length === 2 && q1.more === true && q2.rows.length === 2 && q2.more === true && q3.rows.length === 1 && q3.more === false, "a full page says there is more, and before reaches the rest: " + [q1, q2, q3].map((q) => q.rows.length + "/" + q.more));
  ok([...q1.rows, ...q2.rows, ...q3.rows].map((r) => r.id).join() === kept.rows.map((r) => r.id).join(), "the pages together are the log, in order");
  await seam(LG, { logPage: 100 });
  ok((await get(s, "/api/sync/v1/grants/log?before=abc")).status === 400 && (await get(s, "/api/sync/v1/grants/log?before=1234567890123456")).status === 400, "before= that isn't a number, or has 16 digits, is refused");
  // rows older than the log's days (7; here 0.2 s): never shown, with no new request; and deleted by the alarm, 3 a step
  // here, so the 5 rows take two steps
  // (the age lowered without arming the alarm: the rows are still stored when read, so only the read's own filter
  // can hide them)
  await seam(LG, { logRows: 100_000, logMs: 200, logSweep: 3, noArm: true });
  await new Promise((res) => setTimeout(res, 300));
  const stored = (await (await seam(LG, {})).json()).log;
  ok(stored === 5 && (await logOf(s)).rows.length === 0, "rows past the log's age aren't shown, though they are still stored and no request has come since: " + stored);
  // (the restart drops the alarm and the lowered bounds: they are set again, without arming, so only the object's own
  // arm() at its start can have the alarm sweep)
  await restart(LG);
  ok((await seam(LG, { logRows: 100_000, logSweep: 3 })).status === 200 && (await seam(LG, { logMs: 200 })).status === 200, "(the bounds set again after the restart)");
  let left = -1;
  for (let i = 0; i < 40 && left !== 0; i++) {
    left = (await (await seam(LG, {})).json()).log;
    if (left) await new Promise((res) => setTimeout(res, 100));
  }
  ok(left === 0, "and the alarm deletes them, a page at a time, until none is left: " + left);
  // (the log's age back to its 7 days first: at 200 ms the new row could age out before it was read, hidden by the read
  // and swept by the alarm its own write armed, whenever the request and the read took longer than that)
  await seam(LG, { logMs: 7 * 86400_000 });
  await agent(g2.token, "stat", { path: "/new" });
  const aged = await logOf(s);
  ok(aged.rows.length === 1 && aged.rows[0].paths === '["/new"]', "a new row is shown: " + aged.rows.length);
  ok((await get(s, "/api/sync/v1/grants/log?before=x")).status === 400 && (await get(s, "/api/sync/v1/grants/log?grant=../x")).status === 400, "a bad page or grant is refused");
  // one sweep step deletes one page, not every aged row: 5 rows (made at the full age, so no alarm is due for them),
  // then aged without arming one, then single steps of 3
  await seam(LG, { logMs: 7 * 86400_000, logSweep: 3 });
  for (let i = 0; i < 4; i++) await agent(g2.token, "stat", { path: "/s" + i });
  await seam(LG, { logMs: 200, noArm: true, clearAlarm: true });
  await new Promise((res) => setTimeout(res, 300));
  const n0 = (await (await seam(LG, {})).json()).log, n1 = (await (await seam(LG, { sweepNow: true })).json()).log, n2 = (await (await seam(LG, { sweepNow: true })).json()).log;
  ok(n0 === 5 && n1 === 2 && n2 === 0, `an alarm step sweeps one page of aged rows (3 here): ${n0}, then ${n1}, then ${n2}`);
});

await section("a deleted account's grants", async () => {
  const s = await enabled(DL);
  const g = await make(s, [{ path: "/", access: "read" }]);
  ok((await answer(await agent(g.token, "stat", { path: "/x" }))).status === 200, "the grant works");
  const gen = (await (await get(s, "/api/sync/v1/status")).json()).generation;
  const ns = await mf.getDurableObjectNamespace("SYNC_ACCOUNT", "on");
  const acct = ns.get(ns.idFromName("acct:" + hashOf(DL)));
  await acct.holdPurge({ on: true });
  ok((await post(s, "/api/sync/v1/delete", { confirm: "delete", generation: gen })).status === 202, "the person deletes their synced data");
  const r = await answer(await agent(g.token, "stat", { path: "/x" }));
  ok(r.status === 409 && r.error === "deleting" && r.message === "this account's sync is being deleted", "while it is being deleted (the purge held), a request is refused: deleting: " + JSON.stringify(r));
  await acct.holdPurge({ on: false });
  for (let i = 0; i < 100 && (await (await get(s, "/api/sync/v1/status")).json()).state !== "off"; i++) await new Promise((res) => setTimeout(res, 100));
  ok((await agent(g.token, "stat", { path: "/x" })).status === 401, "once deleted, the grant is gone with the synced data");
});

await section("the first logged row arms the alarm", async () => {
  // (grader's R3) a fresh account with no alarm due: its first logged request alone has the alarm set for when that row
  // ages out (t + 7 days + 1 ms: the log's fixed bound, #904; a literal here, not the code's own constant)
  const s = await enabled(FA);
  const g = await make(s, [{ path: "/", access: "read" }]);
  ok((await (await seam(FA, { clearAlarm: true })).json()).alarm === null, "(no alarm due)");
  const t0 = Date.now();
  await agent(g.token, "stat", { path: "/x" });
  const t1 = Date.now();
  const al = (await (await seam(FA, {})).json()).alarm;
  const days = 7 * 86400_000;
  ok(al !== null && al >= t0 + days && al <= t1 + days + 1, "the first logged row sets the alarm to its own age-out: " + (al === null ? null : al - t0 - days));
});

await section("making a grant arms its expiry", async () => {
  // (astra S5) an ordinary make, no seam wake and no restart: with no alarm due, the alarm is set for the new grant's
  // expiry; and a shorter-lived grant made later brings an alarm that is due later forward to its own expiry
  const s = await enabled(FB);
  ok((await (await seam(FB, { clearAlarm: true })).json()).alarm === null, "(no alarm due)");
  const t0 = Date.now();
  const g1 = await make(s, [{ path: "/", access: "read" }], { days: 30 });
  const a1 = (await (await seam(FB, {})).json()).alarm;
  ok(a1 !== null && Math.abs(a1 - (g1.grant.expires + 1)) <= 1, "a grant made sets the alarm to its own expiry: " + (a1 === null ? null : a1 - g1.grant.expires));
  // (a day of 0.3 s here, so a 1-day grant expires 0.3 s after it is made)
  await seam(FB, { dayMs: 300 });
  const g2 = await make(s, [{ path: "/", access: "read" }], { days: 1 });
  const a2 = (await (await seam(FB, {})).json()).alarm;
  ok(a2 !== null && Math.abs(a2 - (g2.grant.expires + 1)) <= 1 && g2.grant.expires - t0 < 5000, "a shorter-lived grant made later brings it forward to that expiry: " + (a2 === null ? null : a2 - g2.grant.expires));
  const g3 = await make(s, [{ path: "/", access: "read" }], { days: 2 });
  const a3 = (await (await seam(FB, {})).json()).alarm;
  ok(a3 === a2 || a3 === null || a3 <= g2.grant.expires + 1, "a later-expiring one doesn't push it back");
});

await section("a read-only account: reads pass, writes are refused", async () => {
  const s = await enabled(RO);
  const g = await make(s, [{ path: "/", access: "write" }]);
  await seam(RO, { readonly: true });
  for (const v of ["write", "remove", "mkdir"]) {
    const r = await answer(await agent(g.token, v, { path: "/x" }));
    ok(r.status === 409 && r.error === "readonly" && r.message === "this account's sync is read-only now", `${v} on a read-only account: 409 readonly: ${JSON.stringify(r)}`);
  }
  ok((await answer(await agent(g.token, "list", { folder: "/" }))).status === 200 && (await answer(await agent(g.token, "stat", { path: "/x" }))).status === 200, "list and stat still pass");
});

// (an account taken off the allow list after its grant was made: the same storage, a Worker whose SYNC_ACCOUNTS no
// longer has it; grader's A14)
const AL = "a9a9a9a9-000a-4a9a-8a9a-a9a9a9a9a90a";
await section("an account taken off the allow list", async () => {
  const dir = join(process.env.TMPDIR || "/tmp", "agent-allow-" + process.pid);
  const one = (accounts) => new Miniflare(convertV4MiniflareOptions({
    resourcePersistencePath: dir,
    workers: [{ ...base, name: "al", bindings: { ...shareBindings, SYNC_ACCOUNTS: accounts, SYNC_AGENT: "1", GRANT_TAG_KEY: KEY, SYNC_TEST_PIN_MS: "1000" }, durableObjects: objects, routes: ["al.test/*"], outboundService: cocalc, ratelimits: ratelimits("3008") }],
  }));
  const AT = "https://al.test";
  let m = one(AL);
  try {
    const db = await m.getD1Database("SHARE_DB", "al");
    const mig = join(here, "../share/migrations");
    for (const f of readdirSync(mig).filter((f) => f.endsWith(".sql")).sort())
      for (const q of readFileSync(join(mig, f), "utf8").replace(/--.*$/gm, "").split(";").map((q) => q.trim()).filter(Boolean)) await db.prepare(q).run();
    const go = (path, init) => dispatch(m, AT + path, { redirect: "manual", ...init });
    const r = await go("/auth/dev", { method: "POST", headers: { origin: AT, "content-type": "application/json" }, body: JSON.stringify({ token: "dev-token", account_id: AL }) });
    const s = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));
    const hdr = { cookie: s, origin: AT, "content-type": "application/json" };
    ok((await go("/api/sync/v1/enable", { method: "POST", headers: hdr, body: "{}" })).status === 200, "(allow) sync on");
    const g = await (await go("/api/sync/v1/grants", { method: "POST", headers: hdr, body: JSON.stringify({ agent: "a", scopes: [{ path: "/", access: "read" }] }) })).json();
    const call = (mm) => dispatch(mm, AT + "/api/agent/v1/stat", { method: "POST", headers: { authorization: "Bearer " + g.token, "content-type": "application/json" }, body: JSON.stringify({ path: "/x" }) });
    ok((await answer(await call(m))).status === 200, "the grant works while the account is allowed");
    await m.dispose();
    m = one("someone-else");
    const r2 = await answer(await call(m));
    ok(r2.status === 403 && r2.error === "forbidden" && r2.message === "sync isn't enabled for this account", "off the allow list, the same grant on the same storage gets 403: " + JSON.stringify(r2));
  } finally {
    await m.dispose().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

// ---- the account object's alarm: one already due is never postponed by a later wake (wakeBy); it runs, then sets the next
await section("an alarm already due is never postponed by a later wake", async () => {
  const s = await enabled(WK);
  const g = await make(s, [{ path: "/", access: "read" }]);
  ok(g.status === 201, "(a grant: its expiry, 30 days out, is an alarm time)");
  const wake = async (v) => (await at(SITE, "/__test/wake?account=" + WK, { method: "POST", body: JSON.stringify(v) })).json();
  const DAY = 86_400_000, NINETY = 90 * DAY;
  // (the alarm handler can't run inside the one call, so each row sees wakeBy's own decision)
  const late = await wake({ alarmIn: -5_000, wake: NINETY });
  ok(late.alarm !== null && late.alarm <= 1_000, "overdue (5 s past, not yet run), then a wake 90 days out: it stays due, not 90 days out: " + late.alarm);
  const exact = await wake({ alarmIn: 0, wake: NINETY });
  ok(exact.alarm !== null && exact.alarm <= 1_000, "exactly due, then a wake 90 days out: it stays due: " + exact.alarm);
  const soon = await wake({ alarmIn: -5_000, wake: 1 });
  ok(soon.alarm !== null && soon.alarm <= 1_000, "overdue, then a wake at once: due: " + soon.alarm);
  const keep = await wake({ alarmIn: 3_600_000, wake: NINETY });
  ok(keep.alarm === 3_600_000, "an alarm an hour out, then a wake 90 days out: the hour is kept: " + keep.alarm);
  const earlier = await wake({ alarmIn: 3_600_000, wake: 60_000 });
  ok(earlier.alarm === 60_000, "an alarm an hour out, then a wake in a minute: the minute: " + earlier.alarm);
  const none = await wake({ alarmIn: null, wake: 60_000 });
  ok(none.alarm === 60_000, "no alarm, then a wake in a minute: the minute: " + none.alarm);
  // the handler: a due alarm left due runs, and its own arm() sets the next real time (the grant's expiry, about
  // 30 days out), not the later wake asked for while it was due (90 days)
  await wake({ alarmIn: -5_000, wake: NINETY });
  let after = null;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 50));
    after = await (await at(SITE, "/__test/agent?account=" + WK, { method: "POST", body: "{}" })).json();
    if (after.alarm !== null && after.alarm - Date.now() > DAY) break;
  }
  const left = after?.alarm === null || after?.alarm === undefined ? null : after.alarm - Date.now();
  ok(left !== null && left > 29 * DAY && left < 31 * DAY, "the due alarm runs, and sets the next real time (the grant's expiry, ~30 days), not the 90-day wake: " + (left === null ? null : (left / DAY).toFixed(2) + " days"));
});

console.log(`${count - failures}/${count} passed`);
await mf.dispose();
process.exit(failures ? 1 : 0);
