// The engines route (web/engines.ts) in Miniflare, with web/dist's engine in
// a simulated R2 bucket: each file comes back byte for byte with its
// manifest's headers, immutable and readable from anywhere; nothing else
// does; and every 404/405 says nosniff (security audit G-3a; control C-E).
// Run after bun web/build.ts:   node web/test-engines.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { engineIdText, isManifest } from "./engine-id.mts";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "test-workers/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

let failures = 0, count = 0;
const ok = (c, what) => { count++; if (!c) { failures++; console.log("FAIL", what); } };

const { id } = JSON.parse(readFileSync(join(here, "dist/engine/latest.json"), "utf8"));
const dir = join(here, "dist/engine", id);
const man = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
// (the route's Worker, from an engines.ts: this one, or a control's mutated copy)
function workerOf(engines) {
  const entry = `import { handleEngines, handleLibChunk, handlePkg } from ${JSON.stringify(engines)};
export default { async fetch(req, env, ctx) { return (await handleEngines(req, env, ctx)) ?? (await handleLibChunk(req, env, ctx)) ?? (await handlePkg(req, env, ctx)) ?? new Response("not mine", { status: 418 }); } };`;
  const entryFile = join(mkdtempSync(join(tmpdir(), "sb-engines-")), "entry.ts");
  writeFileSync(entryFile, entry);
  const script = execFileSync("bun", ["build", entryFile, "--format", "esm", "--target", "browser"], { encoding: "utf8" });
  return new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "engines", modules: true, script, compatibilityDate: "2026-10-01", r2Buckets: ["ENGINES"] }] }));
}
const mf = workerOf(join(here, "engines.ts"));
const bucket = await mf.getR2Bucket("ENGINES");
// (as scripts/publish-engine.mjs puts it: the zone data only at the shared
// lib/tzdata/, every other file under engine/<id>/)
const SHARED = /^lib\/tzdata\//;
for (const f of [...Object.keys(man.files), "manifest.json"]) await bucket.put(SHARED.test(f) ? f : `engine/${id}/${f}`, readFileSync(join(dir, f)));

