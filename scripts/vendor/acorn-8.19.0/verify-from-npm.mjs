// Re-checks the vendored files against the npm tarball (for reviewers; it
// needs the network, so CI checks only the sha256s in vendor.json):
//   node scripts/vendor/acorn-8.19.0/verify-from-npm.mjs
// The tarball must match vendor.json's integrity, and each vendored file must
// be byte for byte the tarball's file it names, with the sha256 recorded.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const v = JSON.parse(readFileSync(join(here, "vendor.json"), "utf8"));
const tgz = Buffer.from(await (await fetch(v.tarball)).arrayBuffer());
const integrity = "sha512-" + createHash("sha512").update(tgz).digest("base64");
if (integrity !== v.integrity) throw new Error(`the tarball's integrity is ${integrity}, not ${v.integrity}`);
const d = mkdtempSync(join(tmpdir(), "acorn-"));
try {
  writeFileSync(join(d, "p.tgz"), tgz);
  execFileSync("tar", ["-xzf", "p.tgz"], { cwd: d });
  for (const [name, f] of Object.entries(v.files)) {
    const theirs = readFileSync(join(d, f.from)), ours = readFileSync(join(here, name));
    const sha = createHash("sha256").update(ours).digest("hex");
    if (!theirs.equals(ours)) throw new Error(`${name} isn't the tarball's ${f.from}`);
    if (sha !== f.sha256) throw new Error(`${name}'s sha256 is ${sha}, not ${f.sha256}`);
    console.log(`${name}: the tarball's ${f.from}, sha256 ${sha}`);
  }
} finally {
  rmSync(d, { recursive: true, force: true });
}
