# Artifact smoke test: what runs inside chat artifacts?

Paste the prompt below into **claude.ai** and into **ChatGPT**, then copy
the grey "SAGEBRUSH SMOKE TEST" block it displays back into our chat.

- **claude.ai:** paste it into a new chat. It should create an HTML artifact; open the preview.
- **ChatGPT:** paste it into a new chat. It should open in canvas; click **Preview** (or "Run").

The page tests, with a 15 s timeout each:

1. WebAssembly from inline bytes (async and sync);
2. fetch + compile `.wasm` from jsdelivr, unpkg and cdnjs;
3. ES-module `import()` from esm.sh and jsdelivr;
4. a Worker created from a Blob URL that runs WASM;
5. cross-origin isolation (needed for WASM threads);
6. Plotly from cdnjs (falling back to jsdelivr) drawing a 3D surface;
7. BigInt.

In a normal page (headless Chromium here) everything passes except
cross-origin isolation, which needs special response headers.

## Prompt

````
Please create an HTML artifact containing exactly the following page, unchanged, so I can run it. Do not modify, shorten, or "improve" it; it is a compatibility test.

<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Sagebrush artifact smoke test</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 16px; }
  table { border-collapse: collapse; font-size: 14px; }
  td, th { border: 1px solid #ccc; padding: 4px 8px; text-align: left; vertical-align: top; }
  .ok { color: #0a0; font-weight: bold; } .fail { color: #c00; font-weight: bold; }
  pre { background: #f4f4f4; padding: 8px; white-space: pre-wrap; font-size: 12px; }
  #plot { width: 480px; height: 360px; }
</style>
</head>
<body>
<h3>Sagebrush artifact smoke test</h3>
<p>Can this sandbox run WebAssembly, load code from CDNs, start workers, and draw Plotly 3D plots?</p>
<table id="t"><tr><th>#</th><th>test</th><th>result</th><th>detail</th></tr></table>
<div id="plot"></div>
<p>Copy this block back into the chat:</p>
<pre id="report">running...</pre>
<script>
const rows = [];
const ADD_WASM = new Uint8Array([0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,7,7,1,3,97,100,100,0,0,10,9,1,7,0,32,0,32,1,106,11]);
function show(name, ok, detail) {
  rows.push({ name, ok, detail: String(detail).slice(0, 160) });
  const tr = document.createElement("tr");
  for (const [text, cls] of [[rows.length, ""], [name, ""], [ok ? "OK" : "FAIL", ok ? "ok" : "fail"], [String(detail).slice(0, 160), ""]]) {
    const td = document.createElement("td");
    td.textContent = text;
    if (cls) td.className = cls;
    tr.appendChild(td);
  }
  document.getElementById("t").appendChild(tr);
}
async function test(name, fn, ms = 15000) {
  const t0 = performance.now();
  try {
    const r = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
    show(name, true, `${r ?? ""} (${(performance.now() - t0).toFixed(0)} ms)`);
  } catch (e) {
    show(name, false, `${e && e.name ? e.name + ": " : ""}${e && e.message ? e.message : e}`);
  }
}
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = () => res(src.split("/")[2]); s.onerror = () => rej(new Error("script load failed"));
    document.head.appendChild(s);
  });
}
async function compileFrom(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status);
  const m = await WebAssembly.compile(await r.arrayBuffer());
  return `${WebAssembly.Module.exports(m).length} exports`;
}
(async () => {
  await test("WebAssembly.instantiate (inline bytes)", async () => {
    const { instance } = await WebAssembly.instantiate(ADD_WASM);
    return "add(2,40) = " + instance.exports.add(2, 40);
  });
  await test("WebAssembly.Module (sync compile)", async () => "add(1,1) = " + new WebAssembly.Instance(new WebAssembly.Module(ADD_WASM)).exports.add(1, 1));
  await test("fetch+compile .wasm from cdn.jsdelivr.net", () => compileFrom("https://cdn.jsdelivr.net/npm/web-tree-sitter@0.25.10/tree-sitter.wasm"));
  await test("fetch+compile .wasm from unpkg.com", () => compileFrom("https://unpkg.com/web-tree-sitter@0.25.10/tree-sitter.wasm"));
  await test("fetch+compile .wasm from cdnjs.cloudflare.com", () => compileFrom("https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.14.2/sql-wasm.wasm"));
  await test("import() ES module from esm.sh", async () => typeof (await import("https://esm.sh/canvas-confetti@1.9.3")).default);
  await test("import() ES module from cdn.jsdelivr.net/+esm", async () => typeof (await import("https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/+esm")).default);
  await test("Worker from Blob URL running wasm", () => new Promise((res, rej) => {
    const src = `onmessage = async (e) => { const { instance } = await WebAssembly.instantiate(e.data); postMessage(instance.exports.add(20, 22)); };`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    w.onmessage = (e) => res("worker add(20,22) = " + e.data);
    w.onerror = (e) => rej(new Error(e.message || "worker error"));
    w.postMessage(ADD_WASM);
  }));
  await test("crossOriginIsolated / SharedArrayBuffer (wasm threads)", async () => {
    if (!self.crossOriginIsolated) throw new Error("crossOriginIsolated = false; SharedArrayBuffer " + (typeof SharedArrayBuffer));
    return "yes";
  });
  let plotly = null;
  await test("<script> Plotly from cdnjs.cloudflare.com", async () => { await loadScript("https://cdnjs.cloudflare.com/ajax/libs/plotly.js/4.1.2/plotly.min.js"); plotly = "cdnjs"; return "Plotly " + Plotly.version; }, 30000);
  if (!plotly) {
    await test("<script> Plotly from cdn.jsdelivr.net", async () => { await loadScript("https://cdn.jsdelivr.net/npm/plotly.js-dist-min@2.35.2/plotly.min.js"); plotly = "jsdelivr"; return "Plotly " + Plotly.version; }, 30000);
  }
  await test("Plotly 3D surface renders", async () => {
    if (!plotly) throw new Error("Plotly not loaded");
    const n = 40, xs = [...Array(n).keys()].map(i => -3 + 6 * i / (n - 1));
    const z = xs.map(y => xs.map(x => Math.sin(x * x + y * y) / (1 + x * x + y * y)));
    await Plotly.newPlot("plot", [{ type: "surface", x: xs, y: xs, z, opacity: 0.9 }], { margin: { l: 0, r: 0, t: 0, b: 0 } });
    return "drawn (see below)";
  });
  await test("BigInt + performance", async () => { let s = 0n; for (let i = 0n; i < 1000n; i++) s += i * i; return "sum = " + s; });
  const env = `origin=${location.origin || "(opaque)"} ua=${navigator.userAgent}`;
  document.getElementById("report").textContent =
    "SAGEBRUSH SMOKE TEST\n" + env + "\n" + rows.map((r, i) => `${i + 1}. ${r.ok ? "OK  " : "FAIL"} ${r.name} -- ${r.detail}`).join("\n");
})();
</script>
</body>
</html>

````
