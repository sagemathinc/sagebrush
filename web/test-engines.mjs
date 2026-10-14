// The engines route (web/engines.ts) in Miniflare, with web/dist's engine in
// a simulated R2 bucket: each file comes back byte for byte with its
// manifest's headers, immutable and readable from anywhere; nothing else
// does.  Run after bun web/build.ts:   node web/test-engines.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { engineIdText, isManifest } from "./engine-id.mts";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

let failures = 0, count = 0;
const ok = (c, what) => { count++; if (!c) { failures++; console.log("FAIL", what); } };

const { id } = JSON.parse(readFileSync(join(here, "dist/engine/latest.json"), "utf8"));
const dir = join(here, "dist/engine", id);
const man = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const entry = `import { handleEngines } from ${JSON.stringify(join(here, "engines.ts"))};
export default { async fetch(req, env, ctx) { return (await handleEngines(req, env, ctx)) ?? new Response("not mine", { status: 418 }); } };`;
const entryFile = join(mkdtempSync(join(tmpdir(), "sb-engines-")), "entry.ts");
writeFileSync(entryFile, entry);
const script = execFileSync("bun", ["build", entryFile, "--format", "esm", "--target", "browser"], { encoding: "utf8" });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "engines", modules: true, script, compatibilityDate: "2026-10-01", r2Buckets: ["ENGINES"] }] }));
const bucket = await mf.getR2Bucket("ENGINES");
for (const f of [...Object.keys(man.files), "manifest.json"]) await bucket.put(`engine/${id}/${f}`, readFileSync(join(dir, f)));

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
ok((await get(`/engine/latest.json`)).status === 418 && (await get(`/other`)).status === 418, "other paths are not the route's");
await mf.dispose();
console.log(`${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
