// Remotes, step (b1): enrollment (core design remote-v1 r1.8 §3 and §13.2, SEC DESIGN CLEAR).  A box's `sagebrush
// remote` (kind "runner") or an agent's `sagebrush-mcp --remote` (kind "agent") enrolls its own P-256 key by the device
// flow (RFC 8628 shape); a signed-in person approves it here; the relay (b2) then admits its connections by a challenge
// this Worker issues and the enrolled key signs.  No relay yet: b1 is the table, the flow, the challenge, revoke and
// the account's peer list.
//
//   POST /api/remote/v1/device       {pub: JWK, kind, name}  -> {device_code, user_code, verification_uri, interval, expires_in}
//   POST /api/remote/v1/device/poll  {device_code}           -> {error: "authorization_pending" | "slow_down" | "access_denied" | "expired_token"}
//                                                                or, once, {remote_id, kind, name}
//   GET  /remote/activate[?code=]    the approval page (signed in)
//   POST /remote/activate            code [, decision=approve|deny] (a form, same site, signed in)
//   POST /api/remote/v1/challenge    {remote_id}             -> {challenge, expires_in}
//   GET  /api/remote/v1/peers                                -> {peers: [{remote_id, kind, name, jwk, jkt, created, agents,
//                                                                agents_at}]}
//   POST /api/remote/v1/revoke       {remote_id}             -> {ok}
//   GET  /api/remote/v1/runner       (WebSocket) a runner's leg: x-sb-remote-challenge, x-sb-remote-signature (b2a),
//                                    and x-sb-remote-agents, its agent kinds (agentKinds())
//   GET  /api/remote/v1/page?remote=&chan=   (WebSocket) a page's leg, signed in, same site (b2a)
//
// The relay's routes (b2a, relay.ts) are inert also until REMOTE_RELAY (the RemoteRelay Durable Object binding) is
// bound, at b4.
//
// Inert until bound: every route answers 404 unless REMOTE_CHAL_KEY (the challenge key, a secret) and REMOTE_ACCOUNTS
// (who may enroll: comma-separated account ids, a secret; empty, nobody; REMOTE_TIERS adds CoCalc tiers) are set, so
// merging this changes no deployment until the bindings are added (step b4, by @sagebrush).  Unauthenticated routes
// are rate-limited per IP (REMOTE_PREAUTH) before any D1 work, when that binding is present.
import { sessionOf, authTier, sha256Hex, hmac, same, accountHash, type ShareEnv, type Ctx, type D1Stmt } from "../share/server.ts";
import { capsFor } from "./relay-caps.ts";

export interface RemoteEnv extends ShareEnv {
  /** the challenge key (HMAC-SHA-256): a secret */
  REMOTE_CHAL_KEY?: string;
  /** (b4b, DEV) instead of a secret of its own: the challenge key derived from SESSION_KEY (chalKey()), when this is
   * exactly CHAL_DERIVE; any other value, or none, derives nothing */
  REMOTE_CHAL_DERIVE?: string;
  /** who may enroll a remote: comma-separated CoCalc account ids (a secret; unset or empty: nobody) */
  REMOTE_ACCOUNTS?: string;
  /** who else may: comma-separated CoCalc membership tiers, matched exactly against the account's tier as authTier()
   * reads it (fresh from CoCalc, or cached within LIMITS_TTL, 600 s); unset or empty: none.  So who has such a tier is
   * decided in CoCalc, without a deploy, and a tier taken away there stops counting here within 600 s */
  REMOTE_TIERS?: string;
  /** per IP, before authentication */
  REMOTE_PREAUTH?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  /** the relay: a RemoteRelay Durable Object per remote (relay.ts), bound at b4 */
  REMOTE_RELAY?: DurableObjectNamespace;
  REMOTE_ACCOUNT?: DurableObjectNamespace;
}

export const REMOTE_LIMITS = Object.freeze({
  deviceSeconds: 86400, // a device flow's life: a day, so a person can approve when they next look (Nov 12)
  interval: 5, // seconds between polls (closer: slow_down)
  registered: 4, // per account and kind, not revoked
  wrongCodes: 5, // wrong user codes per account per window
  wrongWindow: 600,
  challengeSeconds: 30,
  nameChars: 64,
  bodyBytes: 2048, // a request body here
});
const KINDS = ["runner", "agent"] as const;
type Kind = (typeof KINDS)[number];
// (user codes: 8 consonants, RFC 8628 §6.1's suggestion: no vowels, so no words, and no 0/O or 1/I)
const USER_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const B64URL43 = /^[A-Za-z0-9_-]{43}$/;

