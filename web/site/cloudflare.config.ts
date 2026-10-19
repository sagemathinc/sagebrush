// https://sagebrush.space: the browser demo (web/index.html + the pyjs
// worker bundle), served as static assets by a Worker.  Build the files
// with `bun web/build.ts`, which also copies them to web/site/public/.
//
// `--mode dev` deploys the same site to https://dev.sagebrush.space with
// the share API on (web/share/server.ts): the dev R2 bucket and D1 database,
// shared files served by web/files on files.cocalcusercontent.dev.  The
// production site gets the share API once it is reviewed.
//
// The dev site also has sync (web/sync, design/sync-server.md): its two
// object classes (SQLite storage), their bindings and limits, for the
// accounts in SYNC_ACCOUNTS only (a secret: comma-separated CoCalc account
// ids; unset or empty, nobody), from its own entry, src/dev.ts.  Production
// has none of it: its entry neither routes sync nor exports the classes.
import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import * as devEntrypoint from "./src/dev.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: ({ mode }) => {
    const dev = mode === "dev";
    return {
      name: dev ? "sagebrush-site-dev" : "sagebrush-site",
      compatibilityDate: "2026-10-01",
      // (the dev entry is the production one with sync on: ./src/dev.ts)
      entrypoint: dev ? devEntrypoint : entrypoint,
      assets: { htmlHandling: "auto-trailing-slash", notFoundHandling: "404-page" },
      domains: [dev ? "dev.sagebrush.space" : "sagebrush.space"],
      env: {
        ASSETS: bindings.assets(),
        // engines by their content, kept forever (web/engines.ts, scripts/publish-engine.mjs)
        ENGINES: bindings.r2({ name: "sagebrush-releases" }),
        ...(dev
          ? {
              SHARE_DB: bindings.d1({ name: "sagebrush-share-dev", id: "94675861-6f72-4cbc-a419-b28647eb9e9e" }),
              SHARE_BUCKET: bindings.r2({ name: "sagebrush-share-dev" }),
              FILES_ORIGIN: bindings.text("https://files.cocalcusercontent.dev"),
              // (lite4b: the dev CoCalc, its seed bay, with this site registered as a client)
              COCALC_ORIGIN: bindings.text("https://lite4b.cocalc.ai"),
              SHARE_DEV: bindings.text("1"),
              COCALC_CLIENT_SECRET: bindings.secret(),
              SESSION_KEY: bindings.secret(),
              PURGE_KEY: bindings.secret(),
              DEV_AUTH_TOKEN: bindings.secret(),
              // sync (design/sync-server.md §2, §3, §9, §11)
              SYNC_ACCOUNT: bindings.durableObject({ worker: "sagebrush-site-dev", exportName: "SyncAccount" }),
              SYNC_DOC: bindings.durableObject({ worker: "sagebrush-site-dev", exportName: "SyncDoc" }),
              // (per IP: before authentication, 60 a minute (§2); CoCalc's admin calls, 120 a minute)
              SYNC_PREAUTH: bindings.rateLimit({ namespace: "4101", simple: { limit: 60, period: 60 } }),
              SYNC_ADMIN_LIMIT: bindings.rateLimit({ namespace: "4102", simple: { limit: 120, period: 60 } }),
              // (a device's file URLs are signed here and served by web/files, under FILES_ORIGIN)
              SYNC_ACCOUNTS: bindings.secret(),
              SYNC_URL_KEY: bindings.secret(),
              LIMITS_KEY: bindings.secret(),
            }
          : {}),
      },
      ...(dev ? { exports: { SyncAccount: exports.durableObject({ storage: "sqlite" }), SyncDoc: exports.durableObject({ storage: "sqlite" }) } } : {}),
      triggers: dev ? [triggers.scheduled({ schedule: "17 3 * * *" })] : [],
    };
  },
});
