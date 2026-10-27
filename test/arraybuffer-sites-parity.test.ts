import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The gate's parity with TypeScript 7 (erratum E1r2.2): tsc 7 checks, at every
// call and `new`, the kind TypeScript 5.9's walk gave it, in both directions
// (scripts/arraybuffer-sites-parity.mjs).  A site tsc 7 can't finish is a
// reviewed entry in the table's parity section; any other disagreement fails.
const ROOT = join(__dirname, "..", "..");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const P = require(join(ROOT, "scripts/arraybuffer-sites-parity.mjs"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const G = require(join(ROOT, "scripts/arraybuffer-sites-check.mjs"));

test("tsc 7 agrees with every kind on this tree, except the reviewed sites it can't finish", () => {
  const r = P.checkParity(ROOT);
  assert.deepEqual(r.disagree, [], "a disagreement between TypeScript 5.9's walk and tsc 7");
  assert.deepEqual(r.unplaced.map((e: any) => e.line), [], "an error the wrapping caused away from any site");
  const table = G.readTable(ROOT);
  const want = Object.entries(table.parity ?? {}).map(([k, v]: [string, any]) => `${k} ${v.kind59} ${v.tsc7}`).sort();
  const got = r.unresolved.map((u: any) => `${u.key} ${u.kind59} ${u.tsc7}`).sort();
  assert.deepEqual(got, want, "the sites tsc 7 can't finish are exactly the reviewed parity entries");
  for (const [k, v] of Object.entries(table.parity ?? {}) as [string, any][]) assert.ok(P.PARITY_REASONS[v.tsc7] && v.reason === P.PARITY_REASONS[v.tsc7], k);
  // the skips are counted, never silent
  assert.ok(r.p1.wrapped > 20000);
  for (const k of Object.keys(r.p1.skipped)) assert.ok(P.SKIPS.includes(k), k);
});

test("E1r2.2.4: the parity check rejects a clean site made any, a store expected clean, and a store replaced by a concrete non-store", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-parity-fx-"));
  try {
    const opts = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")).compilerOptions;
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: opts, include: ["src/**/*.ts", "web/**/*.ts"] }));
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    const files: Record<string, string> = {
      "web/worker.ts": "export {};\n",
      "src/runtime/c.ts": `export function a(): number { return 1; }
export function b(): Uint8Array { return new Uint8Array(4); }
export function uses() { const x = a(); const y = b(); const z = new Uint8Array(8); return [x, y, z]; }
`,
    };
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t);
    }
    const clean = P.parity(dir);
    assert.equal(clean.mismatch.length, 0, clean.errors.join("\n"));
    for (const control of ["i", "ii", "iii"]) {
      const r = P.parity(dir, { control });
      assert.ok(r.control, `control ${control} found a site`);
      assert.ok(r.mismatch.some((e: any) => e.site.start === r.control.start), `control ${control} is rejected: ${r.errors.join(" | ")}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