const now = () => Math.floor(Date.now() / 1000);
const enc = new TextEncoder();
const NOSNIFF = { "x-content-type-options": "nosniff" } as const;
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...NOSNIFF } });
const err = (status: number, error: string) => json({ error }, status);
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** All three bindings, or inert (astra's B106-PREAUTH-3: the per-IP limit is mandatory, never skipped). */
function enabled(env: RemoteEnv): boolean {
  return !!(env.SHARE_DB && hasChalKey(env) && env.REMOTE_ACCOUNTS !== undefined && env.REMOTE_PREAUTH);
}

// ---- the challenge key (b4b): REMOTE_CHAL_KEY, a secret of its own (production's, when enabled there); or, on DEV,
// derived from SESSION_KEY (no new secret, so no deploy workflow change): HKDF-SHA-256, its own label, 32 bytes.  The
// derived key is the challenge HMAC's only (CHAL_TAG-prefixed messages): never stored, logged or returned, and
// SESSION_KEY's own uses (sign-in's "oauth\n" HMAC, sessions) are unchanged.  Which key is configuration only (the
// bindings), never the request's: a configured REMOTE_CHAL_KEY is the key, always, and one configured but empty or not
// a string is inert (404), never a fall back to the derived key; nothing ever retries with another key (astra's b4b
// design conditions).  Deriving a key authorizes no account: allowed() (REMOTE_ACCOUNTS, REMOTE_TIERS) still gates
// approval and admission.
// Assumed: SESSION_KEY stays a high-entropy secret; rotating it changes the derived key, so outstanding challenges
// (30 s) fail.
export const CHAL_DERIVE = "session-hkdf-v1";
export const CHAL_INFO = "sagebrush/remote/challenge-key/v1";
function derives(env: RemoteEnv): boolean {
  return env.REMOTE_CHAL_KEY === undefined && env.REMOTE_CHAL_DERIVE === CHAL_DERIVE && typeof env.SESSION_KEY === "string" && env.SESSION_KEY.length > 0;
}
function hasChalKey(env: RemoteEnv): boolean {
  return env.REMOTE_CHAL_KEY !== undefined ? typeof env.REMOTE_CHAL_KEY === "string" && env.REMOTE_CHAL_KEY.length > 0 : derives(env);
}
async function chalKey(env: RemoteEnv): Promise<string> {
  if (!hasChalKey(env)) throw new Error("no challenge key"); // (never: every route, and verifyChallenge, check enabled() first)
  if (env.REMOTE_CHAL_KEY !== undefined) return env.REMOTE_CHAL_KEY;
  const ikm = await crypto.subtle.importKey("raw", enc.encode(env.SESSION_KEY!), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode(CHAL_INFO) }, ikm, 256);
  return b64url(new Uint8Array(bits));
}
const listOf = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
/** Whether this signed-in account may enroll and use remotes: listed in REMOTE_ACCOUNTS, or holding a tier listed in
 * REMOTE_TIERS (authTier(): never a stale or client-given tier; no tier, or CoCalc not answering, is no) */
async function allowed(env: RemoteEnv, s: { id: string; session: string }): Promise<boolean> {
  if (listOf(env.REMOTE_ACCOUNTS).includes(s.id)) return true;
  const tiers = listOf(env.REMOTE_TIERS);
  if (!tiers.length) return false;
  const tier = await authTier(env, s);
  return tier !== null && tiers.includes(tier);
}
async function preauth(req: Request, env: RemoteEnv): Promise<boolean> {
  if (!env.REMOTE_PREAUTH) return false;
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  return (await env.REMOTE_PREAUTH.limit({ key: ip })).success;
}
/**
 * A request body's text, at most bodyBytes, or null (astra's B106-BODY-2): a Content-Length over the cap is refused
 * before any of it is read; without one (or with a false one), the stream is read a chunk at a time, counted, and
 * cancelled as soon as it passes the cap, never read to its end.
 */
export async function boundedText(req: Request): Promise<string | null> {
  const cl = req.headers.get("content-length");
  if (cl !== null && !(/^[0-9]{1,15}$/.test(cl) && Number(cl) <= REMOTE_LIMITS.bodyBytes)) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > REMOTE_LIMITS.bodyBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) all.set(p, (at += p.byteLength) - p.byteLength);
  return new TextDecoder().decode(all);
}
/** A JSON object body, at most bodyBytes, or null. */
export async function body(req: Request): Promise<Record<string, unknown> | null> {
  const t = await boundedText(req);
  if (t === null) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
/** A state-changing request from this site's own pages. */
const sameSite = (req: Request) => req.headers.get("origin") === new URL(req.url).origin;

// ---- keys

/** The RFC 7638 thumbprint of an EC P-256 public JWK. */
export async function thumbprint(jwk: { kty: string; crv: string; x: string; y: string }): Promise<string> {
  const canon = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(canon))));
}
/** Exactly {kty: "EC", crv: "P-256", x, y}, canonical base64url, a point on the curve (WebCrypto's import checks it). */
async function publicKey(v: unknown): Promise<{ jwk: { kty: "EC"; crv: "P-256"; x: string; y: string } } | null> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const j = v as Record<string, unknown>;
  if (Object.keys(j).sort().join() !== "crv,kty,x,y" || j.kty !== "EC" || j.crv !== "P-256") return null;
  for (const c of [j.x, j.y]) {
    if (typeof c !== "string" || !B64URL43.test(c)) return null;
    const raw = unb64url(c);
    if (raw.length !== 32 || b64url(raw) !== c) return null;
  }
  const jwk = { kty: "EC" as const, crv: "P-256" as const, x: j.x as string, y: j.y as string };
  try {
    await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return { jwk };
  } catch {
    return null;
  }
}
/** A peer's claimed name: 1 to nameChars characters, no control characters. */
function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || [...s].length > REMOTE_LIMITS.nameChars || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s)) return null;
  return s;
}

