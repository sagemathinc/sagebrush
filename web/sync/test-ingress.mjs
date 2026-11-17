// ci: web-sync.1 order=21 runner=bun
// The sync API's three ingress limits (design/sync-server.md §2), at the Worker, with counting fakes for the
// rate-limiting bindings, D1 and the account object, so the order of the checks and the work each request costs
// are seen exactly:
//   SYNC_INGRESS_IP       every request, first, per IP (the raw cap, and the only bound before a session read)
//   SYNC_PREAUTH          only a request refused before it is known whose it is (cross-site, no session), per IP
//   SYNC_ACCOUNT_INGRESS  every authenticated request, per account of its session, before any object
// Each refusal is 429 with retry_after 60000 and its own limit's name.
import { handleSync } from "./server.ts";
import { sessionOf, SESSION_TOKEN } from "../share/server.ts";
import { sessionOf as cloudSessionOf, SESSION_TOKEN as CLOUD_SESSION_TOKEN } from "../cloud/share/server.ts";
import { accountHash } from "../sync-protocol/protocol.ts";

let fails = 0, checks = 0;
const ok = (c, what) => { checks++; if (!c) { fails++; console.log("FAIL:", what); } };
const J = JSON.stringify;
const SITE = "https://sagebrush.test";
const hex = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const token = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/** A rate-limiting binding: `n` a key, every call counted (the binding can't be read without counting). */
function limiter(n) {
  const used = new Map(), calls = [];
  return { calls, used, limit: async ({ key }) => { calls.push(key); const u = (used.get(key) ?? 0) + 1; used.set(key, u); return { success: u <= n }; } };
}
/** A world: sessions by token, the counting fakes, and the bindings (any of the three left out by `without`). */
async function world({ raw = 1e6, pre = 60, acct = 3000, without = [] } = {}) {
  const sessions = new Map(), d1 = { prepares: 0 }, objects = { names: [], status: 0 };
  const L = { SYNC_INGRESS_IP: limiter(raw), SYNC_PREAUTH: limiter(pre), SYNC_ACCOUNT_INGRESS: limiter(acct) };
  const SHARE_DB = {
    prepare(sql) {
      d1.prepares++;
      return { bind: (...a) => ({ first: async () => { const s = sessions.get(a[0]); return s && /token_hash/.test(sql) ? { account_id: s, expires: 2e9 } : null; }, run: async () => ({}) }) };
    },
  };
  const SYNC_ACCOUNT = {
    idFromName: (n) => { objects.names.push(n); return n; },
    get: () => ({ status: async () => { objects.status++; return { available: true, state: "on", generation: 1 }; } }),
  };
  const env = { SHARE_DB, SYNC_ACCOUNT, SYNC_DOC: {}, SYNC_ACCOUNTS: "", ...L };
  for (const k of without) delete env[k];
  const signIn = async (id) => { const t = token(); sessions.set(await hex(t), id); env.SYNC_ACCOUNTS = [env.SYNC_ACCOUNTS, id].filter(Boolean).join(","); return t; };
  return { env, L, d1, objects, signIn };
}
/** GET /api/sync/v1/status from `ip`, with `tok` as the session cookie (raw: the cookie header as given). */
const status = (w, { ip = "203.0.113.1", tok = null, raw = null, origin = SITE, query = "" } = {}) => {
  const headers = { "cf-connecting-ip": ip, origin };
  if (raw !== null) headers.cookie = raw;
  else if (tok) headers.cookie = "__Host-sb_session=" + tok;
  return handleSync(new Request(SITE + "/api/sync/v1/status" + query, { headers }), w.env);
};
const body = async (r) => r.json().catch(() => null);
const A = "aaaaaaaa-0000-4000-8000-00000000000a", B = "bbbbbbbb-0000-4000-8000-00000000000b";

