# Claude sandbox: which jsdelivr paths load?

The artifact demo failed in Claude at its first step:

```
TypeError: Failed to fetch dynamically imported module:
https://cdn.jsdelivr.net/gh/sagemathinc/sagebrush@7dddf96…/cdn/sagebrush-engine.mjs
```

In the first smoke test, Claude did allow `import()` from
`cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/+esm`. This page varies one
thing at a time:

- `/npm/` vs `/gh/` (a CSP allowlist can restrict paths, not just hosts);
- the `+esm` endpoint vs a plain file;
- small vs large (670 KB);
- module vs classic `<script>`.

In headless Chromium all 8 pass. Paste the prompt into **claude.ai only**,
since ChatGPT already ran the full demo, and copy the "JSDELIVR DIAGNOSTIC"
block back.

## Prompt

````
Please create an HTML artifact containing exactly the following page, unchanged, so I can run it. Do not modify, shorten, or "improve" it; it is a compatibility test of which cdn.jsdelivr.net paths load.

<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>jsdelivr diagnostic</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 16px; }
  pre { background: #f4f4f4; padding: 8px; white-space: pre-wrap; font-size: 12px; }
</style>
</head>
<body>
<h3>Which cdn.jsdelivr.net paths can this sandbox load?</h3>
<p>Copy this block back into the chat:</p>
<pre id="report">running…</pre>
<script type="module">
const SHA = "4bae7c942a70c04608abe2174acdc03d7d7ccc5c";
const GH = `https://cdn.jsdelivr.net/gh/sagemathinc/sagebrush@${SHA}/cdn/`;
const rows = [];
const show = () => { document.getElementById("report").textContent = "JSDELIVR DIAGNOSTIC\n" + rows.join("\n"); };
async function test(name, fn) {
  const t0 = performance.now();
  try {
    const r = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000))]);
    rows.push(`OK   ${name} -- ${r} (${(performance.now() - t0).toFixed(0)} ms)`);
  } catch (e) {
    rows.push(`FAIL ${name} -- ${e && e.message ? e.message : e}`);
  }
  show();
}
const classic = (src) => new Promise((res, rej) => {
  const s = document.createElement("script");
  s.src = src; s.onload = () => res("loaded"); s.onerror = () => rej(new Error("script load failed"));
  document.head.appendChild(s);
});
await test("1 npm  +esm small (control)", async () => typeof (await import("https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/+esm")).default);
await test("2 npm  plain file, small (25 KB)", async () => typeof (await import("https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.module.mjs")).default);
await test("3 npm  plain file, large (670 KB three.js)", async () => "REVISION " + (await import("https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js")).REVISION);
await test("4 gh   tiny module (47 B)", async () => (await import(GH + "hello.mjs")).hello);
await test("5 gh   pyparse.mjs (215 KB)", async () => typeof (await import(GH + "pyparse.mjs")).parse);
await test("6 gh   sagebrush-engine.mjs (549 KB, wasm inside)", async () => (await import(GH + "sagebrush-engine.mjs")).wasmBytes + " wasm bytes");
await test("7 gh   classic <script>", async () => { await classic(GH + "hello.js"); return window.SB_HELLO_CLASSIC; });
await test("8 esm.run redirect to jsdelivr", async () => typeof (await import("https://esm.run/canvas-confetti@1.9.3")).default);
rows.push(`origin=${location.origin} ua=${navigator.userAgent}`);
show();
</script>
</body>
</html>

````
