// The bindings the sync service runs with (design/sync-server.md §11).
// They exist only on the dev site; without them every /api/sync/ route
// answers 404, so these bindings are the flag.

import type { D1, R2 } from "../share/server.ts";
import type { SyncAccount } from "./account.ts";
import type { SyncDoc } from "./doc.ts";

export interface Namespace<T> {
  idFromName(name: string): unknown;
  get(id: unknown): T;
}
export interface SyncEnv {
  SYNC_ACCOUNT?: Namespace<SyncAccount>;
  SYNC_DOC?: Namespace<SyncDoc>;
  /** sharing's D1: sessions and accounts (sync reads them; it writes only sync_accounts) */
  SHARE_DB?: D1;
  /** sharing's bucket: synced blobs are under s/<account hash>/ (§1) */
  SHARE_BUCKET?: R2;
  /** where signed reads go, the FILES_ORIGIN binding from web/content-domains.mts (§5.4) */
  FILES_ORIGIN?: string;
  /**
   * Test seams, bound only in web/sync/test-sync.mjs: a shorter pin
   * lifetime (ms), and a document id whose batches commit and then lose
   * their answer (§4.3).  Never set in a deployment's config.
   */
  SYNC_TEST_PIN_MS?: string;
  /** the fence overflow's skew margin, ms (LIMIT-PR13-1): an admin-configurable default of 5 s */
  SYNC_FENCE_SKEW_MS?: string;
  SYNC_TEST_LOSE?: string;
  /** comma-separated account ids that may sync; unset means nobody (§11) */
  SYNC_ACCOUNTS?: string;
  /** "all": every signed-in account may sync, each governed by its plan (sync for every CoCalc account, free ones
   * included); anything else, or unset, admits only the lists.  One variable, so closing admission again is
   * unbinding it */
  SYNC_ADMIT?: string;
  /** DEV only, a text binding in the reviewed config: comma-separated synthetic account ids that may sync too (the
   * DEV end-to-end check's accounts); never bound in production, and unset means none */
  SYNC_TEST_ACCOUNTS?: string;
  /** signs blob URLs (§5.4); tickets are nonces, signed by nothing */
  SYNC_URL_KEY?: string;
  /** design/tiered-files.md step 3 (chunked files): "1" turns it on, and only where SHARE_DEV is "1" (DEV); unset, off */
  SYNC_TIERED?: string;
  /** design/agent-endpoint.md (fs-sync step 1a): "1" turns on agents' grants and /api/agent/v1/, and only where
   * SHARE_DEV is "1" (DEV) and GRANT_TAG_KEY is bound; unset, off */
  SYNC_AGENT?: string;
  /** the key of a grant token's tag (design/agent-endpoint.md §2): a secret, set by the operator; without it agents are off */
  GRANT_TAG_KEY?: string;
  COCALC_ORIGIN?: string;
  COCALC_CLIENT_SECRET?: string;
  SHARE_DEV?: string;
}

/**
 * Whether the test seams are on: only in the Worker built from web/sync/test-entry.ts, which sets
 * this flag when it loads, and only with SYNC_TEST_PIN_MS bound.  No deployed entry sets the flag,
 * so no binding alone can turn a seam on in production: a code guarantee, not one of config.
 */
export function testMode(env: SyncEnv): boolean {
  return (globalThis as { __SAGEBRUSH_SYNC_TEST__?: boolean }).__SAGEBRUSH_SYNC_TEST__ === true && !!env.SYNC_TEST_PIN_MS;
}

/**
 * Tests only: named gates in the Worker, which hold a step (a D1 write) until
 * the test opens them, as a D1 answer that arrives late would.  The held
 * request polls on its own timers (workerd refuses a promise resolved from
 * another request).  Off outside test mode: `gate` then returns at once.
 */
const gates = new Set<string>();
export async function gate(env: SyncEnv, name: string): Promise<void> {
  if (!testMode(env)) return;
  for (let i = 0; gates.has(name) && i < 1500; i++) await new Promise((r) => setTimeout(r, 20));
}
/** Tests only: whether a named gate is set (off outside test mode). */
export function gateOn(env: SyncEnv, name: string): boolean {
  return testMode(env) && gates.has(name);
}
export function setGate(env: SyncEnv, name: string, on: boolean): void {
  if (!testMode(env)) return;
  if (on) gates.add(name);
  else gates.delete(name);
}

/** Whether chunked files are on (design/tiered-files.md §7, PR 2): SYNC_TIERED "1" on DEV only (SHARE_DEV "1"), so a
 * stray binding in production turns nothing on: the code's gate, as allowed()'s test list is. */
export function tieredOn(env: SyncEnv): boolean {
  return env.SYNC_TIERED === "1" && env.SHARE_DEV === "1";
}

/** Whether agents' grants and requests are on (design/agent-endpoint.md, fs-sync step 1a): SYNC_AGENT "1" on DEV only
 * (SHARE_DEV "1"), with a tag key bound, so a stray binding in production turns nothing on. */
export function agentOn(env: SyncEnv): boolean {
  return env.SYNC_AGENT === "1" && env.SHARE_DEV === "1" && !!env.GRANT_TAG_KEY;
}

/** Whether `account` may sync here (§11): every signed-in account when SYNC_ADMIT is exactly "all" (its plan governs
 * the rest: sync on or off, storage, files, reads); else only those listed, in SYNC_ACCOUNTS or, on DEV only (SHARE_DEV
 * 1), SYNC_TEST_ACCOUNTS: production binds neither SHARE_DEV nor the test list, and even a stray test list there
 * admits nobody (the code's gate, not the config's alone).  Checked where it
 * always was: registration, status, enable, the socket's upgrade and every message on it (sessionLive), batches and
 * uploads. */
export function allowed(env: SyncEnv, account: string): boolean {
  if (env.SYNC_ADMIT === "all" && typeof account === "string" && account !== "") return true;
  const listed = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean).includes(account);
  return listed(env.SYNC_ACCOUNTS) || (env.SHARE_DEV === "1" && listed(env.SYNC_TEST_ACCOUNTS));
}
