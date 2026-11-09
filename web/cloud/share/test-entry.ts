// The Worker that web/share/test-share.mjs runs in Miniflare: the share API
// on any host, and the files Worker on host files.test.
import { handleFiles } from "../../share/files.ts";
import { handleShare, scheduled, sharePreview, type ShareEnv } from "./server.ts";

export default {
  async fetch(req: Request, env: ShareEnv, ctx: { waitUntil(p: Promise<unknown>): void }) {
    if (new URL(req.url).hostname === "files.test") return handleFiles(req, env);
    // (tests only: sharePreview's answer, as the site Worker gets it)
    const p = /^\/__preview\/([^/@]+)(?:@(.+))?$/.exec(new URL(req.url).pathname);
    if (p) {
      // (@nodb: a deployment without D1; @dberr: D1 failing)
      const failing = { prepare: () => { throw new Error("D1 is down"); } };
      const e = p[2] === "nodb" ? { ...env, SHARE_DB: undefined } : p[2] === "dberr" ? { ...env, SHARE_DB: failing as never } : env;
      return Response.json(await sharePreview(e, p[1], p[2] && p[2] !== "nodb" && p[2] !== "dberr" ? p[2] : null));
    }
    return (await handleShare(req, env, ctx)) ?? new Response("not the API", { status: 404 });
  },
  async scheduled(_e: unknown, env: ShareEnv) {
    await scheduled(env);
  },
};
