// The log mirror's routes on the site (plan r7, design B; SEC pins S1-S8; amendments A1, A2).  The signed-in page
// uploads the allowlisted entries of its agent's log, and reads them back on another device.  Every request is
// authenticated here, by the site's session, and reaches exactly one object, the account's MirrorAccount, named by
// the account it authenticated: the page never names an account or a storage prefix (S1).
//
//   GET    /api/mirror/v1/status                         -> {available, state, mode, conversations, bytes, csrf}
//   POST   /api/mirror/v1/enable                         -> {state: "on"}
//   POST   /api/mirror/v1/disable  {confirm: "delete"}   -> {state: "off"}   every key and index now, objects after
//   GET    /api/mirror/v1/conversations                  -> {conversations: [{conversation, locator, mode, streams}]}
//   POST   /api/mirror/v1/conversations {conversation}   -> {locator}
//   DELETE /api/mirror/v1/conversations/<locator>        -> {}
//   POST   /api/mirror/v1/append/<locator>               one segment: the body (MIRROR_TYPE), its range in
//                                                         x-sb-mirror-range: "<log_instance> <first_n> <last_n> <first_seq> <last_seq>"
//   GET    /api/mirror/v1/read/<locator>/<log_instance>?after=<n>   the segment from position n + 1
//   POST   /api/mirror/v1/stale    {locator, log_instance, from_n, reason}   a page found a stream disagrees with its runner
//                                                         (S6d): a monotonic mark in the account's object, seen by every device
//
// Requests: same origin (Origin, or for a GET Sec-Fetch-Site), signed in, entitled (MIRROR_ACCOUNTS, or a CoCalc tier
// in MIRROR_TIERS); every request but a GET also carries the CSRF token status gave (x-sb-mirror-csrf, an HMAC of the
// session under a key derived from SESSION_KEY) and an exact content type.  All of that is checked before a body is
// read.  An append's Content-Length is required and capped, no Content-Encoding is accepted, and the quota is reserved
// before its body is read.  Responses are private, no-store.
//
// Inert until bound: every route answers 404 unless MIRROR_ACCOUNT (the object), MIRROR_BUCKET (a private R2 bucket),
// MIRROR_PREAUTH (the per-IP limit), SHARE_DB, SESSION_KEY, a current KEK (MIRROR_KEK_CURRENT, MIRROR_KEK_V<n>) and
// BUDGET_CLAIMS "on" are all set and the database has budget_claims (migration 0016), so merging this changes no
// deployment.  Its object checks the same before it writes a claim.
//
// Deploy contract (M3): apply 0016 before setting BUDGET_CLAIMS "on".  Once a claim exists, keep this code deployed (or
// later code that counts budget_claims): no Worker rollback to before it until every claim row is gone.  Unbinding
// BUDGET_CLAIMS is safe (counting is by the table, sharingUsed; the mirror goes inert).
//
// Bodies, plaintext and keys are never logged; the stale mark's audit line has positions and a reason only.
import { accountHash, authTier, claimsWritable, limits, sessionResult, same, type Ctx, type ShareEnv } from "../share/server.ts";
import { MIRROR_CAPS, MIRROR_SCHEMA, canonical, parseBody, LOG_INSTANCE, entryOk, type MirrorEntry } from "../../workspace/agent-chat/mirror-format.ts";
import { ALG, ENVELOPE, LOCATOR, OVERHEAD, b64url, currentKek, hex, newWrappedDek, nonceOf, open, openDek, seal, sha256Hex, type Header, type KekEnv } from "./crypto.ts";
import { STALE_REASONS, type MirrorAccount, type MirrorCode, type R } from "./account.ts";

export const MIRROR_TYPE = "application/vnd.sagebrush.mirror+json";
/** How long before its reservation ends the Worker stops writing an object (the object's late deletion waits longer). */
const PUT_MARGIN_MS = 30_000;
const SMALL_BODY = 1024;

