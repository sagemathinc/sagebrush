// Dynamic registration (plan-lti-r5 §7.1, §17.1).  The code's bootstrap
// policy is fixed by cocalc.ai before the first fetch; every fetch, redirect
// and the registration token go through trustedFetch's "bootstrap" category;
// hosts in the proposed policy are only listed, never fetched, until approved.

import { audit } from "./audit.ts";
import { deploymentSize, guarded, insertRegistrationStmts, regSize, type Bootstrap, type D1, type OwnerKind } from "./db.ts";
import { envName, type Env } from "./env.ts";
import { registeredPage } from "./pages.ts";
import { categoryHosts, checkedUrl, policyDigest, trustedFetch, validatePolicy, type Policy, type Preset } from "./policy.ts";
import { byteLength, LtiError, randomHex, sha256Hex } from "./util.ts";

type RegEnv = Env & Required<Pick<Env, "LTI_ORIGIN" | "LTI_DB" | "LTI_AUDIT" | "LTI_REG">>;

const AGS = ["https://purl.imsglobal.org/spec/lti-ags/scope/lineitem", "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly", "https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly", "https://purl.imsglobal.org/spec/lti-ags/scope/score"];
const NRPS = "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly";
const TOOL_CONFIG = "https://purl.imsglobal.org/spec/lti-tool-configuration";
/** a bootstrap URL may carry the platform's registration token in its query (Canvas does): at most 4 KiB */
const BOOT_URL = 4096;
const PLATFORM_CONFIG = "https://purl.imsglobal.org/spec/lti-platform-configuration";

/** Our client registration (LTI Dynamic Registration §3.4). */
export function toolRegistration(origin: string): Record<string, unknown> {
  return {
    application_type: "web",
    response_types: ["id_token"],
    grant_types: ["implicit", "client_credentials"],
    initiate_login_uri: `${origin}/lti/login`,
    redirect_uris: [`${origin}/lti/launch`],
    client_name: "Sagebrush",
    jwks_uri: `${origin}/lti/jwks`,
    token_endpoint_auth_method: "private_key_jwt",
    scope: [...AGS, NRPS].join(" "),
    [TOOL_CONFIG]: {
      domain: new URL(origin).host,
      target_link_uri: `${origin}/lti/app`,
      claims: ["iss", "sub"],
      messages: [{ type: "LtiResourceLinkRequest", target_link_uri: `${origin}/lti/app` }, { type: "LtiDeepLinkingRequest", target_link_uri: `${origin}/lti/deeplink` }],
    },
  };
}

/** The proposed policy, from the configuration and the platform's answer (§7.1 step 6).  Its hosts aren't fetched until approved. */
export function proposePolicy(config: Record<string, unknown>, configUrl: string): Record<string, unknown> {
  const origin = new URL(configUrl).origin;
  const auth = String(config.authorization_endpoint ?? "");
  let storage: string | undefined;
  try {
    storage = new URL(auth).origin;
  } catch {
    storage = undefined;
  }
  return {
    issuer: config.issuer,
    auth_endpoint: auth,
    jwks_uri: config.jwks_uri,
    token_endpoint: config.token_endpoint,
    ...(typeof config.authorization_server === "string" ? { token_aud: config.authorization_server } : {}),
    service_origins: [origin],
    framing_origins: [origin],
    ...(storage ? { storage_origin: storage } : {}),
    token_deployment_claim: "none",
    services: { ags: true, nrps: true },
  };
}

const parse = (s: string): Record<string, unknown> => {
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    throw new LtiError(502, "json");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new LtiError(502, "json");
  return v as Record<string, unknown>;
};

async function undo(db: D1, rid: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM deployments WHERE rid = ?").bind(rid),
    db.prepare("DELETE FROM registrations WHERE rid = ? AND state = 'bootstrapping'").bind(rid),
    db.prepare("DELETE FROM quota WHERE scope = ? AND NOT EXISTS (SELECT 1 FROM registrations WHERE rid = ?)").bind(rid, rid),
  ]);
}

