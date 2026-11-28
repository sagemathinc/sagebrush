// ci: checks.6 order=20
// scripts/install-engine-wasm.mjs: a fresh engine module with identical bytes
// leaves `git diff --quiet wasm/` clean, whatever the build output's mode.
//   node scripts/test-install-engine-wasm.mjs
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { depInfoPaths, foreignSources, installWasm, namesLocalCargoHome, remappedRustflags, withTargetLock } from "./install-engine-wasm.mjs";

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
// a module's own sources: its dep-info names only this checkout's files (and the Cargo home's crates); another
// checkout's, even one whose path only starts the same, is caught, and so is a dep-info naming nothing
{
  const d = mkdtempSync(join(tmpdir(), "install-engine-wasm-dep-"));
  try {
    const root = join(d, "mf2"), other = join(d, "ffopts"), near = join(d, "mf2b");
    for (const r of [root, other, near]) mkdirSync(r);
    const env = { CARGO_HOME: join(d, "cargo") };
    const module = join(d, "sagebrush_web.wasm");
    const dep = (...paths) => writeFileSync(join(d, "sagebrush_web.d"), `${module}: ${paths.join(" ")}\n\n${paths.map((p) => `${p}:`).join("\n")}\n`);
    ok(JSON.stringify(depInfoPaths(`m.wasm: /a/b\\ c.rs /d.rs\n/a/b\\ c.rs:\n`)) === JSON.stringify(["/a/b c.rs", "/d.rs"]), "depInfoPaths: the first rule's sources, an escaped space kept in its path");
    dep(`${root}/engine/web/src/lib.rs`, `${root}/engine/galois/src/../../group/tables/t.txt`, `${env.CARGO_HOME}/registry/src/x/lib.rs`);
    ok(foreignSources(module, root, env).length === 0, "this checkout's sources and the Cargo home's crates: its own build");
    dep(`${root}/engine/web/src/lib.rs`, `${other}/engine/galois/src/lib.rs`);
    ok(JSON.stringify(foreignSources(module, root, env)) === JSON.stringify([`${other}/engine/galois/src/lib.rs`]), "a source of another checkout sharing the target: caught");
    dep(`${near}/engine/web/src/lib.rs`);
    ok(foreignSources(module, root, env).length === 1, "a checkout whose path only starts the same is another checkout");
    writeFileSync(join(d, "sagebrush_web.d"), "");
    ok(foreignSources(module, root, env).length === 1, "a dep-info naming no sources proves nothing: refused");
    const link = join(d, "link");
    fs.symlinkSync(root, link);
    dep(`${fs.realpathSync(root)}/engine/web/src/lib.rs`);
    ok(foreignSources(module, link, env).length === 0, "a checkout reached through a symlink: cargo names its real path, still its own");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
// the target's build lock: fn runs with it held and it is gone after, also when fn throws; a live holder is waited
// for (told once), a dead one's lock is taken over at once and a never-written one's after a minute, and another
// host's holder isn't judged by this host's pids
{
  const d = mkdtempSync(join(tmpdir(), "install-engine-wasm-lock-"));
  try {
    const target = join(d, "target"), lock = `${target}.lock`;
    const held = (pid, host = "h") => {
      mkdirSync(lock);
      writeFileSync(join(lock, "holder.json"), JSON.stringify({ pid, host, root: "/other" }));
    };
    let inside = false;
    ok(withTargetLock(target, () => ((inside = fs.existsSync(lock)), 7), { host: "h" }) === 7 && inside && !fs.existsSync(lock), "fn's value, with the lock held, and the lock gone after");
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
    ok(polls === 1, "a holder no longer running left it stale: taken over at once");
    held(4242, "elsewhere");
    let ran = false, told = 0;
    // (another host's build, its pid not running here: waited for until it releases the lock, which the log does)
    withTargetLock(target, () => (ran = true), { host: "h", wait: 1, alive: () => false, log: () => (told++, rmSync(lock, { recursive: true, force: true })) });
    ok(ran && told === 1, "another host's holder is waited for, whatever this host's pids say");
    mkdirSync(lock);
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(lock, old, old);
    ran = false;
    withTargetLock(target, () => (ran = true), { host: "h", wait: 1 });
    ok(ran, "a lock whose holder was never written, two minutes old: taken over");
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
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
