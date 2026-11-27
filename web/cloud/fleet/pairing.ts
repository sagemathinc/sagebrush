// The fleet Worker's host-pairing routes (the pairing service note d3, `6f3ab7e0…`, read with the host note d3r2):
//
//   POST /api/fleet/v1/host/pair           a new host asks for a pairing: Sagebrush-Sig over the body's own sign_key
//   POST /api/fleet/v1/host/pair/result    the host polls: Sagebrush-Sig over the pairing's stored sign_key
//   POST /api/fleet/v1/pairings/lookup     the person's app finds the waiting host by its code (session)
//   POST /api/fleet/v1/pairings/approve    the person approves: a host-pair approval and the host's certificate (session)
//
// A pairing is approved when its host's certificate stands (fleet_host_certs): that state is derived, never stored, so
// the poll and the fleet can't disagree. An approve must first win an atomic claim (P1); an expired pairing stays as a
// tombstone, its code cleared, so its host id keeps answering "expired" (P2). Every decision is one D1 statement or
// one D1 batch, its conditions evaluated inside it. Nothing is cached (no-store); nothing is logged.
import { loadChain, pairHost, type WriterCore } from "./writers.ts";
import { bucket, type D1 } from "./store.ts";
import type { PersonDeps, PersonSession } from "./person.ts";

/** A pairing's life: the person must approve within it (the approval's own life, schemas §4). */
export const PAIRING_LIFE_MS = 10 * 60_000;
/** How long an expired pairing stays as a tombstone answering "expired" (P2). The host's resume horizon depends on it. */
export const PAIRING_TOMBSTONE_MS = 30 * 24 * 3600_000;
/** The host's local resume horizon (host d3r2; TESTS P3): it must stay at most half the tombstone's retention. */
export const PAIRING_HOST_RESUME_MAX_MS = 7 * 24 * 3600_000;
/** An approve's claim lease. It keeps racing approves apart; it can't bound a holder's run, because a Worker's 30 s
 * limit is CPU time, not time spent awaiting D1, so a lapsed holder may still reach pairHost. What keeps a host in one
 * fleet is fleet_hosts.host, a global key that pairHost inserts only where it is absent. */
export const PAIRING_CLAIM_MS = 60_000;
/** A host-pair approval's sign-in age at the claim: the core's own (freshAuth's AUTH_MS, 5 minutes). */
const AUTH_FRESH_MS = 5 * 60_000;
/** A pairing request's body cap. */
export const PAIRING_BODY_MAX = 4096;
/** The per-source, per-account and per-pairing limits (§3). */
export const PAIRING_LIMITS = Object.freeze({
  requestsPerSourceHour: 10, livePerSource: 5, liveTotal: 10_000, pollsPerMinute: 30, lookupsPerAccount: 10, lookupsPerSource: 30, approvesPerAccount: 120,
});
const NONCE_KEEP_MS = 10 * 60_000;
/** The HKDF label of the code-hash key (codeHash). */
export const PAIRING_CODE_LABEL = "sagebrush.fleet.pairing-code.v1";
const HOUR = 3600_000, MINUTE = 60_000;

/** The parts of the fleet core these routes use (server.ts passes the installer's getter: only it names the core). */
export interface PairingCore extends WriterCore {
  SIGNED_MAX: number;
  // (typed as loosely as the mirrored core's own JSDoc-less signatures allow)
  verifyRequest(r: { header: any; method: any; target: any; body?: Uint8Array<ArrayBuffer> }, ctx: any): Promise<any>;
  parseSig(header: any): any;
  checkPublicKey(raw: any): any;
  hostFingerprint(host: any, signRaw: any, encRaw: any): Promise<any>;
  verifyApproval(bytes: any, ctx: any): Promise<any>;
  random(n: number): Uint8Array;
  isId(s: unknown): boolean;
}

/** Test seams (test-entry.ts only; the deployed entry passes none). */
export interface PairingHooks {
  /** the Worker's clock (default Date.now) */
  now?: () => number;
  /** a lowered total of live pairings */
  liveTotal?: number;
  /** runs after the claim's batch, before pairHost (a throw: the holder dies holding the claim; a wait: a slow holder) */
  afterClaim?: () => Promise<void>;
  /** runs after pairHost, before the claim's release (a throw: the holder dies after certifying) */
  afterPair?: () => Promise<void>;
  /** runs after an approve's checks, before its claim (an await lets another approve run first) */
  beforeClaim?: () => Promise<void>;
}

