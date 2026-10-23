// The browser worker's optional package set (plan-modular-packages-r4 §4.3):
// the page sends {pkgset: S} (the notebook's pin, §4.4) before any code runs.
// The index is fetched then, asynchronously, and admitted (src/pkgset.ts);
// before each run, the chunks its imports need are fetched asynchronously
// too; an import the scan didn't see is fetched synchronously, asking for
// exactly the pinned size (Range), and refused if more comes.  Every chunk is
// checked against the index's pins before any of it is used, whatever the
// cache or the network gave.
import { installPackageSet, coreBuildId } from "../src/compile";
import { PKGSET_LIMITS, PkgsetError, type ChunkRef, type SetPlan } from "../src/pkgset";

const g = globalThis as any;
let plan: SetPlan | null = null;
const have = new Map<string, Uint8Array>(); // chunk sha256 -> bytes, fetched ahead
const used = new Set<string>(); // chunk sha256s this interpreter uses (pinned in the page's cache)
let onUse: ((digests: string[]) => void) | null = null;
export function onPkgUse(f: (digests: string[]) => void) {
  onUse = f;
}

// a set's file's URL, beside this worker (or the runner's base); null where
// a downloaded file's runner carries no sets
function pkgUrl(path: string): string | null {
  if (g.__SB_FILES__) return null;
  return new URL(path, g.__SB_BASE__ ?? self.location.href).href;
}

// (async: the bytes, at most `max`, as they arrive)
async function boundedFetch(url: string, max: number, fetchBytes: (url: string) => Promise<ArrayBuffer | Uint8Array>): Promise<Uint8Array> {
  if (g.__SB_BROKERED__) {
    // (the runner has no network: the page fetches it, web/worker.ts)
    const b = await fetchBytes(url);
    const u = b instanceof Uint8Array ? b : new Uint8Array(b);
    if (u.length > max) throw new PkgsetError(`${url}: over ${max} bytes`);
    return u;
  }
  const r = await fetch(url, { redirect: "error" });
  if (r.status !== 200) throw new PkgsetError(`${url}: HTTP ${r.status}`);
  if (Number(r.headers.get("content-length") ?? 0) > max) throw new PkgsetError(`${url}: over ${max} bytes`);
  const reader = r.body!.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel();
      throw new PkgsetError(`${url}: over ${max} bytes`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}

// (sync: exactly the pinned size, by Range; a longer answer is refused)
function syncChunk(ref: ChunkRef): Uint8Array {
  const url = pkgUrl(`pkg/${ref.sha256}.json`);
  if (url === null) throw new PkgsetError("package sets are not available in a downloaded file's runner");
  if (typeof g.__SAGEBRUSH_FETCH_SYNC__ === "function") {
    const b: Uint8Array = g.__SAGEBRUSH_FETCH_SYNC__(url);
    if (b.length !== ref.size) throw new PkgsetError(`${url}: not the pinned size`);
    return b;
  }
  const x = new XMLHttpRequest();
  x.open("GET", url, false);
  x.responseType = "arraybuffer";
  x.setRequestHeader("Range", `bytes=0-${ref.size - 1}`);
  x.send();
  if (x.status !== 200 && x.status !== 206) throw new PkgsetError(`${url}: HTTP ${x.status}`);
  const b = new Uint8Array(x.response);
  if (b.length !== ref.size) throw new PkgsetError(`${url}: not the pinned size`);
  return b;
}

function chunk(ref: ChunkRef): Uint8Array {
  const b = have.get(ref.sha256) ?? syncChunk(ref);
  have.delete(ref.sha256);
  if (!used.has(ref.sha256)) {
    used.add(ref.sha256);
    try {
      onUse?.([...used]);
    } catch {}
  }
  return b;
}

/** Use set `S` in this worker: its index, fetched and admitted.  Throws (a PkgsetError) and nothing is installed. */
export async function useSet(S: string, fetchBytes: (url: string) => Promise<ArrayBuffer | Uint8Array>): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(S)) throw new PkgsetError("a package set id is 64 lowercase hex digits");
  const url = pkgUrl(`pkgset/${S}.json`);
  if (url === null) throw new PkgsetError("package sets are not available in a downloaded file's runner");
  const index = await boundedFetch(url, PKGSET_LIMITS.indexBytes, fetchBytes);
  plan = installPackageSet(S, index, chunk);
  used.add(S);
  onUse?.([...used]);
}

// The set's top-level modules that `code` imports (a scan, not a parse: what
// it misses is fetched synchronously when imported)
function importsOf(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/^[ \t]*(?:from[ \t]+([A-Za-z_][\w.]*)[ \t]+import|import[ \t]+([^\n#]+))/gm)) {
    if (m[1]) out.add(m[1].split(".")[0]);
    else for (const part of m[2].split(",")) out.add(part.trim().split(/[ \t.]/)[0]);
  }
  return [...out];
}

/** Before a run: fetch, asynchronously, the chunks of the set's packages `code` imports (and their dependencies). */
export async function prefetchFor(code: string, fetchBytes: (url: string) => Promise<ArrayBuffer | Uint8Array>): Promise<void> {
  if (plan === null || typeof code !== "string") return;
  const build = coreBuildId();
  const want = new Map<string, ChunkRef>();
  for (const top of importsOf(code)) {
    const id = plan.modules.get(top);
    if (!id) continue;
    for (const dep of plan.closure.get(id)!) {
      const p = plan.packages.get(dep)!;
      for (const ref of [p.src, p.pre[build]]) if (ref && !used.has(ref.sha256) && !have.has(ref.sha256)) want.set(ref.sha256, ref);
    }
  }
  await Promise.all(
    [...want.values()].map(async (ref) => {
      try {
        const url = pkgUrl(`pkg/${ref.sha256}.json`);
        if (url === null) return;
        have.set(ref.sha256, await boundedFetch(url, ref.size, fetchBytes));
      } catch {
        // (fetched again, synchronously, when imported: that says why it can't be)
      }
    }),
  );
}
