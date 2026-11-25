// Where the fleet pages get their data (design: agent-autonomous-pages-fleet r2.1 §2, §3): the service's read routes
// with the person's own session, or, on a loopback test page that asks for it, a fixture service. Read only: nothing
// here writes, signs or verifies; the page verifies every signed object itself (fleet-verify.ts).
//
// The mock gate (§3, §4's truth table): the fixtures are served only to a loopback page (localhost or 127.0.0.1) whose
// address carries ?fixtures=1. Anywhere else the flag is ignored and the page reads the service. The fixtures come
// from the test's own server (fixtures.json next to the page), never from the page's bundle.

/** One host as the service lists it: its certificate, revocation and latest ack as exact signed text (or null), and
 *  grant_gen, the highest generation the service accepted (unverified: the grants themselves come from grantsPage). */
export type HostRow = Readonly<{ host: string; cert: string; revocation: string | null; grant_gen: number | null; ack: string | null }>;
/** A page of a host's accepted grants in generation order (gen below `before`, ending at the highest): their exact
 *  texts, and the host's head generation. */
export type GrantsPage = Readonly<{ grants: readonly string[]; head: number }>;
/** A narrowing op as the service lists it (unsigned: shown as an unverified report). */
export type OpRow = Readonly<{ op_id: unknown; kind: unknown; state: unknown; at_ms: unknown }>;
/** A page of the device chain, read by the core's own reader: each entry's text, the head, and the next `after`. */
export type ChainPage = Readonly<{ entries: readonly string[]; head: number; next: number }>;

export interface Source {
  readonly kind: "service" | "fixtures";
  /** The person's fleet and the audience its objects name; null when the person has no fleet. */
  fleet(): Promise<{ fleet: string; aud: string } | null>;
  /** The whole device chain, from genesis, as its entries' texts. */
  chain(): Promise<string[]>;
  hosts(): Promise<HostRow[]>;
  /** The host's newest accepted grants (at most 16), in generation order: with `before`, those below that gen. */
  grantsPage(host: string, before: number | null): Promise<GrantsPage>;
  /** A host's state report (unverified); null when there is none. */
  state(host: string): Promise<unknown>;
  ops(host: string): Promise<OpRow[] | null>;
  /** The clock the page reads lifetimes and ages by. */
  now(): number;
}

/** The service refused or failed: its reason code (§5.4), or "unavailable" when it didn't answer in its shape. */
export class ServiceError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

export const ROUTES = {
  fleet: "/api/fleet/v1/fleet",
  chain: "/api/fleet/v1/chain",
  hosts: "/api/fleet/v1/hosts",
  grants: (host: string, before: number | null) => `/api/fleet/v1/hosts/${encodeURIComponent(host)}/grants` + (before === null ? "" : `?before=${before}`),
  state: (host: string) => `/api/fleet/v1/hosts/${encodeURIComponent(host)}/state`,
  ops: (host: string) => `/api/fleet/v1/hosts/${encodeURIComponent(host)}/ops`,
} as const;

/** At most this many chain pages are read (256 entries each): a chain longer than this is refused, never looped on. */
export const CHAIN_PAGES_MAX = 64;
/** A read answers within this, or it is given up. */
export const READ_MS = 15_000;

export const isLoopback = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1";

/** Which source a page at `url` reads (§4's truth table): fixtures only on loopback with ?fixtures=1. */
export function sourceKind(url: URL): "service" | "fixtures" {
  return isLoopback(url.hostname) && url.searchParams.get("fixtures") === "1" ? "fixtures" : "service";
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function get(f: Fetch, path: string): Promise<{ status: number; bytes: Uint8Array }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), READ_MS);
  try {
    const r = await f(path, { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: ac.signal, headers: { accept: "application/json" } });
    return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
  } catch {
    throw new ServiceError("unavailable", 0);
  } finally {
    clearTimeout(t);
  }
}

const json = (bytes: Uint8Array): unknown => { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return undefined; } };
const refusal = (status: number, bytes: Uint8Array) => {
  const v = json(bytes) as { error?: unknown } | undefined;
  return new ServiceError(typeof v?.error === "string" && /^[a-z_]{1,40}$/.test(v.error) ? v.error : "unavailable", status);
};
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => typeof v === "string" && v.length > 0;
const strOrNull = (v: unknown) => v === null || str(v);
/** A hosts list in its agreed shape (at most 256), or null. */
function hostsOf(v: unknown): HostRow[] | null {
  if (!isRec(v) || !Array.isArray(v.hosts)) return null;
  const rows = v.hosts.slice(0, 256);
  const gen = (v: unknown) => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v > 0);
  if (!rows.every((h) => isRec(h) && str(h.host) && str(h.cert) && strOrNull(h.revocation) && gen(h.grant_gen) && strOrNull(h.ack))) return null;
  return rows.map((h: any) => ({ host: h.host, cert: h.cert, revocation: h.revocation, grant_gen: h.grant_gen, ack: h.ack }));
}
/** A grants page in its agreed shape (at most 16 grants), or null. */
function grantsOf(v: unknown): GrantsPage | null {
  if (!isRec(v) || !Array.isArray(v.grants) || v.grants.length > 16 || !v.grants.every(str) || !(typeof v.head === "number" && Number.isSafeInteger(v.head) && v.head >= 0)) return null;
  return { grants: v.grants as string[], head: v.head };
}
/** An ops list (at most 64, each field still unchecked: the page reads them as a report), or null. */
const opsOf = (v: unknown): OpRow[] | null => (Array.isArray(v) ? v.slice(0, 64).filter(isRec).map((o) => ({ op_id: o.op_id, kind: o.kind, state: o.state, at_ms: o.at_ms })) : null);