const HOST_PAIR = "/api/fleet/v1/host/pair", HOST_RESULT = "/api/fleet/v1/host/pair/result";
const LOOKUP = "/api/fleet/v1/pairings/lookup", APPROVE = "/api/fleet/v1/pairings/approve";
const B64_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
// (the schema's `name` ($defs.name), which the host-pair approval's subject and the certificate carry)
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RESERVED_NAMES = new Set(["own", "con", "prn", "aux", "nul", ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;
const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const STATUS: Readonly<Record<string, number>> = Object.freeze({
  bad_form: 400, bad_audience: 401, clock_skew: 401, bad_signature: 401, unauthenticated: 401, stale_auth: 401, stale_generation: 409,
  not_granted: 403, approval_mismatch: 403, approval_stale: 403, device_unknown: 403, device_removed: 403, device_tier: 403,
  not_found: 404, no_fleet: 404, replay: 409, approval_used: 409, in_progress: 409, chain_fork: 409, limit: 413, rate: 429,
});
const HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: HEADERS });
const refusal = (code: string, extra: Record<string, unknown> = {}) => json(STATUS[code] ?? 500, { error: code, ...extra });
const bare = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });
const utf8 = new TextEncoder(), utf8d = new TextDecoder("utf-8", { fatal: true });
class Refused extends Error { constructor(readonly code: string) { super(code); } }
const no = (code: string): never => { throw new Refused(code); };
const codeOf = (e: unknown) => { const c = (e as { code?: unknown })?.code; return typeof c === "string" ? c : null; };

/** Whether `name` is the schema's display name (the approval and certificate carry it). */
export const isPairingName = (name: unknown): name is string => typeof name === "string" && NAME.test(name) && !RESERVED_NAMES.has(name);

type Row = { pairing: string; code_hash: string | null; host: string; sign_key: string; enc_key: string; fingerprint: string; name: string; source: string;
  created_ms: number; expires_ms: number; claim: string | null; claim_account: string | null; claim_until_ms: number | null; fleet: string | null };
type Env = { FLEET_DB?: D1; FLEET_AUD?: string; LEASE_KEY_SEED?: string };

// (a pairing's host has a standing certificate: the SQL term, with the row's alias `p`)
const CERTIFIED = "EXISTS (SELECT 1 FROM fleet_host_certs c WHERE c.host = p.host)";
const LIVE = `p.code_hash IS NOT NULL AND p.expires_ms > ?NOW AND NOT ${CERTIFIED}`;

/** The pairing routes, or null for any other path. */
export async function handlePairing(req: Request, url: URL, env: Env, getCore: () => PairingCore, deps?: PersonDeps, hooks: PairingHooks = {}): Promise<Response | null> {
  const path = url.pathname;
  if (path !== HOST_PAIR && path !== HOST_RESULT && path !== LOOKUP && path !== APPROVE) return null;
  if (req.method !== "POST") return bare(405);
  const db = env.FLEET_DB, aud = env.FLEET_AUD;
  if (!db || !aud || !env.LEASE_KEY_SEED) return bare(503);
  const core = getCore();
  const now = hooks.now ?? (() => Date.now());
  try {
    const codeKey = await pairingCodeKey(core, env.LEASE_KEY_SEED);
    const body = await readBody(req, path === APPROVE ? 2 * core.SIGNED_MAX + 1024 : PAIRING_BODY_MAX, 10_000);
    if (body === null) return bare(408);
    if (path === HOST_PAIR || path === HOST_RESULT) {
      const source = (req.headers.get("cf-connecting-ip") ?? "unknown").slice(0, 64);
      const target = url.pathname + url.search;
      return path === HOST_PAIR ? await request(db, core, codeKey, aud, now, hooks, source, target, req.headers.get("sagebrush-sig"), body)
        : await poll(db, core, aud, now, target, req.headers.get("sagebrush-sig"), body);
    }
    if (!deps) return bare(503);
    let s: PersonSession;
    try { s = await deps.session(req); } catch { return bare(503); }
    if (s.kind === "unavailable") return bare(503);
    if (s.kind !== "ok") return refusal("unauthenticated");
    if (!ACCOUNT.test(s.account)) return bare(500);
    if (path === LOOKUP) return await lookup(db, core, codeKey, now, s.account, (req.headers.get("cf-connecting-ip") ?? "unknown").slice(0, 64), body);
    return await approve(db, core, aud, now, hooks, s.account, body);
  } catch (e) {
    if (e instanceof Refused) return refusal(e.code);
    const code = codeOf(e);
    if (code && Object.hasOwn(STATUS, code)) return refusal(code, code === "clock_skew" ? { now_ms: now() } : {});
    // (a missing table, a failed batch, a seam's throw: never a 500 with details)
    return bare(503);
  }
}