export type MirrorSiteEnv = ShareEnv & KekEnv & {
  MIRROR_ACCOUNT?: DurableObjectNamespace<MirrorAccount>;
  MIRROR_BUCKET?: R2Bucket;
  MIRROR_PREAUTH?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  /** who may: comma-separated account ids (DEV) */
  MIRROR_ACCOUNTS?: string;
  /** or who holds one of these CoCalc tiers (the paid membership) */
  MIRROR_TIERS?: string;
  SESSION_KEY?: string;
};

/** Seams for the test entry only: where a read's response is written, and a commit whose answer is lost. */
export interface MirrorHooks {
  out?: Writer;
  loseCommit?: boolean;
  /** called between the seal and the put (the test replaces the object there) */
  beforePut?: (key: string) => Promise<void>;
  afterPut?: (key: string) => Promise<void>;
}
/** What a read writes its answer to: one chunk, after every check has passed or failed. */
export interface Writer {
  write(status: number, body: string): void;
}

const NOSNIFF = { "x-content-type-options": "nosniff" } as const;
const PRIVATE = { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", ...NOSNIFF } as const;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: PRIVATE });
const err = (status: number, error: string, message?: string) => json({ error, ...(message ? { message } : {}) }, status);
const STATUS: Record<MirrorCode, number> = { forbidden: 403, off: 409, missing: 404, conflict: 409, busy: 503, limit: 413, storage_full: 507, mode: 409, expired: 409, mismatch: 409, exhausted: 507, invalid: 400 };
const answer = <T>(r: R<T>, ok: (v: T) => Response) => ("error" in r ? err(STATUS[r.error.code] ?? 400, r.error.code, r.error.message) : ok(r.ok));
const listOf = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const enc = new TextEncoder();

export async function mirrorEnabled(env: MirrorSiteEnv): Promise<boolean> {
  if (!(env.MIRROR_ACCOUNT && env.MIRROR_BUCKET && env.MIRROR_PREAUTH && env.SHARE_DB && typeof env.SESSION_KEY === "string" && env.SESSION_KEY.length > 0 && currentKek(env))) return false;
  // (and claims writable: BUDGET_CLAIMS "on" and the table there, so every check of the budget counts the mirror's claim)
  return claimsWritable(env);
}

// ---- the CSRF token (ruling Q2: derived from SESSION_KEY with its own label)
export const CSRF_INFO = "sagebrush/mirror/csrf-key/v1";
async function csrfKey(env: MirrorSiteEnv): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", enc.encode(env.SESSION_KEY!), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode(CSRF_INFO) }, ikm, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
}
async function csrfOf(env: MirrorSiteEnv, session: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await csrfKey(env), enc.encode("mirror-csrf\n" + session))));
}

/** A request from this site's own pages: Origin says so, or, for a GET without one, Sec-Fetch-Site. */
function sameSite(req: Request): boolean {
  const o = req.headers.get("origin");
  if (o !== null) return o === new URL(req.url).origin;
  return req.method === "GET" && req.headers.get("sec-fetch-site") === "same-origin";
}
async function entitled(env: MirrorSiteEnv, who: { id: string; session: string }): Promise<boolean> {
  if (listOf(env.MIRROR_ACCOUNTS).includes(who.id)) return true;
  const tiers = listOf(env.MIRROR_TIERS);
  if (!tiers.length) return false;
  const tier = await authTier(env, who);
  return tier !== null && tiers.includes(tier);
}
/** A body of at most `max` bytes, read no further than that: null if it is longer. */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) all.set(p, (at += p.length) - p.length);
  return all;
}
/** A declared Content-Length: ASCII digits, positive, at most max; else the status to refuse with. */
function declared(req: Request, max: number): number | 411 | 413 {
  const v = req.headers.get("content-length");
  if (v === null || !/^[0-9]{1,9}$/.test(v) || Number(v) === 0) return 411;
  return Number(v) > max ? 413 : Number(v);
}
async function smallJson(req: Request): Promise<Record<string, unknown> | Response> {
  const n = declared(req, SMALL_BODY);
  if (n === 411) return err(411, "invalid", "a body with its Content-Length is required");
  if (n === 413) return err(413, "limit");
  const b = await readCapped(req, n);
  if (!b || b.length !== n) return err(400, "invalid");
  try {
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b));
    if (!v || typeof v !== "object" || Array.isArray(v)) return err(400, "invalid");
    return v as Record<string, unknown>;
  } catch {
    return err(400, "invalid");
  }
}

