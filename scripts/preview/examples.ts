// The examples gallery in a preview, as production has it (William, Nov 12: a preview like production): its pages and
// catalog built into web/dist/examples/ (web/build-examples.ts, which the site's build runs for sagebrush.space), and
// their rule added to web/dist/_headers with the site's page policy (web/csp-policy.mts pagePolicy, which production
// gives /examples/), so the publisher finds exactly one policy for each of their pages. Run by scripts/preview/publish.mjs
// after web/build.ts, under the same build wrapper; it writes only under web/dist.
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildExamplesInto } from "../../web/build-examples";
import { pagePolicy } from "../../web/csp-policy.mts";

// (the output directory: web/dist, or the one given, for the preview test)
const dist = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
const urls = await buildExamplesInto(dist);
if (!urls.length) throw new Error("preview examples: the corpus gave no examples");
if (/^\/examples\//m.test(readFileSync(join(dist, "_headers"), "utf8"))) throw new Error("preview examples: _headers already has an /examples/ rule");
appendFileSync(join(dist, "_headers"), `# the examples gallery (scripts/preview/examples.ts): the site's page policy, as production gives it\n/examples/*\n  Content-Security-Policy: ${pagePolicy()}\n`);
console.log(`preview examples: ${urls.length} pages`);
