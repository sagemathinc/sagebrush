// The dev site's entry (dev.sagebrush.space, `--mode dev`): the production
// entry (./index.ts) with sync on (web/sync, design/sync-server.md), which
// production neither imports nor exports.  Sync answers first: /api/sync/,
// and its part of /auth/logout and /api/admin/ (sign-out's revoke, a purge's
// sync part), before sharing's; then the production entry answers as it does
// there.  Its two object classes are exported here, for the dev config's
// bindings.  The test seams stay off: only web/sync/test-entry.ts sets them.
import { env } from "cloudflare:workers";
import { handleSync, type Env as SyncSiteEnv } from "../../sync/server.ts";
import site from "./index.ts";
export { SyncAccount } from "../../sync/account.ts";
export { SyncDoc } from "../../sync/doc.ts";

export default {
  async fetch(request, e, ctx) {
    return (await handleSync(request, env as unknown as SyncSiteEnv)) ?? site.fetch!(request, e, ctx);
  },
  scheduled: site.scheduled,
} satisfies ExportedHandler;
