// The user-content domain: shared files by hash (web/share/files.ts), from
// the share API's R2 bucket, never from sagebrush.space itself.
// `--mode dev` serves the dev bucket on files.cocalcusercontent.dev, and
// sync's files there too: a device's signed URLs (/p/, web/sync/server.ts
// handleSyncFiles), from its own entry, src/dev.ts.  Production's entry
// doesn't import sync.
import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import * as devEntrypoint from "./src/dev.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: ({ mode }) => {
    const dev = mode === "dev";
    return {
      name: dev ? "sagebrush-files-dev" : "sagebrush-files",
      compatibilityDate: "2026-10-01",
      // (the dev entry is the production one with sync on: ./src/dev.ts)
      entrypoint: dev ? devEntrypoint : entrypoint,
      domains: [dev ? "files.cocalcusercontent.dev" : "files.cocalcusercontent.com"],
      env: {
        SHARE_BUCKET: bindings.r2({ name: dev ? "sagebrush-share-dev" : "sagebrush-share" }),
        // (which files each collection may serve)
        SHARE_DB: dev ? bindings.d1({ name: "sagebrush-share-dev", id: "94675861-6f72-4cbc-a419-b28647eb9e9e" }) : bindings.d1({ name: "sagebrush-share" }),
        ...(dev
          ? {
              // (the same key as the dev site's, which signs the URLs; per IP, 600 a minute, §9)
              SYNC_URL_KEY: bindings.secret(),
              SYNC_FILES_LIMIT: bindings.rateLimit({ namespace: "4103", simple: { limit: 600, period: 60 } }),
              // (the one origin allowed to read them from a page)
              SYNC_SITE_ORIGIN: bindings.text("https://dev.sagebrush.space"),
            }
          : {}),
      },
    };
  },
});
