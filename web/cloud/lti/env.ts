// The LTI Worker's bindings (plan-lti-r5 §2.1, §11.3).  Dev and prod each get
// their own Worker, D1s, objects and keys; nothing is shared.

import type { D1 } from "./db.ts";
import type { LtiReg } from "./reg.ts";
import type { LtiLaunchShard } from "./shard.ts";
import type { LtiCourse } from "./course.ts";
import type { LtiContentGate } from "./gate.ts";
import type { EnvName } from "./policy.ts";

export interface RateLimit { limit(o: { key: string }): Promise<{ success: boolean }> }

export interface Env {
  /** prod | dev | vm-test; anything else turns every route off */
  ENV?: string;
  /** this tool's origin, e.g. https://lti.dev.sagebrush.space */
  LTI_ORIGIN?: string;
  LTI_DB?: D1;
  LTI_AUDIT?: D1;
  LTI_REG?: DurableObjectNamespace<LtiReg>;
  LTI_SHARD?: DurableObjectNamespace<LtiLaunchShard>;
  LTI_COURSE?: DurableObjectNamespace<LtiCourse>;
  /** amendment 3 r15 §2: assignments, revisions, bundles and pins, in a D1 of their own */
  LTI_CONTENT?: D1;
  /** amendment 3 r15 §2.5: the one writer of LtiContent's fenced tables */
  LTI_GATE?: DurableObjectNamespace<LtiContentGate>;
  /** amendment 3 r15 §2.1: the LTI-owned bundle copies, o/<owner digest>/<sha256>/<token> */
  LTI_BUNDLES?: R2Bucket;
  /** the environment's outbound ceiling (§15.4) */
  LTI_FLEET?: DurableObjectNamespace<{ reserve(): boolean }>;
  /** per-IP, before anything else (§15.2): 60 a minute on /lti/* */
  LTI_PREAUTH?: RateLimit;
  /** HMAC with cocalc.ai (§7.3, §17.1) */
  LTI_KEY?: string;
  /** the tool's private signing key, a JWK with its kid (TOOL_KEY, r5 §2.1): deep-link responses, client assertions */
  TOOL_KEY?: string;
  /** the tool's public signing keys, a JWKS (TOOL_KEY's public half; the private half signs from stage B) */
  TOOL_JWKS?: string;
  /** cocalc.ai, for its purge calls (amendment 1 r6 §4.1) */
  COCALC_ORIGIN?: string;
  /** seals the erase journal and the mapping exports (amendment 1 r6 §2.4) */
  MAPPING_BACKUP_KEY?: string;
  /** vm-test only: the synthetic entitlement stub (§13, stage D note) */
  LTI_SYNTHETIC_ENTITLEMENT?: string;
}

export function envName(env: Env): EnvName | null {
  return env.ENV === "prod" || env.ENV === "dev" || env.ENV === "vm-test" ? env.ENV : null;
}

/** All bindings present, or the tool is off (404): the bindings are the flag. */
export function ready(env: Env): env is Required<Pick<Env, "LTI_ORIGIN" | "LTI_DB" | "LTI_AUDIT" | "LTI_REG" | "LTI_SHARD" | "LTI_COURSE" | "LTI_PREAUTH" | "LTI_KEY">> & Env {
  return !!(envName(env) && env.LTI_ORIGIN && env.LTI_DB && env.LTI_AUDIT && env.LTI_REG && env.LTI_SHARD && env.LTI_COURSE && env.LTI_PREAUTH && env.LTI_KEY);
}

/** The stub is honored only in vm-test (§13): production keeps the no-storage-before-entitlement gate. */
export function syntheticEntitlement(env: Env): boolean {
  return env.ENV === "vm-test" && env.LTI_SYNTHETIC_ENTITLEMENT === "1";
}
