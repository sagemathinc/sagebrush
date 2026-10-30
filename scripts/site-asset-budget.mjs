// The site's asset budget gate for the LaTeX editor (plan sbspace r5 §2 and §5). Run where the builds are (a VM or
// CI), never as a judge on the project side. It compares built trees, does not build:
//   node scripts/site-asset-budget.mjs --base-prod DIR --prod DIR --dev DIR [--meta FILE] [--out FILE]
//     --base-prod  web/ of the tree before the editor, built with SAGEBRUSH_LATEX_PREVIEW unset
//     --prod       web/ of the tree with the editor, built with it unset (what PROD ships)
//     --dev        web/ of the tree with the editor, built with SAGEBRUSH_LATEX_PREVIEW=1 (what DEV ships)
//     --meta       the DEV build's build/latex-metafile.json (every bundle's inputs), for the KaTeX census
// Checks (each one printed; the last line is the verdict):
//   1. PROD: every file of web/dist and web/site/public, by name and SHA-256, the same as before the editor, except
//      the DECLARED list: board/examples/source.json, the generated board of the repository's own sources (by folder:
//      src, lib, web, scripts, ...), whose differing nodes may only be the groups of the source files this change
//      touches (--changed FILE: one repository path per line, made from the two trees' manifests), every other field
//      equal;
//   2. PROD holds no LaTeX-owned file (named sagebrush-latex*) and no page or script names one;
//   3. the DEV bootstrap: index.html's growth over PROD, at most DEV_BOOT.raw bytes minified and DEV_BOOT.gzip gzip
//      (level 9);
//   4. the LaTeX group (every sagebrush-latex* file in DEV): its JS at most 192 KiB minified and 64 KiB gzip; no CSS
//      file over 8 KiB; no font file; and the test build's hook on image reads folded away (no DEV file names it);
//   5. no new KaTeX bytes: DEV's katex/ files the same as PROD's, and (with --meta) no node_modules/katex input in a
//      LaTeX bundle and KaTeX's inputs in exactly one output (the math module).
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const BASE = arg("--base-prod"), PROD = arg("--prod"), DEV = arg("--dev"), META = arg("--meta"), OUT = arg("--out"), CHANGED = arg("--changed");
if (!BASE || !PROD || !DEV) { console.error("usage: --base-prod DIR --prod DIR --dev DIR [--meta FILE] [--out FILE]"); process.exit(2); }
const ROOTS = ["dist", "site/public"];
const DEV_BOOT = { raw: 2498, gzip: 990 };
const DECLARED = new Set(["dist/board/examples/source.json", "site/public/board/examples/source.json"]);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const gz = (b) => gzipSync(b, { level: 9 }).length;
function inventory(web) {
  const out = new Map();
  for (const r of ROOTS) {
    const root = join(web, r);
    if (!existsSync(root)) throw new Error(`no ${root}`);
    (function walk(d) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isSymbolicLink()) throw new Error(`a symlink in the output: ${p}`);
        if (e.isDirectory()) walk(p); else if (e.isFile()) out.set(relative(web, p), p);
      }
    })(root);
  }
  return out;
}
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : ": " + JSON.stringify(detail).slice(0, 600))); };

