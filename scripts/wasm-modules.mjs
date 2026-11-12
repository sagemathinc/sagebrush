// The four WebAssembly modules in wasm/ and their pins (design/wasm-artifacts.md).
// wasm/pins.json holds each module's sha256 and exact length; bytes match a pin
// when both are equal.  This module reads the pins, says what state each file
// in wasm/ is in, and checks a run's modules against its mode:
//   pinned  every module matches pins.json (CI, releases, packaging, size, timing)
//   local   a module built on this machine may stand in for its pin, if its
//           sidecar wasm/<module>.local.json matches it (SAGEBRUSH_WASM_LOCAL=1,
//           never under CI=true)
// A module written by scripts/wasm-fetch.mjs is recorded in wasm/.installed.json,
// so a later pin may replace it (a branch switch); bytes that match neither the
// pin, that record nor a sidecar are unidentified, and never used.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MODULES = ["sagebrush-engine.wasm", "sagebrush-raster.wasm", "sagebrush-mp.wasm", "sagebrush-nd.wasm"];
export const BUILDERS = {
  "sagebrush-engine.wasm": "node scripts/build-engine.mjs",
  "sagebrush-raster.wasm": "node scripts/build-engine.mjs (or scripts/build-raster.mjs)",
  "sagebrush-mp.wasm": "node scripts/build-mp.mjs",
  "sagebrush-nd.wasm": "node scripts/build-engine.mjs (or scripts/build-nd.mjs)",
};
const MAX_BYTES = 64 << 20; // no module comes near this; a pin above it is a mistake

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const pinsPath = (root = ROOT) => join(root, "wasm", "pins.json");
export const modulePath = (name, root = ROOT) => join(root, "wasm", name);
const stampPath = (root) => join(root, "wasm", ".installed.json");
const sidecarPath = (name, root) => join(root, "wasm", `${name}.local.json`);

// pins.json: {"v": 1, "modules": {<name>: {"sha256": <64 hex>, "bytes": <n>}}}, exactly the four names
export function parsePins(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`wasm/pins.json is not valid JSON: ${e.message}`);
  }
  if (doc?.v !== 1 || typeof doc.modules !== "object" || doc.modules === null) throw new Error('wasm/pins.json: expected {"v": 1, "modules": {...}}');
  const names = Object.keys(doc.modules).sort();
  if (JSON.stringify(names) !== JSON.stringify([...MODULES].sort())) throw new Error(`wasm/pins.json must pin exactly ${MODULES.join(", ")}; it has ${names.join(", ") || "none"}`);
  for (const name of MODULES) {
    const p = doc.modules[name];
    if (typeof p?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.sha256)) throw new Error(`wasm/pins.json: ${name} needs a sha256 of 64 lowercase hex digits`);
    if (!Number.isSafeInteger(p.bytes) || p.bytes <= 0 || p.bytes > MAX_BYTES) throw new Error(`wasm/pins.json: ${name} needs a byte count between 1 and ${MAX_BYTES}`);
    if (Object.keys(p).sort().join() !== "bytes,sha256") throw new Error(`wasm/pins.json: ${name} has keys other than sha256 and bytes`);
  }
  return doc.modules;
}
export const loadPins = (root = ROOT) => parsePins(readFileSync(pinsPath(root), "utf8"));
export function formatPins(modules) {
  const lines = MODULES.map((n, i) => `    ${JSON.stringify(n)}: { "sha256": ${JSON.stringify(modules[n].sha256)}, "bytes": ${modules[n].bytes} }${i < MODULES.length - 1 ? "," : ""}`);
  return `{\n  "v": 1,\n  "modules": {\n${lines.join("\n")}\n  }\n}\n`;
}
export const matches = (bytes, pin) => bytes.length === pin.bytes && sha256(bytes) === pin.sha256;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
// write JSON beside its target and rename it into place: readers never see half a file
export function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o644 });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
export const readStamp = (root = ROOT) => readJson(stampPath(root)) ?? {};
export function recordInstalled(name, pin, root = ROOT) {
  const stamp = readStamp(root);
  stamp[name] = { sha256: pin.sha256, bytes: pin.bytes };
  writeJsonAtomic(stampPath(root), stamp);
}