// ---- the device flow

async function startDevice(req: Request, env: RemoteEnv): Promise<Response> {
  const b = await body(req);
  if (!b) return err(400, "invalid_request");
  const kind = b.kind;
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) return err(400, "invalid_kind");
  const name = cleanName(b.name);
  if (!name) return err(400, "invalid_name");
  const pk = await publicKey(b.pub);
  if (!pk) return err(400, "invalid_key");
  const db = env.SHARE_DB!;
  const t = now();
  const device = b64url(random(32)); // (256 bits)
  // (rejection sampling: 240 = 12 * 20, so each consonant is equally likely; 8 of 20: ~34.6 bits)
  const letters: string[] = [];
  while (letters.length < 8) for (const x of random(16)) if (x < 240 && letters.length < 8) letters.push(USER_ALPHABET[x % 20]);
  const code = letters.join("");
  await db.batch([
    db.prepare("DELETE FROM remote_devices WHERE expires < ?1").bind(t - 3600),
    db.prepare("INSERT INTO remote_devices (device_hash, user_code, kind, jwk, jkt, name, created, expires) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
      .bind(await sha256Hex(device), code, kind, JSON.stringify(pk.jwk), await thumbprint(pk.jwk), name, t, t + REMOTE_LIMITS.deviceSeconds),
  ]);
  const origin = new URL(req.url).origin;
  return json({
    device_code: device,
    user_code: code.slice(0, 4) + "-" + code.slice(4),
    verification_uri: `${origin}/remote/activate`,
    verification_uri_complete: `${origin}/remote/activate?code=${code}`,
    interval: REMOTE_LIMITS.interval,
    expires_in: REMOTE_LIMITS.deviceSeconds,
  });
}

async function poll(req: Request, env: RemoteEnv): Promise<Response> {
  const b = await body(req);
  if (!b || typeof b.device_code !== "string" || !B64URL43.test(b.device_code)) return err(400, "invalid_request");
  const db = env.SHARE_DB!;
  const t = now();
  const h = await sha256Hex(b.device_code);
  const d = await db.prepare("SELECT state, expires, last_poll, remote_id, kind, name FROM remote_devices WHERE device_hash = ?1").bind(h)
    .first<{ state: string; expires: number; last_poll: number | null; remote_id: string | null; kind: string; name: string }>();
  if (!d || d.expires < t) return err(400, "expired_token");
  if (d.last_poll !== null && t - d.last_poll < REMOTE_LIMITS.interval) {
    await db.prepare("UPDATE remote_devices SET last_poll = ?2 WHERE device_hash = ?1").bind(h, t).run();
    return err(400, "slow_down");
  }
  if (d.state === "approved") {
    // (delivered once: the update is the claim, so two polls can't both get it)
    const r = await db.prepare("UPDATE remote_devices SET state = 'delivered', last_poll = ?2 WHERE device_hash = ?1 AND state = 'approved'").bind(h, t).run();
    if (r.meta?.changes !== 1) return err(400, "expired_token");
    return json({ remote_id: d.remote_id, kind: d.kind, name: d.name });
  }
  await db.prepare("UPDATE remote_devices SET last_poll = ?2 WHERE device_hash = ?1").bind(h, t).run();
  if (d.state === "denied") return err(400, "access_denied");
  if (d.state === "delivered") return err(400, "expired_token");
  return err(400, "authorization_pending");
}

// ---- the approval page

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
function page(title: string, inner: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} - Sagebrush</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}input{font:inherit;padding:.3rem;letter-spacing:.1em;text-transform:uppercase}button{font:inherit;padding:.4rem 1rem;margin-right:.5rem}.k{color:#555}</style></head><body><h1>${esc(title)}</h1>${inner}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "x-frame-options": "DENY",
      // (same-origin, not no-referrer: under no-referrer a browser's form POST carries `Origin: null`, which sameSite()
      // refuses, so no approval could ever be made; same-origin still sends nothing, the code in the URL included, to
      // any other origin)
      "referrer-policy": "same-origin",
      ...NOSNIFF,
    },
  });
}
const codeForm = (msg = "", value = "") =>
  `${msg ? `<p>${esc(msg)}</p>` : ""}<form method="post" action="/remote/activate"><p><label>Code shown by the command: <input name="code" autocomplete="off" maxlength="9" value="${esc(value)}" required></label></p><p><button>Continue</button></p></form>`;
