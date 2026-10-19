// The dev files Worker's entry (files.cocalcusercontent.dev, `--mode dev`):
// a device's signed URLs for synced files (/p/, web/sync/server.ts
// handleSyncFiles) first, then the production entry (./index.ts), which
// doesn't import sync.
import { env } from "cloudflare:workers";
import { handleSyncFiles, type Env as SyncFilesEnv } from "../../sync/server.ts";
import files from "./index.ts";

export default {
  async fetch(request, e, ctx) {
    return (await handleSyncFiles(request, env as unknown as SyncFilesEnv)) ?? files.fetch!(request, e, ctx);
  },
} satisfies ExportedHandler;
