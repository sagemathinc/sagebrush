// The bindings the sync service runs with (design/sync-server.md §11).
// They exist only on the dev site; without them every /api/sync/ route
// answers 404, so these bindings are the flag.

import type { D1 } from "../share/server.ts";
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
  /** comma-separated account ids that may sync; unset means nobody (§11) */
  SYNC_ACCOUNTS?: string;
  /** signs blob URLs (§5.4); tickets are nonces, signed by nothing */
  SYNC_URL_KEY?: string;
  COCALC_ORIGIN?: string;
  COCALC_CLIENT_SECRET?: string;
  SHARE_DEV?: string;
}

/** Whether `account` may sync here (§11): only those listed. */
export function allowed(env: SyncEnv, account: string): boolean {
  return (env.SYNC_ACCOUNTS ?? "").split(",").map((s) => s.trim()).filter(Boolean).includes(account);
}
