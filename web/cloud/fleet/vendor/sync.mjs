// The fleet protocol's pure core, vendored byte for byte from sagebrush-agent (MIT: vendor/fleet-core/LICENSE) at one
// commit of its main branch. vendor/fleet-core/vendor.json names the commit and each file's sha256; CI checks the
// sha256s (test-fleet.mjs), and reviewers check the files against their own clone of sagebrush-agent:
//
//   node web/cloud/fleet/vendor/sync.mjs verify <agent-clone>            each file is the commit's, byte for byte
//   node web/cloud/fleet/vendor/sync.mjs sync <agent-clone> <commit>     replace the files with that commit's
//
// The files are lib/fleet/core/*.mjs (the whole directory: the Worker loads the core as a page does), the frozen schemas
// schema/fleet/fleet.schema.json and reasons.json that the core's useSchemas() checks, and LICENSE.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "fleet-core");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const git = (clone, ...a) => execFileSync("git", ["-C", clone, ...a], { maxBuffer: 1 << 26 });
const show = (clone, commit, path) => git(clone, "show", `${commit}:${path}`);

const [mode, clone, wanted] = process.argv.slice(2);
if (mode === "sync" && clone && wanted) {
  const commit = git(clone, "rev-parse", "--verify", `${wanted}^{commit}`).toString().trim();
  const core = git(clone, "ls-tree", "--name-only", commit, "lib/fleet/core/").toString().split("\n").filter((p) => p.endsWith(".mjs"));
  const from = [...core, "schema/fleet/fleet.schema.json", "schema/fleet/reasons.json", "LICENSE"];
  rmSync(here, { recursive: true, force: true });
  const files = {};
  for (const path of from) {
    const name = path.startsWith("lib/fleet/core/") ? `core/${path.slice(15)}` : path.startsWith("schema/fleet/") ? `schema/${path.slice(13)}` : path;
    const bytes = show(clone, commit, path);
    mkdirSync(dirname(join(here, name)), { recursive: true });
    writeFileSync(join(here, name), bytes);
    files[name] = { from: path, sha256: sha256(bytes) };
  }
  const v = {
    about: "The fleet protocol's pure core, vendored unchanged from sagebrush-agent for the fleet Worker (web/cloud/fleet/). Each file is the commit's, byte for byte; vendor/sync.mjs verify re-checks them against a clone.",
    repository: "https://github.com/sagemathinc/sagebrush-agent",
    commit,
    license: "MIT",
    files,
  };
  writeFileSync(join(here, "vendor.json"), JSON.stringify(v, null, 1) + "\n");
  console.log(`vendored ${Object.keys(files).length} files at ${commit}`);
} else if (mode === "verify" && clone) {
  const v = JSON.parse(readFileSync(join(here, "vendor.json"), "utf8"));
  const core = git(clone, "ls-tree", "--name-only", v.commit, "lib/fleet/core/").toString().split("\n").filter((p) => p.endsWith(".mjs"));
  const listed = Object.values(v.files).map((f) => f.from);
  for (const p of core) if (!listed.includes(p)) throw new Error(`${p} is in the commit's core but not vendored`);
  for (const [name, f] of Object.entries(v.files)) {
    const theirs = show(clone, v.commit, f.from), ours = readFileSync(join(here, name));
    if (!theirs.equals(ours)) throw new Error(`${name} isn't ${f.from} at ${v.commit}`);
    if (sha256(ours) !== f.sha256) throw new Error(`${name}'s sha256 isn't vendor.json's`);
  }
  const extra = (d) => readdirSync(join(here, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? extra(join(d, e.name)) : [join(d, e.name)]));
  for (const f of extra("")) if (f !== "vendor.json" && !Object.hasOwn(v.files, f)) throw new Error(`${f} isn't in vendor.json`);
  console.log(`${Object.keys(v.files).length} files: sagebrush-agent ${v.commit}, byte for byte`);
} else {
  console.error("usage: sync.mjs verify <agent-clone> | sync <agent-clone> <commit>");
  process.exit(2);
}