// ---- the session token's shape, before any hash or D1 read
{
  ok(SESSION_TOKEN.test(token()) && !SESSION_TOKEN.test(token() + "=") && !SESSION_TOKEN.test(token().slice(1)) && !SESSION_TOKEN.test("x".repeat(42) + "+"), "a session token is exactly 43 base64url characters");
  ok(CLOUD_SESSION_TOKEN.source === SESSION_TOKEN.source, "the cloud overlay's session shape is the same");
  // (both sessionOf: the core one, and the cloud overlay's, which the deployed site uses)
  for (const [which, of] of [["core", sessionOf], ["cloud", cloudSessionOf]]) {
    const w = await world();
    for (const bad of ["x", "x".repeat(42), "x".repeat(44), "x".repeat(42) + "=", "x".repeat(42) + "/", "x".repeat(42) + "."]) {
      const before = w.d1.prepares;
      const who = await of(new Request(SITE, { headers: { cookie: "__Host-sb_session=" + bad } }), w.env);
      ok(who === null && w.d1.prepares === before, `${which}: a malformed token (${bad.length} chars) is no session, with no D1 read`);
    }
    const before = w.d1.prepares;
    ok((await of(new Request(SITE, { headers: { cookie: "__Host-sb_session=" + token() } }), w.env)) === null && w.d1.prepares === before + 1, `${which}: a well-formed token that isn't a session: no session, exactly one D1 read`);
  }
}

// ---- 1. raw ingress first: valid traffic counts against it, and past it nothing else runs
{
  const w = await world({ raw: 3 });
  const t = await w.signIn(A);
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await status(w, { tok: t })).status);
  ok(codes.join() === "200,200,200,429", "the raw ingress counts every request, valid ones too: " + codes.join());
  const d1 = w.d1.prepares, acct = w.L.SYNC_ACCOUNT_INGRESS.calls.length, objs = w.objects.names.length;
  const r = await status(w, { tok: t });
  const b = await body(r);
  ok(r.status === 429 && b?.limit === "ingress_per_ip" && b.retry_after === 60_000, "past it: 429, the raw limit's name, retry_after 60000: " + J(b));
  ok(w.d1.prepares === d1 && w.L.SYNC_ACCOUNT_INGRESS.calls.length === acct && w.objects.names.length === objs && w.L.SYNC_PREAUTH.calls.length === 0, "…with no session read, no account limit, no object, and the failure limit untouched");
  ok((await status(w, { tok: t, ip: "203.0.113.2" })).status === 200, "another IP has its own raw ingress");
}

// ---- 2. many accounts behind one address, far past 60 a minute together: never refused
{
  const w = await world({ pre: 60 });
  const toks = await Promise.all(Array.from({ length: 30 }, (_, i) => w.signIn(`cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}`)));
  let n200 = 0;
  for (let round = 0; round < 10; round++) for (const t of toks) n200 += (await status(w, { tok: t, ip: "198.51.100.7" })).status === 200 ? 1 : 0;
  ok(n200 === 300, "30 accounts on one IP, 300 requests: all answered (no IP limit for authenticated requests): " + n200);
  ok(w.L.SYNC_PREAUTH.calls.length === 0, "…and none of them counted against the failure limit");
}

// ---- 3. each account its own ingress, by its session's account
{
  const w = await world({ acct: 3 });
  const ta = await w.signIn(A), tb = await w.signIn(B);
  for (let i = 0; i < 3; i++) await status(w, { tok: ta });
  const objs = w.objects.status;
  const r = await status(w, { tok: ta });
  const b = await body(r);
  ok(r.status === 429 && b?.limit === "account_ingress_per_minute" && b.retry_after === 60_000, "an account past its ingress: 429, the account limit's name, retry_after 60000: " + J(b));
  ok(w.objects.status === objs, "…before any object");
  ok((await status(w, { tok: tb })).status === 200, "another account on the same IP is answered");
  ok((await status(w, { tok: ta, ip: "203.0.113.99" })).status === 429, "and the limit is the account's, not the IP's: another IP is refused for it too");
  // (the account a limit counts is the session's, never one the request names)
  const keys = new Set(w.L.SYNC_ACCOUNT_INGRESS.calls);
  ok(keys.size === 2 && keys.has(await accountHash(A)) && keys.has(await accountHash(B)), "the account ingress is keyed by the session's account hash only");
  const before = w.L.SYNC_ACCOUNT_INGRESS.calls.length;
  await status(w, { tok: tb, query: "?account=" + A });
  await handleSync(new Request(SITE + "/api/sync/v1/status", { headers: { "cf-connecting-ip": "203.0.113.1", origin: SITE, cookie: `__Host-sb_session=${tb}; account=${A}`, "x-account": A } }), w.env);
  const hb = await accountHash(B), named = w.L.SYNC_ACCOUNT_INGRESS.calls.slice(before);
  ok(named.length === 2 && named.every((k) => k === hb), "a request that names another account (query, cookie, header) still counts against its session's account: " + J(named.map((k) => k === hb)));
}

