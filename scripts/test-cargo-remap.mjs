// ci: checks.3 order=63
// Every WebAssembly module builder writes the cargo home as CI's (#1899; remappedRustflags, scripts/install-engine-wasm.mjs,
// #1902): the engine (scripts/build-engine.mjs), nd, the PNG module and the multiprecision core each pass
// --remap-path-prefix=<CARGO_HOME>=/home/runner/.cargo first in RUSTFLAGS, so a build anywhere of the pins' source is
// the pinned bytes.  Each builder runs here against a stub `cargo` that records its RUSTFLAGS and package and fails,
// so nothing is built and nothing is written to wasm/.  The caller's RUSTFLAGS follow the remap (nd keeps its own
// flags instead, as before); with CARGO_HOME unset, the home's .cargo is the one remapped.
//
//   node scripts/test-cargo-remap.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "cargo-remap-"));
const bin = join(dir, "bin");
mkdirSync(bin);
const log = join(dir, "cargo.log");
// (the stub: one line per call, the package after -p, a tab, then RUSTFLAGS; then it fails, as a failed build does)
writeFileSync(join(bin, "cargo"), `#!/bin/sh
pkg=""; prev=""
for a in "$@"; do [ "$prev" = "-p" ] && pkg="$a"; prev="$a"; done
printf '%s\\t%s\\n' "$pkg" "$RUSTFLAGS" >> "${log}"
exit 1
`);
chmodSync(join(bin, "cargo"), 0o755);

const FAKE = join(dir, "fake cargo home");
const REMAP = `--remap-path-prefix=${FAKE}=/home/runner/.cargo`;
let n = 0;

// (run a snippet in a fresh node, as a builder's caller would, and read what the stub saw)
function run(code, env) {
  writeFileSync(log, "");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: root, encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, CARGO_TARGET_DIR: join(dir, "target"), ...env },
  });
  const seen = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
  return { status: r.status, seen };
}
const builders = [
  ["sagebrush-web", `await import(${JSON.stringify(join(root, "scripts", "build-engine.mjs"))})`],
  ["sagebrush-nd", `const { buildNd } = await import(${JSON.stringify(join(root, "scripts", "build-nd.mjs"))}); buildNd()`],
  ["sagebrush-raster", `const { buildRaster } = await import(${JSON.stringify(join(root, "scripts", "build-raster.mjs"))}); buildRaster()`],
  ["sagebrush-mp", `const { buildMp } = await import(${JSON.stringify(join(root, "scripts", "build-mp.mjs"))}); buildMp()`],
];
for (const [pkg, code] of builders) {
  // (a caller's CARGO_HOME, no RUSTFLAGS: the remap alone, or, for nd, the remap then its own flags)
  let r = run(code, { CARGO_HOME: FAKE });
  assert.notEqual(r.status, 0, `${pkg}: the stub's failure fails the build`);
  assert.equal(r.seen.length, 1, `${pkg}: cargo called once before the failure: ${JSON.stringify(r.seen)}`);
  assert.equal(r.seen[0][0], pkg, `${pkg}: the package built`);
  const flags = r.seen[0][1];
  assert.ok(flags === REMAP || (pkg === "sagebrush-nd" && flags.startsWith(`${REMAP} -C `)), `${pkg}: RUSTFLAGS ${JSON.stringify(flags)}, not the remap first`);
  // (the caller's RUSTFLAGS: after the remap; nd keeps its own flags, as it did before)
  r = run(code, { CARGO_HOME: FAKE, RUSTFLAGS: "-C debuginfo=0" });
  const withCaller = r.seen[0]?.[1] ?? "";
  if (pkg === "sagebrush-nd") assert.equal(withCaller, flags, "nd: its own flags, not the caller's");
  else assert.equal(withCaller, `${REMAP} -C debuginfo=0`, `${pkg}: the caller's RUSTFLAGS after the remap`);
  // (no CARGO_HOME: the home's .cargo)
  r = run(code, { HOME: join(dir, "home") });
  assert.ok((r.seen[0]?.[1] ?? "").startsWith(`--remap-path-prefix=${join(dir, "home", ".cargo")}=/home/runner/.cargo`), `${pkg}: with CARGO_HOME unset, ${JSON.stringify(r.seen[0]?.[1])}`);
  n += 6;
}
// (and nothing reached wasm/: every build stopped at the stub)
assert.equal(spawnSync("git", ["-C", root, "status", "--porcelain", "--", "wasm"], { encoding: "utf8" }).stdout.split("\n").filter((l) => l && !l.startsWith("??")).length, 0, "wasm/ unchanged");
n++;
rmSync(dir, { recursive: true, force: true });
console.log(`cargo remap: ${n} checks pass; each of the 4 module builders writes the cargo home as CI's`);
