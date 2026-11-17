// ci: web-sync.1 order=19
// A deployment whose sign-in is its own (AUTH_PROVIDER "local"), in Miniflare with a real D1: which session kinds each
// provider setting accepts (unset, "workos", "local", an unknown name), with and without DEV's gates; a 'local' session
// counted only whole; its idle end, moved only by its own requests, at most once per touch interval, never past its
// absolute end, one write when two requests race; and its limits (DEFAULT_LIMITS, an account's own row, fail closed).
// The sessions are written straight into D1 here, as the deployment's own sign-in would: none of it is in this code.
//
//   node web/cloud/share/test-local-sessions.mjs
import { createHash, randomBytes } from "node:crypto";
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

let failures = 0, count = 0;
function ok(cond, what) {
  count++;
  if (!cond) {
    failures++;
    console.log("FAIL", what);
  }
}
const nowS = () => Math.floor(Date.now() / 1000);
const sha = (s) => createHash("sha256").update(s).digest("hex");

const script = execFileSync("bun", ["build", join(here, "test-local-entry.ts"), "--format", "esm", "--target", "browser"], { encoding: "utf8" });
const DEV = { SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", SESSION_KEY: "session-key" };
const DEFAULT = JSON.stringify({ storage_bytes: 5 * 2 ** 30, max_file_bytes: 50 * 2 ** 20 });
const worker = (b) => new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "share", modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"], bindings: b, outboundService: () => new Response("no", { status: 404 }) }] }));
async function migrate(d) {
  for (const { path: m } of migrations())
    for (const s of readFileSync(m, "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await d.prepare(s).run();
}
const site = (m, path, init = {}) => dispatch(m, SITE + path, { redirect: "manual", ...init });
const me = (m, token) => site(m, "/api/share/me", { headers: { cookie: `__Host-sb_session=${token}` } });

/** A session row as a sign-in would write it; `local` gives the idle fields. */
async function session(db, kind, opts = {}) {
  const account = opts.account ?? crypto.randomUUID();
  const token = randomBytes(32).toString("base64url");
  const t = nowS();
  await db.prepare("INSERT OR IGNORE INTO accounts (account_id, email, name, created, last_login) VALUES (?1, ?2, 'X', ?3, ?3)").bind(account, `${account}@example.com`, t).run();
  const idle_s = "idle_s" in opts ? opts.idle_s : kind === "local" ? 3600 * 24 : null;
  const last_used = "last_used" in opts ? opts.last_used : kind === "local" ? t : null;
  const abs = "abs" in opts ? opts.abs : t + 30 * 86400;
  const expires = "expires" in opts ? opts.expires : kind === "local" ? Math.min(abs, last_used + idle_s) : t + 30 * 86400;
  const validated = kind === "workos" ? t : null;
  await db.prepare("INSERT INTO sessions (token_hash, account_id, created, expires, kind, abs_expires, validated, idle_s, last_used) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
    .bind(sha(token), account, t, expires, kind, kind === "legacy" ? null : abs, validated, idle_s, last_used).run();
  return { token, account, hash: sha(token) };
}
const row = (db, s) => db.prepare("SELECT expires, last_used, abs_expires, idle_s FROM sessions WHERE token_hash = ?1").bind(s.hash).first();

// ---- the provider matrix: which kinds count, with and without DEV's gates
const KINDS = ["legacy", "workos", "dev", "local"];
const matrix = [
  { name: "unset", b: {}, want: ["legacy"] },
  { name: "unset + dev", b: { ...DEV }, want: ["legacy", "dev"] },
  { name: "workos", b: { AUTH_PROVIDER: "workos" }, want: ["workos"] },
  { name: "workos + dev", b: { AUTH_PROVIDER: "workos", ...DEV }, want: ["workos", "dev"] },
  { name: "local", b: { AUTH_PROVIDER: "local", DEFAULT_LIMITS: DEFAULT }, want: ["local"] },
  { name: "local + dev gates", b: { AUTH_PROVIDER: "local", DEFAULT_LIMITS: DEFAULT, ...DEV }, want: ["local"] },
  { name: "unknown", b: { AUTH_PROVIDER: "ldap" }, want: [] },
  { name: "unknown + dev", b: { AUTH_PROVIDER: "ldap", ...DEV }, want: [] },
];
for (const c of matrix) {
  const mf = worker(c.b);
  const db = await mf.getD1Database("SHARE_DB");
  await migrate(db);
  for (const k of KINDS) {
    const s = await session(db, k);
    const r = await me(mf, s.token);
    ok((r.status === 200) === c.want.includes(k), `${c.name}: a '${k}' session ${c.want.includes(k) ? "counts" : "doesn't count"} (got ${r.status})`);
  }
  // (no CoCalc sign-in, callback or admin call, and no /auth/dev, under local or an unknown provider)
  if (c.name.startsWith("local") || c.name.startsWith("unknown")) {
    for (const [p, m] of [["/auth/login", "GET"], ["/auth/callback", "GET"], ["/api/admin/purge", "POST"]]) ok((await site(mf, p, { method: m })).status === 404, `${c.name}: ${m} ${p} is 404`);
    const d = await site(mf, "/auth/dev", { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify({ token: "dev-token", account_id: crypto.randomUUID() }) });
    ok(d.status === 404, `${c.name}: /auth/dev is 404 (got ${d.status})`);
    ok(!(d.headers.getSetCookie?.() ?? []).some((x) => x.startsWith("__Host-sb_session=")), `${c.name}: /auth/dev sets no cookie`);
  }
  await mf.dispose();
}

// ---- 'local' sessions, counted only whole
{
  const mf = worker({ AUTH_PROVIDER: "local", DEFAULT_LIMITS: DEFAULT });
  const db = await mf.getD1Database("SHARE_DB");
  await migrate(db);
  const t = nowS();
  const bad = {
    "no idle_s": { idle_s: null },
    "an idle_s below the floor": { idle_s: 599 },
    "an idle_s above the ceiling": { idle_s: 90 * 86400 + 1 },
    "a negative idle_s": { idle_s: -5, expires: t + 100 },
    "no last_used": { last_used: null, expires: t + 3600 },
    "no abs_expires": { abs: null, expires: t + 3600 },
    "expires past abs_expires": { abs: t + 100, expires: t + 200 },
    "expires past last_used + idle_s": { last_used: t - 3600, idle_s: 3600 * 2, expires: t + 7200 },
    "last_used in the future": { idle_s: 600, last_used: t + 86400, abs: t + 87000, expires: t + 87000 },
  };
  for (const [what, o] of Object.entries(bad)) {
    const s = await session(db, "local", o);
    ok((await me(mf, s.token)).status === 401, `a 'local' row with ${what} counts as no session`);
  }

  // ---- the idle end
  const atEnd = await session(db, "local", { idle_s: 3600, last_used: t - 3600 });
  ok((await me(mf, atEnd.token)).status === 401, "a session at its idle end exactly (expires = now) is refused");
  const nearEnd = await session(db, "local", { idle_s: 3600, last_used: t - 3590 });
  const before = await row(db, nearEnd);
  ok((await me(mf, nearEnd.token)).status === 200, "a session 10 s before its idle end is accepted");
  const after = await row(db, nearEnd);
  ok(after.last_used >= t && after.expires >= t + 3600 - 1 && after.expires <= after.abs_expires, `its request moved its end (${before.expires} -> ${after.expires})`);

  // (another session's activity doesn't move it)
  const acct = crypto.randomUUID();
  const a = await session(db, "local", { account: acct, idle_s: 3600, last_used: t - 3000 });
  const b = await session(db, "local", { account: acct, idle_s: 3600, last_used: t - 3000 });
  const aBefore = await row(db, a);
  ok((await me(mf, b.token)).status === 200, "the account's other session is used");
  ok((await row(db, a)).expires === aBefore.expires, "another session's activity doesn't move this one's end");

  // (coalesced: a recent touch isn't repeated; the interval is half the limit when that's shorter than an hour)
  const recent = await session(db, "local", { idle_s: 86400, last_used: t - 1800 });
  const r0 = await row(db, recent);
  await me(mf, recent.token);
  ok((await row(db, recent)).last_used === r0.last_used, "a session touched 30 minutes ago isn't touched again (interval 1 h)");
  const short = await session(db, "local", { idle_s: 1200, last_used: t - 700 });
  await me(mf, short.token);
  ok((await row(db, short)).last_used >= t, "a 20-minute limit is touched after 10 minutes (half the limit), so an active holder never lapses");

  // (never past the absolute end)
  const capped = await session(db, "local", { idle_s: 86400, last_used: t - 7200, abs: t + 600 });
  await me(mf, capped.token);
  const cr = await row(db, capped);
  ok(cr.expires === cr.abs_expires && cr.last_used >= t, "a touch near the absolute end stops at it");

  // (two requests at once: one write, and both answer with the stored end)
  const race = await session(db, "local", { idle_s: 86400, last_used: t - 7200 });
  const [x, y] = await Promise.all([me(mf, race.token), me(mf, race.token)]);
  ok(x.status === 200 && y.status === 200, "two concurrent requests are both accepted");
  const rr = await row(db, race);
  ok(rr.last_used >= t && rr.expires === Math.min(rr.abs_expires, rr.last_used + rr.idle_s), "after the race the row is one touch's, consistent");

  // ---- limits: the default, an account's own row, fail closed
  const lim = async (m, s) => (await (await me(m, s.token)).json()).limits;
  const d1 = await session(db, "local");
  const l1 = await lim(mf, d1);
  ok(l1 && l1.storage_bytes === 5 * 2 ** 30 && l1.max_file_bytes === 50 * 2 ** 20 && l1.private_links === false, `DEFAULT_LIMITS applies (${JSON.stringify(l1)})`);
  await db.prepare("INSERT INTO account_limits (account_id, storage_bytes, max_file_bytes) VALUES (?1, ?2, ?3)").bind(d1.account, 10 * 2 ** 30, 2 ** 20).run();
  const l2 = await lim(mf, d1);
  ok(l2 && l2.storage_bytes === 10 * 2 ** 30 && l2.max_file_bytes === 2 ** 20, "an account's own row applies instead");
  let refused = false;
  try {
    await db.prepare("INSERT INTO account_limits (account_id, storage_bytes, max_file_bytes) VALUES (?1, 10, 20)").bind(crypto.randomUUID()).run();
  } catch {
    refused = true;
  }
  ok(refused, "the table refuses a file allowance above the storage allowance");
  await mf.dispose();
  for (const [what, v] of [["missing", undefined], ["not JSON", "{"], ["a negative size", JSON.stringify({ storage_bytes: -1, max_file_bytes: 1 })], ["a file above the storage", JSON.stringify({ storage_bytes: 10, max_file_bytes: 20 })], ["not an integer", JSON.stringify({ storage_bytes: 1.5, max_file_bytes: 1 })]]) {
    const m2 = worker({ AUTH_PROVIDER: "local", ...(v === undefined ? {} : { DEFAULT_LIMITS: v }) });
    const d2 = await m2.getD1Database("SHARE_DB");
    await migrate(d2);
    const s = await session(d2, "local");
    const r = await me(m2, s.token);
    ok(r.status === 200 && (await r.json()).limits === null, `DEFAULT_LIMITS ${what}: no limits, so no uploads (fail closed)`);
    await m2.dispose();
  }
}

// ---- the end decided afresh after a touch's await: a touch held across the stored end, or failing then, refuses
for (const [what, b] of [["held 2.5 s, then capped at the absolute end", { TEST_TOUCH_DELAY_MS: "2500" }], ["held 2.5 s, then failing", { TEST_TOUCH_DELAY_MS: "2500", TEST_TOUCH_FAIL: "1" }]]) {
  const m = worker({ AUTH_PROVIDER: "local", DEFAULT_LIMITS: DEFAULT, ...b });
  const d = await m.getD1Database("SHARE_DB");
  await migrate(d);
  const t = nowS();
  // (live when read: due a touch, its absolute end 2 s away, so the touch can only end at it)
  const s = await session(d, "local", { idle_s: 86400, last_used: t - 7200, abs: t + 2 });
  const r = await me(m, s.token);
  ok(r.status === 401, `a touch ${what}: the request is refused (got ${r.status})`);
  await m.dispose();
}
{
  // (and a failed touch on a session well inside its end still answers, with the end it had)
  const m = worker({ AUTH_PROVIDER: "local", DEFAULT_LIMITS: DEFAULT, TEST_TOUCH_FAIL: "1" });
  const d = await m.getD1Database("SHARE_DB");
  await migrate(d);
  const s = await session(d, "local", { idle_s: 86400, last_used: nowS() - 7200 });
  const before = await row(d, s);
  ok((await me(m, s.token)).status === 200, "a failed touch inside the session's end: the request is still answered");
  ok((await row(d, s)).expires === before.expires, "a failed touch extends nothing");
  await m.dispose();
}

console.log(`${count - failures}/${count} checks passed`);
process.exit(failures ? 1 : 0);
