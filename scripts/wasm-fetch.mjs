// Get the four WebAssembly modules that wasm/pins.json names (design/wasm-artifacts.md, section 6).
// For each module: keep wasm/<module> if it already matches its pin; otherwise copy it from the
// user cache, or download it from https://get.sagebrush.space/wasm/sha256/<sha256>.wasm.  Every
// byte is checked (exact length, then sha256) before anything else sees it.
//   node scripts/wasm-fetch.mjs              fetch what's missing or outdated
//   node scripts/wasm-fetch.mjs --offline    no network at all: a module not in the cache fails at once
//   node scripts/wasm-fetch.mjs --force      also replace unidentified bytes and local builds
// SAGEBRUSH_WASM_BASE overrides the base URL (a mirror, or file:///dir/ of <sha256>.wasm files);
// SAGEBRUSH_WASM_CACHE (default $XDG_CACHE_HOME/sagebrush/wasm, else ~/.cache/sagebrush/wasm) is the cache.
//
// Limits: 10 s to the response headers, 60 s per download, up to 3 attempts for a network error
// or a 5xx (backoff 1 s, then 4 s), no retry for a 404 (and nothing about it remembered), at
// most 2 downloads at a time, each module at most once, and 240 s for the whole run.
// Concurrent runs may share the cache: a download goes to a unique .part file, is checked, and is
// renamed onto <sha256>.wasm; wasm/<module> is written the same way.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MODULES, ROOT, loadPins, matches, moduleState, modulePath, recordInstalled } from "./wasm-modules.mjs";

export const DEFAULT_BASE = "https://get.sagebrush.space/wasm/sha256/";
export const LIMITS = { headersMs: 10_000, downloadMs: 60_000, attempts: 3, backoffMs: [1_000, 4_000], deadlineMs: 240_000, parallel: 2, staleMs: 3_600_000 };

export function defaultCacheDir(env = process.env) {
  if (env.SAGEBRUSH_WASM_CACHE) return env.SAGEBRUSH_WASM_CACHE;
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "sagebrush", "wasm");
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
});

// Write bytes to a unique temp file beside `path`, then rename: no reader sees a partial file
function writeAtomic(path, bytes) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.part`);
  try {
    writeFileSync(tmp, bytes, { flag: "wx", mode: 0o644 });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function removeStaleParts(dir, now, staleMs) {
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    if (!f.endsWith(".part")) continue;
    try {
      if (now - statSync(join(dir, f)).mtimeMs > staleMs) rmSync(join(dir, f), { force: true });
    } catch {}
  }
}

export class FetchError extends Error {
  constructor(message, retry) {
    super(message);
    this.retry = retry;
  }
}

// One attempt: the body, cut off past `limit` bytes; headers within limits.headersMs, all within limits.downloadMs
async function attempt(url, limit, limits, outer) {
  if (url.startsWith("file:")) {
    const path = fileURLToPath(url);
    if (!existsSync(path)) throw new FetchError(`404 (no such file ${path})`, false);
    if (statSync(path).size > limit) throw new FetchError(`more than the pinned ${limit} bytes`, false);
    return readFileSync(path);
  }
  const ctl = new AbortController();
  const stop = () => ctl.abort(outer.reason);
  outer.addEventListener("abort", stop, { once: true });
  const headers = setTimeout(() => ctl.abort(new Error(`no response headers within ${limits.headersMs / 1000} s`)), limits.headersMs);
  const total = setTimeout(() => ctl.abort(new Error(`not complete within ${limits.downloadMs / 1000} s`)), limits.downloadMs);
  let complete = false;
  try {
    let res;
    try {
      res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
    } catch (e) {
      throw new FetchError(String(ctl.signal.reason?.message ?? e.cause?.code ?? e.message), true);
    } finally {
      clearTimeout(headers);
    }
    if (res.status === 404) throw new FetchError("404 (not published)", false);
    if (res.status >= 500) throw new FetchError(`HTTP ${res.status}`, true);
    if (res.status !== 200) throw new FetchError(`HTTP ${res.status}`, false);
    const declared = Number(res.headers.get("content-length"));
    if (declared > limit) throw new FetchError(`more than the pinned ${limit} bytes (content-length ${declared})`, false);
    const chunks = [];
    let n = 0;
    try {
      for await (const chunk of res.body) {
        n += chunk.length;
        if (n > limit) throw new FetchError(`more than the pinned ${limit} bytes`, false);
        chunks.push(chunk);
      }
    } catch (e) {
      if (e instanceof FetchError) throw e;
      throw new FetchError(String(ctl.signal.reason?.message ?? e.message), true);
    }
    complete = true;
    return Buffer.concat(chunks);
  } finally {
    // a response that is rejected or not read to the end is aborted, body and connection,
    // before its download slot is released
    if (!complete && !ctl.signal.aborted) ctl.abort(new Error("rejected"));
    clearTimeout(headers);
    clearTimeout(total);
    outer.removeEventListener("abort", stop);
  }
}

export async function download(url, pin, limits, outer, log) {
  let last;
  for (let i = 0; i < limits.attempts; i++) {
    if (outer.aborted) throw outer.reason;
    if (i > 0) await sleep(limits.backoffMs[i - 1] ?? limits.backoffMs.at(-1), outer);
    if (outer.aborted) throw outer.reason;
    try {
      const bytes = await attempt(url, pin.bytes, limits, outer);
      if (!matches(bytes, pin)) throw new FetchError(`the downloaded bytes don't match the pin (${bytes.length} bytes)`, false);
      return bytes;
    } catch (e) {
      last = e;
      if (outer.aborted || !(e instanceof FetchError) || !e.retry) break;
      log(`  ${url}: ${e.message}; retrying`);
    }
  }
  throw last;
}

