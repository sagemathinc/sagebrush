// What hashing a data file's bytes before its transaction costs (sync client step 2a, design/sync-client.md
// §3): a data file made and then written over at sizes up to the workspace's largest (200 MiB), in headless
// Chromium, timed, with the renderer's peak memory (VmHWM), against the same code with the new bytes' hash
// taken out (a bundle built with it removed), each in a browser of its own.  Not a test: it prints a table.
//   CHROME=google-chrome bun web/workspace/bench-write-hash.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const SIZES = (process.env.SIZES ?? "1,16,64,200").split(",").map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// (the new bytes' hash and the copy taken at the call (astra's CORR-9C2-1) taken out of create and of a data
// file's write: the code before this step)
const unhash = {
  name: "unhash",
  setup(b) {
    b.onLoad({ filter: /workspace\/api\.ts$/ }, async (a) => {
      let s = readFileSync(a.path, "utf8");
      const cuts = [["      sha256 = await bytesHash(b);\n", ""], ["  if (c instanceof Uint8Array) return c.byteLength > max ? c : c.slice();\n  if (c instanceof ArrayBuffer) return c.byteLength > max ? c : new Uint8Array(c.slice(0));\n", ""], ["    const sha256 = await bytesHash(b);\n    const base = ", "    const sha256 = undefined as unknown as string;\n    const base = "], ["(old === undefined ? undefined : sameBytes(old, b) ? sha256 : await bytesHash(old))", "undefined"]];
      for (const [x, y] of cuts) {
        if (!s.includes(x)) throw new Error("bench: not found in api.ts: " + x);
        s = s.replace(x, y);
      }
      return { contents: s, loader: "ts" };
    });
  },
};

const page = `<!doctype html><meta charset="utf-8"><script type="module">
import * as W from "./ws.js";
window.bench = async (mib) => {
  const w = await W.Workspace.open({ name: "bench-" + mib, mainName: "bench-main-" + mib });
  const make = (k) => { const b = new Uint8Array(mib * 2 ** 20); for (let j = 0; j < b.length; j += 4096) b[j] = (k + j) & 255; return b; };
  const out = {};
  let t = performance.now();
  await w.create("/f.bin", { content: make(1) });
  out.create = performance.now() - t;
  const writes = [];
  for (let k = 2; k < 5; k++) { const b = make(k); t = performance.now(); await w.write("/f.bin", b, { keepEmpty: false }); writes.push(performance.now() - t); await w.dropVersions("/f.bin"); }
  out.write = Math.min(...writes);
  const b = make(9);
  t = performance.now();
  await crypto.subtle.digest("SHA-256", b);
  out.digest = performance.now() - t;
  w.close();
  return out;
};
window.ready = true;
</script>`;

function rendererPeak(pgid) {
  let peak = 0;
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!cmd.includes("--type=renderer")) continue;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) !== pgid) continue;
      const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
      if (m) peak = Math.max(peak, Number(m[1]) * 1024);
    } catch {}
  }
  return peak;
}

async function run(variant, mib) {
  const site = mkdtempSync(join(tmpdir(), "sb-bench-site-"));
  const built = await Bun.build({ entrypoints: [join(here, "index.ts")], outdir: site, naming: "ws.js", target: "browser", format: "esm", plugins: variant === "without" ? [unhash] : [] });
  if (!built.success) throw new Error(built.logs.join("\n"));
  writeFileSync(join(site, "index.html"), page);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { const p = new URL(req.url).pathname; if (!["/", "/ws.js"].includes(p)) return new Response("not found", { status: 404 }); return new Response(Bun.file(join(site, p === "/" ? "index.html" : p.slice(1))), { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } }); } });
  const profile = mkdtempSync(join(tmpdir(), "sb-bench-"));
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
  try {
    const port = await devtoolsPort(profile);
    let targets;
    for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {} await sleep(100); }
    const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let n = 0;
    const waiting = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
    const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800)); return r.result?.value; };
    await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    for (let i = 0; i < 200 && !(await ev("window.ready === true").catch(() => false)); i++) await sleep(50);
    const r = await ev(`window.bench(${mib})`);
    r.peak = rendererPeak(chrome.pid);
    ws.close();
    return r;
  } finally {
    try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
    server.stop(true);
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
    rmSync(site, { recursive: true, force: true });
  }
}

const MiB = 2 ** 20, f = (x) => x.toFixed(0);
console.log("size MiB | create ms (with / without) | write ms (with / without) | digest ms | renderer peak MiB (with / without)");
for (const mib of SIZES) {
  const a = await run("with", mib), b = await run("without", mib);
  console.log(`${mib} | ${f(a.create)} / ${f(b.create)} | ${f(a.write)} / ${f(b.write)} | ${f(a.digest)} | ${f(a.peak / MiB)} / ${f(b.peak / MiB)}`);
}
process.exit(0);
