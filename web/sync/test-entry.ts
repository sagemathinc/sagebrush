// The Worker that web/sync/test-sync.mjs runs in Miniflare: the sync API,
// with sharing's sign-in for sessions, and the two object classes.  It alone
// turns the test seams on (web/sync/env.ts testMode); no deployed entry does.
(globalThis as { __SAGEBRUSH_SYNC_TEST__?: boolean }).__SAGEBRUSH_SYNC_TEST__ = true;
import { handleShare } from "../share/server.ts";
import { handleSync, handleSyncFiles, register, syncScheduled, type Env } from "./server.ts";
import { accountHash } from "./protocol.ts";
export { SyncAccount } from "./account.ts";
export { SyncDoc } from "./doc.ts";

export default {
  async fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const url = new URL(req.url);
    // (tests only: run the inventory and answer its stats)
    if (url.pathname === "/__test/inventory") return Response.json(await syncScheduled(env));
    // (tests only: the rest of a registration the hold-enable seam held, as the Worker would send it)
    if (url.pathname === "/__test/register") {
      const account = url.searchParams.get("account") ?? "";
      const hash = await accountHash(account);
      return register(env, env.SYNC_ACCOUNT!.get(env.SYNC_ACCOUNT!.idFromName("acct:" + hash)), account, hash, Number(url.searchParams.get("generation")));
    }
    if (url.hostname.endsWith("files.test")) return (await handleSyncFiles(req, env)) ?? new Response("not found", { status: 404 });
    return (await handleSync(req, env)) ?? (await handleShare(req, env, ctx)) ?? new Response("not the API", { status: 404 });
  },
  async scheduled(_e: unknown, env: Env) {
    await syncScheduled(env);
  },
};
