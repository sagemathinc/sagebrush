// ci: web-sync.1 order=18
// Grants (web/cloud/share/grants.ts; grants design d1, d1r1) with WorkOS sign-in, in Miniflare with a real D1: the
// admin path's checks in order (session, the exact allow-list, a fresh re-authentication of that session, same-origin,
// JSON, the body's bound, the rate), grants made, retried and revoked with their audit rows, the account's limits from
// its active grants (the largest storage, never a sum; a revocation counts on the next request; a failed read is 503),
// the migration's bounds, and the routes absent in every other mode.  Sessions are /auth/dev's (DEV), whose
// reauth_ms the rows move in D1 directly.
//
//   node web/cloud/share/test-grants.mjs
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { migrations } from "./migrations.mjs";
import { dispatch } from "../../miniflare-dispatch.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

let failures = 0, count = 0;
const ok = (c, what, detail) => { count++; if (!c) { failures++; console.log("FAIL", what, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400)); } };

const SITE = "https://sagebrush.test";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ADMIN2 = "abababab-abab-4bab-8bab-abababababab";
// (more admins, so one section's writes never spend another's rate)
const ADMIN3 = "acacacac-acac-4cac-8cac-acacacacacac", ADMIN4 = "adadadad-adad-4dad-8dad-adadadadadad", ADMIN5 = "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GONE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", OFF = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const GiB = 1024 ** 3, FREE = 256 * 1024 * 1024;
const nowS = () => Math.floor(Date.now() / 1000);
const sha = (s) => createHash("sha256").update(s).digest("hex");

// (grants.ts itself, for the allow-list's parse and the fail-closed entitlements)
const tmp = mkdtempSync(join(tmpdir(), "grants-"));
writeFileSync(join(tmp, "grants.mjs"), execFileSync("bun", ["build", join(here, "grants.ts"), "--format", "esm", "--target", "node"], { encoding: "utf8" }));
const G = await import(pathToFileURL(join(tmp, "grants.mjs")).href);
rmSync(tmp, { recursive: true, force: true });

const script = execFileSync("bun", ["build", join(here, "test-identity-entry.ts"), "--format", "esm", "--target", "browser"], { encoding: "utf8" });
const base = { AUTH_PROVIDER: "workos", AUTH_ENV: "test", AUTH_ORIGIN: SITE, WORKOS_CLIENT_ID: "client_01TESTCLIENT", WORKOS_ISSUER: "https://api.workos.test/user_management/client_01TESTCLIENT", WORKOS_API_KEY: "sk_test", WORKOS_API: "https://api.workos.test",
  REFRESH_KEYS: `v1:${Buffer.alloc(32, 7).toString("base64")}`, SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", FILES_ORIGIN: "https://files.test", SAGEBRUSH_ADMINS: ` ${ADMIN} ,, ${ADMIN2} ,${ADMIN3},${ADMIN4},${ADMIN5}` };
const worker = (b) => new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "share", modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"], bindings: b, outboundService: () => new Response("no", { status: 404 }) }] }));
async function migrate(d, skip = []) {
  for (const { name, path } of migrations()) if (!skip.includes(name))
    for (const s of readFileSync(path, "utf8").replace(/--.*$/gm, "").split(";").map((x) => x.trim()).filter(Boolean)) await d.prepare(s).run();
}
const mf = worker(base);
const db = await mf.getD1Database("SHARE_DB");
await migrate(db);

const fetchAt = (m, path, init = {}) => dispatch(m, SITE + path, { redirect: "manual", ...init });
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));
/** a DEV session for the account, re-authenticated `ago` ms ago (null: never) */
async function sessionFor(m, d, account, ago = 0) {
  const r = await fetchAt(m, "/auth/dev", { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify({ token: "dev-token", account_id: account }) });
  const c = cookieOf(r);
  await d.prepare("UPDATE sessions SET reauth_ms = ?2 WHERE token_hash = ?1").bind(sha(c.slice(c.indexOf("=") + 1)), ago === null ? null : Date.now() - ago).run();
  return c;
}
const post = (m, path, cookie, body, headers = {}) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return fetchAt(m, path, { method: "POST", headers: { "content-type": "application/json", origin: SITE, ...(cookie ? { cookie } : {}), ...headers }, body: text });
};
const get = (m, path, cookie) => fetchAt(m, path, { headers: cookie ? { cookie } : {} });
const body = async (r) => { try { return await r.json(); } catch { return null; } };
const counts = async () => db.prepare("SELECT (SELECT COUNT(*) FROM grants) g, (SELECT COUNT(*) FROM grant_audit) a").first();
const limitsOf = async (cookie) => (await body(await get(mf, "/api/share/me", cookie)))?.limits;
let rq = 0;
const reqId = () => `req-${++rq}-${Date.now().toString(36)}`;
const until = (days) => nowS() + days * 86400;

