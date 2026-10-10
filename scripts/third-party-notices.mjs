// Third-party notices for each package Sagebrush distributes (audit F9):
// what it bundles that is not Sagebrush's own (MIT OR Apache-2.0) code, with
// the license texts, so that each package carries its notices itself.
//
//   - the Rust crates statically linked into its engines: the normal
//     dependencies of its root crates in engine/ (Cargo metadata, on every
//     platform), each with its license and the license files of its source;
//   - derived code and data, from the sections of NOTICE.md;
//   - for the packages that carry the notebook page (the sagebrush npm
//     package, and so the web site, the desktop app and the standalone
//     executables), the npm packages its bundles contain
//     (web/js-dependencies.json, written by web/build.ts from the bundler's
//     metafiles) with their license files, and KaTeX's fonts (SIL Open Font
//     License, read from the fonts themselves).
//
// Licenses must be on the lists below and come with their texts: anything
// else is an error, not an assumed standard text (a crate without a license
// file gets the standard MIT or Apache-2.0 text, with its authors).
//
//   node scripts/third-party-notices.mjs           write the files
//   node scripts/third-party-notices.mjs --check   fail if one is out of date
//
// Also copies LICENSE-Artistic-2.0.txt (Cremona's ecdata) into the packages
// that bundle the data.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const root = new URL("..", import.meta.url).pathname;
const check = process.argv.includes("--check");

// a NOTICE.md section ("### NumPy ...") by the start of its heading
const notice = readFileSync(join(root, "NOTICE.md"), "utf8");
function section(start) {
  const i = notice.indexOf("\n### " + start);
  if (i < 0) throw new Error("NOTICE.md has no section " + start);
  const j = notice.indexOf("\n#", i + 5);
  return notice.slice(i + 1, j < 0 ? undefined : j).trim();
}
const artistic = readFileSync(join(root, "LICENSE-Artistic-2.0.txt"), "utf8");
const PARTS = {
  cpython: () => section("CPython"),
  numpy: () => section("NumPy"),
  arm: () => section("Arm Optimized Routines"),
  fdlibm: () => section("fdlibm"),
  smalljac: () => section("smalljac"),
  cremona: () => "### John Cremona's ecdata (Artistic License 2.0)\n\nThe elliptic curves of conductor below 1000 (`_cremona_small.py`) are from\nJohn Cremona's ecdata, https://github.com/JohnCremona/ecdata, under the\nArtistic License 2.0 (LICENSE-Artistic-2.0.txt, ecdata's LICENSE file):\nlabel, minimal a-invariants, rank and torsion order, unchanged.",
};

const PACKAGES = [
  { file: "engine/py/THIRD-PARTY-NOTICES.txt", what: "the Python package (wheel and sdist of `sagebrush`)", crates: ["sagebrush-py"], parts: ["smalljac", "cremona"], artistic: "engine/py" },
  { file: "cdn/THIRD-PARTY-NOTICES.txt", what: "the npm package `sagebrush-web`", crates: ["sagebrush-web"], parts: ["smalljac", "cpython"] },
  // the desktop app's native code (app/src-tauri: Tauri, Wry, Tao, its
  // plugins, the platforms' bindings); its page carries the notebook's notices
  { file: "app/THIRD-PARTY-NOTICES-native.txt", what: "the desktop app's native code (app/src-tauri)", manifest: "app/src-tauri", crates: ["sagebrush-app"], parts: [], mpl: true, native: true },
  { file: "packages/sagebrush/THIRD-PARTY-NOTICES.txt", what: "the npm package `sagebrush`, its standalone executables, the notebook page (sagebrush.space, the desktop app)", crates: ["sagebrush-web"], parts: ["cpython", "numpy", "arm", "fdlibm", "smalljac", "cremona"], artistic: "packages/sagebrush", web: true },
];

const metas = new Map();
function metadata(dir) {
  if (!metas.has(dir)) {
    const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], { cwd: join(root, dir), maxBuffer: 1 << 28 }).toString());
    metas.set(dir, { meta, byId: new Map(meta.packages.map((p) => [p.id, p])), nodes: new Map(meta.resolve.nodes.map((n) => [n.id, n])) });
  }
  return metas.get(dir);
}
let meta, byId, nodes;

// the normal (linked) dependencies of the root crates, transitively
function closure(names) {
  const seen = new Set(), stack = meta.packages.filter((p) => names.includes(p.name) && !p.source).map((p) => p.id);
  if (stack.length !== names.length) throw new Error("no crate " + names);
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of nodes.get(id).deps) if (d.dep_kinds.some((k) => k.kind === null)) stack.push(d.pkg);
  }
  return [...seen].map((id) => byId.get(id));
}

