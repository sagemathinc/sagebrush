// Install a freshly built engine module at its committed path, bytes only.
// fs.copyFileSync also copies the source's mode, and cargo writes .wasm
// outputs 0755, so a copy left wasm/sagebrush-engine.wasm executable: git saw
// a mode change and CI's "differs from a fresh build" warning fired even when
// the bytes were identical.  The committed file is 0644.
//
// The bytes go to a temp file in the same directory, which is completed and
// set 0644, then renamed onto dst: a failed or interrupted write never leaves
// a partial dst (CORR-213-1), and the temp is removed on failure.
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export function installWasm(src, dst, io = fs) {
  const bytes = io.readFileSync(src);
  const tmp = join(dirname(dst), `.${basename(dst)}.${process.pid}.${Date.now()}.tmp`);
  try {
    io.writeFileSync(tmp, bytes, { flag: "wx", mode: 0o644 });
    io.chmodSync(tmp, 0o644); // (the umask may have narrowed the create mode)
    io.renameSync(tmp, dst);
  } catch (e) {
    try {
      io.rmSync(tmp, { force: true });
    } catch {}
    throw e;
  }
  return bytes.length;
}

// A module without its custom sections (names, producers, debug info): what
// ships of a wasm module built for size (scripts/build-mp.mjs).
export function stripCustomSections(b) {
  const parts = [b.subarray(0, 8)];
  let i = 8;
  while (i < b.length) {
    const start = i;
    const id = b[i++];
    let size = 0, shift = 0, byte;
    do {
      byte = b[i++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    i += size;
    if (id !== 0) parts.push(b.subarray(start, i));
  }
  return Buffer.concat(parts);
}

// The modules' panic messages name the registry and git crates' source files, by the Cargo home's absolute path.
// Written as CI's, a build anywhere gives CI's bytes (and so its pins); the Cargo home itself stays where it is.
export const CI_CARGO_HOME = "/home/runner/.cargo";
export const cargoHome = (env = process.env) => env.CARGO_HOME || join(homedir(), ".cargo");
/** RUSTFLAGS with the Cargo home remapped to CI's, first, and the caller's own flags after it (once). */
export function remappedRustflags(env = process.env) {
  const remap = `--remap-path-prefix=${cargoHome(env)}=${CI_CARGO_HOME}`;
  const own = env.RUSTFLAGS ?? "";
  return own.split(/\s+/).includes(remap) ? own : own ? `${remap} ${own}` : remap;
}
/** Whether a built module names this machine's Cargo home (when it isn't CI's): a build that wasn't remapped. */
export function namesLocalCargoHome(bytes, env = process.env) {
  const home = cargoHome(env);
  return home !== CI_CARGO_HOME && Buffer.from(bytes).includes(Buffer.from(home + "/"));
}

/** The lock file of a cargo target: beside its real path, so every spelling of one target names one lock (for a
 * target not there yet, or removed meanwhile, beside its parent's real path; the target itself isn't made here). */
export function targetLockPath(target, io = fs) {
  try {
    return io.realpathSync(target) + ".lock";
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  io.mkdirSync(dirname(target), { recursive: true });
  return join(io.realpathSync(dirname(target)), basename(target)) + ".lock";
}

// A command run holding a kernel lock on `lock`: flock(1) on Linux, lockf(1) on macOS; null elsewhere.  The kernel
// releases the lock when the holder's descriptor closes, however it exits, so there is no stale lock to recover.
// Without `wait`, a lock held elsewhere makes it exit LOCK_BUSY at once instead.
export const LOCK_BUSY = 75; // (EX_TEMPFAIL: lockf's own timeout code, and the conflict code flock is given)
export function lockedCommand(lock, argv, { wait = true, platform = process.platform } = {}) {
  if (platform === "linux") return ["flock", "-E", String(LOCK_BUSY), ...(wait ? [] : ["-n"]), lock, ...argv];
  if (platform === "darwin") return ["lockf", "-k", ...(wait ? [] : ["-t", "0"]), lock, ...argv];
  return null;
}

const runLocked = (lock, argv, wait, env) => {
  const cmd = lockedCommand(lock, argv, { wait });
  if (!cmd) return null;
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", env: { ...env, SAGEBRUSH_TARGET_LOCK: lock } });
  if (r.error?.code === "ENOENT") return null; // (no flock/lockf on this machine)
  if (r.error) throw r.error;
  return r.status ?? 1;
};

// Run this script again holding the cargo target's build lock, unless it already holds it: one build at a time in a
// target (two in one checkout, or a module builder run on its own).  Returns the locked run's exit status for the
// caller to exit with, or null when the caller is the locked run, or where there is no lock tool (then unlocked).
export function relaunchUnderTargetLock(target, argv, { env = process.env, log = console.error } = {}) {
  const lock = targetLockPath(target);
  if (env.SAGEBRUSH_TARGET_LOCK === lock) return null;
  const first = runLocked(lock, argv, false, env);
  if (first === null) {
    log(`engine: no flock or lockf here: building without the target's lock (${target})`);
    return null;
  }
  if (first !== LOCK_BUSY) return first;
  log(`engine: waiting for another build in ${target} to finish`);
  return runLocked(lock, argv, true, env);
}

// Remove a cargo target if no build holds its lock (the lock is taken without waiting, and held while it is removed):
// "removed", "busy", "failed" (rm failed), or "unsupported" where there is no lock tool.  The lock file itself stays: removing it could
// let two builds each lock a different file of that name.
export function removeTargetIfIdle(target, { env = process.env } = {}) {
  const status = runLocked(targetLockPath(target), ["rm", "-rf", target], false, env);
  return status === null ? "unsupported" : status === LOCK_BUSY ? "busy" : status === 0 ? "removed" : "failed";
}