for (const a of [USER, OTHER, GONE, OFF]) await db.prepare("INSERT INTO accounts (account_id, created, last_login) VALUES (?1, 1, 1)").bind(a).run();
await db.prepare("UPDATE accounts SET deleting = 1 WHERE account_id = ?1").bind(GONE).run();
await db.prepare("UPDATE accounts SET disabled = 1 WHERE account_id = ?1").bind(OFF).run();
const admin = await sessionFor(mf, db, ADMIN, 1000);

// ---- G3: the allow-list, parsed exactly
{
  const set = (raw) => G.adminSet(raw);
  ok(set(undefined).admins.size === 0 && set("").admins.size === 0 && set(" , ").admins.size === 0 && set(" , ").why === null, "G3 missing, empty and \" , \": no admins, nothing malformed");
  const two = set(` ${ADMIN} ,, ${ADMIN2} `);
  ok(two.why === null && two.admins.has(ADMIN) && two.admins.has(ADMIN2) && two.admins.size === 2, "G3 entries trimmed, empty ones dropped");
  ok(!two.admins.has(ADMIN.slice(0, 35)) && !two.admins.has(ADMIN.replace(/a$/, "b")) && !two.admins.has(` ${ADMIN}`) && !two.admins.has(ADMIN.toUpperCase()), "G3 exact membership: a prefix, a near miss, a padded or upper-cased id are not admins");
  const pre = set(ADMIN.slice(0, 35) + "a");
  ok(pre.why === null && pre.admins.has(ADMIN) , "G3 control: the full id is an admin");
  const bad = set(`${ADMIN},not-an-id`);
  ok(bad.admins.size === 0 && typeof bad.why === "string", "G3 one malformed entry: no admins at all, with the reason", bad.why);
}
{
  const m2 = worker({ ...base, SAGEBRUSH_ADMINS: `${ADMIN},${ADMIN}x` });
  const d2 = await m2.getD1Database("SHARE_DB");
  await migrate(d2);
  const s = await sessionFor(m2, d2, ADMIN, 1000);
  const r = await get(m2, `/api/admin/grants?account=${USER}`, s);
  ok(r.status === 403, `G3 a deployment whose list has a malformed entry refuses even a listed admin (${r.status})`);
  await m2.dispose();
  const m3 = worker((({ SAGEBRUSH_ADMINS, ...b }) => b)(base));
  const d3 = await m3.getD1Database("SHARE_DB");
  await migrate(d3);
  ok((await get(m3, `/api/admin/grants?account=${USER}`, await sessionFor(m3, d3, ADMIN, 1000))).status === 403, "G3 no SAGEBRUSH_ADMINS: no admins");
  await m3.dispose();
}