// ---- the host's two routes

/** A host's body: an object with exactly `keys`, or bad_form. */
function bodyOf(bytes: Uint8Array, keys: string[]): Record<string, unknown> {
  let v: unknown;
  try { v = JSON.parse(utf8d.decode(bytes)); } catch { return no("bad_form"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) return no("bad_form");
  const got = Object.keys(v as object).sort();
  if (got.length !== keys.length || got.some((k, i) => k !== [...keys].sort()[i])) return no("bad_form");
  return v as Record<string, unknown>;
}

/** The Sagebrush-Sig of a pairing request: a host read's form (no agent, capability or idempotency key) at gen 1. */
async function verifySig(core: PairingCore, aud: string, now: number, target: string, header: string | null, body: Uint8Array<ArrayBuffer>, host: string, key: Uint8Array) {
  const f = core.parseSig(header);
  if (f.agent !== "-" || f.cap !== "-" || f.idem !== "-" || f.op !== "-" || f.gen !== "1") no("bad_form");
  // (core verifyRequest, unchanged: its form, aud, 5-minute window and signature; the key is the one this route names)
  return core.verifyRequest({ header, method: "POST", target, body }, {
    aud, now,
    hostKey: (h: string) => (h === host ? key : no("bad_signature")),
    currentGen: () => 1,
  });
}

/** Spend a pairing request's nonce: this host's old nonces pruned, then the insert if absent; false: a replay. */
async function spendNonce(db: D1, host: string, nonce: string, now: number): Promise<boolean> {
  const res = await db.batch([
    db.prepare("DELETE FROM fleet_pairing_nonces WHERE host = ?1 AND created_ms < ?2").bind(host, now - NONCE_KEEP_MS),
    db.prepare("INSERT OR IGNORE INTO fleet_pairing_nonces (host, nonce, created_ms) VALUES (?1, ?2, ?3)").bind(host, nonce, now),
  ]);
  return (res[1]?.meta?.changes ?? 0) === 1;
}

/** A fresh code: 8 characters of a-z2-7 (40 bits). */
function newCode(core: PairingCore): string {
  const b = core.random(5);
  let acc = 0n;
  for (const x of b) acc = (acc << 8n) | BigInt(x);
  let s = "";
  for (let i = 7; i >= 0; i--) s += CODE_ALPHABET[Number((acc >> BigInt(5 * i)) & 31n)];
  return s;
}
/** A code as stored: HMAC-SHA-256 under a key only the Worker holds, so a database read gives no working codes (a
 * plain hash of 40 bits is undone by trying them all). The key is HKDF'd from the lease key's seed under its own label,
 * so it needs no secret of its own; a new seed only ends the live codes, which last 10 minutes. */
async function codeHash(core: PairingCore, key: CryptoKey, code: string): Promise<string> {
  return core.b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8.encode(code))));
}
let codeKeyMemo: { seed: string; key: Promise<CryptoKey> } | null = null;
function pairingCodeKey(core: PairingCore, seed: string): Promise<CryptoKey> {
  if (codeKeyMemo?.seed !== seed) {
    const key = (async () => {
      const ikm = await crypto.subtle.importKey("raw", new Uint8Array(core.unb64(seed, 32)), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8.encode(PAIRING_CODE_LABEL) }, ikm,
        { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
    })();
    key.catch(() => { if (codeKeyMemo?.key === key) codeKeyMemo = null; });
    codeKeyMemo = { seed, key };
  }
  return codeKeyMemo.key;
}
const isUnique = (e: unknown) => /UNIQUE/i.test(String((e as Error)?.message ?? e));

/** The state a pairing row is in now, by ONE statement: approved (its certificate stands), expired, or pending. */
async function stateOf(db: D1, core: PairingCore, row: Row, now: number): Promise<{ state: "approved"; fleet: string; cert: string } | { state: "expired" | "pending" }> {
  const h = await db.prepare("SELECT h.fleet AS fleet, h.sign_key AS sign_key, h.revoked AS revoked, c.bytes AS bytes FROM fleet_hosts h" +
    " JOIN fleet_host_certs c ON c.fleet = h.fleet AND c.host = h.host WHERE h.host = ?1").bind(row.host).first<{ fleet: string; sign_key: string; revoked: number; bytes: string }>();
  if (h && h.sign_key === row.sign_key) {
    // (a revoked host's pairing answers expired: it starts over with a new id, as for any failed pairing)
    if (h.revoked === 1) return { state: "expired" };
    return { state: "approved", fleet: h.fleet, cert: core.b64(utf8.encode(h.bytes)) };
  }
  return { state: row.expires_ms <= now ? "expired" : "pending" };
}

const rowOf = (db: D1, where: string, v: unknown) => db.prepare(`SELECT * FROM fleet_pairings WHERE ${where} = ?1`).bind(v).first<Row>();

/** POST /host/pair: a new pairing, or (idempotent per host id and keys) the same one again. */
async function request(db: D1, core: PairingCore, codeKey: CryptoKey, aud: string, now: () => number, hooks: PairingHooks, source: string, target: string, header: string | null, bytes: Uint8Array<ArrayBuffer>): Promise<Response> {
  const b = bodyOf(bytes, ["enc_key", "fingerprint", "host", "name", "sign_key"]);
  if (!core.isId(b.host) || typeof b.sign_key !== "string" || !B64_32.test(b.sign_key) || typeof b.enc_key !== "string" || !B64_32.test(b.enc_key)
    || typeof b.fingerprint !== "string" || !B64_32.test(b.fingerprint) || !isPairingName(b.name)) no("bad_form");
  const host = b.host as string, signKey = b.sign_key as string, encKey = b.enc_key as string, fingerprint = b.fingerprint as string, name = b.name as string;
  const signRaw = core.unb64(signKey, 32), encRaw = core.unb64(encKey, 32);
  const t = now();
  // the signature: proof that the host holds sign_key
  const f = await verifySig(core, aud, t, target, header, bytes, host, signRaw);
  // the keys and the fingerprint, recomputed (never taken from the body)
  core.checkPublicKey(signRaw);
  if (encRaw.every((x) => x === 0)) no("bad_form");
  if (core.b64(await core.hostFingerprint(host, signRaw, encRaw)) !== fingerprint) no("bad_form");
  // the source's rate, then the nonce
  if (!(await bucket(db, `pair-req:${source}`, PAIRING_LIMITS.requestsPerSourceHour, HOUR, t, core.newId()))) no("rate");
  if (!(await spendNonce(db, host, f.nonce, t))) no("replay");
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await rowOf(db, "host", host);
    if (row) {
      // (one pairing per host id: its keys are immutable, so other keys under this id are refused)
      if (row.sign_key !== signKey || row.enc_key !== encKey || row.fingerprint !== fingerprint) no("bad_form");
      const st = await stateOf(db, core, row, t);
      if (st.state === "approved") return json(200, { pairing: row.pairing, state: "approved" });
      if (st.state === "expired") return json(200, { pairing: row.pairing, state: "expired" });
      // (still pending: the same pairing, its expiry unchanged, with a new code; only the hash is kept, so the old code dies)
      const code = newCode(core);
      try {
        const r = await db.prepare(`UPDATE fleet_pairings AS p SET code_hash = ?1 WHERE p.pairing = ?2 AND ${LIVE.replaceAll("?NOW", "?3")}`)
          .bind(await codeHash(core, codeKey, code), row.pairing, t).run();
        if ((r.meta?.changes ?? 0) === 1) return json(200, { pairing: row.pairing, code, expires_at_ms: row.expires_ms });
      } catch (e) { if (!isUnique(e)) throw e; }
      continue; // (a code collision, or the state moved: decide again)
    }
    // a new pairing: the sweep, the limits and the insert, in ONE batch
    const pairing = core.newId(), code = newCode(core), expires = t + PAIRING_LIFE_MS, total = hooks.liveTotal ?? PAIRING_LIMITS.liveTotal;
    const live = LIVE.replaceAll("?NOW", "?9");
    let res;
    try {
      res = await db.batch([
        // (expired, uncertified pairings become tombstones: their codes freed)
        db.prepare(`UPDATE fleet_pairings AS p SET code_hash = NULL WHERE p.code_hash IS NOT NULL AND p.expires_ms <= ?1 AND NOT ${CERTIFIED}`).bind(t),
        // (tombstones past their retention go, and so do a revoked host's pairing rows: with their approval rows)
        db.prepare(`DELETE FROM fleet_pairing_approvals WHERE pairing IN (SELECT p.pairing FROM fleet_pairings p WHERE p.expires_ms <= ?1 - ?2 AND (NOT ${CERTIFIED}` +
          " OR EXISTS (SELECT 1 FROM fleet_hosts h WHERE h.host = p.host AND h.revoked = 1)))").bind(t, PAIRING_TOMBSTONE_MS),
        db.prepare(`DELETE FROM fleet_pairings AS p WHERE p.expires_ms <= ?1 - ?2 AND (NOT ${CERTIFIED}` +
          " OR EXISTS (SELECT 1 FROM fleet_hosts h WHERE h.host = p.host AND h.revoked = 1))").bind(t, PAIRING_TOMBSTONE_MS),
        db.prepare("INSERT INTO fleet_pairings (pairing, code_hash, host, sign_key, enc_key, fingerprint, name, source, created_ms, expires_ms)" +
          " SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10" +
          " WHERE NOT EXISTS (SELECT 1 FROM fleet_pairings WHERE host = ?3) AND NOT EXISTS (SELECT 1 FROM fleet_hosts WHERE host = ?3)" +
          ` AND (SELECT COUNT(*) FROM fleet_pairings p WHERE p.source = ?8 AND ${live}) < ?11` +
          ` AND (SELECT COUNT(*) FROM fleet_pairings p WHERE ${live}) < ?12`)
          .bind(pairing, await codeHash(core, codeKey, code), host, signKey, encKey, fingerprint, name, source, t, expires, PAIRING_LIMITS.livePerSource, total),
      ]);
    } catch (e) { if (isUnique(e)) continue; throw e; } // (a code collision, or a racing insert for this host id: decide again)
    if ((res[3]?.meta?.changes ?? 0) === 1) return json(200, { pairing, code, expires_at_ms: expires });
    if (await rowOf(db, "host", host)) continue; // (a racing first request for this host id: answer as a re-POST)
    // (a certificate for this host id that didn't come through a pairing: never rebound)
    if (await db.prepare("SELECT 1 AS x FROM fleet_hosts WHERE host = ?1").bind(host).first()) no("bad_form");
    no("limit");
  }
  throw new Error("the pairing request didn't settle");
}

