import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// shutil, CPython 3.14's own Lib/shutil.py, lazily embedded, and the os calls it needs (P3b-2: file descriptors,
// chmod, utime, access, the terminal's size, posix; the design note astra and daybreak2 cleared): test/shutil_cases.py
// prints, on the CLI's real file system, what CPython prints for it, line for line, each run in a fresh folder with
// nothing in the environment but PATH and HOME. The reference is the newest 3.14 patch release (CI's "3.14").
// (The browser worker's file system: web/test-shutil-worker.mjs, the same cases, and its refusals.)
const CLI = join(__dirname, "..", "src", "cli.js");
const CASES = join(__dirname, "..", "..", "test", "shutil_cases.py");
const inFresh = (cmd: string, args: string[]) => {
  const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "shutil-"));
  try {
    return execFileSync(cmd, args, { cwd: d, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: d } });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
};

test("shutil_cases.py: os's descriptors, chmod, utime and access, Path.touch, shutil's copies, moves, rmtree and which, as CPython 3.14 prints them", () => {
  const want = inFresh("python3", [CASES]).split("\n");
  const got = inFresh(process.execPath, [CLI, CASES]).split("\n");
  assert.ok(want.length > 50, "the cases ran under CPython");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `shutil_cases.py line ${i + 1}`);
});

// (what differs from CPython by design, Sagebrush's own: no call takes a descriptor in place of a path, or dir_fd,
// so supports_fd and supports_dir_fd are empty; dir_fd is NotImplementedError, as on a platform without it)
test("os: supports_fd and supports_dir_fd empty, dir_fd refused (open, chmod, utime, access, stat, lstat), posix exactly os's reviewed functions", () => {
  const out = execFileSync(process.execPath, [CLI, "-c", [
    "import os, posix",
    "print(len(os.supports_fd), len(os.supports_dir_fd), sorted(f.__name__ for f in os.supports_follow_symlinks))",
    "for f in [lambda: os.open('x', os.O_RDONLY, dir_fd=3), lambda: os.chmod('x', 0o600, dir_fd=3), lambda: os.utime('x', dir_fd=3), lambda: os.access('x', os.F_OK, dir_fd=3), lambda: os.stat('x', dir_fd=3), lambda: os.lstat('x', dir_fd=3)]:",
    "    try: f()",
    "    except NotImplementedError as e: print('NotImplementedError', e)",
    "print(all(getattr(posix, n) is getattr(os, n) for n in dir(posix) if not n.startswith('__') and n != 'error'), hasattr(posix, 'environ'), hasattr(posix, 'path'))",
  ].join("\n")], { encoding: "utf8" });
  assert.equal(out, [
    "0 0 ['access', 'stat', 'utime']",
    ...Array(6).fill("NotImplementedError dir_fd unavailable on this platform"),
    "True False False",
    "",
  ].join("\n"));
});

// The web build's fs itself (web/shims/fs.ts, its types stripped and its SHA-256 import stubbed, as file-once.test
// runs it): every bound holds before any effect, whatever os passes (astra's OPEN-FLAGS-1: flags with a bit above 31
// made the file; design note §Allocations: a descriptor's file is at most a bytes object's 2**32 - 1 bytes)
test("the web fs's descriptors: flags beyond a C int refused before any effect; seeks and writes past 2**32 - 1 refused, nothing allocated; reads exactly the bytes read; a negative or absent descriptor EBADF, nothing written", () => {
  const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "shutil-shim-"));
  try {
    const src = readFileSync(join(__dirname, "..", "..", "web", "shims", "fs.ts"), "utf8").replace('import { sha256Hex } from "../../src/runtime/sha256";', 'const sha256Hex = (_d: Uint8Array): string => "";');
    assert.ok(src.includes("const sha256Hex = "), "the shim's import, stubbed");
    writeFileSync(join(d, "fs.mts"), src);
    writeFileSync(join(d, "run.mjs"), `
      const shim = await import(${JSON.stringify(join(d, "fs.mts"))});
      const changed = [];
      shim.__hooks.changed = (p) => changed.push(p);
      const wrote = [];
      shim.__hooks.write = (fd, text) => wrote.push([fd, text]);
      const t = (f) => { try { return String(f()); } catch (e) { return e.unsupported ? "unsupported" : e.memory ? "memory" : String(e.code); } };
      const out = {};
      out.flags = [2 ** 32 + 64 + 1, 2 ** 31, 2 ** 53, -1, 1.5, 2 ** 32].map((fl) => t(() => shim.openSync("/unknown-flags", fl, 0o644)));
      out.made = [shim.existsSync("/unknown-flags"), changed.length];
      shim.writeFileSync("/k", "Kept");
      changed.length = 0;
      const fd = shim.openSync("/k", 2, 0);
      out.seek = [t(() => shim.seekFd(fd, 2 ** 32, 0)), t(() => shim.seekFd(fd, 2 ** 53 + 2, 0)), t(() => shim.seekFd(fd, 1e300, 0)), t(() => shim.seekFd(fd, 2 ** 32 - 1, 0))];
      out.write = [t(() => shim.writeSync(fd, new Uint8Array(2))), t(() => shim.writeSync(fd, new Uint8Array(0))), shim.fstatSync(fd).size, changed.length];
      shim.seekFd(fd, 0, 0);
      const r = shim.readFd(fd, 2 ** 32 - 1);
      out.read = [r.length, r.buffer.byteLength, new TextDecoder().decode(r), shim.readFd(fd, 2 ** 32 - 1).length];
      // (only 0, 1 and 2 are the standard streams: a negative or absent descriptor is EBADF, nothing written or changed)
      changed.length = 0;
      out.neg = [-1, -(2 ** 31), 77].flatMap((n) => [t(() => shim.writeSync(n, new Uint8Array([88]))), t(() => shim.writeSync(n, "X")), t(() => shim.readSync(n, new Uint8Array(1))), t(() => shim.closeSync(n)), t(() => shim.seekFd(n, 0, 0)), t(() => shim.readFd(n, 1))]);
      out.negEffects = [wrote.length, changed.length];
      shim.writeSync(1, "ok");
      out.stdout = wrote;
      console.log(JSON.stringify(out));
    `);
    const r = JSON.parse(execFileSync(process.execPath, [join(d, "run.mjs")], { encoding: "utf8" }));
    assert.deepEqual(r.flags, Array(6).fill("unsupported"));
    assert.deepEqual(r.made, [false, 0]);
    assert.deepEqual(r.seek, ["EINVAL", "EINVAL", "EINVAL", String(2 ** 32 - 1)]);
    assert.deepEqual(r.write, ["EFBIG", "0", 4, 0]);
    assert.deepEqual(r.read, [4, 4, "Kept", 0]);
    assert.deepEqual(r.neg, Array(18).fill("EBADF"));
    assert.deepEqual(r.negEffects, [0, 0]);
    assert.deepEqual(r.stdout, [[1, "ok"]]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