// ---- A: the admin path's checks, in order; every refusal writes nothing
{
  const c0 = await counts();
  const g = (o = {}) => ({ request_id: reqId(), account_id: USER, storage_bytes: 10 * GiB, valid_until: until(30), ...o });
  const r1 = await post(mf, "/api/admin/grants", null, g());
  ok(r1.status === 401, `A1 no session: 401 (${r1.status})`);
  const user = await sessionFor(mf, db, USER, 1000);
  const r2 = await post(mf, "/api/admin/grants", user, g());
  const b2 = await body(r2);
  ok(r2.status === 403 && b2?.error === "admin only", `A2 a fresh, re-authenticated session that isn't an admin's: 403 (${r2.status})`);
  // (an account whose id differs from a listed admin's only in its last characters: exact membership, through the route)
  const near = await sessionFor(mf, db, ADMIN.slice(0, 30) + "bbbbbb", 1000);
  const rn = await post(mf, "/api/admin/grants", near, g());
  ok(rn.status === 403 && JSON.stringify(await body(rn)) === JSON.stringify(b2), `A2 an account id matching an admin's but for its last six characters: 403 (${rn.status})`);
  const never = await sessionFor(mf, db, ADMIN, null);
  const r3 = await post(mf, "/api/admin/grants", never, g());
  const b3 = await body(r3);
  ok(r3.status === 403 && JSON.stringify(b3) === JSON.stringify(b2), `A3 an admin's session never re-authenticated: 403, the very same answer as A2's (${r3.status})`);
  const stale = await sessionFor(mf, db, ADMIN, 301_000);
  ok((await post(mf, "/api/admin/grants", stale, g())).status === 403, "A4 an admin re-authenticated 301 s ago: 403");
  const fresh = await sessionFor(mf, db, ADMIN, 295_000);
  const r5 = await post(mf, "/api/admin/grants", fresh, g());
  ok(r5.status === 201, `A4 control: 295 s ago: made (${r5.status})`);
  const c1 = await counts();
  ok(c1.g === c0.g + 1 && c1.a === c0.a + 1, "A refusals A1-A4 wrote nothing; the control wrote one grant and one audit row", { c0, c1 });
  const r6 = await post(mf, "/api/admin/grants", admin, g(), { origin: "https://evil.test" });
  ok(r6.status === 403 && (await counts()).g === c1.g, `A5 a cross-site write: 403, nothing written (${r6.status})`);
  const r7 = await fetchAt(mf, "/api/admin/grants", { method: "POST", headers: { "content-type": "text/plain", origin: SITE, cookie: admin }, body: JSON.stringify(g()) });
  ok(r7.status === 415, `A6 not JSON: 415 (${r7.status})`);
  const r8 = await post(mf, "/api/admin/grants", admin, JSON.stringify({ ...g(), note: "x".repeat(4100) }));
  ok(r8.status === 413 && (await counts()).g === c1.g, `A7 a body over 4096 bytes: 413 (${r8.status})`);
  for (const method of ["PUT", "DELETE", "PATCH"]) ok((await fetchAt(mf, "/api/admin/grants", { method, headers: { origin: SITE, cookie: admin } })).status === 405, `A8 ${method}: 405`);
  ok((await get(mf, `/api/admin/grants?account=${USER}`, user)).status === 403, "A9 a list for a non-admin: 403");
  ok((await get(mf, "/api/admin/grants?account=nope", admin)).status === 400, "A9 a list for a malformed account id: 400");
}