// ---- 4. failures: counted per IP, each costing what it must and no more; past the limit, 429
{
  const w = await world({ pre: 3 });
  const ta = await w.signIn(A);
  const d0 = w.d1.prepares;
  const r1 = await status(w, {});
  ok(r1.status === 401 && w.d1.prepares === d0 && w.L.SYNC_PREAUTH.calls.length === 1, "no cookie: 401, counted once against the failure limit, no D1 read");
  const r2 = await status(w, { raw: "__Host-sb_session=" + "x".repeat(42) });
  ok(r2.status === 401 && w.d1.prepares === d0 && w.L.SYNC_PREAUTH.calls.length === 2, "a malformed session: 401, counted, no D1 read");
  const r3 = await status(w, { tok: token() });
  ok(r3.status === 401 && w.d1.prepares === d0 + 1 && w.L.SYNC_PREAUTH.calls.length === 3, "a well-formed session that isn't one: 401, counted, exactly one D1 read");
  const r4 = await status(w, { tok: token() });
  const b4 = await body(r4);
  ok(r4.status === 429 && b4?.limit === "failed_sync_per_ip" && b4.retry_after === 60_000, "past the failure limit: 429, its name, retry_after 60000: " + J(b4));
  ok(w.objects.names.length === 0 && w.L.SYNC_ACCOUNT_INGRESS.calls.length === 0, "no failure reached the account limit or an object");
  // (the people signed in behind that address are not held up by its failures)
  ok((await status(w, { tok: ta })).status === 200 && w.L.SYNC_PREAUTH.calls.length === 4, "a valid session from the same IP is still answered, without counting against the failure limit");
  ok((await status(w, { ip: "203.0.113.50" })).status === 401, "another IP has its own failure limit");
}

// ---- 5. cross-site: counted as a failure, and no session or account work at all
{
  const w = await world({ pre: 2 });
  const ta = await w.signIn(A);
  const r = await status(w, { tok: ta, origin: "https://evil.test" });
  ok(r.status === 403 && w.d1.prepares === 0 && w.objects.names.length === 0 && w.L.SYNC_ACCOUNT_INGRESS.calls.length === 0, "a cross-site request with a valid cookie: 403, no D1 read, no account limit, no object");
  ok(w.L.SYNC_INGRESS_IP.calls.length === 1 && w.L.SYNC_PREAUTH.calls.length === 1, "…counted against the raw ingress and the failure limit");
  await status(w, { tok: ta, origin: "https://evil.test" });
  const r3 = await status(w, { tok: ta, origin: "https://evil.test" });
  ok(r3.status === 429 && (await body(r3))?.limit === "failed_sync_per_ip", "past the failure limit, cross-site gets 429");
  ok((await status(w, { tok: ta })).status === 200, "and the same account's own pages, same IP, are answered");
}

// ---- 6. each binding is part of the flag: without any one of them, sync is off, and nothing is read
for (const missing of ["SYNC_INGRESS_IP", "SYNC_PREAUTH", "SYNC_ACCOUNT_INGRESS"]) {
  const w = await world({ without: [missing] });
  const t = await w.signIn(A);
  const r = await status(w, { tok: t }).catch((e) => ({ status: "threw: " + e.message, json: async () => null }));
  const calls = Object.values(w.L).reduce((n, l) => n + l.calls.length, 0);
  ok(r.status === 404 && (await body(r))?.error === "sync is not enabled here" && w.d1.prepares === 0 && calls === 0, `without ${missing}: 404, sync off, nothing read or counted: ` + r.status);
}

// ---- 7. the confirmed case: one device sending about 80 requests at once is never refused
{
  const w = await world({ pre: 60 });
  const t = await w.signIn(A);
  const codes = await Promise.all(Array.from({ length: 80 }, () => status(w, { tok: t }).then((r) => r.status)));
  ok(codes.every((c) => c === 200), "80 requests at once from one device (40 files): all answered: " + J([...new Set(codes)]));
}

console.log(fails ? `FAIL: ${fails} of ${checks} checks` : `ok: sync's ingress limits, ${checks} checks`);
process.exit(fails ? 1 : 0);