/** GET /lti/register?code=…&openid_configuration=…&registration_token=… */
export async function register(req: Request, env: RegEnv): Promise<Response> {
  const en = envName(env)!;
  const u = new URL(req.url);
  const code = u.searchParams.get("code"), configUrl = u.searchParams.get("openid_configuration"), token = u.searchParams.get("registration_token");
  if (!code || !/^[0-9a-f]{64}$/.test(code) || !configUrl || byteLength(configUrl) > BOOT_URL || (token !== null && byteLength(token) > BOOT_URL)) return registeredPage(false, []);
  const hash = await sha256Hex(code);
  const now = Date.now();
  const row = await env.LTI_DB.prepare("SELECT owner_ref, owner_kind, preset, bootstrap FROM codes WHERE code_hash = ? AND state = 'live' AND expires > ?").bind(hash, now).first<{ owner_ref: string; owner_kind: OwnerKind; preset: Preset; bootstrap: string }>();
  if (!row) return registeredPage(false, []);
  const bootstrap = JSON.parse(row.bootstrap) as Bootstrap;
  const fa = bootstrap.hosts.map((h) => `https://${h}`);
  // step 2, first: the configuration URL must pass the bootstrap check before anything is reserved or fetched
  const hosts = categoryHosts(null, "bootstrap", bootstrap.hosts);
  try {
    checkedUrl(configUrl, en, BOOT_URL);
    if (!hosts.has(new URL(configUrl).hostname.toLowerCase())) throw new LtiError(400, "host_not_in_policy");
  } catch {
    return registeredPage(false, fa);
  }
  // step 1: reserve the code (single use) and admit the attempt, before anything external
  const rid = randomHex(16);
  const took = await env.LTI_DB.prepare("UPDATE codes SET state = 'reserved', rid = ? WHERE code_hash = ? AND state = 'live' AND expires > ? RETURNING code_hash").bind(rid, hash, now).all();
  if (took.results.length !== 1) return registeredPage(false, fa);
  const restore = () => env.LTI_DB.prepare("UPDATE codes SET state = 'live', rid = NULL WHERE code_hash = ? AND rid = ?").bind(hash, rid).run();
  try {
    await guarded(() => env.LTI_DB.batch(insertRegistrationStmts(env.LTI_DB, { rid, owner_ref: row.owner_ref, owner_kind: row.owner_kind, state: "bootstrapping", iss: null, client_id: null, preset: row.preset, bootstrap: row.bootstrap, policy: null, policy_version: 0, policy_digest: null, staff_digest: null, approved_digest: null, created: now })));
  } catch {
    await restore();
    return registeredPage(false, fa);
  }
  const reg = env.LTI_REG.get(env.LTI_REG.idFromName(rid));
  const lease = await reg.reserve("dynreg");
  if (!lease) {
    await undo(env.LTI_DB, rid);
    await restore();
    return registeredPage(false, fa);
  }
  try {
    // (from here on an external call is made, so a failure consumes the code)
    // step 3
    const c = await trustedFetch(en, hosts, configUrl, { bearer: token ?? undefined }, { maxBytes: 64 * 1024, timeoutMs: 5000, maxUrlLength: BOOT_URL });
    if (c.status !== 200) {
      if (en === "vm-test") console.log("lti register: configuration answered", c.status, c.body.slice(0, 300));
      throw new LtiError(502, "config_status");
    }
    const config = parse(c.body);
    // step 4
    if (bootstrap.expected_issuer !== undefined && config.issuer !== bootstrap.expected_issuer) throw new LtiError(400, "issuer");
    const regEndpoint = config.registration_endpoint;
    if (typeof regEndpoint !== "string") throw new LtiError(400, "registration_endpoint");
    checkedUrl(regEndpoint, en, BOOT_URL);
    if (!hosts.has(new URL(regEndpoint).hostname.toLowerCase())) throw new LtiError(400, "host_not_in_policy");
    void config[PLATFORM_CONFIG];
    // step 5
    const r = await trustedFetch(en, hosts, regEndpoint, { method: "POST", body: JSON.stringify(toolRegistration(env.LTI_ORIGIN)), contentType: "application/json", bearer: token ?? undefined }, { maxBytes: 64 * 1024, timeoutMs: 5000, maxRedirects: 0, maxUrlLength: BOOT_URL });
    if (r.status !== 200 && r.status !== 201) {
      // (vm-test only: the platform's own error text, for diagnosis; never a token)
      if (en === "vm-test") console.log("lti register: platform answered", r.status, r.body.slice(0, 300));
      throw new LtiError(502, "registration_status");
    }
    const answer = parse(r.body);
    const clientId = answer.client_id;
    if (typeof clientId !== "string" || clientId.length < 1 || clientId.length > 255) throw new LtiError(502, "client_id");
    const tc = answer[TOOL_CONFIG] as Record<string, unknown> | undefined;
    // (the deployment: inside the tool configuration, as the spec shows it, or at the top level, where Canvas puts it)
    const depOf = (v: unknown) => (typeof v === "string" && v.length >= 1 && v.length <= 255 ? v : null);
    const deployment = depOf(tc?.deployment_id) ?? depOf(answer.deployment_id);
    // step 6: propose, validated; never fetched
    const policy: Policy = validatePolicy(proposePolicy(config, configUrl), en);
    const ps = JSON.stringify(policy);
    const digest = await policyDigest(policy);
    const size = regSize({ owner_ref: row.owner_ref, iss: policy.issuer, client_id: clientId, bootstrap: row.bootstrap, policy: ps });
    await audit(env.LTI_AUDIT, { action: "registration.dynamic", owner_ref: row.owner_ref, rid, detail: { policy_digest: digest, issuer: policy.issuer } });
    // step 7: pending, with its policy and deployment; the code is used up
    await guarded(() =>
      env.LTI_DB.batch([
        env.LTI_DB.prepare("UPDATE registrations SET state = 'pending', iss = ?, client_id = ?, policy = ?, policy_version = 1, policy_digest = ?, size = ? WHERE rid = ? AND state = 'bootstrapping'").bind(policy.issuer, clientId, ps, digest, size, rid),
        ...(deployment ? [env.LTI_DB.prepare("INSERT INTO deployments (rid, deployment_id, size) VALUES (?, ?, ?)").bind(rid, deployment, deploymentSize(deployment))] : []),
        env.LTI_DB.prepare("DELETE FROM codes WHERE code_hash = ? AND rid = ?").bind(hash, rid),
      ]),
    );
    return registeredPage(true, fa);
  } catch (e) {
    console.log("lti register failed:", e instanceof LtiError ? e.code : "error");
    await undo(env.LTI_DB, rid);
    await env.LTI_DB.prepare("DELETE FROM codes WHERE code_hash = ? AND rid = ?").bind(hash, rid).run();
    if (!(e instanceof LtiError)) throw e;
    return registeredPage(false, fa);
  } finally {
    await reg.commit(lease);
  }
}
