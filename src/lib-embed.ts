// The CLI's embedded Python library, compressed (plan: /scratch/sagebrush-reviews/remote-compute/cli-lib-gzip-plan-r1).
// scripts/build-cli.mjs embeds the library (relative path -> source, the JSON of scripts/build-id.mjs libFiles) as one
// base64 string of its gzip, and build/cli/lib.gen.js calls installEmbeddedLib with it.  globalThis.__PYJS_LIB__ is
// then a getter: the first read (src/compile.ts's, at startup) decodes the whole library once, synchronously, and
// replaces the getter with the plain value, as the old assignment made it; the compressed string is deleted only then.
// A failed decode throws its own error and installs nothing (the getter and the compressed string stay).
import { gunzipSync } from "zlib";

/** (tests) how many times the library was decoded: the production decoder's own count. */
export const libEmbedStats = { decodes: 0 };

/** `globalThis.__PYJS_LIB__` on `g`, decoded from `payload` (base64 of the gzip of the library's JSON) on first read. */
export function installEmbeddedLib(g: any, payload: string) {
  g.__PYJS_LIB_GZ__ = payload;
  // (the flags of a plain global assignment, `globalThis.x = v`: writable, enumerable, configurable)
  const settle = (value: unknown) => {
    Object.defineProperty(g, "__PYJS_LIB__", { value, writable: true, enumerable: true, configurable: true });
    delete g.__PYJS_LIB_GZ__;
  };
  Object.defineProperty(g, "__PYJS_LIB__", {
    enumerable: true,
    configurable: true,
    get() {
      libEmbedStats.decodes++;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(gunzipSync(Buffer.from(g.__PYJS_LIB_GZ__, "base64")));
      const lib = JSON.parse(text);
      settle(lib);
      return lib;
    },
    set(value: unknown) {
      settle(value);
    },
  });
}
