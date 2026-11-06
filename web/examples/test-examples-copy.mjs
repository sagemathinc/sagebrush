// ci: web-runner order=195 runner=bun chrome
// The copy path (web/examples/copy.ts; plan-examples-gallery A1-A3) and the Examples… panel (panel.ts), in Chrome on
// a real workspace: the fixture
// corpus's examples as web/build-examples.ts serves them, beside made-up ones (several folders deep, and each A1
// refusal: a bad hash, a ZIP member renamed, .., an absolute or backslash path, a case collision, a path not in NFC,
// main missing or of another kind, over 2 MiB, an .ipynb that isn't one, a redirect), and A2's races (an existing
// root, two copies at once, the root or a nested folder replaced mid-copy, a file there already); the panel's
// list, filters, sandboxed preview and copy, and a title with markup shown as text (A4). Cases: copy-cases.js.
//   CHROME=google-chrome bun web/examples/test-examples-copy.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";
import { buildExamplesInto, zip } from "../build-examples.ts";

const here = new URL(".", import.meta.url).pathname;
const FIX = join(here, "..", "..", "test", "fixtures", "examples");
const site = mkdtempSync(join(tmpdir(), "sb-examples-copy-site-"));
writeFileSync(join(site, "entry.ts"), `export * as W from ${JSON.stringify(join(here, "..", "workspace", "index.ts"))};\nexport * as C from ${JSON.stringify(join(here, "copy.ts"))};\nexport * as P from ${JSON.stringify(join(here, "panel.ts"))};\n`);
const built = await Bun.build({ entrypoints: [join(site, "entry.ts")], outdir: site, naming: "bundle.js", target: "browser", format: "esm" });
if (!built.success) {
  console.error(built.logs.join("\n"));
  process.exit(1);
}
copyFileSync(join(here, "copy-cases.js"), join(site, "cases.js"));
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>examples copy test</title><script type="module">import { run } from "./cases.js"; window.run = run; window.ready = true;</script>`);

// ---- what the site serves: the fixture corpus, built; then made-up examples beside it
const out = mkdtempSync(join(tmpdir(), "sb-examples-copy-built-"));
await buildExamplesInto(out, FIX);
const routes = new Map();
const catalog = JSON.parse(readFileSync(join(out, "examples", "index.json"), "utf8"));
for (const e of catalog.examples) {
  const slug = e.id.split("/")[1];
  routes.set(`/examples/${e.id}/files.json`, readFileSync(join(out, "examples", e.id, "files.json")));
  routes.set(`/examples/${e.id}/${slug}.zip`, readFileSync(join(out, "examples", e.id, `${slug}.zip`)));
}
routes.set("/raw/latex/article/main.tex", readFileSync(join(FIX, "latex", "article", "main.tex")));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const nb = (src) => Buffer.from(JSON.stringify({ cells: [{ cell_type: "code", metadata: {}, source: src, outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 }, null, 1) + "\n");
function example(id, title, files, o = {}) {
  const main = o.main ?? files[0][0];
  const list = files.map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes), encoding: "utf-8" }));
  if (o.badHash) list[o.badHash].sha256 = "0".repeat(64);
  const fj = Buffer.from(JSON.stringify({ id: o.fjId ?? id, main, files: list, ...(o.pad ? { pad: "x".repeat(o.pad) } : {}) }, null, 1) + "\n");
  const members = files.map(([name, bytes], i) => ({ name: o.renameMember === i ? name + "x" : name, bytes }));
  const slug = id.split("/")[1];
  routes.set(`/examples/${id}/files.json`, o.redirect ? { redirect: "https://example.com/files.json" } : o.stream ? { stream: fj } : fj);
  routes.set(`/examples/${id}/${slug}.zip`, zip(members));
  catalog.examples.push({ id, kind: id.split("/")[0], title, summary: "a test", tags: ["basics"], level: "intro", mode: "python", main, files: files.length, bytes: 0, files_sha256: o.badCatalog ? "f".repeat(64) : sha(fj), url: `/examples/${id}/` });
}
const t = (s) => Buffer.from(s);
example("notebook/deep", "Deep", [["main.ipynb", nb("1 + 1")], ["data/a.txt", t("a")], ["data/more/b.csv", t("x,y\n1,2\n")]]);
example("notebook/pair", "Pair", [["main.ipynb", nb("2 + 2")], ["notes.txt", t("notes")]]);
example("notebook/escape-title", "../../Escape/here", [["main.ipynb", nb("3")]]);
example("notebook/bad-hash", "Bad hash", [["main.ipynb", nb("4")], ["a.txt", t("a")]], { badHash: 1 });
example("notebook/bad-catalog", "Bad catalog", [["main.ipynb", nb("5")]], { badCatalog: true });
example("notebook/bad-member", "Bad member", [["main.ipynb", nb("6")], ["a.txt", t("a")]], { renameMember: 1 });
example("notebook/dotdot", "Dotdot", [["main.ipynb", nb("7")], ["../a.txt", t("a")]]);
example("notebook/absolute", "Absolute", [["main.ipynb", nb("8")], ["/a.txt", t("a")]]);
example("notebook/backslash", "Backslash", [["main.ipynb", nb("9")], ["a\\b.txt", t("a")]]);
example("notebook/collide", "Collide", [["main.ipynb", nb("10")], ["A.txt", t("a")], ["a.txt", t("b")]]);
example("notebook/nfc", "NFC", [["main.ipynb", nb("11")], ["é.txt", t("a")]]);
example("notebook/main-missing", "Main missing", [["main.ipynb", nb("12")]], { main: "other.ipynb" });
example("notebook/main-kind", "Main kind", [["a.txt", t("a")]]);
example("notebook/too-big", "Too big", [["main.ipynb", nb("13")], ["big.bin", Buffer.alloc(2 * 1024 * 1024 + 1)]]);
example("notebook/not-ipynb", "Not ipynb", [["main.ipynb", t("{}")]]);
example("notebook/redirect", "Redirect", [["main.ipynb", nb("14")]], { redirect: true });
// (grader's r549 guards, one case each: deeper than 4, a dotfile, an escape, a file that is also a folder, 41 files,
// files.json naming another id, a files.json over its cap with no content-length (streamed), an id the ID rule refuses)
example("notebook/deep5", "Deep5", [["main.ipynb", nb("15")], ["a/b/c/d/e.txt", t("e")]]);
example("notebook/dotfile", "Dotfile", [["main.ipynb", nb("16")], [".env", t("x")]]);
example("notebook/escape-pct", "Escape pct", [["main.ipynb", nb("17")], ["a%41.txt", t("x")]]);
example("notebook/file-folder", "File folder", [["main.ipynb", nb("18")], ["a", t("x")], ["a/b.txt", t("y")]]);
example("notebook/too-many", "Too many", [["main.ipynb", nb("19")], ...Array.from({ length: 40 }, (_, i) => [`f${i}.txt`, t(String(i))])]);
example("notebook/wrong-id", "Wrong id", [["main.ipynb", nb("20")]], { fjId: "notebook/pair" });
example("notebook/streamed-big", "Streamed big", [["main.ipynb", nb("21")]], { stream: true, pad: 70 * 1024 });
example("notebook/Bad_Id", "Bad id", [["main.ipynb", nb("22")]]);
// (a title that would close a script or open a tag, for the panel: A4 in its actual embedding)
catalog.examples.push({ id: "notebook/evil-title", kind: "notebook", title: '</script><img src=x onerror="window.pwned=1"><b>bold</b>', summary: "<script>window.pwned=2</script>", tags: ["<i>x</i>"], level: "intro", mode: "python", main: "main.ipynb", files: 1, bytes: 0, files_sha256: "0".repeat(64), url: "/examples/notebook/evil-title/" });
routes.set("/examples/index.json", Buffer.from(JSON.stringify(catalog)));

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = decodeURIComponent(new URL(req.url).pathname);
  if (["/", "/bundle.js", "/cases.js"].includes(p)) return new Response(Bun.file(join(site, p === "/" ? "index.html" : p.slice(1))), { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
  const r = routes.get(p);
  if (!r) return new Response("not found", { status: 404 });
  if (r.redirect) return new Response(null, { status: 302, headers: { location: r.redirect } });
  // (a body with no content-length: the copy path's own byte count must stop it)
  if (r.stream) return new Response(new ReadableStream({ start(c) { for (let i = 0; i < r.stream.length; i += 8192) c.enqueue(r.stream.subarray(i, i + 8192)); c.close(); } }), { headers: { "content-type": "application/json" } });
  return new Response(r, { headers: { "content-type": p.endsWith(".json") ? "application/json" : "application/octet-stream" } });
} });

let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-examples-copy-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let code = 1;
try {
  if (!port) port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some((x) => x.type === "page")) break; } catch {} await sleep(100); }
  const ws = new WebSocket(targets.find((x) => x.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map(), errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600)); return r.result?.value; };
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
  for (let i = 0; i < 200 && !(await ev("window.ready === true").catch(() => false)); i++) await sleep(50);
  const results = await ev("window.run()");
  const fails = results.filter(([ok]) => !ok).map(([, what]) => what);
  for (const e of errors) fails.push("page error: " + e);
  if (fails.length) console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  "));
  else {
    console.log(`ok: the examples' copy path, ${results.length} checks`);
    if (process.env.SHOW) for (const [, what] of results) console.log("  " + what);
    code = 0;
  }
  ws.close();
} finally {
  chrome.kill();
  server.stop(true);
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
}
process.exit(code);
