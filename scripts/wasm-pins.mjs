// The pins of the four WebAssembly modules (wasm/pins.json; design/wasm-artifacts.md).
//   node scripts/wasm-pins.mjs --check              each module's state: pinned, local build, an earlier pin, unidentified, missing
//   node scripts/wasm-pins.mjs --verify-committed   pins.json matches the modules committed at HEAD (while they are committed)
//   node scripts/wasm-pins.mjs --from-committed     write pins.json from the modules committed at HEAD
//   node scripts/wasm-pins.mjs --from-local         write pins.json from the files in wasm/ (a build with the pinned
//                                                   toolchain and the path mapping is byte-identical to CI's)
//   node scripts/wasm-pins.mjs --mark-local [name]  record a module built here (wasm/<name>.local.json), for SAGEBRUSH_WASM_LOCAL=1
//   node scripts/wasm-pins.mjs --verify-published [--base URL]   every pin is in the bucket with matching length and sha256
//   node scripts/wasm-pins.mjs --self-test          the planted controls: each must fail with its own message
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODULES, ROOT, checkModules, committedMismatches, formatPins, loadPins, matches, moduleState, modulePath, parsePins, pinsPath, runMode, sha256, writeSidecar } from "./wasm-modules.mjs";
import { DEFAULT_BASE, LIMITS, fetchModules } from "./wasm-fetch.mjs";

