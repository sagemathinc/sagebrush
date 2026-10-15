import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const cli = join(__dirname, "..", "src", "cli.js");
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

test("every intrinsic Magma mode binds has a summary in the Magma index (lib/_magma_docsearch.py)", () => {
  const r = run("-m", "_magma_docsearch", "--check");
  assert.equal(r.stdout.trim(), '{"missing": [], "extra": []}', r.stdout + r.stderr);
  assert.equal(r.status, 0);
});

test("sagebrush --search --mode searches that language's index; the default is unchanged", () => {
  const magma = run("--search", "class", "group", "--mode", "magma");
  assert.match(magma.stdout, /^ClassGroup\(K : Bound, Proof\)    \[magma\]\n    The class group of a number field/);
  const matlab = run("--search", "linsolve", "--mode", "matlab");
  assert.match(matlab.stdout, /^linsolve\(\)    \[matlab\]/);
  const sage = run("--search", "selmer", "rank");
  assert.match(sage.stdout, /^EllipticCurve_rational_field\.selmer_rank\(\)\n/);
  assert.match(run("--search", "linear", "system", "--mode", "python").stdout, /^numpy\.linalg\.solve\(a, b\)    \[python\]\n/);
  const json = JSON.parse(run("--search", "unit", "group", "--mode", "magma", "--json").stdout);
  assert.equal(json[0].name, "UnitGroup");
  assert.equal(json[0].language, "magma");
  const bad = run("--search", "x", "--mode", "fortran");
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /--mode must be one of sage, python, magma, matlab/);
});

test("the capability map has every language, and each area's sample search finds some of that area's functions", () => {
  const dir = mkdtempSync(join(tmpdir(), "capmap-"));
  const f = join(dir, "check.py");
  writeFileSync(f, [
    "import _capability_map as C, _pyjs_docsearch as D",
    "md = C.build()",
    "for h in ('## Sage and Python', '## Magma', '## MATLAB'):",
    "    assert h in md, h",
    "bad = []",
    "for mode, rows in (('sage', C.sage_rows()), ('magma', C.magma_rows()), ('matlab', C.matlab_rows())):",
    "    for area, entries, query in rows:",
    "        assert entries, area",
    "        names = set(e['name'] for e in entries)",
    "        hits = [e['name'] for _, e in D.search(query, 20, None if mode == 'sage' else mode)]",
    "        if not names.intersection(hits):",
    "            bad.append((mode, area, query))",
    "print('bad', bad)",
    "",
  ].join("\n"));
  const r = spawnSync(process.execPath, [cli, f], { encoding: "utf8", cwd: dir });
  assert.equal(r.stdout.trim(), "bad []", r.stdout + r.stderr);
});
