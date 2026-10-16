import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const cli = join(__dirname, "..", "src", "cli.js");
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

test("every intrinsic Magma mode binds has a summary and an example in the Magma index (lib/_magma_docsearch.py)", () => {
  const r = run("-m", "_magma_docsearch", "--check");
  assert.equal(r.stdout.trim(), '{"missing": [], "extra": [], "no_example": []}', r.stdout + r.stderr);
  assert.equal(r.status, 0);
});

test("sagebrush --search --mode searches that language's index; the default is unchanged", () => {
  const magma = run("--search", "class", "group", "--mode", "magma");
  assert.match(magma.stdout, /^ClassGroup\(K : Bound, Proof\)    \[magma\]\n    The class group of a number field/);
  const matlab = run("--search", "linsolve", "--mode", "matlab");
  assert.match(matlab.stdout, /^linsolve\(\)    \[matlab\]/);
  const sage = run("--search", "selmer", "rank");
  assert.match(sage.stdout, /^EllipticCurve_rational_field\.selmer_rank\(\)\n/);
  // (a catalog entry, for agents: call form and status, summary, first example, differs: catalog/SCHEMA.md)
  const py = run("--search", "linear", "system", "--mode", "python").stdout;
  assert.match(py, /^numpy\.linalg\.solve\(a, b\)    \[python\]    \[partial\]\n    The solution x of the linear system a x = b\.\n    >>> import numpy as np\n    >>> np\.linalg\.solve\(\[\[3, 1\], \[1, 2\]\], \[9, 8\]\)\n    array\(\[2\., 3\.\]\)\n    differs: Not yet reviewed/);
  const pyj = JSON.parse(run("--search", "linear", "system", "--mode", "python", "--json").stdout);
  assert.equal(pyj[0].name, "numpy.linalg.solve");
  // (each example with the prelude lines it needs, CORR-012-1)
  assert.equal(pyj[0].examples[0].setup, "import numpy as np");
  const setups = run("-c", "import _catalog as c\nP = 'import numpy as np\\nimport math, cmath, itertools\\nfrom fractions import Fraction'\nfor code in ['math.pi', 'Fraction(1, 3) + cmath.sqrt(-1)', 'len([1])', 'npx = 1']: print(repr(c.setup(P, code)))").stdout;
  assert.equal(setups, "'import math'\n'import cmath\\nfrom fractions import Fraction'\n''\n''\n");
  // (a whole call form, MATLAB's, is shown as written; "(...)" follows the name, CORR-012-2)
  const forms = run("-c", "import _pyjs_docsearch as d\nprint(d.describe({'name': 'max', 'kind': 'function', 'signature': 'M = max(A)\\n[M, I] = max(___)', 'summary': 'S.', 'doc': ''}, 'matlab'))").stdout;
  assert.match(forms, /^M = max\(A\)    \[matlab\]\n    also: \[M, I\] = max\(___\)\n    S\.\n$/);
  for (const k of ["signature", "summary", "examples", "differs", "status", "upstream_version"]) assert.ok(k in pyj[0], k);
  // (a block's code at the prompt, its continuation lines after ...)
  assert.match(run("--search", "lru_cache", "--mode", "python").stdout, /\n    >>> @functools\.lru_cache\(maxsize=None\)\n    \.\.\. def fib\(n\):\n/);
  const json = JSON.parse(run("--search", "unit", "group", "--mode", "magma", "--json").stdout);
  assert.equal(json[0].name, "UnitGroup");
  assert.equal(json[0].language, "magma");
  // (an alias is a name of its entry: found and ranked by it, catalog/SCHEMA.md)
  const alias = run("-c", "import _pyjs_docsearch as d\ne = {'name': 'diff', 'aliases': ['derivative'], 'summary': 'S.', 'doc': '', 'open_problem': False}\nprint(d.score(e, ['derivative'], 'derivative'), d.score(dict(e, aliases=[]), ['derivative'], 'derivative'))").stdout.trim();
  assert.equal(alias, "30 0");
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
