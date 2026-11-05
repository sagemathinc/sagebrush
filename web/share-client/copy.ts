// The reader's own files, for a shared collection's page (view.ts, book links B1): the workspace, in a chunk of its own
// (/sagebrush-share-copy.js), fetched only when the reader's first edit makes a copy, or a copy is there to open. The
// page itself stays as small as before for a reader who only reads and runs.
import { Workspace } from "../workspace/api";
export const openWorkspace = () => Workspace.open();
