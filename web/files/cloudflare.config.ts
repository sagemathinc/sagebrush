// The user-content domain: shared files by hash (web/share/files.ts), from
// the share API's R2 bucket, never from sagebrush.space itself.
// `--mode dev` serves the dev bucket on files.cocalcusercontent.dev.
import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: ({ mode }) => {
    const dev = mode === "dev";
    return {
      name: dev ? "sagebrush-files-dev" : "sagebrush-files",
      compatibilityDate: "2026-10-01",
      entrypoint,
      domains: [dev ? "files.cocalcusercontent.dev" : "files.cocalcusercontent.com"],
      env: { SHARE_BUCKET: bindings.r2({ name: dev ? "sagebrush-share-dev" : "sagebrush-share" }) },
    };
  },
});