const KIND_WORDS: Record<Kind, string> = {
  // (terminal addendum T1.4 T6: terminals are on by default for a runner, so the approval says so)
  runner: "a <b>runner</b>: code you run there, and terminals you open there, run as its user, with its files and its permissions",
  agent: "an <b>agent</b>: it will ask to read and change your workspace, through what you grant it",
};
function normCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.toUpperCase().replace(/[\s-]/g, "");
  return s.length === 8 && [...s].every((c) => USER_ALPHABET.includes(c)) ? s : null;
}

async function activatePage(req: Request, env: RemoteEnv, ctx: Ctx): Promise<Response> {
  const s = await sessionOf(req, env, ctx);
  const url = new URL(req.url);
  const code = (url.searchParams.get("code") ?? "").slice(0, 16);
  if (!s) {
    const back = "/remote/activate" + (code ? "?code=" + encodeURIComponent(code) : "");
    return page("Connect a remote", `<p>Sign in to approve a remote for your account.</p><p><a href="/auth/login?return=${encodeURIComponent(back)}">Sign in with CoCalc</a></p>`);
  }
  if (!(await allowed(env, s))) return page("Connect a remote", "<p>Remotes aren't available for this account yet.</p>", 403);
  return page("Connect a remote", codeForm("", code));
}

async function tooManyWrong(env: RemoteEnv, account: string, t: number): Promise<boolean> {
  const w = await env.SHARE_DB!.prepare("SELECT n, since FROM remote_wrong WHERE account = ?1").bind(account).first<{ n: number; since: number }>();
  return !!w && w.since >= t - REMOTE_LIMITS.wrongWindow && w.n >= REMOTE_LIMITS.wrongCodes;
}
/** Counts a wrong code; true when the account is now at its window's limit. */
async function wrongCode(env: RemoteEnv, account: string, t: number): Promise<boolean> {
  await env.SHARE_DB!.prepare("INSERT INTO remote_wrong (account, n, since) VALUES (?1, 1, ?2) ON CONFLICT(account) DO UPDATE SET n = CASE WHEN since < ?3 THEN 1 ELSE n + 1 END, since = CASE WHEN since < ?3 THEN ?2 ELSE since END")
    .bind(account, t, t - REMOTE_LIMITS.wrongWindow).run();
  return tooManyWrong(env, account, t);
}

async function activate(req: Request, env: RemoteEnv, ctx: Ctx): Promise<Response> {
  if (!sameSite(req)) return err(403, "cross-site request");
  const s = await sessionOf(req, env, ctx);
  if (!s) return page("Connect a remote", "<p>Your session ended: sign in again.</p>", 401);
  if (!(await allowed(env, s))) return page("Connect a remote", "<p>Remotes aren't available for this account yet.</p>", 403);
  const text = await boundedText(req);
  if (text === null) return err(413, "too large");
  const f = new URLSearchParams(text);
  const t = now();
  const tooMany = () => page("Connect a remote", "<p>Too many wrong codes: wait ten minutes, then try again.</p>", 429);
  if (await tooManyWrong(env, s.id, t)) return tooMany();
  const code = normCode(f.get("code"));
  const db = env.SHARE_DB!;
  const d = code
    ? await db.prepare("SELECT device_hash, kind, jwk, jkt, name, expires, state FROM remote_devices WHERE user_code = ?1").bind(code)
      .first<{ device_hash: string; kind: Kind; jwk: string; jkt: string; name: string; expires: number; state: string }>()
    : null;
  if (!d || d.expires < t || d.state !== "pending") {
    if (await wrongCode(env, s.id, t)) return tooMany();
    return page("Connect a remote", codeForm("That code isn't valid (or it expired). Check the code the command shows."), 400);
  }
  const decision = f.get("decision");
  if (decision === "deny") {
    await db.prepare("UPDATE remote_devices SET state = 'denied' WHERE device_hash = ?1 AND state = 'pending'").bind(d.device_hash).run();
    return page("Connect a remote", "<p>Denied. The command will stop.</p>");
  }
  if (decision !== "approve") {
    // (the confirmation: what is asking, in words, with its stable identity; the name is its own claim)
    const short = d.jkt.slice(0, 4) + " " + d.jkt.slice(4, 8);
    return page("Connect a remote", `<p>Approve this remote for your account?</p>
<p>${esc(d.name)} <span class="k">(as it says)</span><br>${KIND_WORDS[d.kind]}<br><span class="k">key ${esc(short)}</span></p>
<form method="post" action="/remote/activate"><input type="hidden" name="code" value="${esc(code!)}"><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form>`);
  }
  // (the slots: at most `registered` per account and kind, not revoked.  This read only words the answer; the cap
  // itself is the INSERT's own guard below, in the batch's one transaction (astra's B106-SLOT-1: two approvals that
  // both read registered - 1 here can't both insert))
  const full = () => page("Connect a remote", `<p>This account already has ${REMOTE_LIMITS.registered} ${d.kind}s: revoke one first.</p>`, 409);
  const n = await db.prepare("SELECT COUNT(*) AS n FROM remotes WHERE account = ?1 AND kind = ?2 AND revoked IS NULL").bind(s.id, d.kind).first<{ n: number }>();
  if ((n?.n ?? 0) >= REMOTE_LIMITS.registered) return full();
  const id = "r" + b64url(random(15)); // (120 bits)
  const r = await db.batch([
    // (and only while the exact session that approves is still live, for this account, not being deleted, nor deleted:
    // a purge drops every session as it marks the account deleting, so an approval held past the session check above
    // inserts nothing after a purge began, a self-purge's end (deleting NULL again, a newer sign-in) included; share's
    // TOUCH guards the same way (B106-PURGE-4); a deleted account (tombstoned) has no sessions: the purge drops them and
    // sign-in refuses a tombstone)
    db.prepare(`INSERT INTO remotes (remote_id, account, kind, jwk, jkt, name, created)
      SELECT ?1, ?2, d.kind, d.jwk, d.jkt, d.name, ?3 FROM remote_devices d WHERE d.device_hash = ?4 AND d.state = 'pending' AND d.expires >= ?3
        AND (SELECT COUNT(*) FROM remotes x WHERE x.account = ?2 AND x.kind = d.kind AND x.revoked IS NULL) < ?5
        AND EXISTS (SELECT 1 FROM sessions s JOIN accounts a ON a.account_id = s.account_id WHERE s.token_hash = ?6 AND s.account_id = ?2 AND s.expires > ?3 AND a.deleting IS NULL)`)
      .bind(id, s.id, t, d.device_hash, REMOTE_LIMITS.registered, s.session),
    db.prepare("UPDATE remote_devices SET state = 'approved', account = ?2, remote_id = ?3 WHERE device_hash = ?1 AND state = 'pending' AND EXISTS (SELECT 1 FROM remotes WHERE remote_id = ?3)").bind(d.device_hash, s.id, id),
  ]);
  if ((r[0] as { meta?: { changes?: number } }).meta?.changes !== 1) {
    const again = await db.prepare("SELECT state FROM remote_devices WHERE device_hash = ?1").bind(d.device_hash).first<{ state: string }>();
    const m = await db.prepare("SELECT COUNT(*) AS n FROM remotes WHERE account = ?1 AND kind = ?2 AND revoked IS NULL").bind(s.id, d.kind).first<{ n: number }>();
    if (again?.state === "pending" && (m?.n ?? 0) >= REMOTE_LIMITS.registered) return full();
    return page("Connect a remote", codeForm("That code was just used or expired. Run the command again."), 409);
  }
  return page("Connect a remote", `<p>Approved. <b>${esc(d.name)}</b> is now one of your remotes; the command continues by itself.</p>`);
}

