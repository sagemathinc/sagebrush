// https://sagebrush.space: the browser demo (web/index.html + the pyjs
// worker bundle), served as static assets by a Worker.  Build the files
// with `bun web/build.ts`, which also copies them to web/site/public/.
import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "sagebrush-site",
    compatibilityDate: "2026-10-01",
    entrypoint,
    assets: { htmlHandling: "auto-trailing-slash", notFoundHandling: "404-page" },
    domains: ["sagebrush.space"],
    env: {
      ASSETS: bindings.assets(),
    },
  },
});
