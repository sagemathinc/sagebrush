// The fleet Worker's routes for the person's own fleet page (the reads scope r4, `386ecf0f…`): reads of the fleet the
// signed-in account owns, and the one write that makes it theirs, the chain append.
//
//   GET  /api/fleet/v1/fleet                         { fleet, aud }, or 404 no_fleet
//   GET  /api/fleet/v1/chain[?after=<seq>]           the host route's page, from the core's one encoder
//   POST /api/fleet/v1/chain                         append one device-chain entry; a genesis binds the fleet
//   GET  /api/fleet/v1/hosts                         { hosts: [{ host, cert, revocation, grant_gen, ack }] }
//   GET  /api/fleet/v1/hosts/<id>/grants[?before=<gen> | ?after=<gen>]   { grants, head }: the accepted lineage
//   GET  /api/fleet/v1/session                       { account, reauth_ms, now_ms, fresh_ms }: the session's last
//                                                    re-authentication (null for none), the clock, and how long it counts
//
// The fleet is always the session account's (fleet_accounts); no route takes a fleet id, and a host or fleet that isn't
// the account's is not_found, never told apart from one that doesn't exist. The session is resolved by the mounting
// Worker's own code (the site's session read of SHARE_DB's primary), passed in as `session`: this file never sees a
// cookie or a token. Every answer is read by ONE SQL statement. Nothing is cached (no-store).
import { appendChainEntry, AUTH_MS, type WriterCore } from "./writers.ts";
import { bucket, chainPage, type D1 } from "./store.ts";
import { sessionResult, type Ctx, type ShareEnv } from "../share/server.ts";

/** `reauthMs`: when this session's person last re-authenticated (sessions.reauth_ms, D1 ms), or null for never. */
export type PersonSession = { kind: "ok"; account: string; reauthMs: number | null } | { kind: "none" } | { kind: "unavailable" };
/** What the mounting Worker supplies: the request's account session, read now from the primary (never a cache). */
export interface PersonDeps { session(req: Request): Promise<PersonSession> }

/**
 * The site's own session (the reads scope r4 §2): share/server.ts's `sessionResult`, the cookie and then a read of the
 * SHARE_DB primary, exactly as sharing, sync and remote authenticate. Without the SHARE_DB binding the session can't be
 * checked: "unavailable" (503), never "none". A read that throws is handlePerson's 503.
 */
export function shareSession(env: ShareEnv, ctx?: Ctx): PersonDeps {
  return {
    async session(req) {
      if (!env.SHARE_DB) return { kind: "unavailable" };
      const r = await sessionResult(req, env, ctx);
      return r.kind === "ok" ? { kind: "ok", account: r.id, reauthMs: r.reauthMs } : r.kind === "unavailable" ? { kind: "unavailable" } : { kind: "none" };
    },
  };
}
interface PersonEnv { FLEET_DB?: D1; FLEET_AUD?: string }
/** The parts of the fleet core these routes use; server.ts passes the installer's getter (only it names the core). */
export interface PersonCore extends WriterCore {
  SIGNED_MAX: number;
  CHAIN_ROUTE: string;
  CHAIN_PAGE_ENTRIES: number;
  CHAIN_PAGE_BYTES: number;
  parseCanonical(bytes: Uint8Array, max?: number): { body?: { fleet?: unknown } } | null;
  parseChainTarget(target: string): number;
  chainPageBody(page: { head: number; entries: { seq: number; bytes: string }[] }, after: number): Uint8Array;
  isId(s: unknown): boolean;
  newId(): string;
}

/** §3.1: the /hosts answer's encoded bytes; one more is a store fault (500), never served. */
export const FLEET_HOSTS_BYTES = 1_048_576;
/** §3.2: a lineage page's grants. Its bytes are the chain page's cap. */
export const GRANTS_PAGE = 16;
/** §3.4: reads and appends per account. */
export const PERSON_RATE = Object.freeze({ limit: 120, windowMs: 60_000 });
const APPEND_READ_MS = 10_000;

const FLEET = "/api/fleet/v1/fleet", CHAIN = "/api/fleet/v1/chain", HOSTS = "/api/fleet/v1/hosts", SESSION = "/api/fleet/v1/session";
const GRANTS = /^\/api\/fleet\/v1\/hosts\/([^/]+)\/grants$/;
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;
const COUNT = /^(0|[1-9][0-9]{0,15})$/;
const STATUS: Readonly<Record<string, number>> = Object.freeze({
  bad_form: 400, bad_audience: 401, bad_signature: 401, unauthenticated: 401, stale_auth: 401, not_granted: 403, device_unknown: 403,
  device_removed: 403, device_tier: 403, recovery_key_mismatch: 403, not_found: 404, no_fleet: 404, chain_fork: 409, limit: 413, rate: 429,
});
const HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: HEADERS });
const refusal = (code: string, extra: Record<string, unknown> = {}) => json(STATUS[code] ?? 500, { error: code, ...extra });
const bare = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });
const utf8 = (s: string) => new TextEncoder().encode(s).length;

