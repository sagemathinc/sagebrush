// Whether web/build.ts writes the Cloudflare site's files (web/site/public,
// web/site/src/build-id.ts, and the articles of web/build-articles.ts).  The
// site moves to sagemathinc/sagebrush-cloud (plan-cloud-split-r1), which
// overlays web/site/ on a core checkout before building; without it, those
// outputs are skipped and web/dist/ is the build's whole output.
// SAGEBRUSH_NO_SITE=1 builds as if web/site/ weren't here (CI's no-site build).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const siteDir = join(here, "site");
export const hasSite = process.env.SAGEBRUSH_NO_SITE !== "1" && existsSync(siteDir);
