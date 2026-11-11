// Build the single-file ES modules of the npm package sagebrush-web, served by jsdelivr
// (cdn.jsdelivr.net/npm/sagebrush-web@<version>/...):
//   sagebrush-engine.mjs  the Rust engines (wasm32, base64-inlined: chat sandboxes forbid fetch())
//   pyparse.mjs           CPython 3.14's parser in TypeScript
// Both are build outputs, not kept in git; a v* release builds them before publishing.
// Run from ~/sagebrush:  node cdn/build.mjs
// The engine is the committed wasm/sagebrush-engine.wasm (node scripts/build-engine.mjs),
// so this module always carries the same engine as the notebook and the CLI.
//   node cdn/build.mjs --check   build the engine module from that wasm in a scratch directory, load it and call it
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const sh = (cmd) => execSync(cmd, { stdio: "inherit", shell: "/bin/bash" });
const wasm = readFileSync("wasm/sagebrush-engine.wasm");
const engineModule = (wasm) => `// Sagebrush engines (Rust -> wasm32), one self-contained ES module.
// Usage: const sb = await import("https://cdn.jsdelivr.net/npm/sagebrush-web@VERSION/sagebrush-engine.mjs");
//        sb.dims({n: 13, k: 2, chi: [6, [2], [1]]})
// Characters: chi = [order, gens, vals] with chi(gens[i]) = zeta_order^vals[i] (LMFDB char_values); omit for trivial.
// (gzipped: a third of the size; DecompressionStream is in every current
// browser and in Node 18+)
const WASM = "${gzipSync(wasm, { level: 9 }).toString("base64")}";
const gz = Uint8Array.from(atob(WASM), (c) => c.charCodeAt(0));
const bytes = new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
const { instance } = await WebAssembly.instantiate(bytes, { sagebrush: { interrupted: () => 0 } });
const X = instance.exports;
const enc = new TextEncoder(), dec = new TextDecoder();

/** Call an engine function: call("dims", {n, k, chi}) -> result (throws on error). */
export function call(fn, args = {}) {
  const req = enc.encode(JSON.stringify({ fn, ...args }));
  const p = X.sb_alloc(req.length);
  new Uint8Array(X.memory.buffer, p, req.length).set(req);
  const r = X.sb_call(p, req.length);
  X.sb_free(p, req.length);
  const reply = JSON.parse(dec.decode(new Uint8Array(X.memory.buffer, r, X.sb_reply_len())));
  if ("error" in reply) throw new Error(reply.error);
  return reply.ok;
}
/** Galois-orbit representatives of Dirichlet characters mod n. */
export const characters = (n) => call("characters", { n });
/** dim S_k, E_k and the modular symbols space for (N, k, chi), over Q(chi). */
export const dims = (a) => call("dims", a);
/** Proven charpoly of T_q on M_k(N, chi)^sign over Z[zeta_m]: coeffs[j][i] = coeff of zeta^i in x^j. */
export const charpoly = (a) => call("charpoly", a);
/** Charpoly of T_q modulo a prime ell (any size, fast). */
export const charpolyMod = (a) => call("charpoly_mod", a);
/** Weight 2, trivial character: proven charpoly of T_q on M_2(N)^+ over Z. */
export const weight2 = (a) => call("weight2", a);
/** a_p of the elliptic curve [a1,a2,a3,a4,a6] for p <= n: [[p, ap or null], ...]. */
export const aplist = (a, n) => call("aplist", { a, n });
export const wasmBytes = bytes.length;
`;
if (process.argv.includes("--check")) {
  const dir = mkdtempSync(join(tmpdir(), "sagebrush-cdn-"));
  let failure = null;
  try {
    writeFileSync(join(dir, "sagebrush-engine.mjs"), engineModule(wasm));
    const sb = await import(pathToFileURL(join(dir, "sagebrush-engine.mjs")).href);
    const got = JSON.stringify(sb.call("factor_integer", { n: "18446744073709551617" }));
    if (sb.wasmBytes !== wasm.length || got !== JSON.stringify([["274177", 1], ["67280421310721", 1]]))
      failure = `${sb.wasmBytes} of ${wasm.length} bytes, factor_integer(2^64 + 1) gave ${got}`;
  } catch (e) {
    failure = String(e?.message ?? e);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failure) {
    console.error(`the engine module built from wasm/sagebrush-engine.wasm failed: ${failure}`);
    process.exit(1);
  }
  console.log(`the engine module builds from wasm/sagebrush-engine.wasm (${wasm.length} bytes) and runs`);
  process.exit(0);
}
writeFileSync("cdn/sagebrush-engine.mjs", engineModule(wasm));
sh("cd pyparse && ../node_modules/.bin/tsc -p . && bun build src/index.ts --minify --format=esm --target=browser --external '*/unames.gen' --outfile ../cdn/pyparse.mjs");
sh("ls -la cdn/*.mjs | awk '{print $5, $9}'; for f in cdn/*.mjs; do echo \"$f gzip: $(gzip -9c $f | wc -c)\"; done");
