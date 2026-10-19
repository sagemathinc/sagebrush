// The workspace (design/workspace-files.md): its index and verbs (api.ts),
// paths (paths.ts), and bringing in what this browser keeps today
// (migrate.ts).
export { Workspace, WorkspaceError, LIMITS, type Entry, type Op, type Version, type BoardRecord, type Limits } from "./api";
export { migrate, reconcile, signature, RECOVERED, EDITED_FOLDER, type KeyValue, type MigrateReport } from "./migrate";
export { normPath, kindOf, safeName, freePath, splitExt, parentOf, nameOf, join, within, TRASH, PathError, type Kind } from "./paths";
export { WS_DB, openWorkspaceDb } from "./db";