// Every pin, fetched from `base` (bounded as wasm-fetch's downloads are) and checked
export async function verifyPublished({ root = ROOT, base = DEFAULT_BASE, limits = LIMITS } = {}) {
  const pins = loadPins(root);
  const scratch = mkdtempSync(join(tmpdir(), "wasm-verify-"));
  try {
    // a fresh root and an empty cache, so only the network can satisfy it
    mkdirSync(join(scratch, "wasm"));
    writeFileSync(pinsPath(scratch), formatPins(pins));
    await fetchModules({ root: scratch, base, cacheDir: join(scratch, "cache"), limits, log: () => {} });
    return MODULES.map((n) => `${n}: published, ${pins[n].bytes} bytes, sha256 ${pins[n].sha256}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function pinsFrom(read) {
  const modules = {};
  for (const n of MODULES) {
    const bytes = read(n);
    modules[n] = { sha256: sha256(bytes), bytes: bytes.length };
  }
  return modules;
}

// ---- the planted controls: a small fixture root, served by a local HTTP server
async function selfTest() {
  const results = [];
  const expect = async (what, fn, pattern) => {
    try {
      await fn();
      results.push(`FAIL ${what}: no error`);
    } catch (e) {
      const ok = pattern.test(e.message);
      results.push(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `: wrong error: ${e.message.split("\n").join(" | ")}`}`);
    }
  };
  const pass = async (what, fn) => {
    try {
      const r = await fn();
      results.push(r === false ? `FAIL ${what}` : `ok   ${what}`);
    } catch (e) {
      results.push(`FAIL ${what}: ${e.message.split("\n").join(" | ")}`);
    }
  };
  const dir = mkdtempSync(join(tmpdir(), "wasm-pins-self-test-"));
  const mods = Object.fromEntries(MODULES.map((n, i) => [n, Buffer.from(`\0asm\x01\0\0\0 fixture ${n} ${"x".repeat(100 + i)}`)]));
  const pinsOf = (m) => Object.fromEntries(MODULES.map((n) => [n, { sha256: sha256(m[n]), bytes: m[n].length }]));
  const served = new Map(MODULES.map((n) => [`${sha256(mods[n])}.wasm`, mods[n]]));
  let requests = 0, mode = "ok", live = 0, peak = 0;
  const started = [];
  const server = createServer((req, res) => {
    requests++;
    started.push(Date.now());
    // a response counts as live until it is finished or its connection is closed
    live++;
    peak = Math.max(peak, live);
    let counted = true;
    const done = () => counted && (counted = false, live--);
    res.on("finish", done);
    res.on("close", done);
    const key = req.url.split("/").pop();
    if (mode === "500") return res.writeHead(500).end();
    if (mode === "slow") return; // never answers: the headers limit must fire
    if (mode === "stall") return res.writeHead(200, { "content-type": "application/wasm" }).write("\0asm"); // headers, then a body that never ends
    if (mode === "stream500") return res.writeHead(500).write("error page that never ends");
    if (mode === "biglen") return res.writeHead(200, { "content-length": String(1 << 30) }).write("\0asm");
    let body = served.get(key);
    if (!body) return res.writeHead(404).end();
    if (mode === "wrong") body = Buffer.from(body).fill(0x41, 8);
    if (mode === "extra") body = Buffer.concat([body, Buffer.from("!")]);
    if (mode === "huge") body = Buffer.alloc(body.length * 4, 1);
    res.writeHead(200, { "content-type": "application/wasm" }).end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/wasm/sha256/`;
  const fast = { ...LIMITS, headersMs: 300, downloadMs: 1_000, backoffMs: [10, 20], deadlineMs: 5_000 };
  const root = (name) => {
    const r = join(dir, name);
    mkdirSync(join(r, "wasm"), { recursive: true });
    writeFileSync(pinsPath(r), formatPins(pinsOf(mods)));
    return r;
  };
  const opts = (r, extra = {}) => ({ root: r, base, cacheDir: join(r, "cache"), limits: fast, log: () => {}, ...extra });
  try {
    // pins.json itself
    await expect("pins.json with an extra module", async () => parsePins(JSON.stringify({ v: 1, modules: { ...pinsOf(mods), "x.wasm": { sha256: "0".repeat(64), bytes: 1 } } })), /exactly/);
    await expect("pins.json with a short sha256", async () => parsePins(JSON.stringify({ v: 1, modules: { ...pinsOf(mods), [MODULES[0]]: { sha256: "abc", bytes: 1 } } })), /64 lowercase hex/);
    // the fetch: a clean download, then the controls
    const r1 = root("r1");
    await pass("a cold fetch downloads all four and they check as pinned", async () => {
      await fetchModules(opts(r1));
      return checkModules({ root: r1, mode: "pinned" }).every((l) => l.endsWith("pinned"));
    });
    await pass("a second run makes no request", async () => {
      const before = requests;
      await fetchModules(opts(r1));
      return requests === before;
    });
    {
      mode = "500";
      const lim = { ...fast, parallel: 1, backoffMs: [60, 120] }, rr = root("r-retry");
      writeFileSync(pinsPath(rr), formatPins(pinsOf(mods)));
      for (const n of MODULES.slice(1)) writeFileSync(modulePath(n, rr), mods[n]); // only the first module to fetch
      const before = requests, t0 = Date.now();
      await expect("a 5xx is retried", () => fetchModules(opts(rr, { limits: lim })), /HTTP 500/);
      const n = requests - before, ms = Date.now() - t0;
      results.push(n === lim.attempts && ms >= 180 ? `ok   ...exactly ${n} attempts, with the backoff (${ms} ms)` : `FAIL ...${n} attempts in ${ms} ms (expected ${lim.attempts}, at least 180 ms)`);
      mode = "ok";
    }
    for (const [m, what, pattern] of [["wrong", "wrong bytes with the right length", /don't match the pin/], ["extra", "the right bytes plus one", /more than the pinned/], ["huge", "an oversized download", /more than the pinned/], ["500", "a 5xx on every attempt", /HTTP 500/]]) {
      const r = root(`r-${m}`);
      mode = m;
      await expect(`the fetch refuses ${what}`, () => fetchModules(opts(r)), pattern);
      mode = "ok";
      await pass(`...and leaves no module and no partial file (${m})`, async () => MODULES.every((n) => !existsSync(modulePath(n, r))) && !execFileSync("find", [r, "-name", "*.part"], { encoding: "utf8" }).trim());
    }
    mode = "slow";
    await expect("an origin that never answers fails within the limits", () => fetchModules(opts(root("r-slow"))), /no response headers/);
    mode = "ok";
    // stopping: the whole-run deadline, a stalled body, and responses that are rejected mid-stream
    const settle = () => new Promise((r) => setTimeout(r, 300));
    mode = "stall";
    {
      const before = started.length, t0 = Date.now(), rd = root("r-deadline");
      await expect("the whole-run deadline stops the run, queued modules included", () => fetchModules(opts(rd, { limits: { ...fast, headersMs: 1_000, downloadMs: 5_000, attempts: 1, deadlineMs: 80 } })), /whole run took more than/);
      const elapsed = Date.now() - t0, late = started.slice(before).filter((t) => t > t0 + 80 + 25).length;
      results.push(elapsed < 400 && late === 0 ? `ok   ...within ${elapsed} ms, and no request starts after the deadline` : `FAIL ...took ${elapsed} ms; ${late} requests started after the deadline`);
      const left = readdirSync(join(rd, "wasm")).filter((f) => f !== "pins.json");
      results.push(left.length === 0 ? "ok   ...and installs nothing in wasm/" : `FAIL ...left ${left.join(", ")} in wasm/`);
    }
    await expect("a body that stalls after its headers is stopped by the download limit", () => fetchModules(opts(root("r-stall"), { limits: { ...fast, headersMs: 1_000, downloadMs: 200, attempts: 1, deadlineMs: 5_000 } })), /not complete within/);
    for (const [m, what, pattern] of [["stream500", "a 5xx whose body never ends, on every attempt", /HTTP 500/], ["biglen", "a content-length past the pinned length", /more than the pinned/]]) {
      mode = m;
      peak = live;
      await expect(`the fetch refuses ${what}`, () => fetchModules(opts(root(`r-${m}`))), pattern);
      await settle();
      results.push(live === 0 && peak <= LIMITS.parallel ? `ok   ...and closes every rejected response (none live afterwards; at most ${peak} at once)` : `FAIL ...${live} responses still live afterwards; ${peak} at once`);
    }
    mode = "ok";
    await expect("an unreachable origin fails", () => fetchModules({ ...opts(root("r-down")), base: "http://127.0.0.1:9/" }), /ECONNREFUSED|fetch failed|refused/i);
    const r404 = root("r404");
    writeFileSync(pinsPath(r404), formatPins({ ...pinsOf(mods), [MODULES[1]]: { sha256: "f".repeat(64), bytes: 10 } }));
    for (const n of MODULES) if (n !== MODULES[1]) writeFileSync(modulePath(n, r404), mods[n]);
    {
      const before = requests;
      await expect("an unpublished pin says so (404, not retried)", () => fetchModules(opts(r404)), /isn't published yet/);
      results.push(requests - before === 1 ? "ok   ...with exactly one request" : `FAIL ...${requests - before} requests for a 404`);
    }
    await expect("--offline with an empty cache fails at once", () => fetchModules({ ...opts(root("r-off")), offline: true }), /--offline makes no request/);
    // a branch switch: bytes this machine installed for an earlier pin are replaced from the cache, with no request
    const r2 = root("r2");
    await fetchModules(opts(r2));
    const newer = { ...mods, [MODULES[0]]: Buffer.concat([mods[MODULES[0]], Buffer.from(" v2")]) };
    served.set(`${sha256(newer[MODULES[0]])}.wasm`, newer[MODULES[0]]);
    writeFileSync(pinsPath(r2), formatPins(pinsOf(newer)));
    await fetchModules(opts(r2)); // to the new pin (downloads one)
    writeFileSync(pinsPath(r2), formatPins(pinsOf(mods)));
    await pass("switching back to a cached pin replaces the installed module with no request", async () => {
      const before = requests;
      await fetchModules(opts(r2));
      return requests === before && moduleState(MODULES[0], pinsOf(mods)[MODULES[0]], r2).state === "pinned";
    });
    // unidentified bytes, a local build and its sidecar
    const r3 = root("r3");
    await fetchModules(opts(r3));
    writeFileSync(modulePath(MODULES[2], r3), Buffer.from("not ours"));
    await expect("unidentified bytes in wasm/ are refused", () => fetchModules(opts(r3)), /--force/);
    await expect("...and fail the pinned check", async () => checkModules({ root: r3, mode: "pinned" }), /matches neither/);
    writeSidecar(MODULES[2], r3);
    await expect("a local build fails the pinned check", async () => checkModules({ root: r3, mode: "pinned" }), /local build/);
    await pass("...and passes in local mode, labelled", async () => checkModules({ root: r3, mode: "local" }).some((l) => /using a local build/.test(l)));
    await pass("--force replaces a local build that has its sidecar", async () => {
      const rl = root("r-local");
      await fetchModules(opts(rl));
      writeFileSync(modulePath(MODULES[0], rl), Buffer.from("built here"));
      writeSidecar(MODULES[0], rl);
      const kept = (await fetchModules(opts(rl))).find((r) => r.name === MODULES[0]).action.startsWith("kept a local build");
      await fetchModules({ ...opts(rl), force: true });
      return kept && moduleState(MODULES[0], pinsOf(mods)[MODULES[0]], rl).state === "pinned";
    });
    writeFileSync(modulePath(MODULES[2], r3), Buffer.from("not ours either"));
    await expect("a sidecar that doesn't match its module is refused", async () => checkModules({ root: r3, mode: "local" }), /matches neither/);
    await pass("--force replaces them with the pinned bytes", async () => {
      await fetchModules({ ...opts(r3), force: true });
      return checkModules({ root: r3, mode: "pinned" }).length === MODULES.length;
    });
    await expect("local mode is refused under CI", async () => runMode({ SAGEBRUSH_WASM_LOCAL: "1", CI: "true" }), /refused under CI/);
    await expect("a missing module names the fix", async () => checkModules({ root: root("r-missing"), mode: "pinned" }), /is missing: run node scripts\/wasm-fetch\.mjs/);
    await pass("an oversized file in wasm/ is unidentified without being read", async () => {
      const ro = root("r-oversized");
      execFileSync("truncate", ["-s", String(1 << 30), modulePath(MODULES[0], ro)]); // 1 GiB, sparse
      const t0 = Date.now(), st = moduleState(MODULES[0], pinsOf(mods)[MODULES[0]], ro);
      return st.state === "unidentified" && Date.now() - t0 < 200;
    });
    await pass("an oversized cache entry is dropped without being read", async () => {
      const rq = root("r-cache-oversized"), cache = join(rq, "cache");
      mkdirSync(cache, { recursive: true });
      execFileSync("truncate", ["-s", String(1 << 30), join(cache, `${sha256(mods[MODULES[0]])}.wasm`)]);
      const t0 = Date.now();
      await fetchModules(opts(rq));
      return Date.now() - t0 < 1_000 && matches(readFileSync(modulePath(MODULES[0], rq)), pinsOf(mods)[MODULES[0]]);
    });
    // two runs sharing one cache
    const shared = join(dir, "shared-cache");
    const [ra, rb] = [root("ra"), root("rb")];
    await pass("two concurrent fetches into one cache both end pinned", async () => {
      await Promise.all([fetchModules({ ...opts(ra), cacheDir: shared }), fetchModules({ ...opts(rb), cacheDir: shared })]);
      return [ra, rb].every((r) => checkModules({ root: r, mode: "pinned" }).length === MODULES.length);
    });
    await pass("a cache entry whose bytes don't match its name is dropped, not used", async () => {
      const rc = root("rc");
      const cache = join(rc, "cache");
      mkdirSync(cache, { recursive: true });
      const corrupt = Buffer.from(mods[MODULES[3]]);
      corrupt[corrupt.length - 1] ^= 1; // the pinned length, one byte different
      writeFileSync(join(cache, `${sha256(mods[MODULES[3]])}.wasm`), corrupt);
      await fetchModules(opts(rc));
      return matches(readFileSync(modulePath(MODULES[3], rc)), pinsOf(mods)[MODULES[3]]);
    });
    // the committed modules against pins.json: all four, none, or a partial set; and git failures
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "wasm"), { recursive: true });
    const g = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
    g("init", "-q");
    g("config", "user.email", "self-test@example.invalid");
    g("config", "user.name", "self-test");
    writeFileSync(pinsPath(repo), formatPins(pinsOf(mods)));
    for (const n of MODULES) writeFileSync(modulePath(n, repo), mods[n]);
    g("add", "-A");
    g("commit", "-qm", "all four");
    await pass("all four committed and matching their pins pass", async () => committedMismatches({ root: repo }).length === 0);
    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    rmSync(modulePath(MODULES[2], repo));
    symlinkSync(MODULES[0], modulePath(MODULES[2], repo));
    g("add", "-A");
    g("commit", "-qm", "a symlink");
    await pass("a module committed as a symlink fails, naming it", async () => committedMismatches({ root: repo }).some((l) => l.startsWith(MODULES[2]) && /not a regular file \(120000/.test(l)));
    g("reset", "-q", "--hard", head);
    chmodSync(modulePath(MODULES[2], repo), 0o755);
    g("add", "-A");
    g("commit", "-qm", "an executable");
    await pass("a module committed as executable fails, naming it", async () => committedMismatches({ root: repo }).some((l) => l.startsWith(MODULES[2]) && /not a regular file \(100755/.test(l)));
    g("reset", "-q", "--hard", head);
    chmodSync(modulePath(MODULES[2], repo), 0o644);
    writeFileSync(modulePath(MODULES[3], repo), Buffer.from("changed"));
    g("commit", "-qam", "one changed");
    await pass("a committed module that differs from its pin fails, naming it", async () => committedMismatches({ root: repo }).some((l) => l.startsWith(MODULES[3])));
    await pass("a pin whose length differs from the committed module fails, naming it", async () => committedMismatches({ root: repo, pins: { ...pinsOf(mods), [MODULES[3]]: { sha256: sha256(Buffer.from("changed")), bytes: 8 } } }).some((l) => l.startsWith(MODULES[3])));
    g("rm", "-q", `wasm/${MODULES[1]}`);
    g("commit", "-qm", "one removed");
    await pass("a partial set fails, naming the missing module", async () => committedMismatches({ root: repo }).some((l) => /only 3 of the 4/.test(l) && l.includes(MODULES[1])));
    g("rm", "-q", ...MODULES.filter((n) => n !== MODULES[1]).map((n) => `wasm/${n}`));
    g("commit", "-qm", "none");
    await pass("no module committed passes (nothing to compare)", async () => committedMismatches({ root: repo }).length === 0);
    await expect("an unknown revision is an error, not a pass", async () => committedMismatches({ root: repo, rev: "no-such-rev" }), /is not a commit/);
    await expect("a directory that isn't a repository is an error", async () => committedMismatches({ root: join(dir, "r1") }), /is not a commit/);
    // publication
    await pass("--verify-published passes when every pin is served", async () => (await verifyPublished({ root: r1, base, limits: fast })).length === MODULES.length);
    await expect("--verify-published fails for a missing key", () => verifyPublished({ root: r404, base, limits: fast }), /isn't published yet/);
    mode = "wrong";
    await expect("--verify-published fails for wrong bytes", () => verifyPublished({ root: r1, base, limits: fast }), /don't match the pin/);
    mode = "ok";
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  try {
    if (cmd === "--check") {
      const pins = loadPins();
      for (const n of MODULES) {
        const s = moduleState(n, pins[n]);
        console.log(`${n}: ${s.state}${s.sha256 && s.state !== "pinned" ? ` (sha256 ${s.sha256}, ${s.bytes} bytes)` : ""}`);
      }
    } else if (cmd === "--verify-committed") {
      const bad = committedMismatches({ rev: arg("--rev") ?? "HEAD" });
      if (bad.length) throw new Error(`wasm/pins.json doesn't match the committed modules (run node scripts/wasm-pins.mjs --from-committed):\n${bad.join("\n")}`);
      console.log("wasm/pins.json matches the committed modules");
    } else if (cmd === "--from-committed" || cmd === "--from-local") {
      const read = cmd === "--from-local" ? (n) => readFileSync(modulePath(n)) : (n) => execFileSync("git", ["-C", ROOT, "show", `HEAD:wasm/${n}`], { maxBuffer: 1 << 27 });
      writeFileSync(pinsPath(), formatPins(pinsFrom(read)));
      console.log(readFileSync(pinsPath(), "utf8").trimEnd());
    } else if (cmd === "--mark-local") {
      for (const n of rest.length ? rest : MODULES) {
        if (!MODULES.includes(n)) throw new Error(`unknown module ${n}`);
        writeSidecar(n);
        console.log(`wasm/${n}.local.json written`);
      }
    } else if (cmd === "--verify-published") {
      for (const l of await verifyPublished({ base: arg("--base") ?? DEFAULT_BASE })) console.log(l);
    } else if (cmd === "--self-test") {
      const r = await selfTest();
      for (const l of r) console.log(l);
      const failed = r.filter((l) => l.startsWith("FAIL")).length;
      console.log(failed ? `wasm-pins self-test: ${failed} of ${r.length} FAILED` : `wasm-pins self-test: all ${r.length} controls pass`);
      if (failed) process.exit(1);
    } else {
      console.error("usage: node scripts/wasm-pins.mjs --check | --verify-committed | --from-committed | --from-local | --mark-local [name...] | --verify-published [--base URL] | --self-test");
      process.exit(2);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
