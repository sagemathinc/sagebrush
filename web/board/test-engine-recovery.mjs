// ci: web-browser/board-unit.2 order=90
// Public engine recovery is opt-in, API-compatible and content-addressed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { engineIdText } from "../engine-id.mts";

const dir = mkdtempSync(join(tmpdir(), "sb-engine-recovery-"));
const originalFetch = globalThis.fetch;
const own = { id: "1".repeat(20), api: 7, files: {} };
const data = new TextEncoder().encode("engine bytes");
const sum = createHash("sha256").update(data).digest("hex");
const files = { "sagebrush-worker.js": { sha256: sum, size: data.length, headers: { "content-type": "text/javascript" } } };
const id = createHash("sha256").update(engineIdText(7, files)).digest("hex").slice(0, 20);
const manifest = { format: "sagebrush-engine", api: 7, id, files };
let calls = [], latest = { api: 7, id }, current = manifest, bytes = data;
try {
  execFileSync("bun", ["build", "web/board/engine.ts", "--target=node", "--format=esm", `--define=__SB_ENGINE__=${JSON.stringify(own)}`, `--outfile=${join(dir, "engine.mjs")}`], { stdio: "pipe" });
  const mod = await import(pathToFileURL(join(dir, "engine.mjs")).href);
  assert.deepEqual(calls, [], "import alone never asks the public site");
  globalThis.fetch = async (url) => {
    const u = new URL(url); calls.push(u.href);
    assert.equal(u.origin, "https://sagebrush.space", "fixed public site, not a document-controlled URL");
    return new Response(u.pathname.endsWith("latest.json") ? JSON.stringify(latest) : u.pathname.endsWith("manifest.json") ? JSON.stringify(current) : bytes);
  };
  const picked = await mod.publicLatestEngine();
  assert.equal(picked.id, id);
  assert.deepEqual(new Uint8Array(await picked.bytes("sagebrush-worker.js")), data);
  assert.equal(calls.length, 3);
  bytes = new TextEncoder().encode("changed bytes");
  await assert.rejects(picked.bytes("sagebrush-worker.js"), /SHA-256 differs/);
  latest = { api: 8, id }; calls = [];
  await assert.rejects(mod.publicLatestEngine(), /newer file reader/);
  assert.equal(calls.length, 1, "incompatible API: no manifest or executable bytes fetched");
  latest = { api: 7, id: "not an id" };
  await assert.rejects(mod.publicLatestEngine(), /invalid latest engine id/);
  latest = { api: 7, id }; current = { ...manifest, files: { ...files, "extra.js": files["sagebrush-worker.js"] } };
  await assert.rejects(mod.publicLatestEngine(), /invalid engine manifest/);
  current = { ...manifest, api: 8 };
  await assert.rejects(mod.publicLatestEngine(), /invalid engine manifest/);
  globalThis.fetch = async () => new Response("no", { status: 404 });
  await assert.rejects(mod.publicLatestEngine(), /latest engine unavailable.*404/);
  globalThis.fetch = async () => { throw new TypeError("Load failed"); };
  await assert.rejects(mod.publicLatestEngine(), /Load failed/);
  let offered = 0;
  const start = (error) => mod.fileEngine(async () => ({ names: [], bytes: async () => { throw error; } }), { sage: false, unavailable: (yes) => { if (yes) offered++; } }).module();
  await assert.rejects(start(new Error("SHA-256 differs: refused")), /SHA-256/);
  assert.equal(offered, 0, "a part hash refusal never offers engine substitution");
  await assert.rejects(start(new mod.EnginePartError("404", "missing", "https://old.invalid/")), /isn't published/);
  assert.ok(offered > 0, "genuine missing parts mark recovery as available");
  // Both part orders, and a late hash refusal: no offer while the hash is
  // pending, no offer after it fails, and the integrity error wins.
  for (const reverse of [false, true]) {
    const decisions = [];
    let rejectHash;
    const hash = new Promise((_, reject) => { rejectHash = reject; });
    const hashName = reverse ? "sagebrush-engine.wasm" : "sagebrush-worker.js";
    const missingName = reverse ? "sagebrush-worker.js" : "sagebrush-engine.wasm";
    const mixed = mod.fileEngine(async () => ({ names: [], bytes: async (name) => {
      if (name === hashName) return hash;
      if (name === missingName) throw new mod.EnginePartError("404", "missing", "https://old.invalid/");
      return new ArrayBuffer(0);
    } }), { sage: false, unavailable: (yes) => decisions.push(yes) }).module();
    const rejected = assert.rejects(mixed, /SHA-256 differs/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(decisions, [], "missing part alone cannot enable recovery before all hashes settle");
    rejectHash(new Error("SHA-256 differs: refused"));
    await rejected;
    assert.deepEqual(decisions, [false], "integrity refusal suppresses recovery in either part order");
  }
  console.log("PASS public recovery: opt-in, fixed site, API, id, manifest hash, part hash, HTTP and network refusal");
} finally {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
}
