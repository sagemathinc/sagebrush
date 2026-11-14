// The Worker that web/cloud/share/test-identity.mjs runs in Miniflare: the share API, plus (tests only) the WorkOS
// token check itself at /__verify, so its rows run in the Workers runtime, as deployed.
import { clearKeyCache, verifyAccessToken } from "../../share/identity/workos.ts";
import { handleShare, scheduled, type ShareEnv } from "./server.ts";

export default {
  async fetch(req: Request, env: ShareEnv, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const u = new URL(req.url);
    if (u.pathname === "/__verify" && req.method === "POST") {
      const b = (await req.json()) as { token: unknown; now?: number; issuer?: string; clientId?: string; env?: string; fresh?: boolean };
      if (b.fresh) clearKeyCache();
      const c = { env: b.env ?? env.AUTH_ENV!, clientId: b.clientId ?? env.WORKOS_CLIENT_ID!, issuer: b.issuer ?? env.WORKOS_ISSUER!, apiKey: env.WORKOS_API_KEY!, api: env.WORKOS_API };
      return Response.json(await verifyAccessToken(c, b.token, { now: b.now }));
    }
    return (await handleShare(req, env, ctx)) ?? new Response("not the API", { status: 404 });
  },
  async scheduled(_e: unknown, env: ShareEnv) {
    await scheduled(env);
  },
};