/**
 * The service's routes, with the person's session (same-origin cookies). `readPage` is the core's chain-page reader
 * (fleet-verify.ts readChainPage): it refuses a page that isn't exactly the agreed form.
 */
export function serviceSource(readPage: (bytes: Uint8Array, after: number) => ChainPage, f: Fetch = (i, o) => fetch(i, o)): Source {
  return {
    kind: "service",
    async fleet() {
      const r = await get(f, ROUTES.fleet);
      if (r.status === 404) return null;
      const v = json(r.bytes);
      if (r.status !== 200) throw refusal(r.status, r.bytes);
      if (!isRec(v) || !str(v.fleet) || !str(v.aud)) throw new ServiceError("unavailable", r.status);
      return { fleet: v.fleet as string, aud: v.aud as string };
    },
    async chain() {
      const out: string[] = [];
      let after = -1;
      for (let i = 0; i < CHAIN_PAGES_MAX; i++) {
        const r = await get(f, after < 0 ? ROUTES.chain : `${ROUTES.chain}?after=${after}`);
        if (r.status !== 200) throw refusal(r.status, r.bytes);
        const p = readPage(r.bytes, after);
        out.push(...p.entries);
        if (p.next >= p.head) return out;
        after = p.next;
      }
      throw new ServiceError("limit", 200);
    },
    async hosts() {
      const r = await get(f, ROUTES.hosts);
      if (r.status !== 200) throw refusal(r.status, r.bytes);
      const rows = hostsOf(json(r.bytes));
      if (!rows) throw new ServiceError("unavailable", r.status);
      return rows;
    },
    async grantsPage(host, before) {
      const r = await get(f, ROUTES.grants(host, before));
      if (r.status !== 200) throw refusal(r.status, r.bytes);
      const p = grantsOf(json(r.bytes));
      if (!p) throw new ServiceError("unavailable", r.status);
      return p;
    },
    async state(host) {
      const r = await get(f, ROUTES.state(host));
      if (r.status === 404) return null;
      if (r.status !== 200) throw refusal(r.status, r.bytes);
      return json(r.bytes) ?? null;
    },
    async ops(host) {
      const r = await get(f, ROUTES.ops(host));
      if (r.status === 404) return null;
      if (r.status !== 200) throw refusal(r.status, r.bytes);
      const v = json(r.bytes);
      return isRec(v) ? opsOf(v.ops) : null;
    },
    now: () => Date.now(),
  };
}

/**
 * The fixture service of a loopback test page (§3): one JSON file the test serves beside the page,
 * { fleet, aud, now_ms, chain: [entry], hosts: [HostRow], grants: { <host>: [grant] }, state: { <host>: report },
 * ops: { <host>: [OpRow] } }. Its
 * signed objects are the agent's own fixtures; it only serves them, and signs nothing.
 */
export function fixtureSource(f: Fetch = (i, o) => fetch(i, o)): Source {
  let data: Promise<Record<string, any>> | null = null;
  let now = 0;
  const load = () => (data ??= (async () => {
    const r = await get(f, "fixtures.json");
    const v = json(r.bytes);
    if (r.status !== 200 || !isRec(v)) throw new ServiceError("unavailable", r.status);
    if (typeof v.now_ms === "number") now = v.now_ms;
    return v;
  })());
  return {
    kind: "fixtures",
    async fleet() { const v = await load(); return str(v.fleet) && str(v.aud) ? { fleet: v.fleet, aud: v.aud } : null; },
    async chain() { const v = await load(); return Array.isArray(v.chain) ? v.chain.filter(str) : []; },
    async hosts() { const rows = hostsOf(await load()); if (!rows) throw new ServiceError("unavailable", 200); return rows; },
    // (the mock only: it reads each grant's gen to page as the service does; the page verifies them all the same)
    async grantsPage(host, before) {
      const v = await load();
      const all: string[] = isRec(v.grants) && Array.isArray(v.grants[host]) ? v.grants[host].filter(str) : [];
      const genOf = (g: string) => { try { return Number(JSON.parse(g)?.body?.gen) || 0; } catch { return 0; } };
      return { grants: all.filter((g) => before === null || genOf(g) < before).slice(-16), head: all.reduce((m, g) => Math.max(m, genOf(g)), 0) };
    },
    async state(host) { const v = await load(); return isRec(v.state) && Object.hasOwn(v.state, host) ? v.state[host] : null; },
    async ops(host) { const v = await load(); return isRec(v.ops) && Object.hasOwn(v.ops, host) ? opsOf(v.ops[host]) : null; },
    now: () => (now > 0 ? now : Date.now()),
  };
}
