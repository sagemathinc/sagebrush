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
  DOC: "dist/sagebrush-latex-doc.js",
  EXAMPLES: "dist/sagebrush-latex-examples.js",
  BEAMER: "dist/sagebrush-latex-beamer.js",
  RUN: "dist/sagebrush-latex-run.js",
  INTERACT: "dist/sagebrush-latex-interact.js",
};
// (232 KiB / 78 KiB: William, 2026-11-03, "OK 232/78", for the open editor following a change made elsewhere (#599);
//  224 KiB / 76 KiB: @sagebrush's ruling of 2026-11-02, for the Beamer track (William: LaTeX and beamer the top
//  priority; the group is fetched only when a .tex is opened, so the first page load is unaffected): each PR reports
//  its delta, and what can be a lazy chunk of its own stays out of the group; was 192 / 64
//  (2026-10-29, the ten examples and the embeddable editor), 180 / 60 before)
// (235 KiB / 79.5 KiB: @sagebrush's ruling with daybreak2's raw number, Nov 4, under William's of 1:47 PM PST ("raise
//  limits to support functionality... under control, justified, and iterative"), for the LaTeX fidelity queue: #641
//  (beamer's early fetch), #644 (beamer's furniture), and astra4's silent gaps, saved boxes, counters and references
//  (cleveref's formatting kept here, as current papers use it): about 239.3K / 80,623 after all five, about 1.3K / 785 B
//  left. The next time the group nears its cap, the answer is a lazy split, not another raise)
export const LATEX_CAPS = { raw: 235 * 1024, gzip: 79.5 * 1024 };
export const gz = (b) => gzipSync(b, { level: 9 }).length;

