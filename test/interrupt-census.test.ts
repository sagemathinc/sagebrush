import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The interrupt matrix's census (plan-interrupt-harness r4 §5): every exported engine entry
// point (engineCall, symCall, mpCall) and every WebAssembly module that doesn't read the
// interrupt flag has an entry in web/interrupt-matrix.json, and the fingerprints of the runtime's
// poll sites, the library route registries and the lib/ modules match the committed ones.  A
// change fails here with what changed, until the matrix is regenerated and the new names are
// classified (web/interrupt-matrix-gen.py).
const root = join(__dirname, "..", "..");
const r = spawnSync(process.execPath, [join(root, "web", "interrupt-census.mjs"), "--names"], { encoding: "utf8" });
const census = JSON.parse(r.stdout);
const matrix = JSON.parse(readFileSync(join(root, "web", "interrupt-matrix.json"), "utf8"));
const listed = new Set<string>();
for (const e of matrix.entries) {
  listed.add(e.transport);
  for (const t of e.covers ?? []) listed.add(t);
}

test("every exported engine entry point and every non-polling wasm module has a matrix entry", () => {
  const missing: string[] = [];
  for (const tr of ["engineCall", "symCall", "mpCall"]) for (const n of census.transports[tr]) if (!listed.has(`${tr}:${n}`)) missing.push(`${tr}:${n}`);
  for (const m of census.transports.wasmModules) if (!m.reads_interrupt && !listed.has(`wasm:${m.module}`)) missing.push(`wasm:${m.module}`);
  assert.deepEqual(missing, [], "new entry points without a matrix entry (classify them in web/interrupt-matrix-gen.py): " + missing.join(", "));
});

test("no matrix entry names an engine entry point that no longer exists", () => {
  const known = new Set<string>();
  for (const tr of ["engineCall", "symCall", "mpCall"]) for (const n of census.transports[tr]) known.add(`${tr}:${n}`);
  for (const m of census.transports.wasmModules) known.add(`wasm:${m.module}`);
  const stale = matrix.entries.map((e: any) => e.transport).filter((t: string) => /^(engineCall|symCall|mpCall|wasm):/.test(t) && !known.has(t));
  assert.deepEqual(stale, []);
});

test("the poll sites, route registries and lib modules match the matrix's fingerprints", () => {
  assert.deepEqual(census.fingerprints, matrix.fingerprints,
    "a poll site, a registry (Magma, MATLAB, Sage) or the lib/ module list changed: classify new routes, then regenerate web/interrupt-matrix.json");
});

test("a cheap exclusion is only an exclusion with its evidence; the counts are reported", () => {
  const by: Record<string, number> = {};
  for (const e of matrix.entries) by[e.status] = (by[e.status] ?? 0) + 1;
  console.log("interrupt matrix:", JSON.stringify(by));
  for (const e of matrix.entries) {
    if (e.status === "cheap") assert.ok(e.evidence && (e.evidence.bound || e.evidence.max_gap_ms !== undefined), `${e.id}: a cheap exclusion needs its evidence`);
  }
  // (strict: every name a case or an evidenced exclusion, as the PR must have it at merge)
  if (process.env.INTERRUPT_CENSUS_STRICT) assert.equal((by.planned ?? 0) + (by["cheap-candidate"] ?? 0), 0, "names still planned or without evidence");
});

test("the compiler's back-edge check is in the census: valid now, and a mutation of it changes the census", () => {
  assert.equal(census.fingerprints.backedges.valid, true, "src/emit.ts's INTR_CHECK no longer tests Ctrl-C's bit and calls interrupted()");
  assert.ok(census.fingerprints.backedges.sites >= 1);
  // (a copy of the tree with src/emit.ts mutated: everything else symlinked, the census pointed at it)
  const emit = readFileSync(join(root, "src", "emit.ts"), "utf8");
  const mutated = (text: string) => {
    const t = mkdtempSync(join(tmpdir(), "intr-census-"));
    try {
      for (const d of ["engine", "lib"]) symlinkSync(join(root, d), join(t, d));
      mkdirSync(join(t, "src"));
      symlinkSync(join(root, "src", "runtime"), join(t, "src", "runtime"));
      writeFileSync(join(t, "src", "emit.ts"), text);
      const r = spawnSync(process.execPath, [join(root, "web", "interrupt-census.mjs")], { encoding: "utf8", env: { ...process.env, INTERRUPT_CENSUS_ROOT: t } });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout).fingerprints.backedges;
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  };
  // the emitted check emptied (astra's isolated mutation, PR #168 review): no longer valid
  const emptied = mutated(emit.replace(/^const INTR_CHECK = "[^"]*";/m, 'const INTR_CHECK = "";'));
  assert.equal(emptied.valid, false);
  assert.notDeepEqual(emptied, census.fingerprints.backedges);
  // one emitting site dropped (a loop form that no longer polls): the sites change
  const lines = emit.split("\n");
  const k = lines.findIndex((l) => /\bINTR_CHECK\b/.test(l) && !/^const INTR_CHECK =/.test(l.trim()));
  assert.ok(k >= 0);
  const dropped = mutated(lines.filter((_, i) => i !== k).join("\n"));
  assert.equal(dropped.sites, census.fingerprints.backedges.sites - 1);
  assert.notEqual(dropped.sha, census.fingerprints.backedges.sha);
});
