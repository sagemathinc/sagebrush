// The Python library in the browser's worker, fetched in chunks
// (web/lib-chunks.mts, made by web/build.ts): this worker carries only the
// manifest, and globalThis.__PYJS_LIB__ (src/compile.ts) is an object with a
// property per library file whose getter fetches that file's group the first
// time any of its files is read (an import: synchronously, as the engine is
// fetched).  A mode's start fetches its groups beforehand, asynchronously
// (prefetchMode).  A chunk is used only if its bytes have the SHA-256 in the
// manifest: a cached copy is origin storage, which any script of the origin
// can write (design/security.md, SEC-8D6-1).  Sources must be there to import
// a module; compiled code ("pre") is used when it is, and otherwise the
// module compiles from its source.
//
// The packages' files (packages/, src/compile.ts) are fetched the same way,
// as globalThis.__SAGEBRUSH_PACKAGES__ {registry, files}.
//
// It must be imported before src/compile.ts, which reads __PYJS_LIB__ and
// __SAGEBRUSH_PACKAGES__ when it is loaded.
import { sha256Hex } from "../src/runtime/sha256";
import type { LibManifest } from "./lib-chunks.mts";

declare const __SB_LIB__: LibManifest;
const g = globalThis as any;
const M = __SB_LIB__;
type Kind = "src" | "pre";
const sources: Record<string, string> = Object.create(null);
const pkgSources: Record<string, string> = Object.create(null);
const installed = new Set<string>(); // group + "." + kind
const precompiled = { build: M.build, modules: Object.create(null) };
g.__SAGEBRUSH_PRECOMPILED__ = precompiled;

// A chunk's URL: beside this worker, or (a downloaded file's runner, files
// mode) the blob: URL it was given, or none (that file doesn't carry it)
function chunkUrl(file: string): string | null {
  const files: Record<string, string> | undefined = g.__SB_FILES__;
  if (files) return files[file] ?? null;
  return new URL(file, g.__SB_BASE__ ?? self.location.href).href;
}

export async function digestHex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  // (the native digest where there is one: 15 MB took 130 ms in the
  // synchronous JS SHA-256, 11 ms natively; the runner's worker is not a
  // secure context, so no crypto.subtle there: the synchronous one)
  const subtle = g.isSecureContext ? globalThis.crypto?.subtle : undefined;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!subtle) return sha256Hex(view);
  const h = new Uint8Array(await subtle.digest("SHA-256", view));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Told each chunk fetched from the site and installed (its file, lib/...):
// the page has the service worker keep it, which a chunk fetched before the
// service worker controlled the page (a first visit) went past (web/sw.js)
let onInstalled: ((file: string) => void) | null = null;
export function onChunkInstalled(f: (file: string) => void) {
  onInstalled = f;
}

// Install a chunk whose bytes were checked: only its own group's files and
// modules (by the manifest), so a chunk can't stand in for another group's.
function install(group: string, kind: Kind, bytes: Uint8Array) {
  if (installed.has(group + "." + kind)) return;
  const c = JSON.parse(new TextDecoder().decode(bytes));
  if (c?.build !== M.build || c.group !== group || c.kind !== kind) throw new Error("not this build's chunk");
  if (kind === "src") {
    for (const [path, text] of Object.entries(c.files ?? {})) {
      if (typeof text !== "string") continue;
      if (Object.hasOwn(M.files, path) && M.files[path] === group) sources[path] = text;
      else if (Object.hasOwn(M.packages.files, path) && M.packages.files[path] === group) pkgSources[path] = text;
    }
  } else {
    for (const [key, m] of Object.entries<any>(c.modules ?? {})) if (m && M.files[m.path] === group) precompiled.modules[key] = m;
  }
  installed.add(group + "." + kind);
  // (not a downloaded file's own copy: web/runner, files mode)
  if (!g.__SB_FILES__) {
    try {
      onInstalled?.(M.chunks[group][kind]!.file);
    } catch {}
  }
}

function fetchSync(url: string): Uint8Array {
  // (in the runner, which has no network, the page fetches it: web/runner)
  if (typeof g.__SAGEBRUSH_FETCH_SYNC__ === "function") return g.__SAGEBRUSH_FETCH_SYNC__(url);
  const x = new XMLHttpRequest();
  x.open("GET", url, false);
  x.responseType = "arraybuffer";
  x.send();
  if (x.status !== 200) throw new Error(`HTTP ${x.status}`);
  return new Uint8Array(x.response);
}

// A group, now: its sources (or an error saying why not), and its compiled
// code if it can have it
function loadSync(group: string) {
  for (const kind of ["src", "pre"] as Kind[]) {
    const ref = M.chunks[group]?.[kind];
    if (!ref || installed.has(group + "." + kind)) continue;
    try {
      const url = chunkUrl(ref.file);
      if (url === null) throw new Error("not in this file's engine");
      const bytes = fetchSync(url);
      if (sha256Hex(bytes) !== ref.sha256) throw new Error("not the chunk this worker was built with");
      install(group, kind, bytes);
    } catch (e: any) {
      if (kind === "src") throw new Error(`could not load the Python library's ${group} modules (${ref.file}: ${e?.message ?? e}${navigator.onLine === false ? "; offline" : ""})`);
    }
  }
}

const lib: Record<string, string> = {};
for (const [path, group] of Object.entries(M.files))
  Object.defineProperty(lib, path, {
    enumerable: true,
    get() {
      if (!(path in sources)) loadSync(group);
      return sources[path];
    },
  });
g.__PYJS_LIB__ = lib;
const pkgFiles: Record<string, string> = {};
for (const [path, group] of Object.entries(M.packages.files))
  Object.defineProperty(pkgFiles, path, {
    enumerable: true,
    get() {
      if (!(path in pkgSources)) loadSync(group);
      return pkgSources[path];
    },
  });
g.__SAGEBRUSH_PACKAGES__ = { registry: M.packages.registry, files: pkgFiles };

const MODE_NAMES: Record<string, string> = { sage: "Sage", matlab: "MATLAB", magma: "Magma" };
const pending = new Map<string, Promise<void>>();
/** Fetch the groups mode `mode` starts with, if not here yet; `loading` is
 * told when that has to fetch something (with the mode's name), and when it
 * is done (null).  Never rejects: what failed is fetched again, synchronously,
 * when a module needs it (and that says why it can't be). */
export function prefetchMode(mode: string, fetchBytes: (url: string) => Promise<ArrayBuffer | Uint8Array>, loading: (what: string | null) => void): Promise<void> {
  const todo = (M.modes[mode] ?? []).flatMap((group) => (["src", "pre"] as Kind[]).filter((k) => M.chunks[group]?.[k] && !installed.has(group + "." + k)).map((k) => [group, k] as [string, Kind]));
  if (!todo.length) return Promise.resolve();
  const p =
    pending.get(mode) ??
    (async () => {
      loading(MODE_NAMES[mode] ?? mode);
      try {
        await Promise.all(
          todo.map(async ([group, kind]) => {
            try {
              const ref = M.chunks[group][kind]!;
              const url = chunkUrl(ref.file);
              if (url === null) return;
              const bytes = await fetchBytes(url);
              if ((await digestHex(bytes)) !== ref.sha256) return;
              install(group, kind, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
            } catch {}
          }),
        );
      } finally {
        pending.delete(mode);
        loading(null);
      }
    })();
  pending.set(mode, p);
  return p;
}