const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense)/i;
// license identifiers accepted (SPDX), in Rust license expressions and npm packages
const OK_LICENSES = new Set(["MIT", "MIT-0", "Apache-2.0", "LLVM-exception", "Unlicense", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Zlib", "Unicode-3.0", "Unicode-DFS-2016", "BSL-1.0", "CC0-1.0", "0BSD", "BlueOak-1.0.0"]);
/// The alternative of a license expression ("A OR B", old "A/B") under which
/// the component is used: the first whose licenses are all accepted (MPL-2.0
/// too where `mpl`: the desktop app's Tauri stack); an error if none is.
function checkLicense(what, expr, mpl = false) {
  const ok = new Set([...OK_LICENSES, ...(mpl ? ["MPL-2.0"] : [])]);
  const top = (expr ?? "").replace(/\s*\/\s*/g, " OR ");
  // split at top-level ORs (parenthesized groups stay whole)
  const alts = [];
  let depth = 0, cur = "";
  for (const tok of top.split(/(\(|\)|\s+OR\s+)/)) {
    if (tok === "(") depth++;
    if (tok === ")") depth--;
    if (depth === 0 && /^\s+OR\s+$/.test(tok)) { alts.push(cur); cur = ""; } else cur += tok;
  }
  alts.push(cur);
  for (const alt of alts) {
    const ids = alt.split(/[\s()]+/).filter((t) => t && !["OR", "AND", "WITH"].includes(t));
    if (ids.length && ids.every((t) => ok.has(t))) return alt.trim();
  }
  throw new Error(`${what}: license ${JSON.stringify(expr)} is not on the accepted list (scripts/third-party-notices.mjs)`);
}
const MIT_TEXT = readFileSync(join(root, "LICENSE-MIT"), "utf8").replace(/^Copyright.*$/m, "Copyright (c) %AUTHORS%").trim();
const APACHE_TEXT = readFileSync(join(root, "LICENSE-APACHE"), "utf8").trim();
function licenseTexts(p) {
  const dir = dirname(p.manifest_path);
  return readdirSync(dir).filter((f) => LICENSE_FILE.test(f) && !/\.(rs|toml|json)$/.test(f)).sort().map((f) => [f, readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n").trim()]);
}

// what must never be linked into a package: the FLINT bindings and the
// oracle crate (LGPL, references for tests only), or any (L)GPL crate
function gate(pkg, all) {
  // (the alternative used: "MIT OR Apache-2.0 OR LGPL-2.1-or-later" is MIT)
  const bad = all.filter((p) => ["sagebrush-flint", "sagebrush-oracle"].includes(p.name) || (p.source && /\b(L?GPL|AGPL)/.test(checkLicense(p.name, p.license, pkg.mpl))));
  if (bad.length) throw new Error(`${pkg.file}: ${bad.map((p) => `${p.name} (${p.license})`).join(", ")} would be linked into ${pkg.what}`);
}

function render(pkg) {
  ({ meta, byId, nodes } = metadata(pkg.manifest ?? "engine"));
  const all = closure(pkg.crates);
  gate(pkg, all);
  const own = all.filter((p) => !p.source);
  const ext = all.filter((p) => p.source).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const texts = new Map(); // hash -> {text, users: [name version (file)]}
  let standard = false;
  const rows = ext.map((p) => {
    const used = checkLicense(`${p.name} ${p.version}`, p.license, pkg.mpl);
    let files = licenseTexts(p);
    if (!files.length) {
      // the standard texts of the licenses it is used under, with its authors
      const owner = p.authors?.length ? p.authors.join(", ") : `the ${p.name} authors`;
      for (const id of used.split(/[\s()]+/).filter((t) => t && !["AND", "WITH", "OR"].includes(t))) {
        if (id === "Apache-2.0") standard = true;
        else if (id === "MIT") files.push(["MIT (standard text)", MIT_TEXT.replace("%AUTHORS%", owner)]);
        else if (id === "LLVM-exception") {}
        else if (existsSync(join(root, "LICENSES", id + ".txt"))) files.push([`${id} (standard text)`, readFileSync(join(root, "LICENSES", id + ".txt"), "utf8").replace(/<year> <owner>/g, owner).trim()]);
        else throw new Error(`${p.name} ${p.version}: no license file, and no standard text of ${id} (LICENSES/)`);
      }
    }
    for (const [f, t] of files) {
      const h = createHash("sha256").update(t).digest("hex");
      if (!texts.has(h)) texts.set(h, { text: t, users: [] });
      texts.get(h).users.push(`${p.name} ${p.version} (${f})`);
    }
    return `${p.name} ${p.version}: ${p.license}${used !== (p.license ?? "").trim() && /GPL|MPL/.test(p.license) ? ` (used under ${used})` : ""}${licenseTexts(p).length ? "" : " [no license file in the crate: the standard text]"}${/MPL-2\.0/.test(used) ? ` [MPL-2.0: unmodified; its source is at https://crates.io/crates/${p.name}/${p.version}]` : ""}`;
  });
  const out = [
    `Third-party notices for ${pkg.what}`,
    `(generated by scripts/third-party-notices.mjs; do not edit)`,
    "",
    `Sagebrush itself (Copyright (c) 2026 SageMath, Inc.) is licensed under the MIT license or the Apache License 2.0, at your option. This package also contains the following, under their own terms.`,
    ...(pkg.native ? ["", "The app's page (the notebook) has its own notices, THIRD-PARTY-NOTICES.txt beside this file in the app. The app uses the platform's web view (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux), which is not part of it; the Linux AppImage also bundles shared libraries of the system it was built on (GTK, WebKitGTK and others, LGPL), which are not listed here."] : []),
    "",
    "== Derived code and data ==",
    "",
    ...pkg.parts.flatMap((k) => [PARTS[k](), ""]),
    `== Rust crates compiled into ${pkg.native ? "the app" : "the engines"} (${ext.length}) ==`,
    "",
    `Sagebrush's own crates: ${own.map((p) => p.name).sort().join(", ")}. The list includes dependencies on every platform and those used only while compiling (procedural macros), so it covers more than any one build contains.`,
    "",
    ...rows,
    "",
    "== License texts of those crates ==",
    "",
    ...[...texts.values()].sort((a, b) => a.users[0].localeCompare(b.users[0])).flatMap(({ text, users }) => ["-".repeat(72), "Used by: " + users.join(", "), "-".repeat(72), "", text, ""]),
    ...(standard ? ["-".repeat(72), "The Apache License 2.0 (standard text, for the crates above without license files)", "-".repeat(72), "", APACHE_TEXT, ""] : []),
    ...(pkg.web ? webSection() : []),
  ];
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// The npm packages in the notebook page's bundles, and KaTeX's fonts.
function webSection() {
  const depsText = readFileSync(join(root, "web", "js-dependencies.json"), "utf8");
  const hash = createHash("sha256").update(depsText).digest("hex").slice(0, 16);
  const deps = JSON.parse(depsText).packages;
  const out = ["== JavaScript packages in the notebook page's bundles (" + deps.length + ") ==", "", `(from web/js-dependencies.json ${hash})`, ""];
  const texts = [];
  for (const d of deps) {
    checkLicense(`${d.name} ${d.version}`, d.license);
    const dir = join(root, d.path);
    const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort();
    if (!files.length) throw new Error(`${d.name} ${d.version}: no license file in ${d.path}`);
    out.push(`${d.name} ${d.version}: ${d.license} (in ${d.in.join(", ")})${d.license_from_version ? ` [vendored by another package; license text from ${d.license_from_version}]` : ""}`);
    for (const f of files) texts.push(["-".repeat(72), `${d.name} ${d.version} (${f})`, "-".repeat(72), "", readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n").trim(), ""]);
  }
  // KaTeX's fonts carry their own license (not KaTeX's MIT): from their name tables
  const katex = deps.find((d) => d.name === "katex");
  const fonts = new Map();
  if (katex) {
    const fdir = join(root, katex.path, "dist", "fonts");
    for (const f of readdirSync(fdir).filter((f) => f.endsWith(".ttf")).sort()) {
      const key = fontNotice(readFileSync(join(fdir, f)));
      if (!/SIL Open Font License, Version 1\.1/.test(key)) throw new Error(`KaTeX font ${f}: not under the SIL Open Font License 1.1: ${key}`);
      (fonts.get(key) ?? fonts.set(key, []).get(key)).push(f.replace(/\.ttf$/, ""));
    }
  }
  out.push("", ...texts.flat());
  if (fonts.size) {
    out.push("== KaTeX's fonts (SIL Open Font License 1.1) ==", "");
    for (const [notice, names] of fonts) out.push("Fonts: " + names.join(", "), "", notice, "");
    out.push("-".repeat(72), "SIL Open Font License, Version 1.1", "-".repeat(72), "", readFileSync(join(root, "LICENSES", "OFL-1.1.txt"), "utf8").trim(), "");
  }
  return out;
}

/// A TrueType font's copyright and license strings (name IDs 0 and 13).
function fontNotice(buf) {
  const u16 = (o) => buf.readUInt16BE(o), u32 = (o) => buf.readUInt32BE(o);
  const tables = u16(4);
  for (let i = 0; i < tables; i++) {
    const r = 12 + 16 * i;
    if (buf.toString("latin1", r, r + 4) !== "name") continue;
    const off = u32(r + 8), count = u16(off + 2), strings = off + u16(off + 4);
    const got = {};
    for (let j = 0; j < count; j++) {
      const e = off + 6 + 12 * j;
      const [pid, nid, len, o] = [u16(e), u16(e + 6), u16(e + 8), u16(e + 10)];
      if (pid !== 3 || (nid !== 0 && nid !== 13)) continue;
      const b = buf.subarray(strings + o, strings + o + len);
      got[nid] = Buffer.from(b).swap16().toString("utf16le");
    }
    return [got[0], got[13]].filter(Boolean).join("\n").replace(/\r/g, "");
  }
  throw new Error("a font without a name table");
}

let stale = [];
const put = (rel, text) => {
  const path = join(root, rel);
  if (existsSync(path) && readFileSync(path, "utf8") === text) return;
  if (check) stale.push(rel);
  else { writeFileSync(path, text); console.log("wrote " + rel); }
};
for (const pkg of PACKAGES) {
  put(pkg.file, render(pkg));
  if (pkg.artistic) put(join(pkg.artistic, "LICENSE-Artistic-2.0.txt"), artistic);
}
if (stale.length) {
  console.error("out of date: " + stale.join(", ") + " (run node scripts/third-party-notices.mjs)");
  process.exit(1);
}
