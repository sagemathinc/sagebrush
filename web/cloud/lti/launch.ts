// Launch (plan-lti-r5 §3): login initiation, the launch POST in both binding
// modes, storage verify, the cookie fallback, the fresh top-level path, and
// sessions.

import { checkClaims, C } from "./claims.ts";
import { launchCheck, pinPlacement } from "./content.ts";
import { findForLogin, getRegistration, hasDeployment, upsertPlacement, type Registration } from "./db.ts";
import { envName, syntheticEntitlement, type Env } from "./env.ts";
import { ALGS, modulusBits, parseJwt, verifyRsa } from "./jwt.ts";
import { errorPage, guestPage, newTabPage, storageLoginPage, ticketPage, tooLargePage, verifyPage } from "./pages.ts";
import { checkedUrl, type EnvName, type Policy } from "./policy.ts";
import type { LaunchClaims, LoginTx } from "./shard.ts";
import { byteLength, derivedKey, fail, json, LtiError, randomHex, readBounded, sha256Hex, testGate } from "./util.ts";

type ReadyEnv = Env & Required<Pick<Env, "LTI_ORIGIN" | "LTI_DB" | "LTI_REG" | "LTI_SHARD" | "LTI_COURSE">>;

const shardOf = (env: ReadyEnv, rid: string, state: string) => env.LTI_SHARD.get(env.LTI_SHARD.idFromName(`${rid}:${state[0]}`));
const regOf = (env: ReadyEnv, rid: string) => env.LTI_REG.get(env.LTI_REG.idFromName(rid));
const courseOf = (env: ReadyEnv, course: string) => env.LTI_COURSE.get(env.LTI_COURSE.idFromName(course));
const cookieName = (state: string) => `__Host-lti_${state.slice(0, 16)}`;
const isHex = (s: unknown, n: number): s is string => typeof s === "string" && s.length === n && /^[0-9a-f]+$/.test(s);

/** The allowlisted targets (§3.1): our origin, path /lti/app or /lti/deeplink, nothing else. */
function allowedTarget(env: ReadyEnv, t: string): boolean {
  try {
    const u = new URL(t);
    return u.origin === env.LTI_ORIGIN && (u.pathname === "/lti/app" || u.pathname === "/lti/deeplink") && !u.search && !u.hash && t === u.origin + u.pathname;
  } catch {
    return false;
  }
}

async function params(req: Request, max: number): Promise<URLSearchParams> {
  const url = new URL(req.url);
  // (the URL-encoded query is bounded like a form body)
  if (req.method === "GET") {
    if (url.search.length > max) throw new LtiError(413, "too_large");
    return url.searchParams;
  }
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.startsWith("application/x-www-form-urlencoded")) throw new LtiError(415, "content_type");
  const body = await readBounded(req, max);
  if (body === null) throw new LtiError(413, "too_large");
  return new URLSearchParams(body);
}

function authUrl(env: ReadyEnv, p: Policy, t: LoginTx): string {
  const u = new URL(p.auth_endpoint);
  const q: Record<string, string> = {
    scope: "openid", response_type: "id_token", response_mode: "form_post", prompt: "none",
    client_id: t.client_id, redirect_uri: env.LTI_ORIGIN + "/lti/launch", login_hint: t.login_hint, state: t.state, nonce: t.nonce,
  };
  if (t.message_hint !== null) q.lti_message_hint = t.message_hint;
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
}

/** The cookie for a launch (§3.3): partitioned inside a frame; first-party and unpartitioned top-level.  SameSite=None either way. */
function setCookie(state: string, top: boolean): string {
  return `${cookieName(state)}=${state}; Path=/; Secure; HttpOnly; SameSite=None;${top ? "" : " Partitioned;"} Max-Age=600`;
}

/** At most 8 live launch cookies (§3.3): beyond 7 existing, the rest are expired. */
function trimCookies(req: Request): string[] {
  const names = (req.headers.get("cookie") ?? "").split(";").map((c) => c.trim().split("=")[0]).filter((n) => n.startsWith("__Host-lti_")).sort();
  return names.slice(7).map((n) => `${n}=; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=0`);
}

