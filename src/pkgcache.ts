// The CLI's optional package sets (plan-modular-packages-r4 §4.3, §4.6):
// `sagebrush --pkgset ID|FILE` (or SAGEBRUSH_PKGSET) loads one set for the run.
//
//   FILE   a set's index on disk, pkgset/<S>.json, with its chunks in the
//          sibling pkg/ directory (what scripts/optional-packages.mjs build makes)
//   ID     64 hex digits: fetched from SAGEBRUSH_PKG_BASE (default
//          https://sagebrush.space) into ~/.cache/sagebrush/pkg/, verified
//
// Everything the set could need for this build is fetched before the program
// starts (bounded by src/pkgset.ts's limits), so imports read the cache
// synchronously.  The cache is bounded: at most 1 GiB and 256 entries,
// least recently used first; a fetch goes to a temporary file, is verified,
// then renamed into place; entries in use by a running process are never
// evicted; stale temporaries and locks are cleaned, a bounded number a run.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { admitIndex, PKGSET_LIMITS, PkgsetError, type ChunkRef } from "./pkgset";
import { sha256Hex } from "./runtime/sha256";

export const CACHE_LIMITS = Object.freeze({ bytes: 1024 * 1024 * 1024, entries: 256, staleMs: 60 * 60 * 1000, lockMs: 10 * 60 * 1000, adminLockMs: 5000, cleanPerRun: 100 });
// (the caps, configurable down by SAGEBRUSH_PKG_CACHE_BYTES and
// SAGEBRUSH_PKG_CACHE_ENTRIES, never above these defaults' hard ceilings)
const envCap = (name: string, ceiling: number) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 && v <= ceiling ? v : ceiling;
};
const caps = () => ({ bytes: envCap("SAGEBRUSH_PKG_CACHE_BYTES", CACHE_LIMITS.bytes), entries: envCap("SAGEBRUSH_PKG_CACHE_ENTRIES", CACHE_LIMITS.entries) });
const HEX64 = /^[0-9a-f]{64}$/;

export function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "sagebrush", "pkg");
}

