// The disk mirror's test bundle (web/workspace/test-disk-mirror.mjs): the workspace and the mirror.
export { Workspace, TRASH } from "./index";
export { importDisk, DiskMirror, fileBytes, toDisk, fromDisk, sha256Hex, CONFLICT, reconcileDisk, keepAll, stateSaver, diskWorkspace, idbState, diskBanner, drainOnQuit, beforeLeave, type Disk, type DiskStat } from "./disk-mirror";
export { notebookFileText, boardFileText } from "./file-bytes";
export { emptyTrashQuestion } from "./browser";
