import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Shared by Sprig's host pins (test/sprig-host.test.ts, sprig-stack.test.ts, sprig-memory.test.ts): S1.1's first host
// exposure, the hidden `--sprig -c` (design/sprig-mvp.md §8, §9; the S1 plan, with ENGINE's E1/E2 and SEC's literal
// staging, Nov 9).  The corpus (test/sprig-corpus-*.test.ts) pins the language; these pin Sprig's boundary.  Nothing in
// them asserts a time or this host's stack depth.
export const ROOT = join(__dirname, "..", "..");
export const CLI = join(__dirname, "..", "src", "cli.js");

export function sprig(src: string, cwd: string) {
  const r = spawnSync(process.execPath, [CLI, "--sprig", "-c", src], { cwd, encoding: "utf8", timeout: 300000, maxBuffer: 1 << 26 });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

/** Python run in the engine (Sprig's modules in-process), its stdout's last line parsed as JSON. */
export function py(src: string, cwd = ROOT) {
  const r = spawnSync(process.execPath, [CLI, "-c", src], { cwd, encoding: "utf8", timeout: 300000, maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

export const HOST_DETAIL = /Traceback|File "|\.py"|RecursionError|RangeError|Maximum call stack/;
