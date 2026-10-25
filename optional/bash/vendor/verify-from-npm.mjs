// Re-checks every vendored package here against its npm tarball (for
// reviewers; it needs the network, so CI checks only the sha256s in
// sagebrush.json and each vendor.json):
//   node optional/bash/vendor/verify-from-npm.mjs
// Each tarball must match its vendor.json's integrity, and each vendored file
// must be byte for byte the tarball's file it names, with the sha256 recorded.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const dir of readdirSync(here).sort()) {
  if (!existsSync(join(here, dir, "vendor.json"))) continue;
  const v = JSON.parse(readFileSync(join(here, dir, "vendor.json"), "utf8"));
  const tgz = Buffer.from(await (await fetch(v.tarball)).arrayBuffer());
  const integrity = "sha512-" + createHash("sha512").update(tgz).digest("base64");
  if (integrity !== v.integrity) throw new Error(`${dir}: the tarball's integrity is ${integrity}, not ${v.integrity}`);
  const d = mkdtempSync(join(tmpdir(), "vendor-"));
  try {
    writeFileSync(join(d, "p.tgz"), tgz);
    execFileSync("tar", ["-xzf", "p.tgz"], { cwd: d });
    for (const [name, f] of Object.entries(v.files)) {
      const theirs = readFileSync(join(d, f.from)), ours = readFileSync(join(here, dir, name));
      const sha = createHash("sha256").update(ours).digest("hex");
      if (!theirs.equals(ours)) throw new Error(`${dir}/${name} isn't the tarball's ${f.from}`);
      if (sha !== f.sha256) throw new Error(`${dir}/${name}'s sha256 is ${sha}, not ${f.sha256}`);
      console.log(`${dir}/${name}: the tarball's ${f.from}, sha256 ${sha}`);
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