// ---- the challenge (the relay's admission, b2: verified in the Worker before any Durable Object is touched)

/**
 * An enrolled remote that may connect: not revoked, and its account neither being deleted nor deleted (astra's
 * B106-PURGE-4 follow-up: between a purge's start and its retried removal of the remotes, their keys must not
 * authenticate).  Null otherwise; the challenge and its verification answer alike either way.
 */
async function liveRemote(env: RemoteEnv, rid: string): Promise<{ account: string; kind: Kind; jwk: string } | null> {
  const db = env.SHARE_DB!;
  const row = await db.prepare("SELECT r.account, r.kind, r.jwk, r.revoked, (SELECT a.deleting FROM accounts a WHERE a.account_id = r.account) AS deleting FROM remotes r WHERE r.remote_id = ?1")
    .bind(rid).first<{ account: string; kind: Kind; jwk: string; revoked: number | null; deleting: number | null }>();
  if (!row || row.revoked !== null || row.deleting !== null) return null;
  if (await db.prepare("SELECT 1 AS x FROM tombstones WHERE account_hash = ?1").bind(await accountHash(row.account)).first()) return null;
  return { account: row.account, kind: row.kind, jwk: row.jwk };
}

type Chal = { v: 1; rid: string; kind: Kind; n: string; exp: number };
const CHAL_TAG = "sb-remote-chal/1\n";

async function challenge(req: Request, env: RemoteEnv): Promise<Response> {
  const b = await body(req);
  if (!b || typeof b.remote_id !== "string" || !/^r[A-Za-z0-9_-]{20}$/.test(b.remote_id)) return err(400, "invalid_request");
  const row = await liveRemote(env, b.remote_id);
  // (an unknown, a revoked remote and one whose account is being deleted answer alike)
  if (!row) return err(404, "unknown_remote");
  const payload: Chal = { v: 1, rid: b.remote_id, kind: row.kind, n: b64url(random(16)), exp: now() + REMOTE_LIMITS.challengeSeconds };
  const p = b64url(enc.encode(JSON.stringify(payload)));
  return json({ challenge: `${p}.${await hmac(await chalKey(env), CHAL_TAG + p)}`, expires_in: REMOTE_LIMITS.challengeSeconds });
}

/** What the challenge-signed upgrade signs: these exact bytes. */
export const challengeMessage = (c: string) => enc.encode(CHAL_TAG + c);

