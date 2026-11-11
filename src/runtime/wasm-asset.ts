// A WebAssembly module of the runtime's own, compiled the first time it is
// needed (the PNG module, src/runtime/raster.ts; the multiprecision core,
// src/runtime/mpcore.ts), its bytes from wherever the host keeps them:
//   globalThis.__SAGEBRUSH_<KEY>__      as base64 (the CLI bundle)
//   globalThis.__SAGEBRUSH_<KEY>_URL__  a URL to fetch synchronously (the
//                                       notebook's worker), checked against
//                                       __SAGEBRUSH_<KEY>_SHA256__
//   else, in Node, the file wasm/<file> above this module.

import { sha256Hex } from "./sha256";

/** the module's bytes; `name` is how its errors call it ("PNG module") */
export function assetBytes(key: string, file: string, name: string): Uint8Array {
  const g = globalThis as any;
  const b64 = g[`__SAGEBRUSH_${key}__`], url = g[`__SAGEBRUSH_${key}_URL__`];
  if (typeof b64 === "string") {
    const bin = atob(b64);
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }
  if (url) {
    // only the bytes the page was built with run (design/security.md,
    // SEC-522-1): without the hash they are not fetched at all
    const want = g[`__SAGEBRUSH_${key}_SHA256__`];
    if (typeof want !== "string" || !/^[0-9a-f]{64}$/.test(want)) throw new Error(`the ${name} has no SHA-256 to check, so it is not loaded`);
    let b: Uint8Array;
    if (typeof g.__SAGEBRUSH_FETCH_SYNC__ === "function") b = g.__SAGEBRUSH_FETCH_SYNC__(String(url));
    else {
      const x = new XMLHttpRequest();
      x.open("GET", String(url), false);
      x.responseType = "arraybuffer";
      x.send();
      if (x.status !== 200) throw new Error(`could not load the ${name} (HTTP ${x.status})`);
      b = new Uint8Array(x.response);
    }
    if (sha256Hex(b) !== want) throw new Error(`the ${name} fetched is not the one this page was built with`);
    return b;
  }
  const fs = g.process?.getBuiltinModule?.("fs"), path = g.process?.getBuiltinModule?.("path");
  if (fs && path) {
    const start = typeof __dirname === "string" ? __dirname : g.process.cwd();
    for (let dir = start, i = 0; i < 6; i++, dir = path.dirname(dir)) {
      const f = path.join(dir, "wasm", file);
      if (fs.existsSync(f)) return new Uint8Array(fs.readFileSync(f));
    }
  }
  throw new Error(`Sagebrush's ${name} (${file}) is not available here`);
}
