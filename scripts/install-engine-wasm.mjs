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
import { randomBytes } from "node:crypto";
import { homedir, hostname } from "node:os";
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

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const readHolder = (dir, io) => {
  try {
    return JSON.parse(io.readFileSync(join(dir, "holder.json"), "utf8"));
  } catch {
    return null;
  }
};

/** The lock directory of a cargo target: beside its real path, so every spelling of one target names one lock. */
export function targetLockPath(target, io = fs) {
  io.mkdirSync(target, { recursive: true });
  return io.realpathSync(target) + ".lock";
}

// Remove the lock if, and only if, it is the holder `token` names: it is first moved aside (a rename, atomic), then
// its holder read there; another holder's lock (taken since `token`'s was judged) is put back.  Whether it was removed.
export function removeLockOf(lock, token, mover, io = fs) {
  const aside = `${lock}.aside.${mover}`;
  try {
    io.renameSync(lock, aside);
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  if (readHolder(aside, io)?.token === token) {
    io.rmSync(aside, { recursive: true, force: true });
    return true;
  }
  try {
    io.renameSync(aside, lock);
  } catch {
    // (a third build took the lock in between: the moved one's holder finds its lock gone when it releases it)
  }
  return false;
}

// fn() with the cargo target's build lock held: one build at a time in a target (two in one checkout, or a module
// builder run on its own).  The lock is a directory beside the target's real path, renamed into place whole with its
// holder record (token, pid, host, checkout) already in it.  A holder on this host that is no longer running left it
// stale, and it is taken over; one on another host is waited for; a lock with no holder record (not one of these) is
// taken over after a minute.  Takeover and release both go through removeLockOf, so neither removes another's lock.
export function withTargetLock(target, fn, { log = console.error, wait = 2000, io = fs, alive = pidAlive, host = hostname() } = {}) {
  const lock = targetLockPath(target, io);
  const token = `${host}.${process.pid}.${randomBytes(8).toString("hex")}`;
  const mine = `${lock}.new.${token}`;
  io.mkdirSync(mine);
  io.writeFileSync(join(mine, "holder.json"), JSON.stringify({ token, pid: process.pid, host, root: process.cwd(), since: new Date().toISOString() }));
  let told = false;
  for (;;) {
    try {
      io.renameSync(mine, lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST" && e.code !== "ENOTEMPTY") {
        io.rmSync(mine, { recursive: true, force: true });
        throw e;
      }
    }
    const holder = readHolder(lock, io);
    let stale;
    try {
      stale = holder ? holder.host === host && !alive(holder.pid) : Date.now() - io.statSync(lock).mtimeMs > 60000;
    } catch {
      continue; // (released meanwhile)
    }
    if (stale) {
      removeLockOf(lock, holder?.token, token, io);
      continue;
    }
    if (!told) {
      log(`engine: waiting for the build in ${holder?.root ?? "another checkout"} (pid ${holder?.pid ?? "?"}) to finish with ${target}`);
      told = true;
    }
    sleep(wait);
  }
  try {
    return fn();
  } finally {
    removeLockOf(lock, token, token, io);
  }
}
