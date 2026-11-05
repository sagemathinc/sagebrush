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

test("_temp_for names its writer's temporary by host, process and thread; _write_page leaves no temporary", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-plot3d-"));
  try {
    const out = py(
      [
        "import os, sage_plot3d as p3",
        "t = p3._temp_for('d')",
        "host = os.path.basename(os.path.dirname(t))",
        "print(os.path.dirname(os.path.dirname(t)) == os.path.join('d', '.plot3d-tmp'), os.path.basename(t) == '%d-%d' % (os.getpid(), 1), host == p3._host() == os.uname().nodename.replace('/', '_'))",
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
