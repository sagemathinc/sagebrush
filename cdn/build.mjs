// Build the single-file ES modules served from jsdelivr (cdn.jsdelivr.net/gh/sagemathinc/sagebrush@<ref>/cdn/...):
//   sagebrush-engine.mjs  the Rust engines (wasm32, base64-inlined: chat sandboxes forbid fetch())
//   pyparse.mjs           CPython 3.14's parser in TypeScript
// Run from ~/sagebrush:  node cdn/build.mjs
// The engine is the committed wasm/sagebrush-engine.wasm (node scripts/build-engine.mjs),
// so this module always carries the same engine as the notebook and the CLI.
//   node cdn/build.mjs --check   fail unless cdn/sagebrush-engine.mjs embeds exactly that wasm
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";

const sh = (cmd) => execSync(cmd, { stdio: "inherit", shell: "/bin/bash" });
const wasm = readFileSync("wasm/sagebrush-engine.wasm");
if (process.argv.includes("--check")) {
  const m = readFileSync("cdn/sagebrush-engine.mjs", "utf8").match(/const WASM = "([^"]*)"/);
  if (!m || !gunzipSync(Buffer.from(m[1], "base64")).equals(wasm)) {
    console.error("cdn/sagebrush-engine.mjs does not embed wasm/sagebrush-engine.wasm: run node cdn/build.mjs");
    process.exit(1);
  }
  console.log("cdn/sagebrush-engine.mjs embeds wasm/sagebrush-engine.wasm");
  process.exit(0);
}
const engine = `// Sagebrush engines (Rust -> wasm32), one self-contained ES module.
// Usage: const sb = await import("https://cdn.jsdelivr.net/gh/sagemathinc/sagebrush@REF/cdn/sagebrush-engine.mjs");
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
writeFileSync("cdn/sagebrush-engine.mjs", engine);
sh("cd pyparse && ../node_modules/.bin/tsc -p . && bun build src/index.ts --minify --format=esm --target=browser --external '*/unames.gen' --outfile ../cdn/pyparse.mjs");
sh("ls -la cdn/*.mjs | awk '{print $5, $9}'; for f in cdn/*.mjs; do echo \"$f gzip: $(gzip -9c $f | wc -c)\"; done");
