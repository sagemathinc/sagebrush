// scripts/check-fresh-wasm.mjs: a stale committed engine fails master pushes, dispatches and the
// schedule, and only warns on a pull request; a fresh one passes everywhere.
//   node scripts/test-check-fresh-wasm.mjs
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFreshWasm } from "./check-fresh-wasm.mjs";
import { installWasm } from "./install-engine-wasm.mjs";

let failures = 0;
const ok = (c, what) => (c ? console.log("ok  ", what) : (failures++, console.log("FAIL", what)));
const dir = mkdtempSync(join(tmpdir(), "check-fresh-wasm-"));
const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
const strict = ["push", "workflow_dispatch", "schedule"];
try {
  git("init", "-q");
  mkdirSync(join(dir, "wasm"));
  const dst = join(dir, "wasm", "sagebrush-engine.wasm"), src = join(dir, "fresh.wasm");
  writeFileSync(dst, "\0asm\x01\0\0\0COMMITTED");
  chmodSync(dst, 0o644);
  git("add", "wasm");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  // a fresh build with the same bytes, installed as build-engine.mjs does
  writeFileSync(src, "\0asm\x01\0\0\0COMMITTED");
  chmodSync(src, 0o755);
  installWasm(src, dst);
  for (const event of [...strict, "pull_request"]) {
    const r = checkFreshWasm({ cwd: dir, event });
    ok(r.status === 0 && !/::(error|warning)::/.test(r.message), `fresh (same bytes): passes, silently, on ${event}`);
  }
  // the control: the committed engine is stale (a fresh build with other bytes)
  writeFileSync(src, "\0asm\x01\0\0\0FRESH-BUILD");
  installWasm(src, dst);
  for (const event of strict) {
    const r = checkFreshWasm({ cwd: dir, event });
    ok(r.status === 1 && r.message.startsWith("::error::") && r.message.includes("sagebrush-engine.wasm"), `stale: an ERROR on ${event} (${r.message.split("\n")[0]})`);
  }
  const pr = checkFreshWasm({ cwd: dir, event: "pull_request" });
  ok(pr.status === 0 && pr.message.startsWith("::warning::"), "stale: a warning on a pull request");
  // a mode-only change is a difference too
  git("checkout", "-q", "--", "wasm");
  chmodSync(dst, 0o755);
  if (process.platform !== "win32") ok(checkFreshWasm({ cwd: dir, event: "push" }).status === 1, "a mode-only change (0755): an ERROR on push");
  // the script as CI runs it: the exit status follows the event
  const cli = (event) => {
    try {
      execFileSync(process.execPath, [join(import.meta.dirname, "check-fresh-wasm.mjs")], { cwd: dir, env: { ...process.env, GITHUB_EVENT_NAME: event }, stdio: "pipe" });
      return 0;
    } catch (e) {
      return e.status;
    }
  };
  ok(cli("push") === 1 && cli("pull_request") === 0, "the script's exit status: 1 on push, 0 on a pull request");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
