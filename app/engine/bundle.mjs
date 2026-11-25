// The engine the desktop app ships on macOS and Linux (design/native-desktop.md §5: one
// known-good engine, so the first run works offline): run before `tauri build` (or
// `cargo build`) there, after app/dist is built (node app/build-frontend.mjs).
//
//   node app/engine/bundle.mjs [--cache DIR]
//
// It puts into app/src-tauri/ (all ignored by git):
//   binaries/sagebrush-node-<target triple>        Node, pinned below by version and SHA-256: the engine's runtime
//                                                  (tauri.macos.conf.json's and tauri.linux.conf.json's externalBin;
//                                                  on macOS signed with the app)
//   engine/*.mjs                                   the engine (app/engine/, its tests and this file left out)
//   engine/root/                                   the interpreter's files from app/dist: the worker, its
//                                                  WebAssembly modules, the library's chunks and the packages
//   agent/                                         the agent the app hosts, with agent/MANIFEST.json
//                                                  (app/engine/agent-bundle.mjs; build.rs compiles its SHA-256 in)
// The download is checked against the pinned SHA-256 before anything is
// unpacked; a mismatch, or a failed download, fails this (never skipped). The same for the agent's release tarball.
// --cache DIR keeps the downloads (default: ~/.cache/sagebrush-node).
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bundleAgent } from "./agent-bundle.mjs";

// Node 24.21.0 (the version CI's size gate pins), from nodejs.org/dist/v24.21.0/SHASUMS256.txt
export const NODE = {
  version: "24.21.0",
  "darwin-arm64": { file: "node-v24.21.0-darwin-arm64.tar.xz", sha256: "6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe", triple: "aarch64-apple-darwin" },
  // (Linux: the executable as shipped has RUNPATH $ORIGIN/../lib, set here before anything hashes it; patched_sha256
  //  is that result, checked)
  "linux-x64": { file: "node-v24.21.0-linux-x64.tar.xz", sha256: "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6", triple: "x86_64-unknown-linux-gnu", patched_sha256: "81f6b048127364cc918366fe542e580225634f0724801623b82c252fdcacc502" },
};
// The AppImage's bundler (linuxdeploy) sets RUNPATH $ORIGIN/../lib on every executable in usr/bin, the Node too, after
// the app (and the agent's manifest, with the Node's SHA-256) is built. So on Linux the Node gets exactly that RUNPATH
// here first, from patchelf pinned below (the static build of the release linuxdeploy's own patchelf is): the bundler's
// patch then changes no byte (checked by the AppImage's self-test), and the .deb and .rpm ship the same bytes.
export const PATCHELF = { version: "0.19.1", file: "patchelf-0.19.1-x86_64.tar.gz", sha256: "a6818fef80128fb354423234ecacdcca3e993913d774e5d8346bc63f70fed4cf" };
// the interpreter's files, from app/dist
const ROOT_FILES = ["sagebrush-worker.js", "sagebrush-engine.wasm", "sagebrush-raster.wasm", "sagebrush-nd.wasm", "sagebrush-mp.wasm", "lib", "pkg", "pkgset", "pkgmeta"];
const ENGINE_FILES = ["frames.mjs", "files.mjs", "serve.mjs", "thread.mjs", "main.mjs"];

const here = fileURLToPath(new URL(".", import.meta.url));
const app = join(here, "..");
const tauri = join(app, "src-tauri");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** A download kept in `cache`, checked against its pinned SHA-256 before use (a mismatch or a failed download fails). */
function fetchPinned(cache, file, url, want) {
  const at = join(cache, file);
  if (existsSync(at) && sha256(readFileSync(at)) === want) return at;
  rmSync(at, { force: true });
  const part = at + ".part";
  execFileSync("curl", ["-fsSL", "--retry", "3", "-o", part, url], { stdio: "inherit" });
  const got = sha256(readFileSync(part));
  if (got !== want) {
    rmSync(part, { force: true });
    throw new Error(`${file}: SHA-256 ${got}, not the pinned ${want}`);
  }
  cpSync(part, at);
  rmSync(part, { force: true });
  return at;
}

