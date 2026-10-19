// The Worker that web/sync/test-sync.mjs runs in Miniflare: the sync API,
// with sharing's sign-in for sessions, and the two object classes.
import { handleShare } from "../share/server.ts";
import { handleSync, handleSyncFiles, type Env } from "./server.ts";
export { SyncAccount } from "./account.ts";
export { SyncDoc } from "./doc.ts";

export default {
  async fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    if (new URL(req.url).hostname === "files.test") return (await handleSyncFiles(req, env)) ?? new Response("not found", { status: 404 });
    return (await handleSync(req, env)) ?? (await handleShare(req, env, ctx)) ?? new Response("not the API", { status: 404 });
  },
};
