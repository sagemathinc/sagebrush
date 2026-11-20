// The division and scaling ops run only in a worker.  A structural row over the web
// build: from every bundle entry in web/build.ts, the closure of its relative
// imports (static and dynamic) is walked, and every bundle whose closure
// reaches the engine module (src/runtime/engine.ts, the only caller of the
// module's sb_call in the runtime) must be a worker bundle.  So a long
// qpoly_divrem call (its work cap is 2^29 units, about 2.15 s on the
// production wasm engine at the worst measured rate) never runs on the UI
// thread (nor a qpoly_scale, qpoly_derivative, qpoly_integral, qpoly_add,
// qpoly_sub or qpoly_eval call, 2^28 units, about 2.16 s there; nor a
// zpoly_fdiv call, about 0.82 s at its work cap, measured on the slowest
// admitted shape, 999 coefficients of 1025 limbs by a 128-limb divisor, as
// the first call in a fresh process, engine module sha256 3b86bfb0..., on
// an AMD EPYC 7B13 host): Sage mode's Python
// (sagebrush.poly.qdivrem, zdivrem, qscale, qderivative, qintegral, qadd,
// qsub, qeval and zfdiv) runs in the kernel's worker (web/worker.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
const ENGINE = "src/runtime/engine.ts";

function resolve(from: string, spec: string): string | null {
  const base = join(dirname(from), spec);
  const tries = [base, base.replace(/\.js$/, ".ts"), base + ".ts", base + ".js", join(base, "index.ts"), join(base, "index.js")];
  for (const t of tries) if (existsSync(t) && statSync(t).isFile()) return t;
  return null;
}

/** The relative imports (static, re-exports and dynamic) of a source file. */
function imports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;
  for (let m; (m = re.exec(text)); ) {
    const r = resolve(file, m[1]);
    if (r) out.push(r);
  }
  return out;
}

function reaches(entry: string, target: string): boolean {
  const seen = new Set<string>();
  const todo = [entry];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (relative(ROOT, f).split("\\").join("/") === target) return true;
    for (const g of imports(f)) todo.push(g);
  }
  return false;
}

test("every web bundle that can reach the engine (and so the division ops) is a worker", () => {
  const build = join(ROOT, "web", "build.ts");
  const text = readFileSync(build, "utf8");
  const entries = new Set<string>();
  for (const m of text.matchAll(/entrypoints:\s*\[join\(here,\s*((?:"[^"]+"\s*,?\s*)+)\)\]/g)) {
    const parts = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    entries.add(join(ROOT, "web", ...parts));
  }
  assert.ok(entries.size >= 20, `found only ${entries.size} bundle entries in web/build.ts`);
  const reaching = [...entries].filter((e) => existsSync(e) && reaches(e, ENGINE)).map((e) => relative(ROOT, e).split("\\").join("/"));
  console.log(`bundles reaching the engine: ${reaching.join(", ")} (of ${entries.size})`);
  const notWorkers = reaching.filter((r) => !/worker/i.test(r));
  assert.deepEqual(notWorkers, [], `bundles reaching ${ENGINE} that aren't workers: ${notWorkers.join(", ")}`);
  assert.ok(reaching.includes("web/worker.ts"), `the kernel's worker reaches the engine (reaching: ${reaching.join(", ")})`);
});
