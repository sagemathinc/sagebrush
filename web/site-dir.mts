// Where web/build.ts and web/build-articles.ts put the Cloudflare site's
// files: web/site/ when it is here.  The site moves to sagebrush-cloud
// (design: plan-cloud-split-r1), which overlays web/site/ on a core checkout
// before building; without it, those files go to a scratch directory and only
// web/dist/ is the build's output.
import { existsSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const hasSite = existsSync(join(here, "site"));
export const siteDir = hasSite ? join(here, "site") : mkdtempSync(join(tmpdir(), "sagebrush-no-site-"));
