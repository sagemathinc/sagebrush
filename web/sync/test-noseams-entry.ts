// A Worker like the deployed one (web/sync/test-sync.mjs runs it beside the
// test entry): the sync API and the two object classes, without the line in
// test-entry.ts that turns the test seams on.  Bound with every seam's
// binding, it must behave as if none were bound (web/sync/env.ts testMode).
import { handleShare } from "../share/server.ts";
import { handleSync, type Env } from "./server.ts";
export { SyncAccount } from "./account.ts";
export { SyncDoc } from "./doc.ts";

export default {
  async fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    return (await handleSync(req, env)) ?? (await handleShare(req, env, ctx)) ?? new Response("not the API", { status: 404 });
  },
};
