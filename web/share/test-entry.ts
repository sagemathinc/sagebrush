// The Worker that web/share/test-share.mjs runs in Miniflare: the share API
// on any host, and the files Worker on host files.test.
import { handleFiles } from "./files.ts";
import { holdDb, holdRoute } from "./test-d1-hold.ts";
import { handleShare, scheduled, type ShareEnv } from "./server.ts";

export default {
  async fetch(req: Request, env: ShareEnv, ctx: { waitUntil(p: Promise<unknown>): void }) {
    if (new URL(req.url).hostname === "files.test") return handleFiles(req, env);
    // (tests only: a D1 write held between its checks and its commit, test-d1-hold.ts)
    const held = await holdRoute(req);
    if (held) return held;
    return (await handleShare(req, env.SHARE_DB ? { ...env, SHARE_DB: holdDb(env.SHARE_DB) } : env, ctx)) ?? new Response("not the API", { status: 404 });
  },
  async scheduled(_e: unknown, env: ShareEnv) {
    await scheduled(env);
  },
};
