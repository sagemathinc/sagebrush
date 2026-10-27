// scripts/install-engine-wasm.mjs: a fresh engine module with identical bytes
// leaves `git diff --quiet wasm/` clean, whatever the build output's mode.
//   node scripts/test-install-engine-wasm.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installWasm } from "./install-engine-wasm.mjs";

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
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