/** POST /host/pair/result: the pairing's state, told only to the key that asked for it. */
async function poll(db: D1, core: PairingCore, aud: string, now: () => number, target: string, header: string | null, bytes: Uint8Array<ArrayBuffer>): Promise<Response> {
  const b = bodyOf(bytes, ["pairing"]);
  if (!core.isId(b.pairing)) no("bad_form");
  const row = await rowOf(db, "pairing", b.pairing);
  const t = now();
  if (!row) {
    // (an unknown pairing: the header's form and window are still checked, then not_found)
    core.parseSig(header);
    no("not_found");
  }
  let f;
  try {
    f = await verifySig(core, aud, t, target, header, bytes, row!.host, core.unb64(row!.sign_key, 32));
  } catch (e) {
    // (another key, or the right key for another pairing: answered as an unknown pairing)
    if (codeOf(e) === "bad_signature") no("not_found");
    throw e;
  }
  if (!(await bucket(db, `pair-poll:${row!.pairing}`, PAIRING_LIMITS.pollsPerMinute, MINUTE, t, core.newId()))) no("rate");
  if (!(await spendNonce(db, row!.host, f.nonce, t))) no("replay");
  const st = await stateOf(db, core, row!, t);
  return json(200, st);
}

// ---- the app's two routes (F7)