// (an entry in use by a live process: <h>.inuse.<pid> files, removed at exit)
const mine = new Set<string>();
let exitHook = false;
function markInUse(dir: string, h: string) {
  const f = join(dir, `${h}.inuse.${process.pid}`);
  if (mine.has(f)) return;
  try {
    writeFileSync(f, "");
    mine.add(f);
  } catch {}
  if (!exitHook) {
    exitHook = true;
    process.on("exit", () => {
      for (const x of mine) {
        try {
          rmSync(x, { force: true });
        } catch {}
      }
    });
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
};

/** Clean stale temporaries and locks, then evict least recently used entries over the caps (never one in use). */
export function trimCache(dir: string, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  let cleaned = 0;
  const inUse = new Set<string>();
  for (const n of names) {
    if (cleaned >= CACHE_LIMITS.cleanPerRun) break;
    const p = join(dir, n);
    const m = /^([0-9a-f]{64})\.inuse\.(\d+)$/.exec(n);
    if (m) {
      if (alive(Number(m[2]))) inUse.add(m[1]);
      else {
        rmSync(p, { force: true });
        cleaned++;
      }
      continue;
    }
    if (n.startsWith(".tmp-") || n.endsWith(".lock")) {
      try {
        const age = now - statSync(p).mtimeMs;
        if (age > (n.endsWith(".lock") ? CACHE_LIMITS.lockMs : CACHE_LIMITS.staleMs)) {
          rmSync(p, { force: true, recursive: true });
          cleaned++;
        }
      } catch {}
    }
  }
  const entries: { h: string; bytes: number; used: number }[] = [];
  for (const n of names) {
    const m = /^([0-9a-f]{64})\.json$/.exec(n);
    if (!m) continue;
    try {
      const st = statSync(join(dir, n));
      entries.push({ h: m[1], bytes: st.size, used: st.atimeMs > st.mtimeMs ? st.atimeMs : st.mtimeMs });
    } catch {}
  }
  let total = entries.reduce((s, e) => s + e.bytes, 0), count = entries.length;
  entries.sort((a, b) => a.used - b.used);
  const cap = caps();
  for (const e of entries) {
    if (total <= cap.bytes && count <= cap.entries) break;
    if (inUse.has(e.h)) continue;
    try {
      rmSync(join(dir, e.h + ".json"), { force: true });
      total -= e.bytes;
      count--;
    } catch {}
  }
}

// GET url, at most `max` bytes (refusing a declared larger body, an encoded
// body, or more bytes than that as they arrive)
async function boundedGet(url: string, max: number): Promise<Uint8Array> {
  const r = await fetch(url, { redirect: "error", headers: { "Accept-Encoding": "identity" } });
  if (r.status !== 200) throw new PkgsetError(`${url}: HTTP ${r.status}`);
  const enc = r.headers.get("content-encoding");
  if (enc !== null && enc !== "identity") throw new PkgsetError(`${url}: an encoded response (${enc.slice(0, 32)})`);
  const len = r.headers.get("content-length");
  if (len !== null && Number(len) > max) throw new PkgsetError(`${url}: ${len} bytes, over ${max}`);
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

// The cache-wide lock (.cache.lock, O_EXCL; stale after a few seconds: it
// is held only while one entry is admitted), around admission's measure,
// evict and rename, so concurrent processes can't together pass the caps
async function withCacheLock<T>(dir: string, f: () => T): Promise<T> {
  const lock = join(dir, ".cache.lock");
  for (let tries = 0; ; tries++) {
    let fd: number;
    try {
      fd = openSync(lock, "wx");
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > CACHE_LIMITS.adminLockMs) rmSync(lock, { force: true });
      } catch {}
      if (tries > 400) throw new PkgsetError("the package cache's lock is held");
      await new Promise((r) => setTimeout(r, 25));
      continue;
    }
    try {
      return f();
    } finally {
      closeSync(fd);
      rmSync(lock, { force: true });
    }
  }
}

// Admit a verified entry (at `tmp`): measure the cache's physical entries,
// evict the least recently used that no live process uses until this one
// fits within both caps, then rename it into place.  If it can't fit (every
// candidate is in use), it is not kept, and this run uses it from memory
// (daybreak3's LIMIT-PR68-2).  True if kept.
function admit(dir: string, h: string, tmp: string, size: number): boolean {
  const cap = caps();
  const live = new Set<string>();
  const entries: { h: string; bytes: number; used: number }[] = [];
  for (const n of readdirSync(dir)) {
    const m = /^([0-9a-f]{64})\.inuse\.(\d+)$/.exec(n);
    if (m && alive(Number(m[2]))) live.add(m[1]);
    const e = /^([0-9a-f]{64})\.json$/.exec(n);
    if (e) {
      try {
        const st = statSync(join(dir, n));
        entries.push({ h: e[1], bytes: st.size, used: Math.max(st.atimeMs, st.mtimeMs) });
      } catch {}
    }
  }
  if (entries.some((e) => e.h === h)) return true; // (another process kept it meanwhile)
  let total = entries.reduce((t, e) => t + e.bytes, 0), count = entries.length;
  entries.sort((a, b) => a.used - b.used);
  for (const e of entries) {
    if (total + size <= cap.bytes && count + 1 <= cap.entries) break;
    if (live.has(e.h) || e.h === h) continue;
    rmSync(join(dir, e.h + ".json"), { force: true });
    total -= e.bytes;
    count--;
  }
  if (total + size > cap.bytes || count + 1 > cap.entries) return false;
  renameSync(tmp, join(dir, h + ".json"));
  return true;
}

