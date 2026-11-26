import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

// lib/_sage_names.py's DEPS against real imports: each module the index
// reaches (NAMES and SHIM_NAMES, closed under DEPS) is imported alone, in
// Python mode, and the Sage-layer modules it loads must be exactly the
// closure of its DEPS entry.  scripts/sage_names.py derives DEPS from the
// sources (the AST); this catches an import-time edge it can't see, such as
// a module-level call that imports (class GraphPlot(_sa_plot().Graphics)).
const CLI = __dirname + "/../src/cli.js";
const run = promisify(execFile);

test("DEPS in lib/_sage_names.py is every Sage-layer module a module loads at import, and no more", async () => {
  const dump = execFileSync(process.execPath, [CLI, "-c",
    "import json, _sage_names as N\nprint(json.dumps({'deps': {k: list(v) for k, v in N.DEPS.items()}, " +
    "'roots': sorted(set(N.NAMES.values()) | (set(N.SHIM_NAMES.values()) - {'sage_all'}))}))"], { encoding: "utf8", timeout: 120000 });
  const { deps, roots } = JSON.parse(dump.trim().split("\n").pop() as string) as { deps: Record<string, string[]>; roots: string[] };
  const closure = (m: string): Set<string> => {
    const out = new Set<string>();
    const todo = [...(deps[m] ?? [])];
    while (todo.length) {
      const d = todo.pop() as string;
      if (out.has(d)) continue;
      out.add(d);
      todo.push(...(deps[d] ?? []));
    }
    return out;
  };
  const mods = new Set<string>(roots);
  for (const r of roots) for (const d of closure(r)) mods.add(d);
  const list = [...mods].sort();
  assert.ok(list.length > 20, `only ${list.length} modules reached`);
  const probe = (m: string) =>
    `import sys\nbefore = set(sys.modules)\nimport ${m}\n` +
    `print('@@' + ','.join(sorted(x for x in sys.modules if x not in before and x != '${m}' and (x.startswith('_sage_') or x.startswith('sage_')))))`;
  const wrong: string[] = [];
  for (let i = 0; i < list.length; i += 4) {
    await Promise.all(list.slice(i, i + 4).map(async (m) => {
      const { stdout } = await run(process.execPath, [CLI, "-c", probe(m)], { encoding: "utf8", timeout: 300000 });
      const line = stdout.split("\n").filter((l) => l.startsWith("@@")).pop();
      assert.ok(line !== undefined, `${m}: no probe output`);
      const loaded = line.slice(2) ? line.slice(2).split(",") : [];
      const want = [...closure(m)].sort();
      if (loaded.join(",") !== want.join(",")) wrong.push(`${m}: loads [${loaded.join(", ")}], DEPS closure [${want.join(", ")}]`);
    }));
  }
  assert.deepEqual(wrong, [], "rerun python3 scripts/sage_names.py --write, or teach import_edges the new import:\n" + wrong.join("\n"));
});