// ---- C: making grants; their retries; the holder's state; the fields' bounds
{
  const id = reqId();
  const g = { request_id: id, account_id: OTHER, storage_bytes: 5 * GiB, private_links: true, valid_until: until(60), note: "pilot course" };
  const r1 = await post(mf, "/api/admin/grants", admin, g);
  const b1 = await body(r1);
  ok(r1.status === 201 && /^[a-z2-7]{26}$/.test(b1?.grant?.id ?? "") && b1.grant.storage_bytes === 5 * GiB && b1.grant.private_links === 1 && b1.grant.created_by === ADMIN && b1.grant.source === "admin" && b1.grant.source_ref === id, "C1 a grant made, as asked, by this admin", b1);
  ok(!("request_hash" in (b1?.grant ?? {})), "C1 the answer carries no request hash");
  const audit = await db.prepare("SELECT actor, action FROM grant_audit WHERE grant_id = ?1").bind(b1.grant.id).all();
  ok(audit.results.length === 1 && audit.results[0].actor === ADMIN && audit.results[0].action === "create", "C1 its audit row", audit.results);
  const c0 = await counts();
  // (a second later, with valid_from still absent: an absent valid_from defaults to now, which a retry mustn't change)
  await new Promise((r) => setTimeout(r, 1100));
  const r2 = await post(mf, "/api/admin/grants", admin, g);
  const b2 = await body(r2);
  ok(r2.status === 200 && b2?.retried === true && b2.grant.id === b1.grant.id && (await counts()).g === c0.g, "C2 the same request again, a second later: the same grant, none made", b2);
  const r3 = await post(mf, "/api/admin/grants", admin, { ...g, storage_bytes: 6 * GiB });
  ok(r3.status === 409 && (await counts()).g === c0.g, `C2 the same request_id with another body: 409, none made (${r3.status})`);
  const r3b = await post(mf, "/api/admin/grants", await sessionFor(mf, db, ADMIN2, 1000), g);
  ok(r3b.status === 200 && (await body(r3b))?.grant?.id === b1.grant.id, "C2 the same request from another admin: still the one grant");
  for (const [who, why] of [[GONE, "being deleted"], [OFF, "disabled"], ["ffffffff-ffff-4fff-8fff-ffffffffffff", "unknown"]]) {
    const r = await post(mf, "/api/admin/grants", admin, { request_id: reqId(), account_id: who, storage_bytes: GiB, valid_until: until(10) });
    ok(r.status === 404 && (await counts()).g === c0.g && (await counts()).a === c0.a, `C3 an account ${why}: 404, nothing written (${r.status})`);
  }
  const bad = [
    [{ storage_bytes: 1099511627777 }, "storage over 1 TiB"],
    [{ storage_bytes: 1.5 }, "fractional storage"],
    [{ storage_bytes: -1 }, "negative storage"],
    [{ storage_bytes: null, valid_until: until(10) }, "a grant that gives nothing"],
    [{ valid_until: nowS() + 2 * 365 * 86400 + 60 }, "a window over 2 years"],
    [{ valid_until: nowS() - 1 }, "a window already over"],
    [{ valid_from: nowS() + 100, valid_until: nowS() + 50 }, "valid_until before valid_from"],
    [{ remote: false }, "remote: false"],
    [{ gpu: "yes" }, "gpu: a string"],
    [{ seats: 0 }, "0 seats"],
    [{ seats: 1001 }, "1001 seats"],
    [{ note: 7 }, "a note that isn't text"],
    [{ tier: "pro" }, "an unknown field"],
    [{ request_id: "short" }, "a request_id under 8 characters"],
    [{ account_id: "x" }, "a malformed account id"],
  ];
  for (const [o, what] of bad) {
    const r = await post(mf, "/api/admin/grants", admin, { request_id: reqId(), account_id: USER, storage_bytes: GiB, valid_until: until(10), ...o });
    ok(r.status === 400, `C4 ${what}: 400 (${r.status})`);
  }
  ok((await counts()).g === c0.g, "C4 none of them wrote anything");
  const two = await post(mf, "/api/admin/grants", admin, { request_id: reqId(), account_id: USER, storage_bytes: GiB, valid_until: nowS() + 2 * 365 * 86400 - 5 });
  ok(two.status === 201, `C4 control: a window just under 2 years is made (${two.status})`);
}

