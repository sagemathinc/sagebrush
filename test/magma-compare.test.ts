import test from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// Every binary operation and every sequence or set intrinsic that takes two
// values, for every pair of values of the kinds Magma mode supports, against
// the outcomes Magma 2.18 gives (run as a black box; test/magma-compare.json,
// made by scripts/magma-compare-table.py, which builds the same program).
const table = JSON.parse(readFileSync(join(__dirname, "..", "..", "test", "magma-compare.json"), "utf8"));

function statements(): [string, string][] {
  // the same list as scripts/magma-compare-table.py statements()
  const names: string[] = table.values.map((v: [string, string]) => v[0]);
  const out: [string, string][] = [];
  const fill = (t: string, vars: Record<string, string>) => t.replace(/\{\{|\}\}|\{(\w)\}/g, (m, v) => (m === "{{" ? "{" : m === "}}" ? "}" : vars[v]));
  for (const [op, t] of table.pair_ops) for (const p of names) for (const q of names) out.push([`${op} ${p} ${q}`, fill(t, { p: `v_${p}`, q: `v_${q}` })]);
  for (const [op, t] of table.universe_ops) for (const u of table.universes) for (const p of names) out.push([`${op} ${p} ${u}`, fill(t, { p: `v_${p}`, u: `v_${u}` })]);
  return out;
}

/** Sagebrush's outcome for statements [lo, hi), in one session. */
function run(stmts: [string, string][], lo: number, hi: number): string[] {
  const prog = [
    ...table.prelude,
    ...table.values.map(([n, e]: [string, string]) => `v_${n} := ${e};`),
    ...stmts.slice(lo, hi).flatMap(([, s], j) => [`print "@@${lo + j}";`, s]),
  ].join("\n") + "\n";
  // standard input from a file: the session goes on after each error
  const dir = mkdtempSync(join(tmpdir(), "magma-compare-"));
  const f = join(dir, "pairs.m");
  writeFileSync(f, prog);
  const fd = openSync(f, "r");
  const r = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { encoding: "utf8", stdio: [fd, "pipe", "pipe"], maxBuffer: 1 << 27 });
  closeSync(fd);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, `${r.error} ${r.stderr}`.slice(0, 2000));
  const cells = new Map<number, string[]>();
  let cur = -1;
  for (const line of r.stdout.split("\n")) {
    const m = /^@@(\d+)$/.exec(line.trim());
    if (m) cells.set((cur = Number(m[1])), []);
    else if (cur >= 0) cells.get(cur)!.push(line);
  }
  return Array.from({ length: hi - lo }, (_, j) => {
    const lines = cells.get(lo + j);
    if (!lines) return "missing";
    const err = lines.find((l) => /error/i.test(l));
    if (err) return err.trim();
    const v = lines.filter((l) => l.trim()).join("\n");
    return v === "true" ? "T" : v === "false" ? "F" : "V";
  });
}

test("every binary operation and two-value mutator agrees with Magma for every pair of kinds", () => {
  const stmts = statements();
  const codes: string[] = table.codes.split(",");
  assert.equal(codes.length, stmts.length);
  const bad: string[] = [];
  for (let lo = 0; lo < stmts.length; lo += 6000) {
    const hi = Math.min(lo + 6000, stmts.length);
    const got = run(stmts, lo, hi);
    for (let k = lo; k < hi; k++) {
      if (codes[k] === "X") continue; // Magma itself crashes there
      const key = stmts[k][0];
      const want = /^\d+$/.test(codes[k]) ? table.errors[Number(codes[k])] : codes[k];
      const g = got[k - lo];
      if (key in table.fail_closed) {
        // Sagebrush refuses on purpose (the reason is in the table): an error
        if (!/error/i.test(g)) bad.push(`${key}: Magma ${want}, Sagebrush ${g} (should refuse)`);
      } else if (g !== want) bad.push(`${key}: Magma ${want}, Sagebrush ${g}`);
    }
  }
  if (process.env.MAGMA_COMPARE_DUMP) writeFileSync(process.env.MAGMA_COMPARE_DUMP, bad.join("\n") + "\n");
  assert.deepEqual(bad.slice(0, 40), [], `${bad.length} differ`);
});
