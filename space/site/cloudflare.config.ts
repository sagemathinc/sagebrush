// https://space.sagebrush.cloud: the whitespace's rough alpha, the whole Sagebrush site with the space at /space/,
// served as static assets by a Worker (as sagebrush.space is: web/site/cloudflare.config.ts). Static files only: no
// bindings but the assets, no secrets. web/dist/_headers (COOP/COEP, each page's CSP) comes along in public/ and
// Cloudflare applies it. Build the files with space/build-alpha.sh, which copies web/dist into ./public; then
// `cf deploy` here.
import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "sagebrush-space-alpha",
    compatibilityDate: "2026-10-01",
    entrypoint,
    assets: { htmlHandling: "auto-trailing-slash", notFoundHandling: "404-page" },
    domains: ["space.sagebrush.cloud"],
    env: { ASSETS: bindings.assets() },
  },
});