/** The mirror's response to req, or null if req is not for it. */
export async function handleMirror(req: Request, env: MirrorSiteEnv, ctx: Ctx, hooks: MirrorHooks = {}): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (!p.startsWith("/api/mirror/")) return null;
  if (!(await mirrorEnabled(env))) return err(404, "not found");
  // (before anything that reads a session: one limit per IP)
  if (!(await env.MIRROR_PREAUTH!.limit({ key: req.headers.get("cf-connecting-ip") ?? "unknown" })).success) return err(429, "rate");
  const m = req.method;
  if (!sameSite(req)) return err(403, "forbidden", "cross-site request");
  const s = await sessionResult(req, env, ctx);
  if (s.kind === "unavailable") return err(503, "busy", "sign-in can't be checked right now; try again soon");
  if (s.kind !== "ok") return err(401, "signed_out", "sign in first");
  const who = { id: s.id, session: s.session };
  const ok = await entitled(env, who);
  if (p === "/api/mirror/v1/status" && m === "GET") {
    if (!ok) return json({ available: false });
    const hash = await accountHash(who.id);
    const st = await stubOf(env, hash).status({ account: who.id, hash });
    const csrf = await csrfOf(env, who.session);
    return answer(st, (v) => json({ available: true, ...v, csrf, encryption: "server", uploaded_by: "page" }));
  }
  if (!ok) return err(403, "forbidden", "the mirror isn't part of this account's plan");
  // (everything else but a GET: the CSRF token, then the exact content type, before any body is read)
  if (m !== "GET") {
    const t = req.headers.get("x-sb-mirror-csrf");
    if (t === null || !same(t, await csrfOf(env, who.session))) return err(403, "forbidden", "missing or wrong CSRF token");
    const ce = req.headers.get("content-encoding");
    if (ce !== null && ce.toLowerCase() !== "identity") return err(415, "invalid", "no content encoding");
  }
  const hash = await accountHash(who.id);
  const stub = stubOf(env, hash);
  const base = { account: who.id, hash };
  const type = (req.headers.get("content-type") ?? "").toLowerCase().replace(/\s+/g, "");
  const isJson = type === "application/json" || type === "application/json;charset=utf-8";

  if (p === "/api/mirror/v1/enable" && m === "POST") {
    // (no body: a key is made here, wrapped, and kept only if the account has none)
    const wrapped = await newWrappedDek(env, who.id);
    return answer(await stub.enable({ ...base, wrapped }), () => json({ state: "on" }));
  }
  if (p === "/api/mirror/v1/disable" && m === "POST") {
    if (!isJson) return err(415, "invalid", "JSON only");
    const b = await smallJson(req);
    if (b instanceof Response) return b;
    if (b.confirm !== "delete") return err(400, "invalid", 'send {"confirm": "delete"}');
    return answer(await stub.disable(base), () => json({ state: "off" }));
  }
  if (p === "/api/mirror/v1/conversations") {
    if (m === "GET") return answer(await stub.list(base), (v) => json(v));
    if (m === "POST") {
      if (!isJson) return err(415, "invalid", "JSON only");
      const b = await smallJson(req);
      if (b instanceof Response) return b;
      if (typeof b.conversation !== "string") return err(400, "invalid");
      return answer(await stub.conv({ ...base, conversation: b.conversation }), (v) => json(v));
    }
  }
  const dc = p.match(/^\/api\/mirror\/v1\/conversations\/([0-9a-f]{32})$/);
  if (dc && m === "DELETE") return answer(await stub.deleteConv({ ...base, locator: dc[1] }), () => json({}));
  const ap = p.match(/^\/api\/mirror\/v1\/append\/([0-9a-f]{32})$/);
  if (ap && m === "POST") {
    if (type !== MIRROR_TYPE) return err(415, "invalid", `${MIRROR_TYPE} only`);
    return append(req, env, stub, base, who.session, ap[1], hooks);
  }
  const rd = p.match(/^\/api\/mirror\/v1\/read\/([0-9a-f]{32})\/([A-Za-z0-9_-]{1,64})$/);
  if (rd && m === "GET") {
    const after = url.searchParams.get("after") ?? "0";
    if (!/^[0-9]{1,15}$/.test(after)) return err(400, "invalid");
    return read(env, stub, base, rd[1], rd[2], Number(after), hooks);
  }
  if (p === "/api/mirror/v1/stale" && m === "POST") {
    if (!isJson) return err(415, "invalid", "JSON only");
    const b = await smallJson(req);
    if (b instanceof Response) return b;
    if (Object.keys(b).sort().join(",") !== "from_n,locator,log_instance,reason" || typeof b.locator !== "string" || !LOCATOR.test(b.locator) || typeof b.log_instance !== "string" || !LOG_INSTANCE.test(b.log_instance)
      || !Number.isSafeInteger(b.from_n) || !(STALE_REASONS as readonly string[]).includes(b.reason as string)) return err(400, "invalid");
    const r = await stub.markStale({ ...base, locator: b.locator, log_instance: b.log_instance, from_n: b.from_n as number, reason: b.reason as string });
    // (positions and a reason only: never an entry, a text or a digest of one)
    if (!("error" in r)) console.log(JSON.stringify({ mirror_stale: b.reason, account: hash.slice(0, 16), locator: b.locator, log_instance: b.log_instance, from_n: b.from_n, stale_from: r.ok.stale_from }));
    return answer(r, (v) => json(v));
  }
  return err(404, "not found");
}

