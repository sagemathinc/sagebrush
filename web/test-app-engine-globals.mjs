// ci: checks.3 order=42
// The desktop app's engine thread (app/engine/thread.mjs) gives the interpreter a browser worker's world and nothing
// of Node's: in a real engine thread, a stand-in for the page's worker (sagebrush-worker.js, in a folder of its own)
// looks for every way out it could find if the interpreter had a bug: Node's globals (process, Buffer, require), the
// network (WebSocket, EventSource, fetch of another host or of a file outside the folder), and import() of a Node
// module, of a bare name, of a data: URL, of a file outside the folder or through a link out of it. Every one must be
// gone or refused; an import() of a file in the folder must still work. Then the control: the same stand-in in a thread
// without thread.mjs's removals reaches them, so the check is real.
//   node web/test-app-engine-globals.mjs
import { Worker } from "node:worker_threads";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
let failed = 0, passed = 0;
const ok = (c, what) => (c ? (passed++, console.log("ok   " + what)) : (failed++, console.log("FAIL " + what)));
const root = mkdtempSync(join(tmpdir(), "sb-engine-globals-"));
const outside = mkdtempSync(join(tmpdir(), "sb-engine-outside-"));
writeFileSync(join(outside, "x.mjs"), "export const x = 1;\n");
writeFileSync(join(root, "own.mjs"), "export const own = 42;\n");
symlinkSync(join(outside, "x.mjs"), join(root, "link.mjs"));
// (the stand-in: each way out, tried; what it got, posted)
writeFileSync(join(root, "sagebrush-worker.js"), `
const out = {};
const tryIt = async (k, f) => { try { const v = await f(); out[k] = "REACHED " + String(v).slice(0, 60); } catch (e) { out[k] = "refused: " + String(e?.message ?? e).slice(0, 100); } };
for (const k of ["process", "Buffer", "require", "WebSocket", "WebSocketStream", "EventSource", "localStorage", "sessionStorage"]) out["global " + k] = typeof globalThis[k];
await tryIt("import node:child_process", async () => (await import("node:child_process")).execSync ? "execSync" : "?");
await tryIt("import node:fs", async () => typeof (await import("node:fs")).readFileSync);
await tryIt("import fs (bare)", async () => typeof (await import("fs")).readFileSync);
await tryIt("import node:module", async () => typeof (await import("node:module")).createRequire);
await tryIt("import data:", async () => (await import("data:text/javascript,export default 7")).default);
await tryIt("import outside", async () => (await import(${JSON.stringify(pathToFileURL(join(outside, "x.mjs")).href)})).x);
await tryIt("import ../ out", async () => (await import("../" + ${JSON.stringify(outside.split("/").pop())} + "/x.mjs")).x);
await tryIt("import link out", async () => (await import("./link.mjs")).x);
await tryIt("fetch another host", async () => (await fetch("https://example.com/")).status);
await tryIt("fetch outside", async () => (await fetch(${JSON.stringify(pathToFileURL(join(outside, "x.mjs")).href)})).status);
await tryIt("import own", async () => (await import("./own.mjs")).own);
postMessage({ probe: out });
`);
const run = (file, data) => new Promise((resolve) => {
  const w = new Worker(file, { workerData: data });
  const t = setTimeout(() => { w.terminate(); resolve(null); }, 20000);
  w.on("message", (m) => { if (m?.probe) { clearTimeout(t); w.terminate(); resolve(m.probe); } });
  w.on("error", (e) => { clearTimeout(t); resolve({ error: String(e?.message ?? e) }); });
});
try {
  const thread = join(here, "..", "app", "engine", "thread.mjs");
  const p = await run(thread, { root, name: "" });
  console.log(JSON.stringify(p));
  ok(!!p && !p.error, "the stand-in ran in a real engine thread");
  if (p && !p.error) {
    for (const k of ["process", "Buffer", "require", "WebSocket", "WebSocketStream", "EventSource", "localStorage", "sessionStorage"]) ok(p["global " + k] === "undefined", `no ${k} in the engine thread (${p["global " + k]})`);
    for (const k of ["import node:child_process", "import node:fs", "import fs (bare)", "import node:module", "import data:", "import outside", "import ../ out", "import link out", "fetch another host", "fetch outside"]) ok(String(p[k]).startsWith("refused"), `${k}: ${p[k]}`);
    ok(p["import own"] === "REACHED 42", `an import() of the engine's own file still works: ${p["import own"]}`);
  }
  // (the control: a thread with nothing removed, loading the same stand-in, reaches Node's modules and the network
  // globals, so the checks above see what they would see without thread.mjs)
  const plain = join(root, "plain-thread.mjs");
  writeFileSync(plain, `import { parentPort, workerData } from "node:worker_threads"; globalThis.postMessage = (m) => parentPort.postMessage(m); await import(${JSON.stringify(pathToFileURL(join(root, "sagebrush-worker.js")).href)});\n`);
  const c = await run(plain, {});
  ok(!!c && String(c["import node:child_process"]).startsWith("REACHED") && c["global WebSocket"] === "function", `the control: a thread without thread.mjs's removals reaches node:child_process and WebSocket (${c?.["import node:child_process"]}, ${c?.["global WebSocket"]})`);
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
console.log(failed ? `FAIL: ${failed} of ${passed + failed}` : `app engine globals: all ${passed} checks passed`);
process.exit(failed ? 1 : 0);
