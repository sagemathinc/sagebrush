// The sync service's routes on sagebrush.space (design/sync-server.md §2,
// §5).  Every request is authenticated here, by sharing's session
// (web/share/server.ts sessionOf), and then reaches exactly one object, the
// account's, which it names by the account it authenticated:
//
//   POST /api/sync/v1/enable    turn sync on for this account (allowlisted on dev)
//   GET  /api/sync/v1/account   the account socket (upgrade; Origin checked)
//
// Without the sync bindings (production today), every route is a 404:
// the bindings are the flag (§11).  Before authentication, an IP limit
// (SYNC_PREAUTH, Cloudflare's rate-limiting binding) comes first (§2).

import { sessionOf, type ShareEnv } from "../share/server.ts";
import { accountHash, SyncError } from "./protocol.ts";
import { allowed, type SyncEnv } from "./env.ts";

export interface RateLimit { limit(o: { key: string }): Promise<{ success: boolean }> }
export type Env = SyncEnv & ShareEnv & { SYNC_PREAUTH?: RateLimit };

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);
const sameSite = (req: Request) => req.headers.get("origin") === new URL(req.url).origin;

const STATUS: Partial<Record<SyncError["code"], number>> = { forbidden: 403, deleting: 409, readonly: 409, invalid: 400, limit: 413, rate: 429, busy: 503 };

/** The sync API's response to req, or null if req is not for it. */
export async function handleSync(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (!p.startsWith("/api/sync/")) return null;
  if (!env.SYNC_ACCOUNT || !env.SYNC_DOC || !env.SHARE_DB) return err(404, "sync is not enabled here");
  // (before anything that reads a session: one limit per IP, whatever the request claims)
  if (env.SYNC_PREAUTH) {
    const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
    if (!(await env.SYNC_PREAUTH.limit({ key: ip })).success) return err(429, "too many requests");
  }
  const m = req.method;
  // every sync request is state-changing or a socket: both come only from this site's pages
  if (!sameSite(req)) return err(403, "cross-site request");
  const who = await sessionOf(req, env);
  if (!who) return err(401, "sign in first");
  if (!allowed(env, who.id)) return err(403, "sync isn't enabled for this account");
  const hash = await accountHash(who.id);
  const stub = env.SYNC_ACCOUNT.get(env.SYNC_ACCOUNT.idFromName("acct:" + hash));
  if (p === "/api/sync/v1/enable" && m === "POST") {
    const r = await stub.enable({ account: who.id, hash });
    return "error" in r ? err(STATUS[r.error.code] ?? 400, r.error.code, { message: r.error.message }) : json(r.ok);
  }
  if (p === "/api/sync/v1/account" && m === "GET") {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return err(426, "a WebSocket upgrade");
    const h = new Headers(req.headers);
    // (the object trusts only these, which only this Worker can send it)
    h.set("x-sync-account", who.id);
    h.set("x-sync-session", who.session);
    h.set("x-sync-expires", String(who.expires * 1000));
    return stub.fetch(new Request(req.url, { method: "GET", headers: h }));
  }
  return err(404, "not found");
}
