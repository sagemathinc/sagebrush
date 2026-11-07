import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCUMENT_MODES, FLAG_MODES, KERNEL_MODES, KERNEL_SPECS, MODE_NAMES, REPL_MODES, TRANSLATED_MODES, isFlagMode, isModeName, isTranslated, modeFlag, modeFlags, modeOfFlags } from "../src/modes";
import { installKernel } from "../src/kernel";
import { cleanDoc } from "../web/board/doc";
import { BOARD_SCHEMA } from "../web/board/format-schema";

// The mode registry (src/modes.ts, design/rill.md §5.1) took the place of the
// copies of the mode set in src/ and web/ without changing what any of them
// does: these pin, as they were before it, the defaults, the board's
// serialized schema, the kernels' specs, the CLI's words and the worker
// messages' flags, and that the registry stays plain data (nothing imported,
// so it adds no module to any bundle that takes it). A new mode changes these
// on purpose, in its own PR.
const repo = join(__dirname, "..", "..");
const text = (p: string) => readFileSync(join(repo, p), "utf8");

test("the registry's subsets, in their consumers' orders", () => {
  assert.deepEqual(MODE_NAMES, ["python", "sage", "magma", "matlab"]);
  assert.deepEqual(DOCUMENT_MODES, ["python", "sage", "magma", "matlab"]);
  assert.deepEqual(FLAG_MODES, ["sage", "magma", "matlab"]);
  assert.deepEqual(TRANSLATED_MODES, ["magma", "matlab"]);
  assert.deepEqual(REPL_MODES, ["python", "magma", "matlab"]);
  assert.deepEqual(KERNEL_MODES, ["sage", "python", "magma", "matlab"]);
  for (const s of [...MODE_NAMES]) assert.ok(isModeName(s));
  for (const s of ["", "Python", "r", "all", null, undefined, 1, {}]) assert.ok(!isModeName(s) && !isFlagMode(s) && !isTranslated(s as any), String(s));
  assert.deepEqual(MODE_NAMES.filter(isFlagMode), FLAG_MODES);
  assert.deepEqual(MODE_NAMES.filter(isTranslated), TRANSLATED_MODES);
});

