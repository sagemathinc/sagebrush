// The engine the Mac app ships (design/native-desktop.md §5: one known-good
// engine, so the first run works offline): run before `tauri build` (or
// `cargo build`) for macOS, after app/dist is built (node app/build-frontend.mjs).
//
//   node app/engine/bundle.mjs [--cache DIR]
//
// It puts into app/src-tauri/ (all ignored by git):
//   binaries/sagebrush-node-aarch64-apple-darwin   Node, pinned below by version and SHA-256: the engine's runtime
//                                                  (tauri.macos.conf.json's externalBin: signed with the app)
//   engine/*.mjs                                   the engine (app/engine/, its tests and this file left out)
//   engine/root/                                   the interpreter's files from app/dist: the worker, its
//                                                  WebAssembly modules, the library's chunks and the packages
// The download is checked against the pinned SHA-256 before anything is
// unpacked; a mismatch, or a failed download, fails this (never skipped).
// --cache DIR keeps the download (default: ~/.cache/sagebrush-node).
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Node 24.21.0 (the version CI's size gate pins), from nodejs.org/dist/v24.21.0/SHASUMS256.txt
export const NODE = {
  version: "24.21.0",
  "darwin-arm64": { file: "node-v24.21.0-darwin-arm64.tar.xz", sha256: "6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe", triple: "aarch64-apple-darwin" },
};
// the interpreter's files, from app/dist
const ROOT_FILES = ["sagebrush-worker.js", "sagebrush-engine.wasm", "sagebrush-raster.wasm", "sagebrush-nd.wasm", "sagebrush-mp.wasm", "lib", "pkg", "pkgset", "pkgmeta"];
const ENGINE_FILES = ["frames.mjs", "serve.mjs", "thread.mjs", "main.mjs"];

const here = fileURLToPath(new URL(".", import.meta.url));
const app = join(here, "..");
const tauri = join(app, "src-tauri");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

function main(argv) {
  let cache = join(homedir(), ".cache", "sagebrush-node");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cache") cache = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]} (usage: node app/engine/bundle.mjs [--cache DIR])`);
  }
  const key = `${process.platform}-${process.arch}`;
  const pin = NODE[key];
  if (!pin) throw new Error(`the app ships its engine on macOS (Apple silicon) only, not ${key}`);
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
  execFileSync("tar", ["-xJf", archive, "-C", unpack, `${top}/bin/node`, `${top}/LICENSE`]);
  mkdirSync(join(tauri, "binaries"), { recursive: true });
  const bin = join(tauri, "binaries", `sagebrush-node-${pin.triple}`);
  copyFileSync(join(unpack, top, "bin", "node"), bin);
  chmodSync(bin, 0o755);
  // (Node's own licence, with the engine's files: its notices travel with it)
  const engine = join(tauri, "engine");
  rmSync(engine, { recursive: true, force: true });
  mkdirSync(join(engine, "root"), { recursive: true });
  copyFileSync(join(unpack, top, "LICENSE"), join(engine, "NODE-LICENSE.txt"));
  rmSync(unpack, { recursive: true, force: true });

  // the engine, and the interpreter's files
  for (const f of ENGINE_FILES) copyFileSync(join(here, f), join(engine, f));
  // (an ES module package: the engine's .mjs files are modules anyway; the worker's .js must be one too, and the
  // engine's thread loads it as one whatever this says)
  writeFileSync(join(engine, "package.json"), JSON.stringify({ type: "module", private: true }) + "\n");
  for (const f of ROOT_FILES) cpSync(join(dist, f), join(engine, "root", f), { recursive: true });
  const n = readdirSync(join(engine, "root", "lib")).length;
  console.log(`engine bundled: Node ${NODE.version} (${pin.triple}), ${ENGINE_FILES.length} engine files, the interpreter's files (${n} entries in lib/)`);
}

main(process.argv.slice(2));