// Each lazy chunk's own cap (raw, gzip), fetched only on its own use, so outside the group:
export const LATEX_LAZY_CAPS = {
  // (@sagebrush, 2026-10-29: comments in a lazy chunk of their own, so a document without comments never pays for them)
  COMMENTS: { label: "the LaTeX comments' chunk", raw: 16 * 1024, gzip: 6 * 1024 },
  // (a document's live comments: comments-doc.ts and the format's core, comments-core.mjs, fetched only when a .tex has
  //  a comments file or someone comments in it. 16 KiB gzip, was 14: @sagebrush's ruling, Oct 31, for the shared pass
  //  in the comments' core, measured 35,707 / 14,289 at master 7ff6d103 -> 39,564 / 15,774 at its head; it holds only
  //  with the pass's measured benefit on VM3)
  COMMENTS_DOC: { label: "the LaTeX document comments' chunk", raw: 40 * 1024, gzip: 16 * 1024 },
  // (the agent pairing: web/workspace/agent-ui.ts, the shared module, through web/latex/agent.ts, fetched only to connect
  //  an agent (the Agent button, a ?pair= link, a remembered one). 44 KiB / 15.5 KiB: @sagebrush ruling 2026-11-04: A12 +
  //  A14 pairing growth (30.3K -> 43.6K); split notebook-edit and reload/restore behind options with the git-proto
  //  pairing work, then return to 40/14)
  AGENT: { label: "the LaTeX agent pairing's chunk", raw: 44 * 1024, gzip: 15.5 * 1024 },
  // (the agent tools' work: web/latex/tools.ts, latex_check's report and latex_render's pictures, on an agent's first call)
  TOOLS: { label: "the LaTeX agent tools' chunk", raw: 16 * 1024, gzip: 6 * 1024 },
  // (the presenter: web/latex/present.ts with overlay.ts, fetched only when Present is pressed)
  PRESENT: { label: "the LaTeX presenter's chunk", raw: 16 * 1024, gzip: 6 * 1024 },
  // (a published document opened read only, doc.ts: fetched only for a /?tex-doc= link, the articles'; @sagebrush,
  //  2026-11-05: 3.5 / 1.75 KiB, about 340 / 165 B over its first build's 3,246 / 1,627, as the beamer chunk's margin)
  DOC: { label: "the LaTeX read-only document's chunk", raw: 3.5 * 1024, gzip: 1.75 * 1024 },
  // (the ten examples, examples.ts: fetched when their list opens, out of the group (@sagebrush, 2026-11-05, the group near
  //  its cap: a lazy split, not another raise); its cap approved by daybreak2, Nov 5)
  EXAMPLES: { label: "the LaTeX examples' chunk", raw: 13 * 1024, gzip: 6 * 1024 },
  // (beamer's frames, blocks and overlays: engine/beamer.mjs, the worker's, fetched when a document first needs it (the
  //  class beamer, or an overlay command). @sagebrush, 2026-11-04: make room for beamer's page furniture by moving
  //  beamer's code out of the group, its own cap line; 8 KiB / 3 KiB: 3,161 / 1,426 moved, and the furniture to come.
  //  8 KiB / 3.5 KiB: @sagebrush's ruling with daybreak2's number, Nov 4, #644 r2: the furniture (6,107 / 2,681) plus
  //  the review-required fixes FURN644-SAGE-1, FURN644-FRAME-NO-1 and BEAMER644-FURN-1 (7,566 / 3,312), about 7.6% room
  //  on each; lazy: no growth for other documents)
  BEAMER: { label: "the LaTeX beamer chunk", raw: 8 * 1024, gzip: 3.5 * 1024 },
  // (Run's code: web/latex/run-core.mjs, fetched on the first Run (first-use code: the editor opens without it). Out of
  //  the group so save-as-you-type (#551, eager by nature) fits under the group's cap without a raise (daybreak2, Nov 7:
  //  a lazy split, not a raise). 12 KiB / 5.25 KiB: daybreak2's ruling, Nov 7, on 11,330 / 4,804 measured at master
  //  59d5ec95, about 8% / 12% room. 15.5 KiB / 6.5 KiB: daybreak2's ruling, Nov 7, for #804 (W01's record of what a
  //  Run imported, its own Run growth): 14,552 / 6,066 measured at #804's head 9759eac5 (master fd24862b merged),
  //  +1,320 / +590, about 9.1% / 9.7% room)
  //  17 KiB / 7 KiB: daybreak2's SIZE design for the Beamer plan's PR 3 (Nov 8), the session script's @interact capture
  //  (its check in the interact chunk, not here): 16,802 / 6,705 measured on #874's head 30efd744, +2,250 / +613
  RUN: { label: "the LaTeX Run chunk", raw: 17 * 1024, gzip: 7 * 1024 },
  // (@interact, a Sagebrush extension (William, Nov 8): interact.ts, a Run's interacts checked and the preview's drawn,
  //  fetched only once a Run or a preview has one; a lazy split for the Beamer plan's PR 3 (daybreak2, Nov 8: the eager
  //  group near its cap); 5 KiB / 2.5 KiB: the measured 4,555 / 2,080 with modest room, as daybreak2's design asks (PR 4
  //  and 5's live widgets justify their own measured change). 9 KiB / 3.75 KiB: PR 4's live widgets (a change runs the
  //  function again in the Run's session), 8,413 / 3,332 measured, as daybreak2's SIZE ruling approved
  INTERACT: { label: "the LaTeX interact chunk", raw: 9 * 1024, gzip: 3.75 * 1024 },
};

/** Each lazy chunk of `files`, measured against its own cap; one not in this tree: present false (and not ok). */
export function latexLazy(files) {
  return Object.entries(LATEX_LAZY_CAPS).map(([key, cap]) => {
    const name = LATEX_LAZY[key], p = files.get(name);
    if (!p) return { key, name, label: cap.label, cap, present: false, ok: false };
    const b = readFileSync(p), raw = b.length, gzip = gz(b);
    return { key, name, label: cap.label, cap, present: true, raw, gzip, ok: raw <= cap.raw && gzip <= cap.gzip };
  });
}

/** The group of `files` (a DEV tree's files: its path under web/, as "dist/...", to the file on disk), measured. */
export function latexGroup(files) {
  const lazy = new Set(Object.values(LATEX_LAZY));
  const group = [...files.keys()].filter((n) => n.startsWith("dist/") && /(^|\/)sagebrush-latex/.test(n) && !lazy.has(n));
  const js = group.filter((n) => n.endsWith(".js")), css = group.filter((n) => n.endsWith(".css"));
  const raw = js.reduce((s, n) => s + statSync(files.get(n)).size, 0), gzip = js.reduce((s, n) => s + gz(readFileSync(files.get(n))), 0);
  return { group, js, css, raw, gzip, ok: js.length > 0 && raw <= LATEX_CAPS.raw && gzip <= LATEX_CAPS.gzip };
}
