// ci: checks.6 order=20
// scripts/install-engine-wasm.mjs: a fresh engine module with identical bytes
// leaves `git diff --quiet wasm/` clean, whatever the build output's mode.
//   node scripts/test-install-engine-wasm.mjs
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_BUSY, installWasm, lockedCommand, namesLocalCargoHome, relaunchUnderTargetLock, remappedRustflags, removeTargetIfIdle, targetLockPath } from "./install-engine-wasm.mjs";

let failures = 0;
const ok = (c, what) => (c ? console.log("ok  ", what) : (failures++, console.log("FAIL", what)));
const dir = mkdtempSync(join(tmpdir(), "install-engine-wasm-"));
const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
const quiet = () => spawnSync("git", ["-C", dir, "diff", "--quiet", "wasm/"]).status === 0;
const mode = (p) => statSync(p).mode & 0o777;
try {
  git("init", "-q");
  mkdirSync(join(dir, "wasm"));
  const dst = join(dir, "wasm", "sagebrush-engine.wasm"), src = join(dir, "sagebrush_web.wasm");
  writeFileSync(dst, "\0asm\x01\0\0\0");
  chmodSync(dst, 0o644);
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  writeFileSync(src, readFileSync(dst));
  chmodSync(src, 0o755); // (as cargo writes it)
  if (process.platform !== "win32") {
    // (the control: a plain copy carries 0755, and git reports the mode change)
    copyFileSync(src, dst);
    ok(mode(dst) === 0o755 && !quiet(), "control: copyFileSync makes the identical file 0755 and git diff reports it");
  }
  installWasm(src, dst); // (also over the 0755 the control left)
  ok(mode(dst) === 0o644, "installWasm: the committed file is 0644");
  ok(readFileSync(dst).equals(readFileSync(src)), "installWasm: the bytes are the build's");
  ok(quiet(), "identical bytes: git diff --quiet wasm/ is clean");
  writeFileSync(src, "\0asm\x01\0\0\0\0");
  installWasm(src, dst);
  ok(!quiet(), "different bytes: git diff still reports them");

  // CORR-213-1: a failure before the rename leaves dst's original bytes and mode, and no temp file
  const before = readFileSync(dst);
  const fresh = Buffer.from("\0asm\x01\0\0\0FRESH");
  writeFileSync(src, fresh);
  const enospc = () => Object.assign(new Error("ENOSPC: no space left on device (injected)"), { code: "ENOSPC" });
  const failing = {
    // (a partial write: 3 bytes reach the file, then ENOSPC)
    partial: { ...fs, writeFileSync: (p, b, o) => { fs.writeFileSync(p, b.subarray(0, 3), o); throw enospc(); } },
    chmod: { ...fs, chmodSync: () => { throw enospc(); } },
    rename: { ...fs, renameSync: () => { throw enospc(); } },
  };
  for (const [name, io] of Object.entries(failing)) {
    let threw = false;
    try {
      installWasm(src, dst, io);
    } catch (e) {
      threw = e.code === "ENOSPC";
    }
    const left = fs.readdirSync(join(dir, "wasm")).filter((f) => f !== "sagebrush-engine.wasm");
    ok(threw && readFileSync(dst).equals(before) && mode(dst) === 0o644 && left.length === 0, `a failure at ${name}: the error is thrown, dst keeps its bytes and 0644, no temp file is left (${JSON.stringify(left)})`);
  }
  installWasm(src, dst);
  ok(readFileSync(dst).equals(fresh) && mode(dst) === 0o644, "then a working install replaces it whole");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
// the Cargo home written as CI's: the flag first, the caller's own after it, never twice; a module naming this
// machine's Cargo home is caught, CI's (or none) is not
{
  const env = { CARGO_HOME: "/home/someone/.cargo" };
  const flag = "--remap-path-prefix=/home/someone/.cargo=/home/runner/.cargo";
  ok(remappedRustflags(env) === flag, "no RUSTFLAGS of its own: the remap alone");
  ok(remappedRustflags({ ...env, RUSTFLAGS: "-Cdebuginfo=2" }) === `${flag} -Cdebuginfo=2`, "its own RUSTFLAGS after the remap");
  ok(remappedRustflags({ ...env, RUSTFLAGS: `${flag} -Cdebuginfo=2` }) === `${flag} -Cdebuginfo=2`, "an already-remapped RUSTFLAGS unchanged (build-all.sh's callers, a nested build)");
  const named = new TextEncoder().encode("panicked at /home/someone/.cargo/registry/src/x.rs:1");
  ok(namesLocalCargoHome(named, env), "a module naming the local Cargo home is caught");
  ok(!namesLocalCargoHome(new TextEncoder().encode("panicked at /home/runner/.cargo/registry/src/x.rs:1"), env), "CI's Cargo home is fine");
  ok(!namesLocalCargoHome(named, { CARGO_HOME: "/home/runner/.cargo" }), "on CI's own runner nothing is local");
  ok(!namesLocalCargoHome(new TextEncoder().encode("/home/someone/.cargo2/x"), env), "a longer path that only starts the same is not the Cargo home");
}
// the target's build lock, a kernel lock (flock on Linux, lockf on macOS): one target's spellings name one lock; a
// build runs again holding it, so two never overlap and a second says once that it waits; a holder killed outright
// releases it; a target is pruned only while its lock is free, and its lock file stays
{
  ok(JSON.stringify(lockedCommand("/t.lock", ["node", "b.mjs"], { platform: "linux" })) === JSON.stringify(["flock", "-E", "75", "/t.lock", "node", "b.mjs"]), "Linux: flock, a conflict exiting 75");
  ok(JSON.stringify(lockedCommand("/t.lock", ["rm"], { wait: false, platform: "linux" })) === JSON.stringify(["flock", "-E", "75", "-n", "/t.lock", "rm"]), "Linux, not waiting: flock -n");
  ok(JSON.stringify(lockedCommand("/t.lock", ["rm"], { wait: false, platform: "darwin" })) === JSON.stringify(["lockf", "-k", "-t", "0", "/t.lock", "rm"]), "macOS, not waiting: lockf -t 0 (its timeout exits 75)");
  ok(lockedCommand("/t.lock", ["rm"], { platform: "win32" }) === null && LOCK_BUSY === 75, "elsewhere: no lock command");
  const d = mkdtempSync(join(tmpdir(), "install-engine-wasm-lock-"));
  try {
    const target = join(d, "target");
    const lock = targetLockPath(target);
    const alias = join(d, "alias");
    fs.symlinkSync(target, alias);
    ok(targetLockPath(alias) === lock && lock === fs.realpathSync(target) + ".lock", "a target reached through a symlink has the real path's lock");
    ok(relaunchUnderTargetLock(target, ["false"], { env: { ...process.env, SAGEBRUSH_TARGET_LOCK: lock } }) === null, "the run that holds the lock goes on (null), it doesn't relaunch");
    if (spawnSync("flock", ["--version"]).status === 0) {
      // (two real builds, each relaunching itself under the lock, the second through the alias: one, then the other)
      const order = join(d, "order.txt"), script = join(d, "child.mjs");
      writeFileSync(script, `import { relaunchUnderTargetLock } from ${JSON.stringify(new URL("./install-engine-wasm.mjs", import.meta.url).href)};
import { appendFileSync } from "node:fs";
const locked = relaunchUnderTargetLock(process.argv[2], [process.execPath, process.argv[1], process.argv[2]]);
if (locked !== null) process.exit(locked);
appendFileSync(${JSON.stringify(order)}, "start\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
appendFileSync(${JSON.stringify(order)}, "end\\n");
`);
      const r = spawnSync("bash", ["-c", `"${process.execPath}" "${script}" "${target}" 2>"${d}/e1" & sleep 0.1; "${process.execPath}" "${script}" "${alias}" 2>"${d}/e2" & wait`]);
      const waited = readFileSync(join(d, "e2"), "utf8");
      ok(r.status === 0 && readFileSync(order, "utf8") === "start\nend\nstart\nend\n", "two builds on one target (one through a symlink): one, then the other");
      ok((waited.match(/waiting for another build/g) ?? []).length === 1, "the second says once that it waits");
      // (a holder killed outright: the kernel releases its lock)
      const holder = spawn("flock", [lock, "sleep", "30"], { detached: true, stdio: "ignore" });
      const until = Date.now() + 5000;
      while (spawnSync("flock", ["-n", "-E", "75", lock, "true"]).status !== 75 && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      ok(removeTargetIfIdle(target) === "busy" && fs.existsSync(target), "a target whose lock a build holds is not pruned");
      process.kill(-holder.pid, "SIGKILL");
      holder.unref();
      let freed = false;
      while (!freed && Date.now() < until + 5000) {
        freed = spawnSync("flock", ["-n", "-E", "75", lock, "true"]).status === 0;
        if (!freed) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      ok(freed, "a holder killed outright releases the lock (no stale lock to recover)");
      ok(removeTargetIfIdle(target) === "removed" && !fs.existsSync(target) && fs.existsSync(lock), "a free target is pruned under its lock, and its lock file stays");
    } else console.log("skip: no flock here (the lock rows run on Linux CI)");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