function stubOf(env: MirrorSiteEnv, hash: string) {
  const ns = env.MIRROR_ACCOUNT!;
  return ns.get(ns.idFromName("mirror:" + hash));
}
type Stub = ReturnType<typeof stubOf>;
type Base = { account: string; hash: string };

/** Parse x-sb-mirror-range: "<log_instance> <first_n> <last_n> <first_seq> <last_seq>". */
function rangeOf(v: string | null) {
  const m = v?.match(/^([A-Za-z0-9_-]{1,64}) ([1-9][0-9]{0,14}) ([1-9][0-9]{0,14}) ([1-9][0-9]{0,14}) ([1-9][0-9]{0,14})$/);
  if (!m) return null;
  const [first_n, last_n, first_seq, last_seq] = [m[2], m[3], m[4], m[5]].map(Number);
  return Number.isSafeInteger(last_n) && Number.isSafeInteger(last_seq) ? { log_instance: m[1], first_n, last_n, first_seq, last_seq } : null;
}

/** One segment: reserve (before the body), read and check it, seal it, put it (never over an object), commit what was sealed. */
async function append(req: Request, env: MirrorSiteEnv, stub: Stub, base: Base, session: string, locator: string, hooks: MirrorHooks): Promise<Response> {
  const n = declared(req, MIRROR_CAPS.requestBytes);
  if (n === 411) return err(411, "invalid", "a body with its Content-Length is required");
  if (n === 413) return err(413, "limit", `at most ${MIRROR_CAPS.requestBytes} bytes`);
  const range = rangeOf(req.headers.get("x-sb-mirror-range"));
  if (!range) return err(400, "invalid", "x-sb-mirror-range");
  const lim = await limits(env, { id: base.account, session });
  if (!lim) return err(503, "busy", "this account's plan can't be checked now; try again");
  // (the most a segment's object can be: its plaintext cap, sealed)
  const bytes = MIRROR_CAPS.segmentBytes + OVERHEAD;
  const r = await stub.reserve({ ...base, locator, range, bytes, limit: lim.storage_bytes });
  if ("error" in r) return answer(r, json);
  const body = await readCapped(req, n);
  const dup = "dup" in r.ok ? r.ok.dup : null;
  const res = "dup" in r.ok ? null : r.ok;
  const give = async (status: number, code: string, message?: string) => {
    if (res) await stub.abandon({ ...base, res: res.res }).catch(() => {});
    return err(status, code, message);
  };
  if (!body || body.length !== n) return give(400, "invalid", "the body doesn't match its Content-Length");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    return give(400, "invalid", "not UTF-8");
  }
  const parsed = parseBody(text);
  if ("error" in parsed) return give(400, "invalid", parsed.error);
  const g = parsed.range;
  if (g.log_instance !== range.log_instance || g.first_n !== range.first_n || g.last_n !== range.last_n || g.first_seq !== range.first_seq || g.last_seq !== range.last_seq)
    return give(400, "invalid", "the body's range isn't the header's");
  const plaintext = enc.encode(canonical(parsed.body));
  if (plaintext.length > MIRROR_CAPS.segmentBytes) return give(413, "limit", `a segment is at most ${MIRROR_CAPS.segmentBytes} bytes`);
  const digest = await sha256Hex(plaintext);
  if (dup) return dup.digest === digest ? json({ segment: dup.segment, digest, first_n: g.first_n, last_n: g.last_n }) : err(409, "conflict", "another history holds this range");
  const rv = res!;
  const dek = await openDek(env, base.account, rv.wraps);
  if (!dek) return give(503, "busy", "this account's key can't be opened");
  if (dek.rewrap) await stub.storeWrap({ ...base, wrapped: dek.rewrap });
  const h: Header = {
    v: ENVELOPE, alg: ALG, schema: MIRROR_SCHEMA, account: base.account, locator, log_instance: g.log_instance, segment: rv.segment,
    first_n: g.first_n, last_n: g.last_n, first_seq: g.first_seq, last_seq: g.last_seq, prev: rv.prev, key_id: dek.key_id, nonce: hex(nonceOf(rv.nonce)), len: plaintext.length,
  };
  const obj = await seal(dek.key, h, plaintext);
  if (obj.length > rv.bytes) return give(413, "limit");
  const sha = await sha256Hex(obj);
  await hooks.beforePut?.(rv.key);
  if (Date.now() > rv.expires - PUT_MARGIN_MS) return give(503, "busy", "try again");
  // (never over an existing object: a key is never reused, and R2 refuses the write if one is there)
  const put = await env.MIRROR_BUCKET!.put(rv.key, obj, { sha256: sha, onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/octet-stream" } }).catch(() => null);
  if (!put) return give(503, "busy", "storage refused the write; try again");
  await hooks.afterPut?.(rv.key);
  const c = await stub.commit({ ...base, res: rv.res, digest, len: plaintext.length, size: obj.length, sha });
  if ("error" in c) return err(STATUS[c.error.code] ?? 400, c.error.code, c.error.message);
  if (hooks.loseCommit) return err(503, "busy", "(test) the commit's answer was lost");
  return json({ segment: c.ok.segment, digest, first_n: g.first_n, last_n: g.last_n });
}

/**
 * One segment back, verified whole before a byte of it is written (S3, S6): the record and the path agree with the
 * object's header, GCM authenticates all of it, the entries are exactly the allowlisted schema, contiguous from first_n
 * with the agent's numbers increasing in [first_seq, last_seq], the digest is the record's, and the chain is the
 * previous segment's.  Anything else is `missing`, never a part of it.
 */
async function read(env: MirrorSiteEnv, stub: Stub, base: Base, locator: string, log_instance: string, after: number, hooks: MirrorHooks): Promise<Response> {
  let status = 200, out = "";
  const w: Writer = hooks.out ?? { write: (s, b) => ((status = s), (out = b)) };
  const res = () => (hooks.out ? new Response(null, { status: 204, headers: PRIVATE }) : new Response(out, { status, headers: PRIVATE }));
  const plan = await stub.readPlan({ ...base, locator, log_instance, after });
  if ("error" in plan) {
    w.write(STATUS[plan.error.code] ?? 400, JSON.stringify({ error: plan.error.code }));
    return res();
  }
  // (the stream's stale mark, S6d: on every answer, so every device shows what a page found)
  const stale = { stale_from: plan.ok.stale_from, stale_reason: plan.ok.stale_reason };
  if ("end" in plan.ok) {
    w.write(200, JSON.stringify({ end: true, ...stale }));
    return res();
  }
  const { seg, key, chain, wraps, account } = plan.ok;
  const missing = (reason: string) => {
    w.write(200, JSON.stringify({ missing: true, reason, segment: seg.segment, first_n: seg.first_n, last_n: seg.last_n, ...stale }));
    return res();
  };
  if (seg.prev !== chain) return missing("chain");
  const o = await env.MIRROR_BUCKET!.get(key);
  if (!o) return missing("absent");
  if (o.size !== seg.size) return missing("corrupt");
  const obj = new Uint8Array(await o.arrayBuffer());
  const dek = await openDek(env, account, wraps);
  if (!dek) return missing("key");
  if (dek.rewrap) await stub.storeWrap({ ...base, wrapped: dek.rewrap });
  const want: Header = {
    v: ENVELOPE, alg: ALG, schema: MIRROR_SCHEMA, account, locator, log_instance, segment: seg.segment, first_n: seg.first_n, last_n: seg.last_n,
    first_seq: seg.first_seq, last_seq: seg.last_seq, prev: chain, key_id: seg.key_id, nonce: hex(nonceOf(seg.nonce)), len: seg.len,
  };
  const pt = await open(dek.key, obj, want);
  if (!pt || (await sha256Hex(pt)) !== seg.digest) return missing("corrupt");
  const parsed = parseBody(new TextDecoder().decode(pt));
  if ("error" in parsed) return missing("corrupt");
  const g = parsed.range;
  if (g.log_instance !== log_instance || g.first_n !== seg.first_n || g.last_n !== seg.last_n || g.first_seq !== seg.first_seq || g.last_seq !== seg.last_seq
    || parsed.body.entries.length !== seg.last_n - seg.first_n + 1 || !parsed.body.entries.every((e: MirrorEntry) => entryOk(e))) return missing("corrupt");
  w.write(200, JSON.stringify({
    segment: seg.segment, log_instance, first_n: seg.first_n, last_n: seg.last_n, first_seq: seg.first_seq, last_seq: seg.last_seq,
    digest: seg.digest, prev: chain, encryption: "server", uploaded_by: "page", ...stale, entries: parsed.body.entries,
  }));
  return res();
}

// ---- an account's purge (web/cloud/share's purgeAccount and drain): the mirror's data first, its claim last

/** Erase the account's mirror (keys and index now, objects by its alarm).  Throws if its object can't be reached, so the
 * purge stays where it is and is retried.  Nothing to do where the mirror isn't bound. */
export async function purgeMirror(env: MirrorSiteEnv, account: string): Promise<void> {
  if (!env.MIRROR_ACCOUNT) return;
  const hash = await accountHash(account);
  const r = await stubOf(env, hash).disable({ account, hash });
  if ("error" in r) throw new Error("the mirror didn't erase (" + r.error.code + ")");
}
/** Whether the account's mirror holds nothing more in R2 (its outbox is empty); true where the mirror isn't bound. */
export async function mirrorGone(env: MirrorSiteEnv, account: string): Promise<boolean> {
  if (!env.MIRROR_ACCOUNT) return true;
  const hash = await accountHash(account);
  const r = await stubOf(env, hash).pending({ account, hash });
  return !("error" in r) && r.ok.pending === 0 && r.ok.state !== "on";
}