/**
 * A peer's challenge and its signature, checked as the relay's upgrade will (b2), before any Durable Object: the
 * challenge's HMAC and expiry; the remote enrolled, not revoked and of the challenge's kind; then ES256 (64-byte r||s,
 * WebCrypto's form) over challengeMessage(c) with its enrolled key.  The challenge's single use is the relay's (b2: a
 * durable used-set, after this).  The checked challenge, or why not.
 */
export async function verifyChallenge(env: RemoteEnv, c: unknown, sig: unknown): Promise<{ ok: true; chal: Chal; account: string } | { ok: false; why: string }> {
  if (!enabled(env)) return { ok: false, why: "disabled" };
  const parts = typeof c === "string" && c.length <= 600 ? c.split(".") : [];
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]{1,512}$/.test(parts[0]) || !same(parts[1], await hmac(await chalKey(env), CHAL_TAG + parts[0]))) return { ok: false, why: "challenge" };
  let chal: Chal;
  try {
    chal = JSON.parse(new TextDecoder().decode(unb64url(parts[0])));
  } catch {
    return { ok: false, why: "challenge" };
  }
  if (!chal || chal.v !== 1 || typeof chal.exp !== "number" || chal.exp < now()) return { ok: false, why: "expired" };
  const row = typeof chal.rid === "string" ? await liveRemote(env, chal.rid) : null;
  if (!row || row.kind !== chal.kind) return { ok: false, why: "unknown_remote" };
  if (typeof sig !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(sig)) return { ok: false, why: "signature" };
  const raw = unb64url(sig);
  if (raw.length !== 64) return { ok: false, why: "signature" };
  const key = await crypto.subtle.importKey("jwk", JSON.parse(row.jwk), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const good = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, challengeMessage(c as string));
  return good ? { ok: true, chal, account: row.account } : { ok: false, why: "signature" };
}

// ---- the account's peers, and revoke

async function peers(req: Request, env: RemoteEnv, ctx: Ctx): Promise<Response> {
  const s = await sessionOf(req, env, ctx);
  if (!s) return err(401, "not signed in");
  type Row = { remote_id: string; kind: Kind; name: string; jwk: string; jkt: string; created: number; agents?: string | null; agents_at?: number | null };
  const db = env.SHARE_DB!;
  let rows: Row[];
  try {
    rows = (await db.prepare("SELECT remote_id, kind, name, jwk, jkt, created, agents, agents_at FROM remotes WHERE account = ?1 AND revoked IS NULL ORDER BY created")
      .bind(s.id).all<Row>()).results ?? [];
  } catch {
    // (a database before the agents columns' migration: the list as before, every computer with no agents)
    rows = (await db.prepare("SELECT remote_id, kind, name, jwk, jkt, created FROM remotes WHERE account = ?1 AND revoked IS NULL ORDER BY created")
      .bind(s.id).all<Row>()).results ?? [];
  }
  // (available: whether this account may enroll and use a computer here, allowed(); the notebook page offers its
  // terminal only when it is true.  Visibility only: enroll and the relay legs check it again at use.  agents: the
  // runner's last admitted report, a hint for the page's list; its hello decides)
  return json({
    peers: rows.map(({ agents, agents_at, ...p }) => ({ ...p, jwk: JSON.parse(p.jwk), ...storedAgents(p.kind, agents, agents_at) })),
    available: await allowed(env, s),
  });
}

/** The agent kinds a runner's leg reports (x-sb-remote-agents): the whole header as one list, at most AGENTS_HEADER
 *  ASCII bytes, at most AGENT_KINDS unique names, each matching the runner's own pattern (relay.py AGENT_NAME), in
 *  order; anything else, a missing header included, is null.  Never a prefix, a part of a list or a folded case. */
export const AGENT_KINDS = 4;
export const AGENTS_HEADER = 100;
const AGENT_NAME = /^[a-z][a-z0-9-]{0,15}$/;
export function agentKinds(h: string | null): string[] | null {
  if (h === null || h.length > AGENTS_HEADER || !/^[\x21-\x7e]+$/.test(h)) return null;
  const names = h.split(",");
  if (names.length > AGENT_KINDS || new Set(names).size !== names.length || !names.every((n) => AGENT_NAME.test(n))) return null;
  return names;
}

/** A peer's stored agents, checked again as it is read: a runner's valid list and its time, else [] and null. */
function storedAgents(kind: Kind, agents: string | null | undefined, at: number | null | undefined): { agents: string[]; agents_at: number | null } {
  let list: unknown = null;
  try {
    list = typeof agents === "string" ? JSON.parse(agents) : null;
  } catch {
    list = null;
  }
  // (each element on its own, never the list joined back into a header: a stored element with a comma in it is not a name)
  const ok = kind === "runner" && Array.isArray(list) && list.length >= 1 && list.length <= AGENT_KINDS
    && list.every((n) => typeof n === "string" && AGENT_NAME.test(n)) && new Set(list).size === list.length;
  return ok ? { agents: list as string[], agents_at: Number.isSafeInteger(at) && (at as number) >= 0 ? (at as number) : null } : { agents: [], agents_at: null };
}

