// The workspace (design/workspace-files.md): its index and verbs (api.ts),
// paths (paths.ts), and bringing in what this browser keeps today
// (migrate.ts).
export { Workspace, WorkspaceError, RESET_HOOK, RESET_PAGE, RESET_BYTES_PAGE, RESET_PAGE_BYTES, LOCAL_PAGE, type Identity, LIMITS, PRUNE_STEP, DROP_PAGE, BYTES_STEP, LEGACY_MAX, COPIES, nkeyOf, BOARD_KEYS, askToKeep, type Entry, type Op, type OpAfter, type OldBytes, identOf, needsHash, type Version, type BoardRecord, type Limits, STALE_FAILS_CAP, type StaleWhy, type StaleStuck } from "./api";
export { migrate, reconcile, adoptOld, signature, RECOVERED, EDITED_FOLDER, type KeyValue, type MigrateReport } from "./migrate";
export { normPath, kindOf, safeName, freePath, splitExt, parentOf, nameOf, join, within, TRASH, PathError, type Kind } from "./paths";
export { WS_DB, WS_VERSION, openWorkspaceDb } from "./db";
export { startMigrator, onMigration, migrationState, MIGRATE, STALE_NOTICE, STUCK_PATHS, STUCK_CHARS, type MigrationState } from "./migrator";
export { showReloadNotice, showLossNotice, showBusyNotice, hideBusyNotice, showStaleNotice, staleText, STALE_DISMISSED } from "./notice";
export { decide, best, newer, resolveReset, readLocal, readOpfs, writeLocal, writeOpfs, placeOf, isWitness, LOCAL_KEY, type Witness, type State, type Held, type Read } from "./witness";
export { reserve, reserved, RESERVE_BYTES } from "./reserve";
// (the notebooks' store and its save gate, which the page closes while the workspace is quarantined: for tests)
export { IdbStore, IdbPatchStore, openHistoryDb, openBoardHistoryDb, setSaveGate, ownedByWorkspace, LOCK_WAIT, HISTORY_BACKLOG, historyBacklog, onHistoryRefused } from "../notebook/stores.js";
export { Outbox, OUTBOX, Fenced, switchTo, currentLease, sender, wireOf, recordBytes, chargeOf, type Lease, type OutboxRecord, type WireOp } from "./sync-outbox";
export { PINS, RELEASE_COST, VDUE, VOVER, BACKFILL, GONE, syncOff, cleanPins, scheduleClean, bytesFor, capNow, pinTotal, liveLease, epochOf, newEpoch, metaWrite, type Pin, type Pending, type NsState, type Skipped } from "./sync-pins";
export { SyncClient, CLIENT, realClock, type Clock, type SyncStatus, type IndexOp, type IndexPage, type Refusal, type ClientOptions, type Work } from "./sync-client";
export { applyOps, applyConfirmed, confirmedIndex, cursorOf, confirmedEntry, genPrefix, genKey, cursorKey, idbStore } from "./sync-confirmed";
export { applyView, fetchKey, VIEW_STORES, type ListedWhy, type JournalRecord } from "./sync-view";