function redirect(location: string, cookies: string[] = []): Response {
  const h = new Headers({ location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
}

/** GET or POST /lti/login (§3.1). */
export async function login(req: Request, env: ReadyEnv): Promise<Response> {
  let q: URLSearchParams;
  try {
    q = await params(req, 8192);
  } catch (e) {
    return fail(e instanceof LtiError ? e.status : 400, e instanceof LtiError ? e.code : "params");
  }
  const iss = q.get("iss"), loginHint = q.get("login_hint"), target = q.get("target_link_uri");
  const clientId = q.get("client_id"), deployment = q.get("lti_deployment_id"), messageHint = q.get("lti_message_hint"), storageTarget = q.get("lti_storage_target");
  const top = q.get("sb_top") === "1";
  // amendment 2 r1 §2.2: decoded UTF-8 bytes, checked before any reservation, transaction or redirect
  const over = (v: string | null, max: number) => v !== null && byteLength(v) > max;
  if (over(iss, 255) || over(clientId, 255) || over(deployment, 255) || over(target, 400) || over(storageTarget, 64)) return fail(400, "params_too_long");
  if (!iss || !loginHint || !target) return fail(400, "params");
  const reg = await findForLogin(env.LTI_DB, iss, clientId);
  if (!reg || reg.state !== "approved" || !reg.policy || !reg.client_id) return fail(400, "registration");
  const fa = reg.policy.framing_origins;
  // (refused, never truncated, hashed or dropped: the platform needs the hint back exactly)
  if (over(messageHint, 1024)) return tooLargePage("message_hint_too_long", fa);
  if (over(loginHint, 255)) return tooLargePage("login_hint_too_long", fa);
  if (!allowedTarget(env, target)) return fail(400, "target");
  if (storageTarget !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(storageTarget)) return fail(400, "storage_target");
  const lease = await regOf(env, reg.rid).reserve("launch");
  if (!lease) return fail(503, "rate");
  const state = randomHex(32), nonce = randomHex(32);
  const mode: LoginTx["mode"] = !top && storageTarget !== null && reg.policy.storage_origin ? "storage" : "cookie";
  const t: LoginTx = { state, nonce, rid: reg.rid, iss, client_id: reg.client_id, deployment, target, login_hint: loginHint, message_hint: messageHint, mode, storage_target: mode === "storage" ? storageTarget : null, created: Date.now() };
  const b = await shardOf(env, reg.rid, state).begin(t);
  if (!b.ok) {
    // (the unused launch token is given back: nothing of this login remains)
    await regOf(env, reg.rid).release(lease);
    if (envName(env) === "vm-test") console.log("lti login refused:", b.code, "bytes", JSON.stringify({ login_hint: byteLength(loginHint), message_hint: messageHint === null ? 0 : byteLength(messageHint) }));
    return b.code === "too_large" ? tooLargePage("too_large", fa) : fail(b.code === "shard_full" ? 503 : 400, b.code);
  }
  await regOf(env, reg.rid).commit(lease);
  const auth = authUrl(env, reg.policy, t);
  if (mode === "storage") {
    return storageLoginPage({
      target: storageTarget!, storageOrigin: reg.policy.storage_origin!, key: state.slice(0, 16), state, nonce, authUrl: auth,
      fallbackUrl: `${env.LTI_ORIGIN}/lti/login/fallback?rid=${reg.rid}&state=${state}`, frameAncestors: reg.policy.framing_origins,
    });
  }
  return redirect(auth, [...trimCookies(req), setCookie(state, top)]);
}

/** GET /lti/login/fallback (§3.3 step 1): storage failed in the page, so the server switches T to cookie mode. */
export async function loginFallback(req: Request, env: ReadyEnv): Promise<Response> {
  const u = new URL(req.url);
  const rid = u.searchParams.get("rid"), state = u.searchParams.get("state");
  if (req.headers.get("sec-fetch-site") !== "same-origin") return fail(403, "same_origin");
  if (!isHex(rid, 32) || !isHex(state, 64)) return fail(400, "params");
  const reg = await getRegistration(env.LTI_DB, rid);
  if (!reg || reg.state !== "approved" || !reg.policy) return fail(400, "registration");
  const t = await shardOf(env, rid, state).toCookie(state);
  if (!t) return errorPage("state", reg.policy.framing_origins);
  return redirect(authUrl(env, reg.policy, t), [...trimCookies(req), setCookie(state, false)]);
}

/** The "Open in a new tab" link: a fresh top-level login with the original hints (§3.3 step 4). */
function newTabHref(env: ReadyEnv, t: LoginTx): string {
  const u = new URL(env.LTI_ORIGIN + "/lti/login");
  u.searchParams.set("iss", t.iss);
  u.searchParams.set("login_hint", t.login_hint);
  u.searchParams.set("target_link_uri", t.target);
  u.searchParams.set("client_id", t.client_id);
  if (t.message_hint !== null) u.searchParams.set("lti_message_hint", t.message_hint);
  if (t.deployment !== null) u.searchParams.set("lti_deployment_id", t.deployment);
  u.searchParams.set("sb_top", "1");
  return u.toString();
}

function cookieValue(req: Request, name: string): string | null {
  for (const c of (req.headers.get("cookie") ?? "").split(";")) {
    const i = c.indexOf("=");
    if (i > 0 && c.slice(0, i).trim() === name) return c.slice(i + 1).trim();
  }
  return null;
}

/** POST /lti/launch (§3.2, §3.3 step 2). */
export async function launch(req: Request, env: ReadyEnv): Promise<Response> {
  const en = envName(env)!;
  let q: URLSearchParams;
  try {
    q = await params(req, 64 * 1024);
  } catch (e) {
    return fail(e instanceof LtiError ? e.status : 400, e instanceof LtiError ? e.code : "params");
  }
  const idt = q.get("id_token"), state = q.get("state");
  if (!idt || !isHex(state, 64)) return fail(400, "params");
  let parsed;
  try {
    parsed = parseJwt(idt);
  } catch (e) {
    return fail(400, (e as LtiError).code ?? "bad_jwt");
  }
  const { header } = parsed;
  if (!(header.alg in ALGS) || typeof header.kid !== "string" || !header.kid || (header.typ !== undefined && header.typ !== "JWT")) return fail(400, "header");
  // The transaction is found by state: but we need its rid, which only the shard knows.  The
  // token's own iss/aud pick a registration to try; T must then agree exactly.
  const iss = typeof parsed.payload.iss === "string" ? parsed.payload.iss : null;
  const aud = parsed.payload.aud;
  const clientId = typeof aud === "string" ? aud : Array.isArray(aud) && aud.length === 1 && typeof aud[0] === "string" ? aud[0] : null;
  if (!iss || !clientId) return fail(400, "aud");
  const reg = await findForLogin(env.LTI_DB, iss, clientId);
  if (!reg || !reg.policy || !reg.client_id) return fail(400, "registration");
  const shard = shardOf(env, reg.rid, state);
  const t = await shard.pending(state);
  if (!t || t.rid !== reg.rid) return errorPage("state", reg.policy.framing_origins);
  const fa = reg.policy.framing_origins;
  const k = await regOf(env, reg.rid).jwk(reg.policy, header.kid, en);
  if ("status" in k) return fail(k.status, k.code);
  if (!k.jwk || !(await verifyRsa(parsed, k.jwk))) {
    if (en === "vm-test") console.log("lti launch signature refused:", JSON.stringify({ alg: header.alg, kid: header.kid, found: !!k.jwk, kty: k.jwk?.kty, alg_k: k.jwk?.alg, use: k.jwk?.use, bits: k.jwk ? modulusBits(k.jwk) : 0 }));
    return fail(401, "signature");
  }
  let claims: LaunchClaims;
  try {
    claims = await checkClaims(parsed.payload, { tx: t, clientId: reg.client_id, deploymentRegistered: (d) => hasDeployment(env.LTI_DB, reg.rid, d), framingOrigins: fa, serviceOrigins: reg.policy.service_origins, now: Date.now() });
  } catch (e) {
    if (e instanceof LtiError) return fail(e.status, e.code);
    throw e;
  }
  // deep linking needs the instructor role in the context (r5 §4.1); anyone else gets the guest page
  if (claims.message_type === "LtiDeepLinkingRequest" && claims.role !== "instructor") claims.role = "guest";
  if (claims.role === "guest") {
    const g = await shard.consume(state, null);
    if (!g.ok) return errorPage(g.code, fa);
    // a guest relaunch is a lower-role relaunch (§3.4, CORR-LTIA-1): the member's elevated sessions end,
    // and an older elevated launch can't be redeemed after it.  Fail closed: unrecorded, it's an error page.
    const course = await derivedKey("course", claims.rid, claims.deployment, claims.context);
    const member = await derivedKey("member", claims.rid, claims.deployment, claims.context, claims.sub);
    const low = await courseOf(env, course).lower(member, claims.launched_at);
    if (!low.ok) return errorPage(low.code, fa);
    return guestPage(fa);
  }
  if (t.mode === "cookie") {
    const c = cookieValue(req, cookieName(state));
    if (c !== state) return newTabPage(newTabHref(env, t), fa);
    const r = await shard.consume(state, claims);
    if (!r.ok || r.value === null) return errorPage(r.ok ? "state" : r.code, fa);
    return ticketPage(`${reg.rid}:${state[0]}:${r.value}`, fa);
  }
  const corr = randomHex(16);
  const r = await shard.launch(state, corr, await sha256Hex(idt), claims);
  if (!r.ok) return errorPage(r.code, fa);
  return verifyPage({ corr: `${reg.rid}:${state[0]}:${corr}`, key: state.slice(0, 16), target: t.storage_target ?? "_parent", storageOrigin: reg.policy.storage_origin!, newTab: newTabHref(env, t), frameAncestors: fa });
}

/** Same-origin JSON only: Sec-Fetch-Site same-origin, Origin ours, JSON, small (§3.3 step 3). */
async function sameOriginJson(req: Request, env: ReadyEnv, max: number): Promise<Record<string, unknown>> {
  if (req.headers.get("sec-fetch-site") !== "same-origin" || req.headers.get("origin") !== env.LTI_ORIGIN) throw new LtiError(403, "same_origin");
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) throw new LtiError(415, "content_type");
  const body = await readBounded(req, max);
  if (body === null) throw new LtiError(413, "too_large");
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    throw new LtiError(400, "json");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new LtiError(400, "json");
  return v as Record<string, unknown>;
}

function splitRef(ref: unknown): { rid: string; digit: string; id: string } | null {
  if (typeof ref !== "string") return null;
  const m = /^([0-9a-f]{32}):([0-9a-f]):([0-9a-f]{32})$/.exec(ref);
  return m ? { rid: m[1], digit: m[2], id: m[3] } : null;
}

/** POST /lti/launch/verify (§3.3 step 3). */
export async function verify(req: Request, env: ReadyEnv): Promise<Response> {
  const b = await sameOriginJson(req, env, 1024);
  const ref = splitRef(b.corr);
  if (!ref || !isHex(b.state, 64) || !isHex(b.nonce, 64) || b.state[0] !== ref.digit) return fail(400, "params");
  const r = await env.LTI_SHARD.get(env.LTI_SHARD.idFromName(`${ref.rid}:${ref.digit}`)).verify(ref.id, b.state, b.nonce);
  if (!r.ok) return fail(400, r.code);
  return json({ ticket: `${ref.rid}:${ref.digit}:${r.value}` });
}

/** POST /lti/session: a launch ticket, once, for a session (§3.3, §3.4). */
export async function session(req: Request, env: ReadyEnv): Promise<Response> {
  const b = await sameOriginJson(req, env, 1024);
  const ref = splitRef(b.ticket);
  if (!ref) return fail(400, "params");
  const r = await env.LTI_SHARD.get(env.LTI_SHARD.idFromName(`${ref.rid}:${ref.digit}`)).redeem(ref.id);
  if (!r.ok) return fail(400, r.code);
  const c = r.value;
  if (c.role === "guest") return fail(403, "guest");
  // a deep-link ticket opens its transaction's picker, not a session (r5 §4)
  if (c.dl_ref) return json({ deep_link: `${ref.rid}:${ref.digit}:${c.dl_ref}`, role: c.role });
  // The no-storage-before-entitlement gate (§7.3, §17.2): until stage E, only vm-test's synthetic stub opens a session.
  if (!syntheticEntitlement(env)) return fail(403, "not_set_up");
  const reg = await getRegistration(env.LTI_DB, c.rid);
  if (!reg || reg.state !== "approved") return fail(403, "registration");
  const course = await derivedKey("course", c.rid, c.deployment, c.context);
  const member = await derivedKey("member", c.rid, c.deployment, c.context, c.sub);
  const placement = c.resource_link === null ? null : await derivedKey("placement", c.rid, c.deployment, c.context, c.resource_link);
  // amendment 3 r15 §4: a placement's pin is checked at every launch, before any handle, member, placement or
  // session is made for it, since anyone who can edit the placement can edit its custom parameters
  if (c.sb) {
    if ("bad" in c.sb || placement === null || !env.LTI_CONTENT) return fail(403, "not_available");
    if (!(await launchCheck(env, reg.owner_ref, c.sb.aid, c.sb.rev))) return fail(403, "not_available");
    const pin = await pinPlacement(env, { rid: c.rid, placement, aid: c.sb.aid, rev: c.sb.rev, item: c.sb.item, launch_id: ref.id });
    if (!pin.ok) return fail(pin.code === "pin_quota" ? 429 : 403, pin.code);
  }
  // the external handles, issued by Reg alone and guarded (amendment 1 r6 §2.4); never sent to the browser
  const personInt = await derivedKey("person", c.rid, c.sub);
  const h = await regOf(env, c.rid).issue(c.rid, personInt, course);
  await testGate("session_after_issue");
  if (!h.ok) return fail(h.code === "removed" ? 403 : h.code === "registration_full" ? 429 : 503, h.code);
  const m = await courseOf(env, course).setMember(member, h.value.member_ref, h.value.person_ref);
  if (!m.ok) return fail(m.code === "erased" ? 403 : 503, m.code);
  // the placement records this launch's AGS grant (r5 §5.1); a URL outside the service origins drops the grant
  if (placement !== null && reg.policy) {
    const svc = new Set(reg.policy.service_origins.map((o) => new URL(o).hostname));
    const okUrl = (u?: string) => {
      if (!u) return null;
      try {
        const x = checkedUrl(u, envName(env)!);
        return svc.has(x.hostname) ? u : null;
      } catch {
        return null;
      }
    };
    const li = okUrl(c.ags?.lineitem), lis = okUrl(c.ags?.lineitems);
    const scope = c.ags && (li || lis || !c.ags.lineitem && !c.ags.lineitems) ? c.ags.scope : null;
    await upsertPlacement(env.LTI_DB, { placement, rid: c.rid, deployment: c.deployment, course, resource_link: c.resource_link!, aid: c.aid ?? null, ags_scope: scope, lineitems: scope ? lis : null, lineitem: scope ? li : null });
  }
  await testGate("session_before_create");
  const s = await courseOf(env, course).create({ course, rid: c.rid, deployment: c.deployment, context: c.context, placement, sub: c.sub, member, member_ref: h.value.member_ref, role: c.role, staff: c.role === "instructor" ? (c.staff ?? "instructor") : null, launched_at: c.launched_at });
  if (!s.ok) return fail(s.code === "sessions_full" || s.code === "course_full" ? 503 : 403, s.code);
  return json({ token: `${course}.${s.value.sid}`, role: s.value.role, staff: s.value.staff, expires: s.value.expires, abs_end: s.value.abs_end });
}

function bearer(req: Request): { course: string; sid: string } | null {
  const m = /^Bearer ([0-9a-f]{32})\.([0-9a-f]{32})$/.exec(req.headers.get("authorization") ?? "");
  return m ? { course: m[1], sid: m[2] } : null;
}

/** POST /lti/session/renew (§3.4): every ≤ 15 min, never past 8 h (learners) or 1 h (instructors). */
export async function renew(req: Request, env: ReadyEnv): Promise<Response> {
  await sameOriginJson(req, env, 64);
  const t = bearer(req);
  if (!t) return fail(401, "session");
  const s = await courseOf(env, t.course).renew(t.sid);
  if (!s.ok) return fail(401, s.code);
  return json({ expires: s.value.expires, abs_end: s.value.abs_end, role: s.value.role });
}

export type { Registration, EnvName };
export { C };
