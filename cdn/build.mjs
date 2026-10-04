// Build the single-file ES modules served from jsdelivr (cdn.jsdelivr.net/gh/sagemathinc/sagebrush@<ref>/cdn/...):
//   sagebrush-engine.mjs  the Rust engines (wasm32, base64-inlined: chat sandboxes forbid fetch())
//   pyparse.mjs           CPython 3.14's parser in TypeScript
// Run from ~/sagebrush:  node cdn/build.mjs
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const sh = (cmd) => execSync(cmd, { stdio: "inherit", shell: "/bin/bash" });
sh("cd engine && PATH=$HOME/.cargo/bin:$PATH CARGO_TARGET_DIR=/tmp/webtarget cargo build -q --release -p sagebrush-web --target wasm32-unknown-unknown");
const wasm = readFileSync("/tmp/webtarget/wasm32-unknown-unknown/release/sagebrush_web.wasm");
const engine = `// Sagebrush engines (Rust -> wasm32), one self-contained ES module.
// Usage: const sb = await import("https://cdn.jsdelivr.net/gh/sagemathinc/sagebrush@REF/cdn/sagebrush-engine.mjs");
//        sb.dims({n: 13, k: 2, chi: [6, [2], [1]]})
// Characters: chi = [order, gens, vals] with chi(gens[i]) = zeta_order^vals[i] (LMFDB char_values); omit for trivial.
const WASM = "${wasm.toString("base64")}";
const bytes = Uint8Array.from(atob(WASM), (c) => c.charCodeAt(0));
const { instance } = await WebAssembly.instantiate(bytes, {});
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
sh("cd pyparse && ../node_modules/.bin/tsc -p . && ~/sagejs/node_modules/.bin/esbuild src/index.ts --bundle --minify --format=esm --platform=neutral --external:./unames.gen --outfile=../cdn/pyparse.mjs --log-level=warning");
sh("ls -la cdn/*.mjs | awk '{print $5, $9}'; for f in cdn/*.mjs; do echo \"$f gzip: $(gzip -9c $f | wc -c)\"; done");