/** POST /pairings/lookup: the waiting host behind a code. It binds nothing (§1.3). */
async function lookup(db: D1, core: PairingCore, codeKey: CryptoKey, now: () => number, account: string, source: string, bytes: Uint8Array): Promise<Response> {
  const t = now();
  if (!(await bucket(db, `pair-lookup:${account}`, PAIRING_LIMITS.lookupsPerAccount, MINUTE, t, core.newId()))) no("rate");
  if (!(await bucket(db, `pair-lookup-src:${source}`, PAIRING_LIMITS.lookupsPerSource, MINUTE, t, core.newId()))) no("rate");
  const b = bodyOf(bytes, ["code"]);
  if (typeof b.code !== "string" || b.code.length > 32) no("bad_form");
  const code = (b.code as string).toLowerCase().replace(/[\s-]/g, "");
  if (!/^[a-z2-7]{8}$/.test(code)) no("bad_form");
  const row = await db.prepare(`SELECT * FROM fleet_pairings p WHERE p.code_hash = ?1 AND ${LIVE.replaceAll("?NOW", "?2")}`).bind(await codeHash(core, codeKey, code), t).first<Row>();
  if (!row) no("not_found");
  const r = row!;
  return json(200, { pairing: r.pairing, host: r.host, sign_key: r.sign_key, enc_key: r.enc_key, fingerprint: r.fingerprint, name: r.name, expires_at_ms: r.expires_ms });
}

