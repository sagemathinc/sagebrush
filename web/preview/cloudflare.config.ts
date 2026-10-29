// cf deploy config: default-only entry, with the reviewed route and sole bucket binding.
import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./entry.mjs" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "sagebrush-preview",
    compatibilityDate: "2026-10-01",
    entrypoint,
    triggers: [{ type: "fetch", pattern: "*.sagebrush.cloud/*", zone: "sagebrush.cloud" }],
    workersDev: false,
    previewUrls: false,
    env: {
      PREVIEWS: bindings.r2({ name: "sagebrush-preview" }),
    },
  },
});
