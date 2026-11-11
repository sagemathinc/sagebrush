import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// The WebAssembly modules' pins (wasm/pins.json, scripts/wasm-pins.mjs; design/wasm-artifacts.md).
const ROOT = join(__dirname, "..", "..");
const run = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, "scripts", "wasm-pins.mjs"), ...args], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });

test("wasm/pins.json matches the modules committed at HEAD", () => {
  // the committed blobs, not the working tree: the engine jobs overlay a fresh build there
  const r = run("--verify-committed");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("the pin and fetch tools' planted controls each fail with their own message", () => {
  const r = run("--self-test");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /all \d+ controls pass/);
  assert.doesNotMatch(r.stdout, /^FAIL/m);
});
