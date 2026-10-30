// The workspace (design/workspace-files.md): its index and verbs (api.ts),
// paths (paths.ts), and bringing in what this browser keeps today
// (migrate.ts).
export { Workspace, WorkspaceError, registerJournalWriter, JOURNAL_KINDS, OutOfScope, type AdmitCheck, RESET_HOOK, JOURNAL_HOOK, FENCE_COUNTERS, RESET_PAGE, RESET_BYTES_PAGE, RESET_PAGE_BYTES, LOCAL_PAGE, type Identity, LIMITS, PRUNE_STEP, DROP_PAGE, BYTES_STEP, LEGACY_MAX, COPIES, nkeyOf, BOARD_KEYS, askToKeep, type Entry, type Op, type OpAfter, type OldBytes, identOf, needsHash, type Version, type BoardRecord, type Limits, STALE_FAILS_CAP, type StaleWhy, type StaleStuck } from "./api";
export { migrate, reconcile, adoptOld, signature, RECOVERED, EDITED_FOLDER, type KeyValue, type MigrateReport } from "./migrate";
export { normPath, kindOf, safeName, freePath, splitExt, parentOf, nameOf, join, within, TRASH, PathError, type Kind } from "./paths";
export { WS_DB, WS_VERSION, openWorkspaceDb, type JournalState } from "./db";
export { startMigrator, onMigration, migrationState, MIGRATE, STALE_NOTICE, STUCK_PATHS, STUCK_CHARS, type MigrationState } from "./migrator";
export { showReloadNotice, showLossNotice, showBusyNotice, hideBusyNotice, showStaleNotice, showHistoryNotice, staleText, STALE_DISMISSED } from "./notice";
export { decide, best, newer, resolveReset, readLocal, readOpfs, writeLocal, writeOpfs, placeOf, isWitness, LOCAL_KEY, type Witness, type State, type Held, type Read } from "./witness";
export { reserve, reserved, RESERVE_BYTES } from "./reserve";
// (the notebooks' store and its save gate, which the page closes while the workspace is quarantined: for tests)
export { IdbStore, IdbPatchStore, openHistoryDb, openBoardHistoryDb, setSaveGate, ownedByWorkspace, LOCK_WAIT, HISTORY_BACKLOG, JOURNAL_TX_HOOK, historyBacklog, onHistoryRefused } from "../notebook/stores.js";
export { Outbox, OUTBOX, Fenced, switchTo, currentLease, sender, wireOf, recordBytes, chargeOf, type Lease, type OutboxRecord, type WireOp } from "./sync-outbox";
export { PINS, RELEASE_COST, VDUE, VOVER, BACKFILL, GONE, syncOff, cleanPins, scheduleClean, bytesFor, capNow, pinTotal, liveLease, epochOf, newEpoch, metaWrite, type Pin, type Pending, type NsState, type Skipped } from "./sync-pins";
export { SyncClient, CLIENT, realClock, type Clock, type SyncStatus, type IndexOp, type IndexPage, type Refusal, type ClientOptions, type Work } from "./sync-client";
export { applyOps, applyConfirmed, confirmedIndex, cursorOf, confirmedEntry, genPrefix, genKey, cursorKey, idbStore } from "./sync-confirmed";
export { applyView, VIEW_STORES, listedSummary, type ListedWhy, type JournalRecord } from "./sync-view";
export { REBUILD, passOf, obligationOf, cleanKey, journalKey, floorKey, journalPrefix, cleanStep, stage, stageEchoes, logDone, captureStep, done as rebuildDone, viewStep, retireStep, acked as rebuiltAcked, type Pass } from "./sync-rebuild";
export { obligate, rebuildKey, type Obligation } from "./sync-outbox";
export { ADOPT, adoptPrefix, capture as captureAdoption } from "./sync-adopt";
// (D11: large moves in chunks, for tests)
export { D11, D11_CEILING, configureD11, RW, MAPS, STAGE, FENCE_READ, entriesOf, rewriting, MapSet, type ERecord, type Mapping } from "./sync-rewrite";
export { REPLAY, PLAN_STATE, runReplay, replayOf, markerKey, lateKey, SENDER_HOLD, ReplayHalted, type Marker } from "./sync-replay";
export { crecordKey, setConfirmedCut, drainConfirmed, LARGE_LOG, type CRecord } from "./sync-confirmed";
export { reduceAll, SyncIndex } from "./sync-reduce";
export { SyncOwner, startSync, STATUS_PUB, OWNER, statusMessage, type Snapshot, type StatusMsg } from "./sync-owner";
export { readLife, syncOffIf, sameLife, type LifeMark } from "./sync-pins";
export { switchToIf } from "./sync-outbox";
export { detectOldSync, classificationProblems, OLD_SYNC_HOOK, OldSyncError, OLD_SYNC_MESSAGE, OLD_SYNC_REASON, PROTO, PROTO_KEY, SIGNAL_FAMILIES, LOCAL_FAMILIES, RETIRED_FAMILIES, SIGNAL_META, LOCAL_META, SYNC_ONLY_STORES, HISTORY_DBS, type OldSync } from "./sync-old";
export { syncSection, PanelPoll, PANEL, clampDelay, askStatus, foot, sidebarLine, readNotebooks, unseenRefusals, raiseSeen, type Notebooks } from "./sync-panel";
export { fileRowMeta, isElsewhere, type ContentHere } from "./row-meta";
export { mountBrowser } from "./browser";
export { renewLease } from "./sync-outbox";
export { rowIcons, ROWICON } from "./sync-rows";
export { LEDGER, WAIT, STATE, CODE, HUB, OBSOLETE, OBSOLETE_KEY, hubOf, waitCount, noteSkip, queueObsolete, cleanObsoleteStep, seedLedger, ledgerKeys, classOf as ledgerClass, isWire, type SyncAnswer, type WaitResult } from "./sync-ledger";
// (sync 2c-3: notebooks' contents on the account connection, and DEV's switch for them)
export { DocSync } from "./doc-sync";
// (the notebook page: whether this device has a notebook's synced history yet, before opening one that arrived by sync)
export { readJournal } from "../notebook/journal-rows.js";
export { DOC_SYNC_ORIGINS, DOC_SYNC_NOTE, docSyncOrigin, docSyncAllowed, enableDocSync, followDocSync, docSyncChannel, DOC_SYNC_RELOAD } from "./doc-sync-switch";
