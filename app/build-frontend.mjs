// The app's web page: the notebook's files from web/dist (bun web/build.ts),
// without the Atlas, the demos or the service worker (the app's files are
// local already).
//
// Its worker fetches the Python library in chunks (web/lib-chunks.mts,
// web/lib-lazy.ts): lib/<group>.<kind>.<hash>.json, each checked against the
// SHA-256 the worker was built with.  They are copied with it, and checked
// here: every chunk the worker names must be in app/dist with that SHA-256,
// and app/dist/lib must hold nothing else, or this fails.  So must every
// module and index the page names.  Without lib/, the
// app served something else for a chunk and every Sage cell failed ("not
// the chunk this worker was built with", the app workflow from 5ba5afdd on).
// The pinned zone data (web/tzdata-chunks.mts) is checked the same way: the
// index the worker names, by its SHA-256, and each zone file the index names,
// by its own, with nothing else in lib/tzdata.
//
//   node app/build-frontend.mjs              build app/dist, then check it
//   node app/build-frontend.mjs --check DIR  check DIR only (web/test-app-frontend.mjs)
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const src = join(here, "..", "web", "dist");
const checkOnly = process.argv[2] === "--check";
if (checkOnly && !process.argv[3]) throw new Error("usage: node app/build-frontend.mjs --check DIR");
const out = checkOnly ? process.argv[3] : join(here, "dist");
if (!checkOnly) {
  // (everything below comes from a complete `bun web/build.ts`: it can stop part way, with index.html written but
  // not the notices or the icons, when web/js-dependencies.json changed; scripts/build-all.sh handles that)
  const FILES = ["index.html", "sagebrush-app.js", "sagebrush-worker.js", "sagebrush-engine.wasm", "sagebrush-raster.wasm", "sagebrush-nd.wasm", "sagebrush-mp.wasm", "sagebrush-console.js", "sagebrush-math.js", "sagebrush-myst.js", "sagebrush-viewer3d.js", "sagebrush-history.js", "sagebrush-analyze.js", "sagebrush-remote.js", "sagebrush-remote-terminal.js", "sagebrush-export.js", "sagebrush-export-worker.js", "sagebrush-gitpush-panel.js", "sagebrush-examples-panel.js", "sagebrush-code.js", "sagebrush-gitpush-worker.js", "sagebrush-latex.js", "sagebrush-latex-worker.js", "sagebrush-latex-comments.js", "sagebrush-latex-comments-doc.js", "sagebrush-latex-agent.js", "sagebrush-latex-tools.js", "sagebrush-latex-present.js", "sagebrush-latex-interact.js", "sagebrush-latex-view.js", "sagebrush-latex-run.js", "sagebrush-latex-doc.js", "sagebrush-latex-share.js", "sagebrush-latex-examples.js", "sagebrush-latex-beamer.js", "sagebrush-latex-pythontex.js", "sagebrush-graphview.js", "sagebrush-selftest.js", "sagebrush-share-deps.js", "sagebrush-share-folder.js", "sagebrush-share-mine.js", "docs-index.json", "THIRD-PARTY-NOTICES.txt", "katex", "icons", "lib"];
  const missing = [...FILES, "shell", "pkg", "pkgset", "pkgmeta"].filter((f) => !existsSync(join(src, f)));
  if (missing.length) throw new Error(`web/dist is missing ${missing.join(", ")}: run \`bun web/build.ts\` to the end (if it stops with "web/js-dependencies.json changed", run node scripts/third-party-notices.mjs and build again), or scripts/build-all.sh, which does both`);
  if (!existsSync(join(here, "THIRD-PARTY-NOTICES-native.txt"))) throw new Error("app/THIRD-PARTY-NOTICES-native.txt is missing: run node scripts/third-party-notices.mjs (or git checkout -- app/THIRD-PARTY-NOTICES-native.txt)");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const f of FILES)
    cpSync(join(src, f), join(out, f), { recursive: true });
  // the Terminal (⋯ ▸ Terminal, web/shell/): its page module and worker, and the bash package set web/build.ts
  // builds (shell/preview-set.json names it; pkgset/<S>.json pins its package in pkg/), served from the app's own
  // origin as the site serves them (William, Oct 30: the Terminal in the desktop and Android apps)
  for (const f of ["shell", "pkg", "pkgset", "pkgmeta"]) cpSync(join(src, f), join(out, f), { recursive: true });
  // (the other modes' documentation indexes, for the notebook's search box, where built)
  for (const f of ["docs-index-python.json", "docs-index-matlab.json", "docs-index-magma.json"]) if (existsSync(join(src, f))) cpSync(join(src, f), join(out, f));
  // the app's native code's notices (scripts/third-party-notices.mjs), beside the page's
  cpSync(join(here, "THIRD-PARTY-NOTICES-native.txt"), join(out, "THIRD-PARTY-NOTICES-native.txt"));
}
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// The worker's chunks, as its manifest names them ({file: "lib/...", sha256: "..."}
// in the bundle), each in app/dist with exactly that SHA-256
const worker = readFileSync(join(out, "sagebrush-worker.js"), "utf8");
const named = new Map([...worker.matchAll(/file:\s*"(lib\/[a-z0-9-]+\.(?:src|pre)\.[0-9a-f]{16}\.json)",\s*sha256:\s*"([0-9a-f]{64})"/g)].map((m) => [m[1], m[2]]));
const mentioned = new Set(worker.match(/lib\/[a-z0-9-]+\.(?:src|pre)\.[0-9a-f]{16}\.json/g) ?? []);
const bad = [];
if (named.size === 0) bad.push("the worker names no library chunk with its SHA-256 (has web/lib-lazy.ts's manifest changed shape?)");
for (const f of mentioned) if (!named.has(f)) bad.push(`${f}: the worker names it without its SHA-256`);
for (const [f, want] of named) {
  const p = join(out, f);
  if (!existsSync(p)) bad.push(`${f}: missing from app/dist`);
  else if (sha256(readFileSync(p)) !== want) bad.push(`${f}: not the bytes the worker was built with`);
}
// The pinned zone data: the index the worker's manifest names ({file:
// "lib/tzdata/index-<sha256>.json", sha256: ...}) with that SHA-256, and each
// zone file its index names (lib/tzdata/<sha256>.tzif) with its own
const tzRef = worker.match(/tzdata:\s*\{\s*file:\s*"(lib\/tzdata\/index-[0-9a-f]{64}\.json)",\s*sha256:\s*"([0-9a-f]{64})"/);
const tzFiles = new Set();
let zones = 0;
if (!tzRef && /lib\/tzdata\/index-/.test(worker)) bad.push("the worker names its zone data without its SHA-256 (has web/lib-lazy.ts's manifest changed shape?)");
if (tzRef) {
  const [, file, want] = tzRef;
  tzFiles.add(file);
  const p = join(out, file);
  if (!existsSync(p)) bad.push(`${file}: missing from app/dist`);
  else if (sha256(readFileSync(p)) !== want) bad.push(`${file}: not the bytes the worker was built with`);
  else {
    const index = JSON.parse(readFileSync(p, "utf8"));
    for (const [zone, h] of Object.entries(index.zones ?? {})) {
      zones++;
      const f = `lib/tzdata/${h}.tzif`;
      if (tzFiles.has(f)) continue;
      tzFiles.add(f);
      const q = join(out, f);
      if (!existsSync(q)) bad.push(`${f} (${zone}): missing from app/dist`);
      else if (sha256(readFileSync(q)) !== h) bad.push(`${f} (${zone}): not the bytes the zone data's index names`);
    }
    if (!zones) bad.push(`${file}: the zone data's index names no zone`);
  }
}
for (const f of readdirSync(join(out, "lib"))) {
  if (f === "tzdata" && statSync(join(out, "lib", f)).isDirectory()) {
    for (const g of readdirSync(join(out, "lib", f))) if (!tzFiles.has(`lib/tzdata/${g}`)) bad.push(`lib/tzdata/${g}: in app/dist but not the worker's`);
  } else if (!named.has("lib/" + f)) bad.push(`lib/${f}: in app/dist but not the worker's`);
}
// Every file of the page's that its HTML or scripts name (its modules,
// sagebrush-*.js and *.wasm, and the documentation indexes) in app/dist: one
// left off the list above failed only where it was used (graph output's
// sagebrush-graphview.js: astra's PKG-70B-1)
const pageFiles = readdirSync(out).filter((f) => /\.(html|m?js)$/.test(f));
const refs = new Set();
for (const f of pageFiles) for (const m of readFileSync(join(out, f), "utf8").matchAll(/\b(sagebrush-[a-z0-9-]+\.(?:m?js|wasm)|docs-index(?:-[a-z]+)?\.json)\b/g)) refs.add(m[1]);
// (the site's only, though the page names them: the notebook page's agent chunk, fetched only by its Agent button, which
// the page never shows in the app (window.__TAURI__): a page there is one the agent's program doesn't accept; and an
// agent's runs of code, which the app refuses (no sandbox there: chat plan PR 4a))
const SITE_ONLY = new Set(["sagebrush-agent.js", "sagebrush-agent-run.js", "sagebrush-agent-instruction.js", "sagebrush-review.js"]);
for (const r of [...refs].sort()) if (!SITE_ONLY.has(r) && !existsSync(join(out, r))) bad.push(`${r}: the page names it, but app/dist has no ${r}`);
for (const r of SITE_ONLY) if (existsSync(join(out, r))) bad.push(`${r}: the site's only, but it is in app/dist`);
// ...and every module or wasm the page names by a path from its own directory
// ("./shell/terminal.js", the Terminal's dynamic import): the Terminal's
// shipped in the apps' menu once without shell/ (#358), the item there and
// its import failing at the first click
const relRefs = new Set();
for (const f of pageFiles) for (const m of readFileSync(join(out, f), "utf8").matchAll(/["'`]\.\/([a-z0-9][a-z0-9/_.-]*\.(?:m?js|wasm))["'`]/gi)) relRefs.add(m[1]);
for (const r of [...relRefs].sort()) if (!existsSync(join(out, r))) bad.push(`./${r}: the page names it, but app/dist has no ${r}`);
// The Terminal's shell (web/shell/loader.ts): its worker, and the package set
// shell/preview-set.json names, pkgset/<S>.json, with each package it pins in
// pkg/<sha256>.json by that SHA-256 and size (the loader refuses any other)
let shellPkgs = 0;
const shellRead = (f) => { try { return JSON.parse(readFileSync(join(out, f), "utf8")); } catch { bad.push(`${f}: missing from app/dist, or not JSON`); return null; } };
if (!existsSync(join(out, "shell", "worker-boot.js"))) bad.push("shell/worker-boot.js: missing from app/dist (the Terminal's worker)");
const S = shellRead("shell/preview-set.json")?.S;
if (S !== undefined && !/^[0-9a-f]{64}$/.test(String(S))) bad.push(`shell/preview-set.json: S is not a set id (${String(S).slice(0, 80)})`);
const set = S && /^[0-9a-f]{64}$/.test(S) ? shellRead(`pkgset/${S}.json`) : null;
if (set) {
  for (const [name, p] of Object.entries(set.packages ?? {})) {
    const js = p?.js;
    if (!js || !/^[0-9a-f]{64}$/.test(js.sha256 ?? "")) { bad.push(`pkgset/${S}.json: ${name} pins no module`); continue; }
    shellPkgs++;
    const f = `pkg/${js.sha256}.json`;
    if (!existsSync(join(out, f))) bad.push(`${f} (${name}): missing from app/dist`);
    else {
      const b = readFileSync(join(out, f));
      if (b.length !== js.size || sha256(b) !== js.sha256) bad.push(`${f} (${name}): not the bytes its set pins (${b.length} bytes)`);
    }
  }
  if (!shellPkgs) bad.push(`pkgset/${S}.json: the Terminal's set names no package`);
}
if (bad.length) {
  console.error(`${checkOnly ? out : "app/dist"}: the worker and its library chunks do not match:\n  ` + bad.join("\n  "));
  process.exit(1);
}
console.log(`${checkOnly ? out : "app/dist"}: the notebook page for the app (the worker's ${named.size} library chunks, ${tzRef ? `its zone data's index and ${tzFiles.size - 1} zone files for ${zones} zones` : "no zone data"}, and the ${refs.size} files the page names checked, ${relRefs.size} by a relative path; the Terminal's set with ${shellPkgs} package${shellPkgs === 1 ? "" : "s"})`);
