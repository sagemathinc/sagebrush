import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { installKernel } from "../src/kernel";
import { KERNEL_SPECS } from "../src/modes";

test("installed bundle paths remain absolute when Jupyter starts elsewhere (#710)", () => {
  const root = mkdtempSync(join(tmpdir(), "sb-kernel-prefix-"));
  const cwd = process.cwd(), main = require.main!, filename = main.filename;
  const lib = (globalThis as any).__PYJS_LIB__;
  const env = process.env.JUPYTER_DATA_DIR;
  const out = process.stdout.write;
  try {
    const installer = join(root, "installer"), notebook = join(root, "notebooks");
    mkdirSync(installer); mkdirSync(notebook);
    // Exercise bundleFile() and the actual copy/argv branch, not launcher(),
    // whose script path was already absolute. A harmless executable fixture
    // also lets us launch exactly the recorded argv from another directory.
    const bundle = join(root, "fixture.cjs");
    const bytes = 'console.log(JSON.stringify(process.argv.slice(2)));\n//' + " ".repeat(1_000_001);
    writeFileSync(bundle, bytes);
    main.filename = bundle;
    (globalThis as any).__PYJS_LIB__ = {};
    process.chdir(installer);
    (process.stdout as any).write = () => true;
    for (const [args, data] of [
      [["--prefix", "./relative prefix λ"], join(installer, "relative prefix λ", "share", "jupyter")],
      [["--prefix", join(root, "absolute prefix")], join(root, "absolute prefix", "share", "jupyter")],
      [[], join(installer, "relative data")],
    ] as [string[], string][]) {
      process.env.JUPYTER_DATA_DIR = "./relative data";
      assert.equal(installKernel([...args, "--mode", "all"]), 0);
      for (const [mode, spec] of Object.entries(KERNEL_SPECS)) {
        const dir = join(data, "kernels", spec.dir);
        const k = JSON.parse(readFileSync(join(dir, "kernel.json"), "utf8"));
        assert.ok(isAbsolute(k.argv[0]));
        assert.ok(isAbsolute(k.argv[1]), `absolute copied bundle: ${k.argv[1]}`);
        assert.equal(k.argv[1], join(dir, "sagebrush.cjs"));
        assert.equal(readFileSync(k.argv[1], "utf8"), bytes);
        const run = spawnSync(k.argv[0], k.argv.slice(1), { cwd: notebook, encoding: "utf8", timeout: 10_000 });
        assert.equal(run.status, 0, run.stderr);
        assert.deepEqual(JSON.parse(run.stdout), ["--jupyter-kernel", "{connection_file}", "--mode", mode]);
      }
      assert.equal(installKernel([...args, "--mode", "all"], true), 0);
      assert.ok(!existsSync(join(data, "kernels", "sagebrush")), "uninstall resolves the same directory");
    }
  } finally {
    process.stdout.write = out;
    process.chdir(cwd);
    main.filename = filename;
    if (lib === undefined) delete (globalThis as any).__PYJS_LIB__;
    else (globalThis as any).__PYJS_LIB__ = lib;
    if (env === undefined) delete process.env.JUPYTER_DATA_DIR;
    else process.env.JUPYTER_DATA_DIR = env;
    rmSync(root, { recursive: true, force: true });
  }
});