/** After the relay admitted a runner's leg: its reported agent kinds (null clears them) and the time, together, on its
 *  own live row only (the admitted remote and account; not revoked, not an account being deleted or deleted).  It
 *  never makes a row, and a failure here (a database before the agents columns, say) leaves the admitted leg alone. */
async function recordAgents(env: RemoteEnv, rid: string, account: string, kinds: string[] | null): Promise<void> {
  try {
    await env.SHARE_DB!.prepare(
      "UPDATE remotes SET agents = ?3, agents_at = ?4 WHERE remote_id = ?1 AND account = ?2 AND kind = 'runner' AND revoked IS NULL"
      + " AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.account_id = ?2 AND a.deleting IS NOT NULL)"
      + " AND NOT EXISTS (SELECT 1 FROM tombstones WHERE account_hash = ?5)")
      .bind(rid, account, kinds === null ? null : JSON.stringify(kinds), Date.now(), await accountHash(account)).run();
  } catch {
    // (the list is a hint: the leg is admitted either way)
  }
}

async function revoke(req: Request, env: RemoteEnv, ctx: Ctx): Promise<Response> {
  if (!sameSite(req)) return err(403, "cross-site request");
  const s = await sessionOf(req, env, ctx);
  if (!s) return err(401, "not signed in");
  const b = await body(req);
  if (!b || typeof b.remote_id !== "string") return err(400, "invalid_request");
  // (the relay's durable `revoked` write is the linearization point (design §3): first, for a remote of this account;
  // then this row, for reporting.  A relay that fails leaves the row as it was, and the revoke is retried.)
  if (env.REMOTE_RELAY) {
    const own = await env.SHARE_DB!.prepare("SELECT 1 AS x FROM remotes WHERE remote_id = ?1 AND account = ?2 AND revoked IS NULL").bind(b.remote_id, s.id).first();
    if (!own) return err(404, "unknown_remote");
    const rr = await env.REMOTE_RELAY.get(env.REMOTE_RELAY.idFromName(b.remote_id)).fetch("https://relay/revoke", { method: "POST" });
    if (!rr.ok) return err(503, "try again");
  }
  const r = await env.SHARE_DB!.prepare("UPDATE remotes SET revoked = ?3 WHERE remote_id = ?1 AND account = ?2 AND revoked IS NULL").bind(b.remote_id, s.id, now()).run();
  return r.meta?.changes === 1 ? json({ ok: true }) : err(404, "unknown_remote");
}

// ---- the relay's legs (b2a): authenticated here, before any Durable Object is touched; the relay gets only the
// headers set here

const isUpgrade = (req: Request) => req.headers.get("upgrade")?.toLowerCase() === "websocket";

async function peerLeg(req: Request, env: RemoteEnv, kind: "runner" | "agent"): Promise<Response> {
  if (!env.REMOTE_RELAY) return err(404, "not found");
  if (!isUpgrade(req)) return err(426, "upgrade required");
  if (!(await preauth(req, env))) return err(429, "slow_down");
  const v = await verifyChallenge(env, req.headers.get("x-sb-remote-challenge"), req.headers.get("x-sb-remote-signature"));
  if (!v.ok) return err(v.why === "unknown_remote" ? 404 : 403, v.why);
  if (v.chal.kind !== kind) return err(403, "kind");
  const relay = env.REMOTE_RELAY.get(env.REMOTE_RELAY.idFromName(v.chal.rid));
  const res = await relay.fetch("https://relay/peer", {
    headers: { upgrade: "websocket", "x-r-account": v.account, "x-r-remote": v.chal.rid, "x-r-kind": v.chal.kind, "x-r-chal": v.chal.n, "x-r-exp": String(v.chal.exp) },
  });
  // (only once the relay has admitted it: a used challenge, a revoked remote, a full account or a superseded leg is
  // refused there, and changes nothing here)
  if (kind === "runner" && res.status === 101) await recordAgents(env, v.chal.rid, v.account, agentKinds(req.headers.get("x-sb-remote-agents")));
  return res;
}

async function pageLeg(req: Request, env: RemoteEnv, ctx: Ctx): Promise<Response> {
  if (!env.REMOTE_RELAY) return err(404, "not found");
  if (!isUpgrade(req)) return err(426, "upgrade required");
  if (!sameSite(req)) return err(403, "cross-site request");
  const s = await sessionOf(req, env, ctx);
  if (!s) return err(401, "not signed in");
  if (!(await allowed(env, s))) return err(403, "not available for this account");
  const url = new URL(req.url);
  const rid = url.searchParams.get("remote") ?? "";
  const chan = url.searchParams.get("chan") ?? "kernel";
  if (!/^r[A-Za-z0-9_-]{20}$/.test(rid)) return err(400, "invalid_request");
  const r = await liveRemote(env, rid);
  // (an unknown remote, another account's, a revoked one and one whose account is being deleted answer alike)
  if (!r || r.account !== s.id) return err(404, "unknown_remote");
  if (!capsFor(r.kind, chan)) return err(400, "unknown channel");
  const relay = env.REMOTE_RELAY.get(env.REMOTE_RELAY.idFromName(rid));
  return relay.fetch("https://relay/page", { headers: { upgrade: "websocket", "x-r-account": s.id, "x-r-remote": rid, "x-r-kind": r.kind, "x-r-chan": chan } });
}