test("src/modes.ts is plain data: it imports nothing", () => {
  const src = text("src/modes.ts");
  assert.doesNotMatch(src, /^\s*(import|export\s+[^;]*\sfrom)\s/m);
  assert.doesNotMatch(src, /\brequire\s*\(|\bimport\s*\(/);
});

test("a worker message's mode flags, as each host sent them", () => {
  // (src/reactive-session.ts and src/board-run.ts: every flag, in this order)
  assert.equal(JSON.stringify(modeFlags("python")), '{"sage":false,"magma":false,"matlab":false}');
  assert.equal(JSON.stringify(modeFlags("sage")), '{"sage":true,"magma":false,"matlab":false}');
  assert.equal(JSON.stringify(modeFlags("magma")), '{"sage":false,"magma":true,"matlab":false}');
  assert.equal(JSON.stringify(modeFlags("matlab")), '{"sage":false,"magma":false,"matlab":true}');
  assert.equal(JSON.stringify(modeFlags(undefined)), '{"sage":false,"magma":false,"matlab":false}');
  // (src/local-gateway.ts: only the one set; the gateway's mode is any string, Python by default)
  assert.deepEqual([modeFlag("python"), modeFlag("sage"), modeFlag("magma"), modeFlag("matlab"), modeFlag("r"), modeFlag(undefined)], [{}, { sage: true }, { magma: true }, { matlab: true }, {}, {}]);
  // (web/worker.ts, src/notebook-session.ts: the first flag set, in this order; none is Python)
  assert.equal(modeOfFlags({}), null);
  assert.equal(modeOfFlags({ sage: false, magma: false, matlab: false }), null);
  assert.equal(modeOfFlags({ matlab: 1 }), "matlab");
  assert.equal(modeOfFlags({ magma: true, matlab: true }), "magma");
  assert.equal(modeOfFlags({ sage: true, magma: true, matlab: true }), "sage");
});

test("web/notebook/worker-kernel.js (loaded from its text, so it imports nothing) sends the same flags", () => {
  const src = text("web/notebook/worker-kernel.js");
  assert.match(src, /if \(mode !== "sage" && mode !== "magma" && mode !== "matlab"\) return null;/);
  const sent = src.match(/sage: (?:opts\.)?mode === "sage", magma: (?:opts\.)?mode === "magma", matlab: (?:opts\.)?mode === "matlab"/g) ?? [];
  assert.equal(sent.length, 3);
  assert.deepEqual(FLAG_MODES, ["sage", "magma", "matlab"]);
});

test("the Jupyter kernels: specs, install order and --mode's error", () => {
  assert.deepEqual(KERNEL_SPECS, {
    sage: {
      dir: "sagebrush",
      display: "Sagebrush (Sage)",
      language: "sage",
      info: { name: "sage", version: "3.14", mimetype: "text/x-python", file_extension: ".sage", codemirror_mode: { name: "ipython", version: 3 }, pygments_lexer: "ipython3" },
    },
    python: {
      dir: "sagebrush-python",
      display: "Sagebrush (Python)",
      language: "python",
      info: { name: "python", version: "3.14", mimetype: "text/x-python", file_extension: ".py", codemirror_mode: { name: "ipython", version: 3 }, pygments_lexer: "ipython3", nbconvert_exporter: "python" },
    },
    magma: {
      dir: "sagebrush-magma",
      display: "Sagebrush (Magma)",
      language: "magma",
      info: { name: "magma", version: "", mimetype: "text/x-magma", file_extension: ".m" },
    },
    matlab: {
      dir: "sagebrush-matlab",
      display: "Sagebrush (MATLAB)",
      language: "matlab",
      info: { name: "matlab", version: "", mimetype: "text/x-matlab", file_extension: ".m", codemirror_mode: "octave", pygments_lexer: "matlab" },
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "sb-modes-"));
  const out: string[] = [], err: string[] = [];
  const write = { out: process.stdout.write, err: process.stderr.write };
  (process.stdout as any).write = (s: string) => (out.push(String(s)), true);
  (process.stderr as any).write = (s: string) => (err.push(String(s)), true);
  let all: number, none: number, bad: number, sage: number;
  try {
    all = installKernel(["--prefix", dir, "--mode", "all"]);
    sage = installKernel(["--prefix", dir]);
    bad = installKernel(["--prefix", dir, "--mode", "r"]);
    none = installKernel(["--prefix", dir, "--mode"]);
  } finally {
    process.stdout.write = write.out;
    process.stderr.write = write.err;
  }
  try {
    assert.deepEqual([all, sage, bad, none], [0, 0, 1, 1]);
    const kernels = join(dir, "share", "jupyter", "kernels");
    assert.deepEqual(out.map((l) => l.replace(kernels, "K")), [
      'installed the Jupyter kernel "Sagebrush (Sage)" in K/sagebrush\n',
      'installed the Jupyter kernel "Sagebrush (Python)" in K/sagebrush-python\n',
      'installed the Jupyter kernel "Sagebrush (Magma)" in K/sagebrush-magma\n',
      'installed the Jupyter kernel "Sagebrush (MATLAB)" in K/sagebrush-matlab\n',
      'installed the Jupyter kernel "Sagebrush (Sage)" in K/sagebrush\n',
    ]);
    assert.deepEqual(err, ["sagebrush: --mode must be sage, python, magma, matlab or all, not r\n", "sagebrush: --mode must be sage, python, magma, matlab or all, not undefined\n"]);
    for (const [mode, spec] of Object.entries(KERNEL_SPECS)) {
      const k = JSON.parse(readFileSync(join(kernels, spec.dir, "kernel.json"), "utf8"));
      assert.deepEqual(k.argv.slice(-4), ["--jupyter-kernel", "{connection_file}", "--mode", mode]);
      delete k.argv;
      assert.deepEqual(k, { display_name: spec.display, language: spec.language, interrupt_mode: "message", metadata: { debugger: false } });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the board format: its mode, Python by default and not written; a code item's, any of the four", () => {
  // (BoardMode is written out in web/board/doc.ts, where the schema's script reads it)
  assert.match(text("web/board/doc.ts"), /^export type BoardMode = "python" \| "sage" \| "magma" \| "matlab";$/m);
  const schema = BOARD_SCHEMA as any;
  assert.deepEqual(schema.properties.mode.enum, DOCUMENT_MODES);
  const json = JSON.parse(text("web/board-format.schema.json"));
  assert.deepEqual(json.properties.mode.enum, DOCUMENT_MODES);
  const board = (mode: unknown, item: unknown) => cleanDoc({ format: "sagebrush-board", version: 1, mode, nodes: [{ id: "a", code: "1", mode: item }, { id: "b", text: "x", mode: item }] });
  for (const m of [...FLAG_MODES]) assert.equal(board(m, m).mode, m);
  for (const m of ["python", "r", "", null, undefined, 3]) assert.equal("mode" in board(m, m), false, String(m));
  for (const m of [...DOCUMENT_MODES]) {
    const [code, note] = board("sage", m).nodes!;
    assert.equal((code as any).mode, m);
    assert.equal("mode" in note, false);
  }
  for (const m of ["r", "", null, 3]) assert.equal("mode" in board("sage", m).nodes![0], false, String(m));
});

test("the workspace's create verb takes the four document modes", () => {
  const schema = JSON.parse(text("web/workspace/schema.json"));
  const modes: unknown[] = [];
  JSON.stringify(schema, (k, v) => (k === "mode" && v && Array.isArray(v.enum) && modes.push(v.enum), v));
  assert.ok(modes.length >= 1);
  for (const m of modes) assert.deepEqual(m, DOCUMENT_MODES);
});
