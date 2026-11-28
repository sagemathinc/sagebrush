// Rill's modules are recorded for the site without their docstrings (src/compile.ts, stripDocstrings): nothing reads
// a Rill function's __doc__, and the precompiled chunk is smaller; other modules are recorded as before, and the
// sources keep their docstrings.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, libDir, stripDocstrings } from "../src/compile";

const ROOT = join(__dirname, "..", "..");
const CLI = join(ROOT, "dist", "src", "cli.js");

// (a module's docstring isn't compiled into its code at all, here or before: only class and function docstrings are)
test("stripDocstrings: class and function docstrings go; a body left empty still compiles", () => {
  const src = '"""MODULE DOC"""\nclass C:\n    """CLASS DOC"""\n    def m(self):\n        """METHOD DOC"""\n        return 1\ndef f():\n    """ONLY DOC"""\nx = "kept, not a docstring"\n';
  const file = join(tmpdir(), "rill_doc_probe.py");
  const kept = compile(src, file, "rill_doc_probe");
  const stripped = compile(src, file, "rill_doc_probe", false, false, { transform: stripDocstrings });
  for (const d of ["CLASS DOC", "METHOD DOC", "ONLY DOC"]) {
    assert.ok(kept.code.includes(d), `compiled as before: ${d}`);
    assert.ok(!stripped.code.includes(d), `stripped: ${d}`);
  }
  assert.ok(stripped.code.includes("kept, not a docstring"));
});

// (recording runs each module as it compiles it: the Rill start exiting 0 shows the stripped modules run)
test("the Rill start is recorded without docstrings, other modules with theirs", () => {
  const dir = mkdtempSync(join(tmpdir(), "rill-nodoc-"));
  try {
    const out = join(dir, "rec.json");
    const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, SAGEBRUSH_PRECOMPILE_OUT: out, SAGEBRUSH_NO_COMPILE_CACHE: "1" }, timeout: 120000 });
    assert.equal(run(["--rill", "-c", "1"]).status, 0);
    assert.equal(run(["-c", "import json"]).status, 0);
    const modules = JSON.parse(readFileSync(out, "utf8")).modules as Record<string, { path: string; code: string }>;
    const rill = Object.values(modules).filter((m) => m.path.startsWith("_rill/"));
    assert.ok(rill.length >= 5, "the Rill start's modules are recorded");
    // (_rill/mem.py's _allowance docstring, as its source keeps it)
    const memSrc = readFileSync(join(libDir(), "_rill", "mem.py"), "utf8");
    const memDoc = "available to a";
    assert.ok(memSrc.includes(memDoc), "mem.py keeps the docstring in its source");
    const mem = rill.find((m) => m.path === "_rill/mem.py")!;
    assert.ok(!mem.code.includes(memDoc), "recorded without it");
    const json = Object.values(modules).find((m) => m.path === "json/__init__.py")!;
    assert.ok(json.code.includes("Serialize ``obj`` to a JSON formatted"), "another module keeps its docstring (json.dumps)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nothing in Rill reads __doc__ (so recording it without docstrings changes no behaviour)", () => {
  const dir = join(libDir(), "_rill");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".py"))) assert.ok(!readFileSync(join(dir, f), "utf8").includes("__doc__"), f);
});
