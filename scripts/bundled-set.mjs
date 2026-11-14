// The package set the CLI carries (scripts/build-cli.mjs): the notebooks' set (pandas, source only: the set
// web/build.ts names in pkgset/latest.json, the same id) in one file, sagebrush-pkgset.json, beside the bundle and
// in the npm package's dist/. The CLI, the notebook server and the Jupyter kernel read it at the first import
// nothing else provides (src/pkgcache.ts bundledSet), so pandas works offline. It is never part of the bundle
// (scripts/size-budget.mjs optionalLeaks), and every byte is checked against the set's id when it is used.
//   node scripts/bundled-set.mjs OUT_FILE        (needs tsc's dist/, as scripts/optional-packages.mjs does)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BUNDLED_PACKAGES = ["pandas"];

/** Build the set and write it to `file` as {format, v, S, index, chunks}; returns S. */
export function writeBundledSet(file) {
  const tmp = mkdtempSync(join(tmpdir(), "sagebrush-pkgset-"));
  try {
    const S = execFileSync("node", [join(root, "scripts", "optional-packages.mjs"), "build", "--out", tmp, ...BUNDLED_PACKAGES], { encoding: "utf8" }).trim().split("\n").pop();
    if (!/^[0-9a-f]{64}$/.test(S)) throw new Error(`the bundled package set: not an id: ${JSON.stringify(S)}`);
    const chunks = {};
    for (const f of readdirSync(join(tmp, "pkg")).sort()) chunks[f.replace(/\.json$/, "")] = readFileSync(join(tmp, "pkg", f), "utf8");
    const index = readFileSync(join(tmp, "pkgset", S + ".json"), "utf8");
    writeFileSync(file, JSON.stringify({ format: "sagebrush-bundled-set", v: 1, S, index, chunks }) + "\n");
    return S;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error("usage: node scripts/bundled-set.mjs OUT_FILE");
    process.exit(2);
  }
  console.log(writeBundledSet(process.argv[2]));
}