// 1. PROD against the tree before the editor
const base = inventory(BASE), prod = inventory(PROD), dev = inventory(DEV);
const names = [...new Set([...base.keys(), ...prod.keys()])].sort();
const differing = names.filter((n) => !base.has(n) || !prod.has(n) || sha(readFileSync(base.get(n))) !== sha(readFileSync(prod.get(n))));
const undeclared = differing.filter((n) => !DECLARED.has(n));
check("PROD files: the same names and bytes as before the editor, but for the declared ones", undeclared.length === 0, { files: names.length, differing, undeclared });
for (const n of differing.filter((x) => DECLARED.has(x))) {
  const a = JSON.parse(readFileSync(base.get(n), "utf8")), b = JSON.parse(readFileSync(prod.get(n), "utf8"));
  const byId = (d) => new Map((d.nodes ?? []).map((x) => [x.id, JSON.stringify(x)]));
  const na = byId(a), nb = byId(b);
  const nodes = [...new Set([...na.keys(), ...nb.keys()])].filter((k) => na.get(k) !== nb.get(k));
  // (besides its nodes: the intro may differ only in its count of source files, and edges only between files or
  //  groups of changed sources; every other field the same)
  const rest = (d) => JSON.stringify(Object.fromEntries(Object.entries(d).filter(([k]) => k !== "nodes" && k !== "edges" && k !== "intro")));
  const intro = (d) => String(d.intro ?? "").replace(/^\*\*\d+ source files\*\*/, "**N source files**");
  const edgeKey = (e) => JSON.stringify(e);
  const ea = new Set((a.edges ?? []).map(edgeKey)), eb = new Set((b.edges ?? []).map(edgeKey));
  const edgeDiff = [...[...ea].filter((k) => !eb.has(k)), ...[...eb].filter((k) => !ea.has(k))].map((k) => JSON.parse(k));
  // (a changed file's group: "g:" + its folder; scripts/x.mjs -> g:scripts, web/build.ts -> g:web)
  const allowed = new Set((CHANGED ? readFileSync(CHANGED, "utf8").split("\n").filter(Boolean) : []).map((p) => "g:" + p.slice(0, Math.max(0, p.lastIndexOf("/")))));
  const changedFile = (id) => (CHANGED ? readFileSync(CHANGED, "utf8").split("\n") : []).some((p) => id === "f:" + p);
  const edgesOk = edgeDiff.every((e) => [e.from, e.to].some((x) => allowed.has(x) || changedFile(x)));
  check(`declared difference ${n}: only the groups of changed sources (nodes, edges, the intro's file count), every other field the same`,
    nodes.length > 0 && nodes.every((k) => allowed.has(k)) && edgesOk && intro(a) === intro(b) && rest(a) === rest(b),
    { nodes, edges: edgeDiff.length, edgesOk, introSame: intro(a) === intro(b), restSame: rest(a) === rest(b) });
}
// 2. nothing of the editor in PROD
const prodLatex = [...prod.keys()].filter((n) => /(^|\/)sagebrush-latex/.test(n));
const prodRefs = [...prod.entries()].filter(([n]) => /\.(html|js|mjs|json)$/.test(n) || n.endsWith("_headers")).filter(([, p]) => readFileSync(p).includes("sagebrush-latex")).map(([n]) => n);
check("PROD: no LaTeX-owned file, and nothing names one", prodLatex.length === 0 && prodRefs.length === 0, { prodLatex, prodRefs });
// 3. the DEV bootstrap. Its ceiling was 1536 B / 717 B gzip; raised for the file browser's "LaTeX file" in New (asked
//    for by William: the only way to make a .tex was to upload one), whose code is in index.html's bundle in a LaTeX
//    build only (PROD byte-identical, check 1). The ceiling is the measured delta + 128 B / + 64 B gzip: 2060 B / 722 B
//    by this check in the I1 run that passed with it (VM2, 2026-10-29), so 2188 B / 786 B. Raised again (@sagebrush's ruling,
//    2026-10-29) for William's phone requests: "LaTeX document" and "LaTeX example" (ten examples) in the File menu's
//    New group and on the empty file list, added by the same LaTeX-only boot hook: the measured delta + 128 B / + 64 B
//    gzip, 2370 B / 926 B (this check's measure, the batch's head merged with master), so 2498 B / 990 B
const pi = readFileSync(prod.get("dist/index.html")), di = readFileSync(dev.get("dist/index.html"));
const boot = { raw: di.length - pi.length, gzip: gz(di) - gz(pi) };
check(`DEV bootstrap delta (index.html): at most ${DEV_BOOT.raw} B minified and ${DEV_BOOT.gzip} B gzip`, boot.raw <= DEV_BOOT.raw && boot.gzip <= DEV_BOOT.gzip, boot);
// 4. the LaTeX group
// (the comments' chunk, sagebrush-latex-comments.js, loaded only for comments: its own line below, not in the group)
const COMMENTS = "dist/sagebrush-latex-comments.js", COMMENTS_DOC = "dist/sagebrush-latex-comments-doc.js", AGENT = "dist/sagebrush-latex-agent.js";
const group = [...dev.keys()].filter((n) => n.startsWith("dist/") && /(^|\/)sagebrush-latex/.test(n) && n !== COMMENTS && n !== COMMENTS_DOC && n !== AGENT);
const js = group.filter((n) => n.endsWith(".js")), css = group.filter((n) => n.endsWith(".css")), fonts = [...dev.keys()].filter((n) => n.startsWith("dist/") && /\.(woff2?|ttf|otf)$/.test(n) && !prod.has(n));
const jsRaw = js.reduce((s, n) => s + statSync(dev.get(n)).size, 0), jsGz = js.reduce((s, n) => s + gz(readFileSync(dev.get(n))), 0);
// (192 KiB / 64 KiB: @sagebrush's ruling of 2026-10-29, for the ten examples and the embeddable editor; was 180 / 60)
check("the LaTeX group's JS: at most 192 KiB minified, 64 KiB gzip", js.length > 0 && jsRaw <= 192 * 1024 && jsGz <= 64 * 1024, { files: js, raw: jsRaw, gzip: jsGz });
// 4b. the comments' chunk: at most 16 KiB minified, 6 KiB gzip (@sagebrush, 2026-10-29: comments in a lazy chunk of
//     their own, so a document without comments never pays for them)
if (dev.has(COMMENTS)) { const b = readFileSync(dev.get(COMMENTS)); check("the LaTeX comments' chunk: at most 16 KiB minified, 6 KiB gzip", b.length <= 16 * 1024 && gz(b) <= 6 * 1024, { raw: b.length, gzip: gz(b) }); }
// 4c. a document's live comments' chunk (comments-doc.ts and the format's core, comments-core.mjs): at most 40 KiB
//     minified, 14 KiB gzip, fetched only when a .tex has a comments file or someone comments in it
// 4d. the agent pairing's chunk (web/workspace/agent-ui.ts, the shared module, through web/latex/agent.ts): at most
//     40 KiB minified, 14 KiB gzip, fetched only to connect an agent (the Agent button, a ?pair= link, a remembered one)
if (dev.has(AGENT)) { const b = readFileSync(dev.get(AGENT)); check("the LaTeX agent pairing's chunk: at most 40 KiB minified, 14 KiB gzip", b.length <= 40 * 1024 && gz(b) <= 14 * 1024, { raw: b.length, gzip: gz(b) }); }
if (dev.has(COMMENTS_DOC)) { const b = readFileSync(dev.get(COMMENTS_DOC)); check("the LaTeX document comments' chunk: at most 40 KiB minified, 14 KiB gzip", b.length <= 40 * 1024 && gz(b) <= 14 * 1024, { raw: b.length, gzip: gz(b) }); }
// (the test build's holds on image and file reads and its comments write, web/latex/page.ts: folded away in the DEV build, so named in none of its files)
const testHooks = [...dev.keys()].filter((n) => n.startsWith("dist/") && /\.(js|html)$/.test(n) && /__sbTex(ImageRead|MountRead|CommentsWrite|SaveWrite)/.test(readFileSync(dev.get(n), "latin1")));
check("DEV: the test build's hooks folded away (no file names __sbTexImageRead, __sbTexMountRead, __sbTexCommentsWrite or __sbTexSaveWrite)", testHooks.length === 0, { testHooks });
check("the LaTeX group: no CSS file over 8 KiB, no new font", css.every((n) => statSync(dev.get(n)).size <= 8192) && fonts.length === 0, { css, fonts });
// 5. KaTeX: the same files, and in exactly one bundle
const kp = [...prod.keys()].filter((n) => n.startsWith("dist/katex/")).sort(), kd = [...dev.keys()].filter((n) => n.startsWith("dist/katex/")).sort();
check("KaTeX's stylesheet and fonts: DEV's the same files and bytes as PROD's", JSON.stringify(kp) === JSON.stringify(kd) && kp.every((n) => sha(readFileSync(prod.get(n))) === sha(readFileSync(dev.get(n)))), { files: kp.length });
if (META) {
  const meta = JSON.parse(readFileSync(META, "utf8"));
  const withKatex = Object.entries(meta).filter(([, ins]) => ins.some((i) => /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?katex\//.test(i))).map(([w]) => w);
  check("KaTeX's code in exactly one bundle (the math module), none of the LaTeX editor's", withKatex.length === 1 && withKatex[0] === "math" && !Object.keys(meta).some((w) => /LaTeX/.test(w) && withKatex.includes(w)), { withKatex });
}
const failed = results.filter((r) => !r.ok);
if (OUT) writeFileSync(OUT, JSON.stringify({ results, boot, latex: { js, jsRaw, jsGz } }, null, 1) + "\n");
console.log(failed.length ? `FAIL: site asset budget, ${failed.length} of ${results.length}: ${failed.map((r) => r.name).join("; ")}` : `ok: site asset budget, ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