function main(argv) {
  let cache = join(homedir(), ".cache", "sagebrush-node");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cache") cache = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]} (usage: node app/engine/bundle.mjs [--cache DIR])`);
  }
  const key = `${process.platform}-${process.arch}`;
  const pin = NODE[key];
  if (!pin) throw new Error(`the app ships its engine on macOS (Apple silicon) and Linux (x64) only, not ${key}`);
  const dist = join(app, "dist");
  for (const f of ROOT_FILES) if (!existsSync(join(dist, f))) throw new Error(`app/dist has no ${f}: build it first (node app/build-frontend.mjs)`);

  // Node: downloaded once, checked, then only its executable taken
  mkdirSync(cache, { recursive: true });
  const archive = join(cache, pin.file);
  if (!existsSync(archive) || sha256(readFileSync(archive)) !== pin.sha256) {
    rmSync(archive, { force: true });
    const part = archive + ".part";
    execFileSync("curl", ["-fsSL", "--retry", "3", "-o", part, `https://nodejs.org/dist/v${NODE.version}/${pin.file}`], { stdio: "inherit" });
    const got = sha256(readFileSync(part));
    if (got !== pin.sha256) {
      rmSync(part, { force: true });
      throw new Error(`${pin.file}: SHA-256 ${got}, not the pinned ${pin.sha256}`);
    }
    cpSync(part, archive);
    rmSync(part, { force: true });
  }
  const unpack = join(tmpdir(), `sagebrush-node-${process.pid}`);
  rmSync(unpack, { recursive: true, force: true });
  mkdirSync(unpack, { recursive: true });
  const top = pin.file.replace(/\.tar\.xz$/, "");
  // (Node, its licence, and its own npm: the agent's dependencies are installed with the pinned Node's npm)
  execFileSync("tar", ["-xJf", archive, "-C", unpack, `${top}/bin/node`, `${top}/LICENSE`, `${top}/lib/node_modules/npm`]);
  mkdirSync(join(tauri, "binaries"), { recursive: true });
  const bin = join(tauri, "binaries", `sagebrush-node-${pin.triple}`);
  copyFileSync(join(unpack, top, "bin", "node"), bin);
  chmodSync(bin, 0o755);
  if (pin.patched_sha256) {
    const pe = fetchPinned(cache, PATCHELF.file, `https://github.com/NixOS/patchelf/releases/download/${PATCHELF.version}/${PATCHELF.file}`, PATCHELF.sha256);
    const peDir = join(unpack, "patchelf");
    mkdirSync(peDir, { recursive: true });
    execFileSync("tar", ["-xzf", pe, "-C", peDir, "./bin/patchelf"]);
    execFileSync(join(peDir, "bin", "patchelf"), ["--set-rpath", "$ORIGIN/../lib", bin]);
    chmodSync(bin, 0o755);
    const got = sha256(readFileSync(bin));
    if (got !== pin.patched_sha256) throw new Error(`the Node with its RUNPATH: SHA-256 ${got}, not the pinned ${pin.patched_sha256}`);
  }
  // (Node's own licence, with the engine's files: its notices travel with it)
  const engine = join(tauri, "engine");
  rmSync(engine, { recursive: true, force: true });
  mkdirSync(join(engine, "root"), { recursive: true });
  copyFileSync(join(unpack, top, "LICENSE"), join(engine, "NODE-LICENSE.txt"));
  // the agent: the manifest names the Node as shipped (Linux and unsigned builds check its exact bytes)
  const nodeBytes = readFileSync(bin);
  const agent = bundleAgent({
    tauri, cache,
    nodeBin: join(unpack, top, "bin", "node"),
    npmCli: join(unpack, top, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    node: { version: NODE.version, sha256: sha256(nodeBytes), size: nodeBytes.length },
  });
  rmSync(unpack, { recursive: true, force: true });

  // the engine, and the interpreter's files
  for (const f of ENGINE_FILES) copyFileSync(join(here, f), join(engine, f));
  // (an ES module package: the engine's .mjs files are modules anyway; the worker's .js must be one too, and the
  // engine's thread loads it as one whatever this says)
  writeFileSync(join(engine, "package.json"), JSON.stringify({ type: "module", private: true }) + "\n");
  for (const f of ROOT_FILES) cpSync(join(dist, f), join(engine, "root", f), { recursive: true });
  const n = readdirSync(join(engine, "root", "lib")).length;
  console.log(`engine bundled: Node ${NODE.version} (${pin.triple}), ${ENGINE_FILES.length} engine files, the interpreter's files (${n} entries in lib/)`);
  console.log(`agent bundled: ${agent.files} files, MANIFEST.json ${agent.sha256}`);
}

main(process.argv.slice(2));
