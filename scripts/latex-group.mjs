// The LaTeX editor's group and its absolute ceiling, shared by the site asset budget (scripts/site-asset-budget.mjs,
// its check 4, run where the builds are) and CI (scripts/test-latex-group-budget.mjs, in web-artifacts on the DEV
// build that job makes), so the one cap is measured the one way in both.
// The group: every dist/ file named sagebrush-latex* in a DEV build, except the lazy chunks (each fetched only on its
// own use, each with a line of its own in the budget). Its JS is measured raw and as the sum of each file's own gzip
// (Node's zlib, level 9).
import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";

export const LATEX_LAZY = {
  COMMENTS: "dist/sagebrush-latex-comments.js",
  COMMENTS_DOC: "dist/sagebrush-latex-comments-doc.js",
  AGENT: "dist/sagebrush-latex-agent.js",
  TOOLS: "dist/sagebrush-latex-tools.js",
  PRESENT: "dist/sagebrush-latex-present.js",
};
// (232 KiB / 78 KiB: William, 2026-11-03, "OK 232/78", for the open editor following a change made elsewhere (#599);
//  224 KiB / 76 KiB: @sagebrush's ruling of 2026-11-02, for the Beamer track (William: LaTeX and beamer the top
//  priority; the group is fetched only when a .tex is opened, so the first page load is unaffected): each PR reports
//  its delta, and what can be a lazy chunk of its own stays out of the group; was 192 / 64
//  (2026-10-29, the ten examples and the embeddable editor), 180 / 60 before)
export const LATEX_CAPS = { raw: 232 * 1024, gzip: 78 * 1024 };
export const gz = (b) => gzipSync(b, { level: 9 }).length;

/** The group of `files` (a DEV tree's files: its path under web/, as "dist/...", to the file on disk), measured. */
export function latexGroup(files) {
  const lazy = new Set(Object.values(LATEX_LAZY));
  const group = [...files.keys()].filter((n) => n.startsWith("dist/") && /(^|\/)sagebrush-latex/.test(n) && !lazy.has(n));
  const js = group.filter((n) => n.endsWith(".js")), css = group.filter((n) => n.endsWith(".css"));
  const raw = js.reduce((s, n) => s + statSync(files.get(n)).size, 0), gzip = js.reduce((s, n) => s + gz(readFileSync(files.get(n))), 0);
  return { group, js, css, raw, gzip, ok: js.length > 0 && raw <= LATEX_CAPS.raw && gzip <= LATEX_CAPS.gzip };
}
