// Third-party notices for each package Sagebrush distributes (audit F9):
// what it bundles that is not Sagebrush's own (MIT OR Apache-2.0) code, with
// the license texts, so that each package carries its notices itself.
//
//   - the Rust crates statically linked into its engines: the normal
//     dependencies of its root crates in engine/ (Cargo metadata, on every
//     platform), each with its license and the license files of its source;
//   - derived code and data, from the sections of NOTICE.md.
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
  { file: "packages/sagebrush/THIRD-PARTY-NOTICES.txt", what: "the npm package `sagebrush`", crates: ["sagebrush-web"], parts: ["cpython", "numpy", "arm", "fdlibm", "smalljac", "cremona"], artistic: "packages/sagebrush" },
];

const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], { cwd: join(root, "engine"), maxBuffer: 1 << 28 }).toString());
const byId = new Map(meta.packages.map((p) => [p.id, p]));
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));

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
function licenseTexts(p) {
  const dir = dirname(p.manifest_path);
  return readdirSync(dir).filter((f) => LICENSE_FILE.test(f) && !/\.(rs|toml|json)$/.test(f)).sort().map((f) => [f, readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n").trim()]);
}

// what must never be linked into a package: the FLINT bindings and the
// oracle crate (LGPL, references for tests only), or any (L)GPL crate
function gate(pkg, all) {
  const bad = all.filter((p) => ["sagebrush-flint", "sagebrush-oracle"].includes(p.name) || /\b(L?GPL|AGPL)/.test(p.license ?? ""));
  if (bad.length) throw new Error(`${pkg.file}: ${bad.map((p) => `${p.name} (${p.license})`).join(", ")} would be linked into ${pkg.what}`);
}

function render(pkg) {
  const all = closure(pkg.crates);
  gate(pkg, all);
  const own = all.filter((p) => !p.source);
  const ext = all.filter((p) => p.source).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const texts = new Map(); // hash -> {text, users: [name version (file)]}
  const rows = ext.map((p) => {
    const files = licenseTexts(p);
    for (const [f, t] of files) {
      const h = createHash("sha256").update(t).digest("hex");
      if (!texts.has(h)) texts.set(h, { text: t, users: [] });
      texts.get(h).users.push(`${p.name} ${p.version} (${f})`);
    }
    return `${p.name} ${p.version}: ${p.license ?? p.license_file ?? "see its license files"}${files.length ? "" : " [no license file in the crate; its license's standard text applies]"}`;
  });
  const out = [
    `Third-party notices for ${pkg.what}`,
    `(generated by scripts/third-party-notices.mjs; do not edit)`,
    "",
    `Sagebrush itself (Copyright (c) 2026 SageMath, Inc.) is licensed under the MIT license or the Apache License 2.0, at your option. This package also contains the following, under their own terms.`,
    "",
    "== Derived code and data ==",
    "",
    ...pkg.parts.flatMap((k) => [PARTS[k](), ""]),
    `== Rust crates compiled into the engines (${ext.length}) ==`,
    "",
    `Sagebrush's own crates: ${own.map((p) => p.name).sort().join(", ")}. The list includes dependencies on every platform and those used only while compiling (procedural macros), so it covers more than any one build contains.`,
    "",
    ...rows,
    "",
    "== License texts of those crates ==",
    "",
    ...[...texts.values()].sort((a, b) => a.users[0].localeCompare(b.users[0])).flatMap(({ text, users }) => ["-".repeat(72), "Used by: " + users.join(", "), "-".repeat(72), "", text, ""]),
  ];
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
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
