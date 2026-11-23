import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sageGlobals, R, libDir } from "../src/compile";
import { dictDelete } from "../src/runtime/object";

const cli = resolve(__dirname, "../src/cli.js");
const run = (cwd: string, args: string[], input?: string) => spawnSync(process.execPath, [cli, ...args], { cwd, input, encoding: "utf8", timeout: 60_000 });

test("Sage startup restores the path object and public cache even on failure", () => {
  const sys = R.importModule("sys"), path = sys.path, exec = R.loader.exec;
  const previous = [...R.sysModules.$m.entries()];
  const user = R.newModule("sagebrush");
  const submodule = R.newModule("sagebrush.user");
  try {
    R.dictSet(R.sysModules, "sagebrush", user);
    R.dictSet(R.sysModules, "sagebrush.user", submodule);
    R.dictSet(R.sysModules, "sagebrush.blocked", null);
    sys.path = ["user path"];
    const userPath = sys.path;
    R.loader.exec = () => {
      assert.deepEqual(sys.path, [libDir()]);
      assert.equal(R.sysModules.$m.has("sagebrush"), false);
      assert.equal(R.sysModules.$m.has("sagebrush.blocked"), false);
      R.dictSet(R.sysModules, "sagebrush", R.newModule("sagebrush"));
      R.dictSet(R.sysModules, "sagebrush.internal", R.newModule("sagebrush.internal"));
      throw new Error("startup failed");
    };
    assert.throws(() => sageGlobals(R.newModule("test")), /startup failed/);
    assert.equal(sys.path, userPath);
    assert.equal(R.sysModules.$m.get("sagebrush"), user);
    assert.equal(R.sysModules.$m.get("sagebrush.user"), submodule);
    assert.equal(R.sysModules.$m.get("sagebrush.blocked"), null);
    assert.equal(R.sysModules.$m.has("sagebrush.internal"), false);
  } finally {
    R.loader.exec = exec;
    sys.path = path;
    for (const name of R.sysModules.$m.keys()) if (typeof name === "string" && (name === "sagebrush" || name.startsWith("sagebrush."))) dictDelete(R.sysModules, name);
    for (const [name, value] of previous) R.dictSet(R.sysModules, name, value);
  }
});

for (const packageShadow of [false, true]) {
  test(`Sage startup ignores a local sagebrush ${packageShadow ? "package" : "file"}, but explicit imports do not (#735)`, () => {
    const root = mkdtempSync(join(tmpdir(), "sb-sage-shadow-"));
    try {
      const scripts = join(root, "scripts"), elsewhere = join(root, "elsewhere");
      mkdirSync(scripts); mkdirSync(elsewhere);
      const shadow = packageShadow ? join(scripts, "sagebrush", "__init__.py") : join(scripts, "sagebrush.py");
      if (packageShadow) mkdirSync(join(scripts, "sagebrush"));
      writeFileSync(shadow, "raise ImportError('local shadow was imported')\n");
      writeFileSync(join(scripts, "helper.py"), "value = 17\n");
      const source = "import sys\nimport helper\nprint(2^3, helper.value)\nprint(sys.path[0])\n";
      const script = join(scripts, "q.sage");
      writeFileSync(script, source);
      for (const args of [[script], ["--sage", script]]) {
        const r = run(elsewhere, args);
        assert.deepEqual([r.status, r.stdout, r.stderr], [0, `8 17\n${scripts}\n`, ""], args.join(" "));
      }
      for (const [args, input] of [[ ["--sage", "-c", source], undefined ], [ ["--sage", "-"], source ]] as [string[], string | undefined][]) {
        const r = run(scripts, args, input);
        assert.deepEqual([r.status, r.stdout, r.stderr], [0, `8 17\n${scripts}\n`, ""], args.join(" "));
      }
      // Merely warming sys.modules permanently would hide the user's file.
      writeFileSync(shadow, "marker = 'local shadow'\n");
      const imports = "import sagebrush\nprint(sagebrush.marker)\n";
      writeFileSync(script, imports);
      for (const args of [[script], ["--sage", "-c", imports], ["-c", imports]]) {
        const r = run(scripts, args);
        assert.deepEqual([r.status, r.stdout, r.stderr], [0, "local shadow\n", ""], args.join(" "));
      }
      // Ordinary Python's explicit submodule import still obeys shadowing.
      writeFileSync(shadow, "raise ImportError('local shadow was imported')\n");
      for (const args of [["-c", "import sagebrush.preparse"], ["--sage", "-c", "import sagebrush"]]) {
        const r = run(scripts, args);
        assert.equal(r.status, 1, r.stderr);
        assert.match(r.stderr, /ImportError: local shadow was imported/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