// The sidecar a builder writes beside a module it built here: wasm/<name>.local.json
export function writeSidecar(name, root = ROOT) {
  const bytes = readFileSync(modulePath(name, root));
  const git = (args) => {
    try {
      return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  writeJsonAtomic(sidecarPath(name, root), { sha256: sha256(bytes), bytes: bytes.length, commit: git(["rev-parse", "HEAD"]), engineStatus: git(["status", "--porcelain", "--", "engine"]) });
}

// One module's state: pinned, installed (bytes this machine fetched for another pin),
// local (built here, sidecar matches), unidentified, or missing.
export function moduleState(name, pin, root = ROOT) {
  const path = modulePath(name, root);
  if (!existsSync(path)) return { name, state: "missing" };
  if (statSync(path).size > MAX_BYTES) return { name, state: "unidentified", bytes: statSync(path).size };
  const bytes = readFileSync(path);
  const got = { sha256: sha256(bytes), bytes: bytes.length };
  if (got.bytes === pin.bytes && got.sha256 === pin.sha256) return { name, state: "pinned", ...got };
  const sidecar = readJson(sidecarPath(name, root));
  if (sidecar && sidecar.sha256 === got.sha256 && sidecar.bytes === got.bytes) return { name, state: "local", ...got, sidecar };
  const stamp = readStamp(root)[name];
  if (stamp && stamp.sha256 === got.sha256 && stamp.bytes === got.bytes) return { name, state: "installed", ...got };
  return { name, state: "unidentified", ...got };
}

export const missingMessage = (name) => `wasm/${name} is missing: run node scripts/wasm-fetch.mjs (or build it: ${BUILDERS[name]})`;

// The mode a run may use: local only on request, and never in CI
export function runMode(env = process.env) {
  if (env.SAGEBRUSH_WASM_LOCAL === "1") {
    if (env.CI === "true") throw new Error("SAGEBRUSH_WASM_LOCAL=1 is refused under CI=true: CI runs pinned modules only");
    return "local";
  }
  return "pinned";
}

// Check all four modules for a run in `mode`, immediately before reading them.  Returns
// one line per module for the run's log; throws, naming every module that fails.
export function checkModules({ root = ROOT, mode = runMode(), pins = loadPins(root) } = {}) {
  const lines = [], errors = [];
  for (const name of MODULES) {
    const s = moduleState(name, pins[name], root);
    if (s.state === "pinned") lines.push(`${name}: pinned`);
    else if (s.state === "missing") errors.push(missingMessage(name));
    else if (s.state === "local" && mode === "local") lines.push(`${name}: using a local build (sha256 ${s.sha256}, ${s.bytes} bytes), not the pinned one (${pins[name].sha256})`);
    else if (s.state === "local") errors.push(`wasm/${name} is a local build (sha256 ${s.sha256}), not its pin: set SAGEBRUSH_WASM_LOCAL=1 to use it, or run node scripts/wasm-fetch.mjs --force`);
    else if (s.state === "installed") errors.push(`wasm/${name} is the module of an earlier pin (sha256 ${s.sha256}): run node scripts/wasm-fetch.mjs`);
    else errors.push(`wasm/${name} matches neither its pin (sha256 ${pins[name].sha256}, ${pins[name].bytes} bytes) nor a local build's sidecar: run node scripts/wasm-fetch.mjs --force, or rebuild it (${BUILDERS[name]})`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return lines;
}

// pins.json against the modules committed at a git revision (the blobs, not the working tree).
// The set rule: all four committed -> each is compared with its pin; none committed -> nothing to
// compare (after the modules stop being committed); one to three committed -> a failure naming the
// missing ones.  Any git failure (not a repository, an unknown revision, a read error) throws.
export function committedMismatches({ root = ROOT, rev = "HEAD", pins = loadPins(root) } = {}) {
  const git = (args, opts = {}) => execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"], ...opts });
  let commit;
  try {
    commit = git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { encoding: "utf8" }).trim();
  } catch (e) {
    throw new Error(`git: ${rev} is not a commit in ${root}${e.stderr && String(e.stderr).trim() ? `: ${String(e.stderr).trim()}` : ""}`);
  }
  const listed = new Map();
  for (const name of MODULES) {
    const line = git(["ls-tree", commit, "--", `wasm/${name}`], { encoding: "utf8" }).trim();
    if (line) listed.set(name, line);
  }
  if (listed.size === 0) return [];
  const missing = MODULES.filter((n) => !listed.has(n));
  if (missing.length) return [`only ${listed.size} of the ${MODULES.length} modules are committed at ${rev} (${commit.slice(0, 12)}): missing ${missing.map((n) => `wasm/${n}`).join(", ")}`];
  const out = [];
  for (const name of MODULES) {
    if (!/^100644 blob [0-9a-f]+\t/.test(listed.get(name))) {
      out.push(`${name}: at ${rev} it is not a regular file (${listed.get(name).split("\t")[0]})`);
      continue;
    }
    const bytes = git(["cat-file", "blob", `${commit}:wasm/${name}`], { maxBuffer: MAX_BYTES * 2 });
    if (!matches(bytes, pins[name])) out.push(`${name}: committed ${bytes.length} bytes, sha256 ${sha256(bytes)}; pinned ${pins[name].bytes} bytes, sha256 ${pins[name].sha256}`);
  }
  return out;
}
