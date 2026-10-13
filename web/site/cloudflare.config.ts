// https://sagebrush.space: the browser demo (web/index.html + the pyjs
// worker bundle), served as static assets by a Worker.  Build the files
// with `bun web/build.ts`, which also copies them to web/site/public/.
//
// `--mode dev` deploys the same site to https://dev.sagebrush.space with
// the share API on (web/share/server.ts): the dev R2 bucket and D1 database,
// shared files served by web/files on files.cocalcusercontent.dev.  The
// production site gets the share API once it is reviewed.
import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: ({ mode }) => {
    const dev = mode === "dev";
    return {
      name: dev ? "sagebrush-site-dev" : "sagebrush-site",
      compatibilityDate: "2026-10-01",
      entrypoint,
      assets: { htmlHandling: "auto-trailing-slash", notFoundHandling: "404-page" },
      domains: [dev ? "dev.sagebrush.space" : "sagebrush.space"],
      env: {
        ASSETS: bindings.assets(),
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
            }
          : {}),
      },
      triggers: dev ? [triggers.scheduled({ schedule: "17 3 * * *" })] : [],
    };
  },
});