/** The person's fleet routes, or null for any other path. */
export async function handlePerson(req: Request, url: URL, env: PersonEnv, getCore: () => PersonCore, deps?: PersonDeps): Promise<Response | null> {
  const path = url.pathname;
  const grants = GRANTS.exec(path);
  if (path !== FLEET && path !== CHAIN && path !== HOSTS && path !== SESSION && !grants) return null;
  const write = path === CHAIN && req.method === "POST";
  if (req.method !== "GET" && !write) return bare(405);
  const db = env.FLEET_DB;
  if (!deps || !db || !env.FLEET_AUD) return bare(503);
  // the session, then the account's rate, before any fleet data is read
  let s: PersonSession;
  try { s = await deps.session(req); } catch { return bare(503); }
  if (s.kind === "unavailable") return bare(503);
  if (s.kind !== "ok") return refusal("unauthenticated");
  if (!ACCOUNT.test(s.account)) return bare(500);
  const core = getCore();
  if (!(await bucket(db, `fleet-read:${s.account}`, PERSON_RATE.limit, PERSON_RATE.windowMs, Date.now(), core.newId())))
    return refusal("rate", { retry_after_s: Math.ceil(PERSON_RATE.windowMs / 1000) });
  if (write) return append(req, core, db, env.FLEET_AUD, s.account);
  // (the page's re-authentication state: Approve and every signed write need a re-authentication within fresh_ms)
  if (path === SESSION) {
    const r = s.reauthMs;
    if (r !== null && !(Number.isSafeInteger(r) && r >= 0)) return bare(500);
    return json(200, { account: s.account, reauth_ms: r, now_ms: Date.now(), fresh_ms: AUTH_MS });
  }
  const fleet = (await db.prepare("SELECT fleet FROM fleet_accounts WHERE account = ?1").bind(s.account).first<{ fleet: string }>())?.fleet ?? null;
  if (path === FLEET) return fleet ? json(200, { fleet, aud: env.FLEET_AUD }) : refusal("no_fleet");
  if (!fleet) return refusal("no_fleet");
  try {
    if (path === CHAIN) return await chain(core, db, fleet, url);
    if (path === HOSTS) return await hosts(db, fleet);
    return await lineage(core, db, fleet, decodeURIComponentSafe(grants![1]), url);
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    return typeof code === "string" && Object.hasOwn(STATUS, code) ? refusal(code) : bare(500);
  }
}

const decodeURIComponentSafe = (s: string) => { try { return decodeURIComponent(s); } catch { return ""; } };

/** GET /chain: the host route's target grammar and page, under the account's fleet. */
async function chain(core: PersonCore, db: D1, fleet: string, url: URL): Promise<Response> {
  const after = core.parseChainTarget(core.CHAIN_ROUTE + url.search);
  const page = await chainPage(db, fleet, after, core.CHAIN_PAGE_ENTRIES);
  let body: Uint8Array;
  try { body = core.chainPageBody(page, after); } catch { return bare(500); }
  return new Response(new Uint8Array(body), { status: 200, headers: HEADERS });
}

/** POST /chain: one entry, appended under this account (a genesis binds the fleet to it, §1). */
async function append(req: Request, core: PersonCore, db: D1, aud: string, account: string): Promise<Response> {
  const body = await readBody(req, core.SIGNED_MAX, APPEND_READ_MS);
  if (body === null) return bare(408);
  if (body.length > core.SIGNED_MAX) return refusal("limit");
  try {
    const fleet = core.parseCanonical(body)?.body?.fleet;
    if (typeof fleet !== "string" || !core.isId(fleet)) return refusal("bad_form");
    const r = await appendChainEntry(db, core, { fleet, aud, bytes: body, now: Date.now(), account });
    return "ok" in r ? json(200, { seq: r.seq }) : refusal(r.refused);
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    return typeof code === "string" && Object.hasOwn(STATUS, code) ? refusal(code) : bare(503);
  }
}

