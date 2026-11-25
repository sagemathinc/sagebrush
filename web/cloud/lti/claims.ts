// The id_token's checks (plan-lti-r5 §3.2), as a pure function so every rule
// is testable without a platform.  All of them run before anything is stored.

import type { DeepLinkRequest, LoginTx, LaunchClaims } from "./shard.ts";
import { LtiError } from "./util.ts";

export const C = {
  version: "https://purl.imsglobal.org/spec/lti/claim/version",
  messageType: "https://purl.imsglobal.org/spec/lti/claim/message_type",
  deployment: "https://purl.imsglobal.org/spec/lti/claim/deployment_id",
  target: "https://purl.imsglobal.org/spec/lti/claim/target_link_uri",
  roles: "https://purl.imsglobal.org/spec/lti/claim/roles",
  context: "https://purl.imsglobal.org/spec/lti/claim/context",
  resourceLink: "https://purl.imsglobal.org/spec/lti/claim/resource_link",
  custom: "https://purl.imsglobal.org/spec/lti/claim/custom",
  presentation: "https://purl.imsglobal.org/spec/lti/claim/launch_presentation",
  deepLinking: "https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings",
  ags: "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint",
  nrps: "https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice",
} as const;

const M = "http://purl.imsglobal.org/vocab/lis/v2/membership";
/** §3.2's exact role table (CORR-LTI2-1): full strings, no prefix or suffix matching. */
export const INSTRUCTOR_ROLES = new Set([`${M}#Instructor`, `${M}#Administrator`, `${M}/Instructor#TeachingAssistant`, "Instructor"]);
export const LEARNER_ROLES = new Set([`${M}#Learner`, "Learner"]);

/**
 * Amendment 5 r5 §1: for an `instructor` result only, `ta` iff the roles hold
 * the Instructor#TeachingAssistant sub-role and none of #Instructor,
 * #Administrator or the short "Instructor"; otherwise `instructor`.  Not an
 * instructor: null.  `…/membership#TeachingAssistant` isn't the sub-role, and
 * stays whatever courseRole makes of it.
 */
export function courseStaff(roles: string[]): "instructor" | "ta" | null {
  if (courseRole(roles) !== "instructor") return null;
  const full = roles.some((r) => r === `${M}#Instructor` || r === `${M}#Administrator` || r === "Instructor");
  return !full && roles.includes(`${M}/Instructor#TeachingAssistant`) ? "ta" : "instructor";
}

/** The AGS scopes the tool uses (r5 §5.2), by short name: a ticket stays small, and unknown scopes are dropped. */
export const AGS_SCOPES: Record<string, string> = {
  lineitem: "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
  "lineitem.readonly": "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly",
  "result.readonly": "https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly",
  score: "https://purl.imsglobal.org/spec/lti-ags/scope/score",
};
export const shortScopes = (uris: string[]): string[] => Object.entries(AGS_SCOPES).filter(([, u]) => uris.includes(u)).map(([k]) => k);
export const fullScopes = (names: string[]): string[] => names.filter((n) => n in AGS_SCOPES).map((n) => AGS_SCOPES[n]);

export function courseRole(roles: string[]): "instructor" | "learner" | "guest" {
  if (roles.some((r) => INSTRUCTOR_ROLES.has(r))) return "instructor";
  if (roles.some((r) => LEARNER_ROLES.has(r))) return "learner";
  return "guest";
}

const bad = (code: string): never => {
  throw new LtiError(400, code);
};
const isStr = (v: unknown, max: number, min = 0): v is string => typeof v === "string" && v.length >= min && v.length <= max;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

export interface CheckContext {
  tx: LoginTx;
  clientId: string;
  /** true iff the claimed deployment is registered under the registration */
  deploymentRegistered: (d: string) => Promise<boolean>;
  /** framing origins, for the return URL (§14.1) */
  framingOrigins: string[];
  /** service origins: a deep-link return URL must be in these or the framing origins (§4.1) */
  serviceOrigins?: string[];
  now: number;
}

