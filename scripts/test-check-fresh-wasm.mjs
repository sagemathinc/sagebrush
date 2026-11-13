// ci: checks.6 order=30
// scripts/check-fresh-wasm.mjs: a stale pin fails master pushes, dispatches and the schedule, and only warns on a
// pull request; a pin that equals the fresh build passes everywhere.
//   node scripts/test-check-fresh-wasm.mjs
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFreshWasm } from "./check-fresh-wasm.mjs";
import { installWasm } from "./install-engine-wasm.mjs";
import { MODULES, formatPins, sha256 } from "./wasm-modules.mjs";

let failures = 0;
const ok = (c, what) => (c ? console.log("ok  ", what) : (failures++, console.log("FAIL", what)));
const dir = mkdtempSync(join(tmpdir(), "check-fresh-wasm-"));
const strict = ["push", "workflow_dispatch", "schedule"];
const pinned = Object.fromEntries(MODULES.map((n) => [n, Buffer.from(`\0asm\x01\0\0\0${n}`)]));
const pinsOf = (mods) => Object.fromEntries(MODULES.map((n) => [n, { sha256: sha256(mods[n]), bytes: mods[n].length }]));
const src = join(dir, "fresh.wasm"), path = (n) => join(dir, "wasm", n);
// a fresh build of `name` with these bytes, installed as build-engine.mjs does (it builds with mode 0755)
const build = (name, bytes) => {
  writeFileSync(src, bytes);
  chmodSync(src, 0o755);
  installWasm(src, path(name));
};
try {
  mkdirSync(join(dir, "wasm"));
  writeFileSync(join(dir, "wasm", "pins.json"), formatPins(pinsOf(pinned)));
  for (const n of MODULES) build(n, pinned[n]);
  for (const event of [...strict, "pull_request"]) {
    const r = checkFreshWasm({ cwd: dir, event });
    ok(r.status === 0 && !/::(error|warning)::/.test(r.message), `fresh (the pinned bytes): passes, silently, on ${event}`);
  }
  // the control: the pin is stale (a fresh engine with other bytes)
  build(MODULES[0], Buffer.from("\0asm\x01\0\0\0FRESH-BUILD"));
  for (const event of strict) {
    const r = checkFreshWasm({ cwd: dir, event });
    ok(r.status === 1 && r.message.startsWith("::error::") && r.message.includes(MODULES[0]), `stale: an ERROR on ${event} (${r.message.split("\n")[0].slice(0, 60)}...)`);
  }
  const pr = checkFreshWasm({ cwd: dir, event: "pull_request" });
  ok(pr.status === 0 && pr.message.startsWith("::warning::"), "stale: a warning on a pull request");
  // a mode-only difference is one too
  build(MODULES[0], pinned[MODULES[0]]);
  chmodSync(path(MODULES[0]), 0o755);
  if (process.platform !== "win32") ok(checkFreshWasm({ cwd: dir, event: "push" }).status === 1, "a mode-only difference (0755): an ERROR on push");
  chmodSync(path(MODULES[0]), 0o644);
  // every module is held to its pin: a stale PNG module is an ERROR, named
  build("sagebrush-raster.wasm", Buffer.from("\0asm\x01\0\0\0RASTER-FRESH"));
  const r = checkFreshWasm({ cwd: dir, event: "push" });
  ok(r.status === 1 && r.message.includes("sagebrush-raster.wasm") && !r.message.includes(`${MODULES[0]}:`), "a stale PNG module (sagebrush-raster.wasm): an ERROR on push, naming only it");
  // a missing module (nothing built) is an error everywhere, never a pass
  rmSync(path("sagebrush-nd.wasm"));
  ok(checkFreshWasm({ cwd: dir, event: "pull_request" }).status === 2, "a module that wasn't built: an error, even on a pull request");
  build("sagebrush-nd.wasm", pinned["sagebrush-nd.wasm"]);
  // pins it can't read are an error everywhere, never a pass: wasm/pins.json invalid, then missing
  const pinsPath = join(dir, "wasm", "pins.json");
  writeFileSync(pinsPath, "{ not json");
  const bad = checkFreshWasm({ cwd: dir, event: "pull_request" });
  ok(bad.status === 2 && bad.message.startsWith("::error::wasm/pins.json"), "an invalid wasm/pins.json: an error, even on a pull request");
  rmSync(pinsPath);
  ok(checkFreshWasm({ cwd: dir, event: "pull_request" }).status === 2, "a missing wasm/pins.json: an error, even on a pull request");
  writeFileSync(pinsPath, formatPins(pinsOf(pinned)));
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