const get = (path, init) => mf.dispatchFetch(`https://sagebrush.test${path}`, init);
for (const [f, d] of Object.entries(man.files)) {
  const r = await get(`/engine/${id}/${f}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  ok(r.status === 200 && bytes.equals(readFileSync(join(dir, f))), `${f}: the file, byte for byte`);
  ok(r.headers.get("content-type") === d.headers["Content-Type"] && /immutable/.test(r.headers.get("cache-control")) && r.headers.get("access-control-allow-origin") === "*" && r.headers.get("x-content-type-options") === "nosniff", `${f}: its type, immutable, CORS *, nosniff`);
}
const runner = await get(`/engine/${id}/runner/index.html`);
ok(/connect-src 'none'/.test(runner.headers.get("content-security-policy") ?? "") && runner.headers.get("cross-origin-embedder-policy") === "require-corp", "the runner page: the runner's policy (no network) and isolation");
const wasm = await get(`/engine/${id}/sagebrush-engine.wasm?h=abc`);
ok(wasm.status === 200 && wasm.headers.get("content-type") === "application/wasm", "a query is ignored (the worker asks for ?h=)");
ok((await get(`/engine/${id}/manifest.json`)).status === 200, "the manifest");
const head = await get(`/engine/${id}/sagebrush-worker.js`, { method: "HEAD" });
ok(head.status === 200 && head.headers.get("content-length") === String(man.files["sagebrush-worker.js"].size), "HEAD gives the size");
ok((await get(`/engine/${"0".repeat(20)}/sagebrush-worker.js`)).status === 404, "an engine that doesn't exist: 404");
ok((await get(`/engine/${id}/nothing.js`)).status === 404, "a file not in the manifest: 404");
ok((await get(`/engine/${id}/sagebrush-worker.js`, { method: "POST" })).status === 405, "only GET and HEAD");
// an object in the bucket that the manifest doesn't list, named like an
// Object property: not served (SEC-CAC-3)
await bucket.put(`engine/${id}/constructor`, "stray");
ok((await get(`/engine/${id}/constructor`)).status === 404 && (await get(`/engine/${id}/tostring`)).status === 404, "an object the manifest doesn't list (constructor): 404");
// the id is the manifest's content: its api and each file's hash, size and
// headers; a change of headers alone (the runner's policy) is another engine (SEC-CAC-2)
const idOf = (api, files) => createHash("sha256").update(engineIdText(api, files)).digest("hex").slice(0, 20);
ok(isManifest(man) && man.id === id && idOf(man.api, man.files) === id, "the engine's id is its manifest's content");
const runnerFile = man.files["runner/index.html"];
const tightened = { ...man.files, "runner/index.html": { ...runnerFile, headers: { ...runnerFile.headers, "Content-Security-Policy": runnerFile.headers["Content-Security-Policy"] + "; frame-src 'none'" } } };
ok(idOf(man.api, tightened) !== id && idOf(man.api + 1, man.files) !== id, "another runner policy, or another api: another id");
ok(idOf(man.api, Object.fromEntries(Object.entries(man.files).reverse())) === id, "the id doesn't depend on the order of the files");
// an id with no engine, asked for again: answered without reading R2 again (HARD-CAC-5)
const unknown = "f".repeat(20);
ok((await get(`/engine/${unknown}/sagebrush-worker.js`)).status === 404, "an unknown id: 404");
// (published just after: still 404 for a minute, as R2 isn't asked again)
for (const f of [...Object.keys(man.files), "manifest.json"]) await bucket.put(`engine/${unknown}/${f}`, readFileSync(join(dir, f)));
ok((await get(`/engine/${unknown}/sagebrush-worker.js`)).status === 404, "an unknown id asked for again soon: answered without reading R2");
// HEAD after a GET: from the edge's copy, with the same headers
const g = await get(`/engine/${id}/sagebrush-engine.wasm`);
await g.arrayBuffer();
const h2 = await get(`/engine/${id}/sagebrush-engine.wasm`, { method: "HEAD" });
ok(h2.status === 200 && h2.headers.get("content-type") === "application/wasm" && !(await h2.arrayBuffer()).byteLength, "HEAD after GET: the headers, no body");
ok((await get(`/engine/latest.json`)).status === 418 && (await get(`/other`)).status === 418, "other paths are not the route's");
// The library's chunks at lib/<name>, for a page older than the site's
// files (HARD-813-1), as scripts/publish-engine.mjs puts them
const chunks = Object.keys(man.files).filter((f) => f.startsWith("lib/"));
ok(chunks.length > 5, "(the engine has the library's chunks)");
for (const f of chunks) await bucket.put(f, readFileSync(join(dir, f)));
for (const f of chunks) {
  const r = await get("/" + f);
  ok(r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(readFileSync(join(dir, f))), `/${f}: the chunk, byte for byte`);
  // (a zone file is bytes; every other chunk is JSON)
  const [type, kind] = f.endsWith(".tzif") ? ["application/octet-stream", "bytes"] : ["application/json", "JSON"];
  ok(r.headers.get("content-type") === type && /immutable/.test(r.headers.get("cache-control")) && r.headers.get("access-control-allow-origin") === "*" && r.headers.get("x-content-type-options") === "nosniff", `/${f}: ${kind}, immutable, CORS *, nosniff`);
}
// (bytes that are not the ones its name says: not served; nor a name of
// another shape, nor a chunk R2 doesn't have)
const [one] = chunks, forged = one.replace(/\.([0-9a-f]{16})\.json$/, ".0000000000000000.json");
await bucket.put(forged, readFileSync(join(dir, one)));
ok((await get("/" + forged)).status === 404, "a chunk whose bytes don't have its name's hash: 404");
await bucket.put("lib/Bad_Name.src.0000000000000000.json", "{}");
ok((await get("/lib/Bad_Name.src.0000000000000000.json")).status === 418 && (await get("/lib/x.src.123.json")).status === 418 && (await get("/lib/../engine/latest.json")).status === 418, "names of another shape are not the route's");
ok((await get("/lib/nothing.src.0123456789abcdef.json")).status === 404, "a chunk R2 doesn't have: 404");
// (the pinned zone data's files, web/tzdata-chunks.mts: by their whole SHA-256)
const zones = chunks.filter((f) => f.startsWith("lib/tzdata/"));
ok(zones.some((f) => /^lib\/tzdata\/index-[0-9a-f]{64}\.json$/.test(f)) && zones.filter((f) => f.endsWith(".tzif")).length > 300, `(the engine has the zone data: ${zones.length} files)`);
const zone = zones.find((f) => f.endsWith(".tzif"));
await bucket.put("lib/tzdata/" + "0".repeat(64) + ".tzif", readFileSync(join(dir, zone)));
ok((await get("/lib/tzdata/" + "0".repeat(64) + ".tzif")).status === 404, "a zone file whose bytes don't have its name's hash: 404");
ok((await get("/" + zone)).headers.get("content-type") === "application/octet-stream", "a zone file is served as bytes");
ok((await get("/" + one, { method: "POST" })).status === 405, "a chunk: only GET and HEAD");
// An engine's zone data from the shared lib/tzdata/ (each file uploaded
// once, not with every engine): served only with the bytes its manifest
// names; an engine published before that has its own copy, used when the
// shared one is missing or not those bytes.
const [zoneA, zoneB, zoneC, zoneD, zoneE] = zones.filter((f) => f.endsWith(".tzif"));
const old = "e".repeat(20), bare = "d".repeat(20);
for (const e of [old, bare]) await bucket.put(`engine/${e}/manifest.json`, readFileSync(join(dir, "manifest.json")));
for (const z of [zoneA, zoneB, zoneD, zoneE]) await bucket.put(`engine/${old}/${z}`, readFileSync(join(dir, z)));
const fromShared = await get(`/engine/${bare}/${zoneC}`);
ok(fromShared.status === 200 && Buffer.from(await fromShared.arrayBuffer()).equals(readFileSync(join(dir, zoneC))) && fromShared.headers.get("content-type") === "application/octet-stream" && /immutable/.test(fromShared.headers.get("cache-control")), "an engine's zone file from the shared copy, byte for byte, with its manifest's headers");
const ix = zones.find((f) => f.endsWith(".json"));
ok(Buffer.from(await (await get(`/engine/${bare}/${ix}`)).arrayBuffer()).equals(readFileSync(join(dir, ix))), "the zone data's index from the shared copy");
await bucket.put(zoneA, readFileSync(join(dir, zoneB)));
await bucket.delete(zoneB);
const a = await get(`/engine/${old}/${zoneA}`), b = await get(`/engine/${old}/${zoneB}`);
ok(a.status === 200 && Buffer.from(await a.arrayBuffer()).equals(readFileSync(join(dir, zoneA))), "a shared copy with other bytes: the engine's own copy");
ok(b.status === 200 && Buffer.from(await b.arrayBuffer()).equals(readFileSync(join(dir, zoneB))), "no shared copy: the engine's own copy");
ok((await get(`/engine/${bare}/${zoneA}`)).status === 404 && (await get(`/engine/${bare}/${zoneB}`)).status === 404, "neither a shared copy with its bytes nor its own: 404");
// (a shared object of another size is not read: 4 MB there, HARD-TZU-2;
// one of the same size with other bytes fails its hash)
await bucket.put(zoneD, new Uint8Array(4 << 20));
const flipped = Buffer.from(readFileSync(join(dir, zoneE)));
flipped[flipped.length - 1] ^= 1;
await bucket.put(zoneE, flipped);
for (const [z, what] of [[zoneD, "another size"], [zoneE, "the same size and other bytes"]]) {
  const r = await get(`/engine/${old}/${z}`);
  ok(r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(readFileSync(join(dir, z))), `a shared copy of ${what}: the engine's own copy`);
  ok((await get(`/engine/${bare}/${z}`)).status === 404, `a shared copy of ${what} and none of its own: 404`);
}
const h = await get(`/engine/${bare}/${zoneC}`, { method: "HEAD" });
ok(h.status === 200 && h.headers.get("content-length") === String(man.files[zoneC].size), "HEAD of a shared zone file gives its size");

// Every refusal (security audit G-3a): the seven 404/405 sites (engine 405 :57, engine 404 without a manifest entry
// :69 and without the object :86, lib 405 :113 and 404 :121, pkg 405 :151 and 404 :153) say nosniff, and keep their
// status, body and headers: a 404 CORS * and no-store, a 405 neither.  A file (200) says it too (COMMON).
const HEX = "0123456789abcdef".repeat(4);
const REFUSALS = [
  ["engine 405", `/engine/${id}/sagebrush-worker.js`, "POST", 405, "method not allowed"],
  ["engine 404 (no entry)", `/engine/${"0".repeat(20)}/sagebrush-worker.js`, "GET", 404, "no such engine file"],
  ["engine 404 (no object)", `/engine/${"b".repeat(20)}/sagebrush-worker.js`, "GET", 404, "no such engine file"],
  ["lib 405", "/lib/x.src.0123456789abcdef.json", "POST", 405, "method not allowed"],
  ["lib 404", "/lib/nothing.src.0123456789abcdef.json", "GET", 404, "no such library chunk"],
  ["pkg 405", `/pkg/${HEX}.json`, "POST", 405, "method not allowed"],
  ["pkg 404", `/pkgset/${HEX}.json`, "GET", 404, "no such package file"],
];
// (per case: what lacks nosniff, and anything else not as before)
async function refusals(w) {
  const b = await w.getR2Bucket("ENGINES");
  await b.put(`engine/${"b".repeat(20)}/manifest.json`, readFileSync(join(dir, "manifest.json"))); // (lists the file; no object)
  const g = (path, init) => w.dispatchFetch(`https://sagebrush.test${path}`, init);
  const lacking = [], other = [];
  for (const [name, path, method, status, body] of REFUSALS) {
    const r = await g(path, { method });
    const text = await r.text(), acao = r.headers.get("access-control-allow-origin"), cc = r.headers.get("cache-control");
    const kept = r.status === status && text === body && (status === 404 ? acao === "*" && cc === "no-store" : acao === null && cc === null);
    if (!kept) other.push(`${name}: ${r.status} ${JSON.stringify(text)} acao=${acao} cache=${cc}`);
    if (r.headers.get("x-content-type-options") !== "nosniff") lacking.push(name);
  }
  return { lacking, other };
}
{
  const { lacking, other } = await refusals(mf);
  console.log(`G3A-ENGINES refusals ${REFUSALS.length}: lacking nosniff [${lacking.join(", ")}]; not as before [${other.join("; ")}]`);
  ok(other.length === 0, "every 404/405 keeps its status, body and headers: " + (other.join("; ") || "all"));
  ok(lacking.length === 0, `every 404/405 (${REFUSALS.length}) says nosniff: ` + (lacking.join(", ") || "none missing"));
  const file = await get(`/engine/${id}/sagebrush-worker.js`);
  ok(file.status === 200 && file.headers.get("x-content-type-options") === "nosniff", "a file (200) says nosniff");
}
await mf.dispose();
// Control C-E: text() without nosniff -> exactly the seven refusals lack it, nothing else changes, and the 200 keeps it
{
  const src = readFileSync(join(here, "engines.ts"), "utf8"), a = `{ ...headers, "X-Content-Type-Options": "nosniff" }`;
  ok(src.split(a).length === 2, "control C-E: the change applies to web/engines.ts");
  const copy = join(mkdtempSync(join(tmpdir(), "sb-engines-ce-")), "engines.ts");
  writeFileSync(copy, src.replace(a, "{ ...headers }"));
  const w = workerOf(copy);
  const wb = await w.getR2Bucket("ENGINES");
  for (const f of ["sagebrush-worker.js", "manifest.json"]) await wb.put(`engine/${id}/${f}`, readFileSync(join(dir, f)));
  const { lacking, other } = await refusals(w);
  const f200 = await w.dispatchFetch(`https://sagebrush.test/engine/${id}/sagebrush-worker.js`);
  console.log(`G3A-ENGINES control C-E: lacking nosniff [${lacking.join(", ")}]; not as before [${other.join("; ")}]; 200 nosniff ${f200.headers.get("x-content-type-options")}`);
  ok(JSON.stringify(lacking) === JSON.stringify(REFUSALS.map(([n]) => n)) && other.length === 0 && f200.status === 200 && f200.headers.get("x-content-type-options") === "nosniff",
    `control C-E: exactly the ${REFUSALS.length} refusals lack nosniff (${lacking.join(", ") || "none"}), nothing else changed (${other.join("; ") || "none"}), the 200 keeps it`);
  await w.dispose();
}
console.log(`${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
