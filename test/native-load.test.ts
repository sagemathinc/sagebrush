import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The native engine's two checked loaders (#7, design N1 r3 S1): src/runtime/native-load.ts (the CLI, the kernel)
// and app/engine/native-load.mjs (the app's engine threads, which load before removing Node's globals). Both run
// on the same rows and must give the same answer, reason for reason; with SAGEBRUSH_ADDON and
// SAGEBRUSH_ADDON_SHA256 set (a built addon), both also load it.
const DIST = __dirname + "/..";
const ROOT = DIST + "/..";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { loadNativeAddon: loadTs } = require(DIST + "/src/runtime/native-load.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { loadNativeAddon: loadMjs } = require(ROOT + "/app/engine/native-load.mjs");

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const answer = (r: any) => (r.ok ? { ok: true } : { ok: false, why: r.why });

test("native-load: the app's loader answers as the runtime's, row for row", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-native-load-"));
  try {
    const plain = join(dir, "plain.node");
    writeFileSync(plain, "not an addon", { mode: 0o644 });
    const loose = join(dir, "loose.node");
    writeFileSync(loose, "not an addon");
    chmodSync(loose, 0o666);
    const link = join(dir, "link.node");
    symlinkSync(plain, link);
    const sub = join(dir, "sub.node");
    mkdirSync(sub);
    const good = sha("not an addon");
    const rows: [string, string, string, any, RegExp][] = [
      ["no Node", plain, good, {}, /need Node/],
      ["a relative path", "plain.node", good, process, /not absolute/],
      ["a malformed sha256", plain, "abc", process, /missing or malformed/],
      ["an upper-case sha256", plain, good.toUpperCase(), process, /missing or malformed/],
      ["a missing file", join(dir, "absent.node"), good, process, /could not be loaded \(ENOENT\)/],
      ["a symlink", link, good, process, /could not be loaded \(ELOOP\)/],
      ["a directory", sub, good, process, /not a regular file/],
      ["writable by others", loose, good, process, /writable by others/],
      ["another sha256", plain, sha("other"), process, /does not match the manifest/],
      ["the right bytes, not an addon", plain, good, process, /could not be loaded/],
    ];
    for (const [what, path, h, p, why] of rows) {
      const a = answer(loadTs(path, h, p)), b = answer(loadMjs(path, h, p));
      assert.deepEqual(b, a, what);
      assert.equal(a.ok, false, what);
      assert.match(a.why, why, what);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native-load: a built addon loads through both", { skip: !process.env.SAGEBRUSH_ADDON || !process.env.SAGEBRUSH_ADDON_SHA256 }, () => {
  const path = process.env.SAGEBRUSH_ADDON!, h = process.env.SAGEBRUSH_ADDON_SHA256!;
  const a = loadTs(path, h), b = loadMjs(path, h, process);
  assert.equal(a.ok, true, a.why);
  assert.equal(b.ok, true, b.why);
});
