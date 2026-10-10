// The app's web page: the notebook's files from web/dist (bun web/build.ts),
// without the Atlas, the demos or the service worker (the app's files are
// local already).
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const src = join(here, "..", "web", "dist");
const out = join(here, "dist");
if (!existsSync(join(src, "index.html"))) throw new Error("no web/dist: run `bun web/build.ts` first");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ["index.html", "sagebrush-worker.js", "sagebrush-engine.wasm", "sagebrush-console.js", "sagebrush-math.js", "sagebrush-viewer3d.js", "sagebrush-history.js", "docs-index.json", "THIRD-PARTY-NOTICES.txt", "katex", "icons"])
  cpSync(join(src, f), join(out, f), { recursive: true });
// the app's native code's notices (scripts/third-party-notices.mjs), beside the page's
cpSync(join(here, "THIRD-PARTY-NOTICES-native.txt"), join(out, "THIRD-PARTY-NOTICES-native.txt"));
console.log("app/dist: the notebook page for the app");