// ---- L: the holder's limits come from its active grants
{
  const H = "12121212-1212-4212-8212-121212121212";
  const s = await sessionFor(mf, db, H, 1000);
  const admin3 = await sessionFor(mf, db, ADMIN3, 1000);
  const l0 = await limitsOf(s);
  ok(l0?.tier === "free" && l0.storage_bytes === FREE && l0.private_links === false, "L1 no grant: the free plan", l0);
  const mk = async (o) => body(await post(mf, "/api/admin/grants", admin3, { request_id: reqId(), account_id: H, valid_until: until(30), ...o }));
  const a = await mk({ storage_bytes: 10 * GiB });
  const b = await mk({ storage_bytes: 20 * GiB });
  const l1 = await limitsOf(s);
  ok(l1?.tier === "grant" && l1.storage_bytes === 20 * GiB && l1.private_links === false, "L2 grants of 10 and 20 GiB: 20 GiB, the largest, never 30", l1);
  await mk({ private_links: true });
  ok((await limitsOf(s))?.private_links === true && (await limitsOf(s)).storage_bytes === 20 * GiB, "L2 a grant of private links only adds them");
  await mk({ storage_bytes: 1024 });
  ok((await limitsOf(s))?.storage_bytes === 20 * GiB, "L2 a grant below the free plan lowers nothing");
  const rv = await post(mf, `/api/admin/grants/${b.grant.id}/revoke`, admin3, { reason: "ended early" });
  const rb = await body(rv);
  ok(rv.status === 200 && rb.grant.revoked_by === ADMIN3 && rb.grant.revoke_reason === "ended early", "L3 a revocation", rb);
  ok((await limitsOf(s))?.storage_bytes === 10 * GiB, "L3 it counts on the very next request: 10 GiB");
  const again = await body(await post(mf, `/api/admin/grants/${b.grant.id}/revoke`, admin3, { reason: "again" }));
  const aud = (await db.prepare("SELECT COUNT(*) n FROM grant_audit WHERE grant_id = ?1 AND action = 'revoke'").bind(b.grant.id).first()).n;
  ok(again.grant.revoked_at === rb.grant.revoked_at && again.grant.revoke_reason === "ended early" && aud === 1, "L3 revoking again: the first revocation stands, one audit row", { again: again.grant, aud });
  ok((await post(mf, `/api/admin/grants/${"a".repeat(26)}/revoke`, admin3, { reason: "x" })).status === 404, "L3 revoking a grant that doesn't exist: 404");
  ok((await post(mf, "/api/admin/grants/%E0%A4%A/revoke", admin3, { reason: "x" })).status === 404, "L3 a malformed escape in the grant id: 404, never 500");
  ok((await post(mf, `/api/admin/grants/${a.grant.id}/revoke`, admin3, { reason: "" })).status === 400, "L3 a revocation without a reason: 400");
  // (the window: valid_from inclusive, valid_until exclusive, on the server's clock)
  await db.prepare("UPDATE grants SET valid_from = ?2 WHERE id = ?1").bind(a.grant.id, nowS() + 60).run();
  ok((await limitsOf(s))?.storage_bytes === FREE || (await limitsOf(s))?.storage_bytes === 1024 * 0 + FREE, "L4 a grant that starts in a minute doesn't count yet");
  await db.prepare("UPDATE grants SET valid_from = ?2, valid_until = ?3 WHERE id = ?1").bind(a.grant.id, nowS() - 60, nowS()).run();
  ok((await limitsOf(s))?.storage_bytes === FREE, "L4 a grant whose valid_until is now no longer counts");
  await db.prepare("UPDATE grants SET valid_until = ?2 WHERE id = ?1").bind(a.grant.id, nowS() + 60).run();
  ok((await limitsOf(s))?.storage_bytes === 10 * GiB, "L4 control: inside its window it counts");
  // (another account's grants never count)
  ok((await limitsOf(await sessionFor(mf, db, "34343434-3434-4434-8434-343434343434", 1000)))?.storage_bytes === FREE, "L5 another account: the free plan");
}

// ---- R: the admin's rate, 30 writes a minute
{
  const s = await sessionFor(mf, db, ADMIN2, 1000);
  let last;
  for (let i = 0; i < 31; i++) last = await post(mf, "/api/admin/grants", s, { request_id: reqId(), account_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", storage_bytes: GiB, valid_until: until(1) });
  const lb = await body(last);
  ok(last.status === 429 && lb?.retry_after_s === 60, `R1 the 31st write in a minute: 429 (${last.status})`);
  const admin4 = await sessionFor(mf, db, ADMIN4, 1000);
  ok((await post(mf, "/api/admin/grants", admin4, { request_id: reqId(), account_id: USER, storage_bytes: GiB, valid_until: until(1) })).status === 201, "R1 another admin is unaffected");
}

// ---- E: a failed read is 503; entitlements fail closed
{
  const m4 = worker(base);
  const d4 = await m4.getD1Database("SHARE_DB");
  await migrate(d4, ["0019_grants.sql"]);
  const s = await sessionFor(m4, d4, USER, 1000);
  const r = await get(m4, "/api/share/me", s);
  ok(r.status === 503, `E1 grants that can't be read: 503, never the free plan taken as the truth (${r.status})`);
  await m4.dispose();
  const broken = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("down"); } }) }) };
  const e = await G.entitlements(broken, USER, nowS());
  ok(e.remote === false && e.gpu === false, "E2 entitlements whose read fails: no remote, no GPU");
  const none = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };
  ok((await G.entitlements(none, USER, nowS())).gpu === false, "E2 entitlements with no answer: no GPU");
  await post(mf, "/api/admin/grants", await sessionFor(mf, db, ADMIN4, 1000), { request_id: reqId(), account_id: OTHER, remote: true, gpu: true, valid_until: until(5) });
  const live = await G.entitlements(db, OTHER, nowS());
  ok(live.remote === true && live.gpu === true, "E2 control: an active grant gives them", live);
}

