// The notebook page as one file, for the measures that read it so (scripts/site-asset-budget.mjs, line 3's pages):
// web/build.ts writes the page's script as its own file, dist/sagebrush-app.js, named in dist/index.html by its
// content's hash (<script src="/sagebrush-app.js?h=…">), where the script used to be inline. Putting it back inline
// gives exactly the page as it was built before (the same <script>…</script> at the same place), so the measures, and
// their frozen baselines, read the same bytes.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

export const APP_TAG = /<script src="\/sagebrush-app\.js\?h=([0-9a-f]{16})"><\/script>/;

/** `html` (the page's bytes) with its script back inline, read from `dir`; a page with no such tag, as it is. The
 * script must be the one the tag names (its hash), or this refuses. */
export function inlinePage(html, dir) {
  const text = Buffer.isBuffer(html) ? html.toString("latin1") : html;
  const m = APP_TAG.exec(text);
  if (!m) return Buffer.isBuffer(html) ? html : Buffer.from(html, "latin1");
  if (text.split(APP_TAG).length !== 3) throw new Error("notebook-page: the page names its script more than once");
  const js = readFileSync(join(dir, "sagebrush-app.js"));
  if (createHash("sha256").update(js).digest("hex").slice(0, 16) !== m[1]) throw new Error("notebook-page: sagebrush-app.js is not the script the page names");
  return Buffer.concat([Buffer.from(text.slice(0, m.index), "latin1"), Buffer.from("<script>"), js, Buffer.from("</script>"), Buffer.from(text.slice(m.index + m[0].length), "latin1")]);
}

/** The page file at `file` as one file (its script beside it, in the same directory). */
export const readPage = (file) => inlinePage(readFileSync(file), dirname(file));
