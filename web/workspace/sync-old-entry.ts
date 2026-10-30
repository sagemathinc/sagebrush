// (the old-sync detector's test build (test-workspace-sync-old.mjs): the workspace, and the journal's and the bundle's
// own writers, so the cases' fixtures are written by the functions that write them)
export * from "./index";
// (no askMerge: exact-only removes it, and the cases don't need it (keepBundle writes the a row while it exists))
export { t1Write, syncedKey, JOURNAL_NS } from "../journal/rows.js";
export { SYNC_NB, FAMILIES, rowKey, seqKey, registryKey } from "../notebook/sync-rows.js";
export { keepBundle } from "../notebook/bundle.js";
export { openHistoryDb, openBoardHistoryDb } from "../notebook/stores.js";
