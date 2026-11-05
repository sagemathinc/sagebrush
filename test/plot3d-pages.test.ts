import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// sage_plot3d's page writing in Sagebrush's own runtime, end to end: a big 3D
// scene in Jupyter is a fresh page written by jupyter_bundle through
// _write_page and _temp_for, a path otherwise reached only by the release's
// test/jupyter_kernel.py (the v0.6.5 release failed on it: `import threading`,
// then `import socket`, then `f.fileno()`, none of which Sagebrush has, and the
// temporary's directories left beside the page).
const cli = join(__dirname, "..", "src", "cli.js");
const py = (code: string, cwd: string) => execFileSync(process.execPath, [cli, "-c", code], { encoding: "utf8", cwd });

test("a big scene's fresh page: written whole by jupyter_bundle, and .sagebrush holds only it", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-plot3d-"));
  try {
    // (daybreak's probe: Jupyter on, an empty working directory, a scene just past the inline bound)
    const out = py(
      [
        "import builtins, os, sage_plot3d as p3",
        "builtins.__sagebrush_jupyter__ = True",
        "b = p3.jupyter_bundle('x' * (p3.JUPYTER_INLINE + 1), '<svg/>', 'scene', lambda: '<html>ok</html>')",
        "print(sorted(b), '.sagebrush/plot3d-v2-' in b['text/html'])",
        "print(sorted(os.listdir('.sagebrush')))",
      ].join("\n"),
      dir,
    );
    const names = readdirSync(join(dir, ".sagebrush"));
    assert.equal(names.length, 1, names.join(" "));
    assert.match(names[0], /^plot3d-v2-[0-9a-f]{8}-[0-9a-f]+\.html$/);
    assert.equal(out, `['text/html', 'text/plain'] True\n['${names[0]}']\n`);
    assert.equal(readFileSync(join(dir, ".sagebrush", names[0]), "utf8"), "<html>ok</html>");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("_temp_for names a new temporary each time, by host, process, thread and 64 random bits; _write_page leaves no temporary", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-plot3d-"));
  try {
    const out = py(
      [
        "import os, sage_plot3d as p3",
        "t = p3._temp_for('d')",
        "host = os.path.basename(os.path.dirname(t))",
        "import re",
        "print(os.path.dirname(os.path.dirname(t)) == os.path.join('d', '.plot3d-tmp'), re.fullmatch('%d-1-[0-9a-f]{16}' % os.getpid(), os.path.basename(t)) is not None and t != p3._temp_for('d'), host == p3._host() == os.uname().nodename.replace('/', '_'))",
        "os.makedirs('d')",
        "p3._write_page(os.path.join('d', 'a.html'), 'one')",
        "p3._write_page(os.path.join('d', 'a.html'), 'two')",
        "print(open(os.path.join('d', 'a.html')).read(), sorted(os.listdir('d')))",
      ].join("\n"),
      dir,
    );
    assert.equal(out, "True True True\ntwo ['a.html']\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("_write_page's guards: another writer's removal is retried, never swallowed; only a missing descriptor skips the fsync", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-plot3d-"));
  try {
    const out = py(
      [
        "import builtins, os, sage_plot3d as p3",
        "os.makedirs('d')",
        "real_makedirs = os.makedirs",
        // (another writer removes the empty directory just after this one makes it: once, then every time)
        "def racing(times):",
        "    left = [times]",
        "    def makedirs(path, *a, **k):",
        "        real_makedirs(path, *a, **k)",
        "        if left[0] > 0:",
        "            left[0] -= 1",
        "            os.rmdir(path)",
        "    return makedirs",
        "os.makedirs = racing(1)",
        "p3._write_page(os.path.join('d', 'a.html'), 'raced')",
        "print(open(os.path.join('d', 'a.html')).read(), sorted(os.listdir('d')))",
        "os.makedirs = racing(100)",
        "try:",
        "    p3._write_page(os.path.join('d', 'b.html'), 'never')",
        "    print('no error')",
        "except FileNotFoundError:",
        "    print('FileNotFoundError', os.path.exists(os.path.join('d', 'b.html')))",
        "os.makedirs = real_makedirs",
        // (a file whose descriptor fails another way, EBADF (9; Sagebrush has no errno module): that error is
        // raised, the temporary removed)
        "real_open = builtins.open",
        "class NoFd:",
        "    def __init__(self, f): self.f = f",
        "    def write(self, s): return self.f.write(s)",
        "    def flush(self): return self.f.flush()",
        "    def close(self): return self.f.close()",
        "    def fileno(self): raise OSError(9, 'bad descriptor')",
        "builtins.open = lambda *a, **k: NoFd(real_open(*a, **k))",
        "try:",
        "    p3._write_page(os.path.join('d', 'c.html'), 'x')",
        "    print('no error')",
        "except OSError as e:",
        "    print(type(e).__name__, e.errno == 9, os.path.exists(os.path.join('d', 'c.html')))",
        "finally:",
        "    builtins.open = real_open",
        "print(sorted(os.listdir('d')), os.listdir(os.path.join('d', '.plot3d-tmp', p3._host())) if os.path.isdir(os.path.join('d', '.plot3d-tmp', p3._host())) else [])",
      ].join("\n"),
      dir,
    );
    assert.equal(out, "raced ['a.html']\nFileNotFoundError False\nOSError True False\n['.plot3d-tmp', 'a.html'] []\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// (astra's PLOT694-WRITER-1: Sagebrush's Node workers share one pid, and _thread.get_ident() is always 1, so two
// writers in one folder differ in nothing but their random part.  Their schedule, deterministic: writer A is paused
// right after its open, writer B writes its page whole and renames it, then A goes on.  Both pages must be whole and
// each its own, with the draws distinct, and with B's first draw A's own (the exclusive open then draws again))
test("two writers of one pid and thread, overlapping: both pages whole, neither cross-written", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-plot3d-"));
  try {
    const out = py(
      [
        "import builtins, os, sage_plot3d as p3",
        "os.makedirs('d')",
        "real_open, real_urandom = builtins.open, os.urandom",
        "def overlap(draws):",
        "    seq = list(draws)",
        "    os.urandom = lambda n: seq.pop(0) if seq else real_urandom(n)",
        "    paused = [True]",
        "    def opening(*a, **k):",
        "        f = real_open(*a, **k)",
        "        if paused[0] and a and '.plot3d-tmp' in str(a[0]):",
        "            paused[0] = False",
        "            p3._write_page(os.path.join('d', 'B.html'), 'BBBB')",  // (B, whole, while A holds its open temporary)
        "        return f",
        "    builtins.open = opening",
        "    try:",
        "        p3._write_page(os.path.join('d', 'A.html'), 'AAAA')",
        "    finally:",
        "        builtins.open, os.urandom = real_open, real_urandom",
        "    pages = [open(os.path.join('d', n)).read() for n in ('A.html', 'B.html')]",
        "    os.unlink(os.path.join('d', 'A.html')); os.unlink(os.path.join('d', 'B.html'))",
        "    return pages, sorted(os.listdir('d'))",
        "print(overlap([b'\\x11' * 8, b'\\x22' * 8]))",
        "print(overlap([b'\\x33' * 8, b'\\x33' * 8, b'\\x44' * 8]))",
      ].join("\n"),
      dir,
    );
    assert.equal(out, "(['AAAA', 'BBBB'], [])\n(['AAAA', 'BBBB'], [])\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an interrupt in the middle of a write: no page, and the write's own temporary removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-plot3d-"));
  try {
    const out = py(
      [
        "import builtins, os, sage_plot3d as p3",
        "os.makedirs('d')",
        "real_open = builtins.open",
        "class Stopped:",
        "    def __init__(self, f): self.f = f",
        "    def write(self, s): raise KeyboardInterrupt",
        "    def close(self): return self.f.close()",
        "builtins.open = lambda *a, **k: Stopped(real_open(*a, **k))",
        "try:",
        "    p3._write_page(os.path.join('d', 'a.html'), 'x')",
        "    print('no interrupt')",
        "except KeyboardInterrupt:",
        "    print('KeyboardInterrupt')",
        "finally:",
        "    builtins.open = real_open",
        "h = os.path.join('d', '.plot3d-tmp', p3._host())",
        "print(os.path.exists(os.path.join('d', 'a.html')), os.listdir(h) if os.path.isdir(h) else [])",
      ].join("\n"),
      dir,
    );
    assert.equal(out, "KeyboardInterrupt\nFalse []\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// (astra's PLOT694-OWNERSHIP-2: once the page is published, the temporary's name is free and another writer may take
// it; an interrupt in the directory cleanup after that must not remove that writer's file)
test("after the rename, an interrupt in the cleanup removes nothing of another writer's", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-plot3d-"));
  try {
    const out = py(
      [
        "import os, sage_plot3d as p3",
        "os.makedirs('d')",
        "real_replace, real_rmdir = os.replace, os.rmdir",
        "seen = []",
        "def replace(a, b):",
        "    seen.append(a)",
        "    return real_replace(a, b)",
        "def rmdir(d):",
        // (another writer takes the vacated name, exclusively, then the cleanup is interrupted)
        "    with open(seen[0], 'x') as other:",
        "        other.write('OTHER')",
        "    raise KeyboardInterrupt",
        "os.replace, os.rmdir = replace, rmdir",
        "try:",
        "    p3._write_page(os.path.join('d', 'a.html'), 'PAGE')",
        "    print('no interrupt')",
        "except KeyboardInterrupt:",
        "    print('KeyboardInterrupt')",
        "finally:",
        "    os.replace, os.rmdir = real_replace, real_rmdir",
        "print(open(os.path.join('d', 'a.html')).read(), open(seen[0]).read())",
      ].join("\n"),
      dir,
    );
    assert.equal(out, "KeyboardInterrupt\nPAGE OTHER\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