// Run `fn` over items, at most `n` at a time
async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

// Fetch every module that wasm/pins.json names.  Returns one {name, action} per module; throws
// (after every module has been tried) naming each failure.
export async function fetchModules({ root = ROOT, base = process.env.SAGEBRUSH_WASM_BASE || DEFAULT_BASE, cacheDir = defaultCacheDir(), offline = false, force = false, limits = LIMITS, log = (s) => console.log(s) } = {}) {
  const pins = loadPins(root);
  const baseUrl = /^[a-z]+:/.test(base) ? (base.endsWith("/") ? base : base + "/") : pathToFileURL(base).href + "/";
  mkdirSync(cacheDir, { recursive: true });
  removeStaleParts(cacheDir, Date.now(), limits.staleMs);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(`the whole run took more than ${limits.deadlineMs / 1000} s`)), limits.deadlineMs);
  const failures = [];
  try {
    const results = await pool(MODULES, limits.parallel, async (name) => {
      const pin = pins[name];
      if (deadline.signal.aborted) {
        failures.push(`${name}: not started: ${deadline.signal.reason.message}`);
        return { name, action: "not started" };
      }
      const s = moduleState(name, pin, root);
      if (s.state === "pinned") return { name, action: "already pinned" };
      if (s.state === "local" && !force) return { name, action: `kept a local build (sha256 ${s.sha256}); --force replaces it` };
      if (s.state === "unidentified" && !force) {
        failures.push(`${name}: wasm/${name} matches neither its pin, a local build's sidecar nor an earlier fetch: rerun with --force to replace it`);
        return { name, action: "refused" };
      }
      const cached = join(cacheDir, `${pin.sha256}.wasm`);
      let bytes = null;
      if (existsSync(cached)) {
        // a cache entry that isn't a regular file of the pinned length, or doesn't match its name, is dropped, never used
        const st = lstatSync(cached);
        const b = st.isFile() && st.size === pin.bytes ? readFileSync(cached) : null;
        if (b && matches(b, pin)) bytes = b;
        else rmSync(cached, { force: true });
      }
      let action = "from the cache";
      if (!bytes) {
        const url = baseUrl + `${pin.sha256}.wasm`;
        if (offline) {
          failures.push(`${name}: not in the cache (${cached}), and --offline makes no request`);
          return { name, action: "missing" };
        }
        try {
          bytes = await download(url, pin, limits, deadline.signal, log);
        } catch (e) {
          const why = deadline.signal.aborted ? deadline.signal.reason.message : e.message;
          const hint = /^404/.test(e.message ?? "") ? ": this pin isn't published yet (merged in the last few minutes, or from an unmerged pull request): build it, or use that run's artifact" : "";
          failures.push(`${name}: ${url}: ${why}${hint}`);
          return { name, action: "failed" };
        }
        writeAtomic(cached, bytes);
        action = "downloaded";
      }
      // nothing is installed after the deadline: a cache hit has no await between the check above and
      // here, and a download that returned finished before the deadline (its abort makes it throw)
      writeAtomic(modulePath(name, root), bytes);
      recordInstalled(name, pin, root);
      return { name, action };
    });
    for (const r of results) log(`${r.name}: ${r.action}`);
    if (failures.length) throw new Error(`wasm-fetch: ${failures.length} of ${MODULES.length} modules failed:\n${failures.join("\n")}`);
    return results;
  } finally {
    clearTimeout(timer);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !["--offline", "--force"].includes(a));
  if (unknown.length) {
    console.error(`wasm-fetch: unknown argument ${unknown[0]} (usage: node scripts/wasm-fetch.mjs [--offline] [--force])`);
    process.exit(2);
  }
  try {
    await fetchModules({ offline: args.includes("--offline"), force: args.includes("--force") });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