// ---- M: the migration's bounds, on the table itself
{
  const ins = (o) => db.prepare("INSERT INTO grants (id, account_id, storage_bytes, private_links, remote, gpu, seats, valid_from, valid_until, source, source_ref, created_at, created_by, revoked_at, revoked_by) VALUES (?1, 'x', ?2, ?3, NULL, NULL, NULL, ?4, ?5, ?6, ?7, 1, 'a', ?8, ?9)")
    .bind(o.id ?? "m".repeat(26).replace(/m$/, String.fromCharCode(97 + (rq++ % 26))), o.s === undefined ? 1 : o.s, o.p ?? null, o.f ?? 0, o.u ?? 100, o.src ?? "admin", o.ref ?? `ref${rq}`, o.ra ?? null, o.rb ?? null).run().then(() => "ok", () => "refused");
  const rows = [
    [{ s: 1099511627776 }, "ok", "storage at 1 TiB"],
    [{ s: 1099511627777 }, "refused", "storage over 1 TiB"],
    [{ f: 0, u: 63072000 }, "ok", "a window of exactly 2 years"],
    [{ f: 0, u: 63072001 }, "refused", "a window over 2 years"],
    [{ f: 10, u: 10 }, "refused", "an empty window"],
    [{ s: null }, "refused", "a grant that gives nothing"],
    [{ p: 0 }, "refused", "private_links 0 (only 1 or NULL)"],
    [{ ra: 5 }, "refused", "revoked_at without revoked_by"],
    [{ src: "cocalc" }, "refused", "a source outside admin and stripe"],
    [{ id: "SHORT" }, "refused", "a malformed id"],
  ];
  for (const [o, want, what] of rows) ok((await ins(o)) === want, `M ${what}: ${want}`);
  await ins({ ref: "dup" });
  ok((await ins({ ref: "dup" })) === "refused", "M one (source, source_ref) once");
}

