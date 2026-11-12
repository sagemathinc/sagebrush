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
  PYTHONTEX: "dist/sagebrush-latex-pythontex.js",
  RUN: "dist/sagebrush-latex-run.js",
  INTERACT: "dist/sagebrush-latex-interact.js",
  VIEW: "dist/sagebrush-latex-view.js",
  SHARE: "dist/sagebrush-latex-share.js",
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
// (236 KiB raw: daybreak2's SIZE ruling, Nov 10 2026, for PythonTeX step (a), once: its source pass must stay eager (the
//  code items it finds, their occurrence ids and where each was read, what Run, check and the CLI use) and so must its
//  no-result display (the items' chips and texts); everything used only to read results back is the PYTHONTEX chunk.
//  Measured 241,385 / 80,477 after the split and the two ruled trims; gzip unchanged, under its cap)
// (241,778 raw: daybreak2's size path for the editor's changes, Nov 10 (a slide's plot sized as in the PDF), a cap moved
//  by a PR is its landing measurement + 64: 241,714 measured on master 66675ccb with it)
// (241,943 raw: daybreak2's size path for the editor's three changes, Nov 10 (the preview keeping its place on a Run:
//  its swap's anchoring, eager), a cap moved by a PR is its landing measurement + 64: 241,879 measured on master
//  a5484fc8 with it; 242,382: daybreak2, Nov 11, +117 for the jumps found with scroll anchoring off, as in Safari
//  (hidden groups take no room, a released piece keeps its height): 242,318 measured on master 43e64469, + 64)
// (244,388 raw / 81,635 gzip: daybreak2's SIZE ruling, Nov 11 2026, for Magma in LaTeX (\magma{}, magmablock, magmasilent), no chunk
//  of its own (a split cost the eager path more than it saved): measured + 64: 244,324 / 81,571 on master 29720004)
// (246,016 raw / 82,328 gzip: a Sage table() drawn as a table (S2's talk), daybreak2's ruling, Nov 12: 245,952 / 82,264
//  measured on master 0d492019 with it (+1,239 / +541 over 244,713 / 81,723), + 64. Before: 244,777 / 81,787, V1's,
//  the view kept and put back: its landing measurement on master e45ae971, + 64)
// (246,588 raw / 82,522 gzip: running code while presenting (S stops a Run; a value a Run didn't reach keeps its earlier
//  one, its title saying why), daybreak2's ruling, Nov 12, renewed after its review fixes: 246,524 / 82,458 measured on
//  master 4e69d8e4 with it (+572 / +194 over 245,952 / 82,264), + 64)
// (246,659 raw / 82,543 gzip: a shared talk on the share page (mountEditor given the author's results, its items and
//  a redraw), daybreak2's ruling, Nov 12: 246,595 / 82,479 measured on master 8431bd54 with it (+71 / +21), + 64)
// (246,769 raw / 82,596 gzip: the editor's File ▸ Share… (its text, and a save of it that refuses unless written, for the
//  page's Share dialog), daybreak2's ruling, Nov 12: 246,705 / 82,532 measured on master 831ff4eb with it (+110 / +53), + 64)
export const LATEX_CAPS = { raw: 246769, gzip: 82596 };
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
  // (45,952 / 16,000: daybreak2's amendment for #957 r3, Nov 10 2026 (from 44 / 15.5 KiB): the grant's id, notebook.edit's
  //  hold and the Everything default, which every page's pairing carries; r3 measured 45,870 / 15,879, master 44,935 / 15,593)
  // (47,645 / 16,403: daybreak2's ruling for #986 r2, Nov 10 2026 (sha256 21d3849d…): the grant's "May run code" UI and
  //  state every page's pairing carries, its run verbs' hook; measured 47,581 / 16,339 + 64. No run's execution, result,
  //  snapshot or output code may enter this chunk: those are run-holder.ts's and the run chunk's, the notebook page's only)
  // (47,904 / 16,470: renewed for the branch history's three verbs, which every page's pairing routes to the page
  //  that offers branches: their checks and runs are in that page's own module (git-verbs.ts), only their route and a commit's count here.
  //  Its growth measured on the same toolchain, master 5ca91ad8 -> the branch history's head: 47,606 -> 47,865 raw (+259), 16,621 ->
  //  16,688 gzip (+67), added to the cap as it was)
  // (49,666 / 16,943: renewed for Chat here, whose link hooks every page's pairing carries (a socket, agent.ready, the
  //  reply's place and answer, Revoke as the link's drain), the leg itself being the Agents page's own; measured in CI at
  //  97f13a7b (run 43173133995): 49,602 / 16,879, + 64)
  AGENT: { label: "the LaTeX agent pairing's chunk", raw: 49666, gzip: 16943 },
  // (the agent tools' work: web/latex/tools.ts, latex_check's report and latex_render's pictures, on an agent's first call)
  // (16,546 / 6,950: daybreak2's Q1 ruling for chat plan PR 4b, Nov 11 2026: latex_build's own code (build.ts, the
  //  engine driven from a snapshot, and the pages' fit) here, out of the eager group, its shared rules handed in by the
  //  page module rather than bundled again; measured 16,482 / 6,886 on master 4d4225f9, + 64. Was 16 / 6 KiB)
  // (17,335 / 7,231: renewed at the landing merge on master 14279164: 16,494 / 6,881 before it -> 17,271 / 7,167 after,
  //  +777 / +286 inherited from #1018's shared check and tools changes, none of it this PR's own code; + 64)
  TOOLS: { label: "the LaTeX agent tools' chunk", raw: 17335, gzip: 7231 },
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
  // (PythonTeX's results pass: engine/pythontex.mjs, the worker's, fetched only when a document has a PythonTeX result to
  //  read back (a valid or stale one), never for one that only has PythonTeX items (daybreak2's SIZE ruling, Nov 10:
  //  its own row, not in an existing chunk; 5 KiB / 2.25 KiB, the smallest rounded cap above its first build's 4,540 / 2,008; 4,799 / 2,153 with the stale fade's code; 4,892 / 2,191 with display states made afresh on a cache hit)
  PYTHONTEX: { label: "the LaTeX PythonTeX results chunk", raw: 5 * 1024, gzip: 2.25 * 1024 },
  // (Run's code: web/latex/run-core.mjs, fetched on the first Run (first-use code: the editor opens without it). Out of
  //  the group so save-as-you-type (#551, eager by nature) fits under the group's cap without a raise (daybreak2, Nov 7:
  //  a lazy split, not a raise). 12 KiB / 5.25 KiB: daybreak2's ruling, Nov 7, on 11,330 / 4,804 measured at master
  //  59d5ec95, about 8% / 12% room. 15.5 KiB / 6.5 KiB: daybreak2's ruling, Nov 7, for #804 (W01's record of what a
  //  Run imported, its own Run growth): 14,552 / 6,066 measured at #804's head 9759eac5 (master fd24862b merged),
  //  +1,320 / +590, about 9.1% / 9.7% room)
  //  17 KiB / 7 KiB: daybreak2's SIZE design for the Beamer plan's PR 3 (Nov 8), the session script's @interact capture
  //  (its check in the interact chunk, not here): 16,802 / 6,705 measured on #874's head 30efd744, +2,250 / +613
  //  17,965 / 7,272: daybreak2's SIZE ruling, Nov 11 (Magma in LaTeX, the session script's Magma part): measured + 64,
  //  17,901 / 7,208 on master 29720004)
  //  18,672 / 7,574: daybreak2's SIZE ruling, Nov 12, renewed after its review fixes (running code while presenting: the
  //  Run keeps a value it didn't reach, each occurrence its own, with why): measured + 64, 18,608 / 7,510 on master
  //  4e69d8e4 (+707 / +304 over 17,901 / 7,206)
  //  19,465 / 7,779: daybreak2's SIZE ruling, Nov 12 (a shared talk's Run on the share page: a session given the share's
  //  files and ended at once, a Run kept in the page, the run half shared with the editor's): measured + 64, 19,401 /
  //  7,715 on master 8431bd54 (+793 / +205 over 18,608 / 7,510); renewed after its review fixes (a session ended for
  //  good at every step, a Run admitted again just before its script): 19,580 / 7,748 measured on master 9534e419, + 64
  RUN: { label: "the LaTeX Run chunk", raw: 19644, gzip: 7812 },
  // (@interact, a Sagebrush extension (William, Nov 8): interact.ts, a Run's interacts checked and the preview's drawn,
  //  fetched only once a Run or a preview has one; a lazy split for the Beamer plan's PR 3 (daybreak2, Nov 8: the eager
  //  group near its cap); 5 KiB / 2.5 KiB: the measured 4,555 / 2,080 with modest room, as daybreak2's design asks (PR 4
  //  and 5's live widgets justify their own measured change). 9 KiB / 3.75 KiB: PR 4's live widgets (a change runs the
  //  function again in the Run's session), 8,413 / 3,332 measured, as daybreak2's SIZE ruling approved
  // (9,453 / 3,805: a labels slider's label kept for a value put back, daybreak2's ruling, Nov 12: 9,389 / 3,741 measured
  //  on master 0d492019 with it, + 64; before, 9 KiB / 3.75 KiB)
  INTERACT: { label: "the LaTeX interact chunk", raw: 9453, gzip: 3805 },
  // (where you were in a .tex (V1, design/view-state.md): view.ts with view-state.ts, fetched as a file opens; a lazy
  //  split by daybreak2's SIZE plan, Nov 10 (the eager group at its cap): 3,314 / 1,608 measured on master a5484fc8,
  //  + 64 B each)
  VIEW: { label: "the LaTeX view chunk", raw: 3378, gzip: 1672 },
  // (a shared talk's view, loaded by the share page by URL for a .tex only (daybreak2's SIZE design, Nov 12): its
  //  measurement + 64, 3,688 / 1,957 on master 8431bd54)
  SHARE: { label: "the LaTeX shared talk's chunk", raw: 3752, gzip: 2021 },
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
