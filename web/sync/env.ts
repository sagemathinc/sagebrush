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
  /** where signed reads go, e.g. https://files.cocalcusercontent.dev (§5.4) */
  FILES_ORIGIN?: string;
  /**
   * Test seams, bound only in web/sync/test-sync.mjs: a shorter pin
   * lifetime (ms), and a document id whose batches commit and then lose
   * their answer (§4.3).  Never set in a deployment's config.
   */
  SYNC_TEST_PIN_MS?: string;
  SYNC_TEST_LOSE?: string;
  /** comma-separated account ids that may sync; unset means nobody (§11) */
  SYNC_ACCOUNTS?: string;
  /** signs blob URLs (§5.4); tickets are nonces, signed by nothing */
  SYNC_URL_KEY?: string;
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

/** Whether `account` may sync here (§11): only those listed. */
export function allowed(env: SyncEnv, account: string): boolean {
  return (env.SYNC_ACCOUNTS ?? "").split(",").map((s) => s.trim()).filter(Boolean).includes(account);
}