/** Every §3.2 check on a verified token's payload.  Returns the launch's claims, or throws a 4xx with a code only. */
export async function checkClaims(p: Record<string, unknown>, ctx: CheckContext): Promise<LaunchClaims> {
  const { tx, clientId, now } = ctx;
  const nowS = Math.floor(now / 1000);
  // binding to T
  if (p.iss !== tx.iss) bad("iss");
  const aud = p.aud;
  if (!(aud === clientId || (Array.isArray(aud) && aud.length === 1 && aud[0] === clientId))) bad("aud");
  if (p.azp !== undefined && p.azp !== clientId) bad("azp");
  if (typeof p.nonce !== "string" || p.nonce !== tx.nonce) bad("nonce");
  const d = p[C.deployment];
  if (!isStr(d, 255, 1)) bad("deployment");
  if (tx.deployment !== null && d !== tx.deployment) bad("deployment");
  if (p[C.target] !== tx.target) bad("target");
  // time
  if (!isInt(p.exp) || !isInt(p.iat) || (p.nbf !== undefined && !isInt(p.nbf))) bad("time");
  if ((p.exp as number) <= nowS - 60) bad("expired");
  if ((p.iat as number) > nowS + 60 || (p.iat as number) < nowS - 600) bad("iat");
  if (p.nbf !== undefined && (p.nbf as number) > nowS + 60) bad("nbf");
  // schema, by message type
  const mt = p[C.messageType];
  if (mt !== "LtiResourceLinkRequest" && mt !== "LtiDeepLinkingRequest") bad("message_type");
  if (!isStr(p.sub, 255, 1)) bad("sub");
  if (p[C.version] !== "1.3.0") bad("version");
  const roles = p[C.roles];
  if (!Array.isArray(roles) || roles.length > 50 || !roles.every((r) => isStr(r, 255))) bad("roles");
  const ctxc = p[C.context];
  if (!isObj(ctxc) || !isStr(ctxc.id, 255, 1) || (ctxc.title !== undefined && !isStr(ctxc.title, 255))) bad("context");
  const rl = p[C.resourceLink];
  const dls = p[C.deepLinking];
  if (mt === "LtiResourceLinkRequest") {
    if (!isObj(rl) || !isStr(rl.id, 255, 1)) bad("resource_link");
    if (dls !== undefined) bad("deep_linking_settings");
  } else {
    if (rl !== undefined) bad("resource_link");
    if (!isObj(dls)) bad("deep_linking_settings");
  }
  const custom = p[C.custom];
  if (custom !== undefined) {
    if (!isObj(custom) || Object.keys(custom).length > 32 || !Object.values(custom).every((v) => isStr(v, 1024))) bad("custom");
  }
  const ags = p[C.ags];
  if (ags !== undefined) {
    if (!isObj(ags) || !Array.isArray(ags.scope) || !ags.scope.every((s) => isStr(s, 255)) || (ags.lineitems !== undefined && !isStr(ags.lineitems, 400)) || (ags.lineitem !== undefined && !isStr(ags.lineitem, 400))) bad("ags");
  }
  const nrps = p[C.nrps];
  if (nrps !== undefined) {
    if (!isObj(nrps) || !isStr(nrps.context_memberships_url, 400) || !Array.isArray(nrps.service_versions) || !nrps.service_versions.includes("2.0")) bad("nrps");
  }
  const pres = p[C.presentation];
  if (pres !== undefined && !isObj(pres)) bad("launch_presentation");
  if (!(await ctx.deploymentRegistered(d as string))) bad("deployment");
  // a deep-link request's settings (r5 §4.1–4.2), kept exactly as the response needs them
  let dl: DeepLinkRequest | undefined;
  if (mt === "LtiDeepLinkingRequest") {
    const st = dls as Record<string, unknown>;
    const strs = (v: unknown, n: number) => Array.isArray(v) && v.length <= n && v.every((x) => isStr(x, 64));
    if (!isStr(st.deep_link_return_url, 400, 1) || !strs(st.accept_types, 10) || !strs(st.accept_presentation_document_targets, 10)) bad("deep_linking_settings");
    for (const k of ["accept_multiple", "accept_lineitem", "auto_create"]) if (st[k] !== undefined && typeof st[k] !== "boolean") bad("deep_linking_settings");
    let ret: URL;
    try {
      ret = new URL(st.deep_link_return_url as string);
    } catch {
      return bad("deep_link_return_url");
    }
    const allowed = [...ctx.framingOrigins, ...(ctx.serviceOrigins ?? [])];
    if (ret.protocol !== "https:" || !allowed.includes(ret.origin)) bad("deep_link_return_url");
    let dataJson: string | undefined;
    if (st.data !== undefined) {
      dataJson = JSON.stringify(st.data);
      if (dataJson.length > 512) bad("deep_link_data");
    }
    dl = {
      return_url: st.deep_link_return_url as string,
      ...(dataJson !== undefined ? { data_json: dataJson } : {}),
      accept_types: st.accept_types as string[],
      accept_multiple: st.accept_multiple === true,
      targets: st.accept_presentation_document_targets as string[],
      accept_lineitem: st.accept_lineitem === true,
      ...(typeof st.auto_create === "boolean" ? { auto_create: st.auto_create } : {}),
    };
  }
  // the return URL only if it is in framing_origins (§14.1)
  let returnUrl: string | null = null;
  if (isObj(pres) && isStr(pres.return_url, 400, 1)) {
    try {
      const u = new URL(pres.return_url);
      if (u.protocol === "https:" && ctx.framingOrigins.includes(u.origin)) returnUrl = u.toString();
    } catch {
      // ignored: no return URL
    }
  }
  return {
    rid: tx.rid,
    deployment: d as string,
    context: (ctxc as { id: string }).id,
    context_title: ((ctxc as { title?: string }).title ?? null) as string | null,
    resource_link: mt === "LtiResourceLinkRequest" ? (rl as { id: string }).id : null,
    sub: p.sub as string,
    role: courseRole(roles as string[]),
    ...(courseStaff(roles as string[]) ? { staff: courseStaff(roles as string[])! } : {}),
    message_type: mt as string,
    target: tx.target,
    launched_at: now,
    return_url: returnUrl,
    ...(dl ? { dl } : {}),
    ...(isObj(custom) && typeof custom.sb_assignment === "string" && /^[0-9a-f]{32}$/.test(custom.sb_assignment) ? { aid: custom.sb_assignment } : {}),
    ...(isObj(custom) ? sbOf(custom) : {}),
    ...(isObj(ags) && mt === "LtiResourceLinkRequest" ? { ags: { scope: shortScopes(ags.scope as string[]), ...(typeof ags.lineitems === "string" ? { lineitems: ags.lineitems } : {}), ...(typeof ags.lineitem === "string" ? { lineitem: ags.lineitem } : {}) } } : {}),
  };
}

/**
 * A placement's Sagebrush custom parameters (amendment 3 r15 §4), small and
 * fixed-shape for the ticket: a well-formed (sb_assignment, sb_rev, sb_item),
 * or `bad` when any is present but malformed, which the launch refuses ("isn't
 * available"), never silently drops.
 */
function sbOf(custom: Record<string, unknown>): { sb?: { aid: string; rev: number; item: string | null } | { bad: true } } {
  const a = custom.sb_assignment, r = custom.sb_rev, i = custom.sb_item;
  if (a === undefined && r === undefined && i === undefined) return {};
  const okA = typeof a === "string" && /^[0-9a-f]{32}$/.test(a);
  const okR = typeof r === "string" && /^[1-9][0-9]{0,8}$/.test(r);
  const okI = i === undefined || (typeof i === "string" && /^[0-9a-f]{1,64}$/.test(i));
  if (!okA || !okR || !okI) return { sb: { bad: true } };
  return { sb: { aid: a as string, rev: Number(r), item: (i as string | undefined) ?? null } };
}
