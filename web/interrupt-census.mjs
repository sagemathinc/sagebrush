// The interrupt matrix's census (plan-interrupt-harness r4 §5), read from source:
// - every exported engine entry point: engineCall's dispatch (engine/web/src/lib.rs), symCall's
//   ops (engine/sym/src/api.rs), mpCall's ops (engine/mpoly/src/lib.rs `call`), and the
//   WebAssembly modules the runtime instantiates, with whether each reads the interrupt flag;
// - fingerprints the matrix must be updated for: the compiler's loop back-edge check (src/emit.ts:
//   the emitted INTR_CHECK and every site that emits it), the runtime's poll sites per file, the
//   library route registries (Magma's top-level intrinsics, MATLAB's @_bs/@_bi builtins,
//   sage_all's __all__), and the list of lib/ modules.
// test/interrupt-census.test.ts checks every name against web/interrupt-matrix.json;
//   node web/interrupt-census.mjs          prints the census as JSON (for updating the matrix).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// (INTERRUPT_CENSUS_ROOT: another tree, for the census's own mutation tests)
const ROOT = process.env.INTERRUPT_CENSUS_ROOT ?? new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const uniq = (xs) => [...new Set(xs)].sort();
const sha = (xs) => createHash("sha256").update(xs.join("\n")).digest("hex").slice(0, 16);

// the string keys of a Rust `match` arm list: lines like  "name" => ...  or  "a" | "b" => ...
function matchKeys(src) {
  const out = [];
  for (const line of src.split("\n")) {
    const m = line.match(/^\s*("[a-z_0-9.]+"(?:\s*\|\s*"[a-z_0-9.]+")*)\s*=>/);
    if (m) for (const k of m[1].matchAll(/"([a-z_0-9.]+)"/g)) out.push(k[1]);
  }
  return uniq(out);
}
// the body of `pub fn NAME(` up to the next top-level `pub fn` or `fn`
function fnBody(src, name) {
  const i = src.indexOf(`pub fn ${name}(`);
  if (i < 0) throw new Error(`no pub fn ${name}`);
  const rest = src.slice(i + 1);
  const j = rest.search(/\n(pub )?fn [a-z_]+[(<]/);
  return j < 0 ? rest : rest.slice(0, j);
}

export function census() {
  const engineCall = matchKeys(read("engine/web/src/lib.rs"));
  // (symCall dispatches from `call` into helpers in the same file, so the whole file is read)
  const symCall = matchKeys(read("engine/sym/src/api.rs"));
  const mpCall = matchKeys(fnBody(read("engine/mpoly/src/lib.rs"), "call"));
  const runtime = readdirSync(join(ROOT, "src/runtime")).filter((f) => f.endsWith(".ts")).sort();
  const wasmModules = runtime
    .filter((f) => /WebAssembly\.(instantiate|Module|Instance)/.test(read(`src/runtime/${f}`)))
    .map((f) => ({ module: f, reads_interrupt: /\bINTR\b|interrupted/.test(read(`src/runtime/${f}`)) }));
  const pollSites = Object.fromEntries(
    runtime.map((f) => [f, (read(`src/runtime/${f}`).match(/pollInterrupt|INTR\[0\]/g) ?? []).length]).filter(([, n]) => n > 0),
  );
  const magma = uniq([...read("lib/_magma.py").matchAll(/^(?:def )?([A-Z][A-Za-z0-9_]*)\s*(?:\(|=)/gm)].map((m) => m[1]));
  const matlab = uniq([...read("lib/_matlab.py").matchAll(/^@_b[si]\(\s*"([^"]+)"/gm)].map((m) => m[1]));
  const sageAll = read("lib/sage_all.py");
  const allBlock = sageAll.slice(sageAll.indexOf("__all__ = ["), sageAll.indexOf("]", sageAll.indexOf("__all__ = [")));
  const sage = uniq([...allBlock.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)].map((m) => m[1]));
  const libModules = readdirSync(join(ROOT, "lib")).filter((f) => f.endsWith(".py")).sort();
  // the compiler's back-edge polling (r5 §5): the emitted check itself, which must test Ctrl-C's
  // bit and call interrupted(), and the lines that emit it (a dropped or bypassed site changes them)
  const emit = read("src/emit.ts");
  const check = (emit.match(/^const INTR_CHECK = "([^"]*)";/m) ?? [])[1] ?? null;
  const emitSites = emit.split("\n").map((l) => l.trim()).filter((l) => /\bINTR_CHECK\b/.test(l) && !/^const INTR_CHECK =/.test(l));
  const backedges = { check, valid: check != null && /INTR\[0\]\s*&\s*1\b/.test(check) && /\binterrupted\(\)/.test(check), sites: emitSites.length, sha: sha(emitSites) };
  return {
    transports: { engineCall, symCall, mpCall, wasmModules },
    fingerprints: {
      backedges,
      pollSites,
      registries: { magma: { count: magma.length, sha: sha(magma) }, matlab: { count: matlab.length, sha: sha(matlab) }, sage: { count: sage.length, sha: sha(sage) } },
      libModules: { count: libModules.length, sha: sha(libModules) },
    },
    names: { magma, matlab, sage, libModules },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = census();
  const brief = process.argv.includes("--names") ? c : { ...c, names: Object.fromEntries(Object.entries(c.names).map(([k, v]) => [k, v.length])) };
  console.log(JSON.stringify(brief, null, 1));
}
