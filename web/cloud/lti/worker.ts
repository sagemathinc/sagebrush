// The LTI tool's Worker (plan-lti-r5 §2.1): its routes, behind a per-IP
// limit before anything else (§15.2).  Without every binding the tool is off
// (404): the bindings are the flag.

import { handleAdmin } from "./admin.ts";
import { uploadBundle } from "./bundle.ts";
import { contentWake } from "./content-wake.ts";
import { ready, type Env } from "./env.ts";
import { launch, login, loginFallback, renew, session, verify } from "./launch.ts";
import { register } from "./register.ts";
import { pick, respond } from "./deeplink.ts";
import { reconcileRegistry } from "./reconcile.ts";
import { fail, json, LtiError } from "./util.ts";

export { LtiReg } from "./reg.ts";
export { LtiLaunchShard } from "./shard.ts";
export { LtiCourse } from "./course.ts";
export { LtiFleet } from "./fleet.ts";
export { LtiContentGate } from "./gate.ts";

export async function handleLti(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/lti/")) return fail(404, "not_found");
  if (!ready(env)) return fail(404, "not_found");
  if (!(await env.LTI_PREAUTH.limit({ key: req.headers.get("cf-connecting-ip") ?? "unknown" })).success) return fail(429, "rate");
  try {
    const p = url.pathname, m = req.method;
    if (p === "/lti/login" && (m === "GET" || m === "POST")) return await login(req, env);
    if (p === "/lti/login/fallback" && m === "GET") return await loginFallback(req, env);
    if (p === "/lti/launch" && m === "POST") return await launch(req, env);
    if (p === "/lti/launch/verify" && m === "POST") return await verify(req, env);
    if (p === "/lti/session" && m === "POST") return await session(req, env);
    if (p === "/lti/session/renew" && m === "POST") return await renew(req, env);
    if (p === "/lti/register" && m === "GET") return await register(req, env);
    if (p === "/lti/deeplink/pick" && m === "POST") return await pick(req, env);
    if (p === "/lti/deeplink/respond" && m === "POST") return await respond(req, env);
    if (p === "/lti/jwks" && m === "GET") return json(env.TOOL_JWKS ? JSON.parse(env.TOOL_JWKS) : { keys: [] }, 200, { "cache-control": "public, max-age=3600" });
    if (p === "/lti/admin/bundle" && m === "PUT") return await uploadBundle(req, env);
    if (p.startsWith("/lti/admin/")) return await handleAdmin(req, env);
    return fail(404, "not_found");
  } catch (e) {
    if (e instanceof LtiError) return fail(e.status, e.code);
    console.log("lti error", (e as Error)?.name ?? "error");
    return fail(500, "error");
  }
}

/** The daily job (§15.1): the registry's quota reconciliation; repairs are logged as alerts. */
export async function ltiScheduled(env: Env): Promise<string[]> {
  if (!ready(env)) return [];
  const fixed = await reconcileRegistry(env.LTI_DB);
  for (const f of fixed) console.log("ALERT lti quota repaired", f);
  return fixed;
}

/** The content wake's schedule (amendment 3 §2.5: every 10 min); every other trigger is the daily job. */
export const CONTENT_CRON = "*/10 * * * *";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return handleLti(req, env);
  },
  async scheduled(c: { cron?: string }, env: Env): Promise<void> {
    if (c?.cron === CONTENT_CRON) {
      const s = await contentWake(env);
      console.log("lti content wake", JSON.stringify({ outcome: s.outcome, mode: s.mode, statements: s.statements, d1_calls: s.d1_calls, r2_calls: s.r2_calls, deleted: s.keys_deleted }));
      return;
    }
    await ltiScheduled(env);
  },
};
