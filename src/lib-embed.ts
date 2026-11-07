// The CLI's embedded Python library, compressed (plan: /scratch/sagebrush-reviews/remote-compute/cli-lib-gzip-plan-r1).
// scripts/build-cli.mjs embeds the library (relative path -> source, the JSON of scripts/build-id.mjs libFiles) as one
// base64 string of its gzip, and build/cli/lib.gen.js calls installEmbeddedLib with it.  globalThis.__PYJS_LIB__ is
// then a getter: the first read (src/compile.ts's, at startup) decodes the whole library once, synchronously, and
// replaces the getter with the plain value, as the old assignment made it; the compressed string is deleted only then.
// A failed decode throws its own error and installs nothing (the getter and the compressed string stay).
// The files scripts/lazy-lib.mjs lists come in a second blob (P3a design note, accepted Nov 7): each is a getter of
// the decoded library from the start (so Object.hasOwn and Object.keys see it), and the first read of any of them
// decodes that blob once and settles all of them as plain values; a start that imports none of them never decodes it.
import { gunzipSync } from "zlib";

/** (tests) how many times the library was decoded: the production decoder's own count. */
export const libEmbedStats = { decodes: 0, lazyDecodes: 0 };

const decode = (payload: string): Record<string, string> => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(gunzipSync(Buffer.from(payload, "base64"))));
const plain = (o: any, k: string, value: unknown) => Object.defineProperty(o, k, { value, writable: true, enumerable: true, configurable: true });

// The lazy files on `lib`: getters, until the first read of one decodes `payload` and settles them all. A failed
// decode, or a blob whose files aren't exactly `names`, throws and settles nothing.
function installLazy(lib: Record<string, string>, payload: string, names: string[]) {
  const load = (): Record<string, string> => {
    libEmbedStats.lazyDecodes++;
    const files = decode(payload);
    const got = Object.keys(files).sort(), want = [...names].sort();
    if (got.length !== want.length || got.some((k, i) => k !== want[i])) throw new Error("the embedded library's lazy part is not the files it names");
    for (const n of names) plain(lib, n, files[n]);
    return files;
  };
  for (const n of names) {
    if (Object.hasOwn(lib, n)) throw new Error(`the embedded library names ${n} twice`);
    Object.defineProperty(lib, n, {
      enumerable: true,
      configurable: true,
      get: () => load()[n],
      set: (value: unknown) => plain(lib, n, value),
    });
  }
}

/** `globalThis.__PYJS_LIB__` on `g`, decoded from `payload` (base64 of the gzip of the library's JSON) on first read;
 * the files `lazyNames`, from `lazy` (the same form), on the first read of one of them. */
export function installEmbeddedLib(g: any, payload: string, lazy?: string, lazyNames?: string[]) {
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
      const lib = decode(g.__PYJS_LIB_GZ__);
      if (lazy !== undefined) installLazy(lib, lazy, lazyNames ?? []);
      settle(lib);
      return lib;
    },
    set(value: unknown) {
      settle(value);
    },
  });
}