// ---- P: an account's purge anonymizes its grants and keeps the audit trail (d1 §4, d1r1 G2, Q3)
{
  const P = "56565656-5656-4656-8656-565656565656";
  const CANARY = "CANARY-7f3a-person-text";
  const admin5 = await sessionFor(mf, db, ADMIN5, 1000);
  const ps = await sessionFor(mf, db, P, 1000);
  const mk = async (o) => body(await post(mf, "/api/admin/grants", admin5, { request_id: reqId(), account_id: P, valid_until: until(30), ...o }));
  // (the canary also as the admin's request_id: an admin grant's source_ref is free text the admin typed)
  const live = await mk({ storage_bytes: 3 * GiB, note: `${CANARY} for ${P}`, request_id: CANARY });
  const ended = await mk({ private_links: true, note: CANARY });
  await post(mf, `/api/admin/grants/${ended.grant.id}/revoke`, admin5, { reason: `${CANARY} ${P}` });
  // (a Stripe-sourced grant, as the later webhook writes one: its source_ref is kept)
  await db.prepare("INSERT INTO grants (id, account_id, storage_bytes, valid_from, valid_until, source, source_ref, note, created_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5, 'stripe', 'sub_TEST123', ?6, ?4, 'stripe')").bind("s".repeat(25) + "a", P, GiB, nowS() - 10, until(30), CANARY).run();
  await db.prepare("INSERT INTO grant_audit (grant_id, at, actor, action, detail) VALUES (?1, ?2, 'stripe', 'create', ?3)").bind("s".repeat(25) + "a", nowS(), `${CANARY} ${P}`).run();
  // (the purge's replacement value can't be taken first: "purged:<id>" is outside the request id grammar, and a
  // grant made with "purged-<id>", the old form, doesn't block the purge)
  const squat = await post(mf, "/api/admin/grants", admin5, { request_id: `purged-${live.grant.id}`, account_id: OTHER, storage_bytes: GiB, valid_until: until(5) });
  const taken = await post(mf, "/api/admin/grants", admin5, { request_id: `purged:${live.grant.id}`, account_id: OTHER, storage_bytes: GiB, valid_until: until(5) });
  ok(squat.status === 201 && taken.status === 400, `P0 a request_id of purged:<id> is refused (${taken.status}); one of purged-<id> is an ordinary request (${squat.status})`);
  // (P is also an admin's grantee here; ADMIN5 itself is purged below, as an admin who made grants)
  const del = await post(mf, "/api/share/delete-everything", ps, { confirm: "delete" });
  ok(del.status === 200, `P1 the account deletes itself (${del.status})`);
  const h = sha(`sagebrush-account\n${P}`);
  const rows = (await db.prepare("SELECT * FROM grants WHERE account_id IN (?1, ?2)").bind(P, h).all()).results;
  const audit = (await db.prepare("SELECT a.* FROM grant_audit a WHERE a.grant_id IN (SELECT id FROM grants WHERE account_id IN (?1, ?2))").bind(P, h).all()).results;
  ok(rows.length === 3 && rows.every((r) => r.account_id === h), "P1 its three grants stay, held by the account's hash, never its id", rows.map((r) => r.account_id));
  ok(rows.every((r) => r.revoked_at !== null), "P1 every one of them is revoked");
  const liveRow = rows.find((r) => r.id === live.grant.id), endedRow = rows.find((r) => r.id === ended.grant.id), stripe = rows.find((r) => r.source === "stripe");
  ok(liveRow?.revoked_by === "purge" && endedRow?.revoked_by === ADMIN5, "P1 an active grant is revoked by the purge; one already revoked keeps its revoker", { live: liveRow?.revoked_by, ended: endedRow?.revoked_by });
  ok(rows.every((r) => (r.note === null || r.note === "removed") && r.revoke_reason === "removed"), "P2 every note and revoke reason is the fixed \"removed\"", rows.map((r) => [r.note, r.revoke_reason]));
  ok(stripe?.source_ref === "sub_TEST123", "P2 a Stripe grant's source_ref, the Stripe object id, is kept on purpose", stripe?.source_ref);
  ok(rows.filter((r) => r.source === "admin").every((r) => r.source_ref === `purged:${r.id}`), "P2 an admin grant's source_ref (the admin's request id) becomes purged:<grant id>, even with a purged-<id> request taken first", rows.map((r) => r.source_ref));
  ok(rows.every((r) => r.request_hash === null), "P2 every request hash goes");
  const text = JSON.stringify([rows, audit]);
  ok(!text.includes(P) && !text.includes(CANARY), "P2 no text field of the account's grants or audit rows holds its id or the planted canary");
  const purgeAudit = audit.filter((a) => a.actor === "purge" && a.action === "revoke");
  ok(purgeAudit.length === 2 && purgeAudit.every((a) => a.grant_id !== ended.grant.id), "P3 the purge's revocations are audited, one row per grant it revoked", purgeAudit);
  ok(audit.filter((a) => a.detail !== null).every((a) => a.detail === "removed"), "P3 audit details are \"removed\"");
  ok((await limitsOf(ps))?.storage_bytes !== 3 * GiB, "P4 the deleted account's session no longer carries the grant");
  // (an admin's own purge: its id leaves the grants and audit rows it made, which stay)
  const made = (await db.prepare("SELECT COUNT(*) n FROM grants WHERE created_by = ?1").bind(ADMIN5).first()).n;
  await post(mf, "/api/share/delete-everything", admin5, { confirm: "delete" });
  const h5 = sha(`sagebrush-account\n${ADMIN5}`);
  const after = await db.prepare("SELECT (SELECT COUNT(*) FROM grants WHERE created_by = ?1 OR revoked_by = ?1) a, (SELECT COUNT(*) FROM grant_audit WHERE actor = ?1) b, (SELECT COUNT(*) FROM grants WHERE created_by = ?2) c, (SELECT COUNT(*) FROM grant_admin_hits WHERE admin = ?1) d").bind(ADMIN5, h5).first();
  ok(made >= 2 && after.a === 0 && after.b === 0 && after.c === made && after.d === 0, "P5 an admin's purge: its id is replaced by its hash in the grants and audit rows it wrote, which all stay; its rate rows go", { made, after });
}

// ---- N: the grant routes exist only with WorkOS sign-in
{
  const legacy = worker({ SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", FILES_ORIGIN: "https://files.test", SAGEBRUSH_ADMINS: ADMIN });
  const dl = await legacy.getD1Database("SHARE_DB");
  await migrate(dl);
  const s = await sessionFor(legacy, dl, ADMIN, 1000);
  ok((await get(legacy, `/api/admin/grants?account=${USER}`, s)).status !== 200, "N without WorkOS sign-in: the grant routes don't answer");
  await legacy.dispose();
}

await mf.dispose();
console.log(`${count - failures}/${count} grants checks passed`);
process.exit(failures ? 1 : 0);
