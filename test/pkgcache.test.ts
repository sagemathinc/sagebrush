import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The CLI's package sets (src/pkgcache.ts; plan-modular-packages-r4 §4.3,
// §4.6): `--pkgset ID` fetches a set and its chunks into a bounded cache,
// each verified before it is kept; a local pkgset/<S>.json file is read with
// its sibling pkg/ chunks; eviction is least recently used, never an entry
// a live process uses; stale temporaries and locks are cleaned.
const DIST = __dirname + "/..";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const C = require(DIST + "/src/pkgcache.js");
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const canon = (v: any): string =>
  Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : v !== null && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v);

// a one-package set on disk: dir/pkgset/<S>.json and dir/pkg/<h>.json
function setOnDisk() {
  const dir = mkdtempSync(join(tmpdir(), "sb-pkgcache-set-"));
  mkdirSync(join(dir, "pkg"));
  mkdirSync(join(dir, "pkgset"));
  const files = { "py/greet.py": "MSG = 'from the set'\n" };
  const chunk = Buffer.from(canon({ format: "sagebrush-pkg-chunk", v: 1, kind: "src", package: "@sagebrush/greet@0.1.0", files }));
  const h = sha(chunk);
  writeFileSync(join(dir, "pkg", h + ".json"), chunk);
  const ix = { format: "sagebrush-pkgset", v: 1, core_api: 1, packages: { "@sagebrush/greet@0.1.0": { dir: "greet", root: "py", files: { "py/greet.py": sha(files["py/greet.py"]) }, modules: ["greet"], requires: [], core_req: { api: 1, level: 1 }, src: { sha256: h, size: chunk.length }, pre: {}, cost: {} } } };
  const index = Buffer.from(canon(ix));
  const S = sha(index);
  writeFileSync(join(dir, "pkgset", S + ".json"), index);
  return { dir, S, h, chunk, index };
}
const cli = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [join(DIST, "src", "cli.js"), ...args], { encoding: "utf8", env: { ...process.env, SAGEBRUSH_NO_COMPILE_CACHE: "1", ...env } });

test("a local set: --pkgset pkgset/<S>.json, its chunks beside it", () => {
  const s = setOnDisk();
  const r = cli(["--pkgset", join(s.dir, "pkgset", s.S + ".json"), "-c", "import greet; print(greet.MSG)"]);
  assert.equal(r.stdout, "from the set\n", r.stderr);
  // (an index file whose name isn't its digest is refused)
  writeFileSync(join(s.dir, "pkgset", "f".repeat(64) + ".json"), s.index);
  const bad = cli(["--pkgset", join(s.dir, "pkgset", "f".repeat(64) + ".json"), "-c", "1"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /package set: .*not the one its id names/);
});

test("a set by id: fetched, verified and cached; then read from the cache", async () => {
  const s = setOnDisk();
  let hits = 0, lie = false;
  const server = createServer((req, res) => {
    hits++;
    const m = /^\/(pkgset|pkg)\/([0-9a-f]{64})\.json$/.exec(req.url ?? "");
    const f = m ? join(s.dir, m[1], m[2] + ".json") : "";
    if (!m || !existsSync(f)) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(lie ? Buffer.from("{}") : require("node:fs").readFileSync(f));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const cache = mkdtempSync(join(tmpdir(), "sb-pkgcache-home-"));
  try {
    const env = { SAGEBRUSH_PKG_BASE: base, XDG_CACHE_HOME: cache };
    const run = () => new Promise<any>((resolve) => {
      const p = require("node:child_process").spawn(process.execPath, [join(DIST, "src", "cli.js"), "--pkgset", s.S, "-c", "import greet; print(greet.MSG)"], { env: { ...process.env, SAGEBRUSH_NO_COMPILE_CACHE: "1", ...env } });
      let out = "", err = "";
      p.stdout.on("data", (d: Buffer) => (out += d));
      p.stderr.on("data", (d: Buffer) => (err += d));
      p.on("close", (status: number) => resolve({ out, err, status }));
    });
    const first = await run();
    assert.equal(first.out, "from the set\n", first.err);
    assert.equal(hits, 2, "the index and its chunk");
    assert.deepEqual(readdirSync(join(cache, "sagebrush", "pkg")).filter((f) => f.endsWith(".json")).sort(), [s.S + ".json", s.h + ".json"].sort());
    const second = await run();
    assert.equal(second.out, "from the set\n");
    assert.equal(hits, 2, "the second run reads the cache");
    // a corrupt cache entry is dropped and fetched again; a server that lies is refused
    writeFileSync(join(cache, "sagebrush", "pkg", s.h + ".json"), "{}");
    lie = true;
    const third = await run();
    assert.equal(third.status, 2);
    assert.match(third.err, /package set: .*not the bytes its address names|over \d+ bytes/);
    assert.ok(!existsSync(join(cache, "sagebrush", "pkg", s.h + ".json")), "the corrupt entry is gone, and nothing wrong was kept");
  } finally {
    server.close();
  }
});

test("eviction: least recently used first, never one in use; stale temporaries and locks cleaned", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-pkgcache-trim-"));
  const old = Date.now() / 1000 - 3 * 3600;
  const names: string[] = [];
  for (let i = 0; i < 260; i++) {
    const h = sha(String(i));
    names.push(h);
    writeFileSync(join(dir, h + ".json"), "x");
    // (older first: entry i last used i seconds after `old`)
    utimesSync(join(dir, h + ".json"), old + i, old + i);
  }
  // entry 0 is in use by this (live) process; entry 1 by a process that is gone
  writeFileSync(join(dir, `${names[0]}.inuse.${process.pid}`), "");
  writeFileSync(join(dir, `${names[1]}.inuse.999999999`), "");
  writeFileSync(join(dir, ".tmp-1-abc"), "partial");
  utimesSync(join(dir, ".tmp-1-abc"), old, old);
  writeFileSync(join(dir, "dead.lock"), "");
  utimesSync(join(dir, "dead.lock"), old, old);
  C.trimCache(dir);
  const left = new Set(readdirSync(dir));
  assert.equal([...left].filter((f) => /^[0-9a-f]{64}\.json$/.test(f)).length, 256, "at most 256 entries");
  assert.ok(left.has(names[0] + ".json"), "the entry in use stays");
  assert.ok(!left.has(names[1] + ".json"), "the oldest unused ones go first");
  assert.ok(!left.has(".tmp-1-abc") && !left.has("dead.lock"), "stale temporaries and locks are cleaned");
  assert.ok(!left.has(`${names[1]}.inuse.999999999`), "a dead process's mark is cleaned");
});