/** GET /hosts: every host of the fleet, its certificate and own first revocation as exact text, its current gen. */
async function hosts(db: D1, fleet: string): Promise<Response> {
  const rows = (await db.prepare("SELECT h.host AS host, c.bytes AS cert," +
    " (SELECT r.bytes FROM fleet_revocations r WHERE r.fleet = h.fleet AND r.kind = 'host' AND r.id = h.host) AS revocation," +
    " (SELECT MAX(g.gen) FROM fleet_grants g WHERE g.fleet = h.fleet AND g.host = h.host) AS grant_gen" +
    " FROM fleet_hosts h LEFT JOIN fleet_host_certs c ON c.fleet = h.fleet AND c.host = h.host WHERE h.fleet = ?1 ORDER BY h.host")
    .bind(fleet).all<{ host: string; cert: string | null; revocation: string | null; grant_gen: number | null }>()).results;
  const out = JSON.stringify({ hosts: rows.map((r) => ({ host: r.host, cert: r.cert, revocation: r.revocation, grant_gen: r.grant_gen, ack: null })) });
  // (measured on the built body, before anything is sent: over the cap is a store fault)
  if (utf8(out) > FLEET_HOSTS_BYTES) return bare(500);
  return new Response(out, { status: 200, headers: HEADERS });
}

/**
 * GET /hosts/<id>/grants: the host's accepted grants, ascending. No cursor: the newest page, ending at head inclusive;
 * ?before=<gen>: the highest grants below it; ?after=<gen>: the lowest above it (after=0 from the oldest). No cursor
 * arithmetic happens here, so none can overflow.
 */
async function lineage(core: PersonCore, db: D1, fleet: string, host: string, url: URL): Promise<Response> {
  if (!core.isId(host)) return refusal("not_found");
  const q = url.search;
  let dir: "newest" | "before" | "after" = "newest", at = 0;
  if (q !== "") {
    const m = /^\?(before|after)=([^&]*)$/.exec(q);
    if (!m || !COUNT.test(m[2]) || !Number.isSafeInteger(Number(m[2]))) return refusal("bad_form");
    dir = m[1] as "before" | "after";
    at = Number(m[2]);
    if (dir === "before" && at < 1) return refusal("bad_form");
  }
  const order = dir === "after" ? "ASC" : "DESC";
  const cond = dir === "before" ? "AND gen < ?3" : dir === "after" ? "AND gen > ?3" : "AND ?3 = ?3";
  const rows = (await db.prepare("SELECT x.paired AS paired, x.head AS head, g.gen AS gen, g.bytes AS bytes" +
    " FROM (SELECT EXISTS (SELECT 1 FROM fleet_hosts WHERE host = ?2 AND fleet = ?1) AS paired," +
    " COALESCE((SELECT MAX(gen) FROM fleet_grants WHERE fleet = ?1 AND host = ?2), 0) AS head) x" +
    ` LEFT JOIN (SELECT gen, bytes FROM fleet_grants WHERE fleet = ?1 AND host = ?2 ${cond} ORDER BY gen ${order} LIMIT ?4) g ON 1 ORDER BY g.gen ${order}`)
    .bind(fleet, host, at, GRANTS_PAGE).all<{ paired: number; head: number; gen: number | null; bytes: string | null }>()).results;
  if (rows.length === 0) return bare(500);
  if (rows[0].paired !== 1) return refusal("not_found");
  const head = rows[0].head;
  // (nearest the cursor first: a page stops before CHAIN_PAGE_BYTES of encoded response, keeping at least one grant)
  const picked: { gen: number; bytes: string }[] = [];
  let size = utf8(JSON.stringify({ grants: [], head }));
  for (const r of rows) {
    if (r.gen === null || r.bytes === null) continue;
    const add = utf8(JSON.stringify(r.bytes)) + (picked.length ? 1 : 0);
    if (size + add > core.CHAIN_PAGE_BYTES) { if (!picked.length) return bare(500); break; }
    picked.push({ gen: r.gen, bytes: r.bytes });
    size += add;
  }
  picked.sort((a, b) => a.gen - b.gen);
  const out = JSON.stringify({ grants: picked.map((p) => p.bytes), head });
  if (utf8(out) !== size || size > core.CHAIN_PAGE_BYTES) return bare(500);
  return new Response(out, { status: 200, headers: HEADERS });
}

/** The body, at most `max` + 1 bytes and within `ms`: null past the deadline. */
async function readBody(req: Request, max: number, ms: number): Promise<Uint8Array | null> {
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
      if (n > max) { void reader.cancel(); return new Uint8Array(max + 1); }
      chunks.push(r.value);
    }
  } finally { clearTimeout(timer); }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
