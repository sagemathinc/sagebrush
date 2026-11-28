// ci: checks.6 order=20
// scripts/install-engine-wasm.mjs: a fresh engine module with identical bytes
// leaves `git diff --quiet wasm/` clean, whatever the build output's mode.
//   node scripts/test-install-engine-wasm.mjs
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installWasm, namesLocalCargoHome, remappedRustflags, removeLockOf, targetLockPath, withTargetLock } from "./install-engine-wasm.mjs";

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
// the target's build lock: fn runs with it held and it is gone after, also when fn throws; a live holder is waited
// for (told once), a dead one's lock is taken over at once, another host's holder is waited for, and a lock with no
// holder record is taken over after a minute; one target spelled two ways is one lock; a takeover or a release never
// removes a lock that isn't the one it judged
{
  const d = mkdtempSync(join(tmpdir(), "install-engine-wasm-lock-"));
  try {
    const target = join(d, "target");
    const lock = targetLockPath(target);
    const holderOf = () => JSON.parse(readFileSync(join(lock, "holder.json"), "utf8"));
    const held = (pid, host = "h", token = `t${pid}`) => {
      mkdirSync(lock);
      writeFileSync(join(lock, "holder.json"), JSON.stringify({ token, pid, host, root: "/other" }));
    };
    let inside = null;
    ok(withTargetLock(target, () => ((inside = fs.existsSync(lock) ? holderOf() : null), 7), { host: "h" }) === 7 && inside?.pid === process.pid && !fs.existsSync(lock), "fn's value, with the lock held (its holder record written before it is taken), and the lock gone after");
    let threw = false;
    try {
      withTargetLock(target, () => {
        throw new Error("build failed");
      }, { host: "h" });
    } catch (e) {
      threw = e.message === "build failed";
    }
    ok(threw && !fs.existsSync(lock), "a failing build's error is thrown and the lock released");
    held(4242);
    let polls = 0;
    const logs = [];
    withTargetLock(target, () => {}, { host: "h", wait: 1, log: (m) => logs.push(m), alive: () => ++polls < 4 });
    ok(polls === 4 && logs.length === 1 && /\/other/.test(logs[0]) && !fs.existsSync(lock), "a live holder is waited for, told once, until it is gone");
    held(4242);
    polls = 0;
    withTargetLock(target, () => {}, { host: "h", wait: 1, alive: () => (polls++, false) });
    ok(polls === 1 && !fs.existsSync(lock), "a holder no longer running left it stale: taken over at once");
    held(4242, "elsewhere");
    let ran = false, told = 0;
    // (another host's build, its pid meaningless here: waited for until it releases the lock, which the log does)
    withTargetLock(target, () => (ran = true), { host: "h", wait: 1, alive: () => false, log: () => (told++, rmSync(lock, { recursive: true, force: true })) });
    ok(ran && told === 1, "another host's holder is waited for, whatever this host's pids say");
    mkdirSync(lock);
    writeFileSync(join(lock, "x"), "");
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(lock, old, old);
    ran = false;
    withTargetLock(target, () => (ran = true), { host: "h", wait: 1 });
    ok(ran, "a lock with no holder record, two minutes old: taken over");
    // (one target, two spellings: a symlink to it names the same lock)
    const alias = join(d, "alias");
    fs.symlinkSync(target, alias);
    ok(targetLockPath(alias) === lock, "a target reached through a symlink has the real path's lock");
    held(4242);
    told = 0;
    withTargetLock(alias, () => {}, { host: "h", wait: 1, alive: () => true, log: () => (told++, rmSync(lock, { recursive: true, force: true })) });
    ok(told === 1, "a build through the alias waits for the holder of the real path's lock");
    // (two waiters judged the same dead holder: the first took it over and holds a new lock; the second's takeover,
    // still naming the dead holder, must leave the new lock in place)
    held(4243, "h", "new-holder");
    ok(!removeLockOf(lock, "t-dead", "second") && holderOf().token === "new-holder", "a takeover of a holder already replaced leaves the new holder's lock");
    ok(removeLockOf(lock, "new-holder", "x") && !fs.existsSync(lock), "the lock it names is removed");
    ok(!removeLockOf(lock, "anything", "x"), "no lock: nothing removed");
    // (a release after the lock was taken from under it: the other holder's lock stays)
    withTargetLock(target, () => {
      rmSync(lock, { recursive: true, force: true });
      held(4244, "h", "thief");
    }, { host: "h" });
    ok(fs.existsSync(lock) && holderOf().token === "thief", "a release removes only its own lock");
    rmSync(lock, { recursive: true, force: true });
    // (two real processes on one target: their builds never overlap)
    const order = join(d, "order.txt"), script = join(d, "child.mjs");
    writeFileSync(script, `import { withTargetLock } from ${JSON.stringify(new URL("./install-engine-wasm.mjs", import.meta.url).href)};
import { appendFileSync } from "node:fs";
withTargetLock(${JSON.stringify(target)}, () => {
  appendFileSync(${JSON.stringify(order)}, "start\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  appendFileSync(${JSON.stringify(order)}, "end\\n");
}, { wait: 20, log: () => {} });
`);
    spawnSync("bash", ["-c", `"${process.execPath}" "${script}" & "${process.execPath}" "${script}" & wait`]);
    ok(readFileSync(order, "utf8") === "start\nend\nstart\nend\n", "two processes on one target: one build, then the other");
    ok(fs.readdirSync(d).filter((n) => n.startsWith("target.lock.")).length === 0, "no lock directories left behind");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