// ---- routing

/** The remotes routes' response to req, or null if req is not for them. */
export async function handleRemote(req: Request, env: RemoteEnv, ctx: Ctx): Promise<Response | null> {
  const p = new URL(req.url).pathname;
  if (!p.startsWith("/api/remote/") && p !== "/remote/activate") return null;
  if (!enabled(env)) return err(404, "not found");
  const m = req.method;
  if (p === "/remote/activate") {
    if (m === "GET") return activatePage(req, env, ctx);
    if (m === "POST") {
      // (the code's guess rate: the per-IP limit too, before the session or any D1 work (B106-PREAUTH-3 follow-up))
      if (!(await preauth(req, env))) return page("Connect a remote", "<p>Too many attempts from here: wait a minute, then try again.</p>", 429);
      return activate(req, env, ctx);
    }
    return err(405, "method not allowed");
  }
  if (p === "/api/remote/v1/peers" && m === "GET") return peers(req, env, ctx);
  if (p === "/api/remote/v1/revoke" && m === "POST") return revoke(req, env, ctx);
  if (p === "/api/remote/v1/runner" && m === "GET") return peerLeg(req, env, "runner");
  if (p === "/api/remote/v1/page" && m === "GET") return pageLeg(req, env, ctx);
  if (m !== "POST") return err(404, "not found");
  // (unauthenticated: the per-IP limit before any D1 work)
  if (!(await preauth(req, env))) return err(429, "slow_down");
  if (p === "/api/remote/v1/device") return startDevice(req, env);
  if (p === "/api/remote/v1/device/poll") return poll(req, env);
  if (p === "/api/remote/v1/challenge") return challenge(req, env);
  return err(404, "not found");
}

/**
 * An account's remotes, deleted with it (web/share's purge): remoteDeletes are the statements, [] where 0009 isn't
 * applied yet, for the purge's final batch, so they commit in the same transaction as its completion (no remote can
 * outlive it); purgeRemotes runs them on their own, when the purge starts, after it has marked the account deleting.
 * Any failure but a missing 0009 throws, and the purge stays where it was, to be retried (astra's B106-PURGE-4).  An
 * approval meanwhile inserts nothing: its INSERT refuses an account being deleted or deleted (activate).
 */
/**
 * Revoke, in its relay, every remote of an account, before its rows go (astra's #109 purge finding): the relay's
 * durable `revoked` write is what ends its live legs and refuses any admission already past the Worker's checks (the
 * relay rechecks it after its own awaits); deleting the D1 rows alone would leave connected legs forwarding.  Throws if
 * a relay can't be reached, so the purge stays where it is and is retried.  Nothing to do without the relay's binding.
 */
async function revokeRelays(env: ShareEnv, account: string): Promise<void> {
  const relay = (env as RemoteEnv).REMOTE_RELAY;
  if (!relay) return;
  const rows = await env.SHARE_DB!.prepare("SELECT remote_id FROM remotes WHERE account = ?1").bind(account).all<{ remote_id: string }>();
  for (const { remote_id } of rows.results ?? []) {
    const r = await relay.get(relay.idFromName(remote_id)).fetch("https://relay/revoke", { method: "POST" });
    if (!r.ok) throw new Error(`the relay of ${remote_id} didn't revoke (${r.status})`);
  }
}

export async function remoteDeletes(env: ShareEnv, account: string): Promise<D1Stmt[]> {
  const db = env.SHARE_DB!;
  if (!(await db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'remotes'").first())) return []; // (no 0009 here yet)
  await revokeRelays(env, account); // (any remote still here is revoked in its relay first)
  return [
    db.prepare("DELETE FROM remotes WHERE account = ?1").bind(account),
    db.prepare("DELETE FROM remote_devices WHERE account = ?1").bind(account),
    db.prepare("DELETE FROM remote_wrong WHERE account = ?1").bind(account),
  ];
}
/** (see remoteDeletes: the same statements, on their own, for purgeAccount before it advances the purge) */
export async function purgeRemotes(env: ShareEnv, account: string): Promise<void> {
  const db = env.SHARE_DB;
  if (!db) return;
  try {
    await revokeRelays(env, account);
    await db.batch([
      db.prepare("DELETE FROM remotes WHERE account = ?1").bind(account),
      db.prepare("DELETE FROM remote_devices WHERE account = ?1").bind(account),
      db.prepare("DELETE FROM remote_wrong WHERE account = ?1").bind(account),
    ]);
  } catch (e) {
    if (/no such table: remote(s|_devices|_wrong)\b/.test(String((e as Error)?.message ?? e))) return; // (no 0009 here yet)
    throw e;
  }
}