// One verified entry: from the cache, or fetched (one fetch per entry at a
// time, by an O_EXCL lock), verified, then admitted (or used from memory)
async function ensure(dir: string, base: string, path: string, h: string, max: number, size: number | null): Promise<Uint8Array> {
  const f = join(dir, h + ".json");
  if (existsSync(f)) {
    const b = new Uint8Array(readFileSync(f));
    if (sha256Hex(b) === h && (size === null || b.length === size)) {
      const now = new Date();
      try {
        utimesSync(f, now, statSync(f).mtime);
      } catch {}
      markInUse(dir, h);
      return b;
    }
    rmSync(f, { force: true });
  }
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, h + ".lock");
  let fd = -1;
  for (let tries = 0; tries < 50; tries++) {
    try {
      fd = openSync(lock, "wx");
      break;
    } catch {
      // (another process is fetching it: wait for it, then use its file)
      await new Promise((r) => setTimeout(r, 100));
      if (existsSync(f)) return ensure(dir, base, path, h, max, size);
    }
  }
  if (fd < 0) throw new PkgsetError(`the package cache's lock for ${h.slice(0, 12)} is held`);
  const tmp = join(dir, `.tmp-${process.pid}-${h.slice(0, 16)}`);
  try {
    const bytes = await boundedGet(base.replace(/\/+$/, "") + "/" + path, size ?? max);
    if (sha256Hex(bytes) !== h || (size !== null && bytes.length !== size)) throw new PkgsetError(`${path}: not the bytes its address names`);
    writeFileSync(tmp, bytes);
    markInUse(dir, h);
    await withCacheLock(dir, () => admit(dir, h, tmp, bytes.length));
    return bytes;
  } finally {
    rmSync(tmp, { force: true });
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}

/**
 * The set `spec` names (an id, or an index file), ready for
 * installPackageSet: [S, index bytes, a synchronous chunk reader].  Fetches
 * everything the set could need for build `build` first.
 */
export async function prepareSet(spec: string, build: string, reserved: Parameters<typeof admitIndex>[3]): Promise<[string, Uint8Array, (ref: ChunkRef) => Uint8Array]> {
  if (HEX64.test(spec)) {
    const dir = cacheDir();
    trimCache(dir);
    const baseUrl = process.env.SAGEBRUSH_PKG_BASE || "https://sagebrush.space";
    const index = await ensure(dir, baseUrl, `pkgset/${spec}.json`, spec, PKGSET_LIMITS.indexBytes, null);
    const plan = admitIndex(spec, index, build, reserved);
    const chunks = new Map<string, Uint8Array>();
    for (const p of plan.packages.values()) {
      for (const ref of [p.src, p.pre[build]].filter(Boolean) as ChunkRef[]) chunks.set(ref.sha256, await ensure(dir, baseUrl, `pkg/${ref.sha256}.json`, ref.sha256, PKGSET_LIMITS.chunkBytes, ref.size));
    }
    return [spec, index, (ref) => chunks.get(ref.sha256) ?? (() => { throw new PkgsetError(`chunk ${ref.sha256.slice(0, 12)} was not fetched`); })()];
  }
  // a local set: pkgset/<S>.json, its chunks in ../pkg/
  const file = resolve(spec);
  const S = basename(file).replace(/\.json$/, "");
  if (!HEX64.test(S)) throw new PkgsetError(`--pkgset takes a set id (64 hex digits) or a pkgset/<id>.json file`);
  const st = statSync(file);
  if (st.size > PKGSET_LIMITS.indexBytes) throw new PkgsetError(`${file}: over ${PKGSET_LIMITS.indexBytes} bytes`);
  const index = new Uint8Array(readFileSync(file));
  const pkgDir = join(dirname(dirname(file)), "pkg");
  return [S, index, (ref) => {
    const f = join(pkgDir, ref.sha256 + ".json");
    if (statSync(f).size !== ref.size) throw new PkgsetError(`${f}: not the size the index pins`);
    return new Uint8Array(readFileSync(f));
  }];
}
