// The fleet routes a signing page needs beyond the reads (M4 note §2): the session's freshness, GET /api/fleet/v1/session
// (auth's re-auth d2), and the chain append, POST /api/fleet/v1/chain. Kept apart from client.ts so the read-only
// fleet pages still make no request but GET (test-fleet-pages.mjs S-4). Every answer is read up to its cap, counted as
// it streams in, within its deadline; a longer or slower one is refused, never held whole.
import { fleetCore } from "../../workspace/fleet/install";
import { readChainPage } from "../../workspace/fleet-verify";
import { ServiceError, serviceSource } from "./client";
import type { SignService } from "../../workspace/fleet-sign";

export const WRITE_ROUTES = { session: "/api/fleet/v1/session", chain: "/api/fleet/v1/chain", reauth: (path: string) => `/auth/login?return=${encodeURIComponent(path)}&reauth=1` } as const;
/** Answer caps (bytes) and the deadline (ms) for each call. */
export const WRITE_CAPS = { session: 1024, append: 1024 } as const;
export const WRITE_MS = 15_000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
async function call(f: Fetch, path: string, init: RequestInit, cap: number): Promise<{ status: number; body: unknown }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), WRITE_MS);
  try {
    let r: Response;
    try {
      r = await f(path, { ...init, credentials: "same-origin", cache: "no-store", redirect: "error", signal: ac.signal });
    } catch { throw new ServiceError("unavailable", 0); }
    const reader = r.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) { ac.abort(); await reader.cancel().catch(() => {}); throw new ServiceError("limit", r.status); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.length; }
    let body: unknown;
    try { body = total ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) : undefined; } catch { body = undefined; }
    return { status: r.status, body };
  } catch (e) {
    if (e instanceof ServiceError) throw e;
    throw new ServiceError("unavailable", 0);
  } finally {
    clearTimeout(t);
  }
}
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const code = (v: unknown) => (isRec(v) && typeof v.error === "string" && /^[a-z_]{1,40}$/.test(v.error) ? v.error : "unavailable");
const ms = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** The page's SignService: the service's own routes, the audience this page's objects name. */
export function signService(aud: string, f: Fetch = (i, o) => fetch(i, o)): SignService {
  const reads = serviceSource(readChainPage, f);
  return {
    aud,
    async session() {
      const r = await call(f, WRITE_ROUTES.session, { method: "GET", headers: { accept: "application/json" } }, WRITE_CAPS.session);
      if (r.status === 401) return null;
      const v = r.body;
      if (r.status !== 200 || !isRec(v) || typeof v.account !== "string" || !(v.reauth_ms === null || ms(v.reauth_ms)) || !ms(v.now_ms) || !ms(v.fresh_ms)) throw new ServiceError(code(v), r.status);
      return { account: v.account, reauth_ms: v.reauth_ms as number | null, now_ms: v.now_ms as number, fresh_ms: v.fresh_ms as number };
    },
    async fleet() {
      try { return await reads.fleet(); } catch (e) { if (e instanceof ServiceError && e.code === "no_fleet") return null; throw e; }
    },
    async chain() {
      try { return await reads.chain(); } catch (e) { if (e instanceof ServiceError && e.code === "no_fleet") return []; throw e; }
    },
    async append(entry: string) {
      const bytes = new TextEncoder().encode(entry);
      if (bytes.length > fleetCore().SIGNED_MAX) return { refused: "limit" };
      const r = await call(f, WRITE_ROUTES.chain, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: bytes }, WRITE_CAPS.append);
      if (r.status === 200 && isRec(r.body) && typeof r.body.seq === "number" && Number.isSafeInteger(r.body.seq)) return { seq: r.body.seq };
      if (r.status >= 500 || r.status === 0) throw new ServiceError("unavailable", r.status);
      return { refused: code(r.body) };
    },
  };
}