/** POST /pairings/approve: the claim, then pairHost, then the claim's release (§1.4, §2.2). */
async function approve(db: D1, core: PairingCore, aud: string, now: () => number, hooks: PairingHooks, account: string, bytes: Uint8Array): Promise<Response> {
  const t = now();
  if (!(await bucket(db, `pair-approve:${account}`, PAIRING_LIMITS.approvesPerAccount, MINUTE, t, core.newId()))) no("rate");
  const b = bodyOf(bytes, ["approval", "cert", "pairing"]);
  if (!core.isId(b.pairing) || typeof b.approval !== "string" || typeof b.cert !== "string") no("bad_form");
  const approvalBytes = utf8.encode(b.approval as string), certBytes = utf8.encode(b.cert as string);
  if (approvalBytes.length > core.SIGNED_MAX || certBytes.length > core.SIGNED_MAX) no("limit");
  const fleet = (await db.prepare("SELECT fleet FROM fleet_accounts WHERE account = ?1").bind(account).first<{ fleet: string }>())?.fleet ?? null;
  if (!fleet) no("no_fleet");
  // 1. the pairing: live and pending
  const row = await db.prepare(`SELECT * FROM fleet_pairings p WHERE p.pairing = ?1 AND ${LIVE.replaceAll("?NOW", "?2")}`).bind(b.pairing, t).first<Row>();
  if (!row) no("not_found");
  const p = row!;
  const chain = await loadChain(db, core, fleet!, aud);
  if (!chain) no("not_granted");
  // 2. the approval, against the STORED pairing (never the request), with a fresh sign-in
  const spent = new Set((await db.prepare("SELECT approval FROM fleet_pairing_approvals WHERE pairing = ?1").bind(p.pairing).all<{ approval: string }>()).results.map((r) => r.approval));
  const a = await core.verifyApproval(approvalBytes, {
    aud, fleet, chain: chain!.state, now: t, checkAuthTime: true, current: null, used: (id: string) => spent.has(id),
    expect: { kind: "host-pair", requester: { pairing: p.pairing }, subject: { host: p.host, sign_key: p.sign_key, enc_key: p.enc_key, fingerprint: p.fingerprint, name: p.name } },
  });
  // 3. the certificate's body names exactly the stored keys, in this account's fleet (pairHost verifies it in full)
  const cert = core.parseCanonical(certBytes, core.SIGNED_MAX)?.body;
  if (!cert || typeof cert !== "object") no("bad_form");
  if (cert.host !== p.host || cert.sign_key !== p.sign_key || cert.enc_key !== p.enc_key || cert.fingerprint !== p.fingerprint) no("approval_mismatch");
  if (cert.fleet !== fleet) no("not_granted");
  if (hooks.beforeClaim) await hooks.beforeClaim();
  // 4. the claim, at a FRESH clock sample: the checks above awaited reads, so time has passed since t. The pairing's
  // expiry is checked again inside the claim's own SQL at this sample, the approval's window and sign-in age here, and
  // the lease runs from it: a claim can't cross an expiry that the earlier sample didn't see
  const tc = now();
  if (tc >= a.not_after_ms || tc < a.at_ms - 5 * 60_000) no("approval_stale");
  if (!(tc - a.auth_time_ms <= AUTH_FRESH_MS && a.auth_time_ms <= tc + AUTH_FRESH_MS)) no("stale_auth");
  // ONE batch: exactly one racer's UPDATE changes a row, and only its approval is spent
  const claim = core.newId(), until = tc + PAIRING_CLAIM_MS;
  const claimable = `p.expires_ms > ?3 AND (p.claim IS NULL OR p.claim_until_ms <= ?3) AND NOT ${CERTIFIED}`;
  let res;
  try {
    res = await db.batch([
      db.prepare(`INSERT INTO fleet_pairing_approvals (approval, pairing, account, at_ms) SELECT ?1, ?2, ?4, ?3 WHERE EXISTS (SELECT 1 FROM fleet_pairings p WHERE p.pairing = ?2 AND ${claimable})`)
        .bind(a.approval, p.pairing, tc, account),
      db.prepare(`UPDATE fleet_pairings AS p SET claim = ?1, claim_account = ?4, claim_until_ms = ?5 WHERE p.pairing = ?2 AND ${claimable}`)
        .bind(claim, p.pairing, tc, account, until),
    ]);
  } catch (e) {
    if (isUnique(e)) no("approval_used");
    throw e;
  }
  if ((res[1]?.meta?.changes ?? 0) !== 1) {
    // (the loser's answer, at the claim's own sample: in_progress only while another claim's lease still runs)
    const again = await rowOf(db, "pairing", p.pairing);
    const certified = again ? (await stateOf(db, core, again, tc)).state === "approved" : false;
    if (again && !certified && again.expires_ms > tc && again.claim !== null && (again.claim_until_ms ?? 0) > tc) no("in_progress");
    no("not_found");
  }
  if (hooks.afterClaim) await hooks.afterClaim();
  // 5. the holder pairs the host: one batch under the head CAS
  let paired: Awaited<ReturnType<typeof pairHost>>;
  try {
    paired = await pairHost(db, core, { fleet: fleet!, aud, bytes: certBytes });
  } catch (e) {
    await release(db, claim, p.pairing, null);
    throw e;
  }
  if (hooks.afterPair) await hooks.afterPair();
  // 6. the release, only while the claim is still this approve's
  await release(db, claim, p.pairing, "ok" in paired ? fleet : null);
  if (!("ok" in paired)) no(paired.refused);
  return json(200, { host: p.host, fleet });
}

function release(db: D1, claim: string, pairing: string, fleet: string | null) {
  return db.prepare("UPDATE fleet_pairings SET claim = NULL, claim_account = NULL, claim_until_ms = NULL, fleet = COALESCE(?3, fleet) WHERE pairing = ?2 AND claim = ?1")
    .bind(claim, pairing, fleet).run();
}

/** The body, at most `max` + 1 bytes and within `ms`: null past the deadline. */
async function readBody(req: Request, max: number, ms: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    for (;;) {
      const r = await Promise.race([reader.read(), deadline]);
      if (r === null) { void reader.cancel(); return null; }
      if (r.done) break;
      n += r.value.length;
      if (n > max) { void reader.cancel(); throw new Refused("limit"); }
      chunks.push(r.value);
    }
  } finally { clearTimeout(timer); }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
