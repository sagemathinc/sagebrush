// The Worker that web/sync/test-sync.mjs runs in Miniflare: the sync API,
// with sharing's sign-in for sessions, and the two object classes.  It alone
// turns the test seams on (web/sync/env.ts testMode); no deployed entry does.
(globalThis as { __SAGEBRUSH_SYNC_TEST__?: boolean }).__SAGEBRUSH_SYNC_TEST__ = true;
import { handleShare } from "../share/server.ts";
import { handleSync, handleSyncFiles, register, syncScheduled, type Env } from "./server.ts";
import { accountHash } from "../sync-protocol/protocol.ts";
import { setGate } from "./env.ts";
export { SyncAccount } from "./account.ts";
export { SyncDoc } from "./doc.ts";

export default {
  async fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const url = new URL(req.url);
    // (tests only: run the inventory and answer its stats)
    if (url.pathname === "/__test/inventory") {
      const d = url.searchParams.get("deadline_ms");
      const prefix = url.searchParams.get("prefix");
      return Response.json(await syncScheduled(env, { ...(d === null ? {} : { deadlineMs: Number(d) }), ...(prefix === null ? {} : { prefix }) }));
    }
    // (tests only: the rest of a registration the hold-enable seam held, as the Worker would send it)
    if (url.pathname === "/__test/register") {
      const account = url.searchParams.get("account") ?? "";
      const hash = await accountHash(account);
      return register(env, env.SYNC_ACCOUNT!.get(env.SYNC_ACCOUNT!.idFromName("acct:" + hash)), account, hash, Number(url.searchParams.get("generation")));
    }
    // (tests only: hold, or open, a named step in the Worker, as a late D1 answer would)
    if (url.pathname === "/__test/gate") {
      setGate(env, url.searchParams.get("name") ?? "", url.searchParams.get("on") === "1");
      return Response.json({ ok: true });
    }
    if (url.hostname.endsWith("files.test")) return (await handleSyncFiles(req, env)) ?? new Response("not found", { status: 404 });
    return (await handleSync(req, env)) ?? (await handleShare(req, env, ctx)) ?? new Response("not the API", { status: 404 });
  },
  async scheduled(_e: unknown, env: Env) {
    await syncScheduled(env);
  },
};
